/**
 * Shared Link routes -- Hono sub-app for shared link CRUD.
 *
 * Mounts on `/api/shared-links` in the main app.
 */

import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { ZodType } from 'zod';
import type { AppEnv } from '../hono';
import { authMiddleware } from '../middleware/auth';
import { ImmichCookie, Permission } from '../enum';
import { AssetIdsSchema } from '../dtos/asset.dto';
import {
  SharedLinkCreateSchema,
  SharedLinkEditSchema,
  SharedLinkIdSchema,
  SharedLinkLoginSchema,
  SharedLinkSearchSchema,
} from '../dtos/shared-link.dto';
import { BadRequestException } from '../utils/errors';

const app = new Hono<AppEnv>();

const parse = <T>(schema: ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException(result.error.issues[0]?.message || 'Invalid request');
  }
  return result.data;
};

const parseJson = async <T>(request: { json(): Promise<unknown> }, schema: ZodType<T>): Promise<T> => {
  try {
    return parse(schema, await request.json());
  } catch (error) {
    if (error instanceof BadRequestException) {
      throw error;
    }
    throw new BadRequestException('Invalid request body');
  }
};

// GET /api/shared-links -- List all shared links
app.get(
  '/',
  authMiddleware({ permission: Permission.SharedLinkRead }),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const dto = parse(SharedLinkSearchSchema, c.req.query());
    const result = await services.sharedLink.getAll(auth, dto);
    return c.json(result);
  },
);

// POST /api/shared-links/login -- Login to a password-protected shared link
app.post(
  '/login',
  authMiddleware({ sharedLink: true, sharedLinkPassword: false }),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const dto = await parseJson(c.req, SharedLinkLoginSchema);
    const { sharedLink, token } = await services.sharedLink.login(auth, dto);
    const tokens = (getCookie(c, ImmichCookie.SharedLinkToken) || '').split(',').filter(Boolean);
    if (!tokens.includes(token)) {
      tokens.push(token);
    }

    setCookie(c, ImmichCookie.SharedLinkToken, tokens.join(','), {
      path: '/',
      sameSite: 'Lax',
      httpOnly: true,
      secure: new URL(c.req.url).protocol === 'https:',
      maxAge: 24 * 60 * 60,
    });
    return c.json(sharedLink, 201);
  },
);

// GET /api/shared-links/me -- Get current shared link
app.get(
  '/me',
  authMiddleware({ sharedLink: true, sharedLinkPassword: false }),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const tokens = (getCookie(c, ImmichCookie.SharedLinkToken) || '').split(',').filter(Boolean);
    const result = await services.sharedLink.getMine(auth, tokens);
    return c.json(result);
  },
);

// GET /api/shared-links/:id -- Get shared link
app.get(
  '/:id',
  authMiddleware({ permission: Permission.SharedLinkRead }),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const { id } = parse(SharedLinkIdSchema, c.req.param());
    const result = await services.sharedLink.get(auth, id);
    return c.json(result);
  },
);

// POST /api/shared-links -- Create shared link
app.post(
  '/',
  authMiddleware({ permission: Permission.SharedLinkCreate }),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const body = await parseJson(c.req, SharedLinkCreateSchema);
    const result = await services.sharedLink.create(auth, body);
    return c.json(result, 201);
  },
);

// PATCH /api/shared-links/:id -- Update shared link
app.patch(
  '/:id',
  authMiddleware({ permission: Permission.SharedLinkUpdate }),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const { id } = parse(SharedLinkIdSchema, c.req.param());
    const body = await parseJson(c.req, SharedLinkEditSchema);
    const result = await services.sharedLink.update(auth, id, body);
    return c.json(result);
  },
);

// DELETE /api/shared-links/:id -- Delete shared link
app.delete(
  '/:id',
  authMiddleware({ permission: Permission.SharedLinkDelete }),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const { id } = parse(SharedLinkIdSchema, c.req.param());
    await services.sharedLink.remove(auth, id);
    return c.body(null, 204);
  },
);

// PUT /api/shared-links/:id/assets -- Add assets to shared link
app.put(
  '/:id/assets',
  authMiddleware({ permission: Permission.SharedLinkUpdate }),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const { id } = parse(SharedLinkIdSchema, c.req.param());
    const body = await parseJson(c.req, AssetIdsSchema);
    const result = await services.sharedLink.addAssets(auth, id, body);
    return c.json(result);
  },
);

// DELETE /api/shared-links/:id/assets -- Remove assets from shared link
app.delete(
  '/:id/assets',
  authMiddleware({ permission: Permission.SharedLinkUpdate }),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const { id } = parse(SharedLinkIdSchema, c.req.param());
    const body = await parseJson(c.req, AssetIdsSchema);
    const result = await services.sharedLink.removeAssets(auth, id, body);
    return c.json(result);
  },
);

export default app;
