/**
 * Memory service -- Workers-compatible version.
 *
 * Core business logic for memory CRUD operations.
 * No NestJS decorators, no BaseService, no job queues.
 */

import type { AuthDto } from 'src/dtos/auth.dto';
import { Permission } from 'src/enum';
import type { ServiceContext } from 'src/context';
import { AccessRepository } from 'src/repositories/access.repository';
import { MemoryRepository } from 'src/repositories/memory.repository';
import { requireAccess, checkAccess } from 'src/utils/access';
import { mapMemory } from 'src/dtos/memory.dto';

export class MemoryService {
  private memoryRepository: MemoryRepository;
  private accessRepository: AccessRepository;

  constructor(private ctx: ServiceContext) {
    this.memoryRepository = new MemoryRepository(ctx.db, ctx.env.DB);
    this.accessRepository = new AccessRepository(ctx.db);
  }

  async search(auth: AuthDto, dto: any) {
    const memories = await this.memoryRepository.search(auth.user.id, dto);
    return memories.filter((memory: any) => memory.assets.length > 0).map((memory: any) => mapMemory(memory, auth));
  }

  statistics(auth: AuthDto, dto: any) {
    return this.memoryRepository.statistics(auth.user.id, dto);
  }

  async get(auth: AuthDto, id: string) {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.MemoryRead,
      ids: [id],
    });
    const memory = await this.findOrFail(id, auth.user.id);
    return mapMemory(memory as any, auth);
  }

  async create(auth: AuthDto, dto: any) {
    const assetIds = dto.assetIds || [];
    const allowedAssetIds = await checkAccess(this.accessRepository, {
      auth,
      permission: Permission.AssetUpdate,
      ids: assetIds,
    });

    const memory = await this.memoryRepository.create(
      {
        id: this.ctx.crypto.randomUUID(),
        ownerId: auth.user.id,
        type: dto.type,
        data: JSON.stringify(dto.data || {}),
        isSaved: dto.isSaved ? 1 : 0,
        memoryAt: this.asIsoString(dto.memoryAt),
        seenAt: dto.seenAt ? this.asIsoString(dto.seenAt) : null,
        showAt: dto.showAt ? this.asIsoString(dto.showAt) : null,
        hideAt: dto.hideAt ? this.asIsoString(dto.hideAt) : null,
      },
      allowedAssetIds,
    );

    return mapMemory(memory as any, auth);
  }

  async update(auth: AuthDto, id: string, dto: any) {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.MemoryUpdate,
      ids: [id],
    });

    const memory = await this.memoryRepository.update(id, auth.user.id, {
      isSaved: dto.isSaved !== undefined ? (dto.isSaved ? 1 : 0) : undefined,
      memoryAt: dto.memoryAt ? this.asIsoString(dto.memoryAt) : undefined,
      seenAt: dto.seenAt ? this.asIsoString(dto.seenAt) : undefined,
    });

    return mapMemory(memory as any, auth);
  }

  async remove(auth: AuthDto, id: string): Promise<void> {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.MemoryDelete,
      ids: [id],
    });
    await this.memoryRepository.delete(id, auth.user.id);
  }

  async addAssets(auth: AuthDto, id: string, dto: { ids: string[] }) {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.MemoryUpdate,
      ids: [id],
    });

    const allowedAssetIds = await checkAccess(this.accessRepository, {
      auth,
      permission: Permission.AssetUpdate,
      ids: dto.ids,
    });

    const existingAssetIds = await this.memoryRepository.getAssetIds(id, auth.user.id, dto.ids);
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
      await this.memoryRepository.addAssetIds(id, auth.user.id, toAdd);
      await this.memoryRepository.update(id, auth.user.id, { updatedAt: new Date().toISOString() });
    }

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: { ids: string[] }) {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.MemoryUpdate,
      ids: [id],
    });

    const existingAssetIds = await this.memoryRepository.getAssetIds(id, auth.user.id, dto.ids);
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
      await this.memoryRepository.removeAssetIds(id, auth.user.id, toRemove);
      await this.memoryRepository.update(id, auth.user.id, { updatedAt: new Date().toISOString() });
    }

    return results;
  }

  private async findOrFail(id: string, ownerId: string) {
    const memory = await this.memoryRepository.get(id, ownerId);
    if (!memory) {
      throw new Error('Memory not found');
    }
    return memory;
  }

  private asIsoString(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : value;
  }
}
