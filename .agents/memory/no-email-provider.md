---
name: No email provider configured
description: This project has no outbound email-sending integration; flows that would normally email a link must fall back to in-app display.
---

As of the password-reset feature, this project has no mailer/SDK (no Resend, SendGrid, nodemailer, etc.) wired up anywhere in the codebase.

**Why:** Auth was migrated to custom email+password with DB-backed sessions (see session-auth-migration.md), and no email integration was added alongside it.

**How to apply:** Any future flow that would normally send an email (password reset, email verification, invites) should either connect a real email integration first, or clearly fall back to returning/displaying the link in-app (as the forgot-password endpoint does today via `resetUrl` in its response) rather than silently failing or pretending an email was sent.
