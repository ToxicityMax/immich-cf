/**
 * Album repository -- Workers/D1-compatible version.
 *
 * Converted from PostgreSQL to D1/SQLite-compatible Kysely queries.
 * Key changes:
 * - No jsonArrayFrom/jsonObjectFrom from kysely/helpers/postgres
 * - No LATERAL JOIN -- use separate queries or correlated subqueries
 * - No RETURNING with expression builders -- use separate select after insert/update
 * - No @Injectable, @InjectKysely, @GenerateSql, @Chunked decorators
 * - No ::uuid casts
 * - Timestamps stored as ISO 8601 TEXT strings
 * - Booleans stored as INTEGER (0/1)
 */

import type { Insertable, Kysely, Updateable } from 'kysely';
import { sql } from 'kysely';
import type { DB, AlbumTable } from 'src/schema';
import { AlbumUserRole } from 'src/enum';

const CHUNK_SIZE = 90;
const INSERT_CHUNK_SIZE = 45;

export interface AlbumAssetCount {
  albumId: string;
  assetCount: number;
  startDate: string | null;
  endDate: string | null;
  lastModifiedAssetTimestamp: string | null;
}

export interface AlbumInfoOptions {
  withAssets: boolean;
}

export class AlbumRepository {
  constructor(private db: Kysely<DB>, private d1?: D1Database) {}

  async getById(id: string, options: AlbumInfoOptions) {
    const album = await this.db
      .selectFrom('album')
      .selectAll('album')
      .where('album.id', '=', id)
      .where('album.deletedAt', 'is', null)
      .executeTakeFirst();

    if (!album) {
      return undefined;
    }

    const albumUsers = await this.getAlbumUsers(id);

    const sharedLinks = await this.db
      .selectFrom('shared_link')
      .selectAll()
      .where('shared_link.albumId', '=', id)
      .execute();

    let assets: any[] | undefined;
    if (options.withAssets) {
      assets = await this.db
        .selectFrom('asset')
        .selectAll('asset')
        .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
        .where('album_asset.albumId', '=', id)
        .where('asset.deletedAt', 'is', null)
        .where('asset.visibility', '!=', 'hidden')
        .where('asset.visibility', '!=', 'locked')
        .orderBy('asset.fileCreatedAt', 'desc')
        .execute();
    }

    return {
      ...album,
      albumUsers,
      sharedLinks,
      assets: assets ?? [],
    };
  }

