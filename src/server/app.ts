import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  DEFAULT_TOKEN_LIFETIME_DAYS, MAX_SITE_ICON_BYTES, MAX_TOKEN_LIFETIME_DAYS, MIN_ADMIN_PASSWORD_LENGTH,
  type AdminSettings, type PublicConfig, type StorageStats,
} from '../shared/types.js';
import type { EnvConfig } from './config.js';
import { GalleryDB, type ImageRecord } from './db.js';
import { MAX_ADMIN_PIXELS, MAX_GUEST_PIXELS, processSiteIcon, processUploadedImage } from './imagePipeline.js';
import { Capacity, generateRandomToken, getPeerConnection, getRequestSecurity, hashPassword,
  isNewPasswordValid, isRefererAllowed, matchesSecret, RateLimiter, sha256Hex, verifyPassword,
  type PeerConnection } from './security.js';
import type { LocalStorageDriver } from './storage.js';
import { flushFileQueue, removeQueuedPair, runCleanupTask } from './cleanup.js';
import { streamStoreZip, type ZipEntry } from './zip.js';
import { getUploadBodyLimit, MIB, MULTIPART_OVERHEAD, readImageUpload, readJsonObject, RequestError } from './requestBody.js';
import { readBoolean, readId, readImageIds, readInteger, readSettingsPatch, readString } from './validation.js';

const SESSION_COOKIE = 'lumepic_session';
const DISK_RESERVE = 50 * MIB;
const PASSWORD_MESSAGE = `密码至少需要 ${MIN_ADMIN_PASSWORD_LENGTH} 个字符，且 UTF-8 长度不超过 256 字节`;
type AppEnv = { Variables: { requestSecurity: ReturnType<typeof getRequestSecurity> } };
type AppContext = Context<AppEnv>;

export interface AppDeps {
  config: EnvConfig;
  db: GalleryDB;
  storage: LocalStorageDriver;
  clientDistDir?: string;
  connection?: (c: Context) => PeerConnection;
}

