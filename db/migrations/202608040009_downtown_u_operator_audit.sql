BEGIN;

/* This role is only a future capability principal. Migration 009 intentionally
 * gives it no schema, relation, sequence, function, or role-membership access. */
DO $role$
DECLARE existing_oid OID;
BEGIN
  CREATE ROLE downtown_u_operator_runtime NOLOGIN;
EXCEPTION WHEN duplicate_object THEN
  SELECT oid INTO existing_oid FROM pg_catalog.pg_roles
    WHERE rolname='downtown_u_operator_runtime';
  IF existing_oid IS NULL OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE oid=existing_oid AND
      (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication
       OR rolbypassrls OR rolconfig IS NOT NULL)
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members
    WHERE roleid=existing_oid OR member=existing_oid
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_shdepend
    WHERE refclassid='pg_catalog.pg_authid'::pg_catalog.regclass
      AND refobjid=existing_oid AND deptype IN ('a','o')
  ) THEN
    RAISE EXCEPTION 'Existing downtown_u_operator_runtime role is unsafe';
  END IF;
END $role$;
REVOKE ALL ON SCHEMA public FROM downtown_u_operator_runtime;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM downtown_u_operator_runtime;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM downtown_u_operator_runtime;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM downtown_u_operator_runtime;

/* Owner-controlled kill switches. No application principal can read or mutate
 * this singleton in 009, and every gate starts disabled. */
