const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

interface AttemptEntry {
  count: number;
  firstAttemptAt: number;
}

const attempts = new Map<string, AttemptEntry>();

function isExpired(entry: AttemptEntry): boolean {
  return Date.now() - entry.firstAttemptAt > WINDOW_MS;
}

export function isRateLimited(key: string): boolean {
  const entry = attempts.get(key);
  if (!entry) return false;

  if (isExpired(entry)) {
    attempts.delete(key);
    return false;
  }

  return entry.count >= MAX_ATTEMPTS;
}

export function recordFailedAttempt(key: string): void {
  const entry = attempts.get(key);

  if (!entry || isExpired(entry)) {
    attempts.set(key, { count: 1, firstAttemptAt: Date.now() });
    return;
  }

  entry.count += 1;
}

export function resetAttempts(key: string): void {
  attempts.delete(key);
}
