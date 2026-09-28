import { beforeAll, describe, expect, it } from 'vitest';
import { authRequest, createTestAdmin, request, setupDatabase, uploadTestAsset } from './helpers';

describe('Downloads', () => {
  let token: string;
  let assetId: string;

  beforeAll(async () => {
    await setupDatabase();
    ({ token } = await createTestAdmin());
    assetId = await uploadTestAsset(token, `download-${crypto.randomUUID()}`);
  });

  const createLink = async (allowDownload: boolean) => {
    const response = await authRequest('/api/shared-links', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'INDIVIDUAL', assetIds: [assetId], allowDownload }),
    });
    expect(response.status).toBe(201);
    return await response.json() as any;
  };

  it('supports shared-link download info and browser form archive requests', async () => {
    const link = await createLink(true);
    const repeatedIds = Array.from({ length: 101 }, () => assetId);
    const info = await request(`/api/download/info?key=${link.key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetIds: repeatedIds }),
    });
    expect(info.status).toBe(200);
    expect((await info.json() as any).archives[0].assetIds.length).toBeGreaterThan(0);

    const form = new URLSearchParams();
    form.set('assetIds', assetId);
    form.set('archiveName', 'shared/photos\r\nunsafe');
    form.set('edited', 'true');
    const archive = await request(`/api/download/archive?key=${link.key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    expect(archive.status).toBe(200);
    expect(archive.headers.get('content-type')).toBe('application/zip');
    const disposition = archive.headers.get('content-disposition') || '';
    expect(disposition).toContain("filename*=UTF-8''sharedphotosunsafe.zip");
    expect(disposition).not.toContain('\r');
    expect(disposition).not.toContain('\n');
    expect(new Uint8Array(await archive.arrayBuffer()).slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));

    const jsonArchive = await request(`/api/download/archive?key=${link.key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetIds: [assetId], archiveName: 'json-archive' }),
    });
    expect(jsonArchive.status).toBe(200);
    expect(jsonArchive.headers.get('content-disposition')).toContain("filename*=UTF-8''json-archive.zip");
    await jsonArchive.arrayBuffer();
  });

  it('rejects shared-link downloads when allowDownload is false', async () => {
    const link = await createLink(false);
    const info = await request(`/api/download/info?key=${link.key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetIds: [assetId] }),
    });
    expect(info.status).toBe(400);

    const archive = await request(`/api/download/archive?key=${link.key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetIds: [assetId], archiveName: 'blocked' }),
    });
    expect(archive.status).toBe(400);
  });
});