CREATE TABLE public.downtown_u_operator_config (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  read_enabled BOOLEAN NOT NULL DEFAULT false,
  mutations_enabled BOOLEAN NOT NULL DEFAULT false,
  exports_enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
INSERT INTO public.downtown_u_operator_config(singleton) VALUES(true);

/* Accounts are administratively provisioned identities, not credential stores. */
CREATE TABLE public.downtown_u_operator_accounts (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  normalized_email TEXT NOT NULL UNIQUE CHECK (
    normalized_email=pg_catalog.lower(pg_catalog.btrim(normalized_email))
    AND pg_catalog.length(normalized_email) BETWEEN 3 AND 254
    AND normalized_email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
  normalized_phone TEXT NOT NULL UNIQUE CHECK (normalized_phone ~ '^[+][1-9][0-9]{7,14}$'),
  display_name TEXT NOT NULL CHECK (
    pg_catalog.length(pg_catalog.btrim(display_name)) BETWEEN 1 AND 120
    AND display_name !~ '[[:cntrl:]]'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  provisioning_reference TEXT NOT NULL UNIQUE CHECK (
    provisioning_reference ~ '^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  disabled_at TIMESTAMPTZ,
  CHECK ((status='active' AND disabled_at IS NULL)
    OR (status='disabled' AND disabled_at IS NOT NULL))
);

/* Contact replacement requires disabling this account and provisioning another. */
CREATE FUNCTION public.downtown_u_operator_accounts_immutable_identity_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  IF NEW.normalized_email IS DISTINCT FROM OLD.normalized_email
     OR NEW.normalized_phone IS DISTINCT FROM OLD.normalized_phone
     OR NEW.provisioning_reference IS DISTINCT FROM OLD.provisioning_reference THEN
    RAISE EXCEPTION 'provisioned operator identity and contacts are immutable';
  END IF;
  RETURN NEW;
END $function$;
CREATE TRIGGER downtown_u_operator_accounts_immutable_identity_guard
  BEFORE UPDATE ON public.downtown_u_operator_accounts
  FOR EACH ROW EXECUTE FUNCTION public.downtown_u_operator_accounts_immutable_identity_guard();

/* Revocation is retained rather than deleting assignment history. Authorization
 * must query revoked_at IS NULL on every privileged request, including sessions
 * that were already fully authenticated. All writes remain owner/admin-only. */
CREATE TABLE public.downtown_u_operator_account_roles (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.downtown_u_operator_accounts(id) ON DELETE RESTRICT,
  role_code TEXT NOT NULL CHECK (role_code IN (
    'eligibility_reviewer','reconciliation_operator','credit_adjuster','audit_exporter')),
  assigned_by_operator_id UUID REFERENCES public.downtown_u_operator_accounts(id) ON DELETE RESTRICT,
  assigned_by_reference TEXT NOT NULL CHECK (
    assigned_by_reference ~ '^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$'),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  revoked_by_operator_id UUID REFERENCES public.downtown_u_operator_accounts(id) ON DELETE RESTRICT,
  revocation_reference TEXT CHECK (revocation_reference IS NULL OR
    revocation_reference ~ '^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$'),
  revoked_at TIMESTAMPTZ,
  CHECK ((revoked_at IS NULL AND revoked_by_operator_id IS NULL AND revocation_reference IS NULL)
    OR (revoked_at IS NOT NULL AND revocation_reference IS NOT NULL))
);
CREATE UNIQUE INDEX downtown_u_operator_account_roles_active_key
  ON public.downtown_u_operator_account_roles(account_id,role_code)
  WHERE revoked_at IS NULL;
CREATE INDEX downtown_u_operator_account_roles_authorization_idx
  ON public.downtown_u_operator_account_roles(account_id,role_code,revoked_at);

/* Version 1 verifiers are application-side HMAC-SHA256 under an external secret,
 * never plain unkeyed SHA-256. Explicit domains include record ID, purpose, and
 * factor: operator-flow:v1:<record ID>:sign_in:flow,
 * operator-challenge:v1:<record ID>:<purpose>:<factor>, and
 * operator-session:v1:<record ID>:session:bearer. Only opaque digests persist. */
CREATE TABLE public.downtown_u_operator_auth_flows (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES public.downtown_u_operator_accounts(id) ON DELETE RESTRICT,
  verifier_version SMALLINT NOT NULL DEFAULT 1 CHECK (verifier_version=1),
  flow_verifier BYTEA NOT NULL CHECK (pg_catalog.octet_length(flow_verifier)=32),
  status TEXT NOT NULL DEFAULT 'pending_email' CHECK (status IN ('pending_email','pending_sms','complete','consumed','expired','revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  UNIQUE (verifier_version,flow_verifier),
  UNIQUE (id,operator_id),
  UNIQUE (id,operator_id,status),
  CHECK (updated_at>=created_at AND expires_at>created_at AND expires_at<=created_at+INTERVAL '30 minutes'),
  CHECK (completed_at IS NULL OR (completed_at>=created_at AND completed_at<=updated_at)),
  CHECK (consumed_at IS NULL OR (completed_at IS NOT NULL AND consumed_at>=completed_at AND consumed_at<=updated_at)),
  CHECK (expired_at IS NULL OR expired_at>=expires_at),
  CHECK (revoked_at IS NULL OR revoked_at>=created_at),
  CHECK ((status IN ('pending_email','pending_sms') AND completed_at IS NULL AND consumed_at IS NULL AND expired_at IS NULL AND revoked_at IS NULL)
    OR (status='complete' AND completed_at IS NOT NULL AND consumed_at IS NULL AND expired_at IS NULL AND revoked_at IS NULL)
    OR (status='consumed' AND completed_at IS NOT NULL AND consumed_at IS NOT NULL AND expired_at IS NULL AND revoked_at IS NULL)
    OR (status='expired' AND consumed_at IS NULL AND expired_at IS NOT NULL AND revoked_at IS NULL)
    OR (status='revoked' AND consumed_at IS NULL AND expired_at IS NULL AND revoked_at IS NOT NULL))
);

CREATE TABLE public.downtown_u_operator_auth_challenges (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES public.downtown_u_operator_accounts(id) ON DELETE RESTRICT,
  flow_id UUID,
  session_id UUID,
  purpose TEXT NOT NULL CHECK (purpose IN ('sign_in','reauth')),
  factor TEXT NOT NULL CHECK (factor IN ('email_magic_link','sms_otp')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','consumed','expired','revoked')),
  verifier_version SMALLINT NOT NULL DEFAULT 1 CHECK (verifier_version=1),
  challenge_verifier BYTEA NOT NULL CHECK (pg_catalog.octet_length(challenge_verifier)=32),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (verifier_version,challenge_verifier),
  UNIQUE (id,operator_id),
  UNIQUE (flow_id,factor),
  FOREIGN KEY (flow_id,operator_id) REFERENCES public.downtown_u_operator_auth_flows(id,operator_id) ON DELETE RESTRICT,
  CHECK ((purpose='sign_in' AND flow_id IS NOT NULL AND session_id IS NULL)
    OR (purpose='reauth' AND factor='sms_otp' AND flow_id IS NULL AND session_id IS NOT NULL)),
  CHECK (updated_at>=created_at AND expires_at>created_at AND expires_at<=created_at+INTERVAL '15 minutes'),
  CHECK (verified_at IS NULL OR (verified_at>=created_at AND verified_at<=expires_at AND verified_at<=updated_at)),
  CHECK (consumed_at IS NULL OR (verified_at IS NOT NULL AND consumed_at>=verified_at AND consumed_at<=updated_at)),
  CHECK (expired_at IS NULL OR expired_at>=expires_at),
  CHECK (revoked_at IS NULL OR revoked_at>=created_at),
  CHECK ((status='pending' AND verified_at IS NULL AND consumed_at IS NULL AND expired_at IS NULL AND revoked_at IS NULL)
    OR (status='verified' AND verified_at IS NOT NULL AND consumed_at IS NULL AND expired_at IS NULL AND revoked_at IS NULL)
    OR (status='consumed' AND verified_at IS NOT NULL AND consumed_at IS NOT NULL AND expired_at IS NULL AND revoked_at IS NULL)
    OR (status='expired' AND consumed_at IS NULL AND expired_at IS NOT NULL AND revoked_at IS NULL)
    OR (status='revoked' AND consumed_at IS NULL AND expired_at IS NULL AND revoked_at IS NOT NULL))
);
CREATE INDEX downtown_u_operator_auth_challenges_digest_idx
  ON public.downtown_u_operator_auth_challenges(verifier_version,challenge_verifier);
CREATE INDEX downtown_u_operator_auth_challenges_expiry_idx
  ON public.downtown_u_operator_auth_challenges(status,expires_at);

/* A session is always full MFA and is minted once from one consumed flow. Both sign-in challenges
 * must be consumed (email_magic_link and sms_otp); the future SECURITY DEFINER auth capability in 3.1C must atomically prove that before flow
 * completion/consumption and issuance. Migration 009 grants no auth capability;
 * declarative topology is not weakened to fake that cross-row proof. */
CREATE TABLE public.downtown_u_operator_sessions (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES public.downtown_u_operator_accounts(id) ON DELETE RESTRICT,
  consumed_auth_flow_id UUID NOT NULL UNIQUE,
  consumed_flow_status TEXT NOT NULL DEFAULT 'consumed' CHECK (consumed_flow_status='consumed'),
  verifier_version SMALLINT NOT NULL DEFAULT 1 CHECK (verifier_version=1),
  session_verifier BYTEA NOT NULL CHECK (pg_catalog.octet_length(session_verifier)=32),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','revoked')),
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  idle_expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (verifier_version,session_verifier),
  UNIQUE (id,operator_id),
  FOREIGN KEY (consumed_auth_flow_id,operator_id,consumed_flow_status)
    REFERENCES public.downtown_u_operator_auth_flows(id,operator_id,status) ON DELETE RESTRICT,
  CHECK (created_at<=last_seen_at AND last_seen_at<=updated_at),
  CHECK (absolute_expires_at>created_at AND absolute_expires_at<=created_at+INTERVAL '8 hours'),
  CHECK (idle_expires_at>last_seen_at AND idle_expires_at<=last_seen_at+INTERVAL '30 minutes' AND idle_expires_at<=absolute_expires_at),
  CHECK ((status IN ('active','expired') AND revoked_at IS NULL)
    OR (status='revoked' AND revoked_at IS NOT NULL AND revoked_at>=created_at))
);
ALTER TABLE public.downtown_u_operator_auth_challenges
  ADD CONSTRAINT downtown_u_operator_auth_challenges_session_owner_fk
  FOREIGN KEY (session_id,operator_id) REFERENCES public.downtown_u_operator_sessions(id,operator_id) ON DELETE RESTRICT;
CREATE INDEX downtown_u_operator_sessions_digest_idx
  ON public.downtown_u_operator_sessions(verifier_version,session_verifier);
CREATE INDEX downtown_u_operator_sessions_expiry_idx
  ON public.downtown_u_operator_sessions(status,idle_expires_at,absolute_expires_at);
CREATE INDEX downtown_u_operator_sessions_operator_idx
  ON public.downtown_u_operator_sessions(operator_id,status,idle_expires_at,absolute_expires_at);
/* Reauth freshness is derived from the latest consumed row, never a writable session timestamp. */
CREATE INDEX downtown_u_operator_reauth_freshness_idx
  ON public.downtown_u_operator_auth_challenges(session_id,consumed_at DESC)
  WHERE purpose='reauth' AND factor='sms_otp' AND status='consumed';

CREATE TABLE public.downtown_u_operator_audit_events (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES public.downtown_u_operator_accounts(id) ON DELETE RESTRICT,
  session_id UUID NOT NULL REFERENCES public.downtown_u_operator_sessions(id) ON DELETE RESTRICT,
  action_code TEXT NOT NULL CHECK (action_code ~ '^[a-z][a-z0-9_]{0,47}$'),
  target_type TEXT NOT NULL CHECK (target_type ~ '^[a-z][a-z0-9_]{0,47}$'),
  target_id TEXT NOT NULL CHECK (pg_catalog.length(target_id) BETWEEN 1 AND 192 AND target_id !~ '[[:cntrl:]]'),
  reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,47}$'),
  reason TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(reason)) BETWEEN 1 AND 500 AND reason !~ '[[:cntrl:]]'),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$'),
  correlation_id TEXT NOT NULL CHECK (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (idempotency_key),
  UNIQUE (id,operator_id,session_id,correlation_id),
  FOREIGN KEY (session_id,operator_id) REFERENCES public.downtown_u_operator_sessions(id,operator_id) ON DELETE RESTRICT
);

CREATE TABLE public.downtown_u_eligibility_events (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES public.downtown_u_operator_accounts(id) ON DELETE RESTRICT,
  session_id UUID NOT NULL REFERENCES public.downtown_u_operator_sessions(id) ON DELETE RESTRICT,
  student_id UUID NOT NULL REFERENCES public.downtown_u_students(id) ON DELETE RESTRICT,
  from_status TEXT NOT NULL CHECK (from_status IN ('pending','approved','rejected','suspended')),
  to_status TEXT NOT NULL CHECK (to_status IN ('pending','approved','rejected','suspended')),
  reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,47}$'),
  reason TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(reason)) BETWEEN 1 AND 500 AND reason !~ '[[:cntrl:]]'),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$'),
  correlation_id TEXT NOT NULL CHECK (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$'),
  audit_event_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK (from_status<>to_status),
  UNIQUE (idempotency_key),
  FOREIGN KEY (session_id,operator_id) REFERENCES public.downtown_u_operator_sessions(id,operator_id) ON DELETE RESTRICT,
  FOREIGN KEY (audit_event_id,operator_id,session_id,correlation_id)
    REFERENCES public.downtown_u_operator_audit_events(id,operator_id,session_id,correlation_id) ON DELETE RESTRICT
);

/* Cases contain only opaque authority keys. There is deliberately no mutable
 * status/open/resolved column: resolution existence is the state. Backfilled
 * rows have no fictional operator; every future operator-created case must set
 * both creator references through the future capability. */
CREATE TABLE public.downtown_u_operator_reconciliation_cases (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  source_type TEXT NOT NULL CHECK (source_type IN ('refund','kitchen')),
  source_id TEXT NOT NULL CHECK (pg_catalog.length(source_id) BETWEEN 1 AND 192 AND source_id !~ '[[:space:][:cntrl:]]'),
  student_id UUID NOT NULL REFERENCES public.downtown_u_students(id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,47}$'),
  reason TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(reason)) BETWEEN 1 AND 500 AND reason !~ '[[:cntrl:]]'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$'),
  correlation_id TEXT NOT NULL CHECK (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$'),
  audit_event_id UUID,
  created_by_operator_id UUID REFERENCES public.downtown_u_operator_accounts(id) ON DELETE RESTRICT,
  created_by_session_id UUID REFERENCES public.downtown_u_operator_sessions(id) ON DELETE RESTRICT,
  origin TEXT NOT NULL CHECK (origin IN ('migration_backfill','source_sync','operator')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT downtown_u_operator_cases_source_key UNIQUE (source_type,source_id),
  FOREIGN KEY (created_by_session_id,created_by_operator_id)
    REFERENCES public.downtown_u_operator_sessions(id,operator_id) ON DELETE RESTRICT,
  FOREIGN KEY (audit_event_id,created_by_operator_id,created_by_session_id,correlation_id)
    REFERENCES public.downtown_u_operator_audit_events(id,operator_id,session_id,correlation_id) ON DELETE RESTRICT,
  CHECK ((origin IN ('migration_backfill','source_sync') AND created_by_operator_id IS NULL
      AND created_by_session_id IS NULL AND audit_event_id IS NULL)
    OR (origin='operator' AND created_by_operator_id IS NOT NULL
      AND created_by_session_id IS NOT NULL AND audit_event_id IS NOT NULL))
);

CREATE TABLE public.downtown_u_operator_reconciliation_resolutions (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  case_id UUID NOT NULL UNIQUE REFERENCES public.downtown_u_operator_reconciliation_cases(id) ON DELETE RESTRICT,
  operator_id UUID NOT NULL REFERENCES public.downtown_u_operator_accounts(id) ON DELETE RESTRICT,
  session_id UUID NOT NULL REFERENCES public.downtown_u_operator_sessions(id) ON DELETE RESTRICT,
  resolution_code TEXT NOT NULL CHECK (resolution_code ~ '^[a-z][a-z0-9_]{0,47}$'),
  reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,47}$'),
  reason TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(reason)) BETWEEN 1 AND 500 AND reason !~ '[[:cntrl:]]'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$'),
  correlation_id TEXT NOT NULL CHECK (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$'),
  audit_event_id UUID NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type ~ '^[a-z][a-z0-9_]{0,47}$'),
  target_id TEXT NOT NULL CHECK (pg_catalog.length(target_id) BETWEEN 1 AND 192 AND target_id !~ '[[:cntrl:]]'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  FOREIGN KEY (session_id,operator_id) REFERENCES public.downtown_u_operator_sessions(id,operator_id) ON DELETE RESTRICT,
  FOREIGN KEY (audit_event_id,operator_id,session_id,correlation_id)
    REFERENCES public.downtown_u_operator_audit_events(id,operator_id,session_id,correlation_id) ON DELETE RESTRICT
);

CREATE VIEW public.downtown_u_operator_reconciliation_case_state AS
SELECT c.*,
  EXISTS (SELECT 1 FROM public.downtown_u_operator_reconciliation_resolutions AS r
    WHERE r.case_id=c.id) AS resolved
FROM public.downtown_u_operator_reconciliation_cases AS c;

/* Immutable intent record. The corresponding ledger link is added below, but
 * 009 grants no mutation capability. */
CREATE TABLE public.downtown_u_operator_adjustments (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES public.downtown_u_operator_accounts(id) ON DELETE RESTRICT,
  session_id UUID NOT NULL REFERENCES public.downtown_u_operator_sessions(id) ON DELETE RESTRICT,
  student_id UUID NOT NULL REFERENCES public.downtown_u_students(id) ON DELETE RESTRICT,
  delta INTEGER NOT NULL CHECK (delta BETWEEN -40 AND 40 AND delta<>0),
  reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,47}$'),
  reason TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(reason)) BETWEEN 1 AND 500 AND reason !~ '[[:cntrl:]]'),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$'),
  correlation_id TEXT NOT NULL CHECK (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$'),
  audit_event_id UUID NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type ~ '^[a-z][a-z0-9_]{0,47}$'),
  target_id TEXT NOT NULL CHECK (pg_catalog.length(target_id) BETWEEN 1 AND 192 AND target_id !~ '[[:cntrl:]]'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (idempotency_key),
  UNIQUE (id,student_id),
  FOREIGN KEY (session_id,operator_id) REFERENCES public.downtown_u_operator_sessions(id,operator_id) ON DELETE RESTRICT,
  FOREIGN KEY (audit_event_id,operator_id,session_id,correlation_id)
    REFERENCES public.downtown_u_operator_audit_events(id,operator_id,session_id,correlation_id) ON DELETE RESTRICT
);

/* Pre-auth evidence contains no attempted identifier, contact, bearer, or JSON. */
CREATE TABLE public.downtown_u_operator_security_events (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  operator_id UUID REFERENCES public.downtown_u_operator_accounts(id) ON DELETE RESTRICT,
  flow_id UUID,
  session_id UUID,
  event_code TEXT NOT NULL CHECK (event_code IN ('issuance','success','failure','expiry','replay','revocation')),
  outcome TEXT NOT NULL CHECK (outcome IN ('observed','succeeded','failed','denied')),
  factor TEXT CHECK (factor IS NULL OR factor IN ('email_magic_link','sms_otp')),
  correlation_id TEXT NOT NULL CHECK (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK ((flow_id IS NULL AND session_id IS NULL) OR operator_id IS NOT NULL),
  FOREIGN KEY (flow_id,operator_id) REFERENCES public.downtown_u_operator_auth_flows(id,operator_id) ON DELETE RESTRICT,
  FOREIGN KEY (session_id,operator_id) REFERENCES public.downtown_u_operator_sessions(id,operator_id) ON DELETE RESTRICT
);

/* Owner/admin lifecycle evidence is bounded and carries no contact or token. */
CREATE TABLE public.downtown_u_operator_owner_events (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  target_operator_id UUID NOT NULL REFERENCES public.downtown_u_operator_accounts(id) ON DELETE RESTRICT,
  actor_operator_id UUID REFERENCES public.downtown_u_operator_accounts(id) ON DELETE RESTRICT,
  event_code TEXT NOT NULL CHECK (event_code IN ('account_disable','account_enable','role_assign','role_revoke','contact_provision','account_provision')),
  target_role_code TEXT CHECK (target_role_code IS NULL OR target_role_code IN ('eligibility_reviewer','reconciliation_operator','credit_adjuster','audit_exporter')),
  admin_reference TEXT NOT NULL CHECK (admin_reference ~ '^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$'),
  reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,47}$'),
  reason TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(reason)) BETWEEN 1 AND 500 AND reason !~ '[[:cntrl:]]'),
  correlation_id TEXT NOT NULL CHECK (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK ((event_code IN ('role_assign','role_revoke'))=(target_role_code IS NOT NULL))
);

