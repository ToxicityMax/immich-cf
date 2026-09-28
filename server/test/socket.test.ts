import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { authRequest, createTestAdmin, createTestImage, request, setupDatabase } from './helpers';

const SOCKET_PATH = '/api/socket.io/?EIO=4&transport=websocket';

type SocketEvent = { name: string; args: unknown[] };
const openSockets = new Set<TestSocket>();

class TestSocket {
  private messages: string[] = [];
  private waiters: Array<(message: string) => void> = [];
  private closed = false;

  constructor(private socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        return;
      }

      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(event.data);
      } else {
        this.messages.push(event.data);
      }
    });
    socket.addEventListener('close', () => {
      this.closed = true;
      openSockets.delete(this);
    });
    socket.accept();
    openSockets.add(this);
  }

  send(message: string): void {
    this.socket.send(message);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.socket.close(1000, 'Test complete');
        } catch {
          // The server may have completed the close handshake first.
        }
        openSockets.delete(this);
        resolve();
      }, 500);

      this.socket.addEventListener(
        'close',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );

      try {
        this.socket.send('41');
      } catch {
        this.socket.close(1000, 'Test complete');
      }
    });
  }

  async waitForClose(timeout = 2_000): Promise<void> {
    if (this.closed) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for WebSocket close')), timeout);
      this.socket.addEventListener(
        'close',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  async nextMessage(timeout = 2_000): Promise<string> {
    const message = this.messages.shift();
    if (message !== undefined) {
      return message;
    }

    return new Promise((resolve, reject) => {
      let waiter: (message: string) => void;
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new Error('Timed out waiting for WebSocket message'));
      }, timeout);

      waiter = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.waiters.push(waiter);
    });
  }

  async nextEvent(name: string, timeout = 2_000): Promise<SocketEvent> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const packet = await this.nextMessage(deadline - Date.now());
      if (packet === '2') {
        this.send('3');
        continue;
      }
      if (!packet.startsWith('42')) {
        continue;
      }

      const [eventName, ...args] = JSON.parse(packet.slice(2)) as [string, ...unknown[]];
      if (eventName === name) {
        return { name: eventName, args };
      }
    }

    throw new Error(`Timed out waiting for event ${name}`);
  }

  async hasEvent(name: string, timeout = 100): Promise<boolean> {
    try {
      await this.nextEvent(name, timeout);
      return true;
    } catch {
      return false;
    }
  }
}

async function connect(headers: HeadersInit, path = SOCKET_PATH): Promise<TestSocket> {
  const response = await request(path, {
    headers: {
      ...Object.fromEntries(new Headers(headers)),
      Upgrade: 'websocket',
    },
  });
  if (response.status !== 101) {
    throw new Error(`WebSocket upgrade failed (${response.status}): ${await response.text()}`);
  }
  expect(response.webSocket).not.toBeNull();
  return new TestSocket(response.webSocket!);
}

async function completeHandshake(socket: TestSocket): Promise<void> {
  const openPacket = await socket.nextMessage();
  expect(openPacket.startsWith('0')).toBe(true);
  expect(JSON.parse(openPacket.slice(1))).toMatchObject({
    upgrades: [],
    pingInterval: 25_000,
    pingTimeout: 20_000,
    maxPayload: 1_000_000,
  });

  socket.send('40');
  const connectPacket = await socket.nextMessage();
  expect(connectPacket.startsWith('40')).toBe(true);
  expect(JSON.parse(connectPacket.slice(2))).toHaveProperty('sid');

  const versionEvent = await socket.nextEvent('on_server_version');
  expect(versionEvent.args).toEqual([{ major: 3, minor: 2, patch: 2, prerelease: null }]);
}

async function createUserAndLogin(adminToken: string): Promise<{ token: string; userId: string }> {
  const createResponse = await authRequest('/api/admin/users', adminToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'user@test.com',
      password: 'password123',
      name: 'Test User',
    }),
  });
  expect(createResponse.status).toBe(200);
  const user = (await createResponse.json()) as { id: string };

  const loginResponse = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'user@test.com', password: 'password123' }),
  });
  expect(loginResponse.status).toBe(200);
  const login = (await loginResponse.json()) as { accessToken: string };
  return { token: login.accessToken, userId: user.id };
}

