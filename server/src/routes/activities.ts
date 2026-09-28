/**
 * Activity routes -- Hono sub-app for activity CRUD.
 *
 * Mounts on `/api/activities` in the main app.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../hono';
import { authMiddleware } from '../middleware/auth';
import { Permission } from '../enum';
import { validate } from '../middleware/validate';
import { ActivityCreateSchema, ActivityDtoSchema, ActivitySearchSchema } from '../dtos/activity.dto';
import { UUIDParamSchema } from '../validation';

const app = new Hono<AppEnv>();

// GET /api/activities -- List activities
app.get(
  '/',
  authMiddleware({ permission: Permission.ActivityRead }),
  validate('query', ActivitySearchSchema),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const dto = c.req.valid('query');
    const result = await services.activity.getAll(auth, dto);
    return c.json(result);
  },
);

// POST /api/activities -- Create activity
app.post(
  '/',
  authMiddleware({ permission: Permission.ActivityCreate }),
  validate('json', ActivityCreateSchema),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const body = c.req.valid('json');
    const { duplicate, value } = await services.activity.create(auth, body);
    if (duplicate) {
      return c.json(value, 200);
    }
    return c.json(value, 201);
  },
);

// GET /api/activities/statistics -- Activity statistics
app.get(
  '/statistics',
  authMiddleware({ permission: Permission.ActivityStatistics }),
  validate('query', ActivityDtoSchema),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const dto = c.req.valid('query');
    const result = await services.activity.getStatistics(auth, dto);
    return c.json(result);
  },
);

// DELETE /api/activities/:id -- Delete activity
app.delete(
  '/:id',
  authMiddleware({ permission: Permission.ActivityDelete }),
  validate('param', UUIDParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const id = c.req.param('id');
    await services.activity.delete(auth, id);
    return c.body(null, 204);
  },
);

export default app;
