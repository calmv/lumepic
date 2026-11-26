import path from 'node:path';
import { serve } from '@hono/node-server';
import { getEnvConfig, isLoopback, loadDotEnv } from './config.js';
import { GalleryDB } from './db.js';
import { LocalStorageDriver } from './storage.js';
import { createApp } from './app.js';
import { backfillThumbnailSizes, runCleanupTask, startPeriodicCleanup } from './cleanup.js';
import { hashPassword, isNewPasswordValid } from './security.js';

loadDotEnv();
const config = getEnvConfig();
const storage = new LocalStorageDriver(config.dataDir);
storage.ensureDirectories();

const dbPath = path.join(storage.dbDir, 'gallery.db');
const db = new GalleryDB(dbPath, config);

if (!db.isInitialized()) {
  if (config.initialAdminPassword) {
    if (!isNewPasswordValid(config.initialAdminPassword)) {
      throw new Error('初始化管理员密码至少需要 12 个字符，且不超过 256 字节');
    }
    db.initializeAdmin(await hashPassword(config.initialAdminPassword));
  } else if ((!isLoopback(config.host) || config.setupToken) && Buffer.byteLength(config.setupToken) < 32) {
    throw new Error('公网初始化必须提供至少 32 字节的一次性 SETUP_TOKEN，或预先配置初始管理员密码');
  }
}
await backfillThumbnailSizes(db, storage);
await runCleanupTask(db, storage, 'expired').catch((err) => console.error('[cleanup] startup cleanup failed:', err));
const stopCleanup = startPeriodicCleanup(db, storage);

const clientDistDir = path.resolve(process.cwd(), 'dist/client');
const app = createApp({ config, db, storage, clientDistDir });

const server = serve(
  {
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
    serverOptions: { headersTimeout: 15_000, requestTimeout: 120_000 },
  },
  (info) => {
    console.log(`[LumePic] Listening on http://${config.host}:${info.port}`);
    console.log(`[LumePic] Data directory: ${storage.dataDir}`);
  }
);

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  stopCleanup();
  server.close(() => {
    void storage.withMutation(() => db.close());
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
