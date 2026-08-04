# Downtown U Student Portal Implementation Plan

> **Execution rule:** Deliver one phase at a time with strict RED/GREEN/REFACTOR TDD. Do not expose a database-dependent route until its migration, secrets, rollback, and production smoke tests pass.

**Goal:** Turn the existing `/downtown-u` Square payment-link enrollment page into an auditable student meal-credit portal: Square payment link → verified Square webhook → student account and immutable credit ledger → OTP login → server-priced meal selection → atomic credit redemption → Square kitchen order → operator dashboard.

**Architecture:** Keep Vite/React as the browser application and Vercel functions under `api/` as the trust boundary. Server-only modules in `server/downtown-u/` own identity normalization, canonical plan/menu economics, authorization, Square verification, and ledger operations. Managed PostgreSQL is authoritative; browser state/localStorage is never authoritative. Square event IDs, payment/order IDs, request idempotency keys, row locks, unique constraints, and transactions make retries safe. Every balance change is a compensating append-only ledger entry; operational purchase/redemption status rows may change while their history cannot.

**Technology:** React 18, Vite 5, TypeScript, Vercel Node functions, `pg`/managed PostgreSQL, Vitest, existing Square REST integration, an approved transactional email/SMS OTP provider (selection is a Phase 3 gate).

---

## Invariants and threat model (all phases)

- Only four server-defined plans exist: `flex-5` = 5 credits/$60, `scholar-10` = 10/$110, `resident-20` = 20/$210, and `semester-40` = 40/$400. Never accept plan price or credit value from a client or unverified webhook field.
- Verify Square webhook signatures against the exact public notification URL and raw request bytes before parsing. Fetch payment/order details from Square and require expected location, completed status, currency, amount, catalog/payment-link association, and matching customer metadata before granting.
- Normalize and validate contact details server-side. Store normalized email/phone, Square customer ID, and eligibility evidence/status only; do not store full student-ID images/documents. Restrict logs to opaque IDs and redact contact data, OTPs, signatures, tokens, and database URLs.
- PostgreSQL is authoritative. Ledger rows are append-only; Phase 1 permits balance changes only for verified purchase grants, refunds, reservations, and redemption reversals. Corrections and failed-order releases use signed compensating entries with reason, actor, source, idempotency key, and resulting balance. Future operator adjustments require the separate privileged Phase 6 path and audit controls.
- Lock the student row (`SELECT … FOR UPDATE`) inside every balance transaction. The database trigger verifies `new balance = old balance + delta`; constraints prohibit negative balances. Unique source keys prevent replay/double spend. Never hold a database transaction open during a Square network call.
- Authentication cookies are `HttpOnly`, `Secure`, `SameSite=Lax`, path-scoped, rotated, short-lived, and backed by hashed server-side sessions. OTPs are hashed, one-use, expiring, attempt-limited, rate-limited by normalized destination plus IP, and responses resist account enumeration.
- All mutations enforce method, content type, payload size/schema, authenticated principal, eligibility state, CSRF/origin policy, and per-principal rate limits. Student endpoints can read/mutate only their own rows; operator endpoints require a separately provisioned role and reauthentication.
- Keep database and Square credentials server-only (never `VITE_`). Use least-privilege environment separation and database roles; production changes require backup/PITR, migration rehearsal, and a rollback/runbook.

## Phase 1 — Student accounts and immutable meal-credit ledger (implement now)

**Files**
- Create `db/migrations/202608040001_downtown_u_phase1.sql`.
- Create `server/downtown-u/plans.ts`, `identity.ts`, `student-accounts.ts`, `credits.ts`, `postgres-student-account-store.ts`, `postgres-credit-store.ts`.
- Create deterministic test transport `server/downtown-u/testing/in-memory-credit-store.ts`.
- Create tests in `server/downtown-u/__tests__/plans-and-identity.test.ts`, `ledger.test.ts`, and `migration.test.ts`.
- Create `.env.example`; update `package.json`/`package-lock.json` only for minimal `pg` and types.

