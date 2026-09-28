import type { ServiceContext } from 'src/context';
import type { AuthDto } from 'src/dtos/auth.dto';
import type { TrashResponseDto } from 'src/dtos/trash.dto';
import { AssetStatus } from 'src/enum';
import { StorageCore } from 'src/cores/storage.core';

const D1_MAX_BINDS = 100;
const RESTORE_ID_CHUNK_SIZE = D1_MAX_BINDS - 3;
const DELETE_ID_CHUNK_SIZE = D1_MAX_BINDS - 2;
const R2_DELETE_CHUNK_SIZE = 1000;

type TrashedAsset = {
  id: string;
  ownerId: string;
  originalPath: string;
  encodedVideoPath: string | null;
  fileSizeInByte: number | null;
  stackId: string | null;
};

export class TrashService {
  constructor(private ctx: ServiceContext) {}

  async empty(auth: AuthDto): Promise<TrashResponseDto> {
    const userId = auth.user.id;
    const { results: trashedAssets } = await this.ctx.env.DB.prepare(`
      SELECT asset.id, asset.ownerId, asset.originalPath, asset.encodedVideoPath,
        asset.stackId, asset_exif.fileSizeInByte
      FROM asset
      LEFT JOIN asset_exif ON asset_exif.assetId = asset.id
      WHERE asset.ownerId = ? AND asset.status = ?
    `).bind(userId, AssetStatus.Trashed).all<TrashedAsset>();

    if (trashedAssets.length === 0) {
      return { count: 0 };
    }

    await this.permanentlyDelete(userId, trashedAssets);
    return { count: trashedAssets.length };
  }