/* Preserve every legacy sign and reference rule verbatim while admitting only
 * a ledger row that names an immutable adjustment. The future capability must
 * atomically insert adjustment + ledger and verify that delta, student,
 * actor_id/operator_id, reason, idempotency, target, and session all agree.
 * Cross-row equality for those values cannot be expressed by these existing
 * column types; no mutation privilege is granted until 3.1B supplies that gate. */
ALTER TABLE public.downtown_u_credit_transactions
  ADD COLUMN operator_adjustment_id UUID;
ALTER TABLE public.downtown_u_credit_transactions
  DROP CONSTRAINT downtown_u_credit_transactions_transaction_type_check,
  DROP CONSTRAINT downtown_u_credit_transactions_actor_type_check,
  DROP CONSTRAINT downtown_u_credit_transactions_check,
  DROP CONSTRAINT downtown_u_credit_transactions_check1,
  DROP CONSTRAINT downtown_u_credit_transactions_check2,
  ADD CONSTRAINT downtown_u_credit_transactions_transaction_type_check CHECK
    (transaction_type IN ('purchase_grant','purchase_refund','reservation','redemption_reversal','operator_adjustment')),
  ADD CONSTRAINT downtown_u_credit_transactions_actor_type_check CHECK
    (actor_type IN ('student','square_webhook','order_service','system','operator')),
  ADD CONSTRAINT downtown_u_credit_transactions_delta_direction_check CHECK
    ((transaction_type IN ('purchase_grant','redemption_reversal') AND delta>0)
      OR (transaction_type IN ('purchase_refund','reservation') AND delta<0)
      OR transaction_type='operator_adjustment'),
  ADD CONSTRAINT downtown_u_credit_transactions_purchase_topology_check CHECK
    ((transaction_type IN ('purchase_grant','purchase_refund'))=(purchase_id IS NOT NULL)),
  ADD CONSTRAINT downtown_u_credit_transactions_redemption_topology_check CHECK
    ((transaction_type IN ('reservation','redemption_reversal'))=(redemption_id IS NOT NULL)),
  ADD CONSTRAINT downtown_u_credit_transactions_adjustment_topology_check CHECK
    ((transaction_type='operator_adjustment')=(operator_adjustment_id IS NOT NULL)
      AND (transaction_type='operator_adjustment')=(actor_type='operator')
      AND (transaction_type<>'operator_adjustment' OR
        (source_type='operator_adjustment'
         AND source_id=operator_adjustment_id::TEXT))),
  ADD CONSTRAINT downtown_u_credit_transactions_operator_adjustment_key UNIQUE (operator_adjustment_id),
  ADD CONSTRAINT downtown_u_credit_transactions_operator_adjustment_fk
    FOREIGN KEY (operator_adjustment_id,student_id)
    REFERENCES public.downtown_u_operator_adjustments(id,student_id) ON DELETE RESTRICT;