**TDD steps**
1. RED: write plan mapping/unknown-plan and contact normalization tests; run `npm test -- server/downtown-u/__tests__` and retain the expected missing-module/migration failure.
2. GREEN: implement immutable canonical plan data and pure normalization; rerun focused tests.
3. RED: specify duplicate grant/webhook handling, conflicting idempotency, insufficient balance, concurrent reservations, duplicate reservation, redeem/reverse, partial/full refund, and immutable prior rows using the deterministic store.
4. GREEN: implement `DowntownUCredits` against a transport interface and a serialized in-memory transport. Inputs may contain an internal credit quantity for future server-resolved meals/refunds, but browser handlers must never pass client-selected economics directly.
5. RED/GREEN: specify migration entities, UUID defaults, canonical economics, unique Square/source/idempotency identifiers, non-negative chain, and append-only triggers; write the SQL.
6. Implement `PostgresCreditStore`: one transaction per operation; lock student/purchase/redemption rows; insert ledger before commit; safely return matching duplicates and reject mismatched reuse. A reservation debits available credits once, redemption changes operational status without a second debit, reversal credits once, and a refund is a negative compensating row. If already-spent credits make a refund revocation impossible, reject automatic mutation and queue Phase 2 operator reconciliation rather than create a negative balance.
7. REFACTOR and run focused tests, ESLint on changed TypeScript, `tsc --noEmit` for app and server, production build, full regression tests, and `git diff --check`.

**Deployment gate**
- Attach a production-capable managed PostgreSQL database with encrypted transit, backups/PITR, connection limits/pooling suitable for Vercel, and separate preview/production credentials. Apply and validate migration in preview first; inspect constraints/triggers and execute concurrent transaction smoke tests against real PostgreSQL. Then apply production migration before deploying any consumer. No Phase 1 public endpoint is added, so existing enrollment remains unchanged if this gate is unavailable.

**Database deployment runbook**
1. Provision a non-runtime migration owner and place its server-only credential in `MIGRATION_DATABASE_URL` for the migration job only. Provision a separate application login without ownership or direct grants; do not put owner credentials in `DATABASE_URL`.
2. Run `202608040001_downtown_u_phase1.sql` with `MIGRATION_DATABASE_URL`. The job must fail if it cannot create/validate the global `downtown_u_runtime` NOLOGIN group role; never catch that failure and retry using `DATABASE_URL` or silently give the application owner credentials.
3. As an administrator, grant membership with `GRANT downtown_u_runtime TO <application_login>`. Set `DATABASE_URL` to that login, remove `MIGRATION_DATABASE_URL` from the web runtime, and keep both values out of logs and browser-prefixed variables.
4. Verify under `SET ROLE downtown_u_runtime`: normal repository student/purchase/redemption/ledger operations succeed; schema DDL, trigger disabling, eligibility changes, authorization-table reads, ledger mutation/truncation, and direct trigger-function execution/attachment fail. Confirm the application login owns no Downtown U object and has no inherited broader role.
5. Rehearse and apply with PostgreSQL 16 in preview before production. If managed PostgreSQL forbids role creation, stop and arrange the equivalent administrator-created NOLOGIN group plus explicit grants; do not weaken the migration or fall back to the owner at runtime.

**Verification**
- Duplicate Square purchase delivery produces one purchase and one grant; mismatched duplicate rejects.
- Parallel debit attempts cannot spend below zero; retry is stable.
- Refund/reversal appends history and cannot mutate/delete old history.
- Database role cannot update/delete ledger rows; direct invalid plan, duplicate source, broken balance chain, and negative balance inserts fail.

## Phase 2 — Verified Square enrollment webhook and eligibility workflow

**Files**
- Create `api/downtown-u/square-webhook.ts`, `server/downtown-u/square-webhook.ts`, `square-client.ts`, `enrollment-service.ts`, and `api/downtown-u/__tests__/square-webhook.test.ts`.
- Create `db/migrations/202608040002_downtown_u_webhook_events.sql` for raw-body hash, event ID/type, processing status/attempts, timestamps, and redacted failure detail (not full sensitive payloads).
- Update `vercel.json` only if an explicit function route/body configuration is required; document `SQUARE_WEBHOOK_SIGNATURE_KEY`, notification URL, API version, and location ID as server-only env names.

