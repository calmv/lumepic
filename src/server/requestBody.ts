import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Busboy from 'busboy';

export const MIB = 1024 * 1024;
export const MULTIPART_OVERHEAD = 64 * 1024;
export const JSON_BODY_LIMIT = 32 * 1024;

export class RequestError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 409 | 413 | 415 = 400) {
    super(message);
  }
}

function checkDeclaredLength(request: Request, limit: number): void {
  const length = request.headers.get('content-length');
  if (length !== null && Number(length) > limit) throw new RequestError('请求体积超过限制', 413);
}

export async function readJsonObject(
  request: Request,
  limit = JSON_BODY_LIMIT
): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new RequestError('请求必须使用 application/json', 415);
  }
  checkDeclaredLength(request, limit);

  const chunks: Buffer[] = [];
  let bytes = 0;
  const reader = request.body?.getReader();
  try {
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) throw new RequestError('请求体积超过限制', 413);
        chunks.push(Buffer.from(value));
      }
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (err) {
    if (err instanceof RequestError) throw err;
  } finally {
    reader?.releaseLock();
  }
  throw new RequestError('请求必须包含有效的 JSON 对象');
}

export function getUploadBodyLimit(request: Request, maxBytes: number, memoryLimit = Infinity): number {
  const bodyLimit = Math.min(maxBytes + MULTIPART_OVERHEAD, memoryLimit);
  const header = request.headers.get('content-length');
  if (header === null) return bodyLimit;
  const length = Number(header);
  if (!Number.isSafeInteger(length) || length < 0) throw new RequestError('上传体积无效');
  checkDeclaredLength(request, bodyLimit);
  return length;
}

export async function readImageUpload(request: Request, maxBytes: number, bodyLimit = getUploadBodyLimit(request, maxBytes)) {
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data(?:;|$)/i.test(contentType) || !request.body) {
    throw new RequestError('请使用 multipart/form-data 上传图片', 415);
  }

  const fields: { albumId?: string } = {};
  const chunks: Buffer[] = [];
  let filename = '';
  let size = 0;
  let requestBytes = 0;
  let formError: RequestError | undefined;
  try {
    const parser = Busboy({
      headers: { 'content-type': contentType },
      defParamCharset: 'utf8',
      limits: { files: 1, fields: 3, parts: 5, fileSize: maxBytes + 1, fieldSize: 512, headerPairs: 20 },
    });
    parser.on('file', (field, file, info) => {
      if (!['file', 'image', 'smfile'].includes(field)) {
        formError = new RequestError('上传字段应为 file、image 或 smfile');
        file.resume();
        return;
      }
      filename = info.filename || 'image';
      file.on('limit', () => { formError = new RequestError('图片体积超过限制', 413); });
      file.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= maxBytes) chunks.push(chunk);
      });
      file.on('error', (error) => parser.destroy(error));
    });
    parser.on('field', (name, value, info) => {
      if (info.valueTruncated) {
        formError = new RequestError('上传字段过长');
      } else if (name === 'albumId') {
        fields.albumId = value;
      }
    });
    for (const event of ['fieldsLimit', 'filesLimit', 'partsLimit'] as const) {
      parser.on(event, () => { formError ??= new RequestError('每次请求只允许上传一张图片'); });
    }

    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        requestBytes += chunk.length;
        if (requestBytes > bodyLimit) callback(new RequestError('请求体积超过限制', 413));
        else callback(null, chunk);
      },
    });
    // Keep the HTTP request stream available to the adapter if the parser rejects early.
    const reader = request.body.getReader();
    const source = Readable.from((async function* () {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          yield Buffer.from(value);
        }
      } finally {
        reader.releaseLock();
      }
    })(), { objectMode: false });
    await pipeline(source, meter, parser);
  } catch (err) {
    if (err instanceof RequestError) throw err;
    throw new RequestError('上传表单格式错误或传输中断');
  }
  if (size > maxBytes) throw new RequestError('图片体积超过限制', 413);
  if (formError) throw formError;
  if (!filename || size === 0) throw new RequestError('未检测到有效图片文件');
  return { filename, buffer: Buffer.concat(chunks, size), ...fields };
}
