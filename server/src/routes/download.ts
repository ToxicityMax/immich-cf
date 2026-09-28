/**
 * Download routes -- Hono sub-app for download/archive operations.
 *
 * Mounts on `/api/download` in the main app.
 */

import { Hono } from 'hono';
import type { ZodType } from 'zod';
import type { AppEnv } from '../hono';
import { authMiddleware } from '../middleware/auth';
import { Permission } from '../enum';
import { DownloadArchiveSchema, DownloadInfoSchema } from '../dtos/download.dto';
import { BadRequestException } from '../utils/errors';

const app = new Hono<AppEnv>();

const validate = <T>(schema: ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException(result.error.issues[0]?.message || 'Invalid request');
  }
  return result.data;
};

const parseJson = async (request: { json(): Promise<unknown> }) => {
  try {
    return await request.json();
  } catch {
    throw new BadRequestException('Invalid request body');
  }
};

// POST /api/download/info -- Get download info (sizes, chunking)
app.post(
  '/info',
  authMiddleware({ permission: Permission.AssetDownload, sharedLink: true }),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const body = validate(DownloadInfoSchema, await parseJson(c.req));
    const result = await services.download.getDownloadInfo(auth, body);
    return c.json(result);
  },
);

// POST /api/download/archive -- Download ZIP archive
app.post(
  '/archive',
  authMiddleware({ permission: Permission.AssetDownload, sharedLink: true }),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const contentType = c.req.header('content-type') || '';
    const rawBody = contentType.includes('application/json') ? await parseJson(c.req) : await c.req.parseBody();
    const body = validate(DownloadArchiveSchema, rawBody);
    const response = await services.download.downloadArchive(auth, body);
    return response;
  },
);

export default app;
