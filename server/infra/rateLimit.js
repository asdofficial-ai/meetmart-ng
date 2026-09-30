const buckets = new Map();

function prune(now, windowMs) {
  if (buckets.size < 5000) return;
  for (const [key, value] of buckets) if (now - value.startedAt >= windowMs * 2) buckets.delete(key);
}

export function createRateLimiter({windowMs = 60_000, defaultLimit = 180, authLimit = 20, sensitiveLimit = 12} = {}) {
  return function checkRateLimit(req, pathname, ip = '') {
    if (req.method === 'OPTIONS' || pathname.startsWith('/health')) return null;
    let limit = defaultLimit;
    let scope = 'default';
    if (pathname.startsWith('/auth/')) { limit = authLimit; scope = 'auth'; }
    if (
      pathname.startsWith('/identity/') ||
      pathname.includes('/reveal-address') ||
      pathname.includes('/complete-delivery') ||
      pathname.includes('/refund') ||
      pathname.includes('/disputes') ||
      pathname.startsWith('/admin/')
    ) { limit = sensitiveLimit; scope = 'sensitive'; }
    const now = Date.now();
    prune(now, windowMs);
    const key = `${scope}:${ip || 'unknown'}`;
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) {
      bucket = {startedAt: now, count: 0};
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    const remaining = Math.max(0, limit - bucket.count);
    const resetSeconds = Math.max(1, Math.ceil((bucket.startedAt + windowMs - now) / 1000));
    if (bucket.count > limit) return {allowed:false, limit, remaining:0, resetSeconds};
    return {allowed:true, limit, remaining, resetSeconds};
  };
}
