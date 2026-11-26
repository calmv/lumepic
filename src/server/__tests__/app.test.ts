import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageItem } from '../../shared/types.js';
import { createApp } from '../app.js';
import { backfillThumbnailSizes, runCleanupTask } from '../cleanup.js';
import { getEnvConfig } from '../config.js';
import { GalleryDB } from '../db.js';
import { LocalStorageDriver } from '../storage.js';
import { processUploadedImage } from '../imagePipeline.js';
import { RateLimiter } from '../security.js';

const origin = 'http://localhost';
const password = 'example-local-password';
const imageOptions = { autoWebp: false, webpQuality: 84, stripExif: true };

function png(width = 120, height = 80, background = '#4b90c5') {
  return sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
}

function cookieFrom(response: Response) {
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('Session cookie missing');
  return cookie;
}

describe('LumePic API, privacy and storage', () => {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  let temp: string;
  let db: GalleryDB;
  let storage: LocalStorageDriver;
  let config: ReturnType<typeof getEnvConfig>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(tempRoot, 'lumepic-test-'));
    config = getEnvConfig({
      dataDir: temp, hardMaxUploadMb: 200, publicUrl: '', initialAdminPassword: '',
      setupToken: '', trustProxy: false, trustedProxyIps: [],
    });
    storage = new LocalStorageDriver(temp);
    storage.ensureDirectories();
    db = new GalleryDB(path.join(storage.dbDir, 'gallery.db'), config);
    app = createApp({ config, db, storage, connection: () => ({ remoteAddress: '127.0.0.1' }) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    const directory = fs.realpathSync.native(temp);
    if (path.dirname(directory).toLowerCase() !== tempRoot.toLowerCase() ||
        !path.basename(directory).startsWith('lumepic-test-')) throw new Error('Unexpected test directory');
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function request(route: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (!['GET', 'HEAD'].includes(init.method ?? 'GET') && !headers.has('Origin')) headers.set('Origin', origin);
    return app.request(new URL(route, origin), { ...init, headers });
  }

  function json(route: string, method: string, value: object, cookie?: string) {
    return request(route, {
      method, body: JSON.stringify(value),
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    });
  }

  async function setup() {
    const response = await json('/api/auth/setup', 'POST', { password });
    expect(response.status).toBe(200);
    return cookieFrom(response);
  }

  function upload(bytes: Buffer, options: { cookie?: string; token?: string; name?: string;
    type?: string; albumId?: string; guest?: boolean } = {}) {
    const form = new FormData();
    form.append('file', new File([new Uint8Array(bytes)], options.name ?? '照片.png', { type: options.type ?? 'image/png' }));
    if (options.albumId) form.append('albumId', options.albumId);
    const headers = new Headers();
    if (options.cookie) headers.set('Cookie', options.cookie);
    if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
    return request(options.guest ? '/api/upload?guest=1' : '/api/upload', { method: 'POST', body: form, headers });
  }

  async function imageFrom(response: Response): Promise<ImageItem> {
    if (response.status !== 200) {
      throw new Error(`Upload failed ${response.status} ${await response.text()}`);
    }
    const { image, url } = await response.json() as { image: ImageItem; url: string };
    expect(url).toBe(image.shareUrl);
    expect(new URL(url).pathname.startsWith(image.uploaderType === 'guest' ? '/g/' : '/i/')).toBe(true);
    return image;
  }

  async function album(name: string, cookie: string): Promise<string> {
    const response = await json('/api/albums', 'POST', { name }, cookie);
    expect(response.status).toBe(200);
    return (await response.json() as { album: { id: string } }).album.id;
  }

  it('creates administrator links at upload, protects management URLs, and handles HEAD and 304', async () => {
    const publicResponse = await request('/api/public-config');
    expect(publicResponse.headers.get('cache-control')).toBe('no-store');
    expect(await publicResponse.json()).toMatchObject({ initialized: false, isAdmin: false, allowGuestUpload: false });
    expect((await json('/api/auth/setup', 'POST', { password: 'too-short' })).status).toBe(400);
    const sample = await png();
    expect((await upload(sample)).status).toBe(401);
    const cookie = await setup();
    const image = await imageFrom(await upload(sample, { cookie }));
    expect(image).toMatchObject({ width: 120, height: 80, mimeType: 'image/png', originalName: '照片.png' });
    expect(image.thumbhash.length).toBeGreaterThan(5);
    expect((await request(image.url)).status).toBe(401);
    expect((await request(`/i/${image.filename}`)).status).toBe(404);
    expect((await request(new URL(image.shareUrl!).pathname.replace('/i/', '/g/'))).status).toBe(404);
    const internal = await request(image.url, { headers: { Cookie: cookie } });
    expect(internal.headers.get('cache-control')).toBe('no-store');
    await internal.arrayBuffer();

    const shared = image;
    const served = await request(shared.shareUrl!);
    expect(served.status).toBe(200);
    expect(served.headers.get('cache-control')).toBe('public, no-cache, max-age=0, must-revalidate');
    expect(served.headers.get('vary')).toBe('Referer');
    const tag = served.headers.get('etag')!;
    const bytes = await served.arrayBuffer();

    const head = await request(shared.shareUrl!, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    const refreshed = await request(shared.shareUrl!, { headers: { 'If-None-Match': tag } });
    expect(refreshed.status).toBe(304);
    expect(refreshed.headers.get('etag')).toBe(tag);
    expect(refreshed.headers.get('cache-control')).toContain('must-revalidate');
    const download = await request(`${shared.shareUrl}?download=1`);
    expect(download.headers.get('content-disposition')).toContain(encodeURIComponent('照片.png'));
    await download.arrayBuffer();
    const thumb = await request(shared.shareThumbUrl!);
    expect(thumb.headers.get('content-type')).toBe('image/webp');
    await thumb.arrayBuffer();

    expect((await json('/api/settings', 'PATCH', { hotlinkProtection: true }, cookie)).status).toBe(200);
    const blocked = await request(shared.shareUrl!, { headers: { 'If-None-Match': tag } });
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get('cache-control')).toBe('no-store');
    expect((await json(`/api/images/${image.id}/share`, 'PUT', { enabled: false }, cookie)).status).toBe(200);
    expect((await request(shared.shareUrl!, { headers: { 'If-None-Match': tag } })).status).toBe(404);
  });

  it('sanitizes, persists and resets an administrator-uploaded site icon', async () => {
    const cookie = await setup();
    const asset = '/api/settings/site-icon';
    const uploadIcon = (bytes: Uint8Array<ArrayBuffer>, name: string, session?: string) => {
      const form = new FormData();
      form.append('file', new File([bytes], name));
      return request(asset, { method: 'PUT', body: form, headers: session ? { Cookie: session } : {} });
    };
    const jpeg = new Uint8Array(await sharp(await png(256, 128))
      .withExif({ IFD0: { Make: 'Test camera' } }).jpeg().toBuffer());
    expect((await uploadIcon(jpeg, 'icon.jpg')).status).toBe(401);
    expect((await uploadIcon(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'icon.svg', cookie))
      .status).toBe(400);

    const saved = await uploadIcon(jpeg, 'icon.jpg', cookie);
    expect(saved.status).toBe(200);
    const { publicConfig: { siteIconUrl } } = await saved.json() as { publicConfig: { siteIconUrl: string } };
    expect(siteIconUrl).toMatch(/^\/api\/site-icon\/[a-f0-9]{64}\.png$/);
    expect(await (await request('/api/public-config')).json()).toMatchObject({ siteIconUrl });
    const served = await request(siteIconUrl);
    expect(served.headers.get('content-type')).toBe('image/png');
    const meta = await sharp(Buffer.from(await served.arrayBuffer())).metadata();
    expect(meta).toMatchObject({ format: 'png', width: 128, height: 64 });
    expect(meta.exif).toBeUndefined();
    expect(db.getStatsCounts().totalImages).toBe(0);

    const reopened = new GalleryDB(path.join(storage.dbDir, 'gallery.db'), config);
    try {
      expect(reopened.getSiteIconUrl()).toBe(siteIconUrl);
    } finally {
      reopened.close();
    }
    expect((await request(asset, { method: 'DELETE' })).status).toBe(401);
    const reset = await request(asset, { method: 'DELETE', headers: { Cookie: cookie } });
    expect(await reset.json()).toMatchObject({ publicConfig: { siteIconUrl: null } });
    expect((await request(siteIconUrl)).status).toBe(404);
  });

  it('closes the image file when the client cancels a download', async () => {
    const cookie = await setup();
    const pixels = randomBytes(256 * 256 * 3);
    const pngBuffer = await sharp(pixels, { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer();
    const image = await imageFrom(await upload(pngBuffer, { cookie }));
    const open = storage.openUploadFile.bind(storage);
    let released!: () => void;
    const closed = new Promise<void>((resolve) => { released = resolve; });
    vi.spyOn(storage, 'openUploadFile').mockImplementation(async (relativePath) => {
      const handle = await open(relativePath);
      if (handle) {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          await close();
          released();
        });
      }
      return handle;
    });
    const controller = new AbortController();
    const response = await request(image.shareUrl!, { signal: controller.signal });
    expect(response.status).toBe(200);
    controller.abort();
    await closed;
    await expect(response.arrayBuffer()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('handles fresh remote setup through the trusted proxy and accepts only one initialization', async () => {
    const secret = 'local-test-initialization-token-long-enough';
    const remoteApp = createApp({
      config: { ...config, setupToken: secret, trustProxy: true, trustedProxyIps: ['172.30.249.2'] },
      db, storage, connection: () => ({ remoteAddress: '172.30.249.2' }),
    });
    const remoteJson = (setupToken?: string) => remoteApp.request('http://app:3000/api/auth/setup', {
      method: 'POST',
      headers: {
        'X-Forwarded-Host': 'img.example.test', 'X-Forwarded-Proto': 'https',
        'X-Forwarded-For': '192.0.2.30', 'Content-Type': 'application/json', Origin: 'https://img.example.test',
      },
      body: JSON.stringify({ password, setupToken }),
    });
    expect((await remoteJson()).status).toBe(403);
    const attempts = await Promise.all([remoteJson(secret), remoteJson(secret)]);
    expect(attempts.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(attempts.find((response) => response.ok)?.headers.get('set-cookie')).toContain('Secure');
  });

  it('rejects non-local HTTP transport and checks the origin of session writes', async () => {
    const remote = createApp({ config, db, storage, connection: () => ({ remoteAddress: '192.0.2.32' }) });
    expect((await remote.request('http://img.example.test/api/public-config')).status).toBe(403);
    const session = await setup();
    const response = await request('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ allowGuestUpload: false }),
      headers: { Cookie: session, 'Content-Type': 'application/json', Origin: 'http://other.example.test' },
    });
    expect(response.status).toBe(403);
    expect((await json('/api/settings', 'PATCH', { allowGuestUpload: true }, session)).status).toBe(200);
  });

  it('copies guest uploads to independent administrator links and keeps original expiry and storage references', async () => {
    const cookie = await setup();
    const target = await album('精选收藏', cookie);
    const rename = await json(`/api/albums/${target}`, 'PATCH', { name: '精选图片' }, cookie);
    expect(rename.status).toBe(200);
    expect((await json('/api/settings', 'PATCH', { allowGuestUpload: true, guestRateLimitPerMin: 10 }, cookie)).status).toBe(200);
    const sample = await png(90, 90);
    const first = await imageFrom(await upload(sample, { cookie, guest: true }));
    const second = await imageFrom(await upload(sample));
    expect(first).toMatchObject({ uploaderType: 'guest', mimeType: 'image/webp' });
    expect(first.expiresAt).not.toBeNull();
    expect(new URL(first.shareThumbUrl!).pathname).toMatch(/^\/g\/thumb\//);
    expect(first.shareUrl).not.toBe(second.shareUrl);
    expect(db.getImageById(first.id)!.storagePath).toBe(db.getImageById(second.id)!.storagePath);
    expect((await request(new URL(first.shareUrl!).pathname.replace('/g/', '/i/'))).status).toBe(404);
    expect((await request(new URL(first.shareThumbUrl!).pathname.replace('/g/', '/i/'))).status).toBe(404);
    expect((await request('/api/images')).status).toBe(401);
    expect((await request(`/api/guest/images/${first.id}`, { method: 'DELETE' })).status).toBe(403);
    const copy = await json(`/api/images/${first.id}`, 'PATCH', { promoteToAdmin: true, albumId: target }, cookie);
    expect(copy.status).toBe(200);
    const { image: saved } = await copy.json() as { image: ImageItem };
    expect(saved.id).not.toBe(first.id);
    expect(saved).toMatchObject({
      uploaderType: 'admin', expiresAt: null, albumId: target, albumName: '精选图片',
      shareUrl: expect.stringMatching(/\/i\//), shareThumbUrl: expect.stringMatching(/\/i\/thumb\//),
    });
    expect(saved.shareUrl).not.toBe(first.shareUrl);
    expect(db.getImageById(first.id)).toMatchObject({ uploaderType: 'guest', expiresAt: first.expiresAt, albumId: null });
    expect(db.getImageById(saved.id)!.storagePath).toBe(db.getImageById(first.id)!.storagePath);

    const batch = await json('/api/images/batch', 'POST', {
      action: 'promote', ids: [first.id, second.id], albumId: target,
    }, cookie);
    expect(batch.status).toBe(200);
    const { items } = await batch.json() as { items: ImageItem[] };
    expect(items.map((item) => item.id)).toContain(saved.id);
    expect(items).toHaveLength(2);
    expect(db.listImages().total).toBe(4);
    for (const url of [first.shareUrl!, first.shareThumbUrl!, saved.shareUrl!, saved.shareThumbUrl!]) {
      const live = await request(url);
      expect(live.status).toBe(200);
      await live.arrayBuffer();
    }

    db.db.prepare('UPDATE images SET expires_at = ? WHERE id = ?').run(new Date(0).toISOString(), first.id);
    expect((await request(first.shareUrl!)).status).toBe(404);
    expect(await runCleanupTask(db, storage, 'all_guest')).toBe(2);
    expect((await request(second.shareUrl!)).status).toBe(404);
    const delivered = await request(saved.shareUrl!);
    expect(delivered.status).toBe(200);
    await delivered.arrayBuffer();
  });

  it('keeps existing guest /i/ URLs compatible while issuing new guests only /g/ URLs', async () => {
    const cookie = await setup();
    expect((await json('/api/settings', 'PATCH', { allowGuestUpload: true }, cookie)).status).toBe(200);
    const sample = await png();
    const original = await imageFrom(await upload(sample));
    const oldLink = new URL(original.shareUrl!).pathname.replace('/g/', '/i/');
    const oldThumb = new URL(original.shareThumbUrl!).pathname.replace('/g/', '/i/');

    db.db.exec('ALTER TABLE images DROP COLUMN legacy_guest_share');
    db.close();
    db = new GalleryDB(path.join(storage.dbDir, 'gallery.db'), config);
    app = createApp({ config, db, storage, connection: () => ({ remoteAddress: '127.0.0.1' }) });
    for (const url of [oldLink, oldThumb, original.shareUrl!, original.shareThumbUrl!]) {
      const result = await request(url);
      expect(result.status).toBe(200);
      await result.arrayBuffer();
    }
    const fresh = await imageFrom(await upload(sample));
    expect((await request(new URL(fresh.shareUrl!).pathname.replace('/g/', '/i/'))).status).toBe(404);
    expect((await json(`/api/images/${original.id}/share`, 'PUT', { enabled: false }, cookie)).status).toBe(200);
    expect((await request(oldLink)).status).toBe(404);
    const issued = await json(`/api/images/${original.id}/share`, 'PUT', { enabled: true }, cookie);
    expect(issued.status).toBe(200);
    const { image } = await issued.json() as { image: ImageItem };
    expect((await request(new URL(image.shareUrl!).pathname.replace('/g/', '/i/'))).status).toBe(404);
  });

  it('uses upload-only expiring tokens and revokes them on password change', async () => {
    const cookie = await setup();
    const response = await json('/api/tokens', 'POST', { name: 'PicGo' }, cookie);
    const { item, rawToken } = await response.json() as { item: { expiresAt: string }; rawToken: string };
    expect(Date.parse(item.expiresAt)).toBeGreaterThan(Date.now());
    const auth = { Authorization: `Bearer ${rawToken}` };
    expect((await request('/api/images', { headers: auth })).status).toBe(401);
    expect((await request('/api/albums', { headers: auth })).status).toBe(401);
    const sample = await png();
    const published = await imageFrom(await upload(sample, { token: rawToken }));
    expect(published.shareUrl).toBe(published.url);
    const rotation = await json('/api/auth/password', 'POST', { currentPassword: password, newPassword: ' revised local password ' }, cookie);
    expect(rotation.status).toBe(200);
    expect((await request('/api/images', { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await upload(sample, { token: rawToken })).status).toBe(401);
    expect((await json('/api/auth/login', 'POST', { password: ' revised local password ' })).status).toBe(200);
  });

  it('issues custom and permanent tokens and still rejects expired or revoked tokens', async () => {
    const cookie = await setup();
    const makeToken = (name: string, expiresInDays: number) =>
      json('/api/tokens', 'POST', { name, expiresInDays }, cookie);

    expect((await makeToken('Invalid', -1)).status).toBe(400);
    expect((await makeToken('Invalid', 1.5)).status).toBe(400);
    const customResponse = await makeToken('17 days', 17);
    expect(customResponse.status).toBe(200);
    const custom = await customResponse.json() as {
      item: { id: string; expiresAt: string; createdAt: string }; rawToken: string;
    };
    expect(Date.parse(custom.item.expiresAt) - Date.parse(custom.item.createdAt)).toBe(17 * 86_400_000);

    const permanentResponse = await makeToken('Permanent', 0);
    expect(permanentResponse.status).toBe(200);
    const permanent = await permanentResponse.json() as {
      item: { id: string; expiresAt: null }; rawToken: string;
    };
    expect(permanent.item.expiresAt).toBeNull();
    const sample = await png();
    expect((await upload(sample, { token: custom.rawToken })).status).toBe(200);
    db.db.prepare('UPDATE api_tokens SET expires_at = ? WHERE id = ?')
      .run(new Date(0).toISOString(), custom.item.id);
    expect((await upload(sample, { token: custom.rawToken })).status).toBe(401);
    expect((await upload(sample, { token: permanent.rawToken })).status).toBe(200);
    expect(await (await request('/api/tokens', { headers: { Cookie: cookie } })).json())
      .toMatchObject({ items: expect.arrayContaining([
        expect.objectContaining({ ...permanent.item, lastUsedAt: expect.any(String) }),
      ]) });
    expect((await request(`/api/tokens/${permanent.item.id}`, {
      method: 'DELETE', headers: { Cookie: cookie },
    })).status).toBe(200);
    expect((await upload(sample, { token: permanent.rawToken })).status).toBe(401);
  });

  it('publishes a batch atomically from the copy action', async () => {
    const cookie = await setup();
    const first = await imageFrom(await upload(await png(), { cookie }));
    const second = await imageFrom(await upload(await png(80, 110), { cookie }));
    const share = (ids: string[]) => json('/api/images/batch', 'POST', { action: 'share', ids }, cookie);
    for (const image of [first, second]) {
      expect((await json(`/api/images/${image.id}/share`, 'PUT', { enabled: false }, cookie)).status).toBe(200);
    }

    expect((await share([first.id, '0123456789abcdef'])).status).toBe(409);
    expect(db.getImageById(first.id)?.shareKey).toBeNull();
    const response = await share([first.id, second.id]);
    expect(response.status).toBe(200);
    const { items } = await response.json() as { items: ImageItem[] };
    expect(items.map((item) => item.id)).toEqual([first.id, second.id]);
    for (const item of items) {
      expect(item.shareUrl).toBeTruthy();
      const published = await request(item.shareUrl!);
      expect(published.status).toBe(200);
      await published.arrayBuffer();
    }
  });

  it('produces a full ZIP with correct size and CRC and limits permanent deletion to trash', async () => {
    const cookie = await setup();
    const first = await imageFrom(await upload(await png(), { name: 'same.png', cookie }));
    const second = await imageFrom(await upload(await png(70, 55), { name: 'same.png', cookie }));
    const exportZip = (ids: string[]) => json('/api/images/download-zip', 'POST', { ids }, cookie);
    const response = await exportZip([first.id, second.id]);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    const zip = Buffer.from(await response.arrayBuffer());
    const end = zip.length - 22;
    expect(zip.readUInt32LE(end)).toBe(0x06054b50);
    expect(zip.readUInt16LE(end + 10)).toBe(2);
    let central = zip.readUInt32LE(end + 16);
    for (const expected of ['same.png', 'same (1).png']) {
      expect(zip.readUInt32LE(central)).toBe(0x02014b50);
      const size = zip.readUInt32LE(central + 24);
      const length = zip.readUInt16LE(central + 28);
      const location = zip.readUInt32LE(central + 42);
      expect(zip.toString('utf8', central + 46, central + 46 + length)).toBe(expected);
      const offset = location + 30 + zip.readUInt16LE(location + 26);
      expect(zip.readUInt32LE(central + 16)).toBe(crc32(zip.subarray(offset, offset + size)));
      central += 46 + length;
    }
    expect((await exportZip([first.id, '0123456789abcdef'])).status).toBe(409);
    const record = db.getImageById(first.id)!;
    const remove = (permanent = false) => request(`/api/images/${first.id}${permanent ? '?permanent=true' : ''}`,
      { method: 'DELETE', headers: { Cookie: cookie } });
    expect((await remove(true)).status).toBe(409);
    expect((await remove()).status).toBe(200);
    expect((await request(first.shareUrl!)).status).toBe(404);
    const privatePreview = await request(first.url, { headers: { Cookie: cookie } });
    expect(privatePreview.status).toBe(200);
    await privatePreview.arrayBuffer();
    const restore = () => json('/api/images/batch', 'POST', { action: 'restore', ids: [first.id] }, cookie);
    expect((await restore()).status).toBe(200);
    expect((await remove()).status).toBe(200);
    expect((await remove(true)).status).toBe(200);
    expect(fs.existsSync(storage.getAbsolutePath(record.storagePath))).toBe(false);
    expect(fs.existsSync(storage.getAbsolutePath(record.thumbPath))).toBe(false);
  });

  it('uses only linked images in selected albums and disables random draws after the last album is removed', async () => {
    const cookie = await setup();
    const a = await album('壁纸', cookie);
    const b = await album('内部截图', cookie);
    expect((await request('/api/random')).status).toBe(403);
    expect((await json('/api/settings', 'PATCH', { randomApiEnabled: true }, cookie)).status).toBe(400);
    const publicImage = await imageFrom(await upload(await png(160, 90), { cookie, albumId: a }));
    const revoked = await imageFrom(await upload(await png(90, 160), { cookie, albumId: a }));
    expect((await json(`/api/images/${revoked.id}/share`, 'PUT', { enabled: false }, cookie)).status).toBe(200);
    await imageFrom(await upload(await png(90, 160, 'red'), { cookie, albumId: b }));
    expect((await json('/api/settings', 'PATCH', { randomApiEnabled: true, randomApiAlbumIds: [a] }, cookie)).status).toBe(200);
    const redirect = await request('/api/random', { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe(publicImage.shareUrl);
    const result = await request('/random?format=json&orient=landscape');
    expect(await result.json()).not.toHaveProperty('originalName');
    expect((await request('/api/random?orient=portrait')).status).toBe(404);
    expect((await request(`/api/albums/${a}`, { method: 'DELETE', headers: { Cookie: cookie } })).status).toBe(200);
    expect((await request('/api/random')).status).toBe(403);
  });

  it('deduplicates bytes without discarding different album or filename metadata and counts thumbnails', async () => {
    const cookie = await setup();
    const a = await album('A', cookie);
    const b = await album('B', cookie);
    const bytes = await png();
    const first = await imageFrom(await upload(bytes, { cookie, albumId: a, name: 'A.png' }));
    const second = await imageFrom(await upload(bytes, { cookie, albumId: b, name: 'B.png' }));
    expect(second).toMatchObject({ albumId: b, originalName: 'B.png' });
    expect(second.id).not.toBe(first.id);
    const files = db.getImageById(second.id)!;
    expect(files.storagePath).toBe(db.getImageById(first.id)!.storagePath);
    expect(db.getTotalUniqueBytes()).toBe(second.sizeBytes + files.thumbSizeBytes!);
    expect((await json('/api/settings', 'PATCH', { maxStorageGb: 0.0000001 }, cookie)).status).toBe(200);
    const duplicate = await upload(bytes, { cookie, albumId: b, name: 'B.png' });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ deduplicated: true, image: { id: second.id } });
    expect((await upload(await png(220, 140, 'red'), { cookie })).status).toBe(507);
  });

  it('validates settings as one update, checks disk readiness and makes the environment URL authoritative', async () => {
    expect((await request('/api/health')).status).toBe(200);
    const cookie = await setup();
    const response = await json('/api/settings', 'PATCH', { siteTitle: 'New title', allowGuestUpload: 'false' }, cookie);
    expect(response.status).toBe(400);
    expect(db.getAdminSettings(200)).toMatchObject({ siteTitle: config.siteTitle, allowGuestUpload: false });
    expect((await json('/api/settings', 'PATCH', { publicUrl: 'https://old.example.test' }, cookie)).status).toBe(200);
    app = createApp({ config: { ...config, publicUrl: 'https://new.example.test' },
      db, storage, connection: () => ({ remoteAddress: '127.0.0.1' }) });
    expect(await (await request('/api/public-config')).json()).toMatchObject({ publicUrl: 'https://new.example.test' });
    expect((await json('/api/settings', 'PATCH', { publicUrl: 'https://changed.example.test' }, cookie)).status).toBe(409);
    vi.spyOn(storage, 'checkWritable').mockRejectedValueOnce(new Error('not writable'));
    expect((await request('/api/health')).status).toBe(503);
  });

  it('rejects an ordinary file above the configured size and requires a referer with hotlink protection enabled', async () => {
    const cookie = await setup();
    expect((await json('/api/settings', 'PATCH', { adminMaxSizeMb: 1 }, cookie)).status).toBe(200);
    const form = new FormData();
    form.append('file', new File([new Uint8Array(1024 * 1024 + 1)], 'oversize.png', { type: 'image/png' }));
    const oversize = await request('/api/upload', { method: 'POST', body: form, headers: { Cookie: cookie } });
    expect(oversize.status).toBe(413);
    const image = await imageFrom(await upload(await png(), { cookie }));
    expect((await json('/api/settings', 'PATCH', { hotlinkProtection: true, allowedReferers: 'blog.example.test' }, cookie)).status).toBe(200);
    expect((await request(image.shareUrl!)).status).toBe(403);
    const allowed = await request(image.shareUrl!, { headers: { Referer: 'https://blog.example.test/' } });
    expect(allowed.status).toBe(200);
    await allowed.arrayBuffer();
  });

  it('retains tracked cleanup after a filesystem error and skips recovery of expired trash', async () => {
    const cookie = await setup();
    await json('/api/settings', 'PATCH', { allowGuestUpload: true }, cookie);
    const image = await imageFrom(await upload(await png()));
    const record = db.getImageById(image.id)!;
    db.softDeleteImages([image.id]);
    db.db.prepare('UPDATE images SET expires_at = ? WHERE id = ?').run(new Date(0).toISOString(), image.id);
    expect((await json('/api/images/batch', 'POST', { action: 'restore', ids: [image.id] }, cookie)).status).toBe(409);
    const remove = vi.spyOn(storage, 'deleteFileQuietly').mockRejectedValueOnce(new Error('simulated I/O error'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runCleanupTask(db, storage)).toBe(1);
    expect(db.getPendingFilePairs('')).toHaveLength(1);
    remove.mockRestore();
    await runCleanupTask(db, storage);
    expect(db.getPendingFilePairs('')).toHaveLength(0);
    expect(fs.existsSync(storage.getAbsolutePath(record.storagePath))).toBe(false);
  });

  it('removes a partially written upload and allows a clean retry', async () => {
    const cookie = await setup();
    const bytes = await png();
    let partialPath = '';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(storage, 'writeImageFiles').mockImplementationOnce(async (relativePath, original) => {
      partialPath = storage.getAbsolutePath(relativePath);
      fs.mkdirSync(path.dirname(partialPath), { recursive: true });
      fs.writeFileSync(partialPath, original);
      throw new Error('simulated thumbnail write failure');
    });
    expect((await upload(bytes, { cookie })).status).toBe(500);
    expect(partialPath).not.toBe('');
    expect(fs.existsSync(partialPath)).toBe(false);
    expect(db.getPendingFilePairs('')).toHaveLength(0);
    expect(db.getStatsCounts().totalImages).toBe(0);
    expect((await upload(bytes, { cookie })).status).toBe(200);
  });

  it('accepts ordinary AVIF and strips metadata from animated WebP without dropping frames', async () => {
    const portrait = sharp({ create: { width: 8, height: 12, channels: 3, background: '#5e8db3' } });
    const avif = await processUploadedImage(await portrait.avif().toBuffer(), imageOptions);
    expect(avif).toMatchObject({ mimeType: 'image/avif', width: 8, height: 12 });

    const rgb = Buffer.concat([Buffer.alloc(8 * 8 * 3, 30), Buffer.alloc(8 * 8 * 3, 190)]);
    const animation = await sharp(rgb, { raw: { width: 8, height: 16, pageHeight: 8, channels: 3 } })
      .webp({ delay: [100, 150], loop: 2 }).withExif({ IFD0: { Make: 'Synthetic camera' } }).toBuffer();
    const original = await sharp(animation).metadata();
    expect(original.pages).toBe(2);
    expect(original.exif?.byteLength).toBeGreaterThan(0);
    const stripped = await processUploadedImage(animation, imageOptions);
    const meta = await sharp(stripped.buffer).metadata();
    expect(meta.pages).toBe(2);
    expect(meta.delay).toEqual([100, 150]);
    expect(meta.exif).toBeUndefined();
  });

  it('keeps APNG frames and tall screenshots under automatic WebP, with a bounded decode budget', async () => {
    const oneFrame = await png(8, 8);
    const uint32 = (n: number) => {
      const encoded = Buffer.alloc(4);
      encoded.writeUInt32BE(n);
      return encoded;
    };
    const chunk = (type: string, bytes: Buffer) => {
      const payload = Buffer.concat([Buffer.from(type), bytes]);
      return Buffer.concat([uint32(bytes.length), payload, uint32(crc32(payload))]);
    };
    const idatStart = oneFrame.indexOf(Buffer.from('IDAT')) - 4;
    const idatBytes = oneFrame.readUInt32BE(idatStart);
    const idatEnd = idatStart + 12 + idatBytes;
    const frame = (sequence: number) => chunk('fcTL', Buffer.concat([
      uint32(sequence), uint32(8), uint32(8), uint32(0), uint32(0), Buffer.from([0, 1, 0, 4, 0, 0]),
    ]));
    const apng = Buffer.concat([
      oneFrame.subarray(0, idatStart), chunk('acTL', Buffer.concat([uint32(2), uint32(0)])),
      chunk('tEXt', Buffer.from('Comment\0test fixture')), frame(0), oneFrame.subarray(idatStart, idatEnd),
      frame(1), chunk('fdAT', Buffer.concat([uint32(2), oneFrame.subarray(idatStart + 8, idatEnd - 4)])),
      oneFrame.subarray(idatEnd),
    ]);
    const options = { ...imageOptions, autoWebp: true };
    const animated = await processUploadedImage(apng, options);
    expect(animated.mimeType).toBe('image/png');
    expect(animated.buffer.includes(Buffer.from('acTL'))).toBe(true);
    expect(animated.buffer.includes(Buffer.from('fdAT'))).toBe(true);
    expect(animated.buffer.includes(Buffer.from('test fixture'))).toBe(false);
    await expect(processUploadedImage(apng, { ...options, maxWorkingBytes: 400 })).rejects.toThrow('IMAGE_MEMORY_BUDGET');

    const tall = await processUploadedImage(await png(24, 16_500), options);
    expect(tall).toMatchObject({ mimeType: 'image/png', width: 24, height: 16_500 });

    // Single-frame APNG (acTL num_frames=1) should be treated as static and converted to WebP
    const singleApng = Buffer.concat([
      oneFrame.subarray(0, idatStart),
      chunk('acTL', Buffer.concat([uint32(1), uint32(0)])),
      frame(0),
      oneFrame.subarray(idatStart),
    ]);
    const convertedSingle = await processUploadedImage(singleApng, options);
    expect(convertedSingle.mimeType).toBe('image/webp');

    // Default 1 GiB fallback allows full 200 MB hardMaxUploadMb without silent truncation
    const cookie = await setup();
    const settingsRes = await request('/api/settings', { headers: { Cookie: cookie } });
    expect(await settingsRes.json()).toMatchObject({ hardMaxUploadMb: 200 });
  });

  it('continues searching valid tags alongside a malformed legacy tag record', async () => {
    const cookie = await setup();
    const legacy = await imageFrom(await upload(await png(), { cookie, name: 'legacy.png' }));
    const tagged = await imageFrom(await upload(await png(16, 16), { cookie, name: 'tagged.png' }));
    db.db.prepare('UPDATE images SET tags_json = ? WHERE id = ?').run('[', legacy.id);
    expect((await json(`/api/images/${tagged.id}`, 'PATCH', { tags: ['literal_%'] }, cookie)).status).toBe(200);
    const found = await request('/api/images?search=literal_%25', { headers: { Cookie: cookie } });
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ total: 1, items: [{ id: tagged.id }] });
  });

  it('backfills thumbnail sizes when an old database is opened', async () => {
    const cookie = await setup();
    const image = await imageFrom(await upload(await png(), { cookie }));
    const record = db.getImageById(image.id)!;
    db.db.prepare('UPDATE images SET thumb_size_bytes = NULL WHERE id = ?').run(image.id);
    expect(db.getTotalUniqueBytes()).toBe(image.sizeBytes);
    await backfillThumbnailSizes(db, storage);
    expect(db.getImageById(image.id)?.thumbSizeBytes).toBe(record.thumbSizeBytes);
  });

  it('prevents global lockout under key churn while keeping brute-force IPs blocked', () => {
    const limiter = new RateLimiter(64);
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(limiter.consume('attacker-ip', 5, 60_000).allowed).toBe(true);
    }
    expect(limiter.consume('attacker-ip', 5, 60_000).allowed).toBe(false);

    // Churn 500 single-probe IPs; legitimate user must NOT be locked out and attacker must stay blocked.
    for (let i = 0; i < 500; i++) {
      expect(limiter.consume(`probe-${i}`, 5, 60_000).allowed).toBe(true);
    }
    expect(limiter.consume('legitimate-admin', 5, 60_000).allowed).toBe(true);
    expect(limiter.consume('attacker-ip', 5, 60_000).allowed).toBe(false);
  });

  it('supports cross-origin Bearer token uploads (Obsidian/extensions) without weakening cookie CSRF', async () => {
    const cookie = await setup();
    const tokenRes = await json('/api/tokens', 'POST', { name: 'Obsidian' }, cookie);
    const { rawToken } = await tokenRes.json() as { rawToken: string };
    const sample = await png(64, 64);

    // Preflight OPTIONS for Bearer upload
    const preflight = await app.request(new URL('/api/upload', origin), {
      method: 'OPTIONS',
      headers: { Origin: 'app://obsidian.md', 'Access-Control-Request-Method': 'POST' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('app://obsidian.md');
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();

    // Cross-origin POST with valid Bearer token succeeds
    const okForm = new FormData();
    okForm.append('file', new File([new Uint8Array(sample)], 'note.png', { type: 'image/png' }));
    const obsidianUpload = await app.request(new URL('/api/upload', origin), {
      method: 'POST',
      body: okForm,
      headers: { Origin: 'app://obsidian.md', Authorization: `Bearer ${rawToken}` },
    });
    expect(obsidianUpload.status).toBe(200);
    expect(obsidianUpload.headers.get('access-control-allow-origin')).toBe('app://obsidian.md');

    // Cross-origin POST with session Cookie ONLY (no Bearer) MUST still fail CSRF check (403)
    const csrfForm = new FormData();
    csrfForm.append('file', new File([new Uint8Array(sample)], 'csrf.png', { type: 'image/png' }));
    const csrfAttempt = await app.request(new URL('/api/upload', origin), {
      method: 'POST',
      body: csrfForm,
      headers: { Origin: 'https://evil.example', Cookie: cookie },
    });
    expect(csrfAttempt.status).toBe(403);

    // Cross-origin POST with invalid Bearer + valid Cookie MUST NOT fall back to Cookie (401)
    const fakeBearerForm = new FormData();
    fakeBearerForm.append('file', new File([new Uint8Array(sample)], 'fake.png', { type: 'image/png' }));
    const fakeBearer = await app.request(new URL('/api/upload', origin), {
      method: 'POST',
      body: fakeBearerForm,
      headers: { Origin: 'https://evil.example', Authorization: 'Bearer lp_invalid', Cookie: cookie },
    });
    expect(fakeBearer.status).toBe(401);
  });

  it('strips JPEG/GIF metadata losslessly without re-encoding and supports hotlinkAllowEmpty + deduplicated stats', async () => {
    const cleanJpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#2d6a4f' } })
      .jpeg({ quality: 96 })
      .toBuffer();
    const taggedJpeg = await sharp(cleanJpeg)
      .withExif({ IFD0: { Make: 'PrivatePhone', Copyright: 'Owner' } })
      .toBuffer();
    const beforeMeta = await sharp(taggedJpeg).metadata();
    expect(beforeMeta.exif?.byteLength).toBeGreaterThan(0);

    const strippedJpeg = await processUploadedImage(taggedJpeg, {
      autoWebp: false,
      webpQuality: 84,
      stripExif: true,
    });
    const afterMeta = await sharp(strippedJpeg.buffer).metadata();
    expect(afterMeta.exif).toBeUndefined();
    expect(strippedJpeg.mimeType).toBe('image/jpeg');
    // Lossless segment removal produces exact compressed scan bytes matching cleanJpeg
    const rawClean = await sharp(cleanJpeg).raw().toBuffer();
    const rawStripped = await sharp(strippedJpeg.buffer).raw().toBuffer();
    expect(rawStripped.equals(rawClean)).toBe(true);

    // Animated GIF keeps frames without re-encoding corruption
    const gifRgb = Buffer.concat([Buffer.alloc(12 * 12 * 3, 20), Buffer.alloc(12 * 12 * 3, 200)]);
    const animGif = await sharp(gifRgb, { raw: { width: 12, height: 24, pageHeight: 12, channels: 3 } })
      .gif({ delay: [80, 120] })
      .toBuffer();
    const processedGif = await processUploadedImage(animGif, imageOptions);
    expect((await sharp(processedGif.buffer, { animated: true }).metadata()).pages).toBe(2);

    // Hotlink allowEmpty toggle + Cache-Control modes + deduplicated guestUsedBytes + wildcard search safety
    const cookie = await setup();
    await json('/api/settings', 'PATCH', {
      allowGuestUpload: true,
      hotlinkProtection: true,
      hotlinkAllowEmpty: true,
      allowedReferers: 'blog.example.test',
    }, cookie);

    const dupSample = await png(80, 80);
    const g1 = await imageFrom(await upload(dupSample, { name: 'report_100%.png' }));
    await imageFrom(await upload(dupSample, { name: 'plain.png' }));

    // Empty referer allowed when hotlinkAllowEmpty=true, foreign referer still blocked
    const directRes = await request(g1.shareUrl!);
    expect(directRes.status).toBe(200);
    expect(directRes.headers.get('cache-control')).toContain('private');
    await directRes.arrayBuffer();
    expect((await request(g1.shareUrl!, { headers: { Referer: 'https://leach.example/' } })).status).toBe(403);

    // Deduplicated guestUsedBytes never exceeds total unique usedBytes
    const statsRes = await request('/api/stats', { headers: { Cookie: cookie } });
    const stats = await statsRes.json() as { usedBytes: number; guestUsedBytes: number };
    expect(stats.guestUsedBytes).toBeLessThanOrEqual(stats.usedBytes);

    // Search escapes % and _ and JSON brackets
    expect(db.listImages({ search: '100%' }).total).toBe(1);
    expect(db.listImages({ search: '[' }).total).toBe(0);
  });
});

