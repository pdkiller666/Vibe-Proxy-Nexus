---
name: Multiple "active" rows + null-first DESC ordering
description: Two related pitfalls in status-transition tables (e.g. subscriptions) — forgetting to retire prior "active" rows, and using desc(nullableCol) to find "the current one".
---

## Rule 1: Retiring prior active rows
Any code path that sets a row's status to "active" (or any other exclusive state) for an entity must, in the same transaction, also transition any other rows for that entity out of that state. If there are multiple write paths that can create an "active" row (e.g. admin manual grant AND payment confirmation), each one independently needs this guard — fixing it in one path is not enough.

**Why:** A payment-confirmation endpoint activated a new subscription without expiring the previous one, so two subscriptions could be "active" simultaneously for the same user. Different read queries (dashboard "/me" vs admin panel) picked between the duplicates differently, so one screen showed the old plan and the other showed the new one — a very confusing bug to diagnose because both screens were "individually correct" against the data they read.

**How to apply:** When adding or reviewing any state-transition write (subscriptions, sessions, leases, "current version" flags, etc.), grep for every write site that sets the target status, not just the one you're touching. Add a same-transaction "retire siblings" step at each one.

## Rule 2: Never ORDER BY desc(nullableColumn) to pick "the current" row
Postgres sorts NULLs FIRST in DESC order by default (and LAST in ASC). If you pick "the most current" row via `ORDER BY desc(someNullableColumn) LIMIT 1`, a row with NULL in that column will always win, regardless of how recent other rows are.

**Why:** An indefinite/hourly plan has `endsAt = NULL` by design (no expiry). Ordering "current subscription" by `desc(endsAt)` meant the null-endsAt hourly plan always outranked a newer, dated plan the user had just switched to.

**How to apply:** Order by a column that is always set (e.g. `startsAt`, `createdAt`, or the row `id`) as the primary sort key, with `id` as a tiebreaker. Only use a nullable column as a *secondary* filter (e.g. `WHERE endsAt IS NULL OR endsAt > now()`), never as the primary ordering key for "give me the latest one".
