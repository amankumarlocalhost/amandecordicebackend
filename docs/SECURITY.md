# Security & production-readiness checklist

✅ implemented and covered by automated tests · ☑️ implemented, not directly tested · ⬜ operator action required

## Identity & sessions
- ✅ Argon2id password hashing (19 MiB, t=2) on the thread pool. Legacy bcrypt hashes are verified and upgraded on login.
- ✅ Account lockout: 5 failures → 15 min. Unknown accounts get timing-equalised responses and a generic error.
- ✅ 15-minute JWT access tokens. On each request the session is checked against the database (cached 60 s, invalidated on revoke), so logout, password change and role change take effect immediately.
- ✅ Rotating opaque refresh tokens, stored only as HMAC hashes. **Reuse detection** revokes the session and raises a security alert.
- ✅ OTPs and email links: stored hashed, 10-minute expiry (email 24 h, reset 30 min), 5 attempts, 60 s resend cooldown, 5 per hour, single use.
- ✅ HttpOnly, Secure, SameSite cookies. The refresh cookie is path-scoped to `/api/v1/auth`.
- ✅ Signed double-submit CSRF tokens on cookie-authenticated unsafe requests. Exempt: webhooks (signature-authenticated) and cookie-less Bearer/`X-Client-Type` clients, which a cross-site page cannot send without a CORS preflight.
- ✅ Customers can never become staff. Staff accounts are created only by a `staff:manage` holder, and sessions are revoked on role change.
- ✅ RBAC with 7 staff roles and 35 permissions. Every admin route and admin-AI tool names its permission. Cost prices are hidden without `catalog:cost`. Refund approval limits are role-based.

## Input, output, data
- ✅ Every route validates params, query and body with Zod. Unknown types are rejected, `$` and `.` keys are stripped (NoSQL injection), and pagination is bounded.
- ✅ JSON bodies are capped at 200 kB. Uploads: 5–10 files, 8–15 MB each, re-encoded by Sharp (magic bytes checked, EXIF/GPS stripped, pixel limit). Ownership is checked whenever an upload is referenced.
- ✅ User-generated text is stored as plain text (tags and control characters stripped). ⬜ The frontend must still escape output.
- ✅ Public APIs never return cost price, supplier details, other customers' data, or unverified safety claims. Reviews show "First L." names only.
- ✅ Customers are scoped to their own orders, returns, conversations, proposals and uploads (returning 404, not 403, to avoid leaking existence).
- ✅ Production errors hide stack traces and internals. Pino redacts cookies, authorization headers, passwords, OTPs, tokens and signatures. Audit metadata is redacted.
- ✅ Full bank account numbers are never stored (last 4 digits only, for COD refunds).

## Payments
- ✅ Only UPI and COD are accepted (enforced by schema). The Razorpay Checkout config is UPI-only, and any **non-UPI capture is refunded**.
- ✅ Checkout signatures are verified with HMAC and compared in constant time. The payment is then fetched from Razorpay and its amount and currency checked. The frontend can never mark an order paid.
- ✅ Webhooks: HMAC over the raw body, deduplicated by event id, and the payment is claimed atomically, so duplicate and delayed events are harmless.
- ✅ Idempotent checkout. Refund capacity is enforced atomically. Provider refund retries never double-refund.
- ⬜ Use live keys only in production. Keep test keys in staging. Never put live keys in CI.

## AI
- ✅ Gemini is the only provider and the key is server-side only. Tool calling is allow-listed with strict schemas, identity comes from the session, outputs are minimised, and there is no database or shell access.
- ✅ Consequential actions require human confirmation, are re-validated and executed once, and are audited. The admin AI cannot exceed the confirming admin's permissions.
- ✅ Prompt-injection posture: tool data is labelled untrusted, the system rules are fixed, and enforcement happens in code rather than the prompt.
- ✅ Per-user daily quotas, a global concurrency limit, timeouts and a kill switch. No message text is stored in usage logs.

## Platform
- ✅ Helmet security headers, a CORS allow-list, and an Origin check on WebSockets.
- ✅ Distributed rate limits (Redis) for the API, auth, OTP, checkout, AI, uploads and reviews. Socket token buckets and frame and message size limits.
- ✅ The app refuses to start in production with unsafe configuration (default secrets, no Redis, insecure cookies, dev OTP exposure).
- ✅ `npm audit --omit=dev` showed **0 vulnerabilities** at the time of writing. ⬜ Enable Dependabot/Renovate and re-run the audit in CI.
- ✅ Audit log for staff actions, financial events, AI actions and security events.
- ⬜ TLS everywhere, private networking for MongoDB and Redis, least-privilege database users, a WAF/CDN, and backups with restore drills (see DEPLOYMENT.md).
- ⬜ A third-party penetration test before launch. Review the Razorpay webhook IP allow-list option.
- ⬜ A privacy policy and DPDP Act 2023 compliance review (consent, retention, grievance officer).
