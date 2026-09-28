/**
 * Stack service -- Workers-compatible version.
 *
 * Core business logic for stack CRUD operations.
 * No NestJS decorators, no BaseService, no job queues.
 */

import type { AuthDto } from 'src/dtos/auth.dto';
import { Permission } from 'src/enum';
import type { ServiceContext } from 'src/context';
import { AccessRepository } from 'src/repositories/access.repository';
import { StackRepository } from 'src/repositories/stack.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { requireAccess } from 'src/utils/access';
import { NotFoundException } from 'src/utils/errors';
import { mapStack } from 'src/dtos/stack.dto';

export class StackService {
  private stackRepository: StackRepository;
  private accessRepository: AccessRepository;
  private assetRepository: AssetRepository;

  constructor(private ctx: ServiceContext) {
    this.stackRepository = new StackRepository(ctx.db, ctx.env.DB);
    this.accessRepository = new AccessRepository(ctx.db);
    this.assetRepository = new AssetRepository(ctx.db);
  }

  async search(auth: AuthDto, dto: any) {
    const stacks = await this.stackRepository.search({
      ownerId: auth.user.id,
      primaryAssetId: dto.primaryAssetId,
    }, !!auth.session?.hasElevatedPermission);
    return stacks.map((stack: any) => mapStack(stack, { auth }));
  }

  async create(auth: AuthDto, dto: any) {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.AssetUpdate,
      ids: dto.assetIds,
    });

    const stack = await this.stackRepository.create(
      { ownerId: auth.user.id },
      dto.assetIds,
      !!auth.session?.hasElevatedPermission,
    );
    await this.ctx.realtime.sendUser(auth.user.id, 'on_asset_stack_update');
    return mapStack(stack as any, { auth });
  }

  async get(auth: AuthDto, id: string) {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.StackRead,
      ids: [id],
    });
    const stack = await this.findOrFail(id, !!auth.session?.hasElevatedPermission);
    return mapStack(stack as any, { auth });
  }

  async update(auth: AuthDto, id: string, dto: any) {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.StackUpdate,
      ids: [id],
    });
    const includeLocked = !!auth.session?.hasElevatedPermission;
    const stack = await this.findOrFail(id, includeLocked);
    if (dto.primaryAssetId && !stack.assets?.some((a: any) => a.id === dto.primaryAssetId)) {
      throw new Error('Primary asset must be in the stack');
    }

    const updatedStack = await this.stackRepository.update(
      id,
      { id, primaryAssetId: dto.primaryAssetId },
      includeLocked,
    );
    await this.ctx.realtime.sendUser(auth.user.id, 'on_asset_stack_update');
    return mapStack(updatedStack as any, { auth });
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.StackDelete,
      ids: [id],
    });
    await this.stackRepository.delete(id);
    await this.ctx.realtime.sendUser(auth.user.id, 'on_asset_stack_update');
  }

  async deleteAll(auth: AuthDto, dto: { ids: string[] }): Promise<void> {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.StackDelete,
      ids: dto.ids,
    });
    await this.stackRepository.deleteAll(dto.ids);
    await this.ctx.realtime.sendUser(auth.user.id, 'on_asset_stack_update');
  }

  async removeAsset(auth: AuthDto, dto: { id: string; assetId: string }): Promise<void> {
    const { id: stackId, assetId } = dto;
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.StackUpdate,
      ids: [stackId],
    });

    const stack = await this.stackRepository.getForAssetRemoval(assetId);

    if (!stack?.id || stack.id !== stackId) {
      throw new Error('Asset not in stack');
    }

    if (stack.primaryAssetId === assetId) {
      throw new Error("Cannot remove stack's primary asset");
    }

    await this.assetRepository.update({ id: assetId, stackId: null });
    await this.ctx.realtime.sendUser(auth.user.id, 'on_asset_stack_update');
  }

  private async findOrFail(id: string, includeLocked = false) {
    const stack = await this.stackRepository.getById(id, includeLocked);
    if (!stack) {
      throw new NotFoundException('Asset stack not found');
    }
    return stack;
  }
}
