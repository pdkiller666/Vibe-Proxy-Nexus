const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// Upper bound on how many distinct keys (ip:email pairs) we track at once.
// Without this, a distributed brute-force spraying many different IPs/emails
// could grow this in-memory map without bound and OOM the container.
const MAX_ENTRIES = 5_000;

// How often to sweep expired entries in the background, independent of
// whether anyone happens to re-touch that key. Keeps the map's steady-state
// size close to "recent distinct attackers/users", not "everyone who ever
// failed a login since boot".
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface AttemptEntry {
  count: number;
  firstAttemptAt: number;
}

const attempts = new Map<string, AttemptEntry>();

function isExpired(entry: AttemptEntry): boolean {
  return Date.now() - entry.firstAttemptAt > WINDOW_MS;
}

// Evicts the least-recently-inserted entry (Map preserves insertion order,
// and `set()` on an existing key does not change its position, so the first
// key is always the oldest touched one — approximates LRU well enough for a
// rate-limit map where "oldest" and "least relevant" line up closely).
function evictOldestIfOverCapacity(): void {
  while (attempts.size > MAX_ENTRIES) {
    const oldestKey = attempts.keys().next().value;
    if (oldestKey === undefined) break;
    attempts.delete(oldestKey);
  }
}

function cleanupExpired(): void {
  for (const [key, entry] of attempts) {
    if (isExpired(entry)) {
      attempts.delete(key);
    }
  }
}

const cleanupTimer = setInterval(cleanupExpired, CLEANUP_INTERVAL_MS);
// Don't let this timer keep the process alive on its own (relevant for
// scripts/tests that import this module and expect to exit cleanly).
cleanupTimer.unref?.();

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
    // Re-inserting via delete+set moves this key to the end (most-recently-
    // used position), keeping eviction order meaningful.
    attempts.delete(key);
    attempts.set(key, { count: 1, firstAttemptAt: Date.now() });
    evictOldestIfOverCapacity();
    return;
  }

  entry.count += 1;
}

export function resetAttempts(key: string): void {
  attempts.delete(key);
}
