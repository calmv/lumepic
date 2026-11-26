import sharp from 'sharp';
import exifReader from 'exif-reader';
import { rgbaToThumbHash } from 'thumbhash';
import type { ExifSummary } from '../shared/types.js';
import { sha256Hex } from './security.js';

export interface ProcessImageOptions {
  autoWebp: boolean;
  webpQuality: number;
  stripExif: boolean;
  maxPixels?: number;
  maxWorkingBytes?: number;
}

export interface ProcessedImageResult {
  hash: string;
  ext: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  thumbhash: string;
  exif: ExifSummary | null;
  buffer: Buffer;
  thumbBuffer: Buffer;
}

const FORMAT_META: Record<string, { ext: string; mimeType: string }> = {
  jpeg: { ext: 'jpg', mimeType: 'image/jpeg' },
  png: { ext: 'png', mimeType: 'image/png' },
  webp: { ext: 'webp', mimeType: 'image/webp' },
  avif: { ext: 'avif', mimeType: 'image/avif' },
  gif: { ext: 'gif', mimeType: 'image/gif' },
};

export const MAX_GUEST_PIXELS = 50_000_000;
export const MAX_ADMIN_PIXELS = 80_000_000;
const MAX_ANIMATION_PIXELS = 80_000_000;
const MAX_ANIMATION_FRAMES = 300;
const MAX_WEBP_DIMENSION = 16_383;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const DROPPED_PNG_CHUNKS = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME', 'caBX']);

sharp.concurrency(1);
sharp.cache({ memory: 24, files: 0, items: 48 });

function stripJpegMetadataLossless(input: Buffer): Buffer | null {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return null;
  const chunks: Buffer[] = [input.subarray(0, 2)];
  let pos = 2;
  while (pos < input.length) {
    if (input[pos] !== 0xff) return null;
    while (pos < input.length && input[pos] === 0xff) pos++;
    if (pos >= input.length) return null;
    const marker = input[pos]!;
    pos++;
    if (marker === 0x00) return null;
    if (marker === 0xd9) {
      chunks.push(Buffer.from([0xff, 0xd9]));
      return Buffer.concat(chunks);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      chunks.push(Buffer.from([0xff, marker]));
      continue;
    }
    if (pos + 2 > input.length) return null;
    const segLen = input.readUInt16BE(pos);
    if (segLen < 2 || pos + segLen > input.length) return null;
    const segEnd = pos + segLen;
    const isMetadata = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (!isMetadata) {
      chunks.push(Buffer.from([0xff, marker]), input.subarray(pos, segEnd));
    }
    pos = segEnd;
    if (marker === 0xda) {
      const scanStart = pos;
      while (pos < input.length) {
        const ff = input.indexOf(0xff, pos);
        if (ff === -1) return null;
        let next = ff + 1;
        while (next < input.length && input[next] === 0xff) next++;
        if (next >= input.length) return null;
        const code = input[next]!;
        if (code === 0x00 || (code >= 0xd0 && code <= 0xd7)) {
          pos = next + 1;
          continue;
        }
        chunks.push(input.subarray(scanStart, ff));
        pos = ff;
        break;
      }
    }
  }
  return null;
}

