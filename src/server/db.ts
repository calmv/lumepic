import path from 'node:path';
import { randomInt } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  AdminSettings,
  AlbumItem,
  ApiTokenItem,
  ExifSummary,
  ImageItem,
  UploaderType,
  WebpMode,
} from '../shared/types.js';
import { normalizePublicUrl, type EnvConfig } from './config.js';
import { DEFAULT_TOKEN_LIFETIME_DAYS } from '../shared/types.js';
import { generateRandomToken, sha256Hex } from './security.js';
import { RequestError } from './requestBody.js';

const CLEANUP_BATCH_SIZE = 200;

export interface StoredFilePair {
  storagePath: string;
  thumbPath: string;
  sizeBytes: number;
}

export interface ImageRecord {
  id: string;
  hash: string;
  filename: string;
  originalName: string;
  storagePath: string;
  thumbPath: string;
  thumbFilename: string;
  shareKey: string | null;
  shareThumbKey: string | null;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  thumbSizeBytes: number | null;
  thumbhash: string;
  uploaderType: UploaderType;
  deleteTokenHash: string | null;
  albumId: string | null;
  albumName: string | null;
  tags: string[];
  exif: ExifSummary | null;
  expiresAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export interface ListImagesFilter {
  search?: string;
  albumId?: string;
  uploaderType?: UploaderType | 'all';
  inTrash?: boolean;
  limit?: number;
  offset?: number;
}

const SETTING_KEYS = {
  ADMIN_PASSWORD_HASH: 'admin_password_hash',
  SITE_TITLE: 'site_title',
  ALLOW_GUEST_UPLOAD: 'allow_guest_upload',
  GUEST_MAX_SIZE_MB: 'guest_max_size_mb',
  GUEST_RATE_LIMIT_PER_MIN: 'guest_rate_limit_per_min',
  GUEST_TTL_DAYS: 'guest_ttl_days',
  ADMIN_MAX_SIZE_MB: 'admin_max_size_mb',
  WEBP_MODE: 'webp_mode',
  AUTO_WEBP: 'auto_webp',
  WEBP_QUALITY: 'webp_quality',
  STRIP_EXIF: 'strip_exif',
  HOTLINK_PROTECTION: 'hotlink_protection',
  HOTLINK_ALLOW_EMPTY: 'hotlink_allow_empty',
  ALLOWED_REFERERS: 'allowed_referers',
  MAX_STORAGE_GB: 'max_storage_gb',
  PUBLIC_URL: 'public_url',
  RANDOM_API_ENABLED: 'random_api_enabled',
  RANDOM_API_ALBUM_IDS: 'random_api_album_ids',
} as const;

export class GalleryDB {
  readonly db: DatabaseSync;

