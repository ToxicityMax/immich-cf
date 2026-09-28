/**
 * Auth routes -- Hono sub-app for authentication operations.
 *
 * Mounts on `/api/auth` in the main app.
 */

import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import type { ZodType } from 'zod';
import type { AppEnv } from '../hono';
import {
  PinCodeChangeSchema,
  PinCodeResetSchema,
  PinCodeSetupSchema,
  SessionUnlockSchema,
} from '../dtos/auth.dto';
import { authMiddleware } from '../middleware/auth';
import { AuthType, ImmichCookie, Permission } from '../enum';
import { BadRequestException, UnauthorizedException } from '../utils/errors';

const app = new Hono<AppEnv>();

async function parseJson<T>(request: { json(): Promise<unknown> }, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new BadRequestException('Invalid request body');
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(result.error.issues[0]?.message || 'Invalid request body');
  }

  return result.data;
}

// POST /api/auth/login -- Login with email/password
app.post('/login', async (c) => {
  const services = c.get('services');
  const body = await c.req.json();
  const config = await services.systemConfig.getSystemConfig();
  if (!config.passwordLogin.enabled) {
    throw new UnauthorizedException('Password login has been disabled');
  }

  const isSecure = c.req.url.startsWith('https');
  const clientIp = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || '0.0.0.0';
  const userAgent = c.req.header('user-agent') || '';

  const loginDetails = {
    isSecure,
    clientIp,
    deviceType: userAgent,
    deviceOS: '',
    appVersion: null,
  };

  const result = await services.auth.login(body, loginDetails);

  // Set auth cookies so the frontend knows the user is authenticated
  const maxAge = 400 * 24 * 60 * 60; // 400 days in seconds
  const cookieDefaults = {
    path: '/',
    sameSite: 'Lax' as const,
    httpOnly: true,
    secure: isSecure,
    maxAge,
  };

  setCookie(c, ImmichCookie.AccessToken, result.accessToken, cookieDefaults);
  setCookie(c, ImmichCookie.AuthType, AuthType.Password, cookieDefaults);
  setCookie(c, ImmichCookie.IsAuthenticated, 'true', {
    ...cookieDefaults,
    httpOnly: false, // must be readable by client JS
  });

  return c.json(result);
});

// POST /api/auth/logout -- Logout
app.post(
  '/logout',
  authMiddleware(),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');

    const result = await services.auth.logout(auth, 'password' as any);

    // Clear auth cookies
    deleteCookie(c, ImmichCookie.AccessToken, { path: '/' });
    deleteCookie(c, ImmichCookie.AuthType, { path: '/' });
    deleteCookie(c, ImmichCookie.IsAuthenticated, { path: '/' });

    return c.json(result);
  },
);

// POST /api/auth/change-password -- Change password
app.post(
  '/change-password',
  authMiddleware(),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const body = await c.req.json();
    const result = await services.auth.changePassword(auth, body);
    return c.json(result);
  },
);

// POST /api/auth/validateToken -- Validate auth token
app.post(
  '/validateToken',
  authMiddleware(),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const result = await services.auth.validateToken(auth);
    return c.json(result);
  },
);

// POST /api/auth/admin-sign-up -- Admin sign up (first user)
app.post('/admin-sign-up', async (c) => {
  const services = c.get('services');
  const body = await c.req.json();
  const result = await services.auth.adminSignUp(body);
  return c.json(result, 201);
});

// GET /api/auth/status -- Get auth status
app.get(
  '/status',
  authMiddleware(),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const result = await services.auth.getAuthStatus(auth);
    return c.json(result);
  },
);

// POST /api/auth/pin-code -- Set up a PIN code
app.post(
  '/pin-code',
  authMiddleware({ permission: Permission.PinCodeCreate }),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const body = await parseJson(c.req, PinCodeSetupSchema);
    await services.auth.setupPinCode(auth, body);
    return c.body(null, 204);
  },
);

// PUT /api/auth/pin-code -- Change a PIN code
app.put(
  '/pin-code',
  authMiddleware({ permission: Permission.PinCodeUpdate }),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const body = await parseJson(c.req, PinCodeChangeSchema);
    await services.auth.changePinCode(auth, body);
    return c.body(null, 204);
  },
);

// DELETE /api/auth/pin-code -- Remove a PIN code
app.delete(
  '/pin-code',
  authMiddleware({ permission: Permission.PinCodeDelete }),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const body = await parseJson(c.req, PinCodeResetSchema);
    await services.auth.resetPinCode(auth, body);
    return c.body(null, 204);
  },
);

// POST /api/auth/session/unlock -- Temporarily elevate the current session
app.post(
  '/session/unlock',
  authMiddleware(),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    const body = await parseJson(c.req, SessionUnlockSchema);
    await services.auth.unlockSession(auth, body);
    return c.body(null, 204);
  },
);

// POST /api/auth/session/lock -- Remove elevation from the current session
app.post(
  '/session/lock',
  authMiddleware(),
  async (c) => {
    const auth = c.get('auth');
    const services = c.get('services');
    await services.auth.lockSession(auth);
    return c.body(null, 204);
  },
);

export default app;
