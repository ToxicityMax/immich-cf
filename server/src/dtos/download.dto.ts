import { z } from 'zod';

// --- Request Schemas ---

const uuidV4 = z.string().uuid().refine((value) => value[14] === '4', { message: 'Invalid UUID v4' });

export const DownloadInfoSchema = z.object({
  assetIds: z.array(uuidV4).optional(),
  albumId: uuidV4.optional(),
  userId: uuidV4.optional(),
  archiveSize: z.number().int().min(1).optional(),
});
export type DownloadInfoDto = z.infer<typeof DownloadInfoSchema>;

export const DownloadArchiveSchema = z.object({
  assetIds: z.preprocess(
    (value) => typeof value === 'string' ? value.split(',').filter(Boolean) : value,
    z.array(uuidV4),
  ),
  edited: z.preprocess((value) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }, z.boolean()).optional(),
  archiveName: z.string().optional(),
});
export type DownloadArchiveDto = z.infer<typeof DownloadArchiveSchema>;

// --- Response DTOs (plain interfaces) ---

export interface DownloadArchiveInfo {
  size: number;
  assetIds: string[];
}

export interface DownloadResponseDto {
  totalSize: number;
  archives: DownloadArchiveInfo[];
}
