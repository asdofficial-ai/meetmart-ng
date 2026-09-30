import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const isProduction = process.env.NODE_ENV === 'production';
const dataDir = process.env.MEETMART_DATA_DIR || path.join(__dirname, 'data');

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1','true','yes','on'].includes(String(raw).trim().toLowerCase());
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  isProduction,
  port: envNumber('PORT', 8787),
  host: process.env.HOST || '0.0.0.0',
  dataDir,
  dbPath: process.env.MEETMART_DB_PATH || path.join(dataDir, 'meetmart.sqlite'),
  uploadDir: process.env.MEETMART_UPLOAD_DIR || path.join(dataDir, 'uploads'),
  backupDir: process.env.MEETMART_BACKUP_DIR || path.join(dataDir, 'backups'),
  storageMode: process.env.MEETMART_STORAGE_MODE || (isProduction ? 'persistent_disk' : 'local'),
  frontendDir: process.env.FRONTEND_DIST_DIR || path.join(projectRoot, 'dist'),
  serveFrontend: envBool('SERVE_FRONTEND', isProduction),
  maxImageBytes: envNumber('MAX_IMAGE_BYTES', 5 * 1024 * 1024),
  maxJsonBytes: envNumber('MAX_JSON_BYTES', 1_000_000),
  sessionTtlMs: envNumber('SESSION_TTL_MS', 1000 * 60 * 60 * 24 * 14),
  cookieName: process.env.SESSION_COOKIE || 'meetmart_session',
  cookieSecure: isProduction || envBool('SESSION_COOKIE_SECURE', false),
  cookieSameSite: process.env.SESSION_SAMESITE || 'Lax',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || (isProduction ? '' : 'http://localhost:5173,http://127.0.0.1:5173'))
    .split(',').map(v => v.trim()).filter(Boolean),
  identityMode: process.env.IDENTITY_PROVIDER_MODE || 'demo',
  asdPayMode: process.env.ASD_PAY_MODE || 'demo',
  allowDemoProviders: envBool('ALLOW_DEMO_PROVIDERS', !isProduction),
  meetMartCommissionRate: envNumber('MEETMART_COMMISSION_RATE', 0.05),
  customerServiceFee: envNumber('MEETMART_CUSTOMER_SERVICE_FEE', 300),
  deliveryPinSecret: process.env.DELIVERY_PIN_SECRET || (isProduction ? '' : 'meetmart-dev-delivery-pin-secret'),
  deliveryAddressSecret: process.env.DELIVERY_ADDRESS_SECRET || (isProduction ? '' : 'meetmart-dev-address-secret'),
  rateLimitWindowMs: envNumber('RATE_LIMIT_WINDOW_MS', 60_000),
  rateLimitDefault: envNumber('RATE_LIMIT_DEFAULT', 180),
  rateLimitAuth: envNumber('RATE_LIMIT_AUTH', 20),
  rateLimitSensitive: envNumber('RATE_LIMIT_SENSITIVE', 12),
  backupEnabled: envBool('BACKUP_ENABLED', isProduction),
  backupIntervalHours: envNumber('BACKUP_INTERVAL_HOURS', 24),
  backupRetention: Math.max(1, Math.floor(envNumber('BACKUP_RETENTION', 7))),
};

export function validateRuntimeConfig({strict = config.isProduction} = {}) {
  const errors = [];
  const warnings = [];
  if (!['local','persistent_disk'].includes(config.storageMode)) errors.push('MEETMART_STORAGE_MODE must be local or persistent_disk.');
  if (strict && config.storageMode !== 'persistent_disk') errors.push('Production requires MEETMART_STORAGE_MODE=persistent_disk for the current storage adapter.');
  if (strict && String(config.deliveryPinSecret).length < 32) errors.push('DELIVERY_PIN_SECRET must be at least 32 characters in production.');
  if (strict && String(config.deliveryAddressSecret).length < 32) errors.push('DELIVERY_ADDRESS_SECRET must be at least 32 characters in production.');
  if (strict && config.deliveryPinSecret === config.deliveryAddressSecret) errors.push('DELIVERY_PIN_SECRET and DELIVERY_ADDRESS_SECRET must be different.');
  if (strict && (config.identityMode === 'demo' || config.asdPayMode === 'demo') && !config.allowDemoProviders) {
    errors.push('Demo identity/payment providers are disabled in production. Configure real providers or explicitly set ALLOW_DEMO_PROVIDERS=true for staging only.');
  }
  if (config.identityMode === 'demo') warnings.push('Identity verification is in demo mode.');
  if (config.asdPayMode === 'demo') warnings.push('ASD Pay is in demo mode; no real money moves.');
  if (config.storageMode === 'persistent_disk') warnings.push('Persistent-disk storage is suitable for single-instance staging; migrate to managed object storage before horizontal scaling.');
  return {ok: errors.length === 0, errors, warnings};
}
