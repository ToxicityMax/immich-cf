import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { authRequest, createTestAdmin, request, setupDatabase, uploadTestAsset } from './helpers';
import { createServiceContext } from '../src/context';
import { TagRepository } from '../src/repositories/tag.repository';

const json = (body: unknown) => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('Organization contracts', () => {
  beforeAll(async () => {
    await setupDatabase();
  });

  const createUser = async (adminToken: string) => {
    const email = `organization-${crypto.randomUUID()}@test.com`;
    const password = 'password123';
    const create = await authRequest('/api/admin/users', adminToken, {
      method: 'POST',
      ...json({ email, password, name: 'Organization User' }),
    });
    expect(create.status).toBe(200);
    const user = (await create.json()) as any;
    const login = await request('/api/auth/login', {
      method: 'POST',
      ...json({ email, password }),
    });
    expect(login.status).toBe(200);
    return { id: user.id as string, token: ((await login.json()) as any).accessToken as string };
  };

  const cloneAssets = async (seedId: string, count: number) => {
    const ids = Array.from({ length: count }, () => crypto.randomUUID());
    await env.DB.batch(ids.map((id) => env.DB.prepare(`
      INSERT INTO asset (
        id, ownerId, type, originalPath, fileCreatedAt, fileModifiedAt,
        checksum, localDateTime, originalFileName
      )
      SELECT ?, ownerId, type, ?, fileCreatedAt, fileModifiedAt,
             randomblob(20), localDateTime, originalFileName
      FROM asset WHERE id = ?
    `).bind(id, `organization/${id}.jpg`, seedId)));
    return ids;
  };

  it('creates, maps, renames, and advances tags on a fresh schema', async () => {
    const { token } = await createTestAdmin();
    const create = await authRequest('/api/tags', token, {
      method: 'POST',
      ...json({ name: 'Places', color: '#112233' }),
    });
    expect(create.status).toBe(201);
    const tag = (await create.json()) as any;
    expect(tag).toEqual({
      id: expect.any(String),
      name: 'Places',
      value: 'Places',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      color: '#112233',
    });

    const before = await env.DB.prepare('SELECT "updateId", "updatedAt" FROM "tag" WHERE "id" = ?').bind(tag.id).first<any>();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const update = await authRequest(`/api/tags/${tag.id}`, token, {
      method: 'PATCH',
      ...json({ name: 'Travel' }),
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ id: tag.id, name: 'Travel', value: 'Travel', color: '#112233' });
    const after = await env.DB.prepare('SELECT "updateId", "updatedAt" FROM "tag" WHERE "id" = ?').bind(tag.id).first<any>();
    expect(after?.updateId).not.toBe(before?.updateId);
    expect(after?.updatedAt).not.toBe(before?.updatedAt);

    expect((await authRequest('/api/tags/not-a-uuid', token)).status).toBe(400);
    expect((await authRequest('/api/tags', token, { method: 'POST', ...json({ name: 'bad/name' }) })).status).toBe(400);
    expect((await authRequest('/api/tags', token, { method: 'PUT', ...json({ tags: [] }) })).status).toBe(200);
  });

  it('renames complete tag subtrees atomically and maintains closure relationships', async () => {
    const { token } = await createTestAdmin();
    const root = (await (await authRequest('/api/tags', token, {
      method: 'POST', ...json({ name: 'Places' }),
    })).json()) as any;
    const child = (await (await authRequest('/api/tags', token, {
      method: 'POST', ...json({ name: 'Europe', parentId: root.id }),
    })).json()) as any;
    const grandchild = (await (await authRequest('/api/tags', token, {
      method: 'POST', ...json({ name: 'France', parentId: child.id }),
    })).json()) as any;

    const rename = await authRequest(`/api/tags/${root.id}`, token, {
      method: 'PATCH', ...json({ name: 'Travel' }),
    });
    expect(rename.status).toBe(200);
    const rows = await env.DB.prepare('SELECT id, value FROM tag WHERE id IN (?, ?, ?) ORDER BY value')
      .bind(root.id, child.id, grandchild.id).all<{ id: string; value: string }>();
    expect(rows.results.map(({ value }) => value)).toEqual(['Travel', 'Travel/Europe', 'Travel/Europe/France']);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM tag_closure WHERE id_ancestor = ?')
      .bind(root.id).first<number>('count')).toBe(3);

    await env.DB.prepare(`
      CREATE TRIGGER fail_child_rename BEFORE UPDATE ON tag
      WHEN OLD.id = '${child.id}'
      BEGIN SELECT RAISE(ABORT, 'rename failure'); END
    `).run();
    try {
      const failed = await authRequest(`/api/tags/${root.id}`, token, {
        method: 'PATCH', ...json({ name: 'Failed' }),
      });
      expect(failed.status).toBe(500);
      const unchanged = await env.DB.prepare('SELECT value FROM tag WHERE id IN (?, ?, ?) ORDER BY value')
        .bind(root.id, child.id, grandchild.id).all<{ value: string }>();
      expect(unchanged.results.map(({ value }) => value)).toEqual(['Travel', 'Travel/Europe', 'Travel/Europe/France']);
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_child_rename').run();
    }

    const repository = new TagRepository(createServiceContext(env as any).db, env.DB);
    await expect(repository.reparent(root.id, grandchild.id)).rejects.toThrow(/descendant/);
    await repository.reparent(child.id, null);
    expect(await env.DB.prepare('SELECT value FROM tag WHERE id = ?').bind(child.id).first<string>('value')).toBe('Europe');
    expect(await env.DB.prepare('SELECT value FROM tag WHERE id = ?').bind(grandchild.id).first<string>('value'))
      .toBe('Europe/France');
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM tag_closure WHERE id_ancestor = ? AND id_descendant = ?')
      .bind(root.id, grandchild.id).first<number>('count')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM tag_closure WHERE id_ancestor = ?')
      .bind(child.id).first<number>('count')).toBe(2);
  });

  it('bulk-tags more than 100 assets with upstream new-pair count semantics', async () => {
    const { token } = await createTestAdmin();
    const seedId = await uploadTestAsset(token, crypto.randomUUID());
    const assetIds = await cloneAssets(seedId, 101);
    const firstTag = (await (await authRequest('/api/tags', token, {
      method: 'POST', ...json({ name: 'Bulk One' }),
    })).json()) as any;
    const secondTag = (await (await authRequest('/api/tags', token, {
      method: 'POST', ...json({ name: 'Bulk Two' }),
    })).json()) as any;
    const body = { tagIds: [firstTag.id, secondTag.id], assetIds };

    const first = await authRequest('/api/tags/assets', token, { method: 'PUT', ...json(body) });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ count: 202 });
    const duplicate = await authRequest('/api/tags/assets', token, { method: 'PUT', ...json(body) });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ count: 0 });
  });

  it('uses the v3 memory query, mutation, and response contracts', async () => {
    const { token } = await createTestAdmin();
    const assetId = await uploadTestAsset(token, crypto.randomUUID());
    const memoryAt = '2020-01-02T03:04:05.000Z';
    const create = await authRequest('/api/memories', token, {
      method: 'POST',
      ...json({
        type: 'on_this_day',
        data: { year: 2020 },
        memoryAt,
        showAt: '2020-01-01T00:00:00.000Z',
        hideAt: '2099-01-01T00:00:00.000Z',
        assetIds: [assetId],
      }),
    });
    expect(create.status).toBe(201);
    const memory = (await create.json()) as any;
    expect(memory).toMatchObject({
      id: expect.any(String),
      data: { year: 2020 },
      isSaved: false,
      memoryAt,
      assets: [expect.objectContaining({ id: assetId, checksum: expect.any(String), isFavorite: false })],
    });
    expect(memory).not.toHaveProperty('updateId');
    expect(memory.assets[0]).not.toHaveProperty('updateId');

    const search = await authRequest(`/api/memories?id=${memory.id}&size=1&page=1&order=asc&isUpcoming=false`, token);
    expect(search.status).toBe(200);
    expect(await search.json()).toEqual([expect.objectContaining({ id: memory.id, data: { year: 2020 } })]);

    const update = await authRequest(`/api/memories/${memory.id}`, token, {
      method: 'PUT',
      ...json({ isSaved: true, seenAt: '2026-01-01T00:00:00.000Z' }),
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ id: memory.id, isSaved: true, seenAt: '2026-01-01T00:00:00.000Z' });

    expect((await authRequest('/api/memories?isSaved=maybe', token)).status).toBe(400);
    expect((await authRequest('/api/memories/not-a-uuid', token)).status).toBe(400);
    expect((await authRequest(`/api/memories/${memory.id}`, token, { method: 'PUT', ...json({}) })).status).toBe(400);
    expect((await authRequest('/api/memories', token, {
      method: 'POST',
      ...json({ type: 'on_this_day', data: { year: 999 }, memoryAt }),
    })).status).toBe(400);
  });

  it('keeps memory assets owner-scoped after partner revocation', async () => {
    const { token, userId } = await createTestAdmin();
    const other = await createUser(token);
    const ownAssetId = await uploadTestAsset(token, crypto.randomUUID());
    const otherAssetId = await uploadTestAsset(other.token, crypto.randomUUID());
    const partner = await authRequest('/api/partners', other.token, {
      method: 'POST',
      ...json({ sharedWithId: userId }),
    });
    expect(partner.status).toBe(201);

    const create = await authRequest('/api/memories', token, {
      method: 'POST',
      ...json({
        type: 'on_this_day',
        data: { year: 2020 },
        memoryAt: '2020-01-02T03:04:05.000Z',
        assetIds: [ownAssetId],
      }),
    });
    expect(create.status).toBe(201);
    const memory = (await create.json()) as any;

    const addPartnerAsset = await authRequest(`/api/memories/${memory.id}/assets`, token, {
      method: 'PUT',
      ...json({ ids: [otherAssetId] }),
    });
    expect(addPartnerAsset.status).toBe(200);
    expect(await addPartnerAsset.json()).toEqual([{ id: otherAssetId, success: false, error: 'no_permission' }]);

    await env.DB.prepare('INSERT INTO memory_asset (memoriesId, assetId) VALUES (?, ?)')
      .bind(memory.id, otherAssetId)
      .run();
    expect(((await (await authRequest(`/api/memories/${memory.id}`, token)).json()) as any).assets)
      .toEqual([expect.objectContaining({ id: ownAssetId })]);

    expect((await authRequest(`/api/partners/${userId}`, other.token, { method: 'DELETE' })).status).toBe(204);
    const afterRevocation = await authRequest(`/api/memories/${memory.id}`, token);
    expect(afterRevocation.status).toBe(200);
    expect(((await afterRevocation.json()) as any).assets).toEqual([expect.objectContaining({ id: ownAssetId })]);

    const removeCrossOwner = await authRequest(`/api/memories/${memory.id}/assets`, token, {
      method: 'DELETE',
      ...json({ ids: [otherAssetId] }),
    });
    expect(await removeCrossOwner.json()).toEqual([{ id: otherAssetId, success: false, error: 'not_found' }]);
  });

  it('handles 101 memory assets within D1 bind limits', async () => {
    const { token } = await createTestAdmin();
    const seedId = await uploadTestAsset(token, crypto.randomUUID());
    const assetIds = await cloneAssets(seedId, 101);
    const create = await authRequest('/api/memories', token, {
      method: 'POST',
      ...json({
        type: 'on_this_day',
        data: { year: 2020 },
        memoryAt: '2020-01-02T03:04:05.000Z',
        assetIds,
      }),
    });
    expect(create.status).toBe(201);
    const memory = (await create.json()) as any;
    expect(memory.assets).toHaveLength(101);

    const remove = await authRequest(`/api/memories/${memory.id}/assets`, token, {
      method: 'DELETE',
      ...json({ ids: assetIds }),
    });
    expect(remove.status).toBe(200);
    expect((await remove.json()) as any[]).toHaveLength(101);

    const add = await authRequest(`/api/memories/${memory.id}/assets`, token, {
      method: 'PUT',
      ...json({ ids: assetIds }),
    });
    expect(add.status).toBe(200);
    expect((await add.json()) as any[]).toEqual(assetIds.map((id) => ({ id, success: true })));
  });

  it('maps stacks and repairs a deleted primary asset', async () => {
    const { token } = await createTestAdmin();
    const primaryId = await uploadTestAsset(token, crypto.randomUUID());
    const secondaryId = await uploadTestAsset(token, crypto.randomUUID());
    const create = await authRequest('/api/stacks', token, {
      method: 'POST',
      ...json({ assetIds: [primaryId, secondaryId] }),
    });
    expect(create.status).toBe(201);
    const stack = (await create.json()) as any;
    expect(stack).toEqual({
      id: expect.any(String),
      primaryAssetId: primaryId,
      assets: [
        expect.objectContaining({ id: primaryId, checksum: expect.any(String), isFavorite: false }),
        expect.objectContaining({ id: secondaryId, checksum: expect.any(String), isFavorite: false }),
      ],
    });
    expect(stack).not.toHaveProperty('ownerId');
    expect(stack.assets[0]).not.toHaveProperty('updateId');
    expect((await authRequest('/api/stacks', token, {
      method: 'POST',
      ...json({ assetIds: [secondaryId, secondaryId] }),
    })).status).toBe(400);
    expect((await authRequest(`/api/stacks/${stack.id}`, token, {
      method: 'PUT',
      ...json({}),
    })).status).toBe(400);

    const remove = await authRequest('/api/assets', token, {
      method: 'DELETE',
      ...json({ ids: [primaryId] }),
    });
    expect(remove.status).toBe(204);
    expect((await authRequest('/api/trash/empty', token, { method: 'POST' })).status).toBe(200);

    const get = await authRequest(`/api/stacks/${stack.id}`, token);
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({
      id: stack.id,
      primaryAssetId: secondaryId,
      assets: [expect.objectContaining({ id: secondaryId })],
    });
    expect((await authRequest('/api/stacks/not-a-uuid', token)).status).toBe(400);
  });

  it('bulk deletes 101 stacks within D1 bind limits', async () => {
    const { token, userId } = await createTestAdmin();
    const seedId = await uploadTestAsset(token, crypto.randomUUID());
    const assetIds = await cloneAssets(seedId, 101);
    const stackIds = assetIds.map(() => crypto.randomUUID());
    await env.DB.batch(stackIds.map((id, index) => env.DB.prepare(
      'INSERT INTO stack (id, ownerId, primaryAssetId) VALUES (?, ?, ?)',
    ).bind(id, userId, assetIds[index])));

    const response = await authRequest('/api/stacks', token, {
      method: 'DELETE',
      ...json({ ids: stackIds }),
    });
    expect(response.status).toBe(204);
    let remaining = 0;
    for (let i = 0; i < stackIds.length; i += 99) {
      const chunk = stackIds.slice(i, i + 99);
      const result = await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM stack WHERE ownerId = ? AND id IN (${chunk.map(() => '?').join(', ')})`,
      ).bind(userId, ...chunk).first<{ count: number }>();
      remaining += Number(result?.count);
    }
    expect(remaining).toBe(0);
  });

  it('validates partner and activity contracts and returns partner creation as 201', async () => {
    const { token } = await createTestAdmin();
    const email = `partner-${crypto.randomUUID()}@test.com`;
    const createUser = await authRequest('/api/admin/users', token, {
      method: 'POST',
      ...json({ email, password: 'password123', name: 'Partner' }),
    });
    const user = (await createUser.json()) as any;

    const partner = await authRequest('/api/partners', token, {
      method: 'POST',
      ...json({ sharedWithId: user.id }),
    });
    expect(partner.status).toBe(201);
    expect(await partner.json()).toMatchObject({ id: user.id, inTimeline: false });
    expect((await authRequest('/api/partners?direction=invalid', token)).status).toBe(400);
    expect((await authRequest('/api/partners/not-a-uuid', token, { method: 'DELETE' })).status).toBe(400);

    expect((await authRequest('/api/activities?albumId=not-a-uuid', token)).status).toBe(400);
    expect((await authRequest('/api/activities/not-a-uuid', token, { method: 'DELETE' })).status).toBe(400);
    expect((await request('/api/activities?albumId=not-a-uuid')).status).toBe(401);
  });
});
