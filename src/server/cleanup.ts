import type { GalleryDB, StoredFilePair } from './db.js';
import type { LocalStorageDriver } from './storage.js';

export async function removeQueuedPair(db: GalleryDB, storage: LocalStorageDriver, pair: StoredFilePair): Promise<void> {
  try {
    await storage.deleteFileQuietly(pair.storagePath);
    await storage.deleteFileQuietly(pair.thumbPath);
    db.completeFilePair(pair.storagePath);
  } catch (error) {
    console.error('[cleanup] queued file pair will be retried:', error);
  }
}

export async function flushFileQueue(db: GalleryDB, storage: LocalStorageDriver): Promise<void> {
  let cursor = '';
  for (;;) {
    const pairs = db.getPendingFilePairs(cursor);
    if (!pairs.length) return;
    for (const pair of pairs) {
      await removeQueuedPair(db, storage, pair);
      cursor = pair.storagePath;
    }
  }
}

export async function backfillThumbnailSizes(db: GalleryDB, storage: LocalStorageDriver): Promise<void> {
  let cursor = '';
  for (;;) {
    const pairs = db.getFilesWithUnknownThumbnailSize(cursor);
    if (!pairs.length) return;
    for (const pair of pairs) {
      db.recordThumbnailSize(pair.storagePath, await storage.getFileSize(pair.thumbPath) ?? 0);
      cursor = pair.storagePath;
    }
  }
}

export async function runCleanupTask(
  db: GalleryDB,
  storage: LocalStorageDriver,
  mode: 'expired' | 'all_guest' | 'empty_trash' = 'expired'
): Promise<number> {
  const startedAt = new Date().toISOString();
  return storage.withMutation(async () => {
    db.cleanupExpiredSessions();
    let total = 0;
    for (;;) {
      const ids = db.findCleanupIds(mode, startedAt);
      if (!ids.length) break;
      total += db.hardDeleteImages(ids);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await flushFileQueue(db, storage);
    return total;
  });
}

export function startPeriodicCleanup(
  db: GalleryDB,
  storage: LocalStorageDriver,
  intervalMs = 15 * 60 * 1000
): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runCleanupTask(db, storage, 'expired');
    } catch (err) {
      console.error('[cleanup] periodic cleanup failed:', err);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
