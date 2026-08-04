# Downtown U database identities

`DATABASE_URL` is the web runtime credential. It **must** authenticate directly
as a dedicated, low-privilege PostgreSQL `LOGIN` that is a member only of the
`NOLOGIN` role `downtown_u_runtime`. Do not use a database owner, administrator,
general application credential, or a connection-string `options=-c role=...`
workaround. The webhook fails closed before claiming an event if this identity
contract is not met.

`MIGRATION_DATABASE_URL` is a separate owner/migration credential. It is used
only by an offline migration job, must not be configured in or accessible to the
web runtime, and must never be substituted for `DATABASE_URL`.

Webhook processing leases use the database clock. An abandoned `processing`
claim remains in progress for five minutes; a later Square retry atomically
takes over the stale lease with an incremented attempt count and a new token.
Until the payment processor is implemented, the default API immediately marks
every acquired claim `failed` with the generic `processor_unavailable` code and
returns 503 so Square retains responsibility for retrying it.