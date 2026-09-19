import { SERVER_VERSION_RESPONSE } from 'src/constants';
import type { RealtimeDisconnectRequest, RealtimePublishRequest } from 'src/services/realtime.service';

const PING_INTERVAL = 25_000;
const PING_TIMEOUT = 20_000;
const MAX_PAYLOAD = 1_000_000;

const USER_ID_HEADER = 'x-workers-immich-user-id';
const SESSION_ID_HEADER = 'x-workers-immich-session-id';
const SESSION_EXPIRES_AT_HEADER = 'x-workers-immich-session-expires-at';
const API_KEY_ID_HEADER = 'x-workers-immich-api-key-id';

interface SocketAttachment {
  engineId: string;
  socketId: string;
  connected: boolean;
  connectedAt: number;
  sessionExpiresAt: number | null;
  awaitingPong: boolean;
  lastPingAt: number;
}

function createSocketId(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

function encodeEvent(event: string, args: unknown[]): string {
  return `42${JSON.stringify([event, ...args])}`;
}

function getAttachment(socket: WebSocket): SocketAttachment | undefined {
  return socket.deserializeAttachment() as SocketAttachment | undefined;
}

export class RealtimeHub {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/publish' && request.method === 'POST') {
      return this.publish(request);
    }

    if (url.pathname === '/disconnect' && request.method === 'POST') {
      return this.disconnect(request);
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }

    return this.connect(request);
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const size = typeof message === 'string' ? new TextEncoder().encode(message).byteLength : message.byteLength;
    if (size > MAX_PAYLOAD) {
      socket.close(1009, 'Message too large');
      return;
    }

    if (typeof message !== 'string') {
      socket.close(1003, 'Binary messages are not supported');
      return;
    }

    const attachment = getAttachment(socket);
    if (!attachment) {
      socket.close(1011, 'Missing connection state');
      return;
    }

    if (message === '1' || message === '41') {
      socket.close(1000, 'Client disconnect');
      return;
    }

    if (message.startsWith('3')) {
      attachment.awaitingPong = false;
      attachment.lastPingAt = Date.now();
      socket.serializeAttachment(attachment);
      await this.scheduleAlarm(attachment.lastPingAt + PING_INTERVAL);
      return;
    }

    // Older clients occasionally initiate an Engine.IO ping themselves.
    if (message.startsWith('2')) {
      socket.send(`3${message.slice(1)}`);
      return;
    }

    if (!message.startsWith('40')) {
      return;
    }

    const namespace = message.slice(2);
    if (namespace.startsWith('/') && namespace !== '/' && !namespace.startsWith('/,')) {
      socket.send(`44${JSON.stringify({ message: 'Invalid namespace' })}`);
      return;
    }

    if (attachment.connected) {
      return;
    }

    attachment.connected = true;
    socket.serializeAttachment(attachment);
    socket.send(`40${JSON.stringify({ sid: attachment.socketId })}`);
    socket.send(encodeEvent('on_server_version', [SERVER_VERSION_RESPONSE]));
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    try {
      socket.close(code, reason);
    } catch {
      // The peer may have already completed the close handshake.
    }

    if (this.state.getWebSockets().every((item) => item.readyState !== WebSocket.OPEN)) {
      await this.state.storage.deleteAlarm();
    }
  }

  webSocketError(_socket: WebSocket, error: unknown): void {
    console.error('Realtime WebSocket error:', error);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let nextAlarm: number | undefined;

    for (const socket of this.state.getWebSockets()) {
      const attachment = getAttachment(socket);
      if (!attachment) {
        socket.close(1011, 'Missing connection state');
        continue;
      }

      if (attachment.sessionExpiresAt !== null) {
        if (now >= attachment.sessionExpiresAt) {
          socket.close(4003, 'Session expired');
          continue;
        }
        nextAlarm = Math.min(nextAlarm ?? attachment.sessionExpiresAt, attachment.sessionExpiresAt);
      }

      if (!attachment.connected) {
        const connectTimeoutAt = attachment.connectedAt + PING_TIMEOUT;
        if (now >= connectTimeoutAt) {
          socket.close(4002, 'Socket.IO connect timeout');
          continue;
        }
        nextAlarm = Math.min(nextAlarm ?? connectTimeoutAt, connectTimeoutAt);
        continue;
      }

      if (attachment.awaitingPong) {
        const timeoutAt = attachment.lastPingAt + PING_TIMEOUT;
        if (now >= timeoutAt) {
          socket.close(4001, 'Ping timeout');
          continue;
        }
        nextAlarm = Math.min(nextAlarm ?? timeoutAt, timeoutAt);
        continue;
      }

      const pingAt = attachment.lastPingAt + PING_INTERVAL;
      if (now >= pingAt) {
        try {
          socket.send('2');
          attachment.awaitingPong = true;
          attachment.lastPingAt = now;
          socket.serializeAttachment(attachment);
          const timeoutAt = now + PING_TIMEOUT;
          nextAlarm = Math.min(nextAlarm ?? timeoutAt, timeoutAt);
        } catch {
          socket.close(1011, 'Ping failed');
        }
      } else {
        nextAlarm = Math.min(nextAlarm ?? pingAt, pingAt);
      }
    }

    if (nextAlarm === undefined) {
      await this.state.storage.deleteAlarm();
    } else {
      await this.state.storage.setAlarm(Math.max(Date.now() + 1, nextAlarm));
    }
  }

  private async connect(request: Request): Promise<Response> {
    const userId = request.headers.get(USER_ID_HEADER);
    if (!userId) {
      return new Response('Authentication required', { status: 401 });
    }

    const sessionId = request.headers.get(SESSION_ID_HEADER);
    const sessionExpiresAtValue = request.headers.get(SESSION_EXPIRES_AT_HEADER);
    const parsedSessionExpiresAt = sessionExpiresAtValue ? Date.parse(sessionExpiresAtValue) : Number.NaN;
    const apiKeyId = request.headers.get(API_KEY_ID_HEADER);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const now = Date.now();
    const attachment: SocketAttachment = {
      engineId: createSocketId(),
      socketId: createSocketId(),
      connected: false,
      connectedAt: now,
      sessionExpiresAt: Number.isFinite(parsedSessionExpiresAt) ? parsedSessionExpiresAt : null,
      awaitingPong: false,
      lastPingAt: now,
    };
    const tags = [`user:${userId}`];
    if (sessionId) {
      tags.push(`session:${sessionId}`);
    }
    if (apiKeyId) {
      tags.push(`api-key:${apiKeyId}`);
    }

    this.state.acceptWebSocket(server, tags);
    server.serializeAttachment(attachment);
    server.send(
      `0${JSON.stringify({
        sid: attachment.engineId,
        upgrades: [],
        pingInterval: PING_INTERVAL,
        pingTimeout: PING_TIMEOUT,
        maxPayload: MAX_PAYLOAD,
      })}`,
    );
    await this.scheduleAlarm(Math.min(now + PING_TIMEOUT, attachment.sessionExpiresAt ?? Number.POSITIVE_INFINITY));

    return new Response(null, { status: 101, webSocket: client });
  }

  private async publish(request: Request): Promise<Response> {
    let message: RealtimePublishRequest;
    try {
      message = (await request.json()) as RealtimePublishRequest;
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    if (
      !message ||
      typeof message.event !== 'string' ||
      !Array.isArray(message.args) ||
      (message.rooms !== undefined && !Array.isArray(message.rooms))
    ) {
      return new Response('Invalid realtime event', { status: 400 });
    }

    const sockets = new Set<WebSocket>();
    if (message.rooms === undefined) {
      for (const socket of this.state.getWebSockets()) {
        sockets.add(socket);
      }
    } else {
      for (const room of message.rooms) {
        if (typeof room !== 'string') {
          return new Response('Invalid realtime room', { status: 400 });
        }
        for (const socket of this.state.getWebSockets(room)) {
          sockets.add(socket);
        }
      }
    }

    const packet = encodeEvent(message.event, message.args);
    for (const socket of sockets) {
      if (getAttachment(socket)?.connected) {
        try {
          socket.send(packet);
        } catch {
          socket.close(1011, 'Event delivery failed');
        }
      }
    }

    return Response.json({ delivered: sockets.size });
  }

  private async disconnect(request: Request): Promise<Response> {
    let message: RealtimeDisconnectRequest;
    try {
      message = (await request.json()) as RealtimeDisconnectRequest;
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    if (!message || !Array.isArray(message.rooms) || message.rooms.some((room) => typeof room !== 'string')) {
      return new Response('Invalid realtime rooms', { status: 400 });
    }

    const sockets = new Set<WebSocket>();
    for (const room of message.rooms) {
      for (const socket of this.state.getWebSockets(room)) {
        sockets.add(socket);
      }
    }

    for (const socket of sockets) {
      try {
        socket.close(4003, 'Credentials revoked');
      } catch {
        // The connection may already be closing.
      }
    }

    return Response.json({ disconnected: sockets.size });
  }

  private async scheduleAlarm(timestamp: number): Promise<void> {
    const currentAlarm = await this.state.storage.getAlarm();
    if (currentAlarm === null || currentAlarm > timestamp) {
      await this.state.storage.setAlarm(timestamp);
    }
  }
}

export const RealtimeHeaders = {
  UserId: USER_ID_HEADER,
  SessionId: SESSION_ID_HEADER,
  SessionExpiresAt: SESSION_EXPIRES_AT_HEADER,
  ApiKeyId: API_KEY_ID_HEADER,
} as const;