/* One hardened guard is attached to every append-only operator evidence table.
 * The transaction-local setting is necessary but never sufficient: all direct
 * relation access is revoked, so only migration owner code can set-and-write. */
CREATE FUNCTION public.downtown_u_operator_append_only_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE','TRUNCATE') THEN
    RAISE EXCEPTION '% is append-only',TG_TABLE_NAME;
  END IF;
  IF pg_catalog.current_setting('downtown_u.operator_write',true) IS DISTINCT FROM
    pg_catalog.pg_backend_pid()::TEXT||':'||pg_catalog.pg_current_xact_id()::TEXT THEN
    RAISE EXCEPTION 'operator evidence write is owner capability controlled';
  END IF;
  RETURN NEW;
END $function$;

CREATE TRIGGER downtown_u_operator_audit_events_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.downtown_u_operator_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.downtown_u_operator_append_only_guard();
CREATE TRIGGER downtown_u_operator_audit_events_no_truncate
  BEFORE TRUNCATE ON public.downtown_u_operator_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.downtown_u_operator_append_only_guard();
CREATE TRIGGER downtown_u_eligibility_events_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.downtown_u_eligibility_events
  FOR EACH ROW EXECUTE FUNCTION public.downtown_u_operator_append_only_guard();
CREATE TRIGGER downtown_u_eligibility_events_no_truncate
  BEFORE TRUNCATE ON public.downtown_u_eligibility_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.downtown_u_operator_append_only_guard();