  async delete(auth: AuthDto, ids: string[]): Promise<number> {
    const userId = auth.user.id;
    const assets: TrashedAsset[] = [];
    for (let index = 0; index < ids.length; index += DELETE_ID_CHUNK_SIZE) {
      const chunk = ids.slice(index, index + DELETE_ID_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      const { results } = await this.ctx.env.DB.prepare(`
        SELECT asset.id, asset.ownerId, asset.originalPath, asset.encodedVideoPath,
          asset.stackId, asset_exif.fileSizeInByte
        FROM asset
        LEFT JOIN asset_exif ON asset_exif.assetId = asset.id
        WHERE asset.ownerId = ? AND asset.id IN (${placeholders})
      `).bind(userId, ...chunk).all<TrashedAsset>();
      assets.push(...results);
    }

    await this.permanentlyDelete(userId, assets);
    return assets.length;
  }

  private async permanentlyDelete(userId: string, assets: TrashedAsset[]): Promise<void> {
    if (assets.length === 0) {
      return;
    }

    const assetIds = assets.map(({ id }) => id);
    const deletingIds = new Set(assetIds);
    const objectKeys = new Set<string>();
    for (const asset of assets) {
      objectKeys.add(asset.originalPath);
      if (asset.encodedVideoPath) {
        objectKeys.add(asset.encodedVideoPath);
      }
    }

    if (assets.length > 20) {
      let cursor: string | undefined;
      do {
        const listed = await this.ctx.bucket.list({ prefix: StorageCore.getUserPrefix(userId), cursor });
        for (const object of listed.objects) {
          const assetId = StorageCore.getAssetIdFromKey(object.key);
          if (assetId && deletingIds.has(assetId)) {
            objectKeys.add(object.key);
          }
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    } else {
      for (const asset of assets) {
        let cursor: string | undefined;
        do {
          const listed = await this.ctx.bucket.list({
            prefix: StorageCore.getAssetPrefix(asset.ownerId, asset.id),
            cursor,
          });
          for (const object of listed.objects) {
            objectKeys.add(object.key);
          }
          cursor = listed.truncated ? listed.cursor : undefined;
        } while (cursor);
      }
    }

    for (let index = 0; index < assetIds.length; index += DELETE_ID_CHUNK_SIZE) {
      const chunk = assetIds.slice(index, index + DELETE_ID_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      const { results } = await this.ctx.env.DB.prepare(`
        SELECT path FROM asset_file WHERE assetId IN (${placeholders})
      `).bind(...chunk).all<{ path: string }>();
      for (const { path } of results) {
        objectKeys.add(path);
      }
    }

    const keys = [...objectKeys].filter(Boolean);

    // R2 cannot participate in a D1 transaction. Delete storage first and abort
    // on failure; successful partial deletes are harmless when the request retries.
    for (let index = 0; index < keys.length; index += R2_DELETE_CHUNK_SIZE) {
      await this.ctx.bucket.delete(keys.slice(index, index + R2_DELETE_CHUNK_SIZE));
    }

    const statements: D1PreparedStatement[] = [];
    const stackIds = [...new Set(assets.map(({ stackId }) => stackId).filter((id): id is string => !!id))];
    for (let index = 0; index < stackIds.length; index += DELETE_ID_CHUNK_SIZE) {
      const chunk = stackIds.slice(index, index + DELETE_ID_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      const { results } = await this.ctx.env.DB.prepare(`
        SELECT stack.id AS stackId, stack.primaryAssetId, asset.id, asset.fileCreatedAt
        FROM stack
        LEFT JOIN asset ON asset.stackId = stack.id AND asset.status = ? AND asset.deletedAt IS NULL
        WHERE stack.id IN (${placeholders})
        ORDER BY asset.fileCreatedAt ASC, asset.id ASC
      `).bind(AssetStatus.Active, ...chunk).all<{
        stackId: string;
        primaryAssetId: string;
        id: string | null;
        fileCreatedAt: string | null;
      }>();
      for (const stackId of chunk) {
        const stack = results.find((row) => row.stackId === stackId);
        if (!stack || !deletingIds.has(stack.primaryAssetId)) {
          continue;
        }
        const replacement = results.find((asset) =>
          asset.stackId === stackId && asset.id && !deletingIds.has(asset.id),
        );
        statements.push(replacement
          ? this.ctx.env.DB.prepare('UPDATE stack SET primaryAssetId = ? WHERE id = ?').bind(replacement.id!, stackId)
          : this.ctx.env.DB.prepare('DELETE FROM stack WHERE id = ?').bind(stackId));
      }
    }

    const relationTables = [
      'activity',
      'asset_file',
      'asset_exif',
      'asset_metadata',
      'asset_edit',
      'tag_asset',
      'album_asset',
      'shared_link_asset',
      'memory_asset',
    ];
    for (let index = 0; index < assetIds.length; index += DELETE_ID_CHUNK_SIZE) {
      const chunk = assetIds.slice(index, index + DELETE_ID_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      statements.push(this.ctx.env.DB.prepare(`
        UPDATE user
        SET quotaUsageInBytes = MAX(0, quotaUsageInBytes - COALESCE((
          SELECT SUM(asset_exif.fileSizeInByte)
          FROM asset_exif
          INNER JOIN asset ON asset.id = asset_exif.assetId
          WHERE asset.ownerId = ? AND asset.id IN (${placeholders})
        ), 0))
        WHERE id = ?
      `).bind(userId, ...chunk, userId));
      for (const table of relationTables) {
        statements.push(this.ctx.env.DB.prepare(`DELETE FROM ${table} WHERE assetId IN (${placeholders})`).bind(...chunk));
      }
    }
    for (let index = 0; index < assetIds.length; index += DELETE_ID_CHUNK_SIZE) {
      const chunk = assetIds.slice(index, index + DELETE_ID_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      statements.push(this.ctx.env.DB.prepare(`
        DELETE FROM asset WHERE ownerId = ? AND id IN (${placeholders})
      `).bind(userId, ...chunk));
    }

    await this.ctx.env.DB.batch(statements);

    for (const { id } of assets) {
      await this.ctx.realtime.sendUser(userId, 'on_asset_delete', id);
    }
  }

  async restoreAll(auth: AuthDto): Promise<TrashResponseDto> {
    const userId = auth.user.id;
    const { results: assets } = await this.ctx.env.DB.prepare(
      'SELECT id FROM asset WHERE ownerId = ? AND status = ?',
    ).bind(userId, AssetStatus.Trashed).all<{ id: string }>();

    if (assets.length === 0) {
      return { count: 0 };
    }

    await this.ctx.env.DB.batch([
      this.ctx.env.DB.prepare(`
        UPDATE asset SET deletedAt = NULL, status = ?
        WHERE ownerId = ? AND status = ?
      `).bind(AssetStatus.Active, userId, AssetStatus.Trashed),
    ]);

    const assetIds = assets.map(({ id }) => id);
    await this.ctx.realtime.sendUser(userId, 'on_asset_restore', assetIds);
    return { count: assetIds.length };
  }

  async restore(auth: AuthDto, dto: { ids: string[] }): Promise<TrashResponseDto> {
    if (dto.ids.length === 0) {
      return { count: 0 };
    }

    const userId = auth.user.id;
    const validIds: string[] = [];
    const uniqueIds = [...new Set(dto.ids)];
    for (let index = 0; index < uniqueIds.length; index += RESTORE_ID_CHUNK_SIZE) {
      const chunk = uniqueIds.slice(index, index + RESTORE_ID_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      const { results } = await this.ctx.env.DB.prepare(`
        SELECT id FROM asset
        WHERE ownerId = ? AND status = ? AND id IN (${placeholders})
      `).bind(userId, AssetStatus.Trashed, ...chunk).all<{ id: string }>();
      validIds.push(...results.map(({ id }) => id));
    }

    if (validIds.length === 0) {
      return { count: 0 };
    }

    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < validIds.length; index += RESTORE_ID_CHUNK_SIZE) {
      const chunk = validIds.slice(index, index + RESTORE_ID_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      statements.push(this.ctx.env.DB.prepare(`
        UPDATE asset SET deletedAt = NULL, status = ?
        WHERE ownerId = ? AND status = ? AND id IN (${placeholders})
      `).bind(AssetStatus.Active, userId, AssetStatus.Trashed, ...chunk));
    }
    await this.ctx.env.DB.batch(statements);

    await this.ctx.realtime.sendUser(userId, 'on_asset_restore', validIds);
    return { count: validIds.length };
  }
}
