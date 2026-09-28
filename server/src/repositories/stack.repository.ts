/**
 * Stack repository -- Workers/D1-compatible version.
 *
 * Converted from PostgreSQL to D1/SQLite-compatible Kysely queries.
 * Key changes:
 * - No jsonArrayFrom from kysely/helpers/postgres
 * - No LATERAL JOIN
 * - No @Injectable, @InjectKysely, @GenerateSql decorators
 * - No ::uuid casts (asUuid removed)
 * - Separate queries instead of complex nested json builders
 */

import type { Insertable, Kysely, Updateable } from 'kysely';
import { AssetVisibility } from 'src/enum';
import type { DB, StackTable } from 'src/schema';

export interface StackSearch {
  ownerId: string;
  primaryAssetId?: string;
}

const getVisibleAssetTypes = (includeLocked: boolean) =>
  includeLocked
    ? [AssetVisibility.Archive, AssetVisibility.Timeline, AssetVisibility.Locked]
    : [AssetVisibility.Archive, AssetVisibility.Timeline];

const CHUNK_SIZE = 90;

export class StackRepository {
  constructor(
    private db: Kysely<DB>,
    private d1: D1Database,
  ) {}

  async search(query: StackSearch, includeLocked = false) {
    let q = this.db
      .selectFrom('stack')
      .selectAll('stack')
      .where('stack.ownerId', '=', query.ownerId);

    if (query.primaryAssetId) {
      q = q.where('stack.primaryAssetId', '=', query.primaryAssetId);
    }

    const stacks = await this.enrichStacks(await q.execute(), includeLocked);
    return includeLocked
      ? stacks
      : stacks.filter((stack) => stack.assets.some((asset: any) => asset.id === stack.primaryAssetId));
  }

  async create(
    entity: Omit<Insertable<StackTable>, 'primaryAssetId'>,
    assetIds: string[],
    includeLocked = false,
  ) {
    if (assetIds.length === 0) {
      throw new Error('A stack requires at least one asset');
    }

    const stackIds = new Set<string>();
    for (let i = 0; i < assetIds.length; i += CHUNK_SIZE) {
      const stacks = await this.db
        .selectFrom('stack')
        .where('stack.ownerId', '=', entity.ownerId)
        .where('stack.primaryAssetId', 'in', assetIds.slice(i, i + CHUNK_SIZE))
        .select('stack.id')
        .execute();

      for (const stack of stacks) {
        stackIds.add(stack.id);
      }
    }

    const uniqueIds = new Set<string>(assetIds);

    for (const stackId of stackIds) {
      const childAssets = await this.db
        .selectFrom('asset')
        .select('asset.id')
        .where('asset.stackId', '=', stackId)
        .where('asset.deletedAt', 'is', null)
        .execute();

      for (const asset of childAssets) {
        uniqueIds.add(asset.id);
      }
    }

    const statements: D1PreparedStatement[] = [];
    const existingStackIds = [...stackIds];
    for (let i = 0; i < existingStackIds.length; i += CHUNK_SIZE) {
      const chunk = existingStackIds.slice(i, i + CHUNK_SIZE);
      statements.push(
        this.d1
          .prepare(`DELETE FROM "stack" WHERE "id" IN (${chunk.map(() => '?').join(', ')})`)
          .bind(...chunk),
      );
    }

    const newId = crypto.randomUUID();
    statements.push(
      this.d1
        .prepare('INSERT INTO "stack" ("id", "ownerId", "primaryAssetId") VALUES (?, ?, ?)')
        .bind(newId, entity.ownerId, assetIds[0]),
    );

    const updatedAt = new Date().toISOString();
    const ids = [...uniqueIds];
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      statements.push(
        this.d1
          .prepare(
            `UPDATE "asset" SET "stackId" = ?, "updatedAt" = ? WHERE "id" IN (${chunk.map(() => '?').join(', ')})`,
          )
          .bind(newId, updatedAt, ...chunk),
      );
    }

    await this.d1.batch(statements);

    const newStack = await this.db
      .selectFrom('stack')
      .selectAll('stack')
      .where('id', '=', newId)
      .executeTakeFirstOrThrow();

    const assets = await this.db
      .selectFrom('asset')
      .selectAll('asset')
      .where('asset.stackId', '=', newId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', 'in', getVisibleAssetTypes(includeLocked))
      .execute();

    return { ...newStack, assets };
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('stack').where('id', '=', id).execute();
  }

  async deleteAll(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      await this.db.deleteFrom('stack').where('id', 'in', ids.slice(i, i + CHUNK_SIZE)).execute();
    }
  }

  async update(id: string, entity: Updateable<StackTable>, includeLocked = false) {
    await this.db
      .updateTable('stack')
      .set(entity)
      .where('id', '=', id)
      .execute();

    const stack = await this.db
      .selectFrom('stack')
      .selectAll('stack')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    const assets = await this.db
      .selectFrom('asset')
      .selectAll('asset')
      .where('asset.stackId', '=', id)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', 'in', getVisibleAssetTypes(includeLocked))
      .execute();

    return { ...stack, assets };
  }

  async getById(id: string, includeLocked = false) {
    const stack = await this.db
      .selectFrom('stack')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!stack) {
      return undefined;
    }

    const assets = await this.db
      .selectFrom('asset')
      .selectAll('asset')
      .where('asset.stackId', '=', id)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', 'in', getVisibleAssetTypes(includeLocked))
      .execute();

    if (!includeLocked && !assets.some((asset) => asset.id === stack.primaryAssetId)) {
      return undefined;
    }

    return { ...stack, assets };
  }

  getForAssetRemoval(assetId: string) {
    return this.db
      .selectFrom('asset')
      .leftJoin('stack', 'stack.id', 'asset.stackId')
      .select(['asset.stackId as id', 'stack.primaryAssetId'])
      .where('asset.id', '=', assetId)
      .executeTakeFirst();
  }

  merge({ sourceId, targetId }: { sourceId: string; targetId: string }) {
    return this.db
      .updateTable('asset')
      .set({ stackId: targetId })
      .where('asset.stackId', '=', sourceId)
      .execute();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async enrichStacks(stacks: any[], includeLocked: boolean) {
    return Promise.all(
      stacks.map(async (stack) => {
        const assets = await this.db
          .selectFrom('asset')
          .selectAll('asset')
          .where('asset.stackId', '=', stack.id)
          .where('asset.deletedAt', 'is', null)
          .where('asset.visibility', 'in', getVisibleAssetTypes(includeLocked))
          .execute();

        return { ...stack, assets };
      }),
    );
  }
}
