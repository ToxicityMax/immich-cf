/**
 * Sync routes -- Hono sub-app for sync protocol.
 *
 * Mounts on `/api/sync` in the main app.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../hono';
import { authMiddleware } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { SyncAckDeleteSchema, SyncAckSetSchema, SyncStreamSchema } from '../dtos/sync.dto';
import { Permission } from '../enum';

const app = new Hono<AppEnv>();

// POST /api/sync/stream -- JSON Lines streaming sync
app.post(
  '/stream',
  authMiddleware({ permission: Permission.SyncStream }),
  validate('json', SyncStreamSchema),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const body = c.req.valid('json');
    const response = await services.sync.stream(auth, body);
    console.log(`[sync-route] POST /stream: returning response status=${response.status}`);
    return response;
  },
);

// GET /api/sync/ack -- Get checkpoints
app.get(
  '/ack',
  authMiddleware({ permission: Permission.SyncCheckpointRead }),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const result = await services.sync.getAcks(auth);
    return c.json(result);
  },
);

// POST /api/sync/ack -- Set checkpoints
app.post(
  '/ack',
  authMiddleware({ permission: Permission.SyncCheckpointUpdate }),
  validate('json', SyncAckSetSchema),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const body = c.req.valid('json');
    await services.sync.setAcks(auth, body);
    return c.body(null, 204);
  },
);

// DELETE /api/sync/ack -- Delete checkpoints
app.delete(
  '/ack',
  authMiddleware({ permission: Permission.SyncCheckpointDelete }),
  validate('json', SyncAckDeleteSchema),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const body = c.req.valid('json');
    await services.sync.deleteAcks(auth, body);
    return c.body(null, 204);
  },
);

export default app;
