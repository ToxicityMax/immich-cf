/**
 * Album service -- Workers-compatible version.
 *
 * Core business logic for album CRUD operations.
 * No NestJS decorators, no BaseService, no job queues.
 */

import type { AuthDto } from 'src/dtos/auth.dto';
import {
  mapAlbum,
  mapAlbumWithAssets,
  mapAlbumWithoutAssets,
} from 'src/dtos/album.dto';
import { AlbumUserRole, Permission } from 'src/enum';
import type { ServiceContext } from 'src/context';
import { AccessRepository } from 'src/repositories/access.repository';
import { AlbumRepository } from 'src/repositories/album.repository';
import { AlbumUserRepository } from 'src/repositories/album-user.repository';
import { UserRepository } from 'src/repositories/user.repository';
import { requireAccess, checkAccess } from 'src/utils/access';

export class AlbumService {
  private albumRepository: AlbumRepository;
  private albumUserRepository: AlbumUserRepository;
  private accessRepository: AccessRepository;
  private userRepository: UserRepository;

  constructor(private ctx: ServiceContext) {
    this.albumRepository = new AlbumRepository(ctx.db, ctx.env.DB);
    this.albumUserRepository = new AlbumUserRepository(ctx.db);
    this.accessRepository = new AccessRepository(ctx.db);
    this.userRepository = new UserRepository(ctx.db);
  }

  async getStatistics(auth: AuthDto) {
    const [owned, shared, notShared] = await Promise.all([
      this.albumRepository.getOwned(auth.user.id),
      this.albumRepository.getShared(auth.user.id),
      this.albumRepository.getNotShared(auth.user.id),
    ]);

    return {
      owned: owned.length,
      shared: shared.length,
      notShared: notShared.length,
    };
  }

  async getAll(auth: AuthDto, dto: { assetId?: string; isOwned?: boolean; isShared?: boolean }) {
    const { assetId, ...options } = dto;
    const ownerId = auth.user.id;

    await this.albumRepository.updateThumbnails();

    let albums: any[];
    if (assetId) {
      albums = await this.albumRepository.getByAssetId(ownerId, assetId);
    } else {
      albums = await this.albumRepository.getAll(ownerId, options);
    }

    const results = await this.albumRepository.getMetadataForIds(albums.map((a: any) => a.id));
    const albumMetadata: Record<string, any> = {};
    for (const metadata of results) {
      albumMetadata[metadata.albumId] = metadata;
    }

    return albums.map((album: any) => ({
      ...mapAlbumWithoutAssets(this.normalizeAlbum(album)),
      sharedLinks: undefined,
      startDate: albumMetadata[album.id]?.startDate ?? undefined,
      endDate: albumMetadata[album.id]?.endDate ?? undefined,
      assetCount: albumMetadata[album.id]?.assetCount ?? 0,
      lastModifiedAssetTimestamp: albumMetadata[album.id]?.lastModifiedAssetTimestamp ?? undefined,
    }));
  }

