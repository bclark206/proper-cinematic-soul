#!/usr/bin/env bash
set -euo pipefail

# Owner-controlled checkout PII retention. Configure a libpq service backed by
# ~/.pg_service.conf + ~/.pgpass; never put database credentials in this script,
# command-line arguments, logs, or application/runtime environment variables.
service="${DOWNTOWN_U_MIGRATION_PGSERVICE:-}"
batch="${DOWNTOWN_U_CHECKOUT_RETENTION_BATCH:-500}"

if [[ ! "$service" =~ ^[A-Za-z0-9_.-]{1,64}$ ]]; then
  printf '%s\n' 'DOWNTOWN_U_MIGRATION_PGSERVICE must name a configured owner-only libpq service.' >&2
  exit 64
fi
if [[ ! "$batch" =~ ^[0-9]+$ ]] || (( batch < 1 || batch > 500 )); then
  printf '%s\n' 'DOWNTOWN_U_CHECKOUT_RETENTION_BATCH must be an integer from 1 through 500.' >&2
  exit 64
fi

# One bounded transaction per invocation. Schedule this command at least weekly;
# repeat invocations drain a backlog without an unbounded lock or statement.
psql "service=${service}" \
  --no-psqlrc --set=ON_ERROR_STOP=1 --set=batch_size="$batch" \
  --command='BEGIN; SELECT public.downtown_u_checkout_anonymize(:batch_size::integer) AS anonymized_attempts; COMMIT;'
