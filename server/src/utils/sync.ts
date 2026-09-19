import type { SyncAssetExifV1, SyncAssetV1, SyncItem } from 'src/dtos/sync.dto';
import { SyncEntityType } from 'src/enum';
import { SyncAck } from 'src/types';

type Impossible<K extends keyof any> = {
  [P in K]: never;
};

type Exact<T, U extends T = T> = U & Impossible<Exclude<keyof U, keyof T>>;

export const fromAck = (ack: string): SyncAck => {
  const [type, updateId, extraId] = ack.split('|');
  return { type: type as SyncEntityType, updateId, extraId };
};

export const toAck = ({ type, updateId, extraId }: SyncAck) =>
  [type, updateId, extraId].filter((v) => v !== undefined).join('|');

export const mapJsonLine = (object: unknown) => JSON.stringify(object) + '\n';

export type SerializeOptions<T extends keyof SyncItem, D extends SyncItem[T]> = {
  type: T;
  data: Exact<SyncItem[T], D>;
  ids: [string] | [string, string];
  ackType?: SyncEntityType;
};

export const serialize = <T extends keyof SyncItem, D extends SyncItem[T]>({
  type,
  data,
  ids,
  ackType,
}: SerializeOptions<T, D>) =>
  mapJsonLine({ type, data, ack: toAck({ type: ackType ?? type, updateId: ids[0], extraId: ids[1] }) });

function blobToBase64(value: unknown): string {
  let bytes: Uint8Array | undefined;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (Array.isArray(value)) {
    bytes = new Uint8Array(value);
  } else if (typeof value === 'string') {
    return value;
  }

  if (!bytes || bytes.length === 0) {
    return '';
  }

  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function mapSyncAssetV1(row: any): SyncAssetV1 {
  return {
    id: row.id,
    ownerId: row.ownerId,
    originalFileName: row.originalFileName,
    thumbhash: row.thumbhash ? blobToBase64(row.thumbhash) || null : null,
    checksum: row.checksum ? blobToBase64(row.checksum) : '',
    fileCreatedAt: row.fileCreatedAt,
    fileModifiedAt: row.fileModifiedAt,
    localDateTime: row.localDateTime,
    duration: row.duration,
    type: row.type,
    deletedAt: row.deletedAt,
    isFavorite: Boolean(row.isFavorite),
    visibility: row.visibility,
    livePhotoVideoId: row.livePhotoVideoId,
    stackId: row.stackId,
    libraryId: row.libraryId,
    width: row.width,
    height: row.height,
    isEdited: Boolean(row.isEdited),
  };
}

export function mapSyncAssetExifV1(row: any, assetId = row?.assetId): SyncAssetExifV1 {
  return {
    assetId,
    description: row?.description ?? null,
    exifImageWidth: row?.exifImageWidth ?? null,
    exifImageHeight: row?.exifImageHeight ?? null,
    fileSizeInByte: row?.fileSizeInByte == null ? null : Number(row.fileSizeInByte),
    orientation: row?.orientation ?? null,
    dateTimeOriginal: row?.dateTimeOriginal ?? null,
    modifyDate: row?.modifyDate ?? null,
    timeZone: row?.timeZone ?? null,
    latitude: row?.latitude ?? null,
    longitude: row?.longitude ?? null,
    projectionType: row?.projectionType ?? null,
    city: row?.city ?? null,
    state: row?.state ?? null,
    country: row?.country ?? null,
    make: row?.make ?? null,
    model: row?.model ?? null,
    lensModel: row?.lensModel ?? null,
    fNumber: row?.fNumber ?? null,
    focalLength: row?.focalLength ?? null,
    iso: row?.iso ?? null,
    exposureTime: row?.exposureTime ?? null,
    profileDescription: row?.profileDescription ?? null,
    rating: row?.rating ?? null,
    fps: row?.fps ?? null,
  };
}
