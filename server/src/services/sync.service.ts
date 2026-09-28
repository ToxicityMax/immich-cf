/**
 * Sync service -- Workers-compatible version.
 *
 * Provides the sync protocol for mobile app synchronization.
 * Converts Node.js Writable streams to Web ReadableStream with TransformStream.
 * PeopleV1 and AssetFacesV1 are stubbed with empty responses.
 * No NestJS, no BaseService, no background jobs.
 */

import type { AuthDto } from 'src/dtos/auth.dto';
import {
  SyncAckDeleteDto,
  SyncAckSetDto,
  SyncStreamDto,
} from 'src/dtos/sync.dto';
import {
  AlbumUserRole,
  SyncEntityType,
  SyncRequestType,
} from 'src/enum';
import type { ServiceContext } from 'src/context';
import { sql } from 'kysely';
import { fromAck, mapSyncAssetExifV1, mapSyncAssetV2, serialize, toAck } from 'src/utils/sync';
import { ForbiddenException, BadRequestException } from 'src/utils/errors';
import { generateUUIDv7 } from 'src/utils/uuid';

type SyncAck = {
  type: SyncEntityType;
  updateId: string;
  extraId?: string;
};
type CheckpointMap = Partial<Record<SyncEntityType, SyncAck>>;

type SyncWriter = {
  write: (data: string) => Promise<void>;
  close: () => Promise<void>;
  abort: (err: any) => Promise<void>;
};

const MAX_DAYS = 30;
const PAGE_SIZE = 1000;
const COMPLETE_ID = 'complete';

const isEntityBackfillComplete = (createId: string, checkpoint: SyncAck | undefined) =>
  createId === checkpoint?.updateId && checkpoint.extraId === COMPLETE_ID;

const getBackfillStartId = (createId: string, checkpoint: SyncAck | undefined) =>
  createId === checkpoint?.updateId && checkpoint.extraId !== COMPLETE_ID ? checkpoint.extraId : undefined;

export const SYNC_TYPES_ORDER = [
  SyncRequestType.AuthUsersV1,
  SyncRequestType.UsersV1,
  SyncRequestType.PartnersV1,
  SyncRequestType.AssetsV1,
  SyncRequestType.AssetsV2,
  SyncRequestType.StacksV1,
  SyncRequestType.PartnerAssetsV1,
  SyncRequestType.PartnerAssetsV2,
  SyncRequestType.PartnerStacksV1,
  SyncRequestType.AlbumAssetsV1,
  SyncRequestType.AlbumAssetsV2,
  SyncRequestType.AlbumsV1,
  SyncRequestType.AlbumsV2,
  SyncRequestType.AlbumUsersV1,
  SyncRequestType.AlbumToAssetsV1,
  SyncRequestType.AssetExifsV1,
  SyncRequestType.AlbumAssetExifsV1,
  SyncRequestType.AssetOcrV1,
  SyncRequestType.PartnerAssetExifsV1,
  SyncRequestType.MemoriesV1,
  SyncRequestType.MemoryToAssetsV1,
  SyncRequestType.PeopleV1,
  SyncRequestType.AssetFacesV1,
  SyncRequestType.AssetFacesV2,
  SyncRequestType.UserMetadataV1,
  SyncRequestType.AssetMetadataV1,
  SyncRequestType.AssetEditsV1,
];

/**
 * Create a JSON Lines streaming helper using Web Streams API.
 */
function createJsonLinesStream(): SyncWriter & { readable: ReadableStream<Uint8Array> } {
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();

  return {
    readable,
    write: (data: string) => writer.write(encoder.encode(data)),
    close: () => writer.close(),
    abort: (err: any) => writer.abort(err),
  };
}

export class SyncService {
  private get db() {
    return this.ctx.db;
  }

  constructor(private ctx: ServiceContext) {}

  async getAcks(auth: AuthDto) {
    const sessionId = auth.session?.id;
    if (!sessionId) {
      throw new ForbiddenException('Sync endpoints cannot be used with API keys');
    }

    return this.db
      .selectFrom('session_sync_checkpoint')
      .select(['type', 'ack'])
      .where('sessionId', '=', sessionId)
      .execute();
  }

  async setAcks(auth: AuthDto, dto: SyncAckSetDto) {
    const sessionId = auth.session?.id;
    if (!sessionId) {
      throw new ForbiddenException('Sync endpoints cannot be used with API keys');
    }

    console.log(`[sync] setAcks: sessionId=${sessionId}, acks=${JSON.stringify(dto.acks)}`);

    const checkpoints: Record<string, { sessionId: string; type: string; ack: string }> = {};
    let hasReset = false;
    for (const ack of dto.acks) {
      const parsed = fromAck(ack);
      const { type, updateId } = parsed;
      if (!updateId || ack.split('|').length > 3) {
        throw new BadRequestException(`Invalid ack: ${ack}`);
      }

      if (type === SyncEntityType.SyncResetV1) {
        hasReset = true;
        continue;
      }

      if (!Object.values(SyncEntityType).includes(type as SyncEntityType)) {
        throw new BadRequestException(`Invalid ack type: ${type}`);
      }

      checkpoints[type] = { sessionId, type, ack };
    }

    if (hasReset) {
      if (dto.acks.length !== 1) {
        throw new BadRequestException('SyncResetV1 cannot be acknowledged with other checkpoints');
      }
      console.log(`[sync] setAcks: processing SyncResetV1 ack, clearing isPendingSyncReset for session=${sessionId}`);
      await this.resetSyncProgress(sessionId);
      return;
    }

    const now = new Date().toISOString();
    const statements = Object.values(checkpoints).map((cp) => this.ctx.env.DB.prepare(`
      INSERT INTO session_sync_checkpoint (sessionId, type, ack, updateId)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (sessionId, type) DO UPDATE SET
        ack = excluded.ack,
        updatedAt = ?,
        updateId = ?
    `).bind(cp.sessionId, cp.type, cp.ack, generateUUIDv7(), now, generateUUIDv7()));
    if (statements.length > 0) {
      await this.ctx.env.DB.batch(statements);
    }

    console.log(`[sync] setAcks: stored ${Object.keys(checkpoints).length} checkpoints`);
  }

  async deleteAcks(auth: AuthDto, dto: SyncAckDeleteDto) {
    const sessionId = auth.session?.id;
    if (!sessionId) {
      throw new ForbiddenException('Sync endpoints cannot be used with API keys');
    }

    console.log(`[sync] deleteAcks: sessionId=${sessionId}, types=${JSON.stringify(dto.types)}`);

    if (dto.types && dto.types.length > 0) {
      await this.db
        .deleteFrom('session_sync_checkpoint')
        .where('sessionId', '=', sessionId)
        .where('type', 'in', dto.types)
        .execute();
    } else {
      await this.db
        .deleteFrom('session_sync_checkpoint')
        .where('sessionId', '=', sessionId)
        .execute();
    }
  }

