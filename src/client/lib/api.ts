import type {
  AdminSettings,
  AlbumItem,
  ApiTokenItem,
  GuestUploadResult,
  ImageItem,
  PublicConfig,
  StorageStats,
  UploaderType,
} from '../../shared/types';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterSeconds?: number) {
    super(message);
  }
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError((data as { error?: string }).error || `请求失败 (${res.status})`, res.status);
  }
  return data as T;
}

export function triggerSingleImageDownload(url: string): void {
  const downloadUrl = `${url}${url.includes('?') ? '&' : '?'}download=1`;
  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export const api = {
  getPublicConfig: () => requestJson<PublicConfig>('/api/public-config'),

  setupAdmin: (password: string, setupToken?: string) =>
    requestJson<{ ok: boolean; config: PublicConfig }>('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ password, setupToken }),
    }),

  login: (password: string) =>
    requestJson<{ ok: boolean; config: PublicConfig }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  logout: () => requestJson<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  changePassword: (currentPassword: string, newPassword: string) =>
    requestJson<{ ok: boolean }>('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  uploadImage: (
    file: File,
    opts: { albumId?: string | null; isGuest?: boolean; signal?: AbortSignal;
      onProgress?: (pct: number) => void } = {}
  ) =>
    new Promise<{
      ok: boolean;
      deduplicated?: boolean;
      url: string;
      image: ImageItem;
    }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', opts.isGuest ? '/api/upload?guest=1' : '/api/upload');
      xhr.withCredentials = true;
      xhr.timeout = 125_000;

      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable && opts.onProgress) {
          opts.onProgress(Math.round((ev.loaded / ev.total) * 100));
        }
      };

      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText || '{}');
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(data);
          } else {
            const seconds = Number(xhr.getResponseHeader('Retry-After'));
            reject(new ApiError(data.error || `上传失败 (${xhr.status})`, xhr.status,
              Number.isInteger(seconds) && seconds > 0 ? seconds : undefined));
          }
        } catch {
          reject(new Error(`上传失败 (${xhr.status})`));
        }
      };

      xhr.onerror = () => reject(new Error('网络错误，无法连接到图床服务器'));
      xhr.ontimeout = () => reject(new Error('上传超时，请重试'));
      xhr.onabort = () => reject(new Error('上传已取消'));
      const abort = () => xhr.abort();
      xhr.onloadend = () => opts.signal?.removeEventListener('abort', abort);

      const form = new FormData();
      form.append('file', file);
      if (opts.albumId) {
        form.append('albumId', opts.albumId);
      }
      if (opts.signal?.aborted) {
        reject(new Error('上传已取消'));
        return;
      }
      opts.signal?.addEventListener('abort', abort, { once: true });
      xhr.send(form);
    }),

  listImages: (params: {
    search?: string;
    albumId?: string;
    uploaderType?: UploaderType | 'all';
    trash?: boolean;
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
  }) => {
    const qs = new URLSearchParams();
    if (params.search) qs.set('search', params.search);
    if (params.albumId) qs.set('albumId', params.albumId);
    if (params.uploaderType && params.uploaderType !== 'all') {
      qs.set('uploaderType', params.uploaderType);
    }
    if (params.trash) qs.set('trash', 'true');
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.offset) qs.set('offset', String(params.offset));
    return requestJson<{ total: number; items: ImageItem[] }>(`/api/images?${qs.toString()}`, { signal: params.signal });
  },

  updateImage: (
    id: string,
    patch: {
      originalName?: string;
      albumId?: string | null;
      tags?: string[];
      promoteToAdmin?: boolean;
    }
  ) =>
    requestJson<{ ok: boolean; image: ImageItem }>(`/api/images/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteImage: (id: string, permanent = false) =>
    requestJson<{ ok: boolean }>(
      `/api/images/${encodeURIComponent(id)}${permanent ? '?permanent=true' : ''}`,
      { method: 'DELETE' }
    ),

  setImageSharing: (id: string, enabled: boolean) =>
    requestJson<{ ok: boolean; image: ImageItem }>(`/api/images/${encodeURIComponent(id)}/share`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),

  shareImages: (ids: string[]) =>
    requestJson<{ ok: boolean; items: ImageItem[] }>('/api/images/batch', {
      method: 'POST',
      body: JSON.stringify({ action: 'share', ids }),
    }),

  batchImages: (
    action: 'trash' | 'restore' | 'delete' | 'move' | 'promote',
    ids: string[],
    albumId?: string | null
  ) =>
    requestJson<{ ok: boolean; affected: number }>('/api/images/batch', {
      method: 'POST',
      body: JSON.stringify({ action, ids, albumId }),
    }),

  downloadZip: async (ids: string[]) => {
    const res = await fetch('/api/images/download-zip', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error((errData as { error?: string }).error || `打包下载失败 (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lumepic-export-${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },

  listAlbums: (signal?: AbortSignal) => requestJson<{ items: AlbumItem[] }>('/api/albums', { signal }),

  createAlbum: (name: string) =>
    requestJson<{ ok: boolean; album: AlbumItem }>('/api/albums', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  deleteAlbum: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/albums/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  renameAlbum: (id: string, name: string) =>
    requestJson<{ ok: boolean; album: AlbumItem }>(`/api/albums/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  getSettings: () =>
    requestJson<{ settings: AdminSettings; hardMaxUploadMb: number; publicUrlLocked: boolean }>('/api/settings'),

  uploadSiteIcon: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return requestJson<{ publicConfig: PublicConfig }>('/api/settings/site-icon', { method: 'PUT', body: form });
  },

  resetSiteIcon: () =>
    requestJson<{ publicConfig: PublicConfig }>('/api/settings/site-icon', { method: 'DELETE' }),

  updateSettings: (patch: Partial<AdminSettings>) =>
    requestJson<{ ok: boolean; settings: AdminSettings; publicConfig: PublicConfig }>(
      '/api/settings',
      {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }
    ),

  getStats: () => requestJson<StorageStats>('/api/stats'),

  cleanup: (mode: 'expired' | 'all_guest' | 'empty_trash') =>
    requestJson<{ ok: boolean; deletedCount: number }>('/api/maintenance/cleanup', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),

  listTokens: () => requestJson<{ items: ApiTokenItem[] }>('/api/tokens'),

  createToken: (name: string, expiresInDays: number) =>
    requestJson<{ ok: boolean; item: ApiTokenItem; rawToken: string }>('/api/tokens', {
      method: 'POST',
      body: JSON.stringify({ name, expiresInDays }),
    }),

  deleteToken: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/tokens/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
};

export type GuestHistoryItem = GuestUploadResult;
