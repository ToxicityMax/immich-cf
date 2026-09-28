import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { authRequest, createTestAdmin, createTestImage, request, setupDatabase, uploadTestAsset } from './helpers';

describe('Shared links', () => {
  let token: string;
  let assetId: string;
  let secondAssetId: string;

  beforeAll(async () => {
    await setupDatabase();
    ({ token } = await createTestAdmin());
    assetId = await uploadTestAsset(token, `shared-${crypto.randomUUID()}`);
    secondAssetId = await uploadTestAsset(token, `shared-${crypto.randomUUID()}`);
  });

  const createLink = async (body: Record<string, unknown>) => {
    const response = await authRequest('/api/shared-links', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { response, body: await response.json() as any };
  };

  it('creates links with v3 statuses and validates the DTO contract', async () => {
    const created = await createLink({ type: 'INDIVIDUAL', assetIds: [assetId], slug: 'validated-link' });
    expect(created.response.status).toBe(201);
    expect(created.body).toMatchObject({ type: 'INDIVIDUAL', slug: 'validated-link' });

    const missingAlbum = await createLink({ type: 'ALBUM' });
    expect(missingAlbum.response.status).toBe(400);
    expect(missingAlbum.body.message).toBe('albumId is required for type ALBUM');

    const mixedTypes = await createLink({ type: 'INDIVIDUAL', assetIds: [assetId], albumId: crypto.randomUUID() });
    expect(mixedTypes.response.status).toBe(400);

    const stringBoolean = await createLink({ type: 'INDIVIDUAL', assetIds: [assetId], allowDownload: 'false' });
    expect(stringBoolean.response.status).toBe(400);

    const malformedId = await authRequest('/api/shared-links/not-a-uuid', token);
    expect(malformedId.status).toBe(400);

    const duplicateSlug = await createLink({ type: 'INDIVIDUAL', assetIds: [secondAssetId], slug: 'validated-link' });
    expect(duplicateSlug.response.status).toBe(400);
    expect(duplicateSlug.body.message).toBe('Failed to save shared link');

    const removed = await authRequest(`/api/shared-links/${created.body.id}`, token, { method: 'DELETE' });
    expect(removed.status).toBe(204);
  });

  it('logs into password links using a merged one-day HttpOnly cookie', async () => {
    const first = await createLink({ type: 'INDIVIDUAL', assetIds: [assetId], password: 'first-password' });
    const second = await createLink({ type: 'INDIVIDUAL', assetIds: [secondAssetId], password: 'second-password' });
    const unprotected = await createLink({ type: 'INDIVIDUAL', assetIds: [assetId] });

    const missingCookie = await request(`/api/shared-links/me?key=${first.body.key}`);
    expect(missingCookie.status).toBe(401);
    expect((await missingCookie.json() as any).message).toBe('Password required');

    const queryBypass = await request(`/api/shared-links/me?key=${first.body.key}&password=first-password`);
    expect(queryBypass.status).toBe(401);
    expect(await queryBypass.json()).toEqual({ message: 'Password required', statusCode: 401 });

    const invalidCookie = await request(`/api/shared-links/me?key=${first.body.key}`, {
      headers: { Cookie: 'immich_shared_link_token=invalid' },
    });
    expect(invalidCookie.status).toBe(401);
    expect(await invalidCookie.json()).toEqual({ message: 'Invalid password', statusCode: 401 });

    const wrongPassword = await request(`/api/shared-links/login?key=${first.body.key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    expect(wrongPassword.status).toBe(401);
    expect((await wrongPassword.json() as any).message).toBe('Invalid password');

    const unprotectedLogin = await request(`/api/shared-links/login?key=${unprotected.body.key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'unused' }),
    });
    expect(unprotectedLogin.status).toBe(400);
    expect((await unprotectedLogin.json() as any).message).toBe('Shared link is not password protected');

    const firstLogin = await request(`https://localhost/api/shared-links/login?key=${first.body.key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'first-password' }),
    });
    expect(firstLogin.status).toBe(201);
    const firstBody = await firstLogin.json() as any;
    expect(firstBody).not.toHaveProperty('token');
    expect(firstBody.password).toBe('first-password');
    expect(firstBody.key).toBe(first.body.key);

    const firstSetCookie = firstLogin.headers.get('set-cookie') || '';
    expect(firstSetCookie).toContain('immich_shared_link_token=');
    expect(firstSetCookie.toLowerCase()).toContain('httponly');
    expect(firstSetCookie.toLowerCase()).toContain('samesite=lax');
    expect(firstSetCookie.toLowerCase()).toContain('max-age=86400');
    expect(firstSetCookie.toLowerCase()).toContain('secure');
    const firstCookie = firstSetCookie.split(';')[0];

    const secondLogin = await request(`/api/shared-links/login?key=${second.body.key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: firstCookie },
      body: JSON.stringify({ password: 'second-password' }),
    });
    expect(secondLogin.status).toBe(201);
    const mergedCookie = (secondLogin.headers.get('set-cookie') || '').split(';')[0];

    const firstAgain = await request(`/api/shared-links/me?key=${first.body.key}`, {
      headers: { Cookie: mergedCookie },
    });
    expect(firstAgain.status).toBe(200);
    expect(await firstAgain.json()).not.toHaveProperty('token');
  });

  it('requires the password cookie for every shared-link resource route', async () => {
    await env.DB.prepare("UPDATE asset SET type = 'VIDEO' WHERE id = ?").bind(assetId).run();
    const link = await createLink({
      type: 'INDIVIDUAL',
      assetIds: [assetId],
      password: 'resource-password',
      allowDownload: true,
    });
    const resources = [
      { path: `/api/assets/${assetId}?key=${link.body.key}` },
      { path: `/api/assets/${assetId}/original?key=${link.body.key}` },
      { path: `/api/assets/${assetId}/thumbnail?key=${link.body.key}` },
      { path: `/api/assets/${assetId}/video/playback?key=${link.body.key}` },
      {
        path: `/api/download/info?key=${link.body.key}`,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assetIds: [assetId] }),
        },
      },
      {
        path: `/api/download/archive?key=${link.body.key}`,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assetIds: [assetId] }),
        },
      },
    ];

    for (const resource of resources) {
      const missing = await request(resource.path, resource.init);
      expect(missing.status, resource.path).toBe(401);
      expect(await missing.json(), resource.path).toEqual({ message: 'Password required', statusCode: 401 });

      const headers = new Headers(resource.init?.headers);
      headers.set('Cookie', 'immich_shared_link_token=invalid');
      const invalid = await request(resource.path, { ...resource.init, headers });
      expect(invalid.status, resource.path).toBe(401);
      expect(await invalid.json(), resource.path).toEqual({ message: 'Invalid password', statusCode: 401 });
    }

    const login = await request(`/api/shared-links/login?key=${link.body.key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'resource-password' }),
    });
    expect(login.status).toBe(201);
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

    for (const resource of resources) {
      const headers = new Headers(resource.init?.headers);
      headers.set('Cookie', cookie);
      const response = await request(resource.path, { ...resource.init, headers });
      expect(response.status, resource.path).toBe(200);
      await response.arrayBuffer();
    }
  });

  it('protects shared-link uploads and album reads and mutations by key or slug', async () => {
    const albumResponse = await authRequest('/api/albums', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ albumName: 'Protected album', assetIds: [assetId] }),
    });
    expect(albumResponse.status).toBe(200);
    const album = await albumResponse.json() as any;
    const link = await createLink({
      type: 'ALBUM',
      albumId: album.id,
      password: 'album-password',
      slug: `protected-${crypto.randomUUID()}`,
      allowUpload: true,
    });
    expect(link.response.status).toBe(201);

    const assertPasswordError = async (path: string, init: RequestInit | undefined, cookie: string | undefined, message: string) => {
      const headers = new Headers(init?.headers);
      if (cookie) {
        headers.set('Cookie', cookie);
      }
      const response = await request(path, { ...init, headers });
      expect(response.status, path).toBe(401);
      expect(await response.json(), path).toEqual({ message, statusCode: 401 });
    };
    const uploadBody = () => {
      const formData = new FormData();
      formData.append('assetData', new File([createTestImage()], `${crypto.randomUUID()}.jpg`, { type: 'image/jpeg' }));
      formData.append('fileCreatedAt', new Date().toISOString());
      formData.append('fileModifiedAt', new Date().toISOString());
      return formData;
    };
    const routes = [
      { path: `/api/albums/${album.id}?key=${link.body.key}` },
      {
        path: `/api/albums/${album.id}/assets?key=${link.body.key}`,
        init: { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [secondAssetId] }) },
      },
      {
        path: `/api/albums/assets?slug=${link.body.slug}`,
        init: {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ albumIds: [album.id], assetIds: [secondAssetId] }),
        },
      },
    ];

    for (const route of routes) {
      await assertPasswordError(route.path, route.init, undefined, 'Password required');
      await assertPasswordError(route.path, route.init, 'immich_shared_link_token=invalid', 'Invalid password');
    }
    await assertPasswordError(
      `/api/assets?slug=${link.body.slug}`,
      { method: 'POST', body: uploadBody() },
      undefined,
      'Password required',
    );
    await assertPasswordError(
      `/api/assets?slug=${link.body.slug}`,
      { method: 'POST', body: uploadBody() },
      'immich_shared_link_token=invalid',
      'Invalid password',
    );

    const unchanged = await authRequest(`/api/albums/${album.id}`, token);
    expect((await unchanged.json() as any).assets.map(({ id }: { id: string }) => id)).not.toContain(secondAssetId);

    const login = await request(`/api/shared-links/login?slug=${link.body.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'album-password' }),
    });
    expect(login.status).toBe(201);
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

    const albumRead = await request(`/api/albums/${album.id}?key=${link.body.key}`, { headers: { Cookie: cookie } });
    expect(albumRead.status).toBe(200);

    const upload = await request(`/api/assets?slug=${link.body.slug}`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: uploadBody(),
    });
    expect(upload.status).toBe(201);
    const uploadedAssetId = (await upload.json() as any).id;

    const addOne = await request(`/api/albums/${album.id}/assets?key=${link.body.key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ ids: [secondAssetId] }),
    });
    expect(addOne.status).toBe(200);

    const addMany = await request(`/api/albums/assets?slug=${link.body.slug}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ albumIds: [album.id], assetIds: [uploadedAssetId] }),
    });
    expect(addMany.status).toBe(200);

    const updated = await authRequest(`/api/albums/${album.id}`, token);
    const assetIds = (await updated.json() as any).assets.map(({ id }: { id: string }) => id);
    expect(assetIds).toEqual(expect.arrayContaining([assetId, secondAssetId, uploadedAssetId]));
  });

  it('does not let public-link credentials mutate link membership', async () => {
    const link = await createLink({ type: 'INDIVIDUAL', assetIds: [assetId] });

    const publicMutation = await request(`/api/shared-links/${link.body.id}/assets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-immich-share-key': link.body.key },
      body: JSON.stringify({ assetIds: [secondAssetId] }),
    });
    expect(publicMutation.status).toBe(403);

    const largeMembership = Array.from({ length: 101 }, () => secondAssetId);
    const ownerMutation = await authRequest(`/api/shared-links/${link.body.id}/assets`, token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetIds: largeMembership }),
    });
    expect(ownerMutation.status).toBe(200);
    const mutationResult = await ownerMutation.json() as any[];
    expect(mutationResult).toHaveLength(101);
    expect(mutationResult.every(({ success }) => success)).toBe(true);

    const updated = await authRequest(`/api/shared-links/${link.body.id}`, token);
    expect(updated.status).toBe(200);
    expect((await updated.json() as any).assets.filter(({ id }: { id: string }) => id === secondAssetId)).toHaveLength(1);
  });
});
