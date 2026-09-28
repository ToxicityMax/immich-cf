import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { apiKeyRequest, authRequest, createTestAdmin, request, setupDatabase } from './helpers';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('API keys', () => {
  let token: string;

  beforeAll(async () => {
    await setupDatabase();
    ({ token } = await createTestAdmin());
  });

  async function create(permissions: string[], name = 'Test key', authToken = token) {
    const response = await authRequest('/api/api-keys', authToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, permissions }),
    });
    return { response, body: (await response.json()) as any };
  }

  it('creates the exact v3 response without storing or listing the secret', async () => {
    const { response, body } = await create(['server.about']);

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      id: expect.any(String),
      name: 'Test key',
      permissions: ['server.about'],
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      secret: expect.any(String),
      apiKey: { id: expect.any(String), name: 'Test key', permissions: ['server.about'] },
    });
    expect(body.apiKey.id).toBe(body.id);

    const row = await env.DB.prepare('SELECT key, updateId FROM api_key WHERE id = ?')
      .bind(body.id)
      .first<{ key: string; updateId: string }>();
    expect(row?.key).not.toBe(body.secret);
    expect(row?.updateId).toMatch(UUID_V7);

    const list = await authRequest('/api/api-keys', token);
    expect(JSON.stringify(await list.json())).not.toContain(body.secret);
  });

  it('rotates in place, advances state, and immediately invalidates the old secret', async () => {
    const { body: created } = await create(['apiKey.read', 'server.about']);
    const before = await env.DB.prepare('SELECT "updatedAt", "updateId" FROM api_key WHERE id = ?')
      .bind(created.id)
      .first<{ updatedAt: string; updateId: string }>();

    const response = await authRequest(`/api/api-keys/${created.id}/rotate`, token, { method: 'POST' });
    expect(response.status).toBe(200);
    const rotated = (await response.json()) as any;
    expect(rotated).toMatchObject({
      id: created.id,
      name: created.name,
      permissions: created.permissions,
      secret: expect.any(String),
      apiKey: { id: created.id },
    });
    expect(rotated.secret).not.toBe(created.secret);

    const after = await env.DB.prepare('SELECT "updatedAt", "updateId" FROM api_key WHERE id = ?')
      .bind(created.id)
      .first<{ updatedAt: string; updateId: string }>();
    expect(after?.updateId).not.toBe(before?.updateId);
    expect(after?.updateId).toMatch(UUID_V7);
    expect(after?.updatedAt).not.toBe(before?.updatedAt);

    expect((await apiKeyRequest('/api/server/about', created.secret)).status).toBe(401);
    expect((await apiKeyRequest('/api/server/about', rotated.secret)).status).toBe(200);
  });

  it('allows /me without apiKey.read but enforces rotation delegation', async () => {
    const { body: limited } = await create(['apiKey.rotate']);
    const me = await apiKeyRequest('/api/api-keys/me', limited.secret);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: limited.id, permissions: ['apiKey.rotate'] });

    const { body: target } = await create(['all']);
    const rotate = await apiKeyRequest(`/api/api-keys/${target.id}/rotate`, limited.secret, { method: 'POST' });
    expect(rotate.status).toBe(400);
    expect(await rotate.json()).toMatchObject({ message: 'Cannot rotate an API Key with permissions you do not have' });
  });

  it('requires rotate permission and scopes rotation to the owning user', async () => {
    const { body: target } = await create(['all']);
    const { body: readOnly } = await create(['apiKey.read']);
    expect((await apiKeyRequest(`/api/api-keys/${target.id}/rotate`, readOnly.secret, { method: 'POST' })).status).toBe(403);

    await authRequest('/api/admin/users', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'other@test.com', name: 'Other', password: 'password123' }),
    });
    const login = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'other@test.com', password: 'password123' }),
    });
    const otherToken = ((await login.json()) as any).accessToken as string;
    const { body: otherKey } = await create(['all'], 'Other key', otherToken);

    const response = await authRequest(`/api/api-keys/${otherKey.id}/rotate`, token, { method: 'POST' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: 'API Key not found' });
  });

  it('validates UUIDs, bodies, permissions, and unknown fields', async () => {
    const invalidId = await authRequest('/api/api-keys/not-a-uuid', token);
    expect(invalidId.status).toBe(400);

    for (const body of [
      { name: 'empty', permissions: [] },
      { name: 'invalid', permissions: ['not.a.permission'] },
      { name: 'unknown', permissions: ['all'], extra: true },
    ]) {
      const response = await authRequest('/api/api-keys', token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
  });
});
