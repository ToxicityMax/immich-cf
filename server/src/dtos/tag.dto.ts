import { z } from 'zod';
import { Tag } from 'src/database';
import { hexColor } from 'src/validation';

// --- Request Schemas ---

export const TagCreateSchema = z.object({
  name: z.string().regex(/^[^/]*$/, 'Tag name cannot contain slash characters ("/")'),
  parentId: z.string().uuid().nullable().optional(),
  color: hexColor.nullable().optional().transform((v) => (v === '' ? null : v)),
});
export type TagCreateDto = z.infer<typeof TagCreateSchema>;

export const TagUpdateSchema = z.object({
  name: z.string().regex(/^[^/]*$/, 'Tag name cannot contain slash characters ("/")').optional(),
  color: hexColor.nullable().optional().transform((v) => (v === '' ? null : v)),
});
export type TagUpdateDto = z.infer<typeof TagUpdateSchema>;

export const TagUpsertSchema = z.object({
  tags: z.array(z.string()),
});
export type TagUpsertDto = z.infer<typeof TagUpsertSchema>;

export const TagBulkAssetsSchema = z.object({
  tagIds: z.array(z.string().uuid()),
  assetIds: z.array(z.string().uuid()),
});
export type TagBulkAssetsDto = z.infer<typeof TagBulkAssetsSchema>;

// --- Response DTOs (plain interfaces) ---

export interface TagBulkAssetsResponseDto {
  count: number;
}

export interface TagResponseDto {
  id: string;
  parentId?: string;
  name: string;
  value: string;
  createdAt: Date;
  updatedAt: Date;
  color?: string;
}

// --- Mapper ---

export function mapTag(entity: Tag): TagResponseDto {
  return {
    id: entity.id,
    parentId: entity.parentId ?? undefined,
    name: entity.value.split('/').at(-1) as string,
    value: entity.value,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    color: entity.color ?? undefined,
  };
}
