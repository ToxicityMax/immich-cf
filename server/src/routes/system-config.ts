/**
 * System config routes -- Hono sub-app for system configuration.
 *
 * Mounts on `/api/system-config` in the main app.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../hono';
import { authMiddleware } from '../middleware/auth';
import { Permission } from '../enum';
import { parseSystemConfig } from '../config';
import { BadRequestException } from '../utils/errors';

const app = new Hono<AppEnv>();

const storageTemplateOptions = {
  secondOptions: ['s', 'ss', 'SSS'],
  minuteOptions: ['m', 'mm'],
  dayOptions: ['d', 'dd'],
  weekOptions: ['W', 'WW'],
  hourOptions: ['h', 'hh', 'H', 'HH'],
  yearOptions: ['y', 'yy'],
  monthOptions: ['M', 'MM', 'MMM', 'MMMM'],
  presetOptions: [
    '{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}',
    '{{y}}/{{MM}}-{{dd}}/{{filename}}',
    '{{y}}/{{MMMM}}-{{dd}}/{{filename}}',
    '{{y}}/{{MM}}/{{filename}}',
    '{{y}}/{{#if album}}{{album}}{{else}}Other/{{MM}}{{/if}}/{{filename}}',
    '{{#if album}}{{album-startDate-y}}/{{album}}{{else}}{{y}}/Other/{{MM}}{{/if}}/{{filename}}',
    '{{y}}/{{MMM}}/{{filename}}',
    '{{y}}/{{MMMM}}/{{filename}}',
    '{{y}}/{{MM}}/{{dd}}/{{filename}}',
    '{{y}}/{{MMMM}}/{{dd}}/{{filename}}',
    '{{y}}/{{y}}-{{MM}}/{{y}}-{{MM}}-{{dd}}/{{filename}}',
    '{{y}}-{{MM}}-{{dd}}/{{filename}}',
    '{{y}}-{{MMM}}-{{dd}}/{{filename}}',
    '{{y}}-{{MMMM}}-{{dd}}/{{filename}}',
    '{{y}}/{{y}}-{{MM}}/{{filename}}',
    '{{y}}/{{y}}-{{WW}}/{{filename}}',
    '{{y}}/{{y}}-{{MM}}-{{dd}}/{{assetId}}',
    '{{y}}/{{y}}-{{MM}}/{{assetId}}',
    '{{y}}/{{y}}-{{WW}}/{{assetId}}',
    '{{album}}/{{filename}}',
    '{{make}}/{{model}}/{{lensModel}}/{{filename}}',
  ],
};

async function parseConfig(request: { json(): Promise<unknown> }) {
  try {
    return parseSystemConfig(await request.json());
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new BadRequestException('Invalid request body');
    }
    const message = (error as { issues?: Array<{ message?: string }> }).issues?.[0]?.message;
    throw new BadRequestException(message || 'Invalid system configuration');
  }
}

// GET /api/system-config -- Get config
app.get(
  '/',
  authMiddleware({ admin: true, permission: Permission.SystemConfigRead }),
  async (c) => {
    const services = c.get('services');
    const result = await services.systemConfig.getSystemConfig();
    return c.json(result);
  },
);

// GET /api/system-config/defaults -- Get defaults
app.get(
  '/defaults',
  authMiddleware({ admin: true, permission: Permission.SystemConfigRead }),
  async (c) => {
    const services = c.get('services');
    const result = services.systemConfig.getDefaults();
    return c.json(result);
  },
);

app.get(
  '/storage-template-options',
  authMiddleware({ admin: true, permission: Permission.SystemConfigRead }),
  (c) => c.json(storageTemplateOptions),
);

// PUT /api/system-config -- Update config
app.put(
  '/',
  authMiddleware({ admin: true, permission: Permission.SystemConfigUpdate }),
  async (c) => {
    const services = c.get('services');
    const body = await parseConfig(c.req);
    const result = await services.systemConfig.updateSystemConfig(body);
    return c.json(result);
  },
);

export default app;
