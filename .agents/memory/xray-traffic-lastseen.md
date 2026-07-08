---
name: Xray traffic polling — reset:false + lastSeen tracking
description: Why the traffic poller reads Xray's Stats API with reset:false and tracks last-seen absolute counters in the DB, instead of QueryStats(reset:true).
---

## The problem
`QueryStats(reset: true)` atomically reads and zeroes Xray's in-memory
per-client traffic counters. Two data-loss windows follow from that:
1. If the Node process crashes between the gRPC response and the DB commit,
   that poll's traffic is gone forever — Xray already zeroed its copy.
2. If Xray itself restarts (e.g. `supervisorctl restart xray` after a key
   add/remove), any traffic accumulated since the *last* poll is wiped by
   the restart before the next poll ever sees it.

## The fix
Switch to `reset: false` — Xray keeps accumulating absolute lifetime
counters and this code never resets them. The poller persists each key's
last-seen absolute value in `vpn_keys.last_seen_up_bytes` /
`last_seen_down_bytes`, and computes this cycle's delta as
`current - lastSeen` inside a single atomic UPDATE (via SQL CASE), so
there's no read-then-write race.

If `current < lastSeen`, that means Xray's own counter reset to 0 behind
our backs (a restart) — treat the whole `current` value as the delta
instead of subtracting, since nothing else could have read it. This
closes both loss windows: a crashed poll just recomputes the same delta
next time (lastSeen wasn't advanced), and a restart's traffic is picked up
by the very next poll rather than discarded.

**Why:** original design (`reset:true`) was explicitly flagged as an
accepted ~1-minute risk window in code comments; the task required fully
closing it.

**How to apply:** any Xray Stats API consumer should default to
`reset:false` with a persisted lastSeen baseline. Only use `reset:true` if
you can tolerate losing counters on crash/restart, or you have a durable
outbox/WAL a step before the reset call.

Also: `xray.ts`'s `reloadXray()` (called on every key add/remove) now
flushes pending deltas via `trafficPolling.ts:flushTrafficDeltas()` right
before `supervisorctl restart xray`, closing the most common trigger of
mid-cycle Xray restarts proactively rather than relying solely on the next
scheduled poll's restart-detection.

## Concurrency pitfall (caught in review)
The `current < lastSeen` restart check is only sound if each flush's read
and write happen as one atomic unit relative to other flushes. Two
triggers call the same flush function (the 60s interval timer AND
reloadXray's pre-restart flush) — if they ever raced, an older/smaller gRPC
snapshot could commit its write *after* a newer/larger snapshot had already
advanced `lastSeen`, making `current < lastSeen` true for a bookkeeping
reason unrelated to any real restart, and double-crediting that stale
snapshot's full value. Fixed by serializing all flush calls through a
promise-chain queue (same `.then(fn, fn)` chaining pattern as `withLock` in
xray.ts) so a read can only ever start after the prior flush's write has
committed. **Any time you add a second call site for a
read-then-conditionally-write cycle like this, check whether the two call
sites can race — mutual exclusion (a queue/mutex), not just correctness of
the single-caller logic, is what makes it safe.**
