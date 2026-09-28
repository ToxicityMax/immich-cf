import { Hono } from 'hono';
import type { AppEnv } from '../hono';
import { parseSystemConfig } from '../config';
import { Permission } from '../enum';
import { authMiddleware } from '../middleware/auth';
import { BadRequestException } from '../utils/errors';

const app = new Hono<AppEnv>();

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

app.get('/', authMiddleware({ admin: true, permission: Permission.AdminConfigRead }), async (c) =>
  c.json(await c.get('services').systemConfig.getAdminConfig()),
);

app.get('/defaults', authMiddleware({ admin: true, permission: Permission.AdminConfigRead }), (c) =>
  c.json(c.get('services').systemConfig.getAdminConfigDefaults()),
);

app.put('/', authMiddleware({ admin: true, permission: Permission.AdminConfigUpdate }), async (c) => {
  const config = await parseConfig(c.req);
  return c.json(await c.get('services').systemConfig.updateSystemConfig(config));
});

export default app;
