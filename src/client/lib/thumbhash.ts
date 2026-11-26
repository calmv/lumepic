import { thumbHashToDataURL } from 'thumbhash';

const cache = new Map<string, string>();

export function decodeThumbHashUrl(base64: string | undefined | null): string | undefined {
  if (!base64) return undefined;
  const cached = cache.get(base64);
  if (cached) return cached;

  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    const dataUrl = thumbHashToDataURL(bytes);
    if (cache.size > 1000) {
      cache.clear();
    }
    cache.set(base64, dataUrl);
    return dataUrl;
  } catch {
    return undefined;
  }
}
