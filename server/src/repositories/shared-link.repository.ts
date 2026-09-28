/**
 * Shared Link repository -- Workers/D1-compatible version.
 *
 * Converted from PostgreSQL to D1/SQLite-compatible Kysely queries.
 * Key changes:
 * - No jsonObjectFrom/jsonArrayFrom from kysely/helpers/postgres
 * - No LATERAL JOIN -- use separate queries
 * - No DISTINCT ON -- use ORDER BY + GROUP BY or separate logic
 * - No @Injectable, @InjectKysely, @GenerateSql decorators
 * - No lodash dependency
 * - Separate queries to build complex objects
 */

import type { Insertable, Kysely, Updateable } from 'kysely';
import type { DB, SharedLinkTable } from 'src/schema';
import { AlbumUserRole, SharedLinkType } from 'src/enum';

export type SharedLinkSearchOptions = {
  userId: string;
  id?: string;
  albumId?: string;
};

const ASSET_INSERT_CHUNK_SIZE = 49;

export class SharedLinkRepository {
  constructor(
    private db: Kysely<DB>,
    private d1: D1Database,
  ) {}

  async get(userId: string, id: string) {
    const link = await this.db
      .selectFrom('shared_link')
      .selectAll('shared_link')
      .where('shared_link.id', '=', id)
      .where('shared_link.userId', '=', userId)
      .executeTakeFirst();

    if (!link) return undefined;

    // Get assets for individual links
    const assets = await this.db
      .selectFrom('shared_link_asset')
      .innerJoin('asset', 'asset.id', 'shared_link_asset.assetId')
      .selectAll('asset')
      .where('shared_link_asset.sharedLinkId', '=', id)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '!=', 'locked')
      .orderBy('asset.fileCreatedAt', 'asc')
      .execute();

    // Get album if it's an album link
    let album: any = null;
    if (link.albumId) {
      album = await this.db
        .selectFrom('album')
        .selectAll('album')
        .where('album.id', '=', link.albumId)
        .where('album.deletedAt', 'is', null)
        .executeTakeFirst();

      if (album) {
        // Get album assets
        const albumAssets = await this.db
          .selectFrom('asset')
          .selectAll('asset')
          .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
          .where('album_asset.albumId', '=', link.albumId!)
          .where('asset.deletedAt', 'is', null)
          .where('asset.visibility', '!=', 'locked')
          .orderBy('asset.fileCreatedAt', 'asc')
          .execute();

        album = await this.enrichAlbum(album, albumAssets);
      }
    }

    // Filter: for album links, album must exist
    if (link.type !== SharedLinkType.Individual && !album) {
      return undefined;
    }

