/**
 * Shared Link Asset repository -- Workers/D1-compatible version.
 *
 * No @InjectKysely, no decorators. Plain Kysely with D1 dialect.
 */

import type { Kysely } from 'kysely';
import type { DB } from 'src/schema';

const CHUNK_SIZE = 90;

export class SharedLinkAssetRepository {
  constructor(
    private db: Kysely<DB>,
    private d1: D1Database,
  ) {}

  async remove(sharedLinkId: string, assetIds: string[]): Promise<string[]> {
    if (assetIds.length === 0) {
      return [];
    }

    // D1 doesn't reliably support RETURNING, so fetch first then delete.
    const existingIds: string[] = [];
    for (let i = 0; i < assetIds.length; i += CHUNK_SIZE) {
      const existing = await this.db
        .selectFrom('shared_link_asset')
        .select('assetId')
        .where('shared_link_asset.sharedLinkId', '=', sharedLinkId)
        .where('shared_link_asset.assetId', 'in', assetIds.slice(i, i + CHUNK_SIZE))
        .execute();

      const chunkIds = existing.map((row) => row.assetId);
      existingIds.push(...chunkIds);
    }

    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < existingIds.length; i += CHUNK_SIZE) {
      const chunk = existingIds.slice(i, i + CHUNK_SIZE);
      statements.push(
        this.d1
          .prepare(
            `DELETE FROM "shared_link_asset" WHERE "sharedLinkId" = ? AND "assetId" IN (${chunk
              .map(() => '?')
              .join(', ')})`,
          )
          .bind(sharedLinkId, ...chunk),
      );
    }
    if (statements.length > 0) {
      await this.d1.batch(statements);
    }

    return existingIds;
  }

  async removeAssets(assetIds: string[]): Promise<void> {
    for (let i = 0; i < assetIds.length; i += CHUNK_SIZE) {
      await this.db
        .deleteFrom('shared_link_asset')
        .where('assetId', 'in', assetIds.slice(i, i + CHUNK_SIZE))
        .execute();
    }
  }
}