  constructor(dbPath: string, envConfig: EnvConfig) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    this.migrate();
    this.seedDefaults(envConfig);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS site_icon (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision TEXT NOT NULL,
        png BLOB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS albums (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        filename TEXT NOT NULL,
        original_name TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        thumb_path TEXT NOT NULL,
        thumb_filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        thumbhash TEXT NOT NULL,
        uploader_type TEXT NOT NULL DEFAULT 'admin',
        delete_token_hash TEXT,
        album_id TEXT REFERENCES albums(id) ON DELETE SET NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        exif_json TEXT,
        expires_at TEXT,
        deleted_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_images_hash ON images(hash);
      CREATE INDEX IF NOT EXISTS idx_images_filename ON images(filename);
      CREATE INDEX IF NOT EXISTS idx_images_thumb_filename ON images(thumb_filename);
      CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_images_expires ON images(expires_at);
      CREATE INDEX IF NOT EXISTS idx_images_storage_path ON images(storage_path);
      CREATE INDEX IF NOT EXISTS idx_images_album_created ON images(album_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS pending_file_deletes (
        storage_path TEXT PRIMARY KEY,
        thumb_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        last_used_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
    this.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(images)').all();
      if (!columns.some((col) => col.name === 'thumb_size_bytes')) {
        this.db.exec('ALTER TABLE images ADD COLUMN thumb_size_bytes INTEGER');
      }
      if (!columns.some((col) => col.name === 'share_key')) {
        this.db.exec(`
          ALTER TABLE images ADD COLUMN share_key TEXT;
          ALTER TABLE images ADD COLUMN share_thumb_key TEXT;
          UPDATE images SET share_key = filename, share_thumb_key = thumb_filename
            WHERE uploader_type = 'guest'
              AND filename IN (SELECT filename FROM images GROUP BY filename HAVING COUNT(*) = 1)
              AND thumb_filename IN (SELECT thumb_filename FROM images GROUP BY thumb_filename HAVING COUNT(*) = 1);
        `);
      }
      if (!columns.some((col) => col.name === 'legacy_guest_share')) {
        this.db.exec(`
          ALTER TABLE images ADD COLUMN legacy_guest_share INTEGER NOT NULL DEFAULT 0;
          UPDATE images SET legacy_guest_share = 1
            WHERE uploader_type = 'guest' AND share_key IS NOT NULL;
        `);
      }
      if (!columns.some((col) => col.name === 'copied_from_guest_id')) {
        this.db.exec('ALTER TABLE images ADD COLUMN copied_from_guest_id TEXT');
      }
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_images_share_key ON images(share_key) WHERE share_key IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_images_share_thumb ON images(share_thumb_key) WHERE share_thumb_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_images_random_album ON images(album_id)
          WHERE uploader_type = 'admin' AND deleted_at IS NULL AND share_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_images_guest_copies ON images(copied_from_guest_id, album_id)
          WHERE copied_from_guest_id IS NOT NULL;
      `);
      if (!this.db.prepare('PRAGMA table_info(api_tokens)').all().some((col) => col.name === 'expires_at')) {
        this.db.exec('ALTER TABLE api_tokens ADD COLUMN expires_at TEXT');
        this.db.prepare('UPDATE api_tokens SET expires_at = ?').run(
          new Date(Date.now() + DEFAULT_TOKEN_LIFETIME_DAYS * 86_400_000).toISOString()
        );
      }
    });
  }

  private setSettingIfMissing(key: string, value: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
      .run(key, value);
  }

  private seedDefaults(envConfig: EnvConfig): void {
    this.setSettingIfMissing(SETTING_KEYS.SITE_TITLE, envConfig.siteTitle);
    this.setSettingIfMissing(SETTING_KEYS.ALLOW_GUEST_UPLOAD, 'false');
    this.setSettingIfMissing(SETTING_KEYS.GUEST_MAX_SIZE_MB, '5');
    this.setSettingIfMissing(SETTING_KEYS.GUEST_RATE_LIMIT_PER_MIN, '10');
    this.setSettingIfMissing(SETTING_KEYS.GUEST_TTL_DAYS, '7');
    this.setSettingIfMissing(
      SETTING_KEYS.ADMIN_MAX_SIZE_MB,
      String(Math.min(100, envConfig.hardMaxUploadMb))
    );
    const legacyAutoWebp = this.getSetting(SETTING_KEYS.AUTO_WEBP);
    this.setSettingIfMissing(SETTING_KEYS.WEBP_MODE,
      legacyAutoWebp === null ? 'guest_only' : legacyAutoWebp === 'true' ? 'all' : 'off');
    this.setSettingIfMissing(SETTING_KEYS.WEBP_QUALITY, '84');
    this.setSettingIfMissing(SETTING_KEYS.STRIP_EXIF, 'true');
    this.setSettingIfMissing(SETTING_KEYS.HOTLINK_PROTECTION, 'false');
    this.setSettingIfMissing(SETTING_KEYS.HOTLINK_ALLOW_EMPTY, 'false');
    this.setSettingIfMissing(SETTING_KEYS.ALLOWED_REFERERS, '');
    this.setSettingIfMissing(SETTING_KEYS.MAX_STORAGE_GB, '0');
    this.setSettingIfMissing(SETTING_KEYS.PUBLIC_URL, '');
    this.setSettingIfMissing(SETTING_KEYS.RANDOM_API_ENABLED, 'false');
    this.setSettingIfMissing(SETTING_KEYS.RANDOM_API_ALBUM_IDS, '[]');

  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  getSiteIconUrl(): string | null {
    const row = this.db.prepare('SELECT revision FROM site_icon WHERE id = 1').get();
    return row ? `/api/site-icon/${row.revision}.png` : null;
  }

  getSiteIcon(revision: string): Uint8Array | undefined {
    return this.db.prepare('SELECT png FROM site_icon WHERE id = 1 AND revision = ?')
      .get(revision)?.png as Uint8Array | undefined;
  }

  setSiteIcon(revision: string, png: Buffer): void {
    this.db.prepare(`INSERT INTO site_icon (id, revision, png) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, png = excluded.png`).run(revision, png);
  }

  resetSiteIcon(): void {
    this.db.prepare('DELETE FROM site_icon WHERE id = 1').run();
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value);
  }

  isInitialized(): boolean {
    return Boolean(this.getAdminPasswordHash());
  }

  getAdminPasswordHash(): string | null {
    return this.getSetting(SETTING_KEYS.ADMIN_PASSWORD_HASH);
  }

  initializeAdmin(hash: string): boolean {
    return this.db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE settings.value = ''`)
      .run(SETTING_KEYS.ADMIN_PASSWORD_HASH, hash).changes === 1;
  }

  rotatePassword(currentHash: string, newHash: string): string | null {
    return this.transaction(() => {
      const updated = this.db.prepare('UPDATE settings SET value = ? WHERE key = ? AND value = ?')
        .run(newHash, SETTING_KEYS.ADMIN_PASSWORD_HASH, currentHash);
      if (updated.changes !== 1) return null;
      this.db.exec('DELETE FROM sessions; DELETE FROM api_tokens;');
      return this.createSession();
    });
  }

  getAdminSettings(hardMaxUploadMb: number): AdminSettings {
    const settings = new Map(this.db.prepare('SELECT key, value FROM settings WHERE key != ?')
      .all(SETTING_KEYS.ADMIN_PASSWORD_HASH).map((row) => [String(row.key), String(row.value)]));
    const bool = (k: string, def = false) => {
      const v = settings.get(k);
      return v === undefined ? def : v === 'true';
    };
    const num = (k: string, def: number) => {
      const v = Number(settings.get(k));
      return Number.isFinite(v) ? v : def;
    };

    const rawWebpMode = settings.get(SETTING_KEYS.WEBP_MODE);
    let webpMode: WebpMode = 'guest_only';
    if (rawWebpMode === 'off' || rawWebpMode === 'guest_only' || rawWebpMode === 'all') {
      webpMode = rawWebpMode;
    } else if (settings.has(SETTING_KEYS.AUTO_WEBP)) {
      webpMode = settings.get(SETTING_KEYS.AUTO_WEBP) === 'true' ? 'all' : 'off';
    }

    let randomApiAlbumIds: string[] = [];
    try {
      const parsed = JSON.parse(settings.get(SETTING_KEYS.RANDOM_API_ALBUM_IDS) || '[]');
      if (Array.isArray(parsed)) {
        randomApiAlbumIds = parsed.filter((x): x is string => typeof x === 'string').slice(0, 100);
      }
    } catch {
      randomApiAlbumIds = [];
    }

    let publicUrl = '';
    try {
      publicUrl = normalizePublicUrl(settings.get(SETTING_KEYS.PUBLIC_URL) || '');
    } catch {
      // Older databases could store arbitrary addresses.
    }
    return {
      siteTitle: settings.get(SETTING_KEYS.SITE_TITLE) || 'LumePic',
      allowGuestUpload: bool(SETTING_KEYS.ALLOW_GUEST_UPLOAD, false),
      guestMaxSizeMb: Math.min(hardMaxUploadMb, Math.max(1, num(SETTING_KEYS.GUEST_MAX_SIZE_MB, 5))),
      guestRateLimitPerMin: Math.min(120, Math.max(1, num(SETTING_KEYS.GUEST_RATE_LIMIT_PER_MIN, 10))),
      guestTtlDays: Math.min(3650, Math.max(0, num(SETTING_KEYS.GUEST_TTL_DAYS, 7))),
      adminMaxSizeMb: Math.min(
        hardMaxUploadMb,
        Math.max(1, num(SETTING_KEYS.ADMIN_MAX_SIZE_MB, 100))
      ),
      webpMode,
      webpQuality: Math.min(95, Math.max(40, num(SETTING_KEYS.WEBP_QUALITY, 84))),
      stripExif: bool(SETTING_KEYS.STRIP_EXIF, true),
      hotlinkProtection: bool(SETTING_KEYS.HOTLINK_PROTECTION, false),
      hotlinkAllowEmpty: bool(SETTING_KEYS.HOTLINK_ALLOW_EMPTY, false),
      allowedReferers: settings.get(SETTING_KEYS.ALLOWED_REFERERS) || '',
      maxStorageGb: Math.max(0, num(SETTING_KEYS.MAX_STORAGE_GB, 0)),
      publicUrl,
      randomApiEnabled: bool(SETTING_KEYS.RANDOM_API_ENABLED, false),
      randomApiAlbumIds,
    };
  }

  updateAdminSettings(patch: Partial<AdminSettings>, hardMaxUploadMb: number): AdminSettings {
    const keys: Record<keyof AdminSettings, string> = {
      siteTitle: SETTING_KEYS.SITE_TITLE,
      allowGuestUpload: SETTING_KEYS.ALLOW_GUEST_UPLOAD,
      guestMaxSizeMb: SETTING_KEYS.GUEST_MAX_SIZE_MB,
      guestRateLimitPerMin: SETTING_KEYS.GUEST_RATE_LIMIT_PER_MIN,
      guestTtlDays: SETTING_KEYS.GUEST_TTL_DAYS,
      adminMaxSizeMb: SETTING_KEYS.ADMIN_MAX_SIZE_MB,
      webpMode: SETTING_KEYS.WEBP_MODE,
      webpQuality: SETTING_KEYS.WEBP_QUALITY,
      stripExif: SETTING_KEYS.STRIP_EXIF,
      hotlinkProtection: SETTING_KEYS.HOTLINK_PROTECTION,
      hotlinkAllowEmpty: SETTING_KEYS.HOTLINK_ALLOW_EMPTY,
      allowedReferers: SETTING_KEYS.ALLOWED_REFERERS,
      maxStorageGb: SETTING_KEYS.MAX_STORAGE_GB,
      publicUrl: SETTING_KEYS.PUBLIC_URL,
      randomApiEnabled: SETTING_KEYS.RANDOM_API_ENABLED,
      randomApiAlbumIds: SETTING_KEYS.RANDOM_API_ALBUM_IDS,
    };
    return this.transaction(() => {
      const current = this.getAdminSettings(hardMaxUploadMb);
      const albumIds = patch.randomApiAlbumIds ?? current.randomApiAlbumIds;
      const randomEnabled = patch.randomApiEnabled ?? current.randomApiEnabled;
      if (patch.randomApiAlbumIds && albumIds.some((id) => !this.albumExists(id))) {
        throw new RequestError('随机图片 API 包含不存在的相册');
      }
      if (randomEnabled && !albumIds.some((id) => this.albumExists(id))) {
        throw new RequestError('开启随机图片 API 前请选择至少一个相册');
      }
      for (const key of Object.keys(patch) as Array<keyof AdminSettings>) {
        const value = patch[key];
        if (value !== undefined) this.setSetting(keys[key], Array.isArray(value) ? JSON.stringify(value) : String(value));
      }
      return this.getAdminSettings(hardMaxUploadMb);
    });
  }

  // --- Sessions ---
  createSession(days = 30): string {
    const rawToken = generateRandomToken(32);
    const tokenHash = sha256Hex(rawToken);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + days * 86_400_000).toISOString();
    this.db
      .prepare('INSERT INTO sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)')
      .run(tokenHash, expiresAt, now.toISOString());
    return rawToken;
  }

  verifySession(rawToken: string | undefined): boolean {
    if (!rawToken) return false;
    const tokenHash = sha256Hex(rawToken);
    const row = this.db
      .prepare('SELECT expires_at FROM sessions WHERE token_hash = ?')
      .get(tokenHash) as { expires_at: string } | undefined;
    if (!row) return false;
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      return false;
    }
    return true;
  }

