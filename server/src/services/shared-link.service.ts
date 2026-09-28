/**
 * Shared Link service -- Workers-compatible version.
 *
 * Core business logic for shared link CRUD operations.
 * No NestJS decorators, no BaseService, no job queues.
 */

import type { AuthDto } from 'src/dtos/auth.dto';
import {
  mapSharedLink,
  type SharedLinkCreateDto,
  type SharedLinkEditDto,
  type SharedLinkLoginDto,
} from 'src/dtos/shared-link.dto';
import { Permission, SharedLinkType } from 'src/enum';
import type { ServiceContext } from 'src/context';
import { AccessRepository } from 'src/repositories/access.repository';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository';
import { SharedLinkAssetRepository } from 'src/repositories/shared-link-asset.repository';
import { requireAccess, checkAccess } from 'src/utils/access';
import { BadRequestException, ForbiddenException, UnauthorizedException } from 'src/utils/errors';

export class SharedLinkService {
  private sharedLinkRepository: SharedLinkRepository;
  private sharedLinkAssetRepository: SharedLinkAssetRepository;
  private accessRepository: AccessRepository;

  constructor(private ctx: ServiceContext) {
    this.sharedLinkRepository = new SharedLinkRepository(ctx.db, ctx.env.DB);
    this.sharedLinkAssetRepository = new SharedLinkAssetRepository(ctx.db, ctx.env.DB);
    this.accessRepository = new AccessRepository(ctx.db);
  }

  async getAll(auth: AuthDto, dto: { id?: string; albumId?: string }) {
    const links = await this.sharedLinkRepository.getAll({
      userId: auth.user.id,
      id: dto.id,
      albumId: dto.albumId,
    });
    return links.map((link: any) => mapSharedLink(link, { stripAssetMetadata: false }));
  }

  async login(auth: AuthDto, dto: SharedLinkLoginDto) {
    if (!auth.sharedLink) {
      throw new ForbiddenException();
    }

    const sharedLink = await this.findOrFail(auth.sharedLink.userId, auth.sharedLink.id);
    if (!sharedLink.password) {
      throw new BadRequestException('Shared link is not password protected');
    }
    if (sharedLink.password !== dto.password) {
      throw new UnauthorizedException('Invalid password');
    }

    return {
      sharedLink: mapSharedLink(sharedLink as any, { stripAssetMetadata: !Boolean(sharedLink.showExif) }),
      token: await this.asToken(sharedLink),
    };
  }

  async getMine(auth: AuthDto, authTokens: string[]) {
    if (!auth.sharedLink) {
      throw new ForbiddenException();
    }

    const sharedLink = await this.findOrFail(auth.sharedLink.userId, auth.sharedLink.id);
    if (sharedLink.password && !authTokens.includes(await this.asToken(sharedLink))) {
      throw new UnauthorizedException(authTokens.length === 0 ? 'Password required' : 'Invalid password');
    }

    return mapSharedLink(sharedLink as any, { stripAssetMetadata: !Boolean(sharedLink.showExif) });
  }

  async get(auth: AuthDto, id: string) {
    const sharedLink = await this.findOrFail(auth.user.id, id);
    return mapSharedLink(sharedLink as any, { stripAssetMetadata: false });
  }

  async create(auth: AuthDto, dto: SharedLinkCreateDto) {
    switch (dto.type) {
      case SharedLinkType.Album: {
        if (!dto.albumId) {
          throw new BadRequestException('Invalid albumId');
        }
        await requireAccess(this.accessRepository, {
          auth,
          permission: Permission.AlbumShare,
          ids: [dto.albumId],
        });
        break;
      }
      case SharedLinkType.Individual: {
        if (!dto.assetIds || dto.assetIds.length === 0) {
          throw new BadRequestException('Invalid assetIds');
        }
        await requireAccess(this.accessRepository, {
          auth,
          permission: Permission.AssetShare,
          ids: dto.assetIds,
        });
        break;
      }
    }

    const keyBytes = crypto.getRandomValues(new Uint8Array(50));

    try {
      const sharedLink = await this.sharedLinkRepository.create({
        id: this.ctx.crypto.randomUUID(),
        key: keyBytes,
        userId: auth.user.id,
        type: dto.type,
        albumId: dto.albumId || null,
        assetIds: dto.assetIds,
        description: dto.description || null,
        password: dto.password || null,
        createdAt: new Date().toISOString(),
        expiresAt: dto.expiresAt?.toISOString() || null,
        allowUpload: dto.allowUpload ?? 1,
        allowDownload: dto.showMetadata === false ? 0 : (dto.allowDownload ?? 1),
        showExif: dto.showMetadata ?? 1,
        slug: dto.slug || null,
      } as any);

      return mapSharedLink(sharedLink as any, { stripAssetMetadata: false });
    } catch (error) {
      this.handleSaveError(error);
    }
  }