CREATE TRIGGER downtown_u_operator_reconciliation_cases_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.downtown_u_operator_reconciliation_cases
  FOR EACH ROW EXECUTE FUNCTION public.downtown_u_operator_append_only_guard();
CREATE TRIGGER downtown_u_operator_reconciliation_cases_no_truncate
  BEFORE TRUNCATE ON public.downtown_u_operator_reconciliation_cases
  FOR EACH STATEMENT EXECUTE FUNCTION public.downtown_u_operator_append_only_guard();
CREATE TRIGGER downtown_u_operator_reconciliation_resolutions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.downtown_u_operator_reconciliation_resolutions
  FOR EACH ROW EXECUTE FUNCTION public.downtown_u_operator_append_only_guard();
CREATE TRIGGER downtown_u_operator_reconciliation_resolutions_no_truncate
  BEFORE TRUNCATE ON public.downtown_u_operator_reconciliation_resolutions
  FOR EACH STATEMENT EXECUTE FUNCTION public.downtown_u_operator_append_only_guard();
CREATE TRIGGER downtown_u_operator_adjustments_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.downtown_u_operator_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.downtown_u_operator_append_only_guard();
CREATE TRIGGER downtown_u_operator_adjustments_no_truncate
  BEFORE TRUNCATE ON public.downtown_u_operator_adjustments
  FOR EACH STATEMENT EXECUTE FUNCTION public.downtown_u_operator_append_only_guard();
