import type { AuthDto } from 'src/dtos/auth.dto';
import type { Env } from 'src/env';
import { ImmichHeader, ImmichQuery } from 'src/enum';
import { RealtimeHeaders } from 'src/realtime';

export async function handleSocketIO(request: Request, env: Env, auth: AuthDto): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.get('EIO') !== '4') {
    return Response.json({ code: 5, message: 'Unsupported protocol version' }, { status: 400 });
  }

  if (
    url.searchParams.get('transport') !== 'websocket' ||
    request.headers.get('Upgrade')?.toLowerCase() !== 'websocket'
  ) {
    return Response.json({ code: 0, message: 'Transport unknown' }, { status: 400 });
  }

  const origin = request.headers.get('Origin');
  if (origin) {
    try {
      if (new URL(origin).origin !== url.origin) {
        return new Response('Forbidden origin', { status: 403 });
      }
    } catch {
      return new Response('Forbidden origin', { status: 403 });
    }
  }

  const headers = new Headers(request.headers);
  headers.delete('authorization');
  headers.delete('cookie');
  headers.delete(ImmichHeader.UserToken);
  headers.delete(ImmichHeader.SessionToken);
  headers.delete(ImmichHeader.ApiKey);
  headers.delete(ImmichHeader.SharedLinkKey);
  headers.delete(ImmichHeader.SharedLinkSlug);
  headers.set(RealtimeHeaders.UserId, auth.user.id);
  if (auth.session) {
    headers.set(RealtimeHeaders.SessionId, auth.session.id);
    if (auth.session.expiresAt) {
      headers.set(RealtimeHeaders.SessionExpiresAt, auth.session.expiresAt);
    } else {
      headers.delete(RealtimeHeaders.SessionExpiresAt);
    }
  } else {
    headers.delete(RealtimeHeaders.SessionId);
    headers.delete(RealtimeHeaders.SessionExpiresAt);
  }
  if (auth.apiKey) {
    headers.set(RealtimeHeaders.ApiKeyId, auth.apiKey.id);
  } else {
    headers.delete(RealtimeHeaders.ApiKeyId);
  }

  for (const parameter of Object.values(ImmichQuery)) {
    url.searchParams.delete(parameter);
  }

  const hub = env.REALTIME.get(env.REALTIME.idFromName('immich'));
  return hub.fetch(new Request(url, { method: request.method, headers }));
}
