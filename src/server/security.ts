import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import type { Context } from 'hono';
import { isLoopback, type EnvConfig } from './config.js';
import { MIN_ADMIN_PASSWORD_LENGTH } from '../shared/types.js';

const scrypt = promisify(crypto.scrypt);
export const MAX_PASSWORD_BYTES = 256;

export function isNewPasswordValid(password: string): boolean {
  return password.length >= MIN_ADMIN_PASSWORD_LENGTH && password.trim().length > 0 &&
    Buffer.byteLength(password) <= MAX_PASSWORD_BYTES;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = (await scrypt(password, salt, 64) as Buffer).toString('hex');
  return `${salt}:${derived}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  if (!salt || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, salt, 64) as Buffer;
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

export function generateRandomToken(byteLength = 32): string {
  return crypto.randomBytes(byteLength).toString('hex');
}

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function matchesSecret(input: string, expected: string): boolean {
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(input).digest(),
    crypto.createHash('sha256').update(expected).digest()
  );
}

export interface PeerConnection {
  remoteAddress?: string;
  encrypted?: boolean;
}

export function getPeerConnection(c: Context): PeerConnection {
  return c.env?.incoming?.socket ?? {};
}

export function getRequestSecurity(c: Context, config: EnvConfig, peer: PeerConnection) {
  const normalizeIp = (ip: string) => ip.toLowerCase().replace(/^::ffff:/, '');
  const address = normalizeIp(peer.remoteAddress ?? '');
  const trusted = config.trustProxy && config.trustedProxyIps.some((ip) => normalizeIp(ip) === address);
  const forwardedIp = trusted ? normalizeIp(c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() ?? '') : '';
  const ip = isIP(forwardedIp) ? forwardedIp : address || 'unknown';
  const secure = peer.encrypted === true || (trusted && c.req.header('x-forwarded-proto') === 'https');
  const authority = (trusted && c.req.header('x-forwarded-host')) || c.req.header('host') || new URL(c.req.url).host;
  let origin = '';
  let local = false;
  try {
    if (/^(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])(?::[0-9]{1,5})?$/i.test(authority)) {
      const url = new URL(`${secure ? 'https' : 'http'}://${authority}`);
      origin = url.origin;
      local = !trusted && isLoopback(address) && isLoopback(url.hostname);
    }
  } catch {
    // Rejected by the request policy.
  }
  return { ip, secure, local, origin };
}

export class Capacity {
  private active = 0;
  private reserved = 0;

  constructor(private readonly parallel: number, private readonly budget = Infinity) {}

  acquire(weight = 1): (() => void) | undefined {
    if (this.active >= this.parallel || this.reserved + weight > this.budget) return;
    this.active++;
    this.reserved += weight;
    return () => {
      this.active--;
      this.reserved -= weight;
    };
  }
}

export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number; blocked: boolean }>();
  private nextSweep = 0;

  constructor(private readonly maxEntries = 4096) {}

  private sweepExpired(now: number): void {
    for (const [id, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(id);
    }
    this.nextSweep = now + 1000;
  }

  private evictOne(): void {
    // Prefer evicting the oldest unblocked key so single-hit botnet churn cannot
    // globally lock out legitimate users OR evict already-blocked brute-force IPs.
    let earliestBlockedKey: string | undefined;
    let earliestBlockedReset = Infinity;
    for (const [id, entry] of this.hits) {
      if (!entry.blocked) {
        this.hits.delete(id);
        return;
      }
      if (entry.resetAt < earliestBlockedReset) {
        earliestBlockedReset = entry.resetAt;
        earliestBlockedKey = id;
      }
    }
    if (earliestBlockedKey !== undefined) {
      this.hits.delete(earliestBlockedKey);
    }
  }

  consume(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterSec: number } {
    const now = Date.now();
    if (now >= this.nextSweep) {
      this.sweepExpired(now);
    }
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (entry) this.hits.delete(key);
      if (this.hits.size >= this.maxEntries) {
        this.sweepExpired(now);
        if (this.hits.size >= this.maxEntries) this.evictOne();
      }
      entry = { count: 0, resetAt: now + windowMs, blocked: false };
      this.hits.set(key, entry);
    } else {
      // Refresh LRU order so active keys stay warm.
      this.hits.delete(key);
      this.hits.set(key, entry);
    }
    if (entry.count >= limit) {
      entry.blocked = true;
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
    }
    entry.count++;
    if (entry.count >= limit) entry.blocked = true;
    return { allowed: true, retryAfterSec: 0 };
  }
}

export function isRefererAllowed(
  refererHeader: string | undefined,
  requestOrigin: string,
  allowedListRaw: string,
  allowEmpty = false
): boolean {
  if (!refererHeader) return allowEmpty;

  let refHost = '';
  try {
    const referer = new URL(refererHeader);
    if (referer.protocol !== 'http:' && referer.protocol !== 'https:') return false;
    if (referer.origin === requestOrigin) return true;
    refHost = referer.hostname.toLowerCase();
  } catch {
    return false;
  }

  const patterns = allowedListRaw
    .split(/[\n,]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (patterns.length === 0) return false;

  return patterns.some((pattern) => {
    if (pattern.startsWith('*.')) {
      const domain = pattern.slice(2);
      return refHost.endsWith(`.${domain}`);
    }
    return refHost === pattern;
  });
}
