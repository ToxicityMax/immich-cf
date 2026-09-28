import { z } from 'zod';
import { SharedLink } from 'src/database';
import { AlbumResponseDto, mapAlbumWithoutAssets } from 'src/dtos/album.dto';
import { AssetResponseDto, mapAsset } from 'src/dtos/asset-response.dto';
import { SharedLinkType } from 'src/enum';

// --- Request Schemas ---

const uuidV4 = z.string().uuid().refine((value) => value[14] === '4', { message: 'Invalid UUID v4' });

export const SharedLinkIdSchema = z.object({ id: uuidV4 });

export const SharedLinkSearchSchema = z.object({
  albumId: uuidV4.optional(),
  id: uuidV4.optional(),
});
export type SharedLinkSearchDto = z.infer<typeof SharedLinkSearchSchema>;

export const SharedLinkCreateSchema = z.object({
  type: z.nativeEnum(SharedLinkType),
  assetIds: z.array(uuidV4).optional(),
  albumId: uuidV4.optional(),
  description: z.string().nullable().optional(),
  password: z.string().nullable().optional(),
  slug: z.string().nullable().optional(),
  expiresAt: z.string().datetime({ offset: true }).transform((value) => new Date(value)).nullable().optional().default(null),
  allowUpload: z.boolean().optional(),
  allowDownload: z.boolean().optional().default(true),
  showMetadata: z.boolean().optional().default(true),
}).superRefine(({ type, albumId, assetIds }, ctx) => {
  if (type === SharedLinkType.Album) {
    if (!albumId) {
      ctx.addIssue({ code: 'custom', message: `albumId is required for type ${SharedLinkType.Album}` });
    }
    if (assetIds && assetIds.length > 0) {
      ctx.addIssue({ code: 'custom', message: `assetIds can only be used with type ${SharedLinkType.Individual}` });
    }
    return;
  }

  if (!assetIds || assetIds.length === 0) {
    ctx.addIssue({ code: 'custom', message: `assetIds are required for type ${SharedLinkType.Individual}` });
  }
  if (albumId) {
    ctx.addIssue({ code: 'custom', message: `albumId can only be used with type ${SharedLinkType.Album}` });
  }
});
export type SharedLinkCreateDto = z.infer<typeof SharedLinkCreateSchema>;

export const SharedLinkEditSchema = z.object({
  description: z.string().nullable().optional(),
  password: z.string().nullable().optional(),
  slug: z.string().nullable().optional(),
  expiresAt: z.string().datetime({ offset: true }).transform((value) => new Date(value)).nullish(),
  allowUpload: z.boolean().optional(),
  allowDownload: z.boolean().optional(),
  showMetadata: z.boolean().optional(),
});
export type SharedLinkEditDto = z.infer<typeof SharedLinkEditSchema>;

export const SharedLinkLoginSchema = z.object({
  password: z.string(),
});
export type SharedLinkLoginDto = z.infer<typeof SharedLinkLoginSchema>;

// --- Response DTOs (plain interfaces) ---

export interface SharedLinkResponseDto {
  id: string;
  description: string | null;
  password: string | null;
  userId: string;
  key: string;
  type: SharedLinkType;
  createdAt: Date;
  expiresAt: Date | null;
  assets: AssetResponseDto[];
  album?: AlbumResponseDto;
  allowUpload: boolean;
  allowDownload: boolean;
  showMetadata: boolean;
  slug: string | null;
}

// --- Mapper ---

export function mapSharedLink(sharedLink: SharedLink, options: { stripAssetMetadata: boolean }): SharedLinkResponseDto {
  const assets = sharedLink.assets || [];
  const key = sharedLink.key as unknown as Uint8Array | ArrayBuffer;
  const keyBytes = key instanceof Uint8Array ? key : new Uint8Array(key);
  const encodedKey = btoa(String.fromCharCode(...keyBytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

  const response = {
    id: sharedLink.id,
    description: sharedLink.description,
    password: sharedLink.password,
    userId: sharedLink.userId,
    key: encodedKey,
    type: sharedLink.type,
    createdAt: sharedLink.createdAt,
    expiresAt: sharedLink.expiresAt,
    assets: assets.map((asset) => mapAsset(asset, { stripMetadata: options.stripAssetMetadata })),
    album: sharedLink.album ? mapAlbumWithoutAssets(sharedLink.album) : undefined,
    allowUpload: Boolean(sharedLink.allowUpload),
    allowDownload: Boolean(sharedLink.allowDownload),
    showMetadata: Boolean(sharedLink.showExif),
    slug: sharedLink.slug,
  };

  // unless we select sharedLink.album.sharedLinks this will be wrong
  if (response.album) {
    response.album.hasSharedLink = true;
    response.album.shared = true;
  }

  return response;
}