    return { ...link, assets, album };
  }

  async getAll({ userId, id, albumId }: SharedLinkSearchOptions) {
    let query = this.db
      .selectFrom('shared_link')
      .selectAll('shared_link')
      .where('shared_link.userId', '=', userId);

    if (id) {
      query = query.where('shared_link.id', '=', id);
    }
    if (albumId) {
      query = query.where('shared_link.albumId', '=', albumId);
    }

    const links = await query
      .orderBy('shared_link.createdAt', 'desc')
      .execute();

    // Enrich each link
    const results = await Promise.all(
      links.map(async (link) => {
        // Get individual assets
        const assets = await this.db
          .selectFrom('shared_link_asset')
          .innerJoin('asset', 'asset.id', 'shared_link_asset.assetId')
          .selectAll('asset')
          .where('shared_link_asset.sharedLinkId', '=', link.id)
          .where('asset.deletedAt', 'is', null)
          .where('asset.visibility', '!=', 'locked')
          .execute();

        // Get album
        let album: any = null;
        if (link.albumId) {
          album = await this.db
            .selectFrom('album')
            .selectAll('album')
            .where('album.id', '=', link.albumId)
            .where('album.deletedAt', 'is', null)
            .executeTakeFirst();

          if (album) {
            album = await this.enrichAlbum(album);
          }
        }

        // Filter: for album links, album must exist
        if (link.type !== SharedLinkType.Individual && !album) {
          return null;
        }

        return { ...link, assets, album };
      }),
    );

    return results.filter(Boolean);
  }

  async getByKey(key: Uint8Array) {
    return this.authBuilder().where('shared_link.key', '=', key).executeTakeFirst();
  }

  async getBySlug(slug: string) {
    return this.authBuilder().where('shared_link.slug', '=', slug).executeTakeFirst();
  }

  async create(entity: Insertable<SharedLinkTable> & { assetIds?: string[] }) {
    const { assetIds, ...linkData } = entity as any;

    const statements = [
      this.d1.prepare(
        `INSERT INTO "shared_link"
          ("id", "description", "userId", "key", "type", "createdAt", "expiresAt", "allowUpload", "albumId", "allowDownload", "showExif", "password", "slug")
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        linkData.id,
        linkData.description ?? null,
        linkData.userId,
        linkData.key,
        linkData.type,
        linkData.createdAt,
        linkData.expiresAt ?? null,
        Number(linkData.allowUpload),
        linkData.albumId ?? null,
        Number(linkData.allowDownload),
        Number(linkData.showExif),
        linkData.password ?? null,
        linkData.slug ?? null,
      ),
    ];

    for (let i = 0; i < (assetIds?.length || 0); i += ASSET_INSERT_CHUNK_SIZE) {
      const chunk = assetIds!.slice(i, i + ASSET_INSERT_CHUNK_SIZE);
      statements.push(
        this.d1
          .prepare(
            `INSERT INTO "shared_link_asset" ("assetId", "sharedLinkId") VALUES ${chunk
              .map(() => '(?, ?)')
              .join(', ')}`,
          )
          .bind(...chunk.flatMap((assetId: string) => [assetId, linkData.id])),
      );
    }

    await this.d1.batch(statements);
    return this.getSharedLinkById(linkData.id);
  }

  async update(entity: Updateable<SharedLinkTable> & { id: string; assetIds?: string[] }) {
    const { assetIds, assets, album, ...linkData } = entity as any;

    await this.db
      .updateTable('shared_link')
      .set(linkData)
      .where('shared_link.id', '=', entity.id!)
      .execute();

    if (assetIds && assetIds.length > 0) {
      await this.addAssets(entity.id, assetIds);
    }

    return this.getSharedLinkById(entity.id!);
  }

  async remove(id: string): Promise<void> {
    await this.db.deleteFrom('shared_link').where('shared_link.id', '=', id).execute();
  }

  async addAssets(id: string, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < assetIds.length; i += ASSET_INSERT_CHUNK_SIZE) {
      const chunk = assetIds.slice(i, i + ASSET_INSERT_CHUNK_SIZE);
      statements.push(
        this.d1
          .prepare(
            `INSERT OR IGNORE INTO "shared_link_asset" ("assetId", "sharedLinkId") VALUES ${chunk
              .map(() => '(?, ?)')
              .join(', ')}`,
          )
          .bind(...chunk.flatMap((assetId) => [assetId, id])),
      );
    }
    await this.d1.batch(statements);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private authBuilder() {
    return this.db
      .selectFrom('shared_link')
      .leftJoin('album', 'album.id', 'shared_link.albumId')
      .selectAll('shared_link')
      .where((eb) =>
        eb.or([
          eb('shared_link.type', '=', SharedLinkType.Individual),
          eb.and([
            eb('album.id', 'is not', null),
            eb('album.deletedAt', 'is', null),
          ]),
        ]),
      );
  }

  private async getSharedLinkById(id: string) {
    const link = await this.db
      .selectFrom('shared_link')
      .selectAll('shared_link')
      .where('shared_link.id', '=', id)
      .executeTakeFirstOrThrow();

    const assets = await this.db
      .selectFrom('shared_link_asset')
      .innerJoin('asset', 'asset.id', 'shared_link_asset.assetId')
      .selectAll('asset')
      .where('shared_link_asset.sharedLinkId', '=', id)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '!=', 'locked')
      .execute();

    return { ...link, assets };
  }

  private async enrichAlbum(album: any, assets: any[] = []) {
    const rows = await this.db
      .selectFrom('album_user')
      .innerJoin('user', 'user.id', 'album_user.userId')
      .selectAll('album_user')
      .selectAll('user')
      .where('album_user.albumId', '=', album.id)
      .where('user.deletedAt', 'is', null)
      .execute();

    const albumUsers = rows
      .map(({ albumId, userId, role, createId, updateId, ...user }) => ({
        albumId,
        userId,
        role,
        createId,
        updateId,
        user,
      }))
      .sort((a, b) => {
        const rank = (role: string) => (role === AlbumUserRole.Owner ? 0 : 1);
        return rank(a.role) - rank(b.role) || a.user.name.localeCompare(b.user.name);
      });

    return { ...album, albumUsers, assets };
  }
}