  deleteSession(rawToken: string | undefined): void {
    if (!rawToken) return;
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256Hex(rawToken));
  }

  // --- API Tokens ---
  createApiToken(name: string, expiresInDays: number): { item: ApiTokenItem; rawToken: string } {
    const id = generateRandomToken(8);
    const rawToken = `lp_${generateRandomToken(24)}`;
    const prefix = rawToken.slice(0, 11);
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = expiresInDays === 0 ? null : new Date(now.getTime() + expiresInDays * 86_400_000).toISOString();
    this.db
      .prepare(
        'INSERT INTO api_tokens (id, name, prefix, token_hash, last_used_at, created_at, expires_at) VALUES (?, ?, ?, ?, NULL, ?, ?)'
      )
      .run(id, name.trim() || 'API Token', prefix, sha256Hex(rawToken), createdAt, expiresAt);
    return {
      rawToken,
      item: { id, name: name.trim() || 'API Token', prefix, lastUsedAt: null, createdAt, expiresAt },
    };
  }

  listApiTokens(): ApiTokenItem[] {
    const rows = this.db
      .prepare('SELECT id, name, prefix, last_used_at, created_at, expires_at FROM api_tokens ORDER BY created_at DESC')
      .all() as Array<{
      id: string;
      name: string;
      prefix: string;
      last_used_at: string | null;
      created_at: string;
      expires_at: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      lastUsedAt: r.last_used_at,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    }));
  }

  verifyApiToken(rawToken: string | undefined, updateActivity = true): boolean {
    if (!rawToken || !/^lp_[a-f0-9]{48}$/.test(rawToken)) return false;
    const tokenHash = sha256Hex(rawToken);
    const now = new Date().toISOString();
    if (!updateActivity) return Boolean(this.db.prepare(
      'SELECT 1 FROM api_tokens WHERE token_hash = ? AND (expires_at IS NULL OR expires_at > ?)'
    ).get(tokenHash, now));
    const result = this.db.prepare(
      'UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ? AND (expires_at IS NULL OR expires_at > ?)'
    ).run(now, tokenHash, now);
    return result.changes === 1;
  }

  deleteApiToken(id: string): boolean {
    const res = this.db.prepare('DELETE FROM api_tokens WHERE id = ?').run(id);
    return res.changes > 0;
  }

  // --- Albums ---
  listAlbums(): AlbumItem[] {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.name, a.created_at,
                COUNT(i.id) AS image_count,
                (SELECT i2.id FROM images i2
                 WHERE i2.album_id = a.id AND i2.deleted_at IS NULL
                 ORDER BY i2.created_at DESC LIMIT 1) AS cover_thumb
         FROM albums a
         LEFT JOIN images i ON i.album_id = a.id AND i.deleted_at IS NULL
         GROUP BY a.id
         ORDER BY a.created_at DESC`
      )
      .all() as Array<{
      id: string;
      name: string;
      created_at: string;
      image_count: number;
      cover_thumb: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      imageCount: Number(r.image_count),
      coverThumbUrl: r.cover_thumb ? `/api/images/${r.cover_thumb}/thumb` : null,
      createdAt: r.created_at,
    }));
  }

  createAlbum(name: string): AlbumItem {
    const clean = name.trim();
    if (!clean) throw new Error('EMPTY_ALBUM_NAME');
    const existing = this.db.prepare('SELECT id, name, created_at FROM albums WHERE name = ?').get(clean) as
      | { id: string; name: string; created_at: string }
      | undefined;
    if (existing) throw new RequestError('已存在同名相册', 409);
    const id = generateRandomToken(8);
    const createdAt = new Date().toISOString();
    this.db.prepare('INSERT INTO albums (id, name, created_at) VALUES (?, ?, ?)').run(id, clean, createdAt);
    return { id, name: clean, imageCount: 0, coverThumbUrl: null, createdAt };
  }

  albumExists(id: string): boolean {
    const row = this.db.prepare('SELECT 1 AS ok FROM albums WHERE id = ?').get(id) as
      | { ok: number }
      | undefined;
    return Boolean(row);
  }

  deleteAlbum(id: string): boolean {
    return this.transaction(() => {
      const result = this.db.prepare('DELETE FROM albums WHERE id = ?').run(id);
      if (result.changes === 0) return false;
      const raw = this.getSetting(SETTING_KEYS.RANDOM_API_ALBUM_IDS) || '[]';
      let ids: unknown;
      try { ids = JSON.parse(raw); } catch { ids = []; }
      const remaining = Array.isArray(ids) ? ids.filter((album) => album !== id) : [];
      this.setSetting(SETTING_KEYS.RANDOM_API_ALBUM_IDS, JSON.stringify(remaining));
      if (remaining.length === 0) this.setSetting(SETTING_KEYS.RANDOM_API_ENABLED, 'false');
      return true;
    });
  }

  renameAlbum(id: string, name: string): AlbumItem | null {
    const clean = name.trim();
    if (!clean) throw new Error('EMPTY_ALBUM_NAME');
    const existing = this.db
      .prepare('SELECT id, name, created_at FROM albums WHERE id = ?')
      .get(id) as { id: string; name: string; created_at: string } | undefined;
    if (!existing) return null;

    const conflict = this.db
      .prepare('SELECT id FROM albums WHERE name = ? AND id != ?')
      .get(clean, id) as { id: string } | undefined;
    if (conflict) throw new Error('ALBUM_EXISTS');

    this.db.prepare('UPDATE albums SET name = ? WHERE id = ?').run(clean, id);
    return this.listAlbums().find((a) => a.id === id) ?? {
      id: existing.id,
      name: clean,
      imageCount: 0,
      coverThumbUrl: null,
      createdAt: existing.created_at,
    };
  }

  // --- Images ---
  private mapRow(row: Record<string, unknown>): ImageRecord {
    let tags: string[] = [];
    try {
      tags = JSON.parse(String(row.tags_json ?? '[]'));
    } catch {
      tags = [];
    }
    let exif: ExifSummary | null = null;
    if (row.exif_json) {
      try {
        exif = JSON.parse(String(row.exif_json));
      } catch {
        exif = null;
      }
    }
    return {
      id: String(row.id),
      hash: String(row.hash),
      filename: String(row.filename),
      originalName: String(row.original_name),
      storagePath: String(row.storage_path),
      thumbPath: String(row.thumb_path),
      thumbFilename: String(row.thumb_filename),
      shareKey: row.share_key ? String(row.share_key) : null,
      shareThumbKey: row.share_thumb_key ? String(row.share_thumb_key) : null,
      mimeType: String(row.mime_type),
      width: Number(row.width),
      height: Number(row.height),
      sizeBytes: Number(row.size_bytes),
      thumbSizeBytes: row.thumb_size_bytes == null ? null : Number(row.thumb_size_bytes),
      thumbhash: String(row.thumbhash),
      uploaderType: row.uploader_type === 'guest' ? 'guest' : 'admin',
      deleteTokenHash: row.delete_token_hash ? String(row.delete_token_hash) : null,
      albumId: row.album_id ? String(row.album_id) : null,
      albumName: row.album_name ? String(row.album_name) : null,
      tags,
      exif,
      expiresAt: row.expires_at ? String(row.expires_at) : null,
      deletedAt: row.deleted_at ? String(row.deleted_at) : null,
      createdAt: String(row.created_at),
    };
  }

  toImageItem(record: ImageRecord, baseUrl: string, publicDelivery = false): ImageItem {
    const prefix = baseUrl ? baseUrl.replace(/\/+$/, '') : '';
    const sharePath = record.uploaderType === 'guest' ? '/g' : '/i';
    const shareUrl = record.shareKey ? `${prefix}${sharePath}/${record.shareKey}` : null;
    const shareThumbUrl = record.shareThumbKey ? `${prefix}${sharePath}/thumb/${record.shareThumbKey}` : null;
    return {
      id: record.id,
      hash: record.hash,
      filename: record.filename,
      originalName: record.originalName,
      mimeType: record.mimeType,
      width: record.width,
      height: record.height,
      sizeBytes: record.sizeBytes,
      thumbhash: record.thumbhash,
      url: publicDelivery && shareUrl ? shareUrl : `/api/images/${record.id}/file`,
      thumbUrl: publicDelivery && shareThumbUrl ? shareThumbUrl : `/api/images/${record.id}/thumb`,
      shareUrl,
      shareThumbUrl,
      uploaderType: record.uploaderType,
      albumId: record.albumId,
      albumName: record.albumName,
      tags: record.tags,
      exif: record.exif,
      expiresAt: record.expiresAt,
      deletedAt: record.deletedAt,
      createdAt: record.createdAt,
    };
  }

  findReusableByHash(hash: string, albumId: string | null, originalName: string): ImageRecord | null {
    const row = this.db
      .prepare(
        `SELECT i.*, a.name AS album_name
         FROM images i
         LEFT JOIN albums a ON a.id = i.album_id
         WHERE i.hash IN (?, ?) AND i.uploader_type = 'admin' AND i.deleted_at IS NULL
           AND i.album_id IS ? AND i.original_name = ? AND i.share_key IS NOT NULL
         ORDER BY i.created_at DESC
         LIMIT 1`
      )
      .get(hash, hash.slice(0, 20), albumId, originalName) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  findAnyByHash(hash: string): ImageRecord | null {
    const row = this.db
      .prepare(
        `SELECT i.*, a.name AS album_name
         FROM images i
         LEFT JOIN albums a ON a.id = i.album_id
         WHERE i.hash IN (?, ?)
         LIMIT 1`
      )
      .get(hash, hash.slice(0, 20)) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  relocateFilePair(existing: ImageRecord, replacement: Pick<ImageRecord,
    'storagePath' | 'thumbPath' | 'filename' | 'thumbFilename' | 'thumbSizeBytes'>): void {
    this.db.prepare(`UPDATE images SET storage_path = ?, thumb_path = ?, filename = ?,
      thumb_filename = ?, thumb_size_bytes = ? WHERE storage_path = ?`).run(
      replacement.storagePath, replacement.thumbPath, replacement.filename, replacement.thumbFilename,
      replacement.thumbSizeBytes, existing.storagePath
    );
    this.queueFilePair({
      storagePath: existing.storagePath,
      thumbPath: existing.thumbPath,
      sizeBytes: existing.sizeBytes + (existing.thumbSizeBytes ?? 0),
    });
  }

  insertImage(input: {
    id: string;
    hash: string;
    filename: string;
    originalName: string;
    storagePath: string;
    thumbPath: string;
    thumbFilename: string;
    mimeType: string;
    width: number;
    height: number;
    sizeBytes: number;
    thumbSizeBytes: number | null;
    shareKey: string | null;
    shareThumbKey: string | null;
    thumbhash: string;
    uploaderType: UploaderType;
    deleteTokenHash: string | null;
    albumId: string | null;
    tags: string[];
    exif: ExifSummary | null;
    expiresAt: string | null;
    copiedFromGuestId?: string;
  }): ImageRecord {
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO images (
          id, hash, filename, original_name, storage_path, thumb_path, thumb_filename,
          mime_type, width, height, size_bytes, thumb_size_bytes, share_key, share_thumb_key, thumbhash, uploader_type,
          delete_token_hash, album_id, tags_json, exif_json, expires_at, deleted_at, created_at, copied_from_guest_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      )
      .run(
        input.id,
        input.hash,
        input.filename,
        input.originalName,
        input.storagePath,
        input.thumbPath,
        input.thumbFilename,
        input.mimeType,
        input.width,
        input.height,
        input.sizeBytes,
        input.thumbSizeBytes,
        input.shareKey,
        input.shareThumbKey,
        input.thumbhash,
        input.uploaderType,
        input.deleteTokenHash,
        input.albumId,
        JSON.stringify(input.tags),
        input.exif ? JSON.stringify(input.exif) : null,
        input.expiresAt,
        createdAt,
        input.copiedFromGuestId ?? null
      );

    return this.getImageById(input.id)!;
  }

  getImageById(id: string): ImageRecord | null {
    const row = this.db
      .prepare(
        `SELECT i.*, a.name AS album_name
         FROM images i
         LEFT JOIN albums a ON a.id = i.album_id
         WHERE i.id = ?`
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  getSharedImage(key: string, thumbnail: boolean, route: UploaderType): ImageRecord | null {
    const field = thumbnail ? 'share_thumb_key' : 'share_key';
    const scope = route === 'guest' ? "i.uploader_type = 'guest'"
      : "(i.uploader_type = 'admin' OR (i.uploader_type = 'guest' AND i.legacy_guest_share = 1))";
    const row = this.db.prepare(
      `SELECT i.* FROM images i WHERE i.${field} = ? AND ${scope} AND i.deleted_at IS NULL
         AND (i.expires_at IS NULL OR i.expires_at > ?) LIMIT 1`
    ).get(key, new Date().toISOString());
    return row ? this.mapRow(row) : null;
  }

  setImageSharing(id: string, enabled: boolean): ImageRecord | null {
    const current = this.getImageById(id);
    if (!current || current.deletedAt || (current.expiresAt && Date.parse(current.expiresAt) <= Date.now())) return null;
    if (Boolean(current.shareKey) === enabled) return current;
    const share = enabled ? GalleryDB.newShareKeys(path.extname(current.filename)) : null;
    this.db.prepare('UPDATE images SET share_key = ?, share_thumb_key = ?, legacy_guest_share = 0 WHERE id = ?')
      .run(share?.shareKey ?? null, share?.shareThumbKey ?? null, id);
    return this.getImageById(id);
  }

  getRandomAdminImage(albumIds: string[], orient?: 'landscape' | 'portrait'): ImageRecord | null {
    if (albumIds.length === 0) return null;
    const placeholders = albumIds.map(() => '?').join(',');
    const orientation = orient === 'landscape' ? 'AND width > height' : orient === 'portrait' ? 'AND height > width' : '';
    const where = `WHERE deleted_at IS NULL AND uploader_type = 'admin' AND share_key IS NOT NULL
      AND (expires_at IS NULL OR expires_at > ?) AND album_id IN (${placeholders}) ${orientation}`;
    const args = [new Date().toISOString(), ...albumIds];
    const count = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM images ${where}`).get(...args)?.n ?? 0);
    if (count === 0) return null;
    const row = this.db.prepare(`SELECT * FROM images ${where} LIMIT 1 OFFSET ?`).get(...args, randomInt(count));
    return row ? this.mapRow(row) : null;
  }

  listImages(filter: ListImagesFilter = {}): { items: ImageRecord[]; total: number } {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (filter.inTrash) {
      conditions.push('i.deleted_at IS NOT NULL');
    } else {
      conditions.push('i.deleted_at IS NULL');
    }

    if (filter.uploaderType && filter.uploaderType !== 'all') {
      conditions.push('i.uploader_type = ?');
      params.push(filter.uploaderType);
    }

    if (filter.albumId) {
      if (filter.albumId === 'unassigned') {
        conditions.push('i.album_id IS NULL');
      } else {
        conditions.push('i.album_id = ?');
        params.push(filter.albumId);
      }
    }

    if (filter.search?.trim()) {
      const escaped = filter.search.trim().replace(/[\\%_]/g, '\\$&');
      const q = `%${escaped}%`;
      conditions.push(
        `(i.original_name LIKE ? ESCAPE '\\' OR i.filename LIKE ? ESCAPE '\\' OR EXISTS (
           SELECT 1 FROM json_each(CASE WHEN json_valid(i.tags_json) THEN i.tags_json ELSE '[]' END)
           WHERE type = 'text' AND value LIKE ? ESCAPE '\\'
         ))`
      );
      params.push(q, q, q);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(200, Math.max(1, filter.limit ?? 60));
    const offset = Math.max(0, filter.offset ?? 0);

    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM images i ${where}`)
      .get(...params) as { cnt: number };

    const rows = this.db
      .prepare(
        `SELECT i.*, a.name AS album_name
         FROM images i
         LEFT JOIN albums a ON a.id = i.album_id
         ${where}
         ORDER BY i.created_at DESC, i.rowid DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    return {
      total: Number(countRow.cnt),
      items: rows.map((r) => this.mapRow(r)),
    };
  }

  updateImageMeta(
    id: string,
    patch: { originalName?: string; albumId?: string | null; tags?: string[]; promoteToAdmin?: boolean }
  ): ImageRecord | null {
    if (patch.promoteToAdmin) {
      return this.transaction(() => {
        const source = this.getImageById(id);
        if (!source) return null;
        return this.copyGuestImage(source, patch);
      });
    }
    const current = this.getImageById(id);
    if (!current) return null;

    const originalName =
      patch.originalName !== undefined ? patch.originalName.trim() || current.originalName : current.originalName;
    const albumId = patch.albumId !== undefined ? patch.albumId : current.albumId;
    const tagsJson = patch.tags !== undefined ? JSON.stringify(patch.tags) : JSON.stringify(current.tags);

    this.db.prepare('UPDATE images SET original_name = ?, album_id = ?, tags_json = ? WHERE id = ?')
      .run(originalName, albumId, tagsJson, id);

    return this.getImageById(id);
  }

  batchMoveAlbum(ids: string[], albumId: string | null): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const res = this.db
      .prepare(`UPDATE images SET album_id = ? WHERE id IN (${placeholders})`)
      .run(albumId, ...ids);
    return Number(res.changes);
  }

  private copyGuestImage(
    source: ImageRecord,
    patch: { albumId?: string | null; originalName?: string; tags?: string[] }
  ): ImageRecord {
    if (source.uploaderType !== 'guest' || source.deletedAt ||
        (source.expiresAt && Date.parse(source.expiresAt) <= Date.now())) {
      throw new RequestError('只有有效的游客图片可以转存', 409);
    }

    const albumId = patch.albumId === undefined ? source.albumId : patch.albumId;
    const originalName = patch.originalName?.trim() || source.originalName;
    const tags = patch.tags ?? source.tags;
    const previous = this.db.prepare(`
      SELECT id FROM images
      WHERE copied_from_guest_id = ? AND album_id IS ? AND original_name = ? AND tags_json = ?
        AND uploader_type = 'admin' AND deleted_at IS NULL AND share_key IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(source.id, albumId, originalName, JSON.stringify(tags));
    if (previous) return this.getImageById(String(previous.id))!;

    return this.insertImage({
      ...source,
      ...GalleryDB.newShareKeys(path.extname(source.filename)),
      id: generateRandomToken(8),
      originalName,
      tags,
      uploaderType: 'admin',
      albumId,
      copiedFromGuestId: source.id,
      deleteTokenHash: null,
      expiresAt: null,
    });
  }

  copyGuestImagesToAdmin(ids: string[], albumId: string | null): ImageRecord[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.transaction(() => {
      const rows = this.db.prepare(`
        SELECT * FROM images WHERE id IN (${placeholders}) AND uploader_type = 'guest' AND deleted_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
      `).all(...ids, new Date().toISOString());
      return rows.map((row) => this.copyGuestImage(this.mapRow(row), { albumId }));
    });
  }

  softDeleteImages(ids: string[]): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const now = new Date().toISOString();
    const res = this.db
      .prepare(`UPDATE images SET deleted_at = ? WHERE id IN (${placeholders}) AND deleted_at IS NULL`)
      .run(now, ...ids);
    return Number(res.changes);
  }

  restoreImages(ids: string[]): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const res = this.db
      .prepare(`UPDATE images SET deleted_at = NULL WHERE id IN (${placeholders})
        AND deleted_at IS NOT NULL AND (expires_at IS NULL OR expires_at > ?)`)
      .run(...ids, new Date().toISOString());
    return Number(res.changes);
  }

  hardDeleteImages(ids: string[], requireTrash = false): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const where = `WHERE id IN (${placeholders})${requireTrash ? ' AND deleted_at IS NOT NULL' : ''}`;
    return this.transaction(() => {
      const rows = this.db.prepare(
        `SELECT DISTINCT storage_path, thumb_path, size_bytes, thumb_size_bytes FROM images ${where}`
      ).all(...ids);
      const deleted = this.db.prepare(`DELETE FROM images ${where}`).run(...ids);
      const stillReferenced = this.db.prepare('SELECT 1 FROM images WHERE storage_path = ? LIMIT 1');
      for (const row of rows) {
        const storagePath = String(row.storage_path);
        if (!stillReferenced.get(storagePath)) {
          this.queueFilePair({
            storagePath,
            thumbPath: String(row.thumb_path),
            sizeBytes: Number(row.size_bytes) + Number(row.thumb_size_bytes ?? 0),
          });
        }
      }
      return Number(deleted.changes);
    });
  }

  queueFilePair(pair: StoredFilePair): void {
    this.db.prepare('INSERT OR IGNORE INTO pending_file_deletes VALUES (?, ?, ?)')
      .run(pair.storagePath, pair.thumbPath, pair.sizeBytes);
  }

  getPendingFilePairs(afterPath: string): StoredFilePair[] {
    return this.db.prepare(
      'SELECT storage_path, thumb_path, size_bytes FROM pending_file_deletes WHERE storage_path > ? ORDER BY storage_path LIMIT ?'
    ).all(afterPath, CLEANUP_BATCH_SIZE).map((row) => ({
      storagePath: String(row.storage_path),
      thumbPath: String(row.thumb_path),
      sizeBytes: Number(row.size_bytes),
    }));
  }

  completeFilePair(storagePath: string): void {
    this.db.prepare('DELETE FROM pending_file_deletes WHERE storage_path = ?').run(storagePath);
  }

  getFilesWithUnknownThumbnailSize(afterPath: string): Array<Pick<StoredFilePair, 'storagePath' | 'thumbPath'>> {
    return this.db.prepare(`
      SELECT DISTINCT storage_path, thumb_path FROM images
      WHERE thumb_size_bytes IS NULL AND storage_path > ? ORDER BY storage_path LIMIT ?
    `).all(afterPath, CLEANUP_BATCH_SIZE).map((row) => ({
      storagePath: String(row.storage_path), thumbPath: String(row.thumb_path),
    }));
  }

  recordThumbnailSize(storagePath: string, size: number): void {
    this.db.prepare('UPDATE images SET thumb_size_bytes = ? WHERE storage_path = ?').run(size, storagePath);
  }

  findCleanupIds(mode: 'expired' | 'all_guest' | 'empty_trash', startedAt: string): string[] {
    const trashCutoff = new Date(Date.parse(startedAt) - 30 * 86_400_000).toISOString();
    const condition = mode === 'all_guest' ? "uploader_type = 'guest' AND created_at <= ?"
      : mode === 'empty_trash' ? 'deleted_at <= ?'
      : '(expires_at <= ? OR deleted_at <= ?)';
    const args = mode === 'expired' ? [startedAt, trashCutoff] : [startedAt];
    return this.db.prepare(`SELECT id FROM images WHERE ${condition} LIMIT ?`)
      .all(...args, CLEANUP_BATCH_SIZE).map((row) => String(row.id));
  }

  getTotalUniqueBytes(): number {
    const row = this.db.prepare(`
      SELECT (SELECT COALESCE(SUM(total), 0) FROM (
        SELECT MAX(size_bytes + COALESCE(thumb_size_bytes, 0)) AS total FROM images GROUP BY storage_path
      )) + (SELECT COALESCE(SUM(size_bytes), 0) FROM pending_file_deletes) AS total
    `).get();
    return Number(row?.total ?? 0);
  }

  getStatsCounts(): {
    totalImages: number;
    adminImages: number;
    guestImages: number;
    trashImages: number;
    usedBytes: number;
    guestUsedBytes: number;
  } {
    const counts = this.db
      .prepare(
        `SELECT
           COUNT(CASE WHEN deleted_at IS NULL THEN 1 END) AS total_active,
           COUNT(CASE WHEN deleted_at IS NULL AND uploader_type = 'admin' THEN 1 END) AS admin_active,
           COUNT(CASE WHEN deleted_at IS NULL AND uploader_type = 'guest' THEN 1 END) AS guest_active,
           COUNT(CASE WHEN deleted_at IS NOT NULL THEN 1 END) AS trash_count
         FROM images`
      )
      .get() as {
      total_active: number;
      admin_active: number;
      guest_active: number;
      trash_count: number;
    };

    const guestUniqueRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(total), 0) AS total FROM (
           SELECT MAX(size_bytes + COALESCE(thumb_size_bytes, 0)) AS total
           FROM images
           WHERE deleted_at IS NULL AND uploader_type = 'guest'
           GROUP BY storage_path
         )`
      )
      .get() as { total: number } | undefined;

    return {
      totalImages: Number(counts.total_active),
      adminImages: Number(counts.admin_active),
      guestImages: Number(counts.guest_active),
      trashImages: Number(counts.trash_count),
      usedBytes: this.getTotalUniqueBytes(),
      guestUsedBytes: Number(guestUniqueRow?.total ?? 0),
    };
  }

  cleanupExpiredSessions(): void {
    this.db
      .prepare('DELETE FROM sessions WHERE expires_at <= ?')
      .run(new Date().toISOString());
  }

  static safeExtName(originalName: string): string {
    return [...path.basename(originalName.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '_')]
      .slice(0, 180).join('') || 'image';
  }

  static newShareKeys(extension: string): { shareKey: string; shareThumbKey: string } {
    const secret = generateRandomToken(16);
    return { shareKey: `${secret}${extension}`, shareThumbKey: `${secret}_400w.webp` };
  }
}