**TDD steps**
1. RED signature tests using Square fixture vectors: missing/invalid signature, wrong URL, altered body, unsupported event, and malformed/oversized input all fail before side effects.
2. GREEN raw-body adapter and constant-time Square signature verification. Do not use parsed/re-serialized JSON for verification.
3. RED event tests: duplicate/concurrent event, completed payment, wrong amount/currency/location/status, unknown plan, reused payment/order, and customer contact merge conflict.
4. GREEN persist event claim, fetch authoritative Square payment/order, map only trusted catalog/link configuration to `getCanonicalPlan`, upsert normalized student/Square linkage, create paid purchase, and grant once in one local transaction. Return 2xx for safely processed duplicates; retry transient failures.
5. RED/GREEN refund and partial-refund events: derive credits to revoke from trusted purchase/refund policy, append compensation, update purchase state, and record a reconciliation case when spent credits prevent automatic revocation. Eligibility begins `pending`; webhook payment does not self-approve.

**Webhook boundary configuration:** Keep `SQUARE_WEBHOOK_SIGNATURE_KEY`, `DOWNTOWN_U_SQUARE_WEBHOOK_URL`, `SQUARE_API_VERSION`, and `SQUARE_LOCATION_ID` server-only. The notification URL must exactly match the public URL registered with Square. Disable request-body parsing for this route: the Node adapter reads the stream once and rejects pre-parsed bodies. Raw webhook requests are limited to 256 KiB.

**Security/deployment gate:** Configure webhook secret in preview, register exact preview callback, replay signed sandbox fixtures, verify no PII/secrets in logs, and alert on processing failures. Production requires exact production URL/signature key and Square dashboard confirmation. Never test by making a live charge.

**Verification:** Signed sandbox webhook creates one pending student/purchase/grant; ten replays remain one. Invalid signatures and economics create nothing. Refunds are auditable and non-negative. Existing payment links continue to render.

## Phase 3 — OTP authentication and student account/eligibility experience

**Files**
- Create migrations `202608040003_downtown_u_auth.sql` (hashed challenges/sessions, expirations, attempts, revocation) and `202608040004_downtown_u_eligibility.sql` (minimal review notes/evidence reference and audit events).
- Create `api/downtown-u/auth/request-otp.ts`, `verify-otp.ts`, `logout.ts`, `me.ts`; `server/downtown-u/auth/*`, `rate-limit.ts`, and provider adapter.
- Create `src/pages/DowntownULogin.tsx`, `DowntownUStudent.tsx`, protected route/components/hooks, and focused API/UI tests.

**TDD steps:** RED/GREEN normalized destination lookup, enumeration-safe responses, hashed OTP, expiry, one use, attempt/rate limits, session rotation/revocation, cookie attributes, and suspended/rejected access. Add an operator-reviewed transition state machine (`pending → approved/rejected`, `approved → suspended`) with timestamp/audit tests; never upload/store full student-ID documents. UI tests cover keyboard/error/loading/session-expiry states.

**Security/deployment gate:** Select an approved email/SMS provider and sender, configure secrets and callback domains, complete privacy/retention review, run abuse/rate-limit tests, and provision a shared rate-limit store if serverless instances cannot enforce limits consistently. Do not enable login until delivery and revocation smoke tests pass.

**Verification:** OTP cannot be replayed or brute-forced, cookies are secure, cross-account reads fail, and only approved students can enter meal ordering. Pending/rejected/suspended users see the correct non-sensitive state.

## Phase 4 — Server-authoritative meal selection and atomic reservation

**Files**
- Create migration `202608040005_downtown_u_meals.sql` for eligible menu snapshots/rules, reservation expiry, and optional outbox jobs.
- Create `api/downtown-u/meals.ts`, `reservations.ts`, `reservations/[id]/cancel.ts`; `server/downtown-u/meals.ts`, `reservation-service.ts`.
- Create `src/pages/DowntownUMeals.tsx` and components/tests; extend `vercel.json` only for required routes.

**TDD steps:** RED/GREEN server-side allowlist from trusted Square catalog IDs, meal-to-credit rules, availability windows, modifiers, eligibility/session checks, and rejection of client price/credit/catalog substitutions. In one transaction lock student, validate trusted menu snapshot, create idempotent reservation, and append debit. Parallel requests and repeated keys must yield at most one reservation and never negative balance. Add expiry/cancel job that locks the reservation and appends exactly one reversal.

