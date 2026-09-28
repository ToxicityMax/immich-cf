/**
 * Activity service -- Workers-compatible version.
 *
 * Core business logic for activity CRUD operations.
 * No NestJS decorators, no BaseService, no job queues.
 */

import type { AuthDto } from 'src/dtos/auth.dto';
import { mapActivity } from 'src/dtos/activity.dto';
import { Permission } from 'src/enum';
import type { ServiceContext } from 'src/context';
import { AccessRepository } from 'src/repositories/access.repository';
import { ActivityRepository } from 'src/repositories/activity.repository';
import { requireAccess } from 'src/utils/access';
import { generateUUIDv7 } from 'src/utils/uuid';

export class ActivityService {
  private activityRepository: ActivityRepository;
  private accessRepository: AccessRepository;

  constructor(private ctx: ServiceContext) {
    this.activityRepository = new ActivityRepository(ctx.db);
    this.accessRepository = new AccessRepository(ctx.db);
  }

  async getAll(auth: AuthDto, dto: any) {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.AlbumRead,
      ids: [dto.albumId],
    });

    const activities = await this.activityRepository.search({
      userId: dto.userId,
      albumId: dto.albumId,
      assetId: dto.level === 'album' ? null : dto.assetId,
      isLiked: dto.type === 'like' ? true : undefined,
    });

    return activities.map((activity: any) => mapActivity(activity));
  }

  async getStatistics(auth: AuthDto, dto: any) {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.AlbumRead,
      ids: [dto.albumId],
    });
    return this.activityRepository.getStatistics({
      albumId: dto.albumId,
      assetId: dto.assetId,
    });
  }

  async create(auth: AuthDto, dto: any) {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.ActivityCreate,
      ids: [dto.albumId],
    });

    const common = {
      userId: auth.user.id,
      assetId: dto.assetId ?? null,
      albumId: dto.albumId,
    };

    let activity: any;
    let duplicate = false;

    if (dto.type === 'like') {
      delete dto.comment;
      const results = await this.activityRepository.search({
        ...common,
        assetId: dto.assetId ?? null,
        isLiked: true,
      });
      activity = results[0];
      duplicate = !!activity;
    }

    if (!activity) {
      activity = await this.activityRepository.create({
        id: this.ctx.crypto.randomUUID(),
        ...common,
        isLiked: dto.type === 'like' ? 1 : 0,
        comment: dto.comment ?? null,
        updateId: generateUUIDv7(),
      });
    }

    return { duplicate, value: mapActivity(activity) };
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.ActivityDelete,
      ids: [id],
    });
    await this.activityRepository.delete(id);
  }
}