CREATE TRIGGER downtown_u_operator_security_events_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.downtown_u_operator_security_events
  FOR EACH ROW EXECUTE FUNCTION public.downtown_u_operator_append_only_guard();
CREATE TRIGGER downtown_u_operator_security_events_no_truncate
  BEFORE TRUNCATE ON public.downtown_u_operator_security_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.downtown_u_operator_append_only_guard();
CREATE TRIGGER downtown_u_operator_owner_events_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.downtown_u_operator_owner_events
  FOR EACH ROW EXECUTE FUNCTION public.downtown_u_operator_append_only_guard();
CREATE TRIGGER downtown_u_operator_owner_events_no_truncate
  BEFORE TRUNCATE ON public.downtown_u_operator_owner_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.downtown_u_operator_append_only_guard();

/* Source synchronization is installed before the snapshot import. Migration DDL
 * locks and these idempotent AFTER triggers close the creation race without
 * changing either immutable source row. */
CREATE FUNCTION public.downtown_u_operator_sync_refund_case() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE previous_setting TEXT;
BEGIN
  previous_setting := pg_catalog.current_setting('downtown_u.operator_write',true);
  PERFORM pg_catalog.set_config('downtown_u.operator_write',
    pg_catalog.pg_backend_pid()::TEXT||':'||pg_catalog.pg_current_xact_id()::TEXT,true);
  INSERT INTO public.downtown_u_operator_reconciliation_cases
    (source_type,source_id,student_id,reason_code,reason,idempotency_key,correlation_id,origin,created_at)
  VALUES ('refund',NEW.id::TEXT,NEW.student_id,'insufficient_available_credits',
    'Imported immutable refund reconciliation','operator_case:refund:'||NEW.id::TEXT,
    'operator_case:refund:'||NEW.id::TEXT,'source_sync',NEW.created_at)
  ON CONFLICT ON CONSTRAINT downtown_u_operator_cases_source_key DO NOTHING;
  PERFORM pg_catalog.set_config('downtown_u.operator_write',COALESCE(previous_setting,''),true);
  RETURN NEW;