export function createApp({ config, db, storage, clientDistDir, connection = getPeerConnection }: AppDeps) {
  const app = new Hono<AppEnv>();
  const loginLimiter = new RateLimiter();
  const guestLimiter = new RateLimiter();
  const randomLimiter = new RateLimiter();
  const passwordSlots = new Capacity(3);
  const memoryLimit = process.constrainedMemory() || 1024 * MIB;
  const inputBudget = Math.min(
    Math.floor(memoryLimit / 4),
    Math.max(64, config.hardMaxUploadMb * 2) * MIB + 3 * MULTIPART_OVERHEAD
  );
  const hardUploadMb = Math.min(config.hardMaxUploadMb, Math.max(1, Math.floor((inputBudget - MULTIPART_OVERHEAD) / MIB)));
  // Image decoding runs serially via acquireImageSlot while uploadSlots caps concurrent raw buffers at inputBudget.
  const imageWorkingBudget = Math.max(64 * MIB, memoryLimit - inputBudget - 192 * MIB);
  const uploadSlots = new Capacity(3, inputBudget);
  let nextImageSlot = Promise.resolve();
  const acquireImageSlot = async (): Promise<() => void> => {
    const previous = nextImageSlot;
    let release!: () => void;
    nextImageSlot = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    return release;
  };
  const zipSlots = new Capacity(1);
  const hasBearerHeader = (c: Context): boolean => /^Bearer\s+\S+/i.test(c.req.header('authorization') ?? '');

  app.onError((error, c) => {
    if (error instanceof RequestError) return c.json({ error: error.message }, error.status);
    console.error('[request]', error);
    return c.json({ error: '服务器暂时无法完成请求' }, 500);
  });

  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('X-Frame-Options', 'DENY');
    if (c.req.path.startsWith('/api/') || c.req.path === '/random') c.header('Cache-Control', 'no-store');
    const security = getRequestSecurity(c, config, connection(c));
    c.set('requestSecurity', security);
    if (!security.origin) return c.json({ error: '请求的站点地址无效' }, 400);
    if (!security.secure && !security.local) return c.json({ error: '请通过 HTTPS 访问图床' }, 403);

    const origin = c.req.header('origin');
    const isCrossOriginBearerUpload =
      c.req.raw.method === 'POST' &&
      c.req.path === '/api/upload' &&
      origin !== undefined &&
      origin !== security.origin &&
      hasBearerHeader(c);

    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.raw.method) && !isCrossOriginBearerUpload) {
      if ((origin !== undefined && origin !== security.origin) ||
          (getCookie(c, SESSION_COOKIE) && origin !== security.origin)) {
        return c.json({ error: '请求来源与图床地址不一致' }, 403);
      }
    }
    if (isCrossOriginBearerUpload && origin) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
    }
    await next();
  });

  app.options('/api/upload', (c) => {
    const origin = c.req.header('origin');
    if (origin) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      c.header('Access-Control-Max-Age', '600');
      c.header('Vary', 'Origin');
    }
    return c.body(null, 204);
  });

  const settings = (): AdminSettings => db.getAdminSettings(hardUploadMb);
  const isSessionAdmin = (c: AppContext): boolean => db.verifySession(getCookie(c, SESSION_COOKIE));
  const baseUrl = (c: AppContext, current = settings()): string => config.publicUrl || current.publicUrl || c.var.requestSecurity.origin;
  const publicConfig = (c: AppContext, adminOverride?: boolean): PublicConfig => {
    const current = settings();
    const initialized = db.isInitialized();
    return {
      siteTitle: current.siteTitle,
      siteIconUrl: db.getSiteIconUrl(),
      initialized,
      requiresSetupToken: !initialized && (Boolean(config.setupToken) || !c.var.requestSecurity.local),
      isAdmin: adminOverride ?? isSessionAdmin(c),
      allowGuestUpload: current.allowGuestUpload,
      guestMaxSizeMb: current.guestMaxSizeMb,
      guestTtlDays: current.guestTtlDays,
      adminMaxSizeMb: current.adminMaxSizeMb,
      publicUrl: config.publicUrl || current.publicUrl,
    };
  };
  const setSessionCookie = (c: AppContext, token: string) => {
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 30 * 86_400, secure: c.var.requestSecurity.secure,
    });
  };
  const unauthorized = (c: AppContext) => c.json({ error: '管理员会话无效或已过期' }, 401);
  const limited = (c: AppContext, retry: number, message: string) => {
    c.header('Retry-After', String(retry));
    return c.json({ error: message }, 429);
  };

  app.get('/api/health', async (c) => {
    try {
      db.db.prepare('SELECT key FROM settings LIMIT 1').get();
      await storage.checkWritable();
      const { freeBytes } = storage.getDiskUsage();
      if (freeBytes !== null && freeBytes < DISK_RESERVE) return c.json({ ok: false }, 503);
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });
  app.get('/api/public-config', (c) => c.json(publicConfig(c)));
  app.get('/api/site-icon/:filename', (c) => {
    const revision = /^([a-f0-9]{64})\.png$/.exec(c.req.param('filename'))?.[1];
    const png = revision ? db.getSiteIcon(revision) : undefined;
    if (!png) return c.notFound();
    c.header('Content-Type', 'image/png');
    c.header('Cache-Control', 'public, max-age=86400, immutable');
    c.header('Content-Security-Policy', "default-src 'none'; sandbox");
    return c.body(new Uint8Array(png));
  });

  app.post('/api/auth/setup', async (c) => {
    if (db.isInitialized()) return c.json({ error: '管理员密码已初始化，请直接登录' }, 409);
    const { ip, local } = c.var.requestSecurity;
    if (!local && !config.setupToken) return c.json({ error: '公网初始化需要部署端配置一次性初始化令牌' }, 403);
    const limit = loginLimiter.consume(`setup:${ip}`, 6, 60_000);
    if (!limit.allowed) return limited(c, limit.retryAfterSec, '初始化请求过于频繁');
    const body = await readJsonObject(c.req.raw, 2048);
    if (config.setupToken) {
      const supplied = typeof body.setupToken === 'string' ? body.setupToken : '';
      if (!matchesSecret(supplied, config.setupToken)) return c.json({ error: '初始化令牌不正确' }, 403);
    }
    const password = readString(body.password, '密码', 256);
    if (!isNewPasswordValid(password)) return c.json({ error: PASSWORD_MESSAGE }, 400);
    const release = passwordSlots.acquire();
    if (!release) return limited(c, 2, '认证服务繁忙，请稍后重试');
    try {
      const hash = await hashPassword(password);
      const session = db.transaction(() => db.initializeAdmin(hash) ? db.createSession() : null);
      if (!session) return c.json({ error: '管理员密码已初始化，请直接登录' }, 409);
      setSessionCookie(c, session);
      return c.json({ ok: true, config: publicConfig(c, true) });
    } finally {
      release();
    }
  });

  app.post('/api/auth/login', async (c) => {
    const stored = db.getAdminPasswordHash();
    if (!stored) return c.json({ error: '系统尚未初始化' }, 400);
    const window = loginLimiter.consume(`login:${c.var.requestSecurity.ip}`, 10, 15 * 60_000);
    if (!window.allowed) return limited(c, window.retryAfterSec, '登录尝试过于频繁');
    const password = readString((await readJsonObject(c.req.raw, 4096)).password, '密码', 1024);
    const release = passwordSlots.acquire();
    if (!release) return limited(c, 2, '认证服务繁忙，请稍后重试');
    try {
      if (!(await verifyPassword(password, stored)) || db.getAdminPasswordHash() !== stored) {
        return c.json({ error: '管理员密码不正确' }, 401);
      }
      setSessionCookie(c, db.createSession());
      return c.json({ ok: true, config: publicConfig(c, true) });
    } finally {
      release();
    }
  });

  app.post('/api/auth/logout', (c) => {
    db.deleteSession(getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: c.var.requestSecurity.secure, httpOnly: true, sameSite: 'Lax' });
    return c.json({ ok: true });
  });

  app.post('/api/auth/password', async (c) => {
    if (!isSessionAdmin(c)) return unauthorized(c);
    const body = await readJsonObject(c.req.raw, 4096);
    const current = readString(body.currentPassword, '当前密码', 1024);
    const password = readString(body.newPassword, '新密码', 256);
    if (!isNewPasswordValid(password)) return c.json({ error: PASSWORD_MESSAGE }, 400);
    if (!isSessionAdmin(c)) return unauthorized(c);
    const release = passwordSlots.acquire();
    if (!release) return limited(c, 2, '认证服务繁忙，请稍后重试');
    try {
      const previous = db.getAdminPasswordHash();
      if (!previous || !(await verifyPassword(current, previous))) return c.json({ error: '当前密码不正确' }, 400);
      const next = await hashPassword(password);
      if (!isSessionAdmin(c)) return unauthorized(c);
      const session = db.rotatePassword(previous, next);
      if (!session) return c.json({ error: '密码已被修改，请重新登录' }, 409);
      setSessionCookie(c, session);
      return c.json({ ok: true });
    } finally {
      release();
    }
  });

  app.post('/api/upload', async (c) => {
    const current = settings();
    const origin = c.req.header('origin');
    const crossOrigin = origin !== undefined && origin !== c.var.requestSecurity.origin;
    const authorization = c.req.header('authorization');
    const hasBearer = authorization !== undefined;
    if (crossOrigin && !hasBearer) return c.json({ error: '请求来源与图床地址不一致' }, 403);
    const bearer = authorization?.match(/^Bearer\s+(lp_[a-f0-9]{48})$/i)?.[1];
    if (hasBearer && !db.verifyApiToken(bearer)) return c.json({ error: '上传 Token 无效或已过期' }, 401);
    const isExplicitGuest = c.req.query('guest') === '1' && !hasBearer;
    const admin = hasBearer || (!crossOrigin && !isExplicitGuest && isSessionAdmin(c));
    const uploaderType = admin ? 'admin' : 'guest';
    if (!admin && !current.allowGuestUpload) return c.json({ error: '游客上传已关闭，请先登录' }, 401);
    const stillAllowed = () => admin
      ? (hasBearer ? db.verifyApiToken(bearer, false) : isSessionAdmin(c))
      : settings().allowGuestUpload;

    const maxBytes = (admin ? current.adminMaxSizeMb : current.guestMaxSizeMb) * MIB;
    const bodyLimit = getUploadBodyLimit(c.req.raw, maxBytes, inputBudget);
    const release = uploadSlots.acquire(bodyLimit);
    if (!release) return limited(c, 2, '上传通道繁忙，请稍后重试');
    let releaseImage: (() => void) | undefined;
    try {
      if (!admin) {
        const rate = guestLimiter.consume(c.var.requestSecurity.ip, current.guestRateLimitPerMin, 60_000);
        if (!rate.allowed) return limited(c, rate.retryAfterSec, '游客上传过于频繁');
      }
      const upload = await readImageUpload(c.req.raw, maxBytes, bodyLimit);
      const albumId = admin && upload.albumId ? readId(upload.albumId, '相册 ID') : null;
      if (albumId && !db.albumExists(albumId)) throw new RequestError('目标相册不存在');
      releaseImage = await acquireImageSlot();
      if (c.req.raw.signal.aborted) return c.body(null, 204);
      if (!stillAllowed()) return c.json({ error: '上传权限已失效' }, 401);
      let processed;
      try {
        processed = await processUploadedImage(upload.buffer, {
          autoWebp: current.webpMode === 'all' || (current.webpMode === 'guest_only' && !admin),
          webpQuality: current.webpQuality,
          stripExif: current.stripExif,
          maxPixels: admin ? MAX_ADMIN_PIXELS : MAX_GUEST_PIXELS,
          maxWorkingBytes: imageWorkingBudget,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : '';
        if (reason === 'IMAGE_MEMORY_BUDGET') return c.json({ error: '图片解码内存超过当前服务配额' }, 413);
        const message = reason === 'IMAGE_TOO_LARGE' ? '图片像素或动画帧数超过限制'
          : reason === 'UNSUPPORTED_ANIMATION' ? '当前无法保留多帧 AVIF 并清除其元数据'
          : reason === 'UNSUPPORTED_APNG_ORIENTATION' ? '当前无法旋转此 APNG 并保留动画'
          : '图片格式不受支持、尺寸过大或文件已损坏（支持 JPG、PNG、WebP、AVIF、GIF）';
        return c.json({ error: message }, 400);
      }

      if (c.req.raw.signal.aborted) return c.body(null, 204);
      const originalName = GalleryDB.safeExtName(upload.filename);
      const expiresAt = !admin && current.guestTtlDays > 0
        ? new Date(Date.now() + current.guestTtlDays * 86_400_000).toISOString() : null;
      const publicDelivery = !admin || hasBearer;
      const result = (record: ImageRecord, deduplicated: boolean) => {
        const image = db.toImageItem(record, baseUrl(c), publicDelivery);
        return c.json({ ok: true, deduplicated, url: image.shareUrl, image });
      };
      return await storage.withMutation(async () => {
        if (!stillAllowed()) return c.json({ error: '上传权限已失效' }, 401);
        if (albumId && !db.albumExists(albumId)) throw new RequestError('目标相册已删除', 409);
        const reusable = admin && !hasBearer ? db.findReusableByHash(processed.hash, albumId, originalName) : null;
        const existing = reusable ?? db.findAnyByHash(processed.hash);
        const existingSize = existing && await storage.getFileSize(existing.storagePath);
        const existingThumbSize = existing && await storage.getFileSize(existing.thumbPath);
        const canReuse = existing && existingSize === processed.sizeBytes && existingThumbSize !== null && existingThumbSize > 0;
        if (reusable && canReuse) {
          if (!stillAllowed()) return c.json({ error: '上传权限已失效' }, 401);
          const currentImage = db.getImageById(reusable.id);
          if (currentImage && !currentImage.deletedAt && currentImage.albumId === albumId &&
              currentImage.originalName === originalName && currentImage.shareKey) {
            return result(currentImage, true);
          }
        }

        const paths = canReuse ? existing : storage.buildRelativePaths(
          `${processed.hash.slice(0, 20)}-${generateRandomToken(8)}`, processed.ext
        );
        const thumbSizeBytes = canReuse ? existingThumbSize : processed.thumbBuffer.byteLength;
        const sizeBytes = processed.sizeBytes + thumbSizeBytes;
        const pair = { storagePath: paths.storagePath, thumbPath: paths.thumbPath, sizeBytes };
        if (!canReuse) {
          const { maxStorageGb } = settings();
          if (maxStorageGb > 0 && db.getTotalUniqueBytes() + sizeBytes > maxStorageGb * 1024 * MIB) {
            return c.json({ error: '图床已达到设定的最大存储容量' }, 507);
          }
          const disk = storage.getDiskUsage();
          if (disk.freeBytes !== null && disk.freeBytes < DISK_RESERVE + sizeBytes) {
            return c.json({ error: '本地磁盘可用空间不足' }, 507);
          }
          db.queueFilePair(pair);
        }

        let record: ImageRecord;
        try {
          if (!canReuse) await storage.writeImageFiles(paths.storagePath, processed.buffer, paths.thumbPath, processed.thumbBuffer);
          record = db.transaction(() => {
            if (!stillAllowed()) throw new RequestError('上传权限已失效', 401);
            if (albumId && !db.albumExists(albumId)) throw new RequestError('目标相册已删除', 409);
            if (existing && !canReuse) db.relocateFilePair(existing, { ...paths, thumbSizeBytes });
            const rebound = reusable && !canReuse ? db.getImageById(reusable.id) : null;
            const keepRecord = rebound && !rebound.deletedAt && rebound.albumId === albumId &&
              rebound.originalName === originalName && rebound.shareKey;
            const inserted = keepRecord ? rebound : db.insertImage({
              ...paths,
              ...processed,
              id: generateRandomToken(8),
              originalName,
              thumbSizeBytes,
              ...GalleryDB.newShareKeys(`.${processed.ext}`),
              uploaderType,
              deleteTokenHash: null,
              albumId,
              tags: [],
              expiresAt,
            });
            if (!canReuse) db.completeFilePair(pair.storagePath);
            return inserted;
          });
        } catch (error) {
          if (!canReuse) await removeQueuedPair(db, storage, pair);
          throw error;
        }
        return result(record, record.id === reusable?.id);
      });
    } finally {
      releaseImage?.();
      release();
    }
  });

  app.delete('/api/guest/images/:id', (c) => c.json({ error: '游客无权删除已上传的图片' }, 403));

  app.use('/api/images', async (c, next) => {
    if (!isSessionAdmin(c)) return unauthorized(c);
    return next();
  });
  app.use('/api/images/*', async (c, next) => {
    if (!isSessionAdmin(c)) return unauthorized(c);
    return next();
  });
  app.use('/api/albums', async (c, next) => {
    if (!isSessionAdmin(c)) return unauthorized(c);
    return next();
  });
  app.use('/api/albums/*', async (c, next) => {
    if (!isSessionAdmin(c)) return unauthorized(c);
    return next();
  });

  app.get('/api/images', (c) => {
    const search = c.req.query('search')?.slice(0, 180);
    const albumId = c.req.query('albumId') || undefined;
    const uploader = c.req.query('uploaderType');
    const limit = readInteger(Number(c.req.query('limit') ?? 80), '每页图片数', 1, 200);
    const offset = readInteger(Number(c.req.query('offset') ?? 0), '分页偏移量', 0, Number.MAX_SAFE_INTEGER);
    const { items, total } = db.listImages({
      search, albumId, limit, offset, inTrash: c.req.query('trash') === 'true',
      uploaderType: uploader === 'admin' || uploader === 'guest' ? uploader : 'all',
    });
    const origin = baseUrl(c);
    return c.json({ total, items: items.map((record) => db.toImageItem(record, origin)) });
  });

  app.patch('/api/images/:id', async (c) => {
    const body = await readJsonObject(c.req.raw);
    const patch: { originalName?: string; albumId?: string | null; tags?: string[]; promoteToAdmin?: boolean } = {};
    if (body.originalName !== undefined) patch.originalName = GalleryDB.safeExtName(readString(body.originalName, '图片名称', 240));
    if (body.albumId !== undefined) patch.albumId = body.albumId === null ? null : readId(body.albumId, '相册 ID');
    if (patch.albumId && !db.albumExists(patch.albumId)) throw new RequestError('目标相册不存在');
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags) || body.tags.length > 30) throw new RequestError('最多允许 30 个标签');
      patch.tags = [...new Set(body.tags.map((tag) => readString(tag, '标签', 40).trim()).filter(Boolean))];
    }
    if (body.promoteToAdmin !== undefined) patch.promoteToAdmin = readBoolean(body.promoteToAdmin, '转存状态');
    if (!isSessionAdmin(c)) return unauthorized(c);
    const updated = db.updateImageMeta(c.req.param('id'), patch);
    return updated ? c.json({ ok: true, image: db.toImageItem(updated, baseUrl(c)) })
      : c.json({ error: '图片不存在' }, 404);
  });

  app.put('/api/images/:id/share', async (c) => {
    const body = await readJsonObject(c.req.raw);
    const enabled = readBoolean(body.enabled, '分享状态');
    if (!isSessionAdmin(c)) return unauthorized(c);
    const record = db.setImageSharing(c.req.param('id'), enabled);
    return record ? c.json({ ok: true, image: db.toImageItem(record, baseUrl(c)) })
      : c.json({ error: '当前图片无法调整分享状态' }, 409);
  });

  app.delete('/api/images/:id', (c) => storage.withMutation(async () => {
    if (!isSessionAdmin(c)) return unauthorized(c);
    const ids = [c.req.param('id')];
    if (c.req.query('permanent') !== 'true') {
      return db.softDeleteImages(ids) ? c.json({ ok: true, softDeleted: true })
        : c.json({ error: '图片不存在或已在回收站' }, 404);
    }
    if (!db.hardDeleteImages(ids, true)) return c.json({ error: '只有回收站中的图片才能永久删除' }, 409);
    await flushFileQueue(db, storage);
    return c.json({ ok: true, permanent: true });
  }));

  app.post('/api/images/batch', async (c) => {
    const body = await readJsonObject(c.req.raw);
    const ids = readImageIds(body.ids);
    if (!isSessionAdmin(c)) return unauthorized(c);
    switch (body.action) {
      case 'share': {
        const records = db.transaction(() => ids.map((id) => {
          const record = db.setImageSharing(id, true);
          if (!record) throw new RequestError('所选图片中有项目无法分享，请刷新后重试', 409);
          return record;
        }));
        const origin = baseUrl(c);
        return c.json({ ok: true, items: records.map((record) => db.toImageItem(record, origin)) });
      }
      case 'trash': return c.json({ ok: true, affected: db.softDeleteImages(ids) });
      case 'restore': {
        const affected = db.restoreImages(ids);
        return affected ? c.json({ ok: true, affected })
          : c.json({ error: '图片不在回收站或已过有效期' }, 409);
      }
      case 'move':
      case 'promote': {
        const albumId = body.albumId == null ? null : readId(body.albumId, '相册 ID');
        if (albumId && !db.albumExists(albumId)) throw new RequestError('目标相册不存在');
        if (body.action === 'move') return c.json({ ok: true, affected: db.batchMoveAlbum(ids, albumId) });
        const copies = db.copyGuestImagesToAdmin(ids, albumId);
        if (copies.length === 0) return c.json({ error: '所选图片中没有可转存的游客图片' }, 409);
        const origin = baseUrl(c);
        return c.json({
          ok: true, affected: copies.length, items: copies.map((record) => db.toImageItem(record, origin)),
        });
      }
      case 'delete': return storage.withMutation(async () => {
        if (!isSessionAdmin(c)) return unauthorized(c);
        const affected = db.hardDeleteImages(ids, true);
        if (!affected) return c.json({ error: '只有回收站中的图片才能永久删除' }, 409);
        await flushFileQueue(db, storage);
        return c.json({ ok: true, affected });
      });
      default: throw new RequestError('不支持的批量操作');
    }
  });

  app.post('/api/images/download-zip', async (c) => {
    const ids = readImageIds((await readJsonObject(c.req.raw)).ids);
    if (!isSessionAdmin(c)) return unauthorized(c);
    const release = zipSlots.acquire();
    if (!release) return limited(c, 2, '已有打包下载正在进行');
    const entries: ZipEntry[] = [];
    let closing: Promise<void> | undefined;
    const closeEntries = async () => {
      closing ??= Promise.allSettled(entries.map((entry) => entry.file.close())).then(() => release());
      await closing;
    };
    try {
      await storage.withMutation(async () => {
        let totalBytes = 0;
        for (const id of ids) {
          const record = db.getImageById(id);
          if (!record) throw new RequestError('所选图片中存在已删除项目，请刷新后重试', 409);
          const file = await storage.openUploadFile(record.storagePath);
          if (!file) throw new RequestError('所选图片中存在磁盘文件缺失的项目', 409);
          const entry = { name: buildDownloadFilename(record), file, size: 0 };
          entries.push(entry);
          const stat = await file.stat();
          if (!stat.isFile()) throw new RequestError('所选图片中存在无效文件', 409);
          entry.size = stat.size;
          totalBytes += stat.size;
          if (totalBytes > 300 * MIB) throw new RequestError('所选图片超过 300 MiB 打包上限，请分批下载', 413);
        }
      });
      const chunks = (async function* () {
        try {
          yield* streamStoreZip(entries);
        } finally {
          await closeEntries();
        }
      })();
      return fileStreamResponse(c, chunks, closeEntries, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="lumepic-export-${new Date().toISOString().slice(0, 10)}.zip"`,
      });
    } catch (error) {
      await closeEntries();
      throw error;
    }
  });

  app.get('/api/albums', (c) => c.json({ items: db.listAlbums() }));
  app.post('/api/albums', async (c) => {
    const name = readString((await readJsonObject(c.req.raw)).name, '相册名', 40).trim();
    if (!name) throw new RequestError('相册名称不能为空');
    if (!isSessionAdmin(c)) return unauthorized(c);
    return c.json({ ok: true, album: db.createAlbum(name) });
  });
  app.delete('/api/albums/:id', (c) => db.deleteAlbum(c.req.param('id')) ? c.json({ ok: true })
    : c.json({ error: '相册不存在' }, 404));
  app.patch('/api/albums/:id', async (c) => {
    const name = readString((await readJsonObject(c.req.raw)).name, '相册名', 40).trim();
    if (!name) throw new RequestError('相册名称不能为空');
    if (!isSessionAdmin(c)) return unauthorized(c);
    const album = db.renameAlbum(c.req.param('id'), name);
    return album ? c.json({ ok: true, album }) : c.json({ error: '相册不存在' }, 404);
  });

  app.get('/api/settings', (c) => {
    if (!isSessionAdmin(c)) return unauthorized(c);
    const current = settings();
    return c.json({
      settings: { ...current, publicUrl: config.publicUrl || current.publicUrl },
      publicUrlLocked: Boolean(config.publicUrl),
      hardMaxUploadMb: hardUploadMb,
    });
  });
  app.patch('/api/settings', async (c) => {
    if (!isSessionAdmin(c)) return unauthorized(c);
    const patch = readSettingsPatch(await readJsonObject(c.req.raw), hardUploadMb);
    if (config.publicUrl && patch.publicUrl !== undefined) throw new RequestError('外链地址由环境变量 PUBLIC_URL 管理', 409);
    if (!isSessionAdmin(c)) return unauthorized(c);
    const updated = db.updateAdminSettings(patch, hardUploadMb);
    return c.json({
      ok: true, settings: { ...updated, publicUrl: config.publicUrl || updated.publicUrl }, publicConfig: publicConfig(c),
    });
  });
  app.put('/api/settings/site-icon', async (c) => {
    if (!isSessionAdmin(c)) return unauthorized(c);
    const bodyLimit = getUploadBodyLimit(c.req.raw, MAX_SITE_ICON_BYTES, inputBudget);
    const release = uploadSlots.acquire(bodyLimit);
    if (!release) return limited(c, 2, '上传通道繁忙，请稍后重试');
    let releaseImage: (() => void) | undefined;
    try {
      const { buffer } = await readImageUpload(c.req.raw, MAX_SITE_ICON_BYTES, bodyLimit);
      releaseImage = await acquireImageSlot();
      if (c.req.raw.signal.aborted) return c.body(null, 204);
      if (!isSessionAdmin(c)) return unauthorized(c);
      const png = await processSiteIcon(buffer).catch(() => null);
      if (!png) return c.json({ error: '请选择可解码的 PNG、JPG 或 WebP 图标（最多 1600 万像素）' }, 400);
      if (c.req.raw.signal.aborted) return c.body(null, 204);
      if (!isSessionAdmin(c)) return unauthorized(c);
      db.setSiteIcon(sha256Hex(png), png);
      return c.json({ publicConfig: publicConfig(c) });
    } finally {
      releaseImage?.();
      release();
    }
  });
  app.delete('/api/settings/site-icon', (c) => {
    if (!isSessionAdmin(c)) return unauthorized(c);
    db.resetSiteIcon();
    return c.json({ publicConfig: publicConfig(c) });
  });
  app.get('/api/stats', (c) => {
    if (!isSessionAdmin(c)) return unauthorized(c);
    const disk = storage.getDiskUsage();
    const result: StorageStats = {
      ...db.getStatsCounts(), diskTotalBytes: disk.totalBytes, diskFreeBytes: disk.freeBytes,
      maxStorageGb: settings().maxStorageGb,
    };
    return c.json(result);
  });
  app.post('/api/maintenance/cleanup', async (c) => {
    if (!isSessionAdmin(c)) return unauthorized(c);
    const { mode } = await readJsonObject(c.req.raw);
    if (mode !== 'expired' && mode !== 'all_guest' && mode !== 'empty_trash') throw new RequestError('清理类型无效');
    if (!isSessionAdmin(c)) return unauthorized(c);
    const deletedCount = await runCleanupTask(db, storage, mode);
    return c.json({ ok: true, deletedCount });
  });

  app.get('/api/tokens', (c) => {
    if (!isSessionAdmin(c)) return unauthorized(c);
    return c.json({ items: db.listApiTokens() });
  });
  app.post('/api/tokens', async (c) => {
    if (!isSessionAdmin(c)) return unauthorized(c);
    const body = await readJsonObject(c.req.raw);
    const name = readString(body.name ?? '', 'Token 名称', 80);
    const expiresInDays = body.expiresInDays === undefined ? DEFAULT_TOKEN_LIFETIME_DAYS
      : readInteger(body.expiresInDays, 'Token 有效期（天）', 0, MAX_TOKEN_LIFETIME_DAYS);
    if (!isSessionAdmin(c)) return unauthorized(c);
    return c.json({ ok: true, ...db.createApiToken(name, expiresInDays) });
  });
  app.delete('/api/tokens/:id', (c) => {
    if (!isSessionAdmin(c)) return unauthorized(c);
    return db.deleteApiToken(c.req.param('id')) ? c.json({ ok: true }) : c.json({ error: 'Token 不存在' }, 404);
  });

  function buildDownloadFilename(record: ImageRecord): string {
    const ext = path.extname(record.filename) || '.webp';
    const sanitized = GalleryDB.safeExtName(record.originalName);
    return Buffer.from(`${path.basename(sanitized, path.extname(sanitized)).trim() || 'image'}${ext}`).toString('utf8');
  }

  function fileStreamResponse(
    c: AppContext,
    chunks: AsyncIterable<Buffer>,
    close: () => Promise<void>,
    headers: Headers | Record<string, string>
  ): Response {
    const stream = Readable.from(chunks, { objectMode: false });
    const { signal } = c.req.raw;
    const abort = () => stream.destroy();
    stream.once('close', () => {
      signal.removeEventListener('abort', abort);
      void close();
    });
    const body = Readable.toWeb(stream) as unknown as ConstructorParameters<typeof Response>[0];
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return new Response(body, { headers });
  }

  async function serveImage(c: AppContext, record: ImageRecord, thumb: boolean, shared: boolean) {
    const sharedSettings = shared ? settings() : null;
    if (sharedSettings) {
      c.header('Cache-Control', 'no-store');
      c.header('Vary', 'Referer');
      if (sharedSettings.hotlinkProtection &&
          !isRefererAllowed(
            c.req.header('referer'),
            c.var.requestSecurity.origin,
            sharedSettings.allowedReferers,
            sharedSettings.hotlinkAllowEmpty
          )) {
        return c.text('Hotlink Forbidden', 403);
      }
    }

    const file = await storage.openUploadFile(thumb ? record.thumbPath : record.storagePath);
    if (!file) return c.notFound();
    let streaming = false;
    let closing: Promise<void> | undefined;
    const closeFile = async () => {
      closing ??= file.close().catch(() => {});
      await closing;
    };
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return c.notFound();
      const download = !thumb && c.req.query('download') === '1';
      const cacheable = shared && !download;
      const etag = `"${record.hash}${thumb ? '-t' : ''}-${stat.size}-${stat.mtimeMs}"`;
      const cacheScope = sharedSettings?.hotlinkProtection ? 'private' : 'public';
      const cacheControl = cacheable ? `${cacheScope}, no-cache, max-age=0, must-revalidate` : 'no-store';
      const headers = new Headers({
        'Content-Type': thumb ? 'image/webp' : record.mimeType,
        'Content-Length': String(stat.size),
        'Cache-Control': cacheControl,
        'Content-Security-Policy': "default-src 'none'; sandbox",
      });
      if (shared) headers.set('Vary', 'Referer');
      if (cacheable) {
        headers.set('ETag', etag);
        const matches = c.req.header('if-none-match')?.split(',').some((key) => {
          const candidate = key.trim().replace(/^W\//, '');
          return candidate === etag || candidate === '*';
        });
        if (matches) {
          headers.delete('Content-Length');
          headers.delete('Content-Type');
          return new Response(null, { status: 304, headers });
        }
      }
      if (download) {
        const name = buildDownloadFilename(record);
        const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
        const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase());
        headers.set('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`);
      }
      if (c.req.raw.method === 'HEAD') return new Response(null, { headers });
      const chunks = (async function* () {
        try {
          if (stat.size > 0) {
            for await (const chunk of file.createReadStream({ end: stat.size - 1, autoClose: false })) {
              yield chunk as Buffer;
            }
          }
        } finally {
          await closeFile();
        }
      })();
      const response = fileStreamResponse(c, chunks, closeFile, headers);
      streaming = true;
      return response;
    } finally {
      if (!streaming) await closeFile();
    }
  }

  app.get('/api/images/:id/:variant', (c) => {
    const variant = c.req.param('variant');
    if (variant !== 'file' && variant !== 'thumb') return c.notFound();
    const record = db.getImageById(c.req.param('id'));
    return record ? serveImage(c, record, variant === 'thumb', false) : c.notFound();
  });

  const handleRandom = (c: AppContext) => {
    const current = settings();
    if (!current.randomApiEnabled) return c.json({ error: '随机图片 API 未开启' }, 403);
    const rate = randomLimiter.consume(c.var.requestSecurity.ip, 60, 60_000);
    if (!rate.allowed) return limited(c, rate.retryAfterSec, '请求随机图片过于频繁');
    const value = c.req.query('orient');
    const orient = value === 'landscape' || value === 'portrait' ? value : undefined;
    const record = db.getRandomAdminImage(current.randomApiAlbumIds, orient);
    if (!record) return c.json({ error: '没有符合条件的公开图片' }, 404);
    const image = db.toImageItem(record, baseUrl(c, current), true);
    if (c.req.query('format') === 'json') {
      return c.json({ ok: true, url: image.shareUrl, thumbUrl: image.shareThumbUrl, width: image.width,
        height: image.height, filename: record.shareKey });
    }
    return c.redirect(image.shareUrl!, 302);
  };
  app.get('/api/random', handleRandom);
  app.get('/random', handleRandom);

  for (const [prefix, route] of [['/i', 'admin'], ['/g', 'guest']] as const) {
    app.use(`${prefix}/*`, async (c, next) => {
      await next();
      if (c.res.status >= 400) c.header('Cache-Control', 'no-store');
    });
    app.get(`${prefix}/thumb/:key`, (c) => {
      const record = db.getSharedImage(c.req.param('key'), true, route);
      return record ? serveImage(c, record, true, true) : c.notFound();
    });
    app.get(`${prefix}/:key`, (c) => {
      const record = db.getSharedImage(c.req.param('key'), false, route);
      return record ? serveImage(c, record, false, true) : c.notFound();
    });
  }

  if (clientDistDir && fs.existsSync(clientDistDir)) {
    const root = path.relative(process.cwd(), clientDistDir) || '.';
    app.use('/assets/*', serveStatic({ root }));
    app.use('/favicon.svg', serveStatic({ root }));
    app.get('*', async (c) => {
      if (/^\/(?:api|i|g|assets)(?:\/|$)/.test(c.req.path)) return c.notFound();
      return c.html(await fs.promises.readFile(path.join(clientDistDir, 'index.html'), 'utf8'));
    });
  }
  return app;
}

