/**
 * Tag repository -- Workers/D1-compatible version.
 *
 * No @Injectable, @InjectKysely, @GenerateSql, @Chunked decorators.
 * No LoggingRepository dependency.
 * No ::uuid casts. Plain Kysely with D1 dialect.
 */

import type { Insertable, Kysely, Updateable } from 'kysely';
import type { DB, TagTable, TagAssetTable } from 'src/schema';
import { BadRequestException } from 'src/utils/errors';

const QUERY_CHUNK_SIZE = 90;
const INSERT_CHUNK_SIZE = 45;

export class TagRepository {
  constructor(private db: Kysely<DB>, private d1: D1Database) {}

  get(id: string) {
    return this.db
      .selectFrom('tag')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  getByValue(userId: string, value: string) {
    return this.db
      .selectFrom('tag')
      .selectAll()
      .where('userId', '=', userId)
      .where('value', '=', value)
      .executeTakeFirst();
  }

  async upsertValue({ userId, value, parentId: _parentId }: { userId: string; value: string; parentId?: string }) {
    const parentId = _parentId ?? null;
    const existing = await this.getByValue(userId, value);
    if (existing) {
      if (existing.parentId !== parentId) {
        await this.reparent(existing.id, parentId);
      }
      return { ...existing, parentId };
    }

    const id = crypto.randomUUID();
    let ancestors: Array<{ id_ancestor: string }> = [];
    if (parentId) {
      const parent = await this.get(parentId);
      if (!parent || parent.userId !== userId) {
        throw new BadRequestException('Tag not found');
      }
      ancestors = await this.db
        .selectFrom('tag_closure')
        .select('id_ancestor')
        .where('id_descendant', '=', parentId)
        .execute();
    }

    await this.d1.batch([
      this.d1.prepare('INSERT INTO tag (id, userId, value, parentId) VALUES (?, ?, ?, ?)')
        .bind(id, userId, value, parentId),
      this.d1.prepare('INSERT INTO tag_closure (id_ancestor, id_descendant) VALUES (?, ?)').bind(id, id),
      ...ancestors.map(({ id_ancestor }) =>
        this.d1.prepare('INSERT INTO tag_closure (id_ancestor, id_descendant) VALUES (?, ?)')
          .bind(id_ancestor, id)),
    ]);

    return this.get(id);
  }

  /**
   * Upsert multiple tags from an array of tag value strings.
   * Creates parent tags automatically for hierarchical values like "parent/child".
   */
  async upsertTags({ userId, tags }: { userId: string; tags: string[] }) {
    const results: any[] = [];
    for (const tagValue of tags) {
      const parts = tagValue.split('/');
      let parentId: string | undefined;

      for (let i = 0; i < parts.length; i++) {
        const value = parts.slice(0, i + 1).join('/');
        const tag = await this.upsertValue({ userId, value, parentId });
        parentId = tag.id;

        if (i === parts.length - 1) {
          results.push(tag);
        }
      }
    }
    return results;
  }

  getAll(userId: string) {
    return this.db
      .selectFrom('tag')
      .selectAll()
      .where('userId', '=', userId)
      .orderBy('value')
      .execute();
  }

  async create(tag: Omit<Insertable<TagTable>, 'id'> & { id?: string }) {
    const value = { ...tag, id: tag.id ?? crypto.randomUUID() };
    let ancestors: Array<{ id_ancestor: string }> = [];
    if (value.parentId) {
      const parent = await this.get(value.parentId);
      if (!parent || parent.userId !== value.userId) {
        throw new BadRequestException('Tag not found');
      }
      ancestors = await this.db
        .selectFrom('tag_closure')
        .select('id_ancestor')
        .where('id_descendant', '=', value.parentId)
        .execute();
    }

    await this.d1.batch([
      this.d1.prepare('INSERT INTO tag (id, userId, value, color, parentId) VALUES (?, ?, ?, ?, ?)')
        .bind(value.id, value.userId, value.value, value.color ?? null, value.parentId ?? null),
      this.d1.prepare('INSERT INTO tag_closure (id_ancestor, id_descendant) VALUES (?, ?)')
        .bind(value.id, value.id),
      ...ancestors.map(({ id_ancestor }) =>
        this.d1.prepare('INSERT INTO tag_closure (id_ancestor, id_descendant) VALUES (?, ?)')
          .bind(id_ancestor, value.id)),
    ]);
    return this.db
      .selectFrom('tag')
      .selectAll()
      .where('id', '=', value.id)
      .executeTakeFirstOrThrow();
  }

  async update(id: string, dto: Updateable<TagTable>) {
    const existing = await this.get(id);
    if (!existing) {
      throw new BadRequestException('Tag not found');
    }

    const descendants = await this.db
      .selectFrom('tag_closure')
      .innerJoin('tag', 'tag.id', 'tag_closure.id_descendant')
      .select(['tag.id', 'tag.value'])
      .where('tag_closure.id_ancestor', '=', id)
      .orderBy('tag.value')
      .execute();
    const nextRootValue = dto.value ?? existing.value;
    const updates = descendants.map((tag) => ({
      id: tag.id,
      value: tag.id === id ? nextRootValue : `${nextRootValue}${tag.value.slice(existing.value.length)}`,
    }));

    if (dto.value !== undefined && dto.value !== existing.value) {
      const subtreeIds = new Set(updates.map(({ id }) => id));
      const values = new Set<string>();
      for (const update of updates) {
        if (values.has(update.value)) {
          throw new BadRequestException('A tag with that name already exists');
        }
        values.add(update.value);
        const duplicate = await this.getByValue(existing.userId, update.value);
        if (duplicate && !subtreeIds.has(duplicate.id)) {
          throw new BadRequestException('A tag with that name already exists');
        }
      }
    }

    const statements = updates.map((update) => update.id === id && dto.color !== undefined
      ? this.d1.prepare('UPDATE tag SET value = ?, color = ? WHERE id = ?').bind(update.value, dto.color, update.id)
      : this.d1.prepare('UPDATE tag SET value = ? WHERE id = ?').bind(update.value, update.id));
    if (statements.length > 0) {
      await this.d1.batch(statements);
    }
    return this.db
      .selectFrom('tag')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  async delete(id: string) {
    await this.db.deleteFrom('tag').where('id', '=', id).execute();
  }

  async getAssetIds(tagId: string, assetIds: string[]): Promise<Set<string>> {
    if (assetIds.length === 0) {
      return new Set();
    }

    const allResults: string[] = [];
    for (let i = 0; i < assetIds.length; i += QUERY_CHUNK_SIZE) {
      const chunk = assetIds.slice(i, i + QUERY_CHUNK_SIZE);
      const results = await this.db
        .selectFrom('tag_asset')
        .select('assetId')
        .where('tagId', '=', tagId)
        .where('assetId', 'in', chunk)
        .execute();
      for (const r of results) {
        allResults.push(r.assetId);
      }
    }

    return new Set(allResults);
  }

  async addAssetIds(tagId: string, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    for (let i = 0; i < assetIds.length; i += INSERT_CHUNK_SIZE) {
      const chunk = assetIds.slice(i, i + INSERT_CHUNK_SIZE);
      await this.db
        .insertInto('tag_asset')
        .values(chunk.map((assetId) => ({ tagId, assetId })))
        .execute();
    }
  }

  async removeAssetIds(tagId: string, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    for (let i = 0; i < assetIds.length; i += QUERY_CHUNK_SIZE) {
      const chunk = assetIds.slice(i, i + QUERY_CHUNK_SIZE);
      await this.db
        .deleteFrom('tag_asset')
        .where('tagId', '=', tagId)
        .where('assetId', 'in', chunk)
        .execute();
    }
  }

  async upsertAssetIds(items: Insertable<TagAssetTable>[]) {
    if (items.length === 0) {
      return [];
    }

    const uniqueItems = [...new Map(items.map((item) => [`${item.tagId}:${item.assetId}`, item])).values()];
    const results: Array<{ tagId: string; assetId: string }> = [];
    for (let i = 0; i < uniqueItems.length; i += INSERT_CHUNK_SIZE) {
      const chunk = uniqueItems.slice(i, i + INSERT_CHUNK_SIZE);
      const inserted = await this.db
        .insertInto('tag_asset')
        .values(chunk)
        .onConflict((oc) => oc.doNothing())
        .returningAll()
        .execute();
      results.push(...inserted);
    }

    return results;
  }

  async reparent(id: string, parentId: string | null): Promise<void> {
    const tag = await this.get(id);
    if (!tag) {
      throw new BadRequestException('Tag not found');
    }

    let parent: Awaited<ReturnType<TagRepository['get']>>;
    if (parentId) {
      parent = await this.get(parentId);
      if (!parent || parent.userId !== tag.userId) {
        throw new BadRequestException('Tag not found');
      }
      const cycle = await this.db.selectFrom('tag_closure').select('id_ancestor')
        .where('id_ancestor', '=', id).where('id_descendant', '=', parentId).executeTakeFirst();
      if (cycle) {
        throw new BadRequestException('Cannot move a tag below itself or one of its descendants');
      }
    }

    const descendants = await this.db.selectFrom('tag_closure')
      .innerJoin('tag', 'tag.id', 'tag_closure.id_descendant')
      .select(['tag.id', 'tag.value'])
      .where('tag_closure.id_ancestor', '=', id).execute();
    const subtreeIds = descendants.map(({ id }) => id);
    const nextRootValue = parent ? `${parent.value}/${tag.value.split('/').at(-1)}` : tag.value.split('/').at(-1)!;
    const valueUpdates = descendants.map((descendant) => ({
      id: descendant.id,
      value: descendant.id === id
        ? nextRootValue
        : `${nextRootValue}${descendant.value.slice(tag.value.length)}`,
    }));
    const subtreeIdSet = new Set(subtreeIds);
    for (const update of valueUpdates) {
      const duplicate = await this.getByValue(tag.userId, update.value);
      if (duplicate && !subtreeIdSet.has(duplicate.id)) {
        throw new BadRequestException('A tag with that name already exists');
      }
    }
    const parentAncestors = parentId
      ? await this.db.selectFrom('tag_closure').select('id_ancestor').where('id_descendant', '=', parentId).execute()
      : [];
    const statements: D1PreparedStatement[] = [
      ...valueUpdates.map((update) => update.id === id
        ? this.d1.prepare('UPDATE tag SET value = ?, parentId = ? WHERE id = ?').bind(update.value, parentId, id)
        : this.d1.prepare('UPDATE tag SET value = ? WHERE id = ?').bind(update.value, update.id)),
      this.d1.prepare(`
        DELETE FROM tag_closure
        WHERE id_descendant IN (SELECT id_descendant FROM tag_closure WHERE id_ancestor = ?)
          AND id_ancestor NOT IN (SELECT id_descendant FROM tag_closure WHERE id_ancestor = ?)
      `).bind(id, id),
    ];
    for (const { id_ancestor } of parentAncestors) {
      for (const id_descendant of subtreeIds) {
        statements.push(this.d1.prepare(
          'INSERT INTO tag_closure (id_ancestor, id_descendant) VALUES (?, ?) ON CONFLICT DO NOTHING',
        ).bind(id_ancestor, id_descendant));
      }
    }
    await this.d1.batch(statements);
  }
}