  async get(auth: AuthDto, id: string, dto: { withoutAssets?: boolean }) {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.AlbumRead,
      ids: [id],
    });

    await this.albumRepository.updateThumbnails();
    const withAssets = dto.withoutAssets === undefined ? true : !dto.withoutAssets;
    const album = await this.findOrFail(id, { withAssets });
    const [albumMetadataForIds] = await this.albumRepository.getMetadataForIds([album.id]);

    const hasSharedUsers = album.albumUsers && album.albumUsers.length > 0;
    const hasSharedLink = album.sharedLinks && album.sharedLinks.length > 0;
    const isShared = hasSharedUsers || hasSharedLink;

    return {
      ...mapAlbum(this.normalizeAlbum(album), withAssets, auth),
      startDate: albumMetadataForIds?.startDate ?? undefined,
      endDate: albumMetadataForIds?.endDate ?? undefined,
      assetCount: albumMetadataForIds?.assetCount ?? 0,
      lastModifiedAssetTimestamp: albumMetadataForIds?.lastModifiedAssetTimestamp ?? undefined,
      contributorCounts: isShared ? await this.albumRepository.getContributorCounts(album.id) : undefined,
    };
  }

  async create(auth: AuthDto, dto: any) {
    const albumUsers = [...new Map(
      (dto.albumUsers || [])
        .filter(({ userId }: { userId: string }) => userId !== auth.user.id)
        .map((albumUser: { userId: string; role: string }) => [albumUser.userId, albumUser]),
    ).values()] as Array<{ userId: string; role: string }>;

    for (const { userId } of albumUsers) {
      const exists = await this.userRepository.get(userId, {});
      if (!exists) {
        throw new Error('User not found');
      }
    }

    const allowedAssetIdsSet = await checkAccess(this.accessRepository, {
      auth,
      permission: Permission.AssetShare,
      ids: dto.assetIds || [],
    });
    const assetIds = [...allowedAssetIdsSet];

    const album = await this.albumRepository.create(
      {
        id: crypto.randomUUID(),
        albumName: dto.albumName || 'Untitled',
        description: dto.description === '' ? null : dto.description ?? null,
        albumThumbnailAssetId: assetIds[0] || null,
        order: 'desc',
      },
      assetIds,
      [{ userId: auth.user.id, role: AlbumUserRole.Owner }, ...albumUsers],
    );

    return mapAlbumWithAssets(this.normalizeAlbum(album));
  }

  async update(auth: AuthDto, id: string, dto: any) {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.AlbumUpdate,
      ids: [id],
    });

    const album = await this.findOrFail(id, { withAssets: true });

    if (dto.albumThumbnailAssetId) {
      const results = await this.albumRepository.getAssetIds(id, [dto.albumThumbnailAssetId]);
      if (results.size === 0) {
        throw new Error('Invalid album thumbnail');
      }
    }

    const updatedAlbum = await this.albumRepository.update(album.id, {
      id: album.id,
      albumName: dto.albumName,
      description: dto.description,
      albumThumbnailAssetId: dto.albumThumbnailAssetId,
      isActivityEnabled: dto.isActivityEnabled,
      order: dto.order,
    });

    return mapAlbumWithoutAssets(
      this.normalizeAlbum({ ...updatedAlbum, assets: album.assets }),
    );
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.AlbumDelete,
      ids: [id],
    });
    await this.albumRepository.delete(id);
  }

  async addAssets(auth: AuthDto, id: string, dto: { ids: string[] }) {
    const album = await this.findOrFail(id, { withAssets: false });
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.AlbumAssetCreate,
      ids: [id],
    });

    const allowedAssetIds = await checkAccess(this.accessRepository, {
      auth,
      permission: Permission.AssetShare,
      ids: dto.ids,
    });

    const existingAssetIds = await this.albumRepository.getAssetIds(id, dto.ids);
    const results: Array<{ id: string; success: boolean; error?: string }> = [];

    const toAdd: string[] = [];
    for (const assetId of dto.ids) {
      if (existingAssetIds.has(assetId)) {
        results.push({ id: assetId, success: false, error: 'duplicate' });
      } else if (!allowedAssetIds.has(assetId)) {
        results.push({ id: assetId, success: false, error: 'no_permission' });
      } else {
        results.push({ id: assetId, success: true });
        toAdd.push(assetId);
      }
    }

    if (toAdd.length > 0) {
      await this.albumRepository.addAssetIds(id, toAdd);
      await this.albumRepository.update(id, {
        id,
        updatedAt: new Date().toISOString(),
        albumThumbnailAssetId: album.albumThumbnailAssetId ?? toAdd[0],
      });
      await this.emitAlbumUpdate(id);
    }

    return results;
  }

  async addAssetsToAlbums(auth: AuthDto, dto: { albumIds: string[]; assetIds: string[] }) {
    const results: any = {
      success: false,
      error: 'duplicate',
    };

    const allowedAlbumIds = await checkAccess(this.accessRepository, {
      auth,
      permission: Permission.AlbumAssetCreate,
      ids: dto.albumIds,
    });
    if (allowedAlbumIds.size === 0) {
      results.error = 'no_permission';
      return results;
    }

    const allowedAssetIds = await checkAccess(this.accessRepository, {
      auth,
      permission: Permission.AssetShare,
      ids: dto.assetIds,
    });
    if (allowedAssetIds.size === 0) {
      results.error = 'no_permission';
      return results;
    }

    const albumAssetValues: { albumId: string; assetId: string }[] = [];
    for (const albumId of allowedAlbumIds) {
      const existingAssetIds = await this.albumRepository.getAssetIds(albumId, [...allowedAssetIds]);
      const notPresentAssetIds = [...allowedAssetIds].filter((id) => !existingAssetIds.has(id));
      if (notPresentAssetIds.length === 0) {
        continue;
      }

      const album = await this.findOrFail(albumId, { withAssets: false });
      results.error = undefined;
      results.success = true;

      for (const assetId of notPresentAssetIds) {
        albumAssetValues.push({ albumId, assetId });
      }
      await this.albumRepository.update(albumId, {
        id: albumId,
        updatedAt: new Date().toISOString(),
        albumThumbnailAssetId: album.albumThumbnailAssetId ?? notPresentAssetIds[0],
      });
      await this.emitAlbumUpdate(albumId);
    }

    await this.albumRepository.addAssetIdsToAlbums(albumAssetValues);
    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: { ids: string[] }) {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.AlbumAssetDelete,
      ids: [id],
    });

    const album = await this.findOrFail(id, { withAssets: false });
    const existingAssetIds = await this.albumRepository.getAssetIds(id, dto.ids);

    const results: Array<{ id: string; success: boolean; error?: string }> = [];
    const toRemove: string[] = [];

    for (const assetId of dto.ids) {
      if (!existingAssetIds.has(assetId)) {
        results.push({ id: assetId, success: false, error: 'not_found' });
      } else {
        results.push({ id: assetId, success: true });
        toRemove.push(assetId);
      }
    }

    if (toRemove.length > 0) {
      await this.albumRepository.removeAssetIds(id, toRemove);
      if (album.albumThumbnailAssetId && toRemove.includes(album.albumThumbnailAssetId)) {
        await this.albumRepository.updateThumbnails();
      }
      await this.emitAlbumUpdate(id);
    }

    return results;
  }

  async addUsers(auth: AuthDto, id: string, dto: { albumUsers: Array<{ userId: string; role?: string }> }) {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.AlbumShare,
      ids: [id],
    });

    const album = await this.findOrFail(id, { withAssets: false });

    for (const { userId, role } of dto.albumUsers) {
      if (role === AlbumUserRole.Owner) {
        throw new Error('Cannot add another owner');
      }

      const exists = album.albumUsers?.find((au: any) => au.user?.id === userId || au.userId === userId);
      if (exists) {
        throw new Error('User already added');
      }

      const user = await this.userRepository.get(userId, {});
      if (!user) {
        throw new Error('User not found');
      }

      await this.albumUserRepository.create({ userId, albumId: id, role: role || AlbumUserRole.Editor });
    }

    const updatedAlbum = await this.findOrFail(id, { withAssets: true });
    return mapAlbumWithAssets(this.normalizeAlbum(updatedAlbum));
  }

  async removeUser(auth: AuthDto, id: string, userId: string): Promise<void> {
    if (userId === 'me') {
      userId = auth.user.id;
    }

    const album = await this.findOrFail(id, { withAssets: false });

    const exists = album.albumUsers?.find((au: any) => au.user?.id === userId || au.userId === userId);
    if (!exists) {
      throw new Error('Album not shared with user');
    }

    if (
      exists.role === AlbumUserRole.Owner &&
      album.albumUsers.filter(({ role }: { role: string }) => role === AlbumUserRole.Owner).length === 1
    ) {
      throw new Error('Cannot remove the last album owner');
    }

    if (auth.user.id !== userId) {
      await requireAccess(this.accessRepository, {
        auth,
        permission: Permission.AlbumShare,
        ids: [id],
      });
    }

    await this.albumUserRepository.delete({ albumId: id, userId });
  }

  async updateUser(auth: AuthDto, id: string, userId: string, dto: { role: string }): Promise<void> {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.AlbumShare,
      ids: [id],
    });
    const album = await this.findOrFail(id, { withAssets: false });
    const albumUser = album.albumUsers.find((entry: any) => entry.userId === userId);
    if (!albumUser) {
      throw new Error('Album not shared with user');
    }
    if (albumUser.role === AlbumUserRole.Owner || dto.role === AlbumUserRole.Owner) {
      throw new Error('User is owner');
    }
    await this.albumUserRepository.update({ albumId: id, userId }, { role: dto.role });
  }

  private async findOrFail(id: string, options: { withAssets: boolean }) {
    const album = await this.albumRepository.getById(id, options);
    if (!album) {
      throw new Error('Album not found');
    }
    return album;
  }

  private async emitAlbumUpdate(albumId: string): Promise<void> {
    const users = await this.ctx.db
      .selectFrom('album_user')
      .select('userId')
      .where('albumId', '=', albumId)
      .execute();
    await this.ctx.realtime.sendUsers(users.map(({ userId }) => userId), 'on_album_update', albumId);
  }

  private normalizeAlbum(album: any) {
    return {
      ...album,
      isActivityEnabled: Boolean(album.isActivityEnabled),
      assets: album.assets?.map((asset: any) => ({
        ...asset,
        isEdited: Boolean(asset.isEdited),
        isExternal: Boolean(asset.isExternal),
        isFavorite: Boolean(asset.isFavorite),
        isOffline: Boolean(asset.isOffline),
      })),
    };
  }
}
