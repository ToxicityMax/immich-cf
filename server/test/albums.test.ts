import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { createServiceContext } from '../src/context';
import { AlbumRepository } from '../src/repositories/album.repository';
import { authRequest, setupDatabase, createTestAdmin, request, uploadTestAsset } from './helpers';

describe('Albums', () => {
  beforeAll(async () => {
    await setupDatabase();
  });

  // Helper to create an album within the current test
  async function createAlbum(token: string, name = 'Test Album', description = '') {
    return authRequest('/api/albums', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ albumName: name, description }),
    });
  }

  // -------------------------------------------------------------------------
  // Create Album
  // -------------------------------------------------------------------------
  describe('POST /api/albums', () => {
    it('should create an album', async () => {
      const { token } = await createTestAdmin();

      const res = await createAlbum(token, 'Test Album', 'A test album');

      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('albumName');
      expect(body.albumName).toBe('Test Album');
      expect(body).not.toHaveProperty('ownerId');
      expect(body).not.toHaveProperty('owner');
      expect(body.albumUsers).toEqual([
        expect.objectContaining({
          role: 'owner',
          user: expect.objectContaining({ id: expect.any(String) }),
        }),
      ]);
    });

    it('should create an album with default name if none provided', async () => {
      const { token } = await createTestAdmin();

      const res = await authRequest('/api/albums', token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('albumName');
    });

    it('deduplicates users and assets while retaining exactly one owner', async () => {
      const { token } = await createTestAdmin();
      const assetId = await uploadTestAsset(token, crypto.randomUUID());
      const email = `album-dedup-${crypto.randomUUID()}@test.com`;
      const userResponse = await authRequest('/api/admin/users', token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'password123', name: 'Dedup User' }),
      });
      const user = (await userResponse.json()) as { id: string };
      const response = await authRequest('/api/albums', token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          albumName: 'Deduplicated',
          assetIds: [assetId, assetId],
          albumUsers: [
            { userId: user.id, role: 'editor' },
            { userId: user.id, role: 'editor' },
          ],
        }),
      });
      expect(response.status).toBe(200);
      const album = (await response.json()) as any;
      expect(album.assets).toHaveLength(1);
      expect(album.albumUsers.map(({ role }: { role: string }) => role).sort()).toEqual(['editor', 'owner']);
    });

    it('rolls back the album row when a relationship insert fails', async () => {
      const { userId } = await createTestAdmin();
      const context = createServiceContext(env as any);
      const repository = new AlbumRepository(context.db, env.DB);
      const albumId = crypto.randomUUID();

      await expect(repository.create(
        { id: albumId, albumName: 'Must Roll Back', order: 'desc' },
        [crypto.randomUUID()],
        [{ userId, role: 'owner' }],
      )).rejects.toThrow();
      expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM album WHERE id = ?')
        .bind(albumId).first<number>('count')).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // List Albums
  // -------------------------------------------------------------------------
  describe('GET /api/albums', () => {
    it('should return a list of albums', async () => {
      const { token } = await createTestAdmin();
      // Create an album so the list is non-empty
      await createAlbum(token, 'List Test Album');

      const res = await authRequest('/api/albums', token);

      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);
    });

    it('should filter owned and shared albums using v3 query parameters', async () => {
      const { token } = await createTestAdmin();
      const email = `album-user-${crypto.randomUUID()}@test.com`;
      const password = 'password123';
      const createUserRes = await authRequest('/api/admin/users', token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name: 'Album User' }),
      });
      expect(createUserRes.status).toBe(200);
      const user = (await createUserRes.json()) as { id: string };

      const loginRes = await request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      expect(loginRes.status).toBe(200);
      const login = (await loginRes.json()) as { accessToken: string };

      const createRes = await authRequest('/api/albums', token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          albumName: 'Shared v3 Album',
          albumUsers: [{ userId: user.id, role: 'viewer' }],
        }),
      });
      expect(createRes.status).toBe(200);
      const album = (await createRes.json()) as any;
      expect(album.albumUsers.map(({ role }: { role: string }) => role)).toEqual(['owner', 'viewer']);

      const sharedRes = await authRequest('/api/albums?isOwned=false', login.accessToken);
      expect(sharedRes.status).toBe(200);
      expect(await sharedRes.json()).toEqual([
        expect.objectContaining({ id: album.id, albumName: 'Shared v3 Album' }),
      ]);

      const ownedRes = await authRequest('/api/albums?isOwned=true', login.accessToken);
      expect(ownedRes.status).toBe(200);
      expect(await ownedRes.json()).toEqual([]);

      const sharedByOwnerRes = await authRequest('/api/albums?isShared=true&isOwned=true', token);
      expect(sharedByOwnerRes.status).toBe(200);
      expect(await sharedByOwnerRes.json()).toContainEqual(expect.objectContaining({ id: album.id }));
    });
  });

  // -------------------------------------------------------------------------
  // Get Album Info
  // -------------------------------------------------------------------------
  describe('GET /api/albums/:id', () => {
    it('should return album info', async () => {
      const { token } = await createTestAdmin();

      // Create an album first
      const createRes = await createAlbum(token, 'Get Info Test');
      const album = (await createRes.json()) as any;

      const res = await authRequest(`/api/albums/${album.id}`, token);

      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body).toHaveProperty('id');
      expect(body.id).toBe(album.id);
      expect(body.albumName).toBe('Get Info Test');
      expect(body.albumUsers[0]).toMatchObject({ role: 'owner' });
    });

    it('should return error for non-existent album', async () => {
      const { token } = await createTestAdmin();
      const res = await authRequest('/api/albums/00000000-0000-0000-0000-000000000000', token);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  // -------------------------------------------------------------------------
  // Update Album
  // -------------------------------------------------------------------------
  describe('PATCH /api/albums/:id', () => {
    it('should update album name and description', async () => {
      const { token } = await createTestAdmin();

      // Create album
      const createRes = await createAlbum(token, 'Original Name');
      const album = (await createRes.json()) as any;

      // Update it
      const res = await authRequest(`/api/albums/${album.id}`, token, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          albumName: 'Updated Name',
          description: 'Updated description',
        }),
      });

      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.albumName).toBe('Updated Name');
      expect(body.description).toBe('Updated description');
    });
  });

  // -------------------------------------------------------------------------
  // Add Assets to Album
  // -------------------------------------------------------------------------
  describe('PUT /api/albums/:id/assets', () => {
    it('should add assets to an album', async () => {
      const { token } = await createTestAdmin();

      // Create album
      const createRes = await createAlbum(token, 'Asset Album');
      const album = (await createRes.json()) as any;

      // Upload asset
      const assetId = await uploadTestAsset(token);

      // Add asset to album
      const res = await authRequest(`/api/albums/${album.id}/assets`, token, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: [assetId],
        }),
      });

      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(Array.isArray(body)).toBe(true);
      // Result should indicate which assets were successfully added
      if (body.length > 0) {
        expect(body[0]).toHaveProperty('id');
        expect(body[0]).toHaveProperty('success');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Remove Assets from Album
  // -------------------------------------------------------------------------
  describe('DELETE /api/albums/:id/assets', () => {
    it('should remove assets from an album', async () => {
      const { token } = await createTestAdmin();

      // Create album and add asset
      const createRes = await createAlbum(token, 'Remove Asset Album');
      const album = (await createRes.json()) as any;

      const assetId = await uploadTestAsset(token);

      // Add asset
      await authRequest(`/api/albums/${album.id}/assets`, token, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [assetId] }),
      });

      // Remove asset
      const res = await authRequest(`/api/albums/${album.id}/assets`, token, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [assetId] }),
      });

      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(Array.isArray(body)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Delete Album
  // -------------------------------------------------------------------------
  describe('DELETE /api/albums/:id', () => {
    it('should delete an album', async () => {
      const { token } = await createTestAdmin();

      // Create album
      const createRes = await createAlbum(token, 'Delete Me');
      const album = (await createRes.json()) as any;

      const res = await authRequest(`/api/albums/${album.id}`, token, {
        method: 'DELETE',
      });

      expect(res.status).toBe(204);

      // Verify album is gone
      const getRes = await authRequest(`/api/albums/${album.id}`, token);
      expect(getRes.status).toBeGreaterThanOrEqual(400);
    });
  });

  // -------------------------------------------------------------------------
  // Album Statistics
  // -------------------------------------------------------------------------
  describe('GET /api/albums/statistics', () => {
    it('should return album statistics', async () => {
      const { token } = await createTestAdmin();
      const res = await authRequest('/api/albums/statistics', token);

      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(typeof body).toBe('object');
      expect(body).not.toBeNull();
    });
  });
});
