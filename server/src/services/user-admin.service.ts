/**
 * User Admin service -- Workers-compatible version.
 *
 * Admin operations for user management.
 * No NestJS decorators, no BaseService, no job queues.
 */

import type { AuthDto } from 'src/dtos/auth.dto';
import { mapUserAdmin } from 'src/dtos/user.dto';
import { mapSession } from 'src/dtos/session.dto';
import type { ServiceContext } from 'src/context';
import { mapPreferences } from 'src/dtos/user-preferences.dto';
import { UserMetadataKey } from 'src/enum';
import { UserRepository } from 'src/repositories/user.repository';
import { SessionRepository } from 'src/repositories/session.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { AlbumRepository } from 'src/repositories/album.repository';
import { BadRequestException, NotFoundException, ForbiddenException } from 'src/utils/errors';
import { getPreferences, mergePreferences } from 'src/utils/preferences';
import { generateUUIDv7 } from 'src/utils/uuid';

export class UserAdminService {
  private userRepository: UserRepository;
  private sessionRepository: SessionRepository;
  private assetRepository: AssetRepository;
  private albumRepository: AlbumRepository;

  constructor(private ctx: ServiceContext) {
    this.userRepository = new UserRepository(ctx.db);
    this.sessionRepository = new SessionRepository(ctx.db);
    this.assetRepository = new AssetRepository(ctx.db);
    this.albumRepository = new AlbumRepository(ctx.db);
  }

  async search(auth: AuthDto, dto: any) {
    const users = await this.userRepository.getList({
      id: dto.id,
      withDeleted: dto.withDeleted,
    });
    return users.map((user) => this.mapUser(user));
  }

  async create(dto: any) {
    const { notify, ...userDto } = dto;

    if (!userDto.password) {
      throw new BadRequestException('password is required');
    }

    const exists = await this.userRepository.getByEmail(userDto.email);
    if (exists) {
      throw new BadRequestException('User exists');
    }

    if (!userDto.isAdmin) {
      const localAdmin = await this.userRepository.getAdmin();
      if (!localAdmin) {
        throw new BadRequestException('The first registered account must be the administrator.');
      }
    }

    const now = new Date().toISOString();
    const id = this.ctx.crypto.randomUUID();
    const payload: any = {
      id,
      email: userDto.email,
      name: userDto.name || '',
      isAdmin: userDto.isAdmin ? 1 : 0,
      storageLabel: userDto.storageLabel || null,
      quotaSizeInBytes: userDto.quotaSizeInBytes ?? null,
      shouldChangePassword: userDto.shouldChangePassword ? 1 : 0,
      avatarColor: userDto.avatarColor || null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      profileImagePath: '',
      oauthId: '',
      quotaUsageInBytes: 0,
      profileChangedAt: now,
      clusterGroupId: id,
      updateId: generateUUIDv7(),
    };
    if (userDto.password) {
      payload.password = await this.ctx.crypto.hashBcrypt(userDto.password, 10);
    }

    const user = await this.userRepository.create(payload);
    return this.mapUser(user);
  }

  async get(auth: AuthDto, id: string) {
    const user = await this.userRepository.get(id, { withDeleted: true });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return this.mapUser(user);
  }

  async update(auth: AuthDto, id: string, dto: any) {
    const user = await this.userRepository.get(id, {});
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (dto.isAdmin !== undefined && dto.isAdmin !== auth.user.isAdmin && auth.user.id === id) {
      throw new ForbiddenException('Admin status can only be changed by another admin');
    }

    if (dto.email) {
      const duplicate = await this.userRepository.getByEmail(dto.email);
      if (duplicate && duplicate.id !== id) {
        throw new Error('Email already in use by another account');
      }
    }

    if (dto.storageLabel) {
      const duplicate = await this.userRepository.getByStorageLabel(dto.storageLabel);
      if (duplicate && duplicate.id !== id) {
        throw new Error('Storage label already in use by another account');
      }
    }

    if (dto.password) {
      dto.password = await this.ctx.crypto.hashBcrypt(dto.password, 10);
    }

    if (dto.pinCode) {
      dto.pinCode = await this.ctx.crypto.hashBcrypt(dto.pinCode, 10);
    }

    if (dto.storageLabel === '') {
      dto.storageLabel = null;
    }

    const updatedUser = await this.userRepository.update(id, { ...dto, updatedAt: new Date().toISOString() });
    return this.mapUser(updatedUser);
  }

  async delete(auth: AuthDto, id: string, dto: any) {
    const user = await this.userRepository.get(id, {});
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (auth.user.id === id) {
      throw new Error('Cannot delete your own account');
    }

    await this.albumRepository.softDeleteAll(id);

    const status = dto.force ? 'removing' : 'deleted';
    const updatedUser = await this.userRepository.update(id, {
      status,
      deletedAt: new Date().toISOString(),
    });

    await this.ctx.realtime.broadcast('on_user_delete', id);
    await this.ctx.realtime.disconnectUser(id);

    return this.mapUser(updatedUser);
  }

  async restore(auth: AuthDto, id: string) {
    const user = await this.userRepository.get(id, { withDeleted: true });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.albumRepository.restoreAll(id);
    const restored = await this.userRepository.restore(id);
    return this.mapUser(restored);
  }

  async getSessions(auth: AuthDto, id: string) {
    const sessions = await this.sessionRepository.getByUserId(id);
    return sessions.map((session) => mapSession(session as any));
  }

  async getStatistics(auth: AuthDto, id: string, dto: any) {
    const stats = await this.assetRepository.getStatistics(id, dto);
    return stats;
  }

  async getPreferences(auth: AuthDto, id: string) {
    const user = await this.userRepository.get(id, { withDeleted: true });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    const metadata = await this.userRepository.getMetadata(id);
    const items = metadata.map((m: any) => ({
      key: m.key as UserMetadataKey,
      value: typeof m.value === 'string' ? JSON.parse(m.value) : m.value,
    }));
    return mapPreferences(getPreferences(items));
  }

  async updatePreferences(auth: AuthDto, id: string, dto: any) {
    const user = await this.userRepository.get(id, { withDeleted: false });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    const metadata = await this.userRepository.getMetadata(id);
    const items = metadata.map((m: any) => ({
      key: m.key as UserMetadataKey,
      value: typeof m.value === 'string' ? JSON.parse(m.value) : m.value,
    }));
    const preferences = mergePreferences(getPreferences(items), dto);

    await this.userRepository.upsertMetadata(id, {
      key: UserMetadataKey.Preferences,
      value: JSON.stringify(preferences),
    });

    return mapPreferences(preferences);
  }

  private mapUser(user: any) {
    const metadata = (user.metadata || []).map((item: any) => {
      if (typeof item.value !== 'string') {
        return item;
      }

      try {
        return { ...item, value: JSON.parse(item.value) };
      } catch {
        return item;
      }
    });

    return mapUserAdmin({ ...user, metadata });
  }
}
