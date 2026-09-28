import { Hono } from 'hono';
import type { AppEnv } from '../hono';
import { Permission } from '../enum';
import { authMiddleware } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { NotificationSearchSchema } from '../dtos/notification.dto';

const app = new Hono<AppEnv>();

app.get(
  '/',
  authMiddleware({ permission: Permission.NotificationRead }),
  validate('query', NotificationSearchSchema),
  (c) => c.json([]),
);

export default app;
