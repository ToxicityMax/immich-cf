/**
 * Memory repository -- Workers/D1-compatible version.
 *
 * Converted from PostgreSQL to D1/SQLite-compatible Kysely queries.
 * Key changes:
 * - No jsonArrayFrom from kysely/helpers/postgres
 * - No luxon DateTime -- use plain Date/string
 * - No @Injectable, @InjectKysely, @GenerateSql, @Chunked decorators
 * - Separate queries for assets instead of nested json builders
 */

import type { Insertable, Kysely, Updateable } from 'kysely';
import { sql } from 'kysely';
import type { DB, MemoryTable } from 'src/schema';

const IN_CHUNK_SIZE = 97;

export class MemoryRepository {
  constructor(
    private db: Kysely<DB>,
    private d1: D1Database,
  ) {}

  private searchBuilder(ownerId: string, dto: any) {
    let query = this.db.selectFrom('memory').where('ownerId', '=', ownerId);

    if (dto.id !== undefined) query = query.where('id', '=', dto.id);
    if (dto.isSaved !== undefined) query = query.where('isSaved', '=', dto.isSaved ? 1 : 0);
    if (dto.type !== undefined) query = query.where('type', '=', dto.type);
    if (dto.for !== undefined) {
      const date = this.asIsoString(dto.for);
      query = query
        .where((eb) => eb.or([eb('showAt', 'is', null), eb('showAt', '<=', date)]))
        .where((eb) => eb.or([eb('hideAt', 'is', null), eb('hideAt', '>=', date)]));
    }
    if (dto.isUpcoming !== undefined) {
      const now = new Date().toISOString();
      query = dto.isUpcoming
        ? query.where('showAt', '>', now)
        : query.where((eb) => eb.or([eb('showAt', 'is', null), eb('showAt', '<=', now)]));
    }

    return query.where('deletedAt', dto.isTrashed ? 'is not' : 'is', null);
  }

  async search(ownerId: string, dto: any) {
    let query = this.searchBuilder(ownerId, dto).selectAll('memory');

    if (dto.order === 'random') {
      query = query.orderBy(sql`RANDOM()`);
    } else {
      const direction = dto.order?.toLowerCase() || 'desc';
      query = query
        .orderBy(sql`"showAt" IS NULL`, 'asc')
        .orderBy('showAt', direction as 'asc' | 'desc')
        .orderBy('memoryAt', direction as 'asc' | 'desc');
    }

    if (dto.size !== undefined) {
      query = query.limit(dto.size);
    }
    if (dto.page !== undefined && dto.size !== undefined) {
      query = query.offset((dto.page - 1) * dto.size);
    }

    const memories = await query.execute();
    return this.enrichMemories(memories);
  }

  async statistics(ownerId: string, dto: any) {
    const result = await this.searchBuilder(ownerId, dto)
      .select((eb) => eb.fn.count('id').as('total'))
      .executeTakeFirstOrThrow();

    return { total: Number(result.total) };
  }

  async get(id: string, ownerId: string) {
    const memory = await this.db
      .selectFrom('memory')
      .selectAll('memory')
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    if (!memory) {
      return undefined;
    }

    const assets = await this.db
      .selectFrom('asset')
      .selectAll('asset')
      .innerJoin('memory_asset', 'asset.id', 'memory_asset.assetId')
      .innerJoin('memory', (join) =>
        join
          .onRef('memory.id', '=', 'memory_asset.memoriesId')
          .onRef('memory.ownerId', '=', 'asset.ownerId'),
      )
      .where('memory_asset.memoriesId', '=', id)
      .where('memory.ownerId', '=', ownerId)
      .where('asset.visibility', '=', 'timeline')
      .where('asset.deletedAt', 'is', null)
      .orderBy('asset.fileCreatedAt', 'asc')
      .execute();

    return this.normalizeMemory({ ...memory, assets });
  }

  async create(memory: Insertable<MemoryTable>, assetIds: string[] | Set<string>) {
    const assetIdArray = assetIds instanceof Set ? [...assetIds] : assetIds;
    const statements: D1PreparedStatement[] = [
      this.d1.prepare(
        'INSERT INTO "memory" ("id", "ownerId", "type", "data", "isSaved", "memoryAt", "seenAt", "showAt", "hideAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        memory.id,
        memory.ownerId,
        memory.type,
        memory.data,
        memory.isSaved ?? 0,
        memory.memoryAt,
        memory.seenAt ?? null,
        memory.showAt ?? null,
        memory.hideAt ?? null,
      ),
    ];
    for (let i = 0; i < assetIdArray.length; i += IN_CHUNK_SIZE) {
      const chunk = assetIdArray.slice(i, i + IN_CHUNK_SIZE);
      statements.push(
        this.d1.prepare(`
          INSERT INTO "memory_asset" ("memoriesId", "assetId")
          SELECT "memory"."id", "asset"."id"
          FROM "memory" JOIN "asset" ON "asset"."ownerId" = "memory"."ownerId"
          WHERE "memory"."id" = ? AND "memory"."ownerId" = ?
            AND "asset"."id" IN (${chunk.map(() => '?').join(', ')})
        `).bind(memory.id, memory.ownerId, ...chunk),
      );
    }
    await this.d1.batch(statements);
    return this.get(memory.id as string, memory.ownerId as string).then((result) => {
      if (!result) throw new Error('Failed to create memory');
      return result;
    });
  }

