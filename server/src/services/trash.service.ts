import type { ServiceContext } from 'src/context';
import type { AuthDto } from 'src/dtos/auth.dto';
import type { TrashResponseDto } from 'src/dtos/trash.dto';
import { AssetStatus } from 'src/enum';

const D1_MAX_BINDS = 100;
const RESTORE_ID_CHUNK_SIZE = D1_MAX_BINDS - 3;
const R2_DELETE_CHUNK_SIZE = 1000;

type TrashedAsset = {
  id: string;
  originalPath: string;
  fileSizeInByte: number | null;
};

export class TrashService {
  constructor(private ctx: ServiceContext) {}

  async empty(auth: AuthDto): Promise<TrashResponseDto> {
    const userId = auth.user.id;
    const { results: trashedAssets } = await this.ctx.env.DB.prepare(`
      SELECT asset.id, asset.originalPath, asset_exif.fileSizeInByte
      FROM asset
      LEFT JOIN asset_exif ON asset_exif.assetId = asset.id
      WHERE asset.ownerId = ? AND asset.status = ?
    `).bind(userId, AssetStatus.Trashed).all<TrashedAsset>();

    if (trashedAssets.length === 0) {
      return { count: 0 };
    }

    const { results: assetFiles } = await this.ctx.env.DB.prepare(`
      SELECT asset_file.path
      FROM asset_file
      INNER JOIN asset ON asset.id = asset_file.assetId
      WHERE asset.ownerId = ? AND asset.status = ?
    `).bind(userId, AssetStatus.Trashed).all<{ path: string }>();

    const objectKeys = [...new Set([
      ...trashedAssets.map(({ originalPath }) => originalPath),
      ...assetFiles.map(({ path }) => path),
    ].filter(Boolean))];

    // R2 cannot participate in a D1 transaction. Delete storage first and abort
    // on failure; successful partial deletes are harmless when the request retries.
    for (let index = 0; index < objectKeys.length; index += R2_DELETE_CHUNK_SIZE) {
      await this.ctx.bucket.delete(objectKeys.slice(index, index + R2_DELETE_CHUNK_SIZE));
    }

    const trashedAssetSubquery = 'SELECT id FROM asset WHERE ownerId = ? AND status = ?';
    const forTrashedAssets = (sql: string) => this.ctx.env.DB.prepare(sql).bind(userId, AssetStatus.Trashed);
    const statements: D1PreparedStatement[] = [
      forTrashedAssets(`
        UPDATE stack
        SET primaryAssetId = (
          SELECT replacement.id
          FROM asset replacement
          WHERE replacement.stackId = stack.id
            AND replacement.status = '${AssetStatus.Active}'
            AND replacement.deletedAt IS NULL
          ORDER BY replacement.fileCreatedAt ASC, replacement.id ASC
          LIMIT 1
        )
        WHERE primaryAssetId IN (${trashedAssetSubquery})
          AND EXISTS (
            SELECT 1 FROM asset replacement
            WHERE replacement.stackId = stack.id
              AND replacement.status = '${AssetStatus.Active}'
              AND replacement.deletedAt IS NULL
          )
      `),
      forTrashedAssets(`DELETE FROM stack WHERE primaryAssetId IN (${trashedAssetSubquery})`),
      forTrashedAssets(`DELETE FROM activity WHERE assetId IN (${trashedAssetSubquery})`),
      forTrashedAssets(`DELETE FROM asset_file WHERE assetId IN (${trashedAssetSubquery})`),
      forTrashedAssets(`DELETE FROM asset_exif WHERE assetId IN (${trashedAssetSubquery})`),
      forTrashedAssets(`DELETE FROM asset_metadata WHERE assetId IN (${trashedAssetSubquery})`),
      forTrashedAssets(`DELETE FROM asset_edit WHERE assetId IN (${trashedAssetSubquery})`),
      forTrashedAssets(`DELETE FROM tag_asset WHERE assetId IN (${trashedAssetSubquery})`),
      forTrashedAssets(`DELETE FROM album_asset WHERE assetId IN (${trashedAssetSubquery})`),
      forTrashedAssets(`DELETE FROM shared_link_asset WHERE assetId IN (${trashedAssetSubquery})`),
      forTrashedAssets(`DELETE FROM memory_asset WHERE assetId IN (${trashedAssetSubquery})`),
      this.ctx.env.DB.prepare(`
        UPDATE user
        SET quotaUsageInBytes = MAX(0, quotaUsageInBytes - ?)
        WHERE id = ?
      `).bind(
        trashedAssets.reduce((total, asset) => total + Number(asset.fileSizeInByte ?? 0), 0),
        userId,
      ),
      forTrashedAssets(`DELETE FROM asset WHERE id IN (${trashedAssetSubquery})`),
    ];

    await this.ctx.env.DB.batch(statements);

    for (const { id } of trashedAssets) {
      await this.ctx.realtime.sendUser(userId, 'on_asset_delete', id);
    }

    return { count: trashedAssets.length };
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
