---
name: Xray traffic polling — reset:false + lastSeen tracking
description: Why the traffic poller reads Xray's Stats API with reset:false and tracks last-seen absolute counters in the DB, instead of QueryStats(reset:true).
---

## Rule
Use `QueryStats(reset:false)` and persist each key's last-seen absolute counter in the DB (`last_seen_up_bytes` / `last_seen_down_bytes`). Compute the delta as `current - lastSeen` atomically inside a single SQL UPDATE. If `current < lastSeen`, treat `current` as the full delta (Xray restarted and zeroed its counter — take whatever it has now rather than discarding it).

**Why:** `reset:true` creates two unrecoverable loss windows — Node crash between gRPC read and DB commit, and Xray restart between polls. The `reset:false` + lastSeen pattern closes both: a crashed poll just recomputes the same delta next run (lastSeen wasn't advanced), and a restart's post-restart bytes are picked up on the very next poll.

**How to apply:** any Xray Stats API consumer should default to `reset:false` with a persisted lastSeen baseline. Only use `reset:true` if you can accept losing counters on crash/restart.

## Concurrency invariant
Two call sites flush traffic (60s interval + `reloadXray()` pre-restart flush). If they race, an older gRPC snapshot can commit *after* a newer one, making `current < lastSeen` falsely true and double-crediting that stale snapshot. Fix: serialize all flush calls through a promise-chain queue so each read only starts after the prior flush's write has committed.

**Rule:** any time you add a second call site for a read-then-conditionally-write cycle, check for races — mutual exclusion (queue/mutex) is required, not just single-caller correctness.

## Remaining loss window (by design)
If Xray restarts unexpectedly *between polls*, traffic accumulated before the restart and not yet seen by a poll is unrecoverable (Xray zeroed it before we read). `reloadXray()` mitigates the common case (deliberate key-change restarts) by flushing before the restart. Unexpected Xray crashes still have a bounded ~60s loss window. Tracked as a separate verification task.
