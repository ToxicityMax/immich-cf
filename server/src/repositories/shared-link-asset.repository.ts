/**
 * Shared Link Asset repository -- Workers/D1-compatible version.
 *
 * No @InjectKysely, no decorators. Plain Kysely with D1 dialect.
 */

import type { Kysely } from 'kysely';
import type { DB } from 'src/schema';

const CHUNK_SIZE = 90;

export class SharedLinkAssetRepository {
  constructor(private db: Kysely<DB>) {}

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
      if (chunkIds.length > 0) {
        await this.db
          .deleteFrom('shared_link_asset')
          .where('shared_link_asset.sharedLinkId', '=', sharedLinkId)
          .where('shared_link_asset.assetId', 'in', chunkIds)
          .execute();
      }
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