  async update(auth: AuthDto, id: string, dto: SharedLinkEditDto) {
    await this.findOrFail(auth.user.id, id);

    try {
      const sharedLink = await this.sharedLinkRepository.update({
        id,
        userId: auth.user.id,
        description: dto.description,
        password: dto.password,
        expiresAt: dto.expiresAt?.toISOString() ?? dto.expiresAt,
        allowUpload: dto.allowUpload,
        allowDownload: dto.allowDownload,
        showExif: dto.showMetadata,
        slug: dto.slug || null,
      });

      return mapSharedLink(sharedLink as any, { stripAssetMetadata: false });
    } catch (error) {
      this.handleSaveError(error);
    }
  }

  async remove(auth: AuthDto, id: string): Promise<void> {
    await this.findOrFail(auth.user.id, id);
    await this.sharedLinkRepository.remove(id);
  }

  async addAssets(auth: AuthDto, id: string, dto: { assetIds: string[] }) {
    const sharedLink = await this.findOrFail(auth.user.id, id);

    if (sharedLink.type !== SharedLinkType.Individual) {
      throw new BadRequestException('Invalid shared link type');
    }

    const existingAssetIds = new Set(
      (sharedLink.assets || []).map((asset: any) => asset.id),
    );
    const notPresentAssetIds = dto.assetIds.filter(
      (assetId) => !existingAssetIds.has(assetId),
    );
    const allowedAssetIds = await checkAccess(this.accessRepository, {
      auth,
      permission: Permission.AssetShare,
      ids: notPresentAssetIds,
    });

    const results: Array<{ assetId: string; success: boolean; error?: string }> = [];
    const toAdd: string[] = [];

    for (const assetId of dto.assetIds) {
      if (existingAssetIds.has(assetId)) {
        results.push({ assetId, success: false, error: 'duplicate' });
      } else if (!allowedAssetIds.has(assetId)) {
        results.push({ assetId, success: false, error: 'no_permission' });
      } else {
        results.push({ assetId, success: true });
        toAdd.push(assetId);
      }
    }

    if (toAdd.length > 0) {
      await this.sharedLinkRepository.addAssets(id, toAdd);
    }

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: { assetIds: string[] }) {
    const sharedLink = await this.findOrFail(auth.user.id, id);

    if (sharedLink.type !== SharedLinkType.Individual) {
      throw new BadRequestException('Invalid shared link type');
    }

    const removedAssetIds = await this.sharedLinkAssetRepository.remove(id, dto.assetIds);
    const removedSet = new Set(removedAssetIds);

    const results: Array<{ assetId: string; success: boolean; error?: string }> = [];

    for (const assetId of dto.assetIds) {
      if (!removedSet.has(assetId)) {
        results.push({ assetId, success: false, error: 'not_found' });
      } else {
        results.push({ assetId, success: true });
      }
    }

    return results;
  }

  private async findOrFail(userId: string, id: string) {
    const sharedLink = await this.sharedLinkRepository.get(userId, id);
    if (!sharedLink) {
      throw new BadRequestException('Shared link not found');
    }
    return sharedLink;
  }

  private asToken(sharedLink: { id: string; password: string | null }) {
    return this.ctx.crypto.hashSha256(`${sharedLink.id}-${sharedLink.password}`);
  }

  private handleSaveError(error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('UNIQUE constraint failed: shared_link.slug')) {
      throw new BadRequestException('Failed to save shared link');
    }
    throw error;
  }
}
