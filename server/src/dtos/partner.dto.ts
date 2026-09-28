import { z } from 'zod';
import { UserResponseDto } from 'src/dtos/user.dto';

// --- Request Schemas ---

export const PartnerCreateSchema = z.object({
  sharedWithId: z.string().uuid(),
});
export type PartnerCreateDto = z.infer<typeof PartnerCreateSchema>;

export const PartnerUpdateSchema = z.object({
  inTimeline: z.boolean(),
});
export type PartnerUpdateDto = z.infer<typeof PartnerUpdateSchema>;

export const PartnerSearchSchema = z.object({
  direction: z.enum(['shared-by', 'shared-with']),
});
export type PartnerSearchDto = z.infer<typeof PartnerSearchSchema>;

// --- Response DTOs (plain interfaces) ---

export interface PartnerResponseDto extends UserResponseDto {
  inTimeline?: boolean;
}
