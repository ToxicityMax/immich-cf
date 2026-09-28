import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createServiceContext } from '../src/context';
import type { AuthDto } from '../src/dtos/auth.dto';
import { TrashService } from '../src/services/trash.service';
import { authRequest, createTestAdmin, setupDatabase, uploadTestAsset } from './helpers';

const json = (body: unknown) => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('Trash', () => {
  beforeAll(async () => {
    await setupDatabase();
  });

  const getQuota = async (userId: string) => Number((await env.DB.prepare(
    'SELECT quotaUsageInBytes FROM user WHERE id = ?',
  ).bind(userId).first<{ quotaUsageInBytes: number }>())?.quotaUsageInBytes);

  it('restores and permanently deletes 101 assets without exceeding D1 bind limits', async () => {
    const { token, userId } = await createTestAdmin();
    const ids = Array.from({ length: 101 }, () => crypto.randomUUID());
    const bytesPerAsset = 10;
    const quotaBefore = await getQuota(userId);

    await env.DB.batch([
      ...ids.map((id) => env.DB.prepare(`
        INSERT INTO asset (
          id, ownerId, type, originalPath, fileCreatedAt, fileModifiedAt,
          checksum, localDateTime, originalFileName, status, deletedAt
        ) VALUES (?, ?, 'IMAGE', ?, ?, ?, randomblob(20), ?, 'bulk.jpg', 'trashed', ?)
      `).bind(id, userId, `trash/${id}.jpg`, new Date().toISOString(), new Date().toISOString(),
        new Date().toISOString(), new Date().toISOString())),
      ...ids.map((id) => env.DB.prepare(
        'INSERT INTO asset_exif (assetId, fileSizeInByte) VALUES (?, ?)',
      ).bind(id, bytesPerAsset)),
      env.DB.prepare(
        'UPDATE user SET quotaUsageInBytes = quotaUsageInBytes + ? WHERE id = ?',
      ).bind(ids.length * bytesPerAsset, userId),
    ]);

    const restore = await authRequest('/api/trash/restore/assets', token, {
      method: 'POST',
      ...json({ ids }),
    });
    expect(restore.status).toBe(200);
    expect(await restore.json()).toEqual({ count: 101 });
    expect(await getQuota(userId)).toBe(quotaBefore + ids.length * bytesPerAsset);

    await env.DB.prepare(`
      UPDATE asset SET status = 'trashed', deletedAt = ?
      WHERE ownerId = ? AND originalPath LIKE 'trash/%'
    `).bind(new Date().toISOString(), userId).run();

    const empty = await authRequest('/api/trash/empty', token, { method: 'POST' });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ count: 101 });
    expect(await getQuota(userId)).toBe(quotaBefore);
    expect(Number((await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM asset WHERE ownerId = ? AND originalPath LIKE 'trash/%'`,
    ).bind(userId).first<{ count: number }>())?.count)).toBe(0);
  });

  it('repairs surviving stacks, removes empty stacks, deletes relationships, and decrements quota', async () => {
    const { token, userId } = await createTestAdmin();
    const [primaryId, replacementId, removedPrimaryId, removedSecondaryId] = await Promise.all([
      uploadTestAsset(token, crypto.randomUUID()),
      uploadTestAsset(token, crypto.randomUUID()),
      uploadTestAsset(token, crypto.randomUUID()),
      uploadTestAsset(token, crypto.randomUUID()),
    ]);
    const createStack = async (assetIds: string[]) => {
      const response = await authRequest('/api/stacks', token, { method: 'POST', ...json({ assetIds }) });
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string };
    };
    const survivingStack = await createStack([primaryId, replacementId]);
    const removedStack = await createStack([removedPrimaryId, removedSecondaryId]);
    const removedIds = [primaryId, removedPrimaryId, removedSecondaryId];
    const quotaBefore = await getQuota(userId);
    const placeholders = removedIds.map(() => '?').join(', ');
    const removedBytes = Number((await env.DB.prepare(`
      SELECT SUM(fileSizeInByte) AS bytes FROM asset_exif WHERE assetId IN (${placeholders})
    `).bind(...removedIds).first<{ bytes: number }>())?.bytes);
    const { results: removedObjects } = await env.DB.prepare(`
      SELECT originalPath AS path FROM asset WHERE id IN (${placeholders})
      UNION ALL
      SELECT path FROM asset_file WHERE assetId IN (${placeholders})
    `).bind(...removedIds, ...removedIds).all<{ path: string }>();
    expect(await env.BUCKET.head(removedObjects[0].path)).not.toBeNull();

    const albumId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO album (id, albumName) VALUES (?, ?)').bind(albumId, 'Trash relations'),
      env.DB.prepare('INSERT INTO album_user (albumId, userId, role) VALUES (?, ?, ?)')
        .bind(albumId, userId, 'owner'),
      ...removedIds.map((id) => env.DB.prepare(
        'INSERT INTO album_asset (albumId, assetId) VALUES (?, ?)',
      ).bind(albumId, id)),
    ]);

    expect((await authRequest('/api/assets', token, {
      method: 'DELETE',
      ...json({ ids: removedIds }),
    })).status).toBe(204);
    const empty = await authRequest('/api/trash/empty', token, { method: 'POST' });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ count: 3 });

    expect(await env.DB.prepare('SELECT primaryAssetId FROM stack WHERE id = ?')
      .bind(survivingStack.id).first()).toEqual({ primaryAssetId: replacementId });
    expect(await env.DB.prepare('SELECT id FROM stack WHERE id = ?').bind(removedStack.id).first()).toBeNull();
    expect(Number((await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM album_asset WHERE albumId = ?',
    ).bind(albumId).first<{ count: number }>())?.count)).toBe(0);
    expect(await getQuota(userId)).toBe(quotaBefore - removedBytes);
    for (const { path } of removedObjects) {
      expect(await env.BUCKET.head(path)).toBeNull();
    }
  });

  it('force deletes every R2 object and the asset row immediately', async () => {
    const { token, userId } = await createTestAdmin();
    const assetId = await uploadTestAsset(token, crypto.randomUUID());
    const asset = await env.DB.prepare(`
      SELECT originalPath FROM asset WHERE id = ?
    `).bind(assetId).first<{ originalPath: string }>();
    const encodedVideoPath = `assets/${userId}/${assetId}/encoded-video.mp4`;
    const orphanedPath = `assets/${userId}/${assetId}/orphaned-derivative.webp`;
    await env.BUCKET.put(encodedVideoPath, new Uint8Array([1, 2, 3]));
    await env.BUCKET.put(orphanedPath, new Uint8Array([4, 5, 6]));
    await env.DB.prepare('UPDATE asset SET encodedVideoPath = ? WHERE id = ?').bind(encodedVideoPath, assetId).run();
    const { results: assetFiles } = await env.DB.prepare(
      'SELECT path FROM asset_file WHERE assetId = ?',
    ).bind(assetId).all<{ path: string }>();
    const quotaBefore = await getQuota(userId);

    const response = await authRequest('/api/assets', token, {
      method: 'DELETE',
      ...json({ ids: [assetId], force: true }),
    });
    expect(response.status).toBe(204);
    expect(await env.DB.prepare('SELECT id FROM asset WHERE id = ?').bind(assetId).first()).toBeNull();
    expect(await getQuota(userId)).toBeLessThan(quotaBefore);
    for (const path of [asset!.originalPath, encodedVideoPath, orphanedPath, ...assetFiles.map(({ path }) => path)]) {
      expect(await env.BUCKET.head(path)).toBeNull();
    }
  });

  it('does not change a stack primary when force deleting a secondary asset', async () => {
    const { token } = await createTestAdmin();
    const primaryId = await uploadTestAsset(token, `force-primary-${crypto.randomUUID()}`);
    const secondaryId = await uploadTestAsset(token, `force-secondary-${crypto.randomUUID()}`);
    const stackResponse = await authRequest('/api/stacks', token, {
      method: 'POST',
      ...json({ assetIds: [primaryId, secondaryId] }),
    });
    expect(stackResponse.status).toBe(201);
    const stack = (await stackResponse.json()) as { id: string; primaryAssetId: string };

    expect((await authRequest('/api/assets', token, {
      method: 'DELETE',
      ...json({ ids: [secondaryId], force: true }),
    })).status).toBe(204);
    expect(await env.DB.prepare('SELECT primaryAssetId FROM stack WHERE id = ?').bind(stack.id).first())
      .toEqual({ primaryAssetId: stack.primaryAssetId });
  });

  it('leaves database rows and quota unchanged when R2 deletion fails', async () => {
    const { token, userId } = await createTestAdmin();
    const assetId = await uploadTestAsset(token, crypto.randomUUID());
    expect((await authRequest('/api/assets', token, {
      method: 'DELETE',
      ...json({ ids: [assetId] }),
    })).status).toBe(204);
    const quotaBefore = await getQuota(userId);
    const context = createServiceContext(env);
    const deleteObject = vi.fn().mockRejectedValue(new Error('injected R2 failure'));
    const service = new TrashService({
      ...context,
      bucket: {
        delete: deleteObject,
        list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
      } as unknown as R2Bucket,
      realtime: { sendUser: vi.fn() } as any,
    });

    await expect(service.empty({ user: { id: userId } } as AuthDto)).rejects.toThrow('injected R2 failure');
    expect(deleteObject).toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT status FROM asset WHERE id = ?').bind(assetId).first())
      .toEqual({ status: 'trashed' });
    expect(await getQuota(userId)).toBe(quotaBefore);
  });
});
