import crypto from 'node:crypto';
import {promisify} from 'node:util';
const scryptAsync = promisify(crypto.scrypt);

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw new Error('Password must be at least 8 characters.');
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, 64);
  return `scrypt:${salt}:${Buffer.from(derived).toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [kind, salt, hex] = String(stored || '').split(':');
    if (kind !== 'scrypt' || !salt || !hex) return false;
    const derived = await scryptAsync(password, salt, 64);
    const a = Buffer.from(hex, 'hex');
    const b = Buffer.from(derived);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function randomId(prefix = '') {
  return `${prefix}${crypto.randomUUID()}`;
}

export function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

export function sanitizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function safeJson(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}
