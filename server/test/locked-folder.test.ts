import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  authRequest,
  createTestAdmin,
  request,
  setupDatabase,
  uploadTestAsset,
} from './helpers';

describe('Locked folder security', () => {
  beforeAll(async () => {
    await setupDatabase();
  });

  async function createUser(adminToken: string) {
    const email = 'user@test.com';
    const password = 'userpass123';
    const createRes = await authRequest('/api/admin/users', adminToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Test User' }),
    });
    expect(createRes.status).toBe(200);
    const user = (await createRes.json()) as any;

    const loginRes = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(loginRes.status).toBe(200);
    const { accessToken } = (await loginRes.json()) as any;
    return { id: user.id as string, token: accessToken as string };
  }

  async function setupPin(token: string, pinCode = '123456') {
    const response = await authRequest('/api/auth/pin-code', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinCode }),
    });
    expect(response.status).toBe(204);
  }

  it('should revoke shared access and require an elevated session', async () => {
    const { token } = await createTestAdmin();
    await setupPin(token);
    const assetId = await uploadTestAsset(token);
    const stackChildId = await uploadTestAsset(token, 'stack-child');
    const assetPath = 'vault/📷/';
    await env.DB.prepare('UPDATE asset SET originalPath = ? WHERE id = ?')
      .bind(`${assetPath}locked.jpg`, assetId)
      .run();

    const stackRes = await authRequest('/api/stacks', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetIds: [assetId, stackChildId] }),
    });
    expect(stackRes.status).toBe(201);
    const stack = (await stackRes.json()) as any;

    const pathsBeforeLockRes = await authRequest('/api/view/folder/unique-paths', token);
    expect(pathsBeforeLockRes.status).toBe(200);
    const pathsBeforeLock = (await pathsBeforeLockRes.json()) as string[];
    expect(pathsBeforeLock).toContain(assetPath);

    const albumRes = await authRequest('/api/albums', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ albumName: 'Private later', assetIds: [assetId] }),
    });
    expect(albumRes.status).toBe(200);
    const album = (await albumRes.json()) as any;

    const linkRes = await authRequest('/api/shared-links', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'INDIVIDUAL', assetIds: [assetId] }),
    });
    expect(linkRes.status).toBe(201);
    const link = (await linkRes.json()) as any;
    expect(link.key).toBeTypeOf('string');

    const lockAssetRes = await authRequest(`/api/assets/${assetId}`, token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'locked' }),
    });
    expect(lockAssetRes.status).toBe(200);

    const albumAfterLockRes = await authRequest(`/api/albums/${album.id}`, token);
    expect(albumAfterLockRes.status).toBe(200);
    const albumAfterLock = (await albumAfterLockRes.json()) as any;
    expect(albumAfterLock.assets).toEqual([]);
    expect(albumAfterLock.assetCount).toBe(0);

    const shareHeaders = { 'x-immich-share-key': link.key };
    const sharedLinkRes = await request('/api/shared-links/me', { headers: shareHeaders });
    expect(sharedLinkRes.status).toBe(200);
    expect(((await sharedLinkRes.json()) as any).assets).toEqual([]);

    const sharedAssetRes = await request(`/api/assets/${assetId}`, { headers: shareHeaders });
    expect(sharedAssetRes.status).toBe(400);

    const lockedAssetRes = await authRequest(`/api/assets/${assetId}`, token);
    expect(lockedAssetRes.status).toBe(400);

    const pathsAfterLockRes = await authRequest('/api/view/folder/unique-paths', token);
    expect(pathsAfterLockRes.status).toBe(200);
    expect((await pathsAfterLockRes.json()) as string[]).not.toContain(assetPath);

    const folderAfterLockRes = await authRequest(
      `/api/view/folder?path=${encodeURIComponent(assetPath)}`,
      token,
    );
    expect(folderAfterLockRes.status).toBe(200);
    expect(await folderAfterLockRes.json()).toEqual([]);

    const stackAfterLockRes = await authRequest(`/api/stacks/${stack.id}`, token);
    expect(stackAfterLockRes.status).toBe(404);
    const stacksAfterLockRes = await authRequest('/api/stacks', token);
    expect(stacksAfterLockRes.status).toBe(200);
    expect((await stacksAfterLockRes.json()) as any[]).not.toContainEqual(
      expect.objectContaining({ id: stack.id }),
    );

    const defaultSearchRes = await authRequest('/api/search/metadata', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(defaultSearchRes.status).toBe(200);
    const defaultSearchItems = ((await defaultSearchRes.json()) as any).assets.items as any[];
    expect(defaultSearchItems).toHaveLength(1);
    expect(defaultSearchItems[0].id).toBe(stackChildId);

    const lockedSearchRes = await authRequest('/api/search/metadata', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'locked' }),
    });
    expect(lockedSearchRes.status).toBe(401);

    const unlockRes = await authRequest('/api/auth/session/unlock', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinCode: '123456' }),
    });
    expect(unlockRes.status).toBe(204);

    expect((await authRequest(`/api/assets/${assetId}`, token)).status).toBe(200);
    const folderAfterUnlockRes = await authRequest(
      `/api/view/folder?path=${encodeURIComponent(assetPath)}`,
      token,
    );
    expect(folderAfterUnlockRes.status).toBe(200);
    expect((await folderAfterUnlockRes.json()) as any[]).toHaveLength(1);

    const stackAfterUnlockRes = await authRequest(`/api/stacks/${stack.id}`, token);
    expect(stackAfterUnlockRes.status).toBe(200);
    expect(((await stackAfterUnlockRes.json()) as any).assets).toHaveLength(2);
    const elevatedSearchRes = await authRequest('/api/search/metadata', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'locked' }),
    });
    expect(elevatedSearchRes.status).toBe(200);
    expect(((await elevatedSearchRes.json()) as any).assets.items).toHaveLength(1);

    expect(
      (await authRequest('/api/auth/session/lock', token, { method: 'POST' })).status,
    ).toBe(204);
    expect((await authRequest(`/api/assets/${assetId}`, token)).status).toBe(400);
  });

  it('should not grant access to a locked live-photo target through its visible parent', async () => {
    const { token } = await createTestAdmin();
    await setupPin(token);
    const parentId = await uploadTestAsset(token, 'live-parent');
    const targetId = await uploadTestAsset(token, 'live-target');

    const linkTargetRes = await authRequest(`/api/assets/${parentId}`, token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ livePhotoVideoId: targetId }),
    });
    expect(linkTargetRes.status).toBe(200);

    const albumRes = await authRequest('/api/albums', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ albumName: 'Live photo', assetIds: [parentId] }),
    });
    expect(albumRes.status).toBe(200);

    const linkRes = await authRequest('/api/shared-links', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'INDIVIDUAL', assetIds: [parentId] }),
    });
    expect(linkRes.status).toBe(201);
    const link = (await linkRes.json()) as any;

    const lockTargetRes = await authRequest(`/api/assets/${targetId}`, token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'locked' }),
    });
    expect(lockTargetRes.status).toBe(200);

    expect((await authRequest(`/api/assets/${targetId}`, token)).status).toBe(400);
    expect(
      (
        await request(`/api/assets/${targetId}`, {
          headers: { 'x-immich-share-key': link.key },
        })
      ).status,
    ).toBe(400);
  });

  it('should create and merge large stacks within D1 bind limits', async () => {
    const { token } = await createTestAdmin();
    const seedId = await uploadTestAsset(token);
    const cloneIds = Array.from({ length: 100 }, () => crypto.randomUUID());

    await env.DB.batch(
      cloneIds.map((id, index) =>
        env.DB.prepare(`
          INSERT INTO asset (
            id, ownerId, type, originalPath,
            fileCreatedAt, fileModifiedAt, checksum, localDateTime, originalFileName
          )
          SELECT ?, ownerId, type, ?, fileCreatedAt, fileModifiedAt,
                 randomblob(20), localDateTime, originalFileName
          FROM asset WHERE id = ?
        `).bind(id, `stack/${id}.jpg`, seedId),
      ),
    );

    const firstAssetIds = [seedId, ...cloneIds.slice(0, 99)];
    const firstStackRes = await authRequest('/api/stacks', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetIds: firstAssetIds }),
    });
    expect(firstStackRes.status).toBe(201);
    const firstStack = (await firstStackRes.json()) as any;
    expect(firstStack.assets).toHaveLength(100);

    const mergedStackRes = await authRequest('/api/stacks', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetIds: [seedId, cloneIds[99]] }),
    });
    expect(mergedStackRes.status).toBe(201);
    expect(((await mergedStackRes.json()) as any).assets).toHaveLength(101);
    expect((await authRequest(`/api/stacks/${firstStack.id}`, token)).status).toBe(400);
  });

  it('should not retarget asset updates or sync another user', async () => {
    const { token: adminToken, userId: adminUserId } = await createTestAdmin();
    const user = await createUser(adminToken);
    const adminAssetId = await uploadTestAsset(adminToken);
    const userAssetId = await uploadTestAsset(user.token);

    const updateRes = await authRequest(`/api/assets/${adminAssetId}`, adminToken, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: userAssetId,
        ownerId: user.id,
        isFavorite: true,
      }),
    });
    expect(updateRes.status).toBe(200);
    expect(((await updateRes.json()) as any).id).toBe(adminAssetId);

    const userAssetRes = await authRequest(`/api/assets/${userAssetId}`, user.token);
    expect(userAssetRes.status).toBe(200);
    expect(await userAssetRes.json()).toMatchObject({
      id: userAssetId,
      ownerId: user.id,
      isFavorite: false,
    });

    const fullSyncRes = await authRequest('/api/sync/full-sync', adminToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: user.id,
        updatedUntil: new Date().toISOString(),
        limit: 100,
      }),
    });
    expect(fullSyncRes.status).toBe(404);

    const deltaSyncRes = await authRequest('/api/sync/delta-sync', adminToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userIds: [adminUserId, user.id],
        updatedAfter: new Date().toISOString(),
      }),
    });
    expect(deltaSyncRes.status).toBe(404);
  });

  it('should not expose password or PIN hashes in user-bearing responses', async () => {
    const { token: adminToken } = await createTestAdmin();
    await setupPin(adminToken);
    const user = await createUser(adminToken);

    const adminUsersRes = await authRequest('/api/admin/users', adminToken);
    expect(adminUsersRes.status).toBe(200);
    for (const item of (await adminUsersRes.json()) as any[]) {
      expect(item).not.toHaveProperty('password');
      expect(item).not.toHaveProperty('pinCode');
    }

    const partnerRes = await authRequest('/api/partners', adminToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharedWithId: user.id }),
    });
    expect(partnerRes.status).toBe(201);
    const partner = (await partnerRes.json()) as any;
    expect(partner).not.toHaveProperty('password');
    expect(partner).not.toHaveProperty('pinCode');

    const albumRes = await authRequest('/api/albums', adminToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        albumName: 'Shared album',
        albumUsers: [{ userId: user.id, role: 'viewer' }],
      }),
    });
    expect(albumRes.status).toBe(200);
    const album = (await albumRes.json()) as any;
    expect(album).not.toHaveProperty('owner');
    expect(album.albumUsers[0]).toMatchObject({ role: 'owner' });
    expect(album.albumUsers[0].user).not.toHaveProperty('password');
    expect(album.albumUsers[0].user).not.toHaveProperty('pinCode');

    const activityRes = await authRequest('/api/activities', adminToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ albumId: album.id, type: 'comment', comment: 'Safe response' }),
    });
    expect(activityRes.status).toBe(201);
    const activity = (await activityRes.json()) as any;
    expect(activity.user).not.toHaveProperty('password');
    expect(activity.user).not.toHaveProperty('pinCode');

    const linkRes = await authRequest('/api/shared-links', adminToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ALBUM', albumId: album.id }),
    });
    expect(linkRes.status).toBe(201);
    const link = (await linkRes.json()) as any;
    const getLinkRes = await authRequest(`/api/shared-links/${link.id}`, adminToken);
    expect(getLinkRes.status).toBe(200);
    const linkedAlbumOwner = ((await getLinkRes.json()) as any).album.albumUsers[0].user;
    expect(linkedAlbumOwner).not.toHaveProperty('password');
    expect(linkedAlbumOwner).not.toHaveProperty('pinCode');
  });
});
