---
name: Clerk Russian (or any non-English) localization
description: How to fully localize Clerk's built-in SignIn/SignUp components, not just a few strings.
---

Passing a hand-written `localization` object with only a couple of overridden keys
(e.g. sign-in title/subtitle) to `<ClerkProvider>` leaves the rest of the built-in
UI (buttons, labels, "Continue with Google", footer links, etc.) in English —
Clerk does not fall back to any auto-translation.

**Why:** Clerk's default components render dozens of localization keys; supplying
a partial object only overrides the keys you explicitly set, the rest use the
English default baked into `@clerk/react`.

**How to apply:** Install `@clerk/localizations` and spread the full locale dict
(e.g. `ruRU`) as the base, then merge custom overrides on top for brand-specific
copy (app name in the title, custom subtitle, etc.):

```ts
import { ruRU } from "@clerk/localizations";

const clerkLocalization = {
  ...ruRU,
  signIn: { ...ruRU.signIn, start: { ...ruRU.signIn?.start, title: "Custom title" } },
};
```

Pass this merged object as `localization` to `<ClerkProvider>`.
