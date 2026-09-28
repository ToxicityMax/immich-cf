import { beforeAll, describe, expect, it } from 'vitest';
import { apiKeyRequest, authRequest, createTestAdmin, request, setupDatabase } from './helpers';

describe('System configuration visibility', () => {
  let token: string;

  beforeAll(async () => {
    await setupDatabase();
    ({ token } = await createTestAdmin());
  });

  async function createKey(permissions: string[]) {
    const response = await authRequest('/api/api-keys', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Config key', permissions }),
    });
    return ((await response.json()) as any).secret as string;
  }

  it('returns a complete safe admin DTO on both current and legacy routes', async () => {
    expect((await request('/api/admin/config')).status).toBe(401);

    for (const path of ['/api/admin/config', '/api/admin/config/defaults', '/api/system-config', '/api/system-config/defaults']) {
      const response = await authRequest(path, token);
      expect(response.status).toBe(200);
      const config = (await response.json()) as any;
      expect(Object.keys(config).sort()).toEqual([
        'backup', 'ffmpeg', 'image', 'integrityChecks', 'job', 'library', 'logging', 'machineLearning', 'map',
        'metadata', 'newVersionCheck', 'nightlyTasks', 'notifications', 'oauth', 'passwordLogin',
        'reverseGeocoding', 'server', 'storageTemplate', 'templates', 'theme', 'trash', 'user',
      ].sort());
      expect(config.backup.database.enabled).toBe(false);
      expect(config.machineLearning.enabled).toBe(false);
      expect(config.notifications.smtp.enabled).toBe(false);
      expect(config.oauth.enabled).toBe(false);
    }
  });

  it('exposes only public and user-visible fields and never leaks secrets', async () => {
    const adminResponse = await authRequest('/api/admin/config', token);
    const config = (await adminResponse.json()) as any;
    config.server.loginPageMessage = 'Visible message';
    config.oauth.clientSecret = 'oauth-secret-value';
    config.oauth.enabled = true;
    config.notifications.smtp.transport.password = 'smtp-secret-value';
    config.notifications.smtp.enabled = true;
    config.unexpected = { value: true };

    const invalid = await authRequest('/api/admin/config', token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    expect(invalid.status).toBe(400);

    delete config.unexpected;
    const updated = await authRequest('/api/admin/config', token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      server: { loginPageMessage: 'Visible message' },
      oauth: { clientSecret: 'oauth-secret-value', enabled: false },
      notifications: { smtp: { enabled: false, transport: { password: 'smtp-secret-value' } } },
    });

    const publicConfig = await request('/api/public/config');
    expect(publicConfig.status).toBe(200);
    const publicBody = await publicConfig.json();
    expect(publicBody).toEqual({
      oauth: { autoLaunch: false, buttonText: 'Login with OAuth', enabled: false },
      passwordLogin: { enabled: true },
      server: { loginPageMessage: 'Visible message' },
      theme: { customCss: '' },
    });

    const userConfig = await authRequest('/api/config', token);
    expect(userConfig.status).toBe(200);
    const serialized = JSON.stringify(await userConfig.json());
    expect(serialized).not.toContain('clientSecret');
    expect(serialized).not.toContain('oauth-secret-value');
    expect(serialized).not.toContain('smtp-secret-value');
  });

  it('enforces exact API-key permissions for each visibility route', async () => {
    const userKey = await createKey(['userConfig.read']);
    expect((await apiKeyRequest('/api/config', userKey)).status).toBe(200);
    expect((await apiKeyRequest('/api/admin/config', userKey)).status).toBe(403);

    const adminKey = await createKey(['adminConfig.read']);
    expect((await apiKeyRequest('/api/admin/config', adminKey)).status).toBe(200);
    expect((await apiKeyRequest('/api/system-config', adminKey)).status).toBe(403);

    const legacyKey = await createKey(['systemConfig.read']);
    expect((await apiKeyRequest('/api/system-config', legacyKey)).status).toBe(200);
  });

  it('includes the OAuth account-management URL in server config', async () => {
    const response = await request('/api/server/config');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ oauthAccountManagementUrl: '' });
  });

  it('returns the v3 storage-template options required by the admin UI', async () => {
    expect((await request('/api/system-config/storage-template-options')).status).toBe(401);

    const response = await authRequest('/api/system-config/storage-template-options', token);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      yearOptions: ['y', 'yy'],
      monthOptions: ['M', 'MM', 'MMM', 'MMMM'],
      presetOptions: expect.arrayContaining(['{{y}}/{{MM}}/{{filename}}']),
    });
  });
});
