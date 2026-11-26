import { MAX_BATCH_IMAGES, type AdminSettings } from '../shared/types.js';
import { normalizePublicUrl } from './config.js';
import { RequestError } from './requestBody.js';

export function readString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.length > max) {
    throw new RequestError(`${field} 必须为不超过 ${max} 字符的文本`);
  }
  return value;
}

export function readId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{16}$/.test(value)) {
    throw new RequestError(`${field}无效`);
  }
  return value;
}

export function readImageIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BATCH_IMAGES) {
    throw new RequestError(`请选择 1 到 ${MAX_BATCH_IMAGES} 张图片`);
  }
  return [...new Set(value.map((id) => readId(id, '图片 ID')))];
}

export function readInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RequestError(`${field}必须是 ${min} 到 ${max} 之间的整数`);
  }
  return value;
}

export function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new RequestError(`${field}必须是布尔值`);
  return value;
}

export function readSettingsPatch(body: Record<string, unknown>, hardMaxMb: number): Partial<AdminSettings> {
  const fields = {
    siteTitle: (v: unknown) => readString(v, '站点名称', 80).trim() || 'LumePic',
    allowGuestUpload: (v: unknown) => readBoolean(v, '游客上传开关'),
    guestMaxSizeMb: (v: unknown) => readInteger(v, '游客上传上限', 1, hardMaxMb),
    guestRateLimitPerMin: (v: unknown) => readInteger(v, '游客每分钟限制', 1, 120),
    guestTtlDays: (v: unknown) => readInteger(v, '游客图片有效期', 0, 3650),
    adminMaxSizeMb: (v: unknown) => readInteger(v, '管理员上传上限', 1, hardMaxMb),
    webpMode: (v: unknown) => {
      if (v !== 'off' && v !== 'guest_only' && v !== 'all') throw new RequestError('WebP 模式无效');
      return v;
    },
    webpQuality: (v: unknown) => readInteger(v, 'WebP 画质', 40, 95),
    stripExif: (v: unknown) => readBoolean(v, '清除 EXIF 开关'),
    hotlinkProtection: (v: unknown) => readBoolean(v, '防盗链开关'),
    hotlinkAllowEmpty: (v: unknown) => readBoolean(v, '允许空 Referer 开关'),
    allowedReferers: (v: unknown) => readString(v, '来源白名单', 4096).trim(),
    maxStorageGb: (v: unknown) => {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100_000) {
        throw new RequestError('存储配额必须是 0 到 100000 GB 之间的数字');
      }
      return v;
    },
    publicUrl: (v: unknown) => {
      const value = readString(v, '外链地址', 2048);
      try {
        return normalizePublicUrl(value);
      } catch {
        throw new RequestError('外链地址必须是 HTTPS 站点源，或本机 HTTP 地址');
      }
    },
    randomApiEnabled: (v: unknown) => readBoolean(v, '随机图片 API 开关'),
    randomApiAlbumIds: (v: unknown) => {
      if (!Array.isArray(v) || v.length > 100) throw new RequestError('随机图库最多选择 100 个相册');
      return [...new Set(v.map((id) => readId(id, '相册 ID')))];
    },
  } satisfies Record<keyof AdminSettings, (value: unknown) => unknown>;

  return Object.fromEntries(Object.entries(body).map(([key, value]) => {
    if (!Object.hasOwn(fields, key)) throw new RequestError(`未知设置项 ${key}`);
    return [key, fields[key as keyof AdminSettings](value)];
  }));
}
