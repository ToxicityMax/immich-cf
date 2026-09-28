import { beforeAll, describe, expect, it } from 'vitest';
import { authRequest, createTestAdmin, request, setupDatabase } from './helpers';

describe('Notifications', () => {
  let token: string;

  beforeAll(async () => {
    await setupDatabase();
    ({ token } = await createTestAdmin());
  });

  it('requires authentication', async () => {
    expect((await request('/api/notifications?unread=true')).status).toBe(401);
  });

  it('returns the empty unread inbox expected by the web client', async () => {
    const response = await authRequest('/api/notifications?unread=true', token);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it('validates notification filters', async () => {
    expect((await authRequest('/api/notifications?unread=invalid', token)).status).toBe(400);
    expect((await authRequest('/api/notifications?level=invalid', token)).status).toBe(400);
  });
});