END $function$;
CREATE TRIGGER downtown_u_operator_sync_refund_case
  AFTER INSERT ON public.downtown_u_refund_reconciliations
  FOR EACH ROW EXECUTE FUNCTION public.downtown_u_operator_sync_refund_case();

CREATE FUNCTION public.downtown_u_operator_sync_kitchen_case() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE previous_setting TEXT; source_student_id UUID;
BEGIN
  IF NEW.state='operator_review' AND
     (TG_OP='INSERT' OR OLD.state IS DISTINCT FROM 'operator_review') THEN
    SELECT r.student_id INTO STRICT source_student_id
      FROM public.downtown_u_redemptions AS r WHERE r.id=NEW.redemption_id;
    previous_setting := pg_catalog.current_setting('downtown_u.operator_write',true);
    PERFORM pg_catalog.set_config('downtown_u.operator_write',
      pg_catalog.pg_backend_pid()::TEXT||':'||pg_catalog.pg_current_xact_id()::TEXT,true);
    INSERT INTO public.downtown_u_operator_reconciliation_cases
      (source_type,source_id,student_id,reason_code,reason,idempotency_key,correlation_id,origin,created_at)
    VALUES ('kitchen',NEW.redemption_id::TEXT,source_student_id,'kitchen_operator_review',
      'Imported kitchen operator review','operator_case:kitchen:'||NEW.redemption_id::TEXT,
      'operator_case:kitchen:'||NEW.redemption_id::TEXT,'source_sync',NEW.updated_at)
    ON CONFLICT ON CONSTRAINT downtown_u_operator_cases_source_key DO NOTHING;
    PERFORM pg_catalog.set_config('downtown_u.operator_write',COALESCE(previous_setting,''),true);
  END IF;
  RETURN NEW;
END $function$;
CREATE TRIGGER downtown_u_operator_sync_kitchen_case
  AFTER INSERT OR UPDATE OF state ON public.downtown_u_kitchen_order_outbox
  FOR EACH ROW EXECUTE FUNCTION public.downtown_u_operator_sync_kitchen_case();

/* Import immutable authority rows without rewriting either source. Re-running
 * these statements is harmless because the authority identity is the key. */
SELECT pg_catalog.set_config('downtown_u.operator_write',
  pg_catalog.pg_backend_pid()::TEXT||':'||pg_catalog.pg_current_xact_id()::TEXT,true);
INSERT INTO public.downtown_u_operator_reconciliation_cases
  (source_type,source_id,student_id,reason_code,reason,idempotency_key,correlation_id,origin,created_at)
SELECT 'refund',q.id::TEXT,q.student_id,q.reason_code,
  'Imported immutable refund reconciliation',
  'operator_case:refund:'||q.id::TEXT,'operator_case:refund:'||q.id::TEXT,
  'migration_backfill',q.created_at
FROM public.downtown_u_refund_reconciliations AS q
ON CONFLICT (source_type,source_id) DO NOTHING;
INSERT INTO public.downtown_u_operator_reconciliation_cases
  (source_type,source_id,student_id,reason_code,reason,idempotency_key,correlation_id,origin,created_at)
