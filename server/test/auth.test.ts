import { describe, it, expect, beforeAll } from 'vitest';
import { request, authRequest, apiKeyRequest, setupDatabase } from './helpers';

describe('Auth', () => {
  beforeAll(async () => {
    await setupDatabase();
  });

  // Helper to create admin in the current test's isolated storage
  async function signUpAdmin(
    email = 'admin@test.com',
    password = 'password123',
    name = 'Test Admin',
  ) {
    return request('/api/auth/admin-sign-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
    });
  }

  async function login(email = 'admin@test.com', password = 'password123') {
    return request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  }

  async function createApiKey(token: string, permissions: string[]) {
    const res = await authRequest('/api/api-keys', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test API Key', permissions }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as any).secret as string;
  }

  // -------------------------------------------------------------------------
  // Admin Sign-Up
  // -------------------------------------------------------------------------
  describe('POST /api/auth/admin-sign-up', () => {
    it('should create the first admin user', async () => {
      const res = await signUpAdmin();

      expect(res.status).toBe(201);

      const body = (await res.json()) as any;
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('email');
      expect(body.email).toBe('admin@test.com');
      expect(body.name).toBe('Test Admin');
      expect(body.isAdmin).toBe(true);
    });

    it('should reject second admin sign-up', async () => {
      // Create the first admin within this test's isolated storage
      const first = await signUpAdmin();
      expect(first.status).toBe(201);

      // Now the second signup should fail
      const res = await signUpAdmin('admin2@test.com', 'password123', 'Second Admin');

      // Should fail because an admin already exists
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------
  describe('POST /api/auth/login', () => {
    it('should return an access token with valid credentials', async () => {
      // Set up admin in this test's isolated storage
      await signUpAdmin();

      const res = await login();

      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body).toHaveProperty('accessToken');
      expect(typeof body.accessToken).toBe('string');
      expect(body.accessToken.length).toBeGreaterThan(0);
    });

    it('should return 401 with invalid password', async () => {
      await signUpAdmin();

      const res = await login('admin@test.com', 'wrongpassword');

      expect(res.status).toBe(401);
    });

    it('should return 401 with non-existent email', async () => {
      await signUpAdmin();

      const res = await login('nobody@test.com', 'password123');

      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // Token Validation
  // -------------------------------------------------------------------------
  describe('POST /api/auth/validateToken', () => {
    it('should validate a valid token', async () => {
      await signUpAdmin();
      const loginRes = await login();
      const { accessToken } = (await loginRes.json()) as any;

      const res = await authRequest('/api/auth/validateToken', accessToken, {
        method: 'POST',
      });

      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body).toHaveProperty('authStatus');
      expect(body.authStatus).toBe(true);
    });

    it('should reject an invalid token', async () => {
      const res = await authRequest('/api/auth/validateToken', 'invalid-token-here', {
        method: 'POST',
      });

      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // Change Password
  // -------------------------------------------------------------------------
  describe('POST /api/auth/change-password', () => {
    it('should change the password successfully', async () => {
      await signUpAdmin();
      const loginRes = await login();
      const { accessToken } = (await loginRes.json()) as any;

      // Change password
      const res = await authRequest('/api/auth/change-password', accessToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: 'password123',
          newPassword: 'newpassword456',
        }),
      });

      expect(res.status).toBe(200);

      // Verify old password no longer works
      const oldLoginRes = await login('admin@test.com', 'password123');
      expect(oldLoginRes.status).toBe(401);

      // Verify new password works
      const newLoginRes = await login('admin@test.com', 'newpassword456');
      expect(newLoginRes.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // PIN Code and Session Elevation
  // -------------------------------------------------------------------------
  describe('PIN code and session elevation', () => {
    it('should set up a PIN code, including one with a leading zero', async () => {
      await signUpAdmin();
      const loginRes = await login();
      const { accessToken } = (await loginRes.json()) as any;

      const setupRes = await authRequest('/api/auth/pin-code', accessToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinCode: '012345' }),
      });
      expect(setupRes.status).toBe(204);

      const statusRes = await authRequest('/api/auth/status', accessToken);
      expect(statusRes.status).toBe(200);
      expect(await statusRes.json()).toMatchObject({
        pinCode: true,
        password: true,
        isElevated: false,
      });
    });

    it('should reject malformed and duplicate PIN setup', async () => {
      await signUpAdmin();
      const loginRes = await login();
      const { accessToken } = (await loginRes.json()) as any;

      const malformedRes = await authRequest('/api/auth/pin-code', accessToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinCode: '12345' }),
      });
      expect(malformedRes.status).toBe(400);

      const setupRes = await authRequest('/api/auth/pin-code', accessToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinCode: '123456' }),
      });
      expect(setupRes.status).toBe(204);

      const duplicateRes = await authRequest('/api/auth/pin-code', accessToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinCode: '654321' }),
      });
      expect(duplicateRes.status).toBe(400);
      expect(await duplicateRes.json()).toMatchObject({ message: 'User already has a PIN code' });
    });

    it('should change a PIN only with valid credentials', async () => {
      await signUpAdmin();
      const loginRes = await login();
      const { accessToken } = (await loginRes.json()) as any;

      await authRequest('/api/auth/pin-code', accessToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinCode: '123456' }),
      });

      const wrongRes = await authRequest('/api/auth/pin-code', accessToken, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinCode: '000000', newPinCode: '654321' }),
      });
      expect(wrongRes.status).toBe(400);
      expect(await wrongRes.json()).toMatchObject({ message: 'Wrong PIN code' });

      const changeRes = await authRequest('/api/auth/pin-code', accessToken, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinCode: '123456', newPinCode: '654321' }),
      });
      expect(changeRes.status).toBe(204);

      const oldPinRes = await authRequest('/api/auth/session/unlock', accessToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinCode: '123456' }),
      });
      expect(oldPinRes.status).toBe(400);

      const newPinRes = await authRequest('/api/auth/session/unlock', accessToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinCode: '654321' }),
      });
      expect(newPinRes.status).toBe(204);
    });

    it('should unlock for fifteen minutes and explicitly lock the current session', async () => {
      await signUpAdmin();
      const loginRes = await login();
      const { accessToken } = (await loginRes.json()) as any;

      await authRequest('/api/auth/pin-code', accessToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinCode: '123456' }),
      });

      const beforeUnlock = Date.now();
      const unlockRes = await authRequest('/api/auth/session/unlock', accessToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinCode: '123456' }),
      });
      expect(unlockRes.status).toBe(204);

      const unlockedStatus = await authRequest('/api/auth/status', accessToken);
      const unlockedBody = (await unlockedStatus.json()) as any;
      expect(unlockedBody.isElevated).toBe(true);
      expect(new Date(unlockedBody.pinExpiresAt).getTime()).toBeGreaterThanOrEqual(
        beforeUnlock + 14 * 60_000,
      );

      const lockRes = await authRequest('/api/auth/session/lock', accessToken, { method: 'POST' });
      expect(lockRes.status).toBe(204);

      const lockedStatus = await authRequest('/api/auth/status', accessToken);
      expect(await lockedStatus.json()).toMatchObject({ pinCode: true, isElevated: false });
    });

    it('should reset with the account password and lock every session', async () => {
      await signUpAdmin();
      const firstLogin = await login();
      const secondLogin = await login();
      const firstToken = ((await firstLogin.json()) as any).accessToken as string;
      const secondToken = ((await secondLogin.json()) as any).accessToken as string;

      await authRequest('/api/auth/pin-code', firstToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinCode: '123456' }),
      });
      for (const token of [firstToken, secondToken]) {
        const res = await authRequest('/api/auth/session/unlock', token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pinCode: '123456' }),
        });
        expect(res.status).toBe(204);
      }

      const resetRes = await authRequest('/api/auth/pin-code', firstToken, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'password123' }),
      });
      expect(resetRes.status).toBe(204);

      for (const token of [firstToken, secondToken]) {
        const statusRes = await authRequest('/api/auth/status', token);
        expect(await statusRes.json()).toMatchObject({ pinCode: false, isElevated: false });
      }
    });

    it('should enforce API key permissions and require a session for elevation', async () => {
      await signUpAdmin();
      const loginRes = await login();
      const { accessToken } = (await loginRes.json()) as any;
      const wrongPermissionKey = await createApiKey(accessToken, ['pinCode.update']);
      const setupKey = await createApiKey(accessToken, ['pinCode.create']);
      const allKey = await createApiKey(accessToken, ['all']);

      const forbiddenRes = await apiKeyRequest('/api/auth/pin-code', wrongPermissionKey, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinCode: '123456' }),
      });
      expect(forbiddenRes.status).toBe(403);

      const setupRes = await apiKeyRequest('/api/auth/pin-code', setupKey, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinCode: '123456' }),
      });
      expect(setupRes.status).toBe(204);

      const unlockRes = await apiKeyRequest('/api/auth/session/unlock', allKey, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinCode: '123456' }),
      });
      expect(unlockRes.status).toBe(400);
      expect(await unlockRes.json()).toMatchObject({
        message: 'This endpoint can only be used with a session token',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Logout
  // -------------------------------------------------------------------------
  describe('POST /api/auth/logout', () => {
    it('should logout and invalidate the token', async () => {
      await signUpAdmin();
      const loginRes = await login();
      const { accessToken } = (await loginRes.json()) as any;

      // Logout
      const logoutRes = await authRequest('/api/auth/logout', accessToken, {
        method: 'POST',
      });

      expect(logoutRes.status).toBe(200);

      const body = (await logoutRes.json()) as any;
      expect(body).toHaveProperty('successful');
      expect(body.successful).toBe(true);

      // Verify token is now invalid
      const validateRes = await authRequest('/api/auth/validateToken', accessToken, {
        method: 'POST',
      });

      expect(validateRes.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // Unauthenticated access
  // -------------------------------------------------------------------------
  describe('Unauthenticated access', () => {
    it('should reject unauthenticated requests to protected endpoints', async () => {
      const res = await request('/api/auth/validateToken', {
        method: 'POST',
      });

      expect(res.status).toBe(401);
    });
  });
});
