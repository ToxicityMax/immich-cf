import { z } from 'zod';
import { NotificationLevel, NotificationType } from '../enum';
import { optionalBooleanQuery } from '../validation';

export const NotificationSearchSchema = z.object({
  id: z.string().uuid().optional(),
  level: z.nativeEnum(NotificationLevel).optional(),
  type: z.nativeEnum(NotificationType).optional(),
  unread: optionalBooleanQuery,
});

export type NotificationSearchDto = z.infer<typeof NotificationSearchSchema>;
