/**
 * API Key service — Workers-compatible version.
 *
 * Manages API key CRUD operations.
 * No NestJS decorators, no BaseService.
 */

import type { ApiKey } from 'src/database';
import type {
  APIKeyCreateDto,
  APIKeyCreateResponseDto,
  APIKeyResponseDto,
  APIKeyUpdateDto,
} from 'src/dtos/api-key.dto';
import type { AuthDto } from 'src/dtos/auth.dto';
import { Permission } from 'src/enum';
import type { ServiceContext } from 'src/context';
import { ApiKeyRepository } from 'src/repositories/api-key.repository';
import { isGranted } from 'src/utils/access';
import { generateUUIDv7 } from 'src/utils/uuid';

export class ApiKeyService {
  private get crypto() {
    return this.ctx.crypto;
  }
  private apiKeyRepo: ApiKeyRepository;

  constructor(private ctx: ServiceContext) {
    this.apiKeyRepo = new ApiKeyRepository(ctx.db);
  }

  async create(
    auth: AuthDto,
    dto: APIKeyCreateDto,
  ): Promise<APIKeyCreateResponseDto> {
    const token = this.crypto.randomBytesAsText(32);
    const tokenHashed = await this.crypto.hashSha256(token);

    if (
      auth.apiKey &&
      !isGranted({ requested: dto.permissions, current: auth.apiKey.permissions })
    ) {
      throw new ApiKeyError(400, 'Cannot grant permissions you do not have');
    }

    const entity = await this.apiKeyRepo.create({
      id: this.crypto.randomUUID(),
      key: tokenHashed,
      name: dto.name || 'API Key',
      userId: auth.user.id,
      permissions: JSON.stringify(dto.permissions),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updateId: generateUUIDv7(),
    });

    const apiKey = this.map(entity);
    return { ...apiKey, secret: token, apiKey };
  }

  async update(
    auth: AuthDto,
    id: string,
    dto: APIKeyUpdateDto,
  ): Promise<APIKeyResponseDto> {
    const exists = await this.apiKeyRepo.getById(auth.user.id, id);
    if (!exists) {
      throw new ApiKeyError(400, 'API Key not found');
    }

    if (
      auth.apiKey &&
      dto.permissions &&
      !isGranted({ requested: dto.permissions, current: auth.apiKey.permissions })
    ) {
      throw new ApiKeyError(400, 'Cannot grant permissions you do not have');
    }

    const updateData: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
      updateId: generateUUIDv7(),
    };
    if (dto.name !== undefined) {
      updateData.name = dto.name;
    }
    if (dto.permissions !== undefined) {
      updateData.permissions = JSON.stringify(dto.permissions);
    }

    const key = await this.apiKeyRepo.update(auth.user.id, id, updateData);
    if (dto.permissions !== undefined) {
      await this.ctx.realtime.disconnectApiKey(id);
    }
    return this.map(key);
  }

  async rotate(auth: AuthDto, id: string): Promise<APIKeyCreateResponseDto> {
    const existing = await this.apiKeyRepo.getById(auth.user.id, id);
    if (!existing) {
      throw new ApiKeyError(400, 'API Key not found');
    }

    const permissions = this.parsePermissions(existing.permissions);
    if (
      auth.apiKey &&
      !isGranted({ requested: permissions, current: auth.apiKey.permissions })
    ) {
      throw new ApiKeyError(400, 'Cannot rotate an API Key with permissions you do not have');
    }

    const token = this.crypto.randomBytesAsText(32);
    const key = await this.apiKeyRepo.update(auth.user.id, id, {
      key: await this.crypto.hashSha256(token),
      updatedAt: new Date().toISOString(),
      updateId: generateUUIDv7(),
    });
    await this.ctx.realtime.disconnectApiKey(id);

    const apiKey = this.map(key);
    return { ...apiKey, secret: token, apiKey };
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    const exists = await this.apiKeyRepo.getById(auth.user.id, id);
    if (!exists) {
      throw new ApiKeyError(400, 'API Key not found');
    }

    await this.apiKeyRepo.delete(auth.user.id, id);
    await this.ctx.realtime.disconnectApiKey(id);
  }

  async getMine(auth: AuthDto): Promise<APIKeyResponseDto> {
    if (!auth.apiKey) {
      throw new ApiKeyError(403, 'Not authenticated with an API Key');
    }

    const key = await this.apiKeyRepo.getById(auth.user.id, auth.apiKey.id);
    if (!key) {
      throw new ApiKeyError(400, 'API Key not found');
    }

    return this.map(key);
  }

  async getById(auth: AuthDto, id: string): Promise<APIKeyResponseDto> {
    const key = await this.apiKeyRepo.getById(auth.user.id, id);
    if (!key) {
      throw new ApiKeyError(400, 'API Key not found');
    }
    return this.map(key);
  }

  async getAll(auth: AuthDto): Promise<APIKeyResponseDto[]> {
    const keys = await this.apiKeyRepo.getByUserId(auth.user.id);
    return keys.map((key) => this.map(key));
  }

  private map(entity: Record<string, unknown>): APIKeyResponseDto {
    return {
      id: entity.id as string,
      name: entity.name as string,
      createdAt: new Date(entity.createdAt as string),
      updatedAt: new Date(entity.updatedAt as string),
      permissions: this.parsePermissions(entity.permissions),
    };
  }

  private parsePermissions(value: unknown): Permission[] {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as Permission[];
      } catch {
        return [];
      }
    }

    return (value as Permission[]) || [];
  }
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class ApiKeyError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiKeyError';
  }
}
