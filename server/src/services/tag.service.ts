/**
 * Tag service -- Workers-compatible version.
 *
 * Core business logic for tag CRUD operations.
 * No NestJS decorators, no BaseService, no job queues.
 */

import type { AuthDto } from 'src/dtos/auth.dto';
import { Permission } from 'src/enum';
import type { ServiceContext } from 'src/context';
import { AccessRepository } from 'src/repositories/access.repository';
import { TagRepository } from 'src/repositories/tag.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { requireAccess, checkAccess } from 'src/utils/access';
import { mapTag } from 'src/dtos/tag.dto';
import { BadRequestException } from 'src/utils/errors';

export class TagService {
  private tagRepository: TagRepository;
  private accessRepository: AccessRepository;
  private assetRepository: AssetRepository;

  constructor(private ctx: ServiceContext) {
    this.tagRepository = new TagRepository(ctx.db, ctx.env.DB);
    this.accessRepository = new AccessRepository(ctx.db);
    this.assetRepository = new AssetRepository(ctx.db);
  }

  async getAll(auth: AuthDto) {
    const tags = await this.tagRepository.getAll(auth.user.id);
    return tags.map((tag: any) => mapTag(tag));
  }

  async get(auth: AuthDto, id: string) {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.TagRead,
      ids: [id],
    });
    const tag = await this.findOrFail(id);
    return mapTag(tag as any);
  }

  async create(auth: AuthDto, dto: any) {
    let parent: any;
    if (dto.parentId) {
      await requireAccess(this.accessRepository, {
        auth,
        permission: Permission.TagRead,
        ids: [dto.parentId],
      });
      parent = await this.tagRepository.get(dto.parentId);
      if (!parent) {
        throw new Error('Tag not found');
      }
    }

    const userId = auth.user.id;
    const value = parent ? `${parent.value}/${dto.name}` : dto.name;
    const duplicate = await this.tagRepository.getByValue(userId, value);
    if (duplicate) {
      throw new BadRequestException('A tag with that name already exists');
    }

    const { color } = dto;
    const tag = await this.tagRepository.create({ userId, value, color, parentId: parent?.id });
    return mapTag(tag as any);
  }

  async update(auth: AuthDto, id: string, dto: any) {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.TagUpdate,
      ids: [id],
    });

    const existing = await this.findOrFail(id);
    const parts = existing.value.split('/');
    if (dto.name) parts[parts.length - 1] = dto.name;
    const value = parts.join('/');
    const duplicate = await this.tagRepository.getByValue(auth.user.id, value);
    if (duplicate && duplicate.id !== id) {
      throw new BadRequestException('A tag with that name already exists');
    }
    const tag = await this.tagRepository.update(id, { value, color: dto.color });
    return mapTag(tag as any);
  }

  async upsert(auth: AuthDto, dto: any) {
    const tags = await this.tagRepository.upsertTags({ userId: auth.user.id, tags: dto.tags });
    return tags.map((tag: any) => mapTag(tag));
  }

  async remove(auth: AuthDto, id: string): Promise<void> {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.TagDelete,
      ids: [id],
    });
    await this.tagRepository.delete(id);
  }

  async bulkTagAssets(auth: AuthDto, dto: any) {
    const [tagIds, assetIds] = await Promise.all([
      checkAccess(this.accessRepository, { auth, permission: Permission.TagAsset, ids: dto.tagIds }),
      checkAccess(this.accessRepository, { auth, permission: Permission.AssetUpdate, ids: dto.assetIds }),
    ]);

    const items: Array<{ tagId: string; assetId: string }> = [];
    for (const tagId of tagIds) {
      for (const assetId of assetIds) {
        items.push({ tagId, assetId });
      }
    }

    const results = await this.tagRepository.upsertAssetIds(items);
    return { count: results.length };
  }

  async addAssets(auth: AuthDto, id: string, dto: { ids: string[] }) {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.TagAsset,
      ids: [id],
    });

    const allowedAssetIds = await checkAccess(this.accessRepository, {
      auth,
      permission: Permission.AssetUpdate,
      ids: dto.ids,
    });

    const existingAssetIds = await this.tagRepository.getAssetIds(id, dto.ids);
    const results: Array<{ id: string; success: boolean; error?: string }> = [];

    const toAdd: string[] = [];
    for (const assetId of dto.ids) {
      if (existingAssetIds.has(assetId)) {
        results.push({ id: assetId, success: false, error: 'duplicate' });
      } else if (!allowedAssetIds.has(assetId)) {
        results.push({ id: assetId, success: false, error: 'no_permission' });
      } else {
        results.push({ id: assetId, success: true });
        existingAssetIds.add(assetId);
        toAdd.push(assetId);
      }
    }

    if (toAdd.length > 0) {
      await this.tagRepository.addAssetIds(id, toAdd);
    }

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: { ids: string[] }) {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.TagAsset,
      ids: [id],
    });

    const existingAssetIds = await this.tagRepository.getAssetIds(id, dto.ids);
    const results: Array<{ id: string; success: boolean; error?: string }> = [];
    const toRemove: string[] = [];

    for (const assetId of dto.ids) {
      if (!existingAssetIds.has(assetId)) {
        results.push({ id: assetId, success: false, error: 'not_found' });
      } else {
        results.push({ id: assetId, success: true });
        existingAssetIds.delete(assetId);
        toRemove.push(assetId);
      }
    }

    if (toRemove.length > 0) {
      await this.tagRepository.removeAssetIds(id, toRemove);
    }

    return results;
  }

  private async findOrFail(id: string) {
    const tag = await this.tagRepository.get(id);
    if (!tag) {
      throw new Error('Tag not found');
    }
    return tag;
  }
}