**Security/deployment gate:** Product/operator sign-off on meal entitlement rules and catalog mappings; preview load/race tests against real PostgreSQL; authenticated CSRF/origin and rate-limit tests. Feature flag remains off until menu and reversal jobs are observable.

**Verification:** Tampered payloads fail; two concurrent last-credit requests produce one success; retries return the same reservation; expiry/cancel restores credits once.

## Phase 5 — Square kitchen order creation and redemption finalization

**Files**
- Create migration `202608040006_downtown_u_order_outbox.sql` for outbox attempts, Square idempotency key, response IDs, dead-letter/reconciliation state.
- Create `api/downtown-u/reservations/[id]/submit.ts`, `api/downtown-u/jobs/orders.ts`; `server/downtown-u/kitchen-order-service.ts`, `order-outbox.ts`, and Square adapter tests.
- Add confirmation/status UI and tests.

**TDD steps:** RED/GREEN submit authorization and reservation ownership; commit reservation + durable outbox locally before network I/O. Worker claims jobs with `FOR UPDATE SKIP LOCKED`, builds Square line items from trusted server snapshots, and uses a stable Square idempotency key. Success stores unique Square order ID and marks redemption `redeemed` without a second debit. Permanent creation failure appends one reversal and marks reconciliation; unknown/timeouts query Square by idempotency/order reference before retrying, never blindly refunding and recreating.

**Security/deployment gate:** Sandbox order tests at the correct location, kitchen ticket review, timeout/retry/dead-letter alerts, least-privilege Square token, and tested emergency feature flag. Production smoke test must use an authorized non-charge sandbox/test path where available; no live charge without explicit approval.

**Verification:** Retried worker creates one kitchen order, success never double-debits, failure restores once, and an operator can correlate reservation, ledger, outbox, and Square IDs.

## Phase 6 — Operator dashboard, reconciliation, hardening, and rollout

**Files**
- Create migration `202608040007_downtown_u_operator_audit.sql` for roles, reconciliation cases, and append-only operator audit.
- Create `api/downtown-u/operator/{students,purchases,redemptions,reconciliation,adjustments}.ts`, `server/downtown-u/operator/*`.
- Create `src/pages/DowntownUOperator.tsx`, dashboard components/tests, monitoring/runbook docs, retention/export procedures.

**TDD steps:** RED/GREEN deny-by-default operator RBAC, reauthentication, scoped search/pagination, redacted responses, eligibility transitions, reconciliation resolution, and compensating manual adjustments requiring reason plus actor. Add CSV/formula-injection tests for exports, immutable audit tests, session/rate-limit tests, and end-to-end scenarios from payment through refund. Load-test webhook bursts and concurrent meal redemption; test backup restore and migration rollback/forward recovery.

**Security/deployment gate:** Named operator accounts (no shared password), MFA/SSO where available, least privilege, security/privacy review, accessibility review, backup restore evidence, alerts/SLOs, incident and reconciliation runbooks, and stakeholder acceptance in preview. Roll out behind flags to staff/pilot cohort, monitor, then expand; preserve enrollment fallback and kill switches.

**Verification:** Operators can resolve pending eligibility and reconciliation without editing ledger history; every action identifies actor/reason. Metrics reconcile `SUM(ledger.delta)` with student balances and Square purchases/refunds, no negative balances exist, expired jobs are drained, and disaster recovery objectives are met.

---

## Release checklist for every phase

1. Start from clean `main`; fetch origin and confirm no unrelated changes. Commit only focused files.
2. Capture the failing focused test (RED), smallest implementation (GREEN), then refactor with tests green.
3. Run focused tests, changed-file ESLint, strict server TypeScript no-emit, app TypeScript no-emit, production build, full relevant regression suite, and `git diff --check`.
4. Review migrations for transactional safety, locks, indexes, constraints, forward compatibility, backups, and rollback/repair procedure. Rehearse against the same PostgreSQL major version as production.
5. Verify preview env names and integration configuration without printing values. Exercise negative security and concurrency cases; inspect redacted logs/metrics.
6. Before push, fetch origin. If `origin/main` moved, rebase focused commits and rerun all gates. Push `main` only when clean; deploy only after prerequisites and phase-specific gates pass.
