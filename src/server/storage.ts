import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

export interface DiskUsageInfo {
  totalBytes: number | null;
  freeBytes: number | null;
}

export class LocalStorageDriver {
  readonly dataDir: string;
  readonly dbDir: string;
  readonly uploadsDir: string;
  readonly originalsDir: string;
  readonly thumbsDir: string;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    this.dbDir = path.join(this.dataDir, 'db');
    this.uploadsDir = path.join(this.dataDir, 'uploads');
    this.originalsDir = path.join(this.uploadsDir, 'originals');
    this.thumbsDir = path.join(this.uploadsDir, 'thumbs');
  }

  ensureDirectories(): void {
    fs.mkdirSync(this.dbDir, { recursive: true });
    fs.mkdirSync(this.originalsDir, { recursive: true });
    fs.mkdirSync(this.thumbsDir, { recursive: true });
  }

  withMutation<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.then(() => {}, () => {});
    return result;
  }

  async checkWritable(): Promise<void> {
    const mode = fs.constants.R_OK | fs.constants.W_OK;
    await Promise.all([this.dbDir, this.originalsDir, this.thumbsDir, path.join(this.dbDir, 'gallery.db')]
      .map((entry) => fs.promises.access(entry, mode)));
  }

  private resolveSafeUploadPath(relPath: string): string {
    const cleanRel = relPath.replace(/^[/\\]+/, '');
    const resolved = path.resolve(this.uploadsDir, cleanRel);
    const uploadsRoot = path.resolve(this.uploadsDir) + path.sep;
    if (!resolved.startsWith(uploadsRoot)) {
      throw new Error('Invalid storage path');
    }
    return resolved;
  }

  buildRelativePaths(fileIdHash: string, ext: string, date = new Date()): {
    storagePath: string;
    thumbPath: string;
    filename: string;
    thumbFilename: string;
  } {
    const year = String(date.getUTCFullYear());
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const filename = `${fileIdHash}.${ext}`;
    const thumbFilename = `${fileIdHash}_400w.webp`;
    return {
      storagePath: `originals/${year}/${month}/${filename}`,
      thumbPath: `thumbs/${year}/${month}/${thumbFilename}`,
      filename,
      thumbFilename,
    };
  }

  async writeImageFiles(
    storagePath: string,
    originalBuffer: Buffer,
    thumbPath: string,
    thumbBuffer: Buffer
  ): Promise<void> {
    const absOriginal = this.resolveSafeUploadPath(storagePath);
    const absThumb = this.resolveSafeUploadPath(thumbPath);

    await fs.promises.mkdir(path.dirname(absOriginal), { recursive: true });
    await fs.promises.mkdir(path.dirname(absThumb), { recursive: true });

    // Newly reserved paths are private until SQLite commits the image record.
    await fs.promises.writeFile(absOriginal, originalBuffer, { flag: 'wx' });
    await fs.promises.writeFile(absThumb, thumbBuffer, { flag: 'wx' });
  }

  async openUploadFile(relPath: string): Promise<FileHandle | null> {
    try {
      return await fs.promises.open(this.resolveSafeUploadPath(relPath), 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async getFileSize(relPath: string): Promise<number | null> {
    try {
      const stat = await fs.promises.stat(this.resolveSafeUploadPath(relPath));
      return stat.isFile() ? stat.size : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  getAbsolutePath(relPath: string): string {
    return this.resolveSafeUploadPath(relPath);
  }

  async deleteFileQuietly(relPath: string): Promise<void> {
    try {
      const absPath = this.resolveSafeUploadPath(relPath);
      await fs.promises.unlink(absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw err;
      }
    }
  }

  getDiskUsage(): DiskUsageInfo {
    try {
      const stats = fs.statfsSync(this.dataDir);
      const blockSize = Number(stats.bsize);
      const totalBytes = Number(stats.blocks) * blockSize;
      const freeBytes = Number(stats.bavail ?? stats.bfree) * blockSize;
      if (Number.isFinite(totalBytes) && Number.isFinite(freeBytes)) {
        return { totalBytes, freeBytes };
      }
    } catch {
      // Fallback if statfsSync is unavailable
    }
    return { totalBytes: null, freeBytes: null };
  }
}
