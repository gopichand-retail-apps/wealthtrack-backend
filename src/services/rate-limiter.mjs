export function createRateLimiter(maximum, windowMs, now = Date.now) {
  if (!Number.isInteger(maximum) || maximum < 1) {
    throw new RangeError('maximum must be a positive integer');
  }
  if (!Number.isInteger(windowMs) || windowMs < 1) {
    throw new RangeError('windowMs must be a positive integer');
  }

  const windows = new Map();
  return function isLimited(key) {
    const timestamp = now();
    const current = windows.get(key);
    if (!current || timestamp >= current.resetAt) {
      windows.set(key, { count: 1, resetAt: timestamp + windowMs });
      return false;
    }
    current.count += 1;
    return current.count > maximum;
  };
}
