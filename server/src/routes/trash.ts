/**
 * Trash routes -- Hono sub-app for trash management.
 *
 * Mounts on `/api/trash` in the main app.
 */

import { Hono } from 'hono';
import { BulkIdsSchema } from '../dtos/asset-ids.response.dto';
import { Permission } from '../enum';
import type { AppEnv } from '../hono';
import { authMiddleware } from '../middleware/auth';
import { validate } from '../middleware/validate';

const app = new Hono<AppEnv>();

// POST /api/trash/empty -- Empty trash (hard delete assets + R2 objects)
app.post(
  '/empty',
  authMiddleware({ permission: Permission.AssetDelete }),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const result = await services.trash.empty(auth);
    return c.json(result);
  },
);

// POST /api/trash/restore -- Restore all trashed assets
app.post(
  '/restore',
  authMiddleware({ permission: Permission.AssetDelete }),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const result = await services.trash.restoreAll(auth);
    return c.json(result);
  },
);

// POST /api/trash/restore/assets -- Restore specific assets
app.post(
  '/restore/assets',
  authMiddleware({ permission: Permission.AssetDelete }),
  validate('json', BulkIdsSchema),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const body = c.req.valid('json');
    const result = await services.trash.restore(auth, body);
    return c.json(result);
  },
);

export default app;