  async getByAssetId(ownerId: string, assetId: string) {
    const albums = await this.db
      .selectFrom('album')
      .selectAll('album')
      .innerJoin('album_asset', 'album_asset.albumId', 'album.id')
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('album_user')
            .select(sql`1`.as('one'))
            .whereRef('album_user.albumId', '=', 'album.id')
            .where('album_user.userId', '=', ownerId),
        ),
      )
      .where('album_asset.assetId', '=', assetId)
      .where('album.deletedAt', 'is', null)
      .orderBy('album.createdAt', 'desc')
      .execute();

    return this.enrichAlbums(albums, ownerId);
  }

  async getAll(ownerId: string, options: { isOwned?: boolean; isShared?: boolean }) {
    let query = this.db
      .selectFrom('album')
      .selectAll('album')
      .innerJoin('album_user as current_user', (join) =>
        join.onRef('current_user.albumId', '=', 'album.id').on('current_user.userId', '=', ownerId),
      )
      .where('album.deletedAt', 'is', null);

    if (options.isOwned !== undefined) {
      query = query.where(
        'current_user.role',
        options.isOwned ? '=' : '!=',
        AlbumUserRole.Owner,
      );
    }

    if (options.isShared !== undefined) {
      query = query.where((eb) => {
        const isShared = eb.or([
          eb.exists(
            eb
              .selectFrom('album_user as shared_user')
              .select(sql`1`.as('one'))
              .whereRef('shared_user.albumId', '=', 'album.id')
              .where('shared_user.role', '!=', AlbumUserRole.Owner),
          ),
          eb.exists(
            eb.selectFrom('shared_link').select(sql`1`.as('one')).whereRef('shared_link.albumId', '=', 'album.id'),
          ),
        ]);
        return options.isShared ? isShared : eb.not(isShared);
      });
    }

    const albums = await query.orderBy('album.createdAt', 'desc').execute();
    return this.enrichAlbums(albums, ownerId);
  }

  async getMetadataForIds(ids: string[]): Promise<AlbumAssetCount[]> {
    if (ids.length === 0) {
      return [];
    }

    const results: AlbumAssetCount[] = [];
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      const rows = await this.db
        .selectFrom('asset')
        .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
        .select('album_asset.albumId as albumId')
        .select((eb) => eb.fn.min('asset.localDateTime').as('startDate'))
        .select((eb) => eb.fn.max('asset.localDateTime').as('endDate'))
        .select((eb) => eb.fn.max('asset.updatedAt').as('lastModifiedAssetTimestamp'))
        .select((eb) => eb.fn.count('asset.id').as('assetCount'))
        .where('album_asset.albumId', 'in', chunk)
        .where('asset.deletedAt', 'is', null)
        .where('asset.visibility', '!=', 'hidden')
        .where('asset.visibility', '!=', 'locked')
        .groupBy('album_asset.albumId')
        .execute();

      for (const row of rows) {
        results.push({
          albumId: row.albumId,
          assetCount: Number(row.assetCount),
          startDate: row.startDate as string | null,
          endDate: row.endDate as string | null,
          lastModifiedAssetTimestamp: row.lastModifiedAssetTimestamp as string | null,
        });
      }
    }

    return results;
  }

  async getOwned(ownerId: string) {
    const albums = await this.db
      .selectFrom('album')
      .selectAll('album')
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('album_user')
            .select(sql`1`.as('one'))
            .whereRef('album_user.albumId', '=', 'album.id')
            .where('album_user.userId', '=', ownerId)
            .where('album_user.role', '=', AlbumUserRole.Owner),
        ),
      )
      .where('album.deletedAt', 'is', null)
      .orderBy('album.createdAt', 'desc')
      .execute();

    return this.enrichAlbums(albums, ownerId);
  }

  async getShared(ownerId: string) {
    const albums = await this.db
      .selectFrom('album')
      .selectAll('album')
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('album_user')
            .select(sql`1`.as('one'))
            .whereRef('album_user.albumId', '=', 'album.id')
            .where('album_user.userId', '=', ownerId),
        ),
      )
      .where((eb) =>
        eb.or([
          eb.exists(
            eb
              .selectFrom('album_user as shared_user')
              .select(sql`1`.as('one'))
              .whereRef('shared_user.albumId', '=', 'album.id')
              .where('shared_user.role', '!=', AlbumUserRole.Owner),
          ),
          eb.exists(
            eb
              .selectFrom('shared_link')
              .select(sql`1`.as('one'))
              .whereRef('shared_link.albumId', '=', 'album.id')
              .where('shared_link.userId', '=', ownerId),
          ),
        ]),
      )
      .where('album.deletedAt', 'is', null)
      .orderBy('album.createdAt', 'desc')
      .execute();

    return this.enrichAlbums(albums, ownerId);
  }

  async getNotShared(ownerId: string) {
    const albums = await this.db
      .selectFrom('album')
      .selectAll('album')
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('album_user')
            .select(sql`1`.as('one'))
            .whereRef('album_user.albumId', '=', 'album.id')
            .where('album_user.userId', '=', ownerId)
            .where('album_user.role', '=', AlbumUserRole.Owner),
        ),
      )
      .where('album.deletedAt', 'is', null)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('album_user')
              .select(sql`1`.as('one'))
              .whereRef('album_user.albumId', '=', 'album.id')
              .where('album_user.role', '!=', AlbumUserRole.Owner),
          ),
        ),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb.selectFrom('shared_link').select(sql`1`.as('one')).whereRef('shared_link.albumId', '=', 'album.id'),
          ),
        ),
      )
      .orderBy('album.createdAt', 'desc')
      .execute();

    return this.enrichAlbums(albums, ownerId);
  }

  async restoreAll(userId: string): Promise<void> {
    await this.db
      .updateTable('album')
      .set({ deletedAt: null })
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('album_user')
            .select(sql`1`.as('one'))
            .whereRef('album_user.albumId', '=', 'album.id')
            .where('album_user.userId', '=', userId)
            .where('album_user.role', '=', AlbumUserRole.Owner),
        ),
      )
      .execute();
  }

  async softDeleteAll(userId: string): Promise<void> {
    await this.db
      .updateTable('album')
      .set({ deletedAt: new Date().toISOString() })
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('album_user')
            .select(sql`1`.as('one'))
            .whereRef('album_user.albumId', '=', 'album.id')
            .where('album_user.userId', '=', userId)
            .where('album_user.role', '=', AlbumUserRole.Owner),
        ),
      )
      .execute();
  }

  async deleteAll(userId: string): Promise<void> {
    await this.db
      .deleteFrom('album')
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('album_user')
            .select(sql`1`.as('one'))
            .whereRef('album_user.albumId', '=', 'album.id')
            .where('album_user.userId', '=', userId)
            .where('album_user.role', '=', AlbumUserRole.Owner),
        ),
      )
      .execute();
  }

  async removeAssetsFromAll(assetIds: string[]): Promise<void> {
    for (let i = 0; i < assetIds.length; i += CHUNK_SIZE) {
      const chunk = assetIds.slice(i, i + CHUNK_SIZE);
      await this.db
        .updateTable('album')
        .set({ albumThumbnailAssetId: null })
        .where('albumThumbnailAssetId', 'in', chunk)
        .execute();
      await this.db
        .deleteFrom('album_asset')
        .where('album_asset.assetId', 'in', chunk)
        .execute();
    }
    await this.updateThumbnails();
  }

  async removeAssetIds(albumId: string, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    for (let i = 0; i < assetIds.length; i += CHUNK_SIZE) {
      const chunk = assetIds.slice(i, i + CHUNK_SIZE);
      await this.db
        .deleteFrom('album_asset')
        .where('album_asset.albumId', '=', albumId)
        .where('album_asset.assetId', 'in', chunk)
        .execute();
    }
  }

  async getAssetIds(albumId: string, assetIds: string[]): Promise<Set<string>> {
    if (assetIds.length === 0) {
      return new Set();
    }

    const allResults: string[] = [];
    for (let i = 0; i < assetIds.length; i += CHUNK_SIZE) {
      const chunk = assetIds.slice(i, i + CHUNK_SIZE);
      const results = await this.db
        .selectFrom('album_asset')
        .select('album_asset.assetId')
        .where('album_asset.albumId', '=', albumId)
        .where('album_asset.assetId', 'in', chunk)
        .execute();
      for (const r of results) {
        allResults.push(r.assetId);
      }
    }

    return new Set(allResults);
  }

  async addAssetIds(albumId: string, assetIds: string[]): Promise<void> {
    await this.addAssets(this.db, albumId, assetIds);
  }

  async create(
    album: Insertable<AlbumTable>,
    assetIds: string[],
    albumUsers: Array<{ userId: string; role?: string }>,
  ) {
    const uniqueAssetIds = [...new Set(assetIds)];
    const uniqueAlbumUsers = [...new Map(albumUsers.map((user) => [user.userId, user])).values()];
    if (uniqueAlbumUsers.filter(({ role }) => role === AlbumUserRole.Owner).length !== 1) {
      throw new Error('Album must have an owner');
    }

    if (!this.d1) {
      throw new Error('D1 binding is required to create an album');
    }

    const newAlbumId = album.id || crypto.randomUUID();
    const statements: D1PreparedStatement[] = [
      this.d1.prepare(`
        INSERT INTO album (id, albumName, description, albumThumbnailAssetId, "order")
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        newAlbumId,
        album.albumName ?? 'Untitled',
        album.description ?? null,
        album.albumThumbnailAssetId ?? null,
        album.order ?? 'desc',
      ),
      ...uniqueAssetIds.map((assetId) =>
        this.d1!.prepare('INSERT INTO album_asset (albumId, assetId) VALUES (?, ?)').bind(newAlbumId, assetId)),
      ...uniqueAlbumUsers.map((user) =>
        this.d1!.prepare('INSERT INTO album_user (albumId, userId, role) VALUES (?, ?, ?)')
          .bind(newAlbumId, user.userId, user.role || AlbumUserRole.Editor)),
    ];
    await this.d1.batch(statements);

    return this.getById(newAlbumId, { withAssets: true });
  }

  async update(id: string, album: Updateable<AlbumTable>) {
    await this.db
      .updateTable('album')
      .set(album)
      .where('id', '=', id)
      .execute();

    // Fetch updated album with relations
    const updated = await this.db
      .selectFrom('album')
      .selectAll('album')
      .where('album.id', '=', id)
      .executeTakeFirstOrThrow();

    const albumUsers = await this.getAlbumUsers(id);

    const sharedLinks = await this.db
      .selectFrom('shared_link')
      .selectAll()
      .where('shared_link.albumId', '=', id)
      .execute();

    return {
      ...updated,
      albumUsers,
      sharedLinks,
    };
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('album').where('id', '=', id).execute();
  }

  async updateThumbnails(): Promise<number | undefined> {
    // Simplified thumbnail update for D1:
    // Set thumbnail for albums that have assets but no thumbnail.
    // Uses simple joins + WHERE clauses (D1/SQLite-compatible).
    const albumsNeedingThumbnail = await this.db
      .selectFrom('album')
      .select('album.id')
      .where('album.albumThumbnailAssetId', 'is', null)
      .where('album.deletedAt', 'is', null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('album_asset')
            .select(sql`1`.as('one'))
            .innerJoin('asset', 'album_asset.assetId', 'asset.id')
            .whereRef('album_asset.albumId', '=', 'album.id')
            .where('asset.deletedAt', 'is', null),
        ),
      )
      .execute();

    let count = 0;
    for (const album of albumsNeedingThumbnail) {
      const latestAsset = await this.db
        .selectFrom('album_asset')
        .innerJoin('asset', 'album_asset.assetId', 'asset.id')
        .select('album_asset.assetId')
        .where('album_asset.albumId', '=', album.id)
        .where('asset.deletedAt', 'is', null)
        .orderBy('asset.fileCreatedAt', 'desc')
        .limit(1)
        .executeTakeFirst();

      if (latestAsset) {
        await this.db
          .updateTable('album')
          .set({ albumThumbnailAssetId: latestAsset.assetId })
          .where('id', '=', album.id)
          .execute();
        count++;
      }
    }

    // Also fix invalid thumbnails (asset no longer in album)
    const albumsWithInvalidThumbnail = await this.db
      .selectFrom('album')
      .select(['album.id', 'album.albumThumbnailAssetId'])
      .where('album.albumThumbnailAssetId', 'is not', null)
      .where('album.deletedAt', 'is', null)
      .execute();

    for (const album of albumsWithInvalidThumbnail) {
      const exists = await this.db
        .selectFrom('album_asset')
        .innerJoin('asset', 'album_asset.assetId', 'asset.id')
        .select('album_asset.assetId')
        .where('album_asset.albumId', '=', album.id)
        .where('album_asset.assetId', '=', album.albumThumbnailAssetId!)
        .where('asset.deletedAt', 'is', null)
        .executeTakeFirst();

      if (!exists) {
        const latestAsset = await this.db
          .selectFrom('album_asset')
          .innerJoin('asset', 'album_asset.assetId', 'asset.id')
          .select('album_asset.assetId')
          .where('album_asset.albumId', '=', album.id)
          .where('asset.deletedAt', 'is', null)
          .orderBy('asset.fileCreatedAt', 'desc')
          .limit(1)
          .executeTakeFirst();

        await this.db
          .updateTable('album')
          .set({ albumThumbnailAssetId: latestAsset?.assetId ?? null })
          .where('id', '=', album.id)
          .execute();
        count++;
      }
    }

    return count;
  }

  getContributorCounts(id: string) {
    return this.db
      .selectFrom('album_asset')
      .innerJoin('asset', 'asset.id', 'album_asset.assetId')
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '!=', 'locked')
      .where('album_asset.albumId', '=', id)
      .select('asset.ownerId as userId')
      .select((eb) => eb.fn.count('asset.id').as('assetCount'))
      .groupBy('asset.ownerId')
      .orderBy('assetCount', 'desc')
      .execute();
  }

  async addAssetIdsToAlbums(values: { albumId: string; assetId: string }[]): Promise<void> {
    if (values.length === 0) {
      return;
    }

    for (let i = 0; i < values.length; i += INSERT_CHUNK_SIZE) {
      const chunk = values.slice(i, i + INSERT_CHUNK_SIZE);
      await this.db.insertInto('album_asset').values(chunk).execute();
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async addAssets(db: Kysely<DB>, albumId: string, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    for (let i = 0; i < assetIds.length; i += INSERT_CHUNK_SIZE) {
      const chunk = assetIds.slice(i, i + INSERT_CHUNK_SIZE);
      await db
        .insertInto('album_asset')
        .values(chunk.map((assetId) => ({ albumId, assetId })))
        .execute();
    }
  }

  private async enrichAlbums(albums: any[], authUserId?: string) {
    return Promise.all(
      albums.map(async (album) => {
        const albumUsers = await this.getAlbumUsers(album.id, authUserId);

        const sharedLinks = await this.db
          .selectFrom('shared_link')
          .selectAll()
          .where('shared_link.albumId', '=', album.id)
          .execute();

        return {
          ...album,
          albumUsers,
          sharedLinks,
        };
      }),
    );
  }

  private async getAlbumUsers(albumId: string, authUserId?: string) {
    const albumUsers = await this.db
      .selectFrom('album_user')
      .innerJoin('user', 'user.id', 'album_user.userId')
      .selectAll('album_user')
      .selectAll('user')
      .where('album_user.albumId', '=', albumId)
      .where('user.deletedAt', 'is', null)
      .execute();

    return albumUsers
      .map(({ albumId: _albumId, userId, role, createId, updateId, ...user }) => ({
        albumId,
        userId,
        role,
        createId,
        updateId,
        user,
      }))
      .sort((a, b) => {
        const rank = (value: typeof a) =>
          value.role === AlbumUserRole.Owner ? 0 : value.userId === authUserId ? 1 : 2;
        return rank(a) - rank(b) || a.user.name.localeCompare(b.user.name);
      });
  }
}