  /**
   * Stream sync data as JSON Lines (application/x-ndjson).
   * Returns a Response with streaming body.
   */
  async stream(auth: AuthDto, dto: SyncStreamDto): Promise<Response> {
    const session = auth.session;
    if (!session) {
      throw new ForbiddenException('Sync endpoints cannot be used with API keys');
    }

    const deprecated = dto.types.find((type) =>
      [SyncRequestType.AssetsV1, SyncRequestType.PartnerAssetsV1, SyncRequestType.AlbumAssetsV1, SyncRequestType.AssetFacesV1].includes(type),
    );
    if (deprecated) {
      throw new BadRequestException(`Sync request type ${deprecated} is no longer supported`);
    }

    const startTime = Date.now();
    console.log(`[sync] stream: sessionId=${session.id}, userId=${auth.user.id}, types=[${dto.types.join(',')}], reset=${dto.reset ?? false}`);

    const stream = createJsonLinesStream();

    // Process sync in the background (stream.readable is consumed by the Response)
    const processSync = async () => {
      try {
        if (dto.reset) {
          console.log(`[sync] stream: reset requested, clearing reset state and checkpoints`);
          await this.resetSyncProgress(session.id);
        }

        // Check if pending sync reset
        const sessionRow = await this.db
          .selectFrom('session')
          .select('session.isPendingSyncReset')
          .where('session.id', '=', session.id)
          .executeTakeFirst();

        console.log(`[sync] stream: isPendingSyncReset=${sessionRow?.isPendingSyncReset}`);

        if (sessionRow?.isPendingSyncReset) {
          console.log(`[sync] stream: sending SyncResetV1 (client must ack to clear reset flag)`);
          await stream.write(serialize({ type: SyncEntityType.SyncResetV1, ids: ['reset'], data: {} }));
          await stream.close();
          return;
        }

        // Load checkpoints
        const checkpoints = await this.db
          .selectFrom('session_sync_checkpoint')
          .selectAll()
          .where('sessionId', '=', session.id)
          .execute();

        const checkpointMap: CheckpointMap = {};
        for (const cp of checkpoints) {
          checkpointMap[cp.type as SyncEntityType] = fromAck(cp.ack);
        }

        console.log(`[sync] stream: loaded ${checkpoints.length} checkpoints: [${checkpoints.map(cp => cp.type).join(', ')}]`);

        // Check if full sync is needed (complete ack is too old)
        if (this.needsFullSync(checkpointMap)) {
          console.log(`[sync] stream: checkpoints too old (>${MAX_DAYS} days), sending SyncResetV1`);
          await stream.write(serialize({ type: SyncEntityType.SyncResetV1, ids: ['reset'], data: {} }));
          await stream.close();
          return;
        }

        const nowId = generateUUIDv7(Date.now() - 1);
        let totalItemsStreamed = 0;

        // Process requested sync types in order
        for (const type of SYNC_TYPES_ORDER.filter((t) => dto.types.includes(t))) {
          const count = await this.handleSyncType(type, auth, checkpointMap, nowId, stream);
          totalItemsStreamed += count;
        }

        // Send completion
        await stream.write(serialize({ type: SyncEntityType.SyncCompleteV1, ids: [nowId], data: {} }));
        await stream.close();

        const elapsed = Date.now() - startTime;
        console.log(`[sync] stream: completed in ${elapsed}ms, streamed ${totalItemsStreamed} items, nowId=${nowId}`);
      } catch (err) {
        console.error('[sync] stream: error during sync processing:', err);
        stream.abort(err);
      }
    };

    processSync();

    return new Response(stream.readable, {
      headers: { 'Content-Type': 'application/jsonlines+json' },
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async resetSyncProgress(sessionId: string): Promise<void> {
    await this.ctx.env.DB.batch([
      this.ctx.env.DB.prepare('UPDATE session SET isPendingSyncReset = 0 WHERE id = ?').bind(sessionId),
      this.ctx.env.DB.prepare('DELETE FROM session_sync_checkpoint WHERE sessionId = ?').bind(sessionId),
    ]);
  }

  private async streamPages(
    fetchPage: (afterId?: string) => Promise<any[]>,
    getId: (row: any) => string,
    writeRow: (row: any) => Promise<void>,
  ): Promise<number> {
    let afterId: string | undefined;
    let count = 0;

    while (true) {
      const rows = await fetchPage(afterId);
      for (const row of rows) {
        await writeRow(row);
      }
      count += rows.length;

      if (rows.length < PAGE_SIZE) {
        return count;
      }

      const nextId = getId(rows.at(-1));
      if (!nextId || nextId === afterId) {
        throw new Error('Sync keyset pagination did not advance');
      }
      afterId = nextId;
    }
  }

  private async setBackfillComplete(sessionId: string, type: SyncEntityType, createId: string): Promise<void> {
    const ack = toAck({ type, updateId: createId, extraId: COMPLETE_ID });
    await this.db
      .insertInto('session_sync_checkpoint')
      .values({ sessionId, type, ack, updateId: generateUUIDv7() })
      .onConflict((oc) => oc.columns(['sessionId', 'type']).doUpdateSet({
        ack,
        updatedAt: new Date().toISOString(),
        updateId: generateUUIDv7(),
      }))
      .execute();
  }

  private async sendBackfillComplete(stream: SyncWriter, type: SyncEntityType, createId: string): Promise<void> {
    await stream.write(serialize({
      type: SyncEntityType.SyncAckV1,
      ackType: type,
      ids: [createId, COMPLETE_ID],
      data: {},
    }));
  }

  private mapSharedAsset(row: any, userId: string) {
    return mapSyncAssetV2({ ...row, isFavorite: row.ownerId === userId ? row.isFavorite : false });
  }

  private mapStack(row: any) {
    return {
      id: row.id,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      primaryAssetId: row.primaryAssetId,
      ownerId: row.ownerId,
    };
  }

  private getPartnerBackfillRelations(userId: string, nowId: string, checkpoint?: SyncAck) {
    return this.db.selectFrom('partner').select(['sharedById as id', 'createId'])
      .where('sharedWithId', '=', userId)
      .where('createId', '<', nowId)
      .$if(!!checkpoint, (query) => query.where('createId', '>=', checkpoint!.updateId))
      .orderBy('createId', 'asc')
      .execute();
  }

  private getAlbumBackfillRelations(userId: string, nowId: string, checkpoint?: SyncAck) {
    return this.db.selectFrom('album_user').select(['albumId as id', 'createId'])
      .where('userId', '=', userId)
      .where('createId', '<', nowId)
      .$if(!!checkpoint, (query) => query.where('createId', '>=', checkpoint!.updateId))
      .orderBy('createId', 'asc')
      .execute();
  }

  private async syncEntityBackfills(options: {
    stream: SyncWriter;
    checkpointMap: CheckpointMap;
    backfillType: SyncEntityType;
    upsertType: SyncEntityType;
    sessionId: string;
    relations: { id: string; createId: string }[];
    fetchPage: (relationId: string, cursor: string | undefined, endId: string) => Promise<any[]>;
    mapRow: (row: any) => any;
  }): Promise<number> {
    const { stream, checkpointMap, backfillType, upsertType, sessionId, relations, fetchPage, mapRow } = options;
    const backfillCheckpoint = checkpointMap[backfillType];
    const upsertCheckpoint = checkpointMap[upsertType];
    let count = 0;

    if (upsertCheckpoint) {
      for (const relation of relations) {
        if (isEntityBackfillComplete(relation.createId, backfillCheckpoint)) continue;
        const startId = getBackfillStartId(relation.createId, backfillCheckpoint);
        count += await this.streamPages(
          (afterId) => fetchPage(relation.id, afterId ?? startId, upsertCheckpoint.updateId),
          (row) => row.updateId,
          async (row) => stream.write(serialize({
            type: backfillType as any,
            ids: [relation.createId, row.updateId],
            data: mapRow(row),
          } as any)),
        );
        await this.sendBackfillComplete(stream, backfillType, relation.createId);
      }
    } else if (relations.length > 0) {
      await this.setBackfillComplete(sessionId, backfillType, relations.at(-1)!.createId);
    }

    return count;
  }

  private needsFullSync(checkpointMap: CheckpointMap): boolean {
    const completeAck = checkpointMap[SyncEntityType.SyncCompleteV1];
    if (!completeAck) {
      return false;
    }

    // Extract the millisecond timestamp from the first 48 bits of the UUIDv7.
    const hexStr = completeAck.updateId.replaceAll('-', '').slice(0, 12);
    const milliseconds = Number.parseInt(hexStr, 16);
    const ackDate = new Date(milliseconds);
    const maxAge = MAX_DAYS * 24 * 60 * 60 * 1000;

    const tooOld = (Date.now() - ackDate.getTime()) > maxAge;
    if (tooOld) {
      console.log(`[sync] needsFullSync: complete ack from ${ackDate.toISOString()} is older than ${MAX_DAYS} days`);
    }
    return tooOld;
  }

  /**
   * Handle a single sync type. Returns the number of items streamed.
   */
  private async handleSyncType(
    type: SyncRequestType,
    auth: AuthDto,
    checkpointMap: CheckpointMap,
    nowId: string,
    stream: SyncWriter,
  ): Promise<number> {
    const userId = auth.user.id;
    const includeLocked = !!auth.session?.hasElevatedPermission;
    let count = 0;

    switch (type) {
      case SyncRequestType.AuthUsersV1:
        count = await this.syncSimpleUpsert(stream, 'user', SyncEntityType.AuthUserV1, checkpointMap, nowId, {
          ownerFilter: userId,
          ownerColumn: 'id',
          mapRow: (row: any) => ({
            id: row.id,
            name: row.name,
            email: row.email,
            avatarColor: row.avatarColor ?? 'primary',
            deletedAt: row.deletedAt,
            hasProfileImage: !!row.profileImagePath,
            profileChangedAt: row.profileChangedAt,
            isAdmin: Boolean(row.isAdmin),
            pinCode: row.pinCode ? 'configured' : null,
            oauthId: row.oauthId ?? '',
            storageLabel: row.storageLabel,
            quotaSizeInBytes: row.quotaSizeInBytes,
            quotaUsageInBytes: row.quotaUsageInBytes ?? 0,
          }),
        });
        break;

      case SyncRequestType.UsersV1:
        // Deletes
        count += await this.syncAuditDeletes(stream, 'user_audit', SyncEntityType.UserDeleteV1, checkpointMap, nowId, {
          mapRow: (row: any) => ({ userId: row.userId }),
        });
        // Upserts
        count += await this.syncSimpleUpsert(stream, 'user', SyncEntityType.UserV1, checkpointMap, nowId, {
          mapRow: (row: any) => ({
            id: row.id,
            name: row.name,
            email: row.email,
            avatarColor: row.avatarColor ?? 'primary',
            deletedAt: row.deletedAt,
            hasProfileImage: !!row.profileImagePath,
            profileChangedAt: row.profileChangedAt,
          }),
        });
        break;

      case SyncRequestType.PartnersV1:
        count += await this.syncAuditDeletes(stream, 'partner_audit', SyncEntityType.PartnerDeleteV1, checkpointMap, nowId, {
          filterQuery: (query) => query.where((eb: any) => eb.or([
            eb('sharedById', '=', userId),
            eb('sharedWithId', '=', userId),
          ])),
          mapRow: (row: any) => ({ sharedById: row.sharedById, sharedWithId: row.sharedWithId }),
        });
        count += await this.syncSimpleUpsert(stream, 'partner', SyncEntityType.PartnerV1, checkpointMap, nowId, {
          filterQuery: (query) => query.where((eb: any) => eb.or([
            eb('sharedById', '=', userId),
            eb('sharedWithId', '=', userId),
          ])),
          mapRow: (row: any) => ({
            sharedById: row.sharedById,
            sharedWithId: row.sharedWithId,
            inTimeline: Boolean(row.inTimeline),
          }),
        });
        break;

      case SyncRequestType.AssetsV2:
        count += await this.syncAuditDeletes(stream, 'asset_audit', SyncEntityType.AssetDeleteV1, checkpointMap, nowId, {
          filterQuery: (query) => query.where((eb: any) => eb.or([
            eb.and([
              eb('ownerId', '=', userId),
              includeLocked
                ? eb('reason', '!=', 'lock')
                : eb.or([
                  ...(checkpointMap[SyncEntityType.AssetV2] ? [eb('reason', '=', 'lock')] : []),
                  eb.and([
                    eb('reason', '!=', 'lock'),
                    eb.or([eb('visibility', '!=', 'locked'), eb('visibility', 'is', null)]),
                  ]),
                ]),
            ]),
            eb.and([
              eb('ownerId', '!=', userId),
              eb('reason', '=', 'lock'),
              eb.exists(
                this.db.selectFrom('album_asset_audit as known_album_asset')
                  .innerJoin('album_user as known_album_user', (join) => join
                    .onRef('known_album_user.albumId', '=', 'known_album_asset.albumId')
                    .on('known_album_user.userId', '=', userId),
                  )
                  .select('known_album_asset.assetId')
                  .whereRef('known_album_asset.assetId', '=', 'asset_audit.assetId')
                  .where('known_album_asset.visibility', '=', 'locked')
                  .where('known_album_asset.relationUpdateId', 'is not', null)
                  .where((scope) => this.wasAlbumRelationSynced(
                    scope,
                    'known_album_asset.relationUpdateId',
                    'known_album_user.createId',
                    checkpointMap[SyncEntityType.AlbumAssetCreateV2],
                    checkpointMap[SyncEntityType.AlbumAssetBackfillV2],
                  )),
              ),
            ]),
          ])),
          mapRow: (row: any) => ({ assetId: row.assetId }),
        });
        count += await this.syncSimpleUpsert(stream, 'asset', SyncEntityType.AssetV2, checkpointMap, nowId, {
          ownerFilter: userId,
          filterQuery: (query) => includeLocked ? query : query.where('visibility', '!=', 'locked'),
          mapRow: (row: any) => mapSyncAssetV2(row),
        });
        break;

      case SyncRequestType.AssetExifsV1:
        count = await this.syncExifUpserts(stream, SyncEntityType.AssetExifV1, checkpointMap, nowId, userId, includeLocked);
        break;

      case SyncRequestType.StacksV1:
        count += await this.syncAuditDeletes(stream, 'stack_audit', SyncEntityType.StackDeleteV1, checkpointMap, nowId, {
          ownerFilter: userId,
          ownerColumn: 'userId',
          filterQuery: (query) => includeLocked ? query : query.where((eb: any) => eb.or([
            eb('visibility', '!=', 'locked'),
            eb('visibility', 'is', null),
          ])),
          mapRow: (row: any) => ({ stackId: row.stackId }),
        });
        count += await this.syncStackUpserts(stream, checkpointMap, nowId, userId, includeLocked);
        break;

      case SyncRequestType.AlbumsV1:
        count += await this.syncAuditDeletes(stream, 'album_audit', SyncEntityType.AlbumDeleteV1, checkpointMap, nowId, {
          ownerFilter: userId,
          ownerColumn: 'userId',
          mapRow: (row: any) => ({ albumId: row.albumId }),
        });
        count += await this.syncAlbumUpserts(stream, SyncEntityType.AlbumV1, checkpointMap, nowId, userId);
        break;

      case SyncRequestType.AlbumsV2:
        count += await this.syncAuditDeletes(stream, 'album_audit', SyncEntityType.AlbumDeleteV1, checkpointMap, nowId, {
          ownerFilter: userId,
          ownerColumn: 'userId',
          mapRow: (row: any) => ({ albumId: row.albumId }),
        });
        count += await this.syncAlbumUpserts(stream, SyncEntityType.AlbumV2, checkpointMap, nowId, userId);
        break;

      case SyncRequestType.AlbumUsersV1:
        count += await this.syncAuditDeletes(stream, 'album_user_audit', SyncEntityType.AlbumUserDeleteV1, checkpointMap, nowId, {
          filterQuery: (query) => query.where('albumId', 'in',
            this.db.selectFrom('album_user').select('albumId').where('userId', '=', userId),
          ),
          mapRow: (row: any) => ({ albumId: row.albumId, userId: row.userId }),
        });
        count += await this.syncAlbumUsers(stream, checkpointMap, nowId, userId, auth.session!.id);
        break;

      case SyncRequestType.AlbumToAssetsV1:
        count += await this.syncAuditDeletes(stream, 'album_asset_audit', SyncEntityType.AlbumToAssetDeleteV1, checkpointMap, nowId, {
          filterQuery: (query) => query.where('albumId', 'in',
            this.db.selectFrom('album_user').select('albumId').where('userId', '=', userId),
          ).where((eb: any) => eb.or([
            eb('visibility', '!=', 'locked'),
            eb('visibility', 'is', null),
            eb.exists(
              this.db.selectFrom('album_user as known_album_user')
                .select('known_album_user.albumId')
                .whereRef('known_album_user.albumId', '=', 'album_asset_audit.albumId')
                .where('known_album_user.userId', '=', userId)
                .where((scope) => this.wasAlbumRelationSynced(
                  scope,
                  'album_asset_audit.relationUpdateId',
                  'known_album_user.createId',
                  checkpointMap[SyncEntityType.AlbumToAssetV1],
                  checkpointMap[SyncEntityType.AlbumToAssetBackfillV1],
                )),
            ),
          ])),
          mapRow: (row: any) => ({ albumId: row.albumId, assetId: row.assetId }),
        });
        count += await this.syncAlbumToAssets(stream, checkpointMap, nowId, userId, auth.session!.id, includeLocked);
        break;

      case SyncRequestType.MemoriesV1:
        count += await this.syncAuditDeletes(stream, 'memory_audit', SyncEntityType.MemoryDeleteV1, checkpointMap, nowId, {
          ownerFilter: userId,
          ownerColumn: 'userId',
          mapRow: (row: any) => ({ memoryId: row.memoryId }),
        });
        count += await this.syncSimpleUpsert(stream, 'memory', SyncEntityType.MemoryV1, checkpointMap, nowId, {
          ownerFilter: userId,
          mapRow: (row: any) => ({
            id: row.id,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            deletedAt: row.deletedAt,
            ownerId: row.ownerId,
            type: row.type,
            data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
            isSaved: Boolean(row.isSaved),
            memoryAt: row.memoryAt,
            seenAt: row.seenAt,
            showAt: row.showAt,
            hideAt: row.hideAt,
          }),
        });
        break;

      case SyncRequestType.MemoryToAssetsV1:
        count += await this.syncAuditDeletes(stream, 'memory_asset_audit', SyncEntityType.MemoryToAssetDeleteV1, checkpointMap, nowId, {
          filterQuery: (query) => query.where('memoryId', 'in',
            this.db.selectFrom('memory').select('id').where('ownerId', '=', userId),
          ).$if(!includeLocked, (qb: any) => qb.where((eb: any) => eb.or([
            eb('visibility', '!=', 'locked'),
            eb('visibility', 'is', null),
          ]))),
          mapRow: (row: any) => ({ memoryId: row.memoryId, assetId: row.assetId }),
        });
        count += await this.syncMemoryAssetUpserts(stream, checkpointMap, nowId, userId, includeLocked);
        break;

      case SyncRequestType.UserMetadataV1:
        count += await this.syncAuditDeletes(stream, 'user_metadata_audit', SyncEntityType.UserMetadataDeleteV1, checkpointMap, nowId, {
          ownerFilter: userId,
          ownerColumn: 'userId',
          mapRow: (row: any) => ({ userId: row.userId, key: row.key }),
        });
        count += await this.syncUserMetadataUpserts(stream, checkpointMap, nowId, userId);
        break;

      case SyncRequestType.AssetMetadataV1:
        count = await this.syncAssetMetadata(stream, checkpointMap, nowId, auth);
        break;

      case SyncRequestType.AssetEditsV1:
        count = await this.syncAssetEdits(stream, checkpointMap, nowId, userId, includeLocked);
        break;

      // Stubbed sync types (features removed in Workers)
      case SyncRequestType.PeopleV1:
        // People feature removed -- return empty
        break;
      case SyncRequestType.AssetFacesV1:
        throw new BadRequestException('Sync request type AssetFacesV1 is no longer supported');
      case SyncRequestType.AssetFacesV2:
      case SyncRequestType.AssetOcrV1:
        break;

      case SyncRequestType.PartnerAssetsV1:
        throw new BadRequestException('Sync request type PartnerAssetsV1 is no longer supported');
      case SyncRequestType.PartnerAssetsV2:
        count = await this.syncPartnerAssets(stream, checkpointMap, nowId, userId, auth.session!.id);
        break;
      case SyncRequestType.PartnerAssetExifsV1:
        count = await this.syncPartnerAssetExifs(stream, checkpointMap, nowId, userId, auth.session!.id);
        break;
      case SyncRequestType.PartnerStacksV1:
        count = await this.syncPartnerStacks(stream, checkpointMap, nowId, userId, auth.session!.id);
        break;
      case SyncRequestType.AlbumAssetsV1:
        throw new BadRequestException('Sync request type AlbumAssetsV1 is no longer supported');
      case SyncRequestType.AlbumAssetsV2:
        count = await this.syncAlbumAssets(stream, checkpointMap, nowId, userId, auth.session!.id);
        break;
      case SyncRequestType.AlbumAssetExifsV1:
        count = await this.syncAlbumAssetExifs(stream, checkpointMap, nowId, userId, auth.session!.id);
        break;
    }

    if (count > 0) {
      console.log(`[sync] handleSyncType: ${type} streamed ${count} items`);
    }

    return count;
  }

  /**
   * Generic simple upsert sync from a table with updateId column.
   * Returns the number of items streamed.
   */
  private async syncSimpleUpsert(
    stream: SyncWriter,
    tableName: string,
    entityType: SyncEntityType,
    checkpointMap: CheckpointMap,
    nowId: string,
    options: {
      ownerFilter?: string;
      ownerColumn?: string;
      filterQuery?: (query: any) => any;
      mapRow: (row: any) => any;
    },
  ): Promise<number> {
    const checkpoint = checkpointMap[entityType];
    const ownerColumn = options.ownerColumn || 'ownerId';

    return this.streamPages(
      async (afterId) => {
        let query = this.db
          .selectFrom(tableName as any)
          .selectAll()
          .where('updateId' as any, '<', nowId)
          .orderBy('updateId', 'asc');

        if (checkpoint) {
          query = query.where('updateId' as any, '>', checkpoint.updateId);
        }
        if (afterId) {
          query = query.where('updateId' as any, '>', afterId);
        }
        if (options.ownerFilter) {
          query = query.where(ownerColumn as any, '=', options.ownerFilter);
        }
        if (options.filterQuery) {
          query = options.filterQuery(query);
        }

        return query.limit(PAGE_SIZE).execute();
      },
      (row) => row.updateId,
      async (row) => stream.write(serialize({
        type: entityType,
        ids: [row.updateId],
        data: options.mapRow(row),
      })),
    );
  }

  private wasAlbumRelationSynced(
    eb: any,
    relationUpdateId: string,
    albumCreateId: string,
    upsertCheckpoint: SyncAck | undefined,
    backfillCheckpoint: SyncAck | undefined,
  ) {
    if (!upsertCheckpoint) {
      return eb.val(false);
    }

    const relationId = eb.ref(relationUpdateId);
    const createId = eb.ref(albumCreateId);
    const normalSync = eb.and([
      eb(relationId, '<=', upsertCheckpoint.updateId),
      eb(createId, '<=', relationId),
    ]);
    if (!backfillCheckpoint) {
      return normalSync;
    }

    const currentBackfill = backfillCheckpoint.extraId === COMPLETE_ID
      ? eb.val(true)
      : backfillCheckpoint.extraId
        ? eb(relationId, '<=', backfillCheckpoint.extraId)
        : eb.val(false);
    const backfillSync = eb.and([
      eb(createId, '>', relationId),
      eb.or([
        eb(createId, '<', backfillCheckpoint.updateId),
        eb.and([eb(createId, '=', backfillCheckpoint.updateId), currentBackfill]),
      ]),
    ]);

    return eb.or([normalSync, backfillSync]);
  }

  /**
   * Generic audit table deletes sync.
   * Returns the number of items streamed.
   */
  private async syncAuditDeletes(
    stream: SyncWriter,
    auditTable: string,
    entityType: SyncEntityType,
    checkpointMap: CheckpointMap,
    nowId: string,
    options: {
      ownerFilter?: string;
      ownerColumn?: string;
      filterQuery?: (query: any) => any;
      mapRow: (row: any) => any;
    },
  ): Promise<number> {
    const checkpoint = checkpointMap[entityType];

    return this.streamPages(
      async (afterId) => {
        let query = this.db
          .selectFrom(auditTable as any)
          .selectAll()
          .where('id' as any, '<', nowId)
          .orderBy('id', 'asc');

        if (checkpoint) {
          query = query.where('id' as any, '>', checkpoint.updateId);
        }
        if (afterId) {
          query = query.where('id' as any, '>', afterId);
        }
        if (options.ownerFilter && options.ownerColumn) {
          query = query.where(options.ownerColumn as any, '=', options.ownerFilter);
        }
        if (options.filterQuery) {
          query = options.filterQuery(query);
        }

        return query.limit(PAGE_SIZE).execute();
      },
      (row) => row.id,
      async (row) => stream.write(serialize({
        type: entityType,
        ids: [row.id],
        data: options.mapRow(row),
      })),
    );
  }

  private async syncExifUpserts(
    stream: SyncWriter,
    entityType: SyncEntityType,
    checkpointMap: CheckpointMap,
    nowId: string,
    userId: string,
    includeLocked: boolean,
  ): Promise<number> {
    const checkpoint = checkpointMap[entityType];
    const syncId = sql<string>`max(asset_exif.updateId, asset.updateId)`;

    return this.streamPages(
      async (afterId) => {
        let query = this.db
          .selectFrom('asset_exif')
          .innerJoin('asset', 'asset.id', 'asset_exif.assetId')
          .selectAll('asset_exif')
          .select(syncId.as('syncId'))
          .where('asset.ownerId', '=', userId)
          .$if(!includeLocked, (qb) => qb.where('asset.visibility', '!=', 'locked'))
          .where(syncId, '<', nowId)
          .orderBy(syncId, 'asc');
        if (checkpoint) query = query.where(syncId, '>', checkpoint.updateId);
        if (afterId) query = query.where(syncId, '>', afterId);
        return query.limit(PAGE_SIZE).execute();
      },
      (row) => row.syncId,
      async (row) => stream.write(serialize({
        type: entityType,
        ids: [row.syncId],
        data: mapSyncAssetExifV1(row),
      })),
    );
  }

  private async syncStackUpserts(
    stream: SyncWriter,
    checkpointMap: CheckpointMap,
    nowId: string,
    userId: string,
    includeLocked: boolean,
  ): Promise<number> {
    const entityType = SyncEntityType.StackV1;
    const checkpoint = checkpointMap[entityType];
    const syncId = sql<string>`max(stack.updateId, asset.updateId)`;

    return this.streamPages(
      async (afterId) => {
        let query = this.db.selectFrom('stack')
          .innerJoin('asset', 'asset.id', 'stack.primaryAssetId')
          .selectAll('stack')
          .select(syncId.as('syncId'))
          .where('stack.ownerId', '=', userId)
          .$if(!includeLocked, (qb) => qb.where('asset.visibility', '!=', 'locked'))
          .where(syncId, '<', nowId)
          .orderBy(syncId, 'asc');
        if (checkpoint) query = query.where(syncId, '>', checkpoint.updateId);
        if (afterId) query = query.where(syncId, '>', afterId);
        return query.limit(PAGE_SIZE).execute();
      },
      (row) => row.syncId,
      async (row) => stream.write(serialize({
        type: entityType,
        ids: [row.syncId],
        data: this.mapStack(row),
      })),
    );
  }

  private async syncPartnerAssets(
    stream: SyncWriter,
    checkpointMap: CheckpointMap,
    nowId: string,
    userId: string,
    sessionId: string,
  ): Promise<number> {
    const deleteType = SyncEntityType.PartnerAssetDeleteV1;
    let count = await this.syncAuditDeletes(stream, 'asset_audit', deleteType, checkpointMap, nowId, {
      filterQuery: (query) => query.where('ownerId', 'in',
        this.db.selectFrom('partner').select('sharedById').where('sharedWithId', '=', userId),
      ).where((eb: any) => eb.or([
        ...(checkpointMap[SyncEntityType.PartnerAssetV2] ? [eb('reason', '=', 'lock')] : []),
        eb.and([
          eb('reason', '!=', 'lock'),
          eb.or([eb('visibility', '!=', 'locked'), eb('visibility', 'is', null)]),
        ]),
      ])),
      mapRow: (row: any) => ({ assetId: row.assetId }),
    });
    const upsertType = SyncEntityType.PartnerAssetV2;
    const backfillType = SyncEntityType.PartnerAssetBackfillV2;
    const relations = await this.getPartnerBackfillRelations(userId, nowId, checkpointMap[backfillType]);
    count += await this.syncEntityBackfills({
      stream, checkpointMap, backfillType, upsertType, sessionId, relations,
      fetchPage: async (partnerId, cursor, endId) => {
        let query = this.db.selectFrom('asset').selectAll()
          .where('ownerId', '=', partnerId)
          .where('visibility', '!=', 'locked')
          .where('updateId', '<', nowId)
          .where('updateId', '<=', endId)
          .orderBy('updateId', 'asc');
        if (cursor) query = query.where('updateId', '>', cursor);
        return query.limit(PAGE_SIZE).execute();
      },
      mapRow: (row) => this.mapSharedAsset(row, userId),
    });
    const checkpoint = checkpointMap[upsertType];
    count += await this.streamPages(
      async (afterId) => {
        let query = this.db.selectFrom('asset').selectAll()
          .where('ownerId', 'in', this.db.selectFrom('partner').select('sharedById').where('sharedWithId', '=', userId))
          .where('visibility', '!=', 'locked')
          .where('updateId', '<', nowId)
          .orderBy('updateId', 'asc');
        if (checkpoint) query = query.where('updateId', '>', checkpoint.updateId);
        if (afterId) query = query.where('updateId', '>', afterId);
        return query.limit(PAGE_SIZE).execute();
      },
      (row) => row.updateId,
      async (row) => stream.write(serialize({ type: upsertType, ids: [row.updateId], data: this.mapSharedAsset(row, userId) })),
    );
    return count;
  }

  private async syncPartnerAssetExifs(
    stream: SyncWriter,
    checkpointMap: CheckpointMap,
    nowId: string,
    userId: string,
    sessionId: string,
  ): Promise<number> {
    const upsertType = SyncEntityType.PartnerAssetExifV1;
    const backfillType = SyncEntityType.PartnerAssetExifBackfillV1;
    const relations = await this.getPartnerBackfillRelations(userId, nowId, checkpointMap[backfillType]);
    let count = await this.syncEntityBackfills({
      stream, checkpointMap, backfillType, upsertType, sessionId, relations,
      fetchPage: async (partnerId, cursor, endId) => {
        let query = this.db.selectFrom('asset_exif').innerJoin('asset', 'asset.id', 'asset_exif.assetId')
          .selectAll('asset_exif')
          .where('asset.ownerId', '=', partnerId)
          .where('asset.visibility', '!=', 'locked')
          .where('asset_exif.updateId', '<', nowId)
          .where('asset_exif.updateId', '<=', endId)
          .orderBy('asset_exif.updateId', 'asc');
        if (cursor) query = query.where('asset_exif.updateId', '>', cursor);
        return query.limit(PAGE_SIZE).execute();
      },
      mapRow: (row) => mapSyncAssetExifV1(row),
    });
    const checkpoint = checkpointMap[upsertType];
    count += await this.streamPages(
      async (afterId) => {
        let query = this.db.selectFrom('asset_exif').innerJoin('asset', 'asset.id', 'asset_exif.assetId')
          .selectAll('asset_exif')
          .where('asset.ownerId', 'in', this.db.selectFrom('partner').select('sharedById').where('sharedWithId', '=', userId))
          .where('asset.visibility', '!=', 'locked')
          .where('asset_exif.updateId', '<', nowId)
          .orderBy('asset_exif.updateId', 'asc');
        if (checkpoint) query = query.where('asset_exif.updateId', '>', checkpoint.updateId);
        if (afterId) query = query.where('asset_exif.updateId', '>', afterId);
        return query.limit(PAGE_SIZE).execute();
      },
      (row) => row.updateId,
      async (row) => stream.write(serialize({ type: upsertType, ids: [row.updateId], data: mapSyncAssetExifV1(row) })),
    );
    return count;
  }

  private async syncPartnerStacks(
    stream: SyncWriter,
    checkpointMap: CheckpointMap,
    nowId: string,
    userId: string,
    sessionId: string,
  ): Promise<number> {
    const deleteType = SyncEntityType.PartnerStackDeleteV1;
    let count = await this.syncAuditDeletes(stream, 'stack_audit', deleteType, checkpointMap, nowId, {
      filterQuery: (query) => query.where('userId', 'in',
        this.db.selectFrom('partner').select('sharedById').where('sharedWithId', '=', userId),
      ),
      mapRow: (row: any) => ({ stackId: row.stackId }),
    });
    const upsertType = SyncEntityType.PartnerStackV1;
    const backfillType = SyncEntityType.PartnerStackBackfillV1;
    const relations = await this.getPartnerBackfillRelations(userId, nowId, checkpointMap[backfillType]);
    count += await this.syncEntityBackfills({
      stream, checkpointMap, backfillType, upsertType, sessionId, relations,
      fetchPage: async (partnerId, cursor, endId) => {
        let query = this.db.selectFrom('stack').innerJoin('asset', 'asset.id', 'stack.primaryAssetId')
          .selectAll('stack')
          .where('stack.ownerId', '=', partnerId)
          .where('asset.visibility', '!=', 'locked')
          .where('stack.updateId', '<', nowId)
          .where('stack.updateId', '<=', endId)
          .orderBy('stack.updateId', 'asc');
        if (cursor) query = query.where('stack.updateId', '>', cursor);
        return query.limit(PAGE_SIZE).execute();
      },
      mapRow: (row) => this.mapStack(row),
    });
    const checkpoint = checkpointMap[upsertType];
    count += await this.streamPages(
      async (afterId) => {
        let query = this.db.selectFrom('stack').innerJoin('asset', 'asset.id', 'stack.primaryAssetId')
          .selectAll('stack')
          .where('stack.ownerId', 'in', this.db.selectFrom('partner').select('sharedById').where('sharedWithId', '=', userId))
          .where('asset.visibility', '!=', 'locked')
          .where('stack.updateId', '<', nowId)
          .orderBy('stack.updateId', 'asc');
        if (checkpoint) query = query.where('stack.updateId', '>', checkpoint.updateId);
        if (afterId) query = query.where('stack.updateId', '>', afterId);
        return query.limit(PAGE_SIZE).execute();
      },
      (row) => row.updateId,
      async (row) => stream.write(serialize({ type: upsertType, ids: [row.updateId], data: this.mapStack(row) })),
    );
    return count;
  }

  private async syncAlbumUpserts(
    stream: SyncWriter,
    entityType: SyncEntityType.AlbumV1 | SyncEntityType.AlbumV2,
    checkpointMap: CheckpointMap,
    nowId: string,
    userId: string,
  ): Promise<number> {
    const checkpoint = checkpointMap[entityType];

    return this.streamPages(
      async (afterId) => {
        let query = this.db
          .selectFrom('album')
          .innerJoin('album_user as current_user', (join) =>
            join.onRef('current_user.albumId', '=', 'album.id').on('current_user.userId', '=', userId),
          )
          .innerJoin('album_user as owner', (join) =>
            join.onRef('owner.albumId', '=', 'album.id').on('owner.role', '=', AlbumUserRole.Owner),
          )
          .selectAll('album')
          .select('owner.userId as ownerId')
          .where('album.updateId', '<', nowId)
          .orderBy('album.updateId', 'asc');
        if (checkpoint) query = query.where('album.updateId', '>', checkpoint.updateId);
        if (afterId) query = query.where('album.updateId', '>', afterId);
        return query.limit(PAGE_SIZE).execute();
      },
      (row) => row.updateId,
      async (row) => {
        const data = {
          id: row.id,
          name: row.albumName,
          description: row.description ?? '',
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          thumbnailAssetId: row.albumThumbnailAssetId,
          isActivityEnabled: Boolean(row.isActivityEnabled),
          order: row.order,
        };
        await stream.write(serialize({
          type: entityType,
          ids: [row.updateId],
          data: entityType === SyncEntityType.AlbumV1 ? { ...data, ownerId: row.ownerId } : data,
        } as any));
      },
    );
  }

  private async syncAlbumAssets(
    stream: SyncWriter,
    checkpointMap: CheckpointMap,
    nowId: string,
    userId: string,
    sessionId: string,
  ): Promise<number> {
    const createType = SyncEntityType.AlbumAssetCreateV2;
    const updateType = SyncEntityType.AlbumAssetUpdateV2;
    const backfillType = SyncEntityType.AlbumAssetBackfillV2;
    const createCheckpoint = checkpointMap[createType];
    const relations = await this.getAlbumBackfillRelations(userId, nowId, checkpointMap[backfillType]);
    let count = await this.syncEntityBackfills({
      stream,
      checkpointMap,
      backfillType,
      upsertType: createType,
      sessionId,
      relations,
      fetchPage: async (albumId, cursor, endId) => {
        let query = this.db.selectFrom('album_asset').innerJoin('asset', 'asset.id', 'album_asset.assetId')
          .selectAll('asset')
          .select('album_asset.updateId as updateId')
          .where('album_asset.albumId', '=', albumId)
          .where('asset.visibility', '!=', 'locked')
          .where('album_asset.updateId', '<', nowId)
          .where('album_asset.updateId', '<=', endId)
          .orderBy('album_asset.updateId', 'asc');
        if (cursor) query = query.where('album_asset.updateId', '>', cursor);
        return query.limit(PAGE_SIZE).execute();
      },
      mapRow: (row) => this.mapSharedAsset(row, userId),
    });

    if (createCheckpoint) {
      const updateCheckpoint = checkpointMap[updateType];
      count += await this.streamPages(
        async (afterId) => {
          let query = this.db.selectFrom('asset')
            .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
            .innerJoin('album_user', 'album_user.albumId', 'album_asset.albumId')
            .selectAll('asset')
            .where('album_user.userId', '=', userId)
            .where('album_asset.updateId', '<=', createCheckpoint.updateId)
            .where('asset.visibility', '!=', 'locked')
            .where('asset.updateId', '<', nowId)
            .orderBy('asset.updateId', 'asc');
          if (updateCheckpoint) query = query.where('asset.updateId', '>', updateCheckpoint.updateId);
          if (afterId) query = query.where('asset.updateId', '>', afterId);
          return query.limit(PAGE_SIZE).execute();
        },
        (row) => row.updateId,
        async (row) => stream.write(serialize({
          type: updateType,
          ids: [row.updateId],
          data: this.mapSharedAsset(row, userId),
        })),
      );
    }

    let sentUpdateCheckpoint = false;
    count += await this.streamPages(
      async (afterId) => {
        let query = this.db.selectFrom('album_asset').innerJoin('asset', 'asset.id', 'album_asset.assetId')
          .innerJoin('album_user', 'album_user.albumId', 'album_asset.albumId')
          .selectAll('asset')
          .select('album_asset.updateId as updateId')
          .where('album_user.userId', '=', userId)
          .where('asset.visibility', '!=', 'locked')
          .where('album_asset.updateId', '<', nowId)
          .orderBy('album_asset.updateId', 'asc');
        if (createCheckpoint) query = query.where('album_asset.updateId', '>', createCheckpoint.updateId);
        if (afterId) query = query.where('album_asset.updateId', '>', afterId);
        return query.limit(PAGE_SIZE).execute();
      },
      (row) => row.updateId,
      async (row) => {
        if (!sentUpdateCheckpoint) {
          await stream.write(serialize({ type: SyncEntityType.SyncAckV1, ackType: updateType, ids: [nowId], data: {} }));
          sentUpdateCheckpoint = true;
        }
        await stream.write(serialize({ type: createType, ids: [row.updateId], data: this.mapSharedAsset(row, userId) }));
      },
    );
    return count;
  }

  private async syncAlbumAssetExifs(
    stream: SyncWriter,
    checkpointMap: CheckpointMap,
    nowId: string,
    userId: string,
    sessionId: string,
  ): Promise<number> {
    const createType = SyncEntityType.AlbumAssetExifCreateV1;
    const updateType = SyncEntityType.AlbumAssetExifUpdateV1;
    const backfillType = SyncEntityType.AlbumAssetExifBackfillV1;
    const createCheckpoint = checkpointMap[createType];
    const relations = await this.getAlbumBackfillRelations(userId, nowId, checkpointMap[backfillType]);
    let count = await this.syncEntityBackfills({
      stream,
      checkpointMap,
      backfillType,
      upsertType: createType,
      sessionId,
      relations,
      fetchPage: async (albumId, cursor, endId) => {
        let query = this.db.selectFrom('album_asset')
          .innerJoin('asset', 'asset.id', 'album_asset.assetId')
          .innerJoin('asset_exif', 'asset_exif.assetId', 'album_asset.assetId')
          .selectAll('asset_exif')
          .select('album_asset.updateId as updateId')
          .where('album_asset.albumId', '=', albumId)
          .where('asset.visibility', '!=', 'locked')
          .where('album_asset.updateId', '<', nowId)
          .where('album_asset.updateId', '<=', endId)
          .orderBy('album_asset.updateId', 'asc');
        if (cursor) query = query.where('album_asset.updateId', '>', cursor);
        return query.limit(PAGE_SIZE).execute();
      },
      mapRow: (row) => mapSyncAssetExifV1(row),
    });

    if (createCheckpoint) {
      const updateCheckpoint = checkpointMap[updateType];
      count += await this.streamPages(
        async (afterId) => {
          let query = this.db.selectFrom('asset_exif')
            .innerJoin('asset', 'asset.id', 'asset_exif.assetId')
            .innerJoin('album_asset', 'album_asset.assetId', 'asset_exif.assetId')
            .innerJoin('album_user', 'album_user.albumId', 'album_asset.albumId')
            .selectAll('asset_exif')
            .where('album_user.userId', '=', userId)
            .where('album_asset.updateId', '<=', createCheckpoint.updateId)
            .where('asset.visibility', '!=', 'locked')
            .where('asset_exif.updateId', '<', nowId)
            .orderBy('asset_exif.updateId', 'asc');
          if (updateCheckpoint) query = query.where('asset_exif.updateId', '>', updateCheckpoint.updateId);
          if (afterId) query = query.where('asset_exif.updateId', '>', afterId);
          return query.limit(PAGE_SIZE).execute();
        },
        (row) => row.updateId,
        async (row) => stream.write(serialize({
          type: updateType,
          ids: [row.updateId],
          data: mapSyncAssetExifV1(row),
        })),
      );
    }

    let sentUpdateCheckpoint = false;
    count += await this.streamPages(
      async (afterId) => {
        let query = this.db.selectFrom('album_asset')
          .innerJoin('asset', 'asset.id', 'album_asset.assetId')
          .innerJoin('asset_exif', 'asset_exif.assetId', 'album_asset.assetId')
          .innerJoin('album_user', 'album_user.albumId', 'album_asset.albumId')
          .selectAll('asset_exif')
          .select('album_asset.updateId as updateId')
          .where('album_user.userId', '=', userId)
          .where('asset.visibility', '!=', 'locked')
          .where('album_asset.updateId', '<', nowId)
          .orderBy('album_asset.updateId', 'asc');
        if (createCheckpoint) query = query.where('album_asset.updateId', '>', createCheckpoint.updateId);
        if (afterId) query = query.where('album_asset.updateId', '>', afterId);
        return query.limit(PAGE_SIZE).execute();
      },
      (row) => row.updateId,
      async (row) => {
        if (!sentUpdateCheckpoint) {
          await stream.write(serialize({ type: SyncEntityType.SyncAckV1, ackType: updateType, ids: [nowId], data: {} }));
          sentUpdateCheckpoint = true;
        }
        await stream.write(serialize({ type: createType, ids: [row.updateId], data: mapSyncAssetExifV1(row) }));
      },
    );
    return count;
  }

  private async syncAlbumUsers(
    stream: SyncWriter,
    checkpointMap: CheckpointMap,
    nowId: string,
    userId: string,
    sessionId: string,
  ): Promise<number> {
    const entityType = SyncEntityType.AlbumUserV1;
    const checkpoint = checkpointMap[entityType];
    const backfillType = SyncEntityType.AlbumUserBackfillV1;
    const backfillCheckpoint = checkpointMap[backfillType];
    const albums = await this.db
      .selectFrom('album_user')
      .select(['albumId', 'createId'])
      .where('userId', '=', userId)
      .where('createId', '<', nowId)
      .$if(!!backfillCheckpoint, (query) => query.where('createId', '>=', backfillCheckpoint!.updateId))
      .orderBy('createId', 'asc')
      .execute();
    let count = 0;

    if (checkpoint) {
      for (const album of albums) {
        if (isEntityBackfillComplete(album.createId, backfillCheckpoint)) continue;
        const startId = getBackfillStartId(album.createId, backfillCheckpoint);
        count += await this.streamPages(
          async (afterId) => {
            let query = this.db.selectFrom('album_user').selectAll()
              .where('albumId', '=', album.albumId)
              .where('updateId', '<', nowId)
              .where('updateId', '<=', checkpoint.updateId)
              .orderBy('updateId', 'asc');
            if (startId) query = query.where('updateId', '>', startId);
            if (afterId) query = query.where('updateId', '>', afterId);
            return query.limit(PAGE_SIZE).execute();
          },
          (row) => row.updateId,
          async (row) => stream.write(serialize({
            type: backfillType,
            ids: [album.createId, row.updateId],
            data: { albumId: row.albumId, userId: row.userId, role: row.role as AlbumUserRole },
          })),
        );
        await this.sendBackfillComplete(stream, backfillType, album.createId);
      }
    } else if (albums.length > 0) {
      await this.setBackfillComplete(sessionId, backfillType, albums.at(-1)!.createId);
    }

    count += await this.streamPages(
      async (afterId) => {
        let query = this.db
          .selectFrom('album_user')
          .selectAll('album_user')
          .where('album_user.albumId', 'in',
            this.db.selectFrom('album_user as current_user').select('current_user.albumId').where('current_user.userId', '=', userId),
          )
          .where('album_user.updateId', '<', nowId)
          .orderBy('album_user.updateId', 'asc');
        if (checkpoint) query = query.where('album_user.updateId', '>', checkpoint.updateId);
        if (afterId) query = query.where('album_user.updateId', '>', afterId);
        return query.limit(PAGE_SIZE).execute();
      },
      (row) => row.updateId,
      async (row) => stream.write(serialize({
        type: entityType,
        ids: [row.updateId],
        data: { albumId: row.albumId, userId: row.userId, role: row.role as AlbumUserRole },
      })),
    );

    return count;
  }

  private async syncAlbumToAssets(
    stream: SyncWriter,
    checkpointMap: CheckpointMap,
    nowId: string,
    userId: string,
    sessionId: string,
    includeLocked: boolean,
  ): Promise<number> {
    const entityType = SyncEntityType.AlbumToAssetV1;
    const checkpoint = checkpointMap[entityType];
    const backfillType = SyncEntityType.AlbumToAssetBackfillV1;
    const backfillCheckpoint = checkpointMap[backfillType];
    const albums = await this.db.selectFrom('album_user').select(['albumId', 'createId'])
      .where('userId', '=', userId)
      .where('createId', '<', nowId)
      .$if(!!backfillCheckpoint, (query) => query.where('createId', '>=', backfillCheckpoint!.updateId))
      .orderBy('createId', 'asc')
      .execute();
    let count = 0;

    if (checkpoint) {
      for (const album of albums) {
        if (isEntityBackfillComplete(album.createId, backfillCheckpoint)) continue;
        const startId = getBackfillStartId(album.createId, backfillCheckpoint);
        count += await this.streamPages(
          async (afterId) => {
            let query = this.db.selectFrom('album_asset')
              .innerJoin('asset', 'asset.id', 'album_asset.assetId')
              .selectAll('album_asset')
              .where('album_asset.albumId', '=', album.albumId)
              .$if(!includeLocked, (qb) => qb.where('asset.visibility', '!=', 'locked'))
              .where('album_asset.updateId', '<', nowId)
              .where('album_asset.updateId', '<=', checkpoint.updateId)
              .orderBy('album_asset.updateId', 'asc');
            if (startId) query = query.where('album_asset.updateId', '>', startId);
            if (afterId) query = query.where('album_asset.updateId', '>', afterId);
            return query.limit(PAGE_SIZE).execute();
          },
          (row) => row.updateId,
          async (row) => stream.write(serialize({
            type: backfillType,
            ids: [album.createId, row.updateId],
            data: { albumId: row.albumId, assetId: row.assetId },
          })),
        );
        await this.sendBackfillComplete(stream, backfillType, album.createId);
      }
    } else if (albums.length > 0) {
      await this.setBackfillComplete(sessionId, backfillType, albums.at(-1)!.createId);
    }

    count += await this.streamPages(
      async (afterId) => {
        let query = this.db
          .selectFrom('album_asset')
          .innerJoin('asset', 'asset.id', 'album_asset.assetId')
          .selectAll('album_asset')
          .where('album_asset.albumId', 'in',
            this.db.selectFrom('album_user').select('albumId').where('userId', '=', userId),
          )
          .$if(!includeLocked, (qb) => qb.where('asset.visibility', '!=', 'locked'))
          .where('album_asset.updateId', '<', nowId)
          .orderBy('album_asset.updateId', 'asc');
        if (checkpoint) query = query.where('album_asset.updateId', '>', checkpoint.updateId);
        if (afterId) query = query.where('album_asset.updateId', '>', afterId);
        return query.limit(PAGE_SIZE).execute();
      },
      (row) => row.updateId,
      async (row) => stream.write(serialize({
        type: entityType,
        ids: [row.updateId],
        data: { albumId: row.albumId, assetId: row.assetId },
      })),
    );

    return count;
  }

  private async syncMemoryAssetUpserts(
    stream: SyncWriter,
    checkpointMap: CheckpointMap,
    nowId: string,
    userId: string,
    includeLocked: boolean,
  ): Promise<number> {
    const entityType = SyncEntityType.MemoryToAssetV1;
    const checkpoint = checkpointMap[entityType];
    const syncId = sql<string>`max(memory_asset.updateId, asset.updateId)`;

    return this.streamPages(
      async (afterId) => {
        let query = this.db
          .selectFrom('memory_asset')
          .innerJoin('memory', 'memory.id', 'memory_asset.memoriesId')
          .innerJoin('asset', 'asset.id', 'memory_asset.assetId')
          .selectAll('memory_asset')
          .select(syncId.as('syncId'))
          .where('memory.ownerId', '=', userId)
          .$if(!includeLocked, (qb) => qb.where('asset.visibility', '!=', 'locked'))
          .where(syncId, '<', nowId)
          .orderBy(syncId, 'asc');
        if (checkpoint) query = query.where(syncId, '>', checkpoint.updateId);
        if (afterId) query = query.where(syncId, '>', afterId);
        return query.limit(PAGE_SIZE).execute();
      },
      (row) => row.syncId,
      async (row) => stream.write(serialize({
        type: entityType,
        ids: [row.syncId],
        data: { memoryId: row.memoriesId, assetId: row.assetId },
      })),
    );
  }

  private async syncUserMetadataUpserts(
    stream: SyncWriter,
    checkpointMap: CheckpointMap,
    nowId: string,
    userId: string,
  ): Promise<number> {
    const entityType = SyncEntityType.UserMetadataV1;
    const checkpoint = checkpointMap[entityType];

    return this.streamPages(
      async (afterId) => {
        let query = this.db
          .selectFrom('user_metadata')
          .selectAll()
          .where('userId', '=', userId)
          .where('updateId', '<', nowId)
          .orderBy('updateId', 'asc');
        if (checkpoint) query = query.where('updateId', '>', checkpoint.updateId);
        if (afterId) query = query.where('updateId', '>', afterId);
        return query.limit(PAGE_SIZE).execute();
      },
      (row) => row.updateId,
      async (row) => stream.write(serialize({
        type: entityType,
        ids: [row.updateId],
        data: {
          userId: row.userId,
          key: row.key,
          value: typeof row.value === 'string' ? JSON.parse(row.value) : row.value,
        },
      })),
    );
  }

  private async syncAssetMetadata(
    stream: SyncWriter,
    checkpointMap: CheckpointMap,
    nowId: string,
    auth: AuthDto,
  ): Promise<number> {
    const userId = auth.user.id;
    const includeLocked = !!auth.session?.hasElevatedPermission;
    let count = 0;

    // Deletes
    const deleteType = SyncEntityType.AssetMetadataDeleteV1;
    const deleteCheckpoint = checkpointMap[deleteType];

    count += await this.streamPages(
      async (afterId) => {
        let query = this.db
          .selectFrom('asset_metadata_audit')
          .innerJoin('asset', 'asset.id', 'asset_metadata_audit.assetId')
          .selectAll('asset_metadata_audit')
          .where('asset.ownerId', '=', userId)
          .$if(!includeLocked, (qb) => qb.where((eb) => eb.or([
            eb('asset_metadata_audit.visibility', '!=', 'locked'),
            eb('asset_metadata_audit.visibility', 'is', null),
          ])))
          .where('asset_metadata_audit.id', '<', nowId)
          .orderBy('asset_metadata_audit.id', 'asc');
        if (deleteCheckpoint) query = query.where('asset_metadata_audit.id', '>', deleteCheckpoint.updateId);
        if (afterId) query = query.where('asset_metadata_audit.id', '>', afterId);
        return query.limit(PAGE_SIZE).execute();
      },
      (row) => row.id,
      async (row) => stream.write(serialize({
        type: deleteType,
        ids: [row.id],
        data: { assetId: row.assetId, key: row.key },
      })),
    );

    // Upserts
    const upsertType = SyncEntityType.AssetMetadataV1;
    const upsertCheckpoint = checkpointMap[upsertType];
    const syncId = sql<string>`max(asset_metadata.updateId, asset.updateId)`;

    count += await this.streamPages(
      async (afterId) => {
        let query = this.db
          .selectFrom('asset_metadata')
          .innerJoin('asset', 'asset.id', 'asset_metadata.assetId')
          .selectAll('asset_metadata')
          .select(syncId.as('syncId'))
          .where('asset.ownerId', '=', userId)
          .$if(!includeLocked, (qb) => qb.where('asset.visibility', '!=', 'locked'))
          .where(syncId, '<', nowId)
          .orderBy(syncId, 'asc');
        if (upsertCheckpoint) query = query.where(syncId, '>', upsertCheckpoint.updateId);
        if (afterId) query = query.where(syncId, '>', afterId);
        return query.limit(PAGE_SIZE).execute();
      },
      (row) => row.syncId,
      async (row) => stream.write(serialize({
        type: upsertType,
        ids: [row.syncId],
        data: {
          assetId: row.assetId,
          key: row.key,
          value: typeof row.value === 'string' ? JSON.parse(row.value) : row.value,
        },
      })),
    );

    return count;
  }

  private async syncAssetEdits(
    stream: SyncWriter,
    checkpointMap: CheckpointMap,
    nowId: string,
    userId: string,
    includeLocked: boolean,
  ): Promise<number> {
    let count = 0;
    const deleteType = SyncEntityType.AssetEditDeleteV1;
    const deleteCheckpoint = checkpointMap[deleteType];

    count += await this.streamPages(
      async (afterId) => {
        let query = this.db
          .selectFrom('asset_edit_audit')
          .innerJoin('asset', 'asset.id', 'asset_edit_audit.assetId')
          .selectAll('asset_edit_audit')
          .where('asset.ownerId', '=', userId)
          .$if(!includeLocked, (qb) => qb.where((eb) => eb.or([
            eb('asset_edit_audit.visibility', '!=', 'locked'),
            eb('asset_edit_audit.visibility', 'is', null),
          ])))
          .where('asset_edit_audit.id', '<', nowId)
          .orderBy('asset_edit_audit.id', 'asc');
        if (deleteCheckpoint) query = query.where('asset_edit_audit.id', '>', deleteCheckpoint.updateId);
        if (afterId) query = query.where('asset_edit_audit.id', '>', afterId);
        return query.limit(PAGE_SIZE).execute();
      },
      (row) => row.id,
      async (row) => stream.write(serialize({
        type: deleteType,
        ids: [row.id],
        data: { editId: row.editId },
      })),
    );

    const upsertType = SyncEntityType.AssetEditV1;
    const upsertCheckpoint = checkpointMap[upsertType];
    const syncId = sql<string>`max(asset_edit.updateId, asset.updateId)`;
    count += await this.streamPages(
      async (afterId) => {
        let query = this.db
          .selectFrom('asset_edit')
          .innerJoin('asset', 'asset.id', 'asset_edit.assetId')
          .selectAll('asset_edit')
          .select(syncId.as('syncId'))
          .where('asset.ownerId', '=', userId)
          .$if(!includeLocked, (qb) => qb.where('asset.visibility', '!=', 'locked'))
          .where(syncId, '<', nowId)
          .orderBy(syncId, 'asc');
        if (upsertCheckpoint) query = query.where(syncId, '>', upsertCheckpoint.updateId);
        if (afterId) query = query.where(syncId, '>', afterId);
        return query.limit(PAGE_SIZE).execute();
      },
      (row) => row.syncId,
      async (row) => stream.write(serialize({
        type: upsertType,
        ids: [row.syncId],
        data: {
          id: row.id,
          assetId: row.assetId,
          action: row.action,
          parameters: typeof row.parameters === 'string' ? JSON.parse(row.parameters) : row.parameters,
          sequence: row.sequence,
        },
      })),
    );

    return count;
  }

}