  async update(id: string, ownerId: string, memory: Updateable<MemoryTable>) {
    await this.db.updateTable('memory').set(memory).where('id', '=', id).where('ownerId', '=', ownerId).execute();

    const updated = await this.db
      .selectFrom('memory')
      .selectAll('memory')
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .executeTakeFirstOrThrow();

    const assets = await this.db
      .selectFrom('asset')
      .selectAll('asset')
      .innerJoin('memory_asset', 'asset.id', 'memory_asset.assetId')
      .innerJoin('memory', (join) =>
        join
          .onRef('memory.id', '=', 'memory_asset.memoriesId')
          .onRef('memory.ownerId', '=', 'asset.ownerId'),
      )
      .where('memory_asset.memoriesId', '=', id)
      .where('memory.ownerId', '=', ownerId)
      .where('asset.visibility', '=', 'timeline')
      .where('asset.deletedAt', 'is', null)
      .orderBy('asset.fileCreatedAt', 'asc')
      .execute();

    return this.normalizeMemory({ ...updated, assets });
  }

  async delete(id: string, ownerId: string) {
    await this.db.deleteFrom('memory').where('id', '=', id).where('ownerId', '=', ownerId).execute();
  }

  async getAssetIds(id: string, ownerId: string, assetIds: string[]): Promise<Set<string>> {
    if (assetIds.length === 0) {
      return new Set<string>();
    }

    const allResults: string[] = [];
    for (let i = 0; i < assetIds.length; i += IN_CHUNK_SIZE) {
      const chunk = assetIds.slice(i, i + IN_CHUNK_SIZE);
      const results = await this.db
        .selectFrom('memory_asset')
        .innerJoin('memory', 'memory.id', 'memory_asset.memoriesId')
        .innerJoin('asset', (join) =>
          join
            .onRef('asset.id', '=', 'memory_asset.assetId')
            .onRef('asset.ownerId', '=', 'memory.ownerId'),
        )
        .select('assetId')
        .where('memoriesId', '=', id)
        .where('memory.ownerId', '=', ownerId)
        .where('assetId', 'in', chunk)
        .execute();
      for (const r of results) {
        allResults.push(r.assetId);
      }
    }

    return new Set(allResults);
  }

  async addAssetIds(id: string, ownerId: string, assetIds: string[]) {
    if (assetIds.length === 0) {
      return;
    }

    for (let i = 0; i < assetIds.length; i += IN_CHUNK_SIZE) {
      const chunk = assetIds.slice(i, i + IN_CHUNK_SIZE);
      await this.d1.prepare(`
        INSERT INTO "memory_asset" ("memoriesId", "assetId")
        SELECT "memory"."id", "asset"."id"
        FROM "memory" JOIN "asset" ON "asset"."ownerId" = "memory"."ownerId"
        WHERE "memory"."id" = ? AND "memory"."ownerId" = ?
          AND "asset"."id" IN (${chunk.map(() => '?').join(', ')})
      `).bind(id, ownerId, ...chunk).run();
    }
  }

  async removeAssetIds(id: string, ownerId: string, assetIds: string[]) {
    if (assetIds.length === 0) {
      return;
    }

    for (let i = 0; i < assetIds.length; i += IN_CHUNK_SIZE) {
      const chunk = assetIds.slice(i, i + IN_CHUNK_SIZE);
      await this.d1.prepare(`
        DELETE FROM "memory_asset"
        WHERE "memoriesId" = ? AND "assetId" IN (${chunk.map(() => '?').join(', ')})
          AND EXISTS (
            SELECT 1 FROM "memory" JOIN "asset"
              ON "asset"."id" = "memory_asset"."assetId"
             AND "asset"."ownerId" = "memory"."ownerId"
            WHERE "memory"."id" = "memory_asset"."memoriesId" AND "memory"."ownerId" = ?
          )
      `).bind(id, ...chunk, ownerId).run();
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async enrichMemories(memories: any[]) {
    return Promise.all(
      memories.map(async (memory) => {
        const assets = await this.db
          .selectFrom('asset')
          .selectAll('asset')
          .innerJoin('memory_asset', 'asset.id', 'memory_asset.assetId')
          .innerJoin('memory', (join) =>
            join
              .onRef('memory.id', '=', 'memory_asset.memoriesId')
              .onRef('memory.ownerId', '=', 'asset.ownerId'),
          )
          .where('memory_asset.memoriesId', '=', memory.id)
          .where('memory.ownerId', '=', memory.ownerId)
          .where('asset.visibility', '=', 'timeline')
          .where('asset.deletedAt', 'is', null)
          .orderBy('asset.fileCreatedAt', 'asc')
          .execute();

        return this.normalizeMemory({ ...memory, assets });
      }),
    );
  }

  private normalizeMemory(memory: any) {
    return {
      ...memory,
      data: typeof memory.data === 'string' ? JSON.parse(memory.data) : memory.data,
      isSaved: Boolean(memory.isSaved),
    };
  }

  private asIsoString(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : value;
  }
}