function stripPngMetadataLossless(input: Buffer): Buffer | null {
  if (input.length < 8 || !input.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const chunks: Buffer[] = [input.subarray(0, 8)];
  let pos = 8;
  while (pos + 12 <= input.length) {
    const length = input.readUInt32BE(pos);
    if (length > input.length - pos - 12) return null;
    const type = input.toString('latin1', pos + 4, pos + 8);
    const chunkEnd = pos + 12 + length;
    if (!DROPPED_PNG_CHUNKS.has(type)) {
      chunks.push(input.subarray(pos, chunkEnd));
    }
    if (type === 'IEND') return Buffer.concat(chunks);
    pos = chunkEnd;
  }
  return null;
}

function readApngFrames(input: Buffer, width: number, height: number): number | undefined {
  let declaredFrames: number | undefined;
  let frameCount = 0;
  let sawImageData = false;
  for (let pos = 8; pos + 12 <= input.length;) {
    const size = input.readUInt32BE(pos);
    if (size > input.length - pos - 12) break;
    const chunkType = input.toString('latin1', pos + 4, pos + 8);
    const data = pos + 8;
    if (chunkType === 'IDAT') sawImageData = true;
    if (chunkType === 'acTL') {
      if (size !== 8 || declaredFrames !== undefined || sawImageData) break;
      declaredFrames = input.readUInt32BE(data);
      if (declaredFrames > MAX_ANIMATION_FRAMES) throw new Error('IMAGE_TOO_LARGE');
      if (!declaredFrames) break;
    }
    if (chunkType === 'fcTL') {
      if (size !== 26 || declaredFrames === undefined || ++frameCount > declaredFrames) break;
      const frameWidth = input.readUInt32BE(data + 4);
      const frameHeight = input.readUInt32BE(data + 8);
      const offsetX = input.readUInt32BE(data + 12);
      const offsetY = input.readUInt32BE(data + 16);
      if (!frameWidth || !frameHeight || offsetX + frameWidth > width || offsetY + frameHeight > height) break;
    }
    if (chunkType === 'IEND' && frameCount === (declaredFrames ?? 0)) {
      return declaredFrames !== undefined && declaredFrames > 1 ? declaredFrames : undefined;
    }
    pos += 12 + size;
  }
  throw new Error('UNSUPPORTED_IMAGE');
}

function stripWebpMetadataLossless(input: Buffer): Buffer | null {
  if (input.length < 12 || input.toString('latin1', 0, 4) !== 'RIFF' || input.toString('latin1', 8, 12) !== 'WEBP') {
    return null;
  }
  const riffEnd = Math.min(input.length, 8 + input.readUInt32LE(4));
  const bodyChunks: Buffer[] = [];
  let bodyLength = 0;
  let pos = 12;
  while (pos + 8 <= riffEnd) {
    const fourCC = input.toString('latin1', pos, pos + 4);
    const size = input.readUInt32LE(pos + 4);
    if (size > riffEnd - pos - 8) return null;
    const padded = size + (size & 1);
    const nextPos = pos + 8 + padded;
    if (fourCC !== 'EXIF' && fourCC !== 'XMP ') {
      if (fourCC === 'VP8X' && size === 10 && pos + 18 <= riffEnd) {
        const vp8x = Buffer.from(input.subarray(pos, pos + 18));
        vp8x[8] = vp8x[8]! & ~(0x08 | 0x04);
        bodyChunks.push(vp8x);
        bodyLength += vp8x.length;
      } else {
        const sliceEnd = Math.min(riffEnd, nextPos);
        const raw = input.subarray(pos, sliceEnd);
        bodyChunks.push(raw);
        bodyLength += raw.length;
        if ((size & 1) === 1 && sliceEnd < nextPos) {
          bodyChunks.push(Buffer.from([0]));
          bodyLength += 1;
        }
      }
    }
    pos = nextPos;
  }
  if (bodyLength === 0) return null;
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + bodyLength, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, ...bodyChunks]);
}

