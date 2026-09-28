import { Hono } from 'hono';
import type { AppEnv } from '../hono';
import { Permission } from '../enum';
import { authMiddleware } from '../middleware/auth';

const app = new Hono<AppEnv>();

app.get('/', authMiddleware({ permission: Permission.UserConfigRead }), async (c) =>
  c.json(await c.get('services').systemConfig.getUserConfig()),
);

app.get('/defaults', authMiddleware({ permission: Permission.UserConfigRead }), (c) =>
  c.json(c.get('services').systemConfig.getUserConfigDefaults()),
);

export default app;
