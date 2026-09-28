import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateUUIDv7 } from '../src/utils/uuid';
import { authRequest, createTestAdmin, request, setupDatabase, uploadTestAsset } from './helpers';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const waitForSnapshot = () => new Promise((resolve) => setTimeout(resolve, 25));

async function getSyncItems(token: string, types: string[], reset = false) {
  await waitForSnapshot();
  const response = await authRequest('/api/sync/stream', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ types, ...(reset ? { reset: true } : {}) }),
  });
  expect(response.status).toBe(200);
  return (await response.text()).trimEnd().split('\n').map((line) => JSON.parse(line));
}

async function createUser(adminToken: string) {
  const email = `sync-${crypto.randomUUID()}@test.com`;
  const password = 'password123';
  const createResponse = await authRequest('/api/admin/users', adminToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'Sync User' }),
  });
  expect(createResponse.status).toBe(200);
  const user = (await createResponse.json()) as { id: string };
  const loginResponse = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(loginResponse.status).toBe(200);
  const login = (await loginResponse.json()) as { accessToken: string };
  return { userId: user.id, token: login.accessToken };
}

async function setSyncAcks(token: string, acks: string[]) {
  const response = await authRequest('/api/sync/ack', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ acks }),
  });
  expect(response.status).toBe(204);
}

async function createAssetDerivedRows(token: string, userId: string, assetId: string) {
  const stackChildId = await uploadTestAsset(token, `stack-child-${assetId}`);
  const stackResponse = await authRequest('/api/stacks', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetIds: [assetId, stackChildId] }),
  });
  expect(stackResponse.status).toBe(201);
  const stack = (await stackResponse.json()) as { id: string };
  const memoryId = crypto.randomUUID();
  const editId = crypto.randomUUID();
  const now = new Date().toISOString();
  const updateId = generateUUIDv7(Date.now() - 100);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO memory (id, ownerId, type, data, memoryAt) VALUES (?, ?, ?, ?, ?)')
      .bind(memoryId, userId, 'on_this_day', '{}', now),
    env.DB.prepare('INSERT INTO memory_asset (memoriesId, assetId, updateId) VALUES (?, ?, ?)')
      .bind(memoryId, assetId, updateId),
    env.DB.prepare('INSERT INTO asset_metadata (assetId, key, value, updateId) VALUES (?, ?, ?, ?)')
      .bind(assetId, 'mobile-app', JSON.stringify({ iCloudId: 'locked-secret' }), updateId),
    env.DB.prepare('INSERT INTO asset_edit (id, assetId, action, parameters, sequence, updateId) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(editId, assetId, 'rotate', JSON.stringify({ angle: 90 }), 0, updateId),
  ]);
  return { editId, memoryId, stackId: stack.id };
}

const OWNER_ASSET_TYPES = [
  'AssetsV2',
  'AssetExifsV1',
  'StacksV1',
  'MemoryToAssetsV1',
  'AssetMetadataV1',
  'AssetEditsV1',
];

const MOBILE_SYNC_TYPES = [
  'AuthUsersV1',
  'UsersV1',
  'AssetsV2',
  'AssetExifsV1',
  'AssetEditsV1',
  'AssetMetadataV1',
  'PartnersV1',
  'PartnerAssetsV2',
  'PartnerAssetExifsV1',
  'AlbumsV2',
  'AlbumUsersV1',
  'AlbumAssetsV2',
  'AlbumAssetExifsV1',
  'AlbumToAssetsV1',
  'MemoriesV1',
  'MemoryToAssetsV1',
  'StacksV1',
  'PartnerStacksV1',
  'UserMetadataV1',
  'PeopleV1',
  'AssetFacesV2',
  'AssetOcrV1',
];

