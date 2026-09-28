import { z } from 'zod';
import { Permission } from 'src/enum';

// --- Request Schemas ---

export const APIKeyCreateSchema = z.object({
  name: z.string().optional(),
  permissions: z.array(z.nativeEnum(Permission)).min(1),
}).strict();
export type APIKeyCreateDto = z.infer<typeof APIKeyCreateSchema>;

export const APIKeyUpdateSchema = z.object({
  name: z.string().optional(),
  permissions: z.array(z.nativeEnum(Permission)).min(1).optional(),
}).strict();
export type APIKeyUpdateDto = z.infer<typeof APIKeyUpdateSchema>;

// --- Response DTOs (plain interfaces) ---

export interface APIKeyResponseDto {
  id: string;
  name: string;
  createdAt: string | Date;
  updatedAt: string | Date;
  permissions: Permission[];
}

export interface APIKeyCreateResponseDto extends APIKeyResponseDto {
  secret: string;
  apiKey: APIKeyResponseDto;
}
