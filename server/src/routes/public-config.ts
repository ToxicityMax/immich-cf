import { Hono } from 'hono';
import type { AppEnv } from '../hono';

const app = new Hono<AppEnv>();

app.get('/config', async (c) => {
  const result = await c.get('services').systemConfig.getPublicConfig();
  return c.json(result);
});

app.get('/config/defaults', (c) => {
  const result = c.get('services').systemConfig.getPublicConfigDefaults();
  return c.json(result);
});

export default app;
