import fs from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';

export interface EnvConfig {
  port: number;
  host: string;
  dataDir: string;
  siteTitle: string;
  publicUrl: string;
  initialAdminPassword: string;
  setupToken: string;
  hardMaxUploadMb: number;
  trustProxy: boolean;
  trustedProxyIps: string[];
}

export function isLoopback(value: string | undefined): boolean {
  const addr = value?.replace(/^::ffff:/i, '').replace(/^\[|\]$/g, '').toLowerCase();
  return addr === 'localhost' || addr === '::1' || (isIP(addr ?? '') === 4 && addr?.startsWith('127.') === true);
}

export function normalizePublicUrl(value: string): string {
  if (!value.trim()) return '';
  const url = new URL(value.trim());
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('外链地址必须是 HTTPS 站点源，或本机 HTTP 地址');
  }
  return url.origin;
}

function secretFromEnv(name: string): string {
  const filename = process.env[`${name}_FILE`];
  return filename ? fs.readFileSync(filename, 'utf8').replace(/\r?\n$/, '') : (process.env[name] ?? '');
}

/**
 * Load `.env` from working directory if present without overwriting existing environment variables.
 */
export function loadDotEnv(cwd = process.cwd()): void {
  const envPath = path.join(cwd, '.env');
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function getEnvConfig(overrides: Partial<EnvConfig> = {}): EnvConfig {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须介于 1 和 65535');
  const dataDir = path.resolve(process.env.DATA_DIR || './data');
  const uploadLimit = Number(process.env.HARD_MAX_UPLOAD_MB ?? 100);
  if (!Number.isInteger(uploadLimit) || uploadLimit < 1 || uploadLimit > 200) {
    throw new Error('HARD_MAX_UPLOAD_MB 必须是 1 到 200 之间的整数');
  }
  const trustedProxyIps = (process.env.TRUSTED_PROXY_IPS ?? '').split(',').map((ip) => ip.trim()).filter(Boolean);
  const trustProxy = process.env.TRUST_PROXY === 'true';
  if (trustProxy && (!trustedProxyIps.length || trustedProxyIps.some((ip) => !isIP(ip)))) {
    throw new Error('启用 TRUST_PROXY 时必须配置 TRUSTED_PROXY_IPS 为代理的实际 IP');
  }

  return {
    port,
    host: process.env.HOST || '127.0.0.1',
    dataDir,
    siteTitle: process.env.SITE_TITLE?.trim() || 'LumePic',
    publicUrl: normalizePublicUrl(process.env.PUBLIC_URL ?? ''),
    initialAdminPassword: secretFromEnv('ADMIN_PASSWORD'),
    setupToken: secretFromEnv('SETUP_TOKEN').trim(),
    hardMaxUploadMb: uploadLimit,
    trustProxy,
    trustedProxyIps,
    ...overrides,
  };
}