describe('Sync v3', () => {
  beforeAll(async () => {
    await setupDatabase();
  });

  it('streams V2 assets as JSON Lines', async () => {
    const { token, userId } = await createTestAdmin();
    const assetId = await uploadTestAsset(token);
    const response = await authRequest('/api/sync/stream', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ types: ['AssetsV2'] }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/jsonlines+json');
    const text = await response.text();
    expect(text.endsWith('\n')).toBe(true);
    const items = text.trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(items).toContainEqual(expect.objectContaining({
      type: 'AssetV2',
      data: expect.objectContaining({ id: assetId, ownerId: userId, duration: null }),
    }));
    expect(items.at(-1)?.type).toBe('SyncCompleteV1');
    expect(items.at(-1)?.ack.split('|')[1]).toMatch(UUID_V7);
  });

  it('streams assets for the exact mobile v3.2.1 sync request', async () => {
    const { token, userId } = await createTestAdmin();
    const assetId = await uploadTestAsset(token);
    const items = await getSyncItems(token, MOBILE_SYNC_TYPES);

    expect(items).toContainEqual(expect.objectContaining({
      type: 'AssetV2',
      data: expect.objectContaining({ id: assetId, ownerId: userId }),
    }));
    expect(items.at(-1)?.type).toBe('SyncCompleteV1');
  });

  it('derives album ownership from the owner membership', async () => {
    const { token, userId } = await createTestAdmin();
    const createResponse = await authRequest('/api/albums', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ albumName: 'Sync Album' }),
    });
    expect(createResponse.status).toBe(200);
    const album = (await createResponse.json()) as { id: string };

    const response = await authRequest('/api/sync/stream', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ types: ['AlbumsV1', 'AlbumUsersV1'] }),
    });
    expect(response.status).toBe(200);

    const items = (await response.text()).trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(items).toContainEqual(expect.objectContaining({
      type: 'AlbumV1',
      data: expect.objectContaining({ id: album.id, ownerId: userId, name: 'Sync Album' }),
    }));
    expect(items).toContainEqual(expect.objectContaining({
      type: 'AlbumUserV1',
      data: { albumId: album.id, userId, role: 'owner' },
    }));
  });

  it('rejects deprecated and unknown request types', async () => {
    const { token } = await createTestAdmin();
    for (const type of ['AssetsV1', 'UnknownV1']) {
      const response = await authRequest('/api/sync/stream', token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ types: [type] }),
      });
      expect(response.status).toBe(400);
    }
  });

  it('accepts empty feature families and validates reset as a boolean', async () => {
    const { token } = await createTestAdmin();
    const items = await getSyncItems(token, ['PeopleV1', 'AssetFacesV2', 'AssetOcrV1']);
    expect(items.map(({ type }) => type)).toEqual(['SyncCompleteV1']);

    const emptyItems = await getSyncItems(token, []);
    expect(emptyItems.map(({ type }) => type)).toEqual(['SyncCompleteV1']);

    const invalidReset = await authRequest('/api/sync/stream', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ types: [], reset: 'true' }),
    });
    expect(invalidReset.status).toBe(400);
  });

  it('returns only public checkpoint fields', async () => {
    const { token } = await createTestAdmin();
    const response = await authRequest('/api/sync/ack', token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it('validates all acknowledgements before writing and rejects mixed reset acknowledgements', async () => {
    const { token, userId } = await createTestAdmin();
    const cursor = generateUUIDv7();
    const invalid = await authRequest('/api/sync/ack', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acks: [`UserV1|${cursor}`, 'NotAnEntity|invalid'] }),
    });
    expect(invalid.status).toBe(400);

    const mixedReset = await authRequest('/api/sync/ack', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acks: ['SyncResetV1|reset', `AssetV2|${cursor}`] }),
    });
    expect(mixedReset.status).toBe(400);

    const count = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM session_sync_checkpoint checkpoint
      INNER JOIN session ON session.id = checkpoint.sessionId
      WHERE session.userId = ?
    `).bind(userId).first<number>('count');
    expect(count).toBe(0);

    await setSyncAcks(token, [`UserV1|${cursor}`]);
    await env.DB.prepare('UPDATE session SET isPendingSyncReset = 1 WHERE userId = ?').bind(userId).run();
    const reset = await authRequest('/api/sync/ack', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acks: ['SyncResetV1|reset'] }),
    });
    expect(reset.status).toBe(204);
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM session_sync_checkpoint checkpoint
      INNER JOIN session ON session.id = checkpoint.sessionId
      WHERE session.userId = ?
    `).bind(userId).first<number>('count')).toBe(0);
    expect(await env.DB.prepare('SELECT isPendingSyncReset FROM session WHERE userId = ?')
      .bind(userId).first<number>('isPendingSyncReset')).toBe(0);
  });

  it('rolls back every checkpoint when a D1 batch statement fails', async () => {
    const { token, userId } = await createTestAdmin();
    await env.DB.prepare(`
      CREATE TRIGGER fail_asset_checkpoint BEFORE INSERT ON session_sync_checkpoint
      WHEN NEW.type = 'AssetV2'
      BEGIN SELECT RAISE(ABORT, 'checkpoint failure'); END
    `).run();
    try {
      const response = await authRequest('/api/sync/ack', token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acks: [
          `UserV1|${generateUUIDv7()}`,
          `AssetV2|${generateUUIDv7()}`,
        ] }),
      });
      expect(response.status).toBe(500);
      const count = await env.DB.prepare(`
        SELECT COUNT(*) AS count FROM session_sync_checkpoint checkpoint
        INNER JOIN session ON session.id = checkpoint.sessionId
        WHERE session.userId = ?
      `).bind(userId).first<number>('count');
      expect(count).toBe(0);
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_asset_checkpoint').run();
    }
  });

  it('generates canonical cursors and advances mutable rows', async () => {
    const { token, userId } = await createTestAdmin();
    const user = await env.DB.prepare('SELECT updateId FROM user WHERE id = ?')
      .bind(userId)
      .first<{ updateId: string }>();
    const session = await env.DB.prepare('SELECT updateId FROM session WHERE userId = ? ORDER BY createdAt DESC LIMIT 1')
      .bind(userId)
      .first<{ updateId: string }>();
    expect(user?.updateId).toMatch(UUID_V7);
    expect(session?.updateId).toMatch(UUID_V7);

    const assetId = await uploadTestAsset(token, 'cursor');
    const inserted = await env.DB.prepare('SELECT updateId, updatedAt FROM asset WHERE id = ?')
      .bind(assetId)
      .first<{ updateId: string; updatedAt: string }>();

    expect(inserted?.updateId).toMatch(UUID_V7);

    await env.DB.prepare("UPDATE asset SET updatedAt = '2000-01-01T00:00:00.000Z' WHERE id = ?")
      .bind(assetId)
      .run();
    const updated = await env.DB.prepare('SELECT updateId, updatedAt FROM asset WHERE id = ?')
      .bind(assetId)
      .first<{ updateId: string; updatedAt: string }>();

    expect(updated?.updateId).toMatch(UUID_V7);
    expect(updated?.updateId).not.toBe(inserted?.updateId);
    expect(updated?.updatedAt).not.toBe('2000-01-01T00:00:00.000Z');
  });

  it('includes application-created users in the initial sync snapshot', async () => {
    const { token } = await createTestAdmin();
    const created = await createUser(token);
    const row = await env.DB.prepare('SELECT updateId FROM user WHERE id = ?')
      .bind(created.userId)
      .first<{ updateId: string }>();
    expect(row?.updateId).toMatch(UUID_V7);

    const items = await getSyncItems(token, ['UsersV1']);
    expect(items).toContainEqual(expect.objectContaining({
      type: 'UserV1',
      data: expect.objectContaining({ id: created.userId }),
    }));
  });

  it('generates relationship create cursors and asset edit audits', async () => {
    const { token, userId } = await createTestAdmin();
    const assetId = await uploadTestAsset(token, 'edit-audit');
    const albumResponse = await authRequest('/api/albums', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ albumName: 'Cursor Album' }),
    });
    const album = (await albumResponse.json()) as { id: string };
    const albumUser = await env.DB.prepare('SELECT createId, updateId FROM album_user WHERE albumId = ? AND userId = ?')
      .bind(album.id, userId)
      .first<{ createId: string; updateId: string }>();

    expect(albumUser?.createId).toMatch(UUID_V7);
    expect(albumUser?.updateId).toMatch(UUID_V7);

    const partnerId = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO user (id, email, name, clusterGroupId) VALUES (?, ?, ?, ?)')
      .bind(partnerId, `${partnerId}@test.com`, 'Partner', partnerId)
      .run();
    await env.DB.prepare('INSERT INTO partner (sharedById, sharedWithId) VALUES (?, ?)')
      .bind(userId, partnerId)
      .run();
    const partner = await env.DB.prepare('SELECT createId, updateId FROM partner WHERE sharedById = ? AND sharedWithId = ?')
      .bind(userId, partnerId)
      .first<{ createId: string; updateId: string }>();

    expect(partner?.createId).toMatch(UUID_V7);
    expect(partner?.updateId).toMatch(UUID_V7);

    const editId = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO asset_edit (id, assetId, action, parameters, sequence) VALUES (?, ?, ?, ?, ?)')
      .bind(editId, assetId, 'rotate', '{}', 0)
      .run();
    const edit = await env.DB.prepare('SELECT updateId FROM asset_edit WHERE id = ?')
      .bind(editId)
      .first<{ updateId: string }>();
    expect(edit?.updateId).toMatch(UUID_V7);

    await env.DB.prepare('DELETE FROM asset_edit WHERE id = ?').bind(editId).run();
    const audit = await env.DB.prepare('SELECT id, editId, assetId FROM asset_edit_audit WHERE editId = ?')
      .bind(editId)
      .first<{ id: string; editId: string; assetId: string }>();
    expect(audit).toEqual({ id: expect.stringMatching(UUID_V7), editId, assetId });
  });

  it('streams exact AlbumsV2 upserts and AlbumDeleteV1 records', async () => {
    const { token, userId } = await createTestAdmin();
    const createResponse = await authRequest('/api/albums', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ albumName: 'V2 Album', description: 'description' }),
    });
    const album = (await createResponse.json()) as { id: string };
    const deletedAlbumId = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO album_audit (id, albumId, userId) VALUES (?, ?, ?)')
      .bind(generateUUIDv7(Date.now() - 100), deletedAlbumId, userId)
      .run();

    const items = await getSyncItems(token, ['AlbumsV2']);
    const upsert = items.find(({ type, data }) => type === 'AlbumV2' && data.id === album.id);
    expect(upsert.data).toEqual({
      id: album.id,
      name: 'V2 Album',
      description: 'description',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      thumbnailAssetId: null,
      isActivityEnabled: true,
      order: 'desc',
    });
    expect(items).toContainEqual(expect.objectContaining({
      type: 'AlbumDeleteV1',
      data: { albumId: deletedAlbumId },
    }));
  });

  it('maps only the exact AssetExifV1 fields', async () => {
    const { token } = await createTestAdmin();
    const assetId = await uploadTestAsset(token, 'exif');
    await env.DB.prepare(`
      UPDATE asset_exif SET
        description = 'caption', exifImageWidth = 10, exifImageHeight = 20,
        fileSizeInByte = 123, orientation = '1', dateTimeOriginal = '2020-01-02T03:04:05.000Z',
        modifyDate = '2020-01-03T03:04:05.000Z', timeZone = 'UTC', latitude = 1.5,
        longitude = 2.5, projectionType = 'equirectangular', city = 'City', state = 'State',
        country = 'Country', make = 'Make', model = 'Model', lensModel = 'Lens', fNumber = 2.8,
        focalLength = 35, iso = 100, exposureTime = '1/100', profileDescription = 'Profile',
        rating = 4, fps = 30, tags = '["internal"]', lockedProperties = '["description"]'
      WHERE assetId = ?
    `).bind(assetId).run();

    const items = await getSyncItems(token, ['AssetExifsV1']);
    const exif = items.find(({ type }) => type === 'AssetExifV1').data;
    expect(Object.keys(exif).sort()).toEqual([
      'assetId', 'city', 'country', 'dateTimeOriginal', 'description', 'exifImageHeight', 'exifImageWidth',
      'exposureTime', 'fNumber', 'fileSizeInByte', 'focalLength', 'fps', 'iso', 'latitude', 'lensModel',
      'longitude', 'make', 'model', 'modifyDate', 'orientation', 'profileDescription', 'projectionType',
      'rating', 'state', 'timeZone',
    ].sort());
    expect(exif).toEqual(expect.objectContaining({ assetId, description: 'caption', fileSizeInByte: 123, fps: 30 }));
  });

  it('isolates every owner asset-derived family until the session is elevated', async () => {
    const { token, userId } = await createTestAdmin();
    const assetId = await uploadTestAsset(token, 'owner-locked-families');
    const related = await createAssetDerivedRows(token, userId, assetId);
    await env.DB.prepare("UPDATE asset SET visibility = 'locked' WHERE id = ?").bind(assetId).run();

    const hiddenItems = await getSyncItems(token, OWNER_ASSET_TYPES);
    expect(hiddenItems.some(({ data }) =>
      data?.id === assetId || data?.assetId === assetId || data?.primaryAssetId === assetId ||
      data?.id === related.editId || data?.id === related.stackId || data?.memoryId === related.memoryId,
    )).toBe(false);

    expect((await authRequest('/api/auth/pin-code', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinCode: '123456' }),
    })).status).toBe(204);
    expect((await authRequest('/api/auth/session/unlock', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinCode: '123456' }),
    })).status).toBe(204);

    const resetItems = await getSyncItems(token, OWNER_ASSET_TYPES);
    expect(resetItems.map(({ type }) => type)).toEqual(['SyncResetV1']);
    const elevatedItems = await getSyncItems(token, OWNER_ASSET_TYPES, true);
    expect(elevatedItems).toContainEqual(expect.objectContaining({
      type: 'AssetV2', data: expect.objectContaining({ id: assetId, visibility: 'locked' }),
    }));
    expect(elevatedItems).toContainEqual(expect.objectContaining({
      type: 'AssetExifV1', data: expect.objectContaining({ assetId }),
    }));
    expect(elevatedItems).toContainEqual(expect.objectContaining({
      type: 'StackV1', data: expect.objectContaining({ id: related.stackId, primaryAssetId: assetId }),
    }));
    expect(elevatedItems).toContainEqual(expect.objectContaining({
      type: 'MemoryToAssetV1', data: { memoryId: related.memoryId, assetId },
    }));
    expect(elevatedItems).toContainEqual(expect.objectContaining({
      type: 'AssetMetadataV1', data: expect.objectContaining({ assetId, value: { iCloudId: 'locked-secret' } }),
    }));
    expect(elevatedItems).toContainEqual(expect.objectContaining({
      type: 'AssetEditV1', data: expect.objectContaining({ id: related.editId, assetId }),
    }));

    await env.DB.prepare("UPDATE session SET pinExpiresAt = '2000-01-01T00:00:00.000Z' WHERE userId = ?")
      .bind(userId)
      .run();
    const expiredItems = await getSyncItems(token, OWNER_ASSET_TYPES);
    expect(expiredItems.map(({ type }) => type)).toEqual(['SyncResetV1']);
  });

  it('converges owner asset-derived families when an asset is locked and unlocked', async () => {
    const { token, userId } = await createTestAdmin();
    const assetId = await uploadTestAsset(token, 'owner-lock-transition');
    const related = await createAssetDerivedRows(token, userId, assetId);
    const initialItems = await getSyncItems(token, OWNER_ASSET_TYPES);
    await setSyncAcks(token, initialItems.filter(({ type }) => type !== 'SyncCompleteV1').map(({ ack }) => ack));

    const lockResponse = await authRequest(`/api/assets/${assetId}`, token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'locked' }),
    });
    expect(lockResponse.status).toBe(200);
    const lockedItems = await getSyncItems(token, OWNER_ASSET_TYPES);
    expect(lockedItems).toContainEqual(expect.objectContaining({ type: 'AssetDeleteV1', data: { assetId } }));
    expect(lockedItems.some(({ type, data }) =>
      ['AssetV2', 'AssetExifV1', 'StackV1', 'MemoryToAssetV1', 'AssetMetadataV1', 'AssetEditV1'].includes(type) &&
      (data?.id === assetId || data?.assetId === assetId || data?.primaryAssetId === assetId ||
        data?.id === related.stackId || data?.memoryId === related.memoryId),
    )).toBe(false);

    await waitForSnapshot();
    await env.DB.prepare("UPDATE asset SET visibility = 'timeline' WHERE id = ?").bind(assetId).run();
    const unlockedItems = await getSyncItems(token, OWNER_ASSET_TYPES);
    expect(unlockedItems).toContainEqual(expect.objectContaining({
      type: 'AssetV2', data: expect.objectContaining({ id: assetId, visibility: 'timeline' }),
    }));
    expect(unlockedItems).toContainEqual(expect.objectContaining({ type: 'AssetExifV1', data: expect.objectContaining({ assetId }) }));
    expect(unlockedItems).toContainEqual(expect.objectContaining({ type: 'StackV1', data: expect.objectContaining({ id: related.stackId }) }));
    expect(unlockedItems).toContainEqual(expect.objectContaining({ type: 'MemoryToAssetV1', data: { memoryId: related.memoryId, assetId } }));
    expect(unlockedItems).toContainEqual(expect.objectContaining({ type: 'AssetMetadataV1', data: expect.objectContaining({ assetId }) }));
    expect(unlockedItems).toContainEqual(expect.objectContaining({ type: 'AssetEditV1', data: expect.objectContaining({ id: related.editId, assetId }) }));
  });

  it('converges previously synced shared-album assets for unelevated recipients when the owner locks them', async () => {
    const { token } = await createTestAdmin();
    const receiver = await createUser(token);
    const unsyncedReceiver = await createUser(token);
    const assetId = await uploadTestAsset(token, 'shared-lock-secret');
    const albumResponse = await authRequest('/api/albums', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        albumName: 'Lock transition album',
      }),
    });
    expect(albumResponse.status).toBe(200);
    const album = (await albumResponse.json()) as { id: string };
    expect((await authRequest(`/api/albums/${album.id}/assets`, token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [assetId] }),
    })).status).toBe(200);
    expect((await authRequest(`/api/albums/${album.id}/users`, token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        albumUsers: [
          { userId: receiver.userId, role: 'viewer' },
          { userId: unsyncedReceiver.userId, role: 'viewer' },
        ],
      }),
    })).status).toBe(200);

    const types = ['AssetsV2', 'AlbumAssetsV2', 'AlbumAssetExifsV1', 'AlbumToAssetsV1'];
    const initialItems = await getSyncItems(receiver.token, types);
    expect(initialItems).toContainEqual(expect.objectContaining({
      type: 'AlbumAssetCreateV2',
      data: expect.objectContaining({ id: assetId, originalFileName: 'test-shared-lock-secret.jpg' }),
    }));
    expect(initialItems).toContainEqual(expect.objectContaining({
      type: 'AlbumToAssetV1',
      data: { albumId: album.id, assetId },
    }));
    await setSyncAcks(receiver.token, initialItems.filter(({ type }) => type !== 'SyncCompleteV1').map(({ ack }) => ack));

    expect((await authRequest(`/api/assets/${assetId}`, token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'locked' }),
    })).status).toBe(200);

    const items = await getSyncItems(receiver.token, types);
    expect(items).toContainEqual(expect.objectContaining({ type: 'AssetDeleteV1', data: { assetId } }));
    expect(items).toContainEqual(expect.objectContaining({
      type: 'AlbumToAssetDeleteV1',
      data: { albumId: album.id, assetId },
    }));
    expect(items.some(({ type, data }) =>
      ['AssetV2', 'AlbumAssetCreateV2', 'AlbumAssetUpdateV2', 'AlbumAssetExifCreateV1',
        'AlbumAssetExifUpdateV1', 'AlbumAssetBackfillV2', 'AlbumAssetExifBackfillV1', 'AlbumToAssetV1',
        'AlbumToAssetBackfillV1'].includes(type) && (data?.id === assetId || data?.assetId === assetId),
    )).toBe(false);
    expect(JSON.stringify(items)).not.toContain('shared-lock-secret');

    const unsyncedItems = await getSyncItems(unsyncedReceiver.token, types);
    expect(JSON.stringify(unsyncedItems)).not.toContain(assetId);
    expect(JSON.stringify(unsyncedItems)).not.toContain('shared-lock-secret');
  });

  it('streams asset edit upserts and deletes with exact payloads', async () => {
    const { token } = await createTestAdmin();
    const assetId = await uploadTestAsset(token, 'edit-sync');
    const editId = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO asset_edit (id, assetId, action, parameters, sequence) VALUES (?, ?, ?, ?, ?)')
      .bind(editId, assetId, 'rotate', JSON.stringify({ angle: 90 }), 0)
      .run();

    const upsertItems = await getSyncItems(token, ['AssetEditsV1']);
    expect(upsertItems).toContainEqual(expect.objectContaining({
      type: 'AssetEditV1',
      data: { id: editId, assetId, action: 'rotate', parameters: { angle: 90 }, sequence: 0 },
    }));

    await env.DB.prepare('DELETE FROM asset_edit WHERE id = ?').bind(editId).run();
    const deleteItems = await getSyncItems(token, ['AssetEditsV1']);
    expect(deleteItems).toContainEqual(expect.objectContaining({
      type: 'AssetEditDeleteV1',
      data: { editId },
    }));
  });

  it('advances asset and edit cursors through create, replace, and remove', async () => {
    const { token } = await createTestAdmin();
    const assetId = await uploadTestAsset(token, 'edit-cursors');

    const create = await authRequest(`/api/assets/${assetId}/edits`, token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edits: [{ action: 'rotate', parameters: { angle: 90 } }] }),
    });
    expect(create.status).toBe(200);

    const createdItems = await getSyncItems(token, ['AssetsV2', 'AssetEditsV1']);
    const createdAsset = createdItems.find(({ type, data }) => type === 'AssetV2' && data.id === assetId);
    const createdEdit = createdItems.find(({ type, data }) => type === 'AssetEditV1' && data.assetId === assetId);
    expect(createdAsset).toEqual(expect.objectContaining({
      ack: expect.stringMatching(/^AssetV2\|/),
      data: expect.objectContaining({ id: assetId, isEdited: true }),
    }));
    expect(createdEdit).toEqual(expect.objectContaining({
      ack: expect.stringMatching(/^AssetEditV1\|/),
      data: expect.objectContaining({ assetId, action: 'rotate', sequence: 0 }),
    }));
    await setSyncAcks(token, [createdAsset.ack, createdEdit.ack]);

    const replace = await authRequest(`/api/assets/${assetId}/edits`, token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edits: [{ action: 'mirror', parameters: { axis: 'vertical' } }] }),
    });
    expect(replace.status).toBe(200);

    const replacedItems = await getSyncItems(token, ['AssetsV2', 'AssetEditsV1']);
    const replacedAsset = replacedItems.find(({ type, data }) => type === 'AssetV2' && data.id === assetId);
    const replacedEdit = replacedItems.find(({ type, data }) => type === 'AssetEditV1' && data.assetId === assetId);
    const replacedDelete = replacedItems.find(({ type, data }) =>
      type === 'AssetEditDeleteV1' && data.editId === createdEdit.data.id,
    );
    expect(replacedAsset?.data.isEdited).toBe(true);
    expect(replacedAsset?.ack).not.toBe(createdAsset.ack);
    expect(replacedEdit).toEqual(expect.objectContaining({
      data: expect.objectContaining({ assetId, action: 'mirror', sequence: 0 }),
    }));
    expect(replacedEdit?.data.id).not.toBe(createdEdit.data.id);
    expect(replacedDelete).toEqual(expect.objectContaining({ ack: expect.stringMatching(/^AssetEditDeleteV1\|/) }));
    await setSyncAcks(token, [replacedAsset.ack, replacedEdit.ack, replacedDelete.ack]);

    const remove = await authRequest(`/api/assets/${assetId}/edits`, token, { method: 'DELETE' });
    expect(remove.status).toBe(204);

    const removedItems = await getSyncItems(token, ['AssetsV2', 'AssetEditsV1']);
    const removedAsset = removedItems.find(({ type, data }) => type === 'AssetV2' && data.id === assetId);
    expect(removedAsset?.data.isEdited).toBe(false);
    expect(removedAsset?.ack).not.toBe(replacedAsset.ack);
    expect(removedItems).toContainEqual(expect.objectContaining({
      type: 'AssetEditDeleteV1',
      data: { editId: replacedEdit.data.id },
    }));
    expect(removedItems.some(({ type, data }) => type === 'AssetEditV1' && data.assetId === assetId)).toBe(false);
  });

  it('pages past 1000 rows and excludes cursors beyond the snapshot', async () => {
    const { token } = await createTestAdmin();
    const baseTime = Date.now() - 100_000;
    const statements: D1PreparedStatement[] = [];
    const pageUserIds: string[] = [];
    for (let index = 0; index < 1001; index++) {
      const id = crypto.randomUUID();
      pageUserIds.push(id);
      statements.push(env.DB.prepare('INSERT INTO user (id, email, name, clusterGroupId, updateId) VALUES (?, ?, ?, ?, ?)').bind(
        id,
        `page-${index}@test.com`,
        `Page ${index}`,
        id,
        generateUUIDv7(baseTime + index),
      ));
    }
    for (let index = 0; index < statements.length; index += 50) {
      await env.DB.batch(statements.slice(index, index + 50));
    }

    const futureUserId = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO user (id, email, name, clusterGroupId, updateId) VALUES (?, ?, ?, ?, ?)')
      .bind(futureUserId, 'future@test.com', 'Future', futureUserId, generateUUIDv7(Date.now() + 60_000))
      .run();

    const items = await getSyncItems(token, ['UsersV1']);
    const users = items.filter(({ type }) => type === 'UserV1');
    const streamedIds = new Set(users.map(({ data }) => data.id));
    expect(users.length).toBeGreaterThan(1000);
    expect(pageUserIds.every((id) => streamedIds.has(id))).toBe(true);
    expect(users.some(({ data }) => data.id === futureUserId)).toBe(false);
  }, 20_000);

  it('isolates relationship audits and exposes partner relations in both directions', async () => {
    const { token, userId } = await createTestAdmin();
    const otherUserId = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO user (id, email, name, clusterGroupId) VALUES (?, ?, ?, ?)')
      .bind(otherUserId, 'other-audit@test.com', 'Other', otherUserId)
      .run();

    const ownAlbumResponse = await authRequest('/api/albums', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ albumName: 'Own Audit Album' }),
    });
    const ownAlbum = (await ownAlbumResponse.json()) as { id: string };
    const otherAlbumId = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO album (id, albumName) VALUES (?, ?)').bind(otherAlbumId, 'Other Album').run();
    await env.DB.prepare('INSERT INTO album_user (albumId, userId, role) VALUES (?, ?, ?)')
      .bind(otherAlbumId, otherUserId, 'owner')
      .run();

    const ownDeletedAssetId = crypto.randomUUID();
    const otherDeletedAssetId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO album_asset_audit (id, albumId, assetId) VALUES (?, ?, ?)')
        .bind(generateUUIDv7(Date.now() - 200), ownAlbum.id, ownDeletedAssetId),
      env.DB.prepare('INSERT INTO album_asset_audit (id, albumId, assetId) VALUES (?, ?, ?)')
        .bind(generateUUIDv7(Date.now() - 100), otherAlbumId, otherDeletedAssetId),
      env.DB.prepare('INSERT INTO partner (sharedById, sharedWithId, inTimeline, createId, updateId) VALUES (?, ?, ?, ?, ?)')
        .bind(userId, otherUserId, 1, generateUUIDv7(Date.now() - 100), generateUUIDv7(Date.now() - 100)),
    ]);

    const items = await getSyncItems(token, ['AlbumToAssetsV1', 'PartnersV1']);
    expect(items).toContainEqual(expect.objectContaining({
      type: 'PartnerV1',
      data: { sharedById: userId, sharedWithId: otherUserId, inTimeline: true },
    }));
    expect(items).toContainEqual(expect.objectContaining({
      type: 'AlbumToAssetDeleteV1',
      data: { albumId: ownAlbum.id, assetId: ownDeletedAssetId },
    }));
    expect(items.some(({ data }) => data?.assetId === otherDeletedAssetId)).toBe(false);
    expect(items.findIndex(({ type }) => type === 'PartnerV1'))
      .toBeLessThan(items.findIndex(({ type }) => type === 'AlbumToAssetDeleteV1'));
  });

  it('generates deletion tombstones and suppresses child tombstones on parent cascades', async () => {
    const { token, userId } = await createTestAdmin();
    const assetId = await uploadTestAsset(token, 'audit-triggers');
    const albumResponse = await authRequest('/api/albums', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ albumName: 'Audit Trigger Album' }),
    });
    const album = (await albumResponse.json()) as { id: string };
    await env.DB.prepare('INSERT INTO album_asset (albumId, assetId) VALUES (?, ?)').bind(album.id, assetId).run();

    await env.DB.prepare('DELETE FROM album_asset WHERE albumId = ? AND assetId = ?').bind(album.id, assetId).run();
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM album_asset_audit WHERE albumId = ?').bind(album.id).first('count')).toBe(1);

    await env.DB.prepare('INSERT INTO album_asset (albumId, assetId) VALUES (?, ?)').bind(album.id, assetId).run();
    await env.DB.prepare('DELETE FROM album WHERE id = ?').bind(album.id).run();
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM album_audit WHERE albumId = ? AND userId = ?').bind(album.id, userId).first('count')).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM album_user_audit WHERE albumId = ?').bind(album.id).first('count')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM album_asset_audit WHERE albumId = ?').bind(album.id).first('count')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM sync_delete_guard').first('count')).toBe(0);

    const secondAlbumResponse = await authRequest('/api/albums', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ albumName: 'Asset Cascade Album' }),
    });
    const secondAlbum = (await secondAlbumResponse.json()) as { id: string };
    await env.DB.prepare('INSERT INTO album_asset (albumId, assetId) VALUES (?, ?)').bind(secondAlbum.id, assetId).run();
    await env.DB.prepare('DELETE FROM asset WHERE id = ?').bind(assetId).run();
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM asset_audit WHERE assetId = ? AND ownerId = ?').bind(assetId, userId).first('count')).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM album_asset_audit WHERE albumId = ? AND assetId = ?').bind(secondAlbum.id, assetId).first('count')).toBe(1);
  });

  it('syncs partner V2 families with resumable backfills and locked-asset isolation', async () => {
    const { token, userId } = await createTestAdmin();
    const receiver = await createUser(token);
    const assetId = await uploadTestAsset(token, 'partner-visible');
    const lockedAssetId = await uploadTestAsset(token, 'partner-locked');
    await env.DB.batch([
      env.DB.prepare('UPDATE asset SET isFavorite = 1 WHERE id = ?').bind(assetId),
      env.DB.prepare("UPDATE asset SET visibility = 'locked' WHERE id = ?").bind(lockedAssetId),
      env.DB.prepare('INSERT INTO partner (sharedById, sharedWithId) VALUES (?, ?)').bind(userId, receiver.userId),
    ]);

    const initialItems = await getSyncItems(receiver.token, ['PartnerAssetsV2', 'PartnerAssetExifsV1']);
    const assetItem = initialItems.find(({ type, data }) => type === 'PartnerAssetV2' && data.id === assetId);
    expect(assetItem.data.isFavorite).toBe(false);
    expect(initialItems.some(({ data }) => data?.id === lockedAssetId || data?.assetId === lockedAssetId)).toBe(false);
    const storedBackfill = await env.DB.prepare(`
      SELECT checkpoint.ack FROM session_sync_checkpoint checkpoint
      INNER JOIN session ON session.id = checkpoint.sessionId
      WHERE session.userId = ? AND checkpoint.type = 'PartnerAssetBackfillV2'
    `).bind(receiver.userId).first<{ ack: string }>();
    expect(storedBackfill?.ack).toMatch(/^PartnerAssetBackfillV2\|.+\|complete$/);

    await setSyncAcks(receiver.token, [assetItem.ack]);
    await env.DB.prepare('DELETE FROM partner WHERE sharedById = ? AND sharedWithId = ?').bind(userId, receiver.userId).run();
    await waitForSnapshot();
    await env.DB.prepare('INSERT INTO partner (sharedById, sharedWithId) VALUES (?, ?)').bind(userId, receiver.userId).run();

    const resumedItems = await getSyncItems(receiver.token, ['PartnerAssetsV2']);
    const backfill = resumedItems.find(({ type, data }) => type === 'PartnerAssetBackfillV2' && data.id === assetId);
    expect(backfill.data.isFavorite).toBe(false);
    const [backfillType, createId, updateId] = backfill.ack.split('|');
    expect(backfillType).toBe('PartnerAssetBackfillV2');
    expect(createId).toMatch(UUID_V7);
    expect(updateId).toMatch(UUID_V7);
    expect(resumedItems).toContainEqual(expect.objectContaining({
      type: 'SyncAckV1',
      ack: `PartnerAssetBackfillV2|${createId}|complete`,
    }));
  });

  it('backfills newly shared album users, assets, EXIF, and relationships with composite acks', async () => {
    const { token } = await createTestAdmin();
    const receiver = await createUser(token);
    const assetId = await uploadTestAsset(token, 'album-backfill');
    const albumResponse = await authRequest('/api/albums', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ albumName: 'Backfill Album' }),
    });
    const album = (await albumResponse.json()) as { id: string };
    await env.DB.prepare('INSERT INTO album_asset (albumId, assetId) VALUES (?, ?)').bind(album.id, assetId).run();
    await waitForSnapshot();
    const baselineId = generateUUIDv7(Date.now() + 1000);
    await setSyncAcks(receiver.token, [
      `AlbumAssetCreateV2|${baselineId}`,
      `AlbumAssetExifCreateV1|${baselineId}`,
      `AlbumUserV1|${baselineId}`,
      `AlbumToAssetV1|${baselineId}`,
    ]);
    await waitForSnapshot();
    await env.DB.prepare('INSERT INTO album_user (albumId, userId, role) VALUES (?, ?, ?)')
      .bind(album.id, receiver.userId, 'viewer')
      .run();

    const items = await getSyncItems(receiver.token, [
      'AlbumAssetsV2', 'AlbumAssetExifsV1', 'AlbumUsersV1', 'AlbumToAssetsV1',
    ]);
    expect(items).toContainEqual(expect.objectContaining({
      type: 'AlbumAssetBackfillV2',
      data: expect.objectContaining({ id: assetId, isFavorite: false }),
    }));
    expect(items).toContainEqual(expect.objectContaining({
      type: 'AlbumAssetExifBackfillV1',
      data: expect.objectContaining({ assetId }),
    }));
    expect(items).toContainEqual(expect.objectContaining({
      type: 'AlbumUserBackfillV1',
      data: expect.objectContaining({ albumId: album.id, role: 'owner' }),
    }));
    expect(items).toContainEqual(expect.objectContaining({
      type: 'AlbumToAssetBackfillV1',
      data: { albumId: album.id, assetId },
    }));

    for (const type of [
      'AlbumAssetBackfillV2', 'AlbumAssetExifBackfillV1', 'AlbumUserBackfillV1', 'AlbumToAssetBackfillV1',
    ]) {
      const entity = items.find((item) => item.type === type);
      const [, createId] = entity.ack.split('|');
      expect(items).toContainEqual(expect.objectContaining({ type: 'SyncAckV1', ack: `${type}|${createId}|complete` }));
    }
  });
});