describe('Socket.IO realtime compatibility', () => {
  let admin: { token: string; userId: string };

  beforeAll(async () => {
    await setupDatabase();
    admin = await createTestAdmin();
  });

  afterEach(async () => {
    await Promise.all([...openSockets].map((socket) => socket.close()));
  });

  it('requires authentication and the WebSocket transport', async () => {
    const unauthorized = await request(SOCKET_PATH, { headers: { Upgrade: 'websocket' } });
    expect(unauthorized.status, await unauthorized.clone().text()).toBe(401);

    const polling = await authRequest('/api/socket.io/?EIO=4&transport=polling', admin.token);
    expect(polling.status).toBe(400);
    expect(await polling.json()).toEqual({ code: 0, message: 'Transport unknown' });

    const crossOrigin = await authRequest(SOCKET_PATH, admin.token, {
      headers: { Upgrade: 'websocket', Origin: 'https://example.com' },
    });
    expect(crossOrigin.status).toBe(403);
  });

  it('accepts the browser cookie and completes an Engine.IO 4 handshake', async () => {
    const socket = await connect({
      Cookie: `immich_access_token=${admin.token}`,
      Origin: 'http://localhost',
    });
    await completeHandshake(socket);

    socket.send('2probe');
    expect(await socket.nextMessage()).toBe('3probe');
    await socket.close();
  });

  it('delivers upload and asset lifecycle events only to the owning user', async () => {
    const otherUser = await createUserAndLogin(admin.token);
    const ownerSocket = await connect({ Authorization: `Bearer ${admin.token}` });
    const otherSocket = await connect({ Authorization: `Bearer ${otherUser.token}` });
    await completeHandshake(ownerSocket);
    await completeHandshake(otherSocket);

    const image = createTestImage();
    const formData = new FormData();
    formData.append('assetData', new File([image], 'socket-upload.jpg', { type: 'image/jpeg' }));
    formData.append('fileCreatedAt', '2026-01-02T03:04:05.000Z');
    formData.append('fileModifiedAt', '2026-01-02T03:04:05.000Z');

    const uploadResponse = await authRequest('/api/assets', admin.token, { method: 'POST', body: formData });
    expect(uploadResponse.status).toBe(201);
    const upload = (await uploadResponse.json()) as { id: string };

    const legacyUpload = await ownerSocket.nextEvent('on_upload_success');
    expect(legacyUpload.args[0]).toMatchObject({ id: upload.id, ownerId: admin.userId });
    expect(typeof (legacyUpload.args[0] as { isEdited: unknown }).isEdited).toBe('boolean');

    const syncUpload = await ownerSocket.nextEvent('AssetUploadReadyV2');
    expect(syncUpload.args[0]).toMatchObject({
      asset: {
        id: upload.id,
        ownerId: admin.userId,
        originalFileName: 'socket-upload.jpg',
        fileCreatedAt: '2026-01-02T03:04:05.000Z',
        createdAt: expect.any(String),
        duration: null,
      },
      exif: { assetId: upload.id },
    });
    expect(await ownerSocket.hasEvent('AssetUploadReadyV1')).toBe(false);
    expect(await otherSocket.hasEvent('on_upload_success')).toBe(false);

    const albumResponse = await authRequest('/api/albums', admin.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        albumName: 'Realtime album',
        albumUsers: [{ userId: otherUser.userId, role: 'viewer' }],
      }),
    });
    expect(albumResponse.status).toBe(200);
    const album = (await albumResponse.json()) as { id: string };
    const addResponse = await authRequest(`/api/albums/${album.id}/assets`, admin.token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [upload.id] }),
    });
    expect(addResponse.status).toBe(200);
    expect((await ownerSocket.nextEvent('on_album_update')).args).toEqual([album.id]);
    expect((await otherSocket.nextEvent('on_album_update')).args).toEqual([album.id]);

    const updateResponse = await authRequest(`/api/assets/${upload.id}`, admin.token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isFavorite: true }),
    });
    expect(updateResponse.status).toBe(200);
    const updateEvent = await ownerSocket.nextEvent('on_asset_update');
    expect(updateEvent.args[0]).toMatchObject({ id: upload.id, isFavorite: true });

    const trashResponse = await authRequest('/api/assets', admin.token, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [upload.id] }),
    });
    expect(trashResponse.status).toBe(204);
    expect((await ownerSocket.nextEvent('on_asset_trash')).args).toEqual([[upload.id]]);

    const restoreResponse = await authRequest('/api/trash/restore/assets', admin.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [upload.id] }),
    });
    expect(restoreResponse.status).toBe(200);
    expect((await ownerSocket.nextEvent('on_asset_restore')).args).toEqual([[upload.id]]);

    await ownerSocket.close();
    await otherSocket.close();
  });

  it('targets a revoked session without notifying the current session', async () => {
    const currentSocket = await connect({ Authorization: `Bearer ${admin.token}` });
    await completeHandshake(currentSocket);

    const createResponse = await authRequest('/api/sessions', admin.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceType: 'mobile', deviceOS: 'test' }),
    });
    expect(createResponse.status).toBe(201);
    const session = (await createResponse.json()) as { id: string; token: string };
    const revokedSocket = await connect({ 'x-immich-user-token': session.token });
    await completeHandshake(revokedSocket);

    const deleteResponse = await authRequest(`/api/sessions/${session.id}`, admin.token, { method: 'DELETE' });
    expect(deleteResponse.status).toBe(204);
    expect((await revokedSocket.nextEvent('on_session_delete')).args).toEqual([session.id]);
    await revokedSocket.waitForClose();
    expect(await currentSocket.hasEvent('on_session_delete')).toBe(false);

    await currentSocket.close();
    await revokedSocket.close();
  });
});
