---
name: Slot/entitlement lifecycle tied to subscription row
description: Where to put per-cycle purchased add-ons (e.g. extra device slots) so they expire correctly on renewal/switch
---

Purchased add-ons that are meant to last only for the current billing
cycle/subscription (e.g. "extra device slot") should be stored as a column on
the **subscription** row, not on the user row.

**Why:** a column on `users` is permanent and has no natural expiry — when a
subscription ends, renews, or the user switches plans, there's nothing that
resets it, so the entitlement silently carries over forever unless someone
remembers to write extra cleanup logic. A column on the active `subscription`
row disappears automatically when that row's lifecycle ends (expires,
switched, cancelled), matching the intended "per subscription period" scope
with no extra bookkeeping.

**How to apply:** when adding a purchasable/grantable entitlement scoped to
"while the user has an active subscription" or "for this billing period",
default to putting the counter/flag on the subscription table. Every read
path (API responses, slot-usage math) and every write path (purchase confirm,
admin override) must resolve the *current active* subscription row first,
then read/write the field there — never fall back to a per-user total.
