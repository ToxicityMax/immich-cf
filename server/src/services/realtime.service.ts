import type { AssetResponseDto } from 'src/dtos/asset-response.dto';
import type { SyncAssetEditV1, SyncAssetExifV1, SyncAssetV2 } from 'src/dtos/sync.dto';
import type { Env } from 'src/env';
import { ImmichEnvironment } from 'src/enum';

const HUB_NAME = 'immich';

export interface RealtimeClientEventMap {
  on_upload_success: [AssetResponseDto];
  on_user_delete: [string];
  on_asset_delete: [string];
  on_asset_trash: [string[]];
  on_asset_update: [AssetResponseDto];
  on_asset_hidden: [string];
  on_asset_restore: [string[]];
  on_asset_stack_update: [];
  on_album_update: [string];
  on_person_thumbnail: [string];
  on_server_version: [{ major: number; minor: number; patch: number; prerelease: number | null }];
  on_config_update: [];
  on_new_release: [unknown];
  on_session_delete: [string];
  on_notification: [unknown];
  AppRestartV1: [{ isMaintenanceMode: boolean }];
  MaintenanceStatusV1: [unknown];
  AssetUploadReadyV2: [{ asset: SyncAssetV2; exif: SyncAssetExifV1 }];
  AssetEditReadyV2: [{ asset: SyncAssetV2; edit: SyncAssetEditV1[] }];
}

export interface RealtimePublishRequest {
  event: keyof RealtimeClientEventMap;
  args: unknown[];
  rooms?: string[];
}

export interface RealtimeDisconnectRequest {
  rooms: string[];
}

export class RealtimeService {
  constructor(
    private namespace: DurableObjectNamespace,
    private enabled = true,
  ) {}

  sendUser<T extends keyof RealtimeClientEventMap>(
    userId: string,
    event: T,
    ...args: RealtimeClientEventMap[T]
  ): Promise<void> {
    return this.publish(event, args, [`user:${userId}`]);
  }

  sendUsers<T extends keyof RealtimeClientEventMap>(
    userIds: string[],
    event: T,
    ...args: RealtimeClientEventMap[T]
  ): Promise<void> {
    const rooms = [...new Set(userIds)].map((userId) => `user:${userId}`);
    return this.publish(event, args, rooms);
  }

  sendSession<T extends keyof RealtimeClientEventMap>(
    sessionId: string,
    event: T,
    ...args: RealtimeClientEventMap[T]
  ): Promise<void> {
    return this.publish(event, args, [`session:${sessionId}`]);
  }

  broadcast<T extends keyof RealtimeClientEventMap>(
    event: T,
    ...args: RealtimeClientEventMap[T]
  ): Promise<void> {
    return this.publish(event, args);
  }

  disconnectUser(userId: string): Promise<void> {
    return this.disconnect([`user:${userId}`]);
  }

  disconnectSession(sessionId: string): Promise<void> {
    return this.disconnect([`session:${sessionId}`]);
  }

  disconnectApiKey(apiKeyId: string): Promise<void> {
    return this.disconnect([`api-key:${apiKeyId}`]);
  }

  private async publish<T extends keyof RealtimeClientEventMap>(
    event: T,
    args: RealtimeClientEventMap[T],
    rooms?: string[],
  ): Promise<void> {
    if (rooms?.length === 0) {
      return;
    }

    const message: RealtimePublishRequest = { event, args, rooms };
    return this.post('/publish', message);
  }

  private disconnect(rooms: string[]): Promise<void> {
    const message: RealtimeDisconnectRequest = { rooms };
    return this.post('/disconnect', message);
  }

  private async post(path: string, message: RealtimePublishRequest | RealtimeDisconnectRequest): Promise<void> {
    if (!this.enabled) {
      return;
    }

    try {
      const id = this.namespace.idFromName(HUB_NAME);
      const response = await this.namespace.get(id).fetch(`https://realtime.internal${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        console.error(`Realtime request failed with status ${response.status}`);
      }
    } catch (error) {
      // Realtime delivery is best-effort; HTTP sync remains the source of convergence.
      console.error('Realtime request failed:', error);
    }
  }
}

export function createRealtimeService(env: Env): RealtimeService {
  return new RealtimeService(env.REALTIME, env.ENVIRONMENT !== ImmichEnvironment.Testing);
}