SELECT 'kitchen',o.redemption_id::TEXT,r.student_id,
  'kitchen_operator_review',
  'Imported kitchen operator review',
  'operator_case:kitchen:'||o.redemption_id::TEXT,
  'operator_case:kitchen:'||o.redemption_id::TEXT,'migration_backfill',o.updated_at
FROM public.downtown_u_kitchen_order_outbox AS o
JOIN public.downtown_u_redemptions AS r ON r.id=o.redemption_id
WHERE o.state='operator_review'
ON CONFLICT (source_type,source_id) DO NOTHING;
SELECT pg_catalog.set_config('downtown_u.operator_write','',true);

REVOKE ALL ON FUNCTION public.downtown_u_operator_append_only_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.downtown_u_operator_append_only_guard() FROM downtown_u_operator_runtime;
REVOKE ALL ON FUNCTION public.downtown_u_operator_accounts_immutable_identity_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.downtown_u_operator_accounts_immutable_identity_guard() FROM downtown_u_operator_runtime;
REVOKE ALL ON public.downtown_u_operator_config,
  public.downtown_u_operator_accounts,public.downtown_u_operator_account_roles,
  public.downtown_u_operator_auth_flows,public.downtown_u_operator_auth_challenges,public.downtown_u_operator_sessions,
  public.downtown_u_operator_security_events,public.downtown_u_operator_owner_events,
  public.downtown_u_operator_audit_events,public.downtown_u_eligibility_events,
  public.downtown_u_operator_reconciliation_cases,public.downtown_u_operator_reconciliation_resolutions,
  public.downtown_u_operator_adjustments,public.downtown_u_operator_reconciliation_case_state
  FROM PUBLIC,downtown_u_operator_runtime,downtown_u_runtime,downtown_u_jobs,downtown_u_kitchen_jobs;

/* Default privileges are ambient owner state, not a trusted migration input.
 * Catalog-drive every identifier in the fixed public namespace, remove every
 * non-owner ACL entry (including PUBLIC and arbitrary roles), then fail closed
 * if ownership or the complete ACL surface is not exactly owner-only. */
DO $acl$
DECLARE migration_owner OID; target RECORD;
BEGIN
  SELECT r.oid INTO STRICT migration_owner FROM pg_catalog.pg_roles AS r
    WHERE r.rolname=CURRENT_USER;

  FOR target IN
    SELECT c.relname,c.relowner,acl.grantee,grantee.rolname AS grantee_name
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) AS acl
    LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid=acl.grantee
    WHERE n.nspname='public' AND c.relkind IN ('r','v')
      AND (c.relname LIKE 'downtown_u_operator_%' OR c.relname='downtown_u_eligibility_events')
      AND acl.grantee<>migration_owner
  LOOP
    IF target.relowner<>migration_owner THEN
      RAISE EXCEPTION 'operator relation is not migration-owner controlled';
    ELSIF target.grantee=0 THEN
      EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC','public',target.relname);
    ELSIF target.grantee_name IS NULL THEN
      RAISE EXCEPTION 'operator relation ACL references unknown role';
    ELSE
      EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I',
        'public',target.relname,target.grantee_name);
    END IF;
  END LOOP;

  FOR target IN
    SELECT p.proname,p.proowner,acl.grantee,grantee.rolname AS grantee_name,
      pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) AS acl
    LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid=acl.grantee
    WHERE n.nspname='public' AND p.proname LIKE 'downtown_u_operator_%'
      AND acl.grantee<>migration_owner
  LOOP
    IF target.proowner<>migration_owner THEN
      RAISE EXCEPTION 'operator function is not migration-owner controlled';
    ELSIF target.grantee=0 THEN
      EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON FUNCTION %I.%I(%s) FROM PUBLIC',
        'public',target.proname,target.identity_arguments);
    ELSIF target.grantee_name IS NULL THEN
      RAISE EXCEPTION 'operator function ACL references unknown role';
    ELSE
      EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON FUNCTION %I.%I(%s) FROM %I',
        'public',target.proname,target.identity_arguments,target.grantee_name);
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) AS acl
    WHERE n.nspname='public' AND c.relkind IN ('r','v')
      AND (c.relname LIKE 'downtown_u_operator_%' OR c.relname='downtown_u_eligibility_events')
      AND (c.relowner<>migration_owner OR acl.grantee<>migration_owner)
  ) THEN RAISE EXCEPTION 'non-owner operator relation ACL remains'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) AS acl
    WHERE n.nspname='public' AND p.proname LIKE 'downtown_u_operator_%'
      AND (p.proowner<>migration_owner OR acl.grantee<>migration_owner)
  ) THEN RAISE EXCEPTION 'non-owner operator function ACL remains'; END IF;
END $acl$;

COMMIT;
