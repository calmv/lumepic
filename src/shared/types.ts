export type UploaderType = 'admin' | 'guest';
export type WebpMode = 'off' | 'guest_only' | 'all';
export const MAX_BATCH_IMAGES = 200;
export const MIN_ADMIN_PASSWORD_LENGTH = 12;
export const DEFAULT_TOKEN_LIFETIME_DAYS = 90;
export const MAX_TOKEN_LIFETIME_DAYS = 36_500;
export const MAX_SITE_ICON_BYTES = 2 * 1024 * 1024;

export interface PublicConfig {
  siteTitle: string;
  siteIconUrl: string | null;
  initialized: boolean;
  requiresSetupToken: boolean;
  isAdmin: boolean;
  allowGuestUpload: boolean;
  guestMaxSizeMb: number;
  guestTtlDays: number;
  adminMaxSizeMb: number;
  publicUrl: string;
}

export interface AdminSettings {
  siteTitle: string;
  allowGuestUpload: boolean;
  guestMaxSizeMb: number;
  guestRateLimitPerMin: number;
  guestTtlDays: number;
  adminMaxSizeMb: number;
  webpMode: WebpMode;
  webpQuality: number;
  stripExif: boolean;
  hotlinkProtection: boolean;
  hotlinkAllowEmpty: boolean;
  allowedReferers: string;
  maxStorageGb: number;
  publicUrl: string;
  randomApiEnabled: boolean;
  randomApiAlbumIds: string[];
}

export interface ExifSummary {
  make?: string;
  model?: string;
  fNumber?: number;
  exposureTime?: string;
  iso?: number;
  focalLength?: number;
  dateTimeOriginal?: string;
}

export interface ImageItem {
  id: string;
  hash: string;
  filename: string;
  originalName: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  thumbhash: string;
  url: string;
  thumbUrl: string;
  shareUrl: string | null;
  shareThumbUrl: string | null;
  uploaderType: UploaderType;
  albumId: string | null;
  albumName: string | null;
  tags: string[];
  exif: ExifSummary | null;
  expiresAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export interface GuestUploadResult {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  thumbhash: string;
  url: string;
  thumbUrl: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface AlbumItem {
  id: string;
  name: string;
  imageCount: number;
  coverThumbUrl: string | null;
  createdAt: string;
}

export interface ApiTokenItem {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface StorageStats {
  totalImages: number;
  adminImages: number;
  guestImages: number;
  trashImages: number;
  usedBytes: number;
  guestUsedBytes: number;
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
  maxStorageGb: number;
}
