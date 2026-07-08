---
name: Drizzle raw-SQL array params and one-active-subscription-per-user pattern
description: Why `= any($1::type[])` fails via drizzle's sql`` tag even though it works with a raw pg client, and how to safely resolve "current" rows for a user across a 1:many relation.
---

Passing a JS array through drizzle-orm's `sql` template tag as a bind param for `= any(${arr}::int[])` fails (throws a generic "Failed query" with no useful pg-level detail), even though the exact same query with the exact same array works fine through a raw `pg` client (`pool.query("select ... any($1::int[])", [[1,2,3]])`). Root cause not fully isolated, but reliably reproduced twice.

**Why:** drizzle's `sql` tag has its own param-serialization path that doesn't treat a plain array parameter the same way node-postgres's driver does for `= any($1::type[])`. Don't rely on that pattern.

**How to apply:** for "value in this set of ids" filters, always prefer the drizzle query builder (`inArray(column, ids)`) over hand-rolled raw `sql` with an array param. It composes fine with `selectDistinctOn`.

Related pattern: when a user *should* have only one "current" row in a 1:many table (e.g. one active subscription) but the schema doesn't enforce that, don't `innerJoin` straight from the many-side into that table for aggregation — it fans out and multiplies sums if more than one qualifying row ever exists (bad data, race condition, etc.). Instead resolve to exactly one row per user first via `db.selectDistinctOn([table.userId], {...}).orderBy(table.userId, desc(recencyColumn), desc(table.id))`, either as a CTE (`db.$with(...).as(...)` + `.with(...)`) or a separate query joined in application code, then join/merge that single-row-per-user result into the aggregation.