function stripGifMetadataLossless(input: Buffer): Buffer | null {
  if (input.length < 14) return null;
  const sig = input.toString('ascii', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  const packed = input[10]!;
  let pos = 13 + ((packed & 0x80) !== 0 ? 3 * (1 << ((packed & 0x07) + 1)) : 0);
  if (pos > input.length) return null;
  const chunks: Buffer[] = [input.subarray(0, pos)];

  const skipSubBlocks = (start: number): number | null => {
    let p = start;
    while (p < input.length) {
      const len = input[p]!;
      p += 1;
      if (len === 0) return p;
      if (p + len > input.length) return null;
      p += len;
    }
    return null;
  };

  while (pos < input.length) {
    const introducer = input[pos]!;
    if (introducer === 0x3b) {
      chunks.push(Buffer.from([0x3b]));
      return Buffer.concat(chunks);
    }
    if (introducer === 0x2c) {
      if (pos + 11 > input.length) return null;
      const localPacked = input[pos + 9]!;
      const localTableBytes = (localPacked & 0x80) !== 0 ? 3 * (1 << ((localPacked & 0x07) + 1)) : 0;
      const lzwStart = pos + 10 + localTableBytes;
      if (lzwStart + 1 > input.length) return null;
      const end = skipSubBlocks(lzwStart + 1);
      if (end === null) return null;
      chunks.push(input.subarray(pos, end));
      pos = end;
      continue;
    }
    if (introducer === 0x21) {
      if (pos + 2 > input.length) return null;
      const label = input[pos + 1]!;
      if (label === 0xff && pos + 14 <= input.length && input[pos + 2] === 11) {
        const appId = input.toString('latin1', pos + 3, pos + 14);
        if (appId === 'XMP DataXMP') return null;
      }
      const end = skipSubBlocks(pos + 2);
      if (end === null) return null;
      if (label !== 0xfe) {
        chunks.push(input.subarray(pos, end));
      }
      pos = end;
      continue;
    }
    return null;
  }
  return null;
}

function tryStripMetadataLossless(input: Buffer, format: string): Buffer | null {
  switch (format) {
    case 'jpeg': return stripJpegMetadataLossless(input);
    case 'png': return stripPngMetadataLossless(input);
    case 'webp': return stripWebpMetadataLossless(input);
    case 'gif': return stripGifMetadataLossless(input);
    default: return null;
  }
}

function detectFormat(input: Buffer): string | undefined {
  if (input.length < 12) return;
  if (input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) return 'jpeg';
  if (input.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  const signature = input.toString('ascii', 0, 6);
  if (signature === 'GIF87a' || signature === 'GIF89a') return 'gif';
  if (input.toString('latin1', 0, 4) === 'RIFF' && input.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  for (let start = 0; start + 16 <= Math.min(input.length, 4096);) {
    const size = input.readUInt32BE(start);
    if (size < 8 || start + size > input.length) break;
    if (input.toString('latin1', start + 4, start + 8) === 'ftyp') {
      const end = Math.min(start + size, start + 512);
      for (let offset = start + 8; offset + 4 <= end; offset += 4) {
        if (offset === start + 12) continue; // Minor version, not a brand.
        const brand = input.toString('latin1', offset, offset + 4);
        if (brand === 'avif' || brand === 'avis') return 'avif';
      }
      break;
    }
    start += size;
  }
}

export async function processSiteIcon(input: Buffer): Promise<Buffer> {
  const format = detectFormat(input);
  if (format !== 'png' && format !== 'jpeg' && format !== 'webp') throw new Error('UNSUPPORTED_IMAGE');
  return sharp(input, { failOn: 'error', limitInputPixels: 16_000_000 })
    .autoOrient()
    .resize({ width: 128, height: 128, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
}

function formatExposureTime(val: unknown): string | undefined {
  if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) return undefined;
  if (val >= 1) return `${val.toFixed(1).replace(/\.0$/, '')}s`;
  const denom = Math.round(1 / val);
  return denom > 0 ? `1/${denom}s` : undefined;
}

function extractExifSummary(exifBuf: Buffer | undefined): ExifSummary | null {
  if (!exifBuf) return null;
  try {
    const parsed = exifReader(exifBuf) as unknown as {
      Image?: Record<string, unknown>;
      Photo?: Record<string, unknown>;
    };
    const image = parsed.Image ?? {};
    const photo = parsed.Photo ?? {};

    const make = typeof image.Make === 'string' ? image.Make.trim() : undefined;
    const model = typeof image.Model === 'string' ? image.Model.trim() : undefined;
    const fNumber = typeof photo.FNumber === 'number' ? Number(photo.FNumber.toFixed(1)) : undefined;
    const exposureTime = formatExposureTime(photo.ExposureTime);
    const isoRaw = photo.ISOSpeedRatings ?? photo.PhotographicSensitivity;
    const iso = Array.isArray(isoRaw)
      ? typeof isoRaw[0] === 'number'
        ? isoRaw[0]
        : undefined
      : typeof isoRaw === 'number'
        ? isoRaw
        : undefined;
    const focalLength =
      typeof photo.FocalLength === 'number' ? Math.round(photo.FocalLength) : undefined;
    const dateRaw = photo.DateTimeOriginal;
    const dateTimeOriginal =
      dateRaw instanceof Date
        ? dateRaw.toISOString()
        : typeof dateRaw === 'string'
          ? dateRaw
          : undefined;

    const summary: ExifSummary = {
      ...(make ? { make } : {}),
      ...(model ? { model } : {}),
      ...(fNumber ? { fNumber } : {}),
      ...(exposureTime ? { exposureTime } : {}),
      ...(iso ? { iso } : {}),
      ...(focalLength ? { focalLength } : {}),
      ...(dateTimeOriginal ? { dateTimeOriginal } : {}),
    };

    return Object.keys(summary).length > 0 ? summary : null;
  } catch {
    return null;
  }
}

export async function processUploadedImage(
  inputBuffer: Buffer,
  options: ProcessImageOptions
): Promise<ProcessedImageResult> {
  const format = detectFormat(inputBuffer);
  if (!format) throw new Error('UNSUPPORTED_IMAGE');
  const maxPixels = options.maxPixels ?? MAX_GUEST_PIXELS;
  const inputOpts = { failOn: 'error' as const, limitInputPixels: maxPixels };
  const meta = await sharp(inputBuffer, inputOpts).metadata();
  const decodedFormat = meta.format === 'heif' && meta.compression === 'av1' ? 'avif' : meta.format;
  if (decodedFormat !== format) throw new Error('UNSUPPORTED_IMAGE');

  const apngFrames = format === 'png' ? readApngFrames(inputBuffer, meta.width, meta.height) : undefined;
  const frames = apngFrames ?? meta.pages ?? 1;
  const frameHeight = meta.pageHeight ?? meta.height;
  const pixels = meta.width * frameHeight;
  if (!pixels || pixels > maxPixels || frames > MAX_ANIMATION_FRAMES || pixels * frames > MAX_ANIMATION_PIXELS) {
    throw new Error('IMAGE_TOO_LARGE');
  }
  const animated = apngFrames !== undefined || frames > 1;
  const fitsWebp = meta.width <= MAX_WEBP_DIMENSION && meta.height <= MAX_WEBP_DIMENSION;
  const outFormat = !animated && options.autoWebp && fitsWebp ? 'webp' : format;
  let finalBuffer = inputBuffer;
  const quality = Math.min(95, Math.max(40, options.webpQuality));
  const needsAutoOrient = meta.orientation !== undefined && meta.orientation !== 1;
  const hasEmbeddedMeta = Boolean(meta.exif || meta.xmp || meta.iptc || (meta.comments && meta.comments.length > 0));

  let needsReencode = outFormat !== format;
  if (!needsReencode && options.stripExif) {
    if (needsAutoOrient) {
      if (apngFrames !== undefined) throw new Error('UNSUPPORTED_APNG_ORIENTATION');
      needsReencode = true;
    } else if (format === 'avif') {
      needsReencode = hasEmbeddedMeta;
    } else {
      const stripped = tryStripMetadataLossless(inputBuffer, format);
      if (stripped) {
        try {
          const checkMeta = await sharp(stripped, {
            ...inputOpts,
            animated,
            limitInputPixels: animated ? MAX_ANIMATION_PIXELS : maxPixels,
          }).metadata();
          if (!checkMeta.exif && !checkMeta.xmp && !checkMeta.iptc &&
              (!checkMeta.comments || checkMeta.comments.length === 0)) {
            finalBuffer = stripped;
          } else {
            needsReencode = true;
          }
        } catch {
          needsReencode = true;
        }
      } else {
        needsReencode = true;
      }
    }
  } else if (animated) {
    // Validate all animation frames even when preserving original buffer untouched.
    await sharp(inputBuffer, { ...inputOpts, animated: true, limitInputPixels: MAX_ANIMATION_PIXELS }).metadata();
  }

  const bytesPerPixel = meta.depth === 'uchar' ? 4 : 8;
  const workingBytes = !needsReencode
    ? pixels * bytesPerPixel + inputBuffer.byteLength * 2
    : animated
      ? pixels * frames * bytesPerPixel * 2
      : pixels * (bytesPerPixel + 4);
  if (options.maxWorkingBytes !== undefined && workingBytes > options.maxWorkingBytes) {
    throw new Error('IMAGE_MEMORY_BUDGET');
  }

  if (needsReencode) {
    // Sharp does not encode APNG, so a failed lossless pass must not flatten its animation.
    if (apngFrames !== undefined) throw new Error('UNSUPPORTED_IMAGE');
    let pipeline = sharp(inputBuffer, {
      ...inputOpts,
      animated,
      limitInputPixels: animated ? MAX_ANIMATION_PIXELS : maxPixels,
    }).autoOrient();
    if (!options.stripExif) pipeline = pipeline.keepMetadata();
    switch (outFormat) {
      case 'jpeg': pipeline = pipeline.jpeg({ quality: 92, mozjpeg: true }); break;
      case 'png': pipeline = pipeline.png({ compressionLevel: 6 }); break;
      case 'webp': pipeline = pipeline.webp({ quality }); break;
      case 'avif':
        if (animated) throw new Error('UNSUPPORTED_ANIMATION');
        pipeline = pipeline.avif({ quality: 82 });
        break;
      case 'gif': pipeline = pipeline.gif({ reuse: true, effort: 3 }); break;
    }
    finalBuffer = await pipeline.toBuffer();
  }

  const finalMeta = finalBuffer === inputBuffer ? meta : await sharp(finalBuffer, inputOpts).metadata();
  const width = finalMeta.autoOrient?.width ?? finalMeta.width;
  const height = finalMeta.pageHeight ?? finalMeta.autoOrient?.height ?? finalMeta.height;
  const thumbBuffer = await sharp(finalBuffer, inputOpts).autoOrient()
    .resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 78 })
    .toBuffer();
  const { data: rgba, info } = await sharp(thumbBuffer, inputOpts)
    .resize(96, 96, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const formatInfo = FORMAT_META[outFormat]!;

  return {
    hash: sha256Hex(finalBuffer),
    ext: formatInfo.ext,
    mimeType: formatInfo.mimeType,
    width,
    height,
    sizeBytes: finalBuffer.byteLength,
    thumbhash: Buffer.from(rgbaToThumbHash(info.width, info.height, rgba)).toString('base64'),
    exif: options.stripExif ? null : extractExifSummary(meta.exif),
    buffer: finalBuffer,
    thumbBuffer,
  };
}
