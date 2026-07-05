---
name: Session/token expiry boundary semantics
description: How to reason about "expiresAt equals now" test cases for cleanup jobs that use lt(expiresAt, new Date())
---

When testing a cleanup query built as `lt(expiresAt, new Date())` (strictly less-than, evaluated at query time), a row seeded with `expiresAt = new Date()` at seed time will be **deleted**, not kept.

**Why:** some non-zero time always elapses between seeding the row and the query executing, so the seeded "now" timestamp is already in the past by the time `new Date()` is evaluated inside the query. There is no way to seed a row that is exactly equal to the query's `new Date()` down to the same tick.

**How to apply:** when writing a boundary test for "expiresAt == now", assert the row gets deleted (treated as expired), and document why inline so a future reader doesn't "fix" it back to expecting the row to survive.
