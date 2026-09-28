import { describe, it, expect, beforeAll } from 'vitest';
import { authRequest, createTestImage, request, setupDatabase } from './helpers';

describe('Timeline v3 smoke path', () => {
  beforeAll(async () => {
    await setupDatabase();
  });

  it('creates an admin and serves an uploaded image through timeline and media endpoints', async () => {
    const email = 'timeline-admin@test.com';
    const password = 'password123';
    const fileCreatedAt = '2026-04-15T12:34:56.000Z';
    const image = createTestImage();

    const signupResponse = await request('/api/auth/admin-sign-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Timeline Admin' }),
    });
    expect(signupResponse.status).toBe(201);
    const admin = (await signupResponse.json()) as { id: string };
    expect(admin.id).toEqual(expect.any(String));

    const loginResponse = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(loginResponse.status).toBe(200);
    const login = (await loginResponse.json()) as { accessToken: string; userId: string };
    expect(login).toMatchObject({ accessToken: expect.any(String), userId: admin.id });

    const formData = new FormData();
    formData.append('assetData', new File([image], 'timeline-smoke.jpg', { type: 'image/jpeg' }));
    formData.append('fileCreatedAt', fileCreatedAt);
    formData.append('fileModifiedAt', fileCreatedAt);
    const uploadResponse = await authRequest('/api/assets', login.accessToken, {
      method: 'POST',
      body: formData,
    });
    expect(uploadResponse.status).toBe(201);
    const upload = (await uploadResponse.json()) as { id: string };
    expect(upload.id).toEqual(expect.any(String));

    const bucketPath = '/api/timeline/bucket?timeBucket=2026-04-01T00%3A00%3A00.000Z';
    for (const path of [
      '/api/timeline/buckets',
      bucketPath,
      `/api/assets/${upload.id}/thumbnail`,
      `/api/assets/${upload.id}/original`,
    ]) {
      expect((await request(path)).status).toBe(401);
    }

    const bucketsResponse = await authRequest('/api/timeline/buckets', login.accessToken);
    expect(bucketsResponse.status).toBe(200);
    expect(await bucketsResponse.json()).toEqual([{ timeBucket: '2026-04-01', count: 1 }]);

    const bucketResponse = await authRequest(bucketPath, login.accessToken);
    expect(bucketResponse.status).toBe(200);
    expect(await bucketResponse.json()).toEqual({
      id: [upload.id],
      ownerId: [admin.id],
      ratio: [1],
      isFavorite: [false],
      visibility: ['timeline'],
      isTrashed: [false],
      isImage: [true],
      thumbhash: [null],
      fileCreatedAt: [fileCreatedAt],
      localOffsetHours: [0],
      createdAt: [expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)],
      duration: [null],
      projectionType: [null],
      livePhotoVideoId: [null],
      city: [null],
      country: [null],
      latitude: [0],
      longitude: [0],
    });

    const thumbnailResponse = await authRequest(`/api/assets/${upload.id}/thumbnail`, login.accessToken);
    expect(thumbnailResponse.status).toBe(200);
    expect(thumbnailResponse.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await thumbnailResponse.arrayBuffer())).toEqual(new Uint8Array(image));

    const originalResponse = await authRequest(`/api/assets/${upload.id}/original`, login.accessToken);
    expect(originalResponse.status).toBe(200);
    expect(originalResponse.headers.get('content-type')).toBe('image/jpeg');
    expect(originalResponse.headers.get('content-disposition')).toBe('attachment; filename="timeline-smoke.jpg"');
    expect(new Uint8Array(await originalResponse.arrayBuffer())).toEqual(new Uint8Array(image));
  });
});
