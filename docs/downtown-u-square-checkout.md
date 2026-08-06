# Downtown U embedded Square checkout runbook

## Deployment gate

Checkout is disabled unless `DOWNTOWN_U_CHECKOUT_ENABLED=1` **exactly** and every server setting validates. Keep it `0` during migration and no-live verification. Apply `202608040007_downtown_u_checkout.sql` with the migration-owner credential before enabling the runtime.

Required server-only values:

- `DOWNTOWN_U_SQUARE_APPLICATION_ID` (public identifier, exposed only by the gated config endpoint)
- `SQUARE_LOCATION_ID=LPPWSSV03BHK8`
- `SQUARE_ACCESS_TOKEN`, pinned `SQUARE_API_VERSION=2026-01-22`
- all four `DOWNTOWN_U_SQUARE_*_VARIATION_ID` values
- `DATABASE_URL`, `DOWNTOWN_U_AUTH_SECRET`, `DOWNTOWN_U_PUBLIC_APP_ORIGIN`

Never create a `VITE_*` access token, catalog ID, or Square application setting. The browser receives only application ID and location ID. It sends a one-use Web Payments source token; it never sends amount, currency, credits, location, catalog ID, or order economics.

## Square and HTTPS

1. Add the exact `DOWNTOWN_U_PUBLIC_APP_ORIGIN` domain in the Square application Web Payments settings.
2. Serve checkout over HTTPS. The component fails closed outside a secure context.
3. Permit the production Web Payments SDK exactly as deployed: `script-src https://web.squarecdn.com`, `frame-src https://web.squarecdn.com`, and `connect-src https://web.squarecdn.com https://pci-connect.squareup.com`. These are the only Square browser origins used here; sandbox and hosted-checkout redirect origins are intentionally absent. Keep `frame-ancestors 'none'`, `base-uri 'self'` (or `'none'` on isolated documents), `object-src 'none'`, HTTPS-only transport, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`.
4. Confirm the four variation IDs belong to location `LPPWSSV03BHK8`, quantity one, and the canonical prices in `server/downtown-u/plans.ts`.
5. Preserve the signed `payment.updated` webhook. It remains the only enrollment/credit-grant authority.

## No-live verification

Use mocked HTTP responses and a disposable stock PostgreSQL 16 database. Do **not** paste a real card/source token, use a production access token, or call Square production. Verify:

- config endpoint returns only `applicationId` and `locationId` when gated on;
- order/payment request-body snapshots contain one canonical variation and trusted USD amount;
- read-back drift never yields `paid`;
- timeout retries retain the same browser idempotency key and provider idempotency keys;
- checkout/purchase race links to `activated` without granting credits from the POST;
- runtime has function capability but no direct checkout-table privilege.

`operator_review` means the provider outcome is ambiguous or failed strict verification. Do not tell the buyer to pay again. Reconcile with the persisted order/payment IDs, `du:<attempt UUID>` reference, and stable Square idempotency keys. Only a read-back `COMPLETED` payment with exact order economics/contact may advance to paid. If no provider ID can be recovered through Square's idempotent create retry, retain the case for an operator; never issue a fresh key.

## Checkout PII retention

Migration `007` provides `downtown_u_checkout_anonymize(limit)`, an owner-only, batch-bounded capability. It preserves attempt IDs, idempotency material, provider IDs, purchase linkage, state, and timestamps while clearing normalized email and request-actor HMACs after 90 days. Abandoned `started`, `order_created`, `payment_created`, and `paid` rows are first quarantined as `operator_review`, so old browser recovery records cannot silently resume after contact data is removed. Web and job runtimes cannot execute this capability.

Install `scripts/downtown-u-checkout-retention.sh` in an owner-controlled scheduler before enabling checkout. Use a libpq service and `.pgpass`; never place the migration-owner URL/password on a command line or in the web/job runtime. The required weekly schedule is equivalent to:

```cron
17 3 * * 0 cd /absolute/path/to/proper-cinematic-soul && DOWNTOWN_U_MIGRATION_PGSERVICE=downtown_u_migration DOWNTOWN_U_CHECKOUT_RETENTION_BATCH=500 ./scripts/downtown-u-checkout-retention.sh
```

Run additional bounded invocations when a backlog exists, stopping when `anonymized_attempts` is zero. Alert on a nonzero script exit and on records older than 97 days whose `redacted_at` remains null. Checkout must remain disabled if this owner-controlled schedule is not installed and tested.

## Migration roadmap numbering

- `202608040007`: embedded checkout attempts, capabilities, rate limits, purchase-link trigger (this step)
- `202608040008`: kitchen order workflow (reserved)
- `202608040009`: operator audit workflow (reserved)
