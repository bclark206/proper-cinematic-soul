BEGIN;

-- A3c introduces the first authoritative refund application records. Any older
-- refund ledger or purchase state is therefore unverifiable and must not be
-- laundered into the new model. Keep this check ahead of every schema mutation
-- so failure leaves the pre-A3c database byte-for-byte structurally unchanged.
-- Take both write-conflicting locks in the same order as payment activation:
-- purchase first, then ledger. SHARE ROW EXCLUSIVE conflicts with runtime
-- RowExclusive DML, and both locks remain held until commit or rollback.
LOCK TABLE public.downtown_u_plan_purchases
  IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.downtown_u_credit_transactions
  IN SHARE ROW EXCLUSIVE MODE;

DO $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.downtown_u_credit_transactions AS t
    WHERE t.transaction_type='purchase_refund'
  ) OR EXISTS (
    SELECT 1 FROM public.downtown_u_plan_purchases AS p
    WHERE p.refunded_credits<>0 OR p.status<>'paid' OR p.refunded_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Downtown U pre-A3c refund state is not canonical';
  END IF;
END
$function$;

-- created_at is a transaction-start timestamp and UUIDs do not encode commit or
-- application order. Reconstruct the only possible student-local chain from its
-- balance transitions; an ambiguous or inconsistent pre-A3c ledger aborts this
-- transactional migration.
ALTER TABLE public.downtown_u_credit_transactions
  ADD COLUMN ledger_sequence BIGINT;
ALTER TABLE public.downtown_u_credit_transactions
  DISABLE TRIGGER downtown_u_credit_transactions_immutable;
DO $function$
DECLARE
  student RECORD;
  prior_balance BIGINT;
  next_balance BIGINT;
  next_id UUID;
  next_sequence BIGINT;
  remaining_count BIGINT;
  candidate_count BIGINT;
BEGIN
  FOR student IN
    SELECT s.id,s.credit_balance FROM public.downtown_u_students AS s ORDER BY s.id
  LOOP
    prior_balance := 0;
    next_sequence := 1;
    SELECT count(*) INTO remaining_count
    FROM public.downtown_u_credit_transactions AS t WHERE t.student_id=student.id;

    WHILE remaining_count > 0 LOOP
      SELECT count(*) INTO candidate_count
      FROM public.downtown_u_credit_transactions AS t
      WHERE t.student_id=student.id AND t.ledger_sequence IS NULL
        AND t.resulting_balance::BIGINT = prior_balance + t.delta::BIGINT;
      IF candidate_count <> 1 THEN
        RAISE EXCEPTION 'Downtown U historical credit ledger is ambiguous or inconsistent for student %',
          student.id;
      END IF;

      SELECT t.id,t.resulting_balance::BIGINT INTO STRICT next_id,next_balance
      FROM public.downtown_u_credit_transactions AS t
      WHERE t.student_id=student.id AND t.ledger_sequence IS NULL
        AND t.resulting_balance::BIGINT = prior_balance + t.delta::BIGINT;
      UPDATE public.downtown_u_credit_transactions AS t
      SET ledger_sequence=next_sequence WHERE t.id=next_id;
      prior_balance := next_balance;
      next_sequence := next_sequence + 1;
      remaining_count := remaining_count - 1;
    END LOOP;

    IF prior_balance IS DISTINCT FROM student.credit_balance::BIGINT THEN
      RAISE EXCEPTION 'Downtown U historical credit ledger final balance is inconsistent for student %',
        student.id;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM public.downtown_u_credit_transactions AS t
    WHERE t.ledger_sequence IS NULL
  ) THEN
    RAISE EXCEPTION 'Downtown U historical credit ledger contains orphan or unassigned rows';
  END IF;
END
$function$;
ALTER TABLE public.downtown_u_credit_transactions
  ENABLE TRIGGER downtown_u_credit_transactions_immutable;
ALTER TABLE public.downtown_u_credit_transactions
  ALTER COLUMN ledger_sequence SET NOT NULL,
  ADD CONSTRAINT downtown_u_credit_transactions_ledger_sequence_positive
    CHECK (ledger_sequence > 0),
  ADD CONSTRAINT downtown_u_credit_transactions_student_ledger_sequence_key
    UNIQUE (student_id,ledger_sequence);

-- Preserve direct runtime ledger insertion while withholding sequence assignment:
-- only the trusted trigger may populate ledger_sequence after taking the student lock.
REVOKE INSERT ON public.downtown_u_credit_transactions FROM downtown_u_runtime;
GRANT INSERT (id,student_id,purchase_id,redemption_id,delta,resulting_balance,
  transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id,
  metadata,created_at) ON public.downtown_u_credit_transactions TO downtown_u_runtime;

CREATE OR REPLACE FUNCTION public.downtown_u_apply_credit_transaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  current_balance INTEGER;
  referenced_credits INTEGER;
  refunded_credits INTEGER;
  reservation_count INTEGER;
BEGIN
  IF NEW.ledger_sequence IS NOT NULL THEN
    RAISE EXCEPTION 'Downtown U ledger sequence is assigned internally';
  END IF;
  SELECT s.credit_balance INTO current_balance
  FROM public.downtown_u_students AS s WHERE s.id = NEW.student_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Downtown U student not found'; END IF;

  -- This is deliberately after the student row lock: committed/application order
  -- for one student is therefore serial and gap-free without a global sequence.
  SELECT COALESCE(max(t.ledger_sequence),0)+1 INTO NEW.ledger_sequence
  FROM public.downtown_u_credit_transactions AS t WHERE t.student_id=NEW.student_id;

  IF NEW.transaction_type IN ('purchase_grant', 'purchase_refund') THEN
    SELECT p.credits_granted INTO referenced_credits
    FROM public.downtown_u_plan_purchases AS p
    WHERE p.id = NEW.purchase_id AND p.student_id = NEW.student_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Downtown U purchase not found for student'; END IF;
    IF NEW.transaction_type = 'purchase_grant' AND NEW.delta <> referenced_credits THEN
      RAISE EXCEPTION 'Downtown U purchase grant must equal referenced purchase credits_granted';
    ELSIF NEW.transaction_type = 'purchase_refund' THEN
      SELECT COALESCE(-sum(t.delta), 0) INTO refunded_credits
      FROM public.downtown_u_credit_transactions AS t
      WHERE t.purchase_id = NEW.purchase_id AND t.transaction_type = 'purchase_refund';
      IF refunded_credits + (-NEW.delta) > referenced_credits THEN
        RAISE EXCEPTION 'Downtown U purchase refund credits exceed the purchase grant';
      END IF;
    END IF;
  ELSIF NEW.transaction_type IN ('reservation', 'redemption_reversal') THEN
    SELECT r.credits INTO referenced_credits
    FROM public.downtown_u_redemptions AS r
    WHERE r.id = NEW.redemption_id AND r.student_id = NEW.student_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Downtown U redemption not found for student'; END IF;
    IF NEW.transaction_type = 'reservation' AND NEW.delta <> -referenced_credits THEN
      RAISE EXCEPTION 'Downtown U reservation debit must equal referenced redemption credits';
    ELSIF NEW.transaction_type = 'redemption_reversal' THEN
      IF NEW.delta <> referenced_credits THEN
        RAISE EXCEPTION 'Downtown U redemption reversal must equal referenced redemption credits';
      END IF;
      SELECT count(*) INTO reservation_count
      FROM public.downtown_u_credit_transactions AS t
      WHERE t.redemption_id = NEW.redemption_id AND t.transaction_type = 'reservation';
      IF reservation_count <> 1 THEN
        RAISE EXCEPTION 'Downtown U redemption reversal requires exactly one reservation ledger entry';
      END IF;
    END IF;
  END IF;

  IF NEW.resulting_balance <> current_balance + NEW.delta THEN
    RAISE EXCEPTION 'Credit ledger balance chain mismatch';
  END IF;
  IF NEW.resulting_balance < 0 THEN
    RAISE EXCEPTION 'Downtown U credit balance cannot be negative';
  END IF;
  INSERT INTO public.downtown_u_balance_update_authorizations
    (backend_pid, transaction_id, student_id, new_balance)
  VALUES (pg_backend_pid(), txid_current(), NEW.student_id, NEW.resulting_balance)
  ON CONFLICT (backend_pid, transaction_id, student_id)
  DO UPDATE SET new_balance = EXCLUDED.new_balance;
  UPDATE public.downtown_u_students
  SET credit_balance = NEW.resulting_balance, updated_at = now() WHERE id = NEW.student_id;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.downtown_u_apply_credit_transaction() FROM PUBLIC, downtown_u_runtime;

CREATE TABLE public.downtown_u_refund_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  square_refund_id TEXT NOT NULL UNIQUE CHECK (square_refund_id ~ '^[A-Za-z0-9_-]{1,192}$'),
  source_event_id TEXT NOT NULL UNIQUE CHECK (source_event_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  square_payment_id TEXT NOT NULL CHECK (square_payment_id ~ '^[A-Za-z0-9_-]{1,192}$'),
  square_order_id TEXT CHECK (square_order_id IS NULL OR square_order_id ~ '^[A-Za-z0-9_-]{1,192}$'),
  purchase_id UUID NOT NULL REFERENCES public.downtown_u_plan_purchases(id) ON DELETE RESTRICT,
  student_id UUID NOT NULL REFERENCES public.downtown_u_students(id) ON DELETE RESTRICT,
  authoritative_amount_cents INTEGER NOT NULL CHECK (authoritative_amount_cents > 0),
  authoritative_currency TEXT NOT NULL CHECK (authoritative_currency = 'USD'),
  authoritative_location_id TEXT NOT NULL CHECK (authoritative_location_id ~ '^[A-Za-z0-9_-]{1,192}$'),
  authoritative_updated_at TEXT NOT NULL CHECK (
    length(authoritative_updated_at) BETWEEN 20 AND 35 AND
    authoritative_updated_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$'),
  refund_sequence BIGINT NOT NULL CHECK (refund_sequence > 0),
  cumulative_refunded_cents INTEGER NOT NULL CHECK (cumulative_refunded_cents > 0),
  target_refunded_credits INTEGER NOT NULL CHECK (target_refunded_credits >= 0),
  credit_delta INTEGER NOT NULL CHECK (credit_delta >= 0 AND credit_delta <= target_refunded_credits),
  available_credits_before INTEGER NOT NULL CHECK (available_credits_before >= 0),
  status TEXT NOT NULL CHECK (status IN ('applied','reconciliation_required')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ,
  CHECK ((status='applied' AND applied_at IS NOT NULL) OR
         (status='reconciliation_required' AND applied_at IS NULL)),
  CHECK ((status='applied' AND available_credits_before>=credit_delta) OR
         (status='reconciliation_required' AND available_credits_before<credit_delta)),
  UNIQUE (id, purchase_id, student_id),
  UNIQUE (purchase_id, refund_sequence)
);

CREATE TABLE public.downtown_u_refund_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_application_id UUID NOT NULL UNIQUE,
  purchase_id UUID NOT NULL,
  student_id UUID NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code = 'insufficient_available_credits'),
  required_credits INTEGER NOT NULL CHECK (required_credits > 0),
  available_credits INTEGER NOT NULL CHECK (available_credits >= 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status='open'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (available_credits < required_credits),
  FOREIGN KEY (refund_application_id,purchase_id,student_id)
    REFERENCES public.downtown_u_refund_applications(id,purchase_id,student_id) ON DELETE RESTRICT
);

CREATE FUNCTION public.downtown_u_reject_refund_record_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Downtown U refund records are immutable';
END
$function$;
CREATE TRIGGER downtown_u_refund_applications_immutable
BEFORE UPDATE OR DELETE ON public.downtown_u_refund_applications
FOR EACH ROW EXECUTE FUNCTION public.downtown_u_reject_refund_record_mutation();
CREATE TRIGGER downtown_u_refund_applications_no_truncate
BEFORE TRUNCATE ON public.downtown_u_refund_applications
FOR EACH STATEMENT EXECUTE FUNCTION public.downtown_u_reject_refund_record_mutation();
CREATE TRIGGER downtown_u_refund_reconciliations_immutable
BEFORE UPDATE OR DELETE ON public.downtown_u_refund_reconciliations
FOR EACH ROW EXECUTE FUNCTION public.downtown_u_reject_refund_record_mutation();
CREATE TRIGGER downtown_u_refund_reconciliations_no_truncate
BEFORE TRUNCATE ON public.downtown_u_refund_reconciliations
FOR EACH STATEMENT EXECUTE FUNCTION public.downtown_u_reject_refund_record_mutation();
REVOKE ALL ON FUNCTION public.downtown_u_reject_refund_record_mutation() FROM PUBLIC, downtown_u_runtime;
REVOKE ALL ON public.downtown_u_refund_applications FROM PUBLIC, downtown_u_runtime;
REVOKE ALL ON public.downtown_u_refund_reconciliations FROM PUBLIC, downtown_u_runtime;

-- Extend the trusted ledger gate: purchase grants and authoritative refund debits
-- may only originate while a SECURITY DEFINER capability owns CURRENT_USER.
CREATE OR REPLACE FUNCTION public.downtown_u_require_trusted_purchase_grant() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.transaction_type IN ('purchase_grant','purchase_refund') AND CURRENT_USER IS DISTINCT FROM
    pg_catalog.pg_get_userbyid((SELECT p.proowner FROM pg_catalog.pg_proc AS p
      WHERE p.oid = 'public.downtown_u_require_trusted_purchase_grant()'::pg_catalog.regprocedure)) THEN
    RAISE EXCEPTION 'Downtown U authoritative purchase ledger mutation rejected';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION public.downtown_u_activate_verified_refund(
  requested_event_id TEXT,
  requested_claim_token UUID,
  requested_resource_id TEXT,
  requested_refund_id TEXT,
  requested_payment_id TEXT,
  requested_order_id TEXT,
  requested_amount_cents INTEGER,
  requested_currency TEXT,
  requested_location_id TEXT,
  requested_updated_at TEXT
) RETURNS TABLE(outcome TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  purchase public.downtown_u_plan_purchases%ROWTYPE;
  application public.downtown_u_refund_applications%ROWTYPE;
  grant_row public.downtown_u_credit_transactions%ROWTYPE;
  parsed_updated_at TIMESTAMPTZ;
  purchase_count INTEGER;
  collision_count INTEGER;
  grant_count INTEGER;
  cumulative_cents BIGINT;
  target_credits INTEGER;
  delta_credits INTEGER;
  available_credits INTEGER;
  next_status TEXT;
  topology_count INTEGER;
  applied_credit_total INTEGER;
  prefix_count BIGINT;
  prior_applied_credits INTEGER;
  next_refund_sequence BIGINT;
  expected_purchase_status TEXT;
  expected_refunded_at TIMESTAMPTZ;
  prior_application RECORD;
  expected_sequence BIGINT;
  expected_cumulative BIGINT;
  expected_target INTEGER;
  expected_delta INTEGER;
  expected_ledger_count INTEGER;
  expected_reconciliation_count INTEGER;
BEGIN
  IF requested_event_id IS NULL OR requested_event_id !~ '^[A-Za-z0-9_-]{1,128}$'
    OR requested_claim_token IS NULL
    OR requested_resource_id IS NULL OR requested_resource_id !~ '^[A-Za-z0-9_-]{1,192}$'
    OR requested_refund_id IS NULL OR requested_refund_id !~ '^[A-Za-z0-9_-]{1,192}$'
    OR requested_payment_id IS NULL OR requested_payment_id !~ '^[A-Za-z0-9_-]{1,192}$'
    OR requested_order_id IS NOT NULL AND requested_order_id !~ '^[A-Za-z0-9_-]{1,192}$'
    OR requested_resource_id IS DISTINCT FROM requested_refund_id
    OR requested_refund_id = requested_payment_id
    OR requested_refund_id = requested_order_id
    OR requested_payment_id = requested_order_id
    OR requested_amount_cents IS NULL OR requested_amount_cents <= 0 OR requested_amount_cents > 40000
    OR requested_currency IS DISTINCT FROM 'USD'
    OR requested_location_id IS NULL OR requested_location_id !~ '^[A-Za-z0-9_-]{1,192}$'
    OR requested_updated_at IS NULL OR length(requested_updated_at) NOT BETWEEN 20 AND 35
    OR requested_updated_at !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
    RAISE EXCEPTION 'Downtown U refund activation rejected';
  END IF;
  BEGIN
    parsed_updated_at := requested_updated_at::TIMESTAMPTZ;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Downtown U refund activation rejected';
  END;

  PERFORM 1 FROM public.downtown_u_webhook_events AS e
  WHERE e.square_event_id=requested_event_id AND e.event_type='refund.updated'
    AND e.status='processing' AND e.claim_token=requested_claim_token FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Downtown U refund activation rejected'; END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(keys.identity,0))
  FROM pg_catalog.unnest(ARRAY[
    'event:'||requested_event_id, 'payment:'||requested_payment_id,
    'refund:'||requested_refund_id,
    CASE WHEN requested_order_id IS NOT NULL THEN 'order:'||requested_order_id END
  ]::TEXT[]) AS keys(identity)
  WHERE keys.identity IS NOT NULL ORDER BY keys.identity;

  SELECT count(*) INTO collision_count FROM public.downtown_u_refund_applications AS r
  WHERE r.square_refund_id=requested_refund_id OR r.source_event_id=requested_event_id;
  IF collision_count > 1 THEN RAISE EXCEPTION 'Downtown U refund activation rejected'; END IF;
  IF collision_count = 1 THEN
    SELECT r.* INTO application FROM public.downtown_u_refund_applications AS r
    WHERE r.square_refund_id=requested_refund_id OR r.source_event_id=requested_event_id FOR UPDATE;
    IF application.square_refund_id IS DISTINCT FROM requested_refund_id
      OR application.source_event_id IS DISTINCT FROM requested_event_id
      OR application.square_payment_id IS DISTINCT FROM requested_payment_id
      OR application.square_order_id IS DISTINCT FROM requested_order_id
      OR application.authoritative_amount_cents IS DISTINCT FROM requested_amount_cents
      OR application.authoritative_currency IS DISTINCT FROM requested_currency
      OR application.authoritative_location_id IS DISTINCT FROM requested_location_id
      OR application.authoritative_updated_at IS DISTINCT FROM requested_updated_at THEN
      RAISE EXCEPTION 'Downtown U refund activation rejected';
    END IF;
    SELECT p.* INTO purchase FROM public.downtown_u_plan_purchases AS p
    WHERE p.id=application.purchase_id FOR UPDATE;
    IF NOT FOUND OR purchase.square_payment_id IS DISTINCT FROM application.square_payment_id
      OR purchase.student_id IS DISTINCT FROM application.student_id
      OR (application.square_order_id IS NOT NULL
        AND purchase.square_order_id IS DISTINCT FROM application.square_order_id) THEN
      RAISE EXCEPTION 'Downtown U refund activation rejected';
    END IF;
    -- Validate the complete A3b grant contract before trusting refund state.
    SELECT count(*) INTO grant_count FROM public.downtown_u_credit_transactions AS t
    WHERE t.purchase_id=application.purchase_id AND t.transaction_type='purchase_grant';
    IF grant_count <> 1 THEN RAISE EXCEPTION 'Downtown U refund activation rejected'; END IF;
    SELECT t.* INTO grant_row FROM public.downtown_u_credit_transactions AS t
    WHERE t.purchase_id=application.purchase_id AND t.transaction_type='purchase_grant';
    IF grant_row.student_id IS DISTINCT FROM purchase.student_id
      OR grant_row.delta IS DISTINCT FROM purchase.credits_granted
      OR grant_row.ledger_sequence IS NULL OR grant_row.ledger_sequence <= 0
      OR grant_row.resulting_balance IS DISTINCT FROM (SELECT COALESCE(sum(t.delta),0)::INTEGER
        FROM public.downtown_u_credit_transactions AS t WHERE t.student_id=grant_row.student_id
          AND t.ledger_sequence <= grant_row.ledger_sequence)
      OR grant_row.transaction_type IS DISTINCT FROM 'purchase_grant'
      OR grant_row.reason IS DISTINCT FROM 'verified Square payment'
      OR grant_row.idempotency_key IS DISTINCT FROM 'purchase_grant:'||purchase.square_payment_id
      OR grant_row.actor_type IS DISTINCT FROM 'square_webhook'
      OR grant_row.actor_id IS DISTINCT FROM purchase.source_event_id
      OR grant_row.source_type IS DISTINCT FROM 'square_payment'
      OR grant_row.source_id IS DISTINCT FROM purchase.square_payment_id
      OR grant_row.metadata IS DISTINCT FROM pg_catalog.jsonb_build_object(
        'currency',purchase.currency,'locationId',application.authoritative_location_id) THEN
      RAISE EXCEPTION 'Downtown U refund activation rejected';
    END IF;

    -- Recompute the immutable sequence prefix. Reconciliation applications
    -- contribute authoritative money, but only applied predecessors contribute
    -- credits already moved on the purchase.
    SELECT count(*),COALESCE(sum(r.authoritative_amount_cents),0)
      INTO prefix_count,cumulative_cents
    FROM public.downtown_u_refund_applications AS r
    WHERE r.purchase_id=application.purchase_id AND r.refund_sequence<=application.refund_sequence;
    IF prefix_count IS DISTINCT FROM application.refund_sequence
      OR cumulative_cents>purchase.price_cents THEN
      RAISE EXCEPTION 'Downtown U refund activation rejected';
    END IF;
    target_credits := CASE WHEN cumulative_cents=purchase.price_cents THEN purchase.credits_granted
      ELSE (cumulative_cents*purchase.credits_granted/purchase.price_cents)::INTEGER END;
    SELECT COALESCE(sum(r.credit_delta),0)::INTEGER INTO prior_applied_credits
    FROM public.downtown_u_refund_applications AS r
    WHERE r.purchase_id=application.purchase_id AND r.refund_sequence<application.refund_sequence
      AND r.status='applied';
    delta_credits := target_credits-prior_applied_credits;
    IF application.cumulative_refunded_cents IS DISTINCT FROM cumulative_cents::INTEGER
      OR application.target_refunded_credits IS DISTINCT FROM target_credits
      OR application.credit_delta IS DISTINCT FROM delta_credits OR delta_credits<0
      OR (application.status='applied' AND (application.available_credits_before<delta_credits
        OR application.applied_at IS DISTINCT FROM application.authoritative_updated_at::TIMESTAMPTZ))
      OR (application.status='reconciliation_required' AND (delta_credits=0
        OR application.available_credits_before>=delta_credits OR application.applied_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'Downtown U refund activation rejected';
    END IF;

    SELECT COALESCE(sum(r.credit_delta) FILTER (WHERE r.status='applied'),0)::INTEGER
      INTO applied_credit_total FROM public.downtown_u_refund_applications AS r
      WHERE r.purchase_id=application.purchase_id;
    expected_purchase_status := CASE WHEN applied_credit_total=0 THEN 'paid'
      WHEN applied_credit_total=purchase.credits_granted THEN 'refunded' ELSE 'partially_refunded' END;
    SELECT r.authoritative_updated_at::TIMESTAMPTZ INTO expected_refunded_at
    FROM public.downtown_u_refund_applications AS r WHERE r.purchase_id=application.purchase_id
      AND r.status='applied' AND r.credit_delta>0 ORDER BY r.refund_sequence DESC LIMIT 1;
    IF purchase.refunded_credits IS DISTINCT FROM applied_credit_total
      OR purchase.status IS DISTINCT FROM expected_purchase_status
      OR purchase.refunded_at IS DISTINCT FROM expected_refunded_at THEN
      RAISE EXCEPTION 'Downtown U refund activation rejected';
    END IF;
    IF application.status='reconciliation_required' THEN
      SELECT count(*) INTO topology_count FROM public.downtown_u_refund_reconciliations AS q
      WHERE q.refund_application_id=application.id AND q.purchase_id=application.purchase_id
        AND q.student_id=application.student_id AND q.reason_code='insufficient_available_credits'
        AND q.required_credits=application.credit_delta
        AND q.available_credits=application.available_credits_before
        AND q.available_credits<q.required_credits AND q.status='open';
      IF topology_count <> 1 THEN RAISE EXCEPTION 'Downtown U refund activation rejected'; END IF;
    ELSE
      SELECT count(*) INTO topology_count FROM public.downtown_u_refund_reconciliations AS q
      WHERE q.refund_application_id=application.id;
      IF topology_count <> 0 THEN RAISE EXCEPTION 'Downtown U refund activation rejected'; END IF;
    END IF;
    -- Count the collision superset first; only then inspect the exact row.
    SELECT count(*) INTO collision_count FROM public.downtown_u_credit_transactions AS t
    WHERE t.idempotency_key='purchase_refund:'||application.square_refund_id
      OR (t.source_type='square_refund' AND t.source_id=application.square_refund_id)
      OR (t.transaction_type='purchase_refund' AND t.source_id=application.square_refund_id);
    IF collision_count <> (CASE WHEN application.status='applied' AND application.credit_delta>0 THEN 1 ELSE 0 END) THEN
      RAISE EXCEPTION 'Downtown U refund activation rejected';
    END IF;
    SELECT count(*) INTO topology_count FROM public.downtown_u_credit_transactions AS t
    WHERE t.transaction_type='purchase_refund'
      AND t.source_id=application.square_refund_id
      AND t.idempotency_key='purchase_refund:'||application.square_refund_id
      AND t.purchase_id=application.purchase_id AND t.student_id=application.student_id
      AND t.redemption_id IS NULL
      AND t.ledger_sequence>0
      AND t.resulting_balance=(SELECT COALESCE(sum(chain.delta),0)::INTEGER
        FROM public.downtown_u_credit_transactions AS chain
        WHERE chain.student_id=t.student_id AND chain.ledger_sequence<=t.ledger_sequence)
      AND t.delta=-application.credit_delta
      AND t.resulting_balance=application.available_credits_before-application.credit_delta
      AND t.reason='verified Square refund'
      AND t.actor_type='square_webhook' AND t.actor_id=application.source_event_id
      AND t.source_type='square_refund'
      AND t.metadata=pg_catalog.jsonb_build_object(
        'amountCents',application.authoritative_amount_cents,
        'currency',application.authoritative_currency);
    IF topology_count <> collision_count THEN
      RAISE EXCEPTION 'Downtown U refund activation rejected';
    END IF;
    UPDATE public.downtown_u_webhook_events AS e SET status='completed',
      completed_at=pg_catalog.clock_timestamp(),claim_token=NULL,updated_at=pg_catalog.clock_timestamp()
    WHERE e.square_event_id=requested_event_id AND e.status='processing'
      AND e.claim_token=requested_claim_token;
    IF NOT FOUND THEN RAISE EXCEPTION 'Downtown U refund activation rejected'; END IF;
    RETURN QUERY SELECT 'duplicate'::TEXT;
    RETURN;
  END IF;

  SELECT count(*) INTO purchase_count FROM public.downtown_u_plan_purchases AS p
  WHERE p.square_payment_id=requested_payment_id;
  IF purchase_count <> 1 THEN RAISE EXCEPTION 'Downtown U refund activation rejected'; END IF;
  SELECT p.* INTO purchase FROM public.downtown_u_plan_purchases AS p
  WHERE p.square_payment_id=requested_payment_id FOR UPDATE;
  IF requested_order_id IS NOT NULL AND purchase.square_order_id IS DISTINCT FROM requested_order_id THEN
    RAISE EXCEPTION 'Downtown U refund activation rejected';
  END IF;
  IF EXISTS (SELECT 1 FROM public.downtown_u_refund_applications AS r
    WHERE r.purchase_id=purchase.id AND r.status='reconciliation_required') THEN
    RAISE EXCEPTION 'Downtown U refund activation rejected';
  END IF;

  SELECT count(*) INTO grant_count FROM public.downtown_u_credit_transactions AS t
  WHERE t.purchase_id=purchase.id AND t.transaction_type='purchase_grant';
  IF grant_count <> 1 THEN RAISE EXCEPTION 'Downtown U refund activation rejected'; END IF;
  SELECT t.* INTO grant_row FROM public.downtown_u_credit_transactions AS t
  WHERE t.purchase_id=purchase.id AND t.transaction_type='purchase_grant';
  IF grant_row.student_id IS DISTINCT FROM purchase.student_id
    OR grant_row.delta IS DISTINCT FROM purchase.credits_granted
    OR grant_row.ledger_sequence IS NULL OR grant_row.ledger_sequence <= 0
    OR grant_row.resulting_balance IS DISTINCT FROM (SELECT COALESCE(sum(t.delta),0)::INTEGER
      FROM public.downtown_u_credit_transactions AS t WHERE t.student_id=grant_row.student_id
        AND t.ledger_sequence <= grant_row.ledger_sequence)
    OR grant_row.transaction_type IS DISTINCT FROM 'purchase_grant'
    OR grant_row.reason IS DISTINCT FROM 'verified Square payment'
    OR grant_row.idempotency_key IS DISTINCT FROM 'purchase_grant:'||purchase.square_payment_id
    OR grant_row.actor_type IS DISTINCT FROM 'square_webhook'
    OR grant_row.actor_id IS DISTINCT FROM purchase.source_event_id
    OR grant_row.source_type IS DISTINCT FROM 'square_payment'
    OR grant_row.source_id IS DISTINCT FROM purchase.square_payment_id
    OR grant_row.metadata IS DISTINCT FROM pg_catalog.jsonb_build_object(
      'currency',purchase.currency,'locationId',requested_location_id) THEN
    RAISE EXCEPTION 'Downtown U refund activation rejected';
  END IF;

  -- A new event may build only on a completely canonical immutable refund
  -- history. Validate every predecessor, not just the mutable purchase cache.
  expected_sequence := 0;
  expected_cumulative := 0;
  prior_applied_credits := 0;
  expected_ledger_count := 0;
  expected_reconciliation_count := 0;
  expected_refunded_at := NULL;
  FOR prior_application IN
    SELECT r.* FROM public.downtown_u_refund_applications AS r
    WHERE r.purchase_id=purchase.id ORDER BY r.refund_sequence
  LOOP
    expected_sequence := expected_sequence+1;
    expected_cumulative := expected_cumulative+prior_application.authoritative_amount_cents;
    IF expected_cumulative>purchase.price_cents THEN
      RAISE EXCEPTION 'Downtown U refund activation rejected';
    END IF;
    expected_target := CASE WHEN expected_cumulative=purchase.price_cents
      THEN purchase.credits_granted
      ELSE (expected_cumulative*purchase.credits_granted/purchase.price_cents)::INTEGER END;
    expected_delta := expected_target-prior_applied_credits;
    IF prior_application.refund_sequence IS DISTINCT FROM expected_sequence
      OR prior_application.cumulative_refunded_cents IS DISTINCT FROM expected_cumulative::INTEGER
      OR prior_application.target_refunded_credits IS DISTINCT FROM expected_target
      OR prior_application.credit_delta IS DISTINCT FROM expected_delta OR expected_delta<0
      OR prior_application.student_id IS DISTINCT FROM purchase.student_id
      OR prior_application.square_payment_id IS DISTINCT FROM purchase.square_payment_id
      OR (prior_application.square_order_id IS NOT NULL
        AND prior_application.square_order_id IS DISTINCT FROM purchase.square_order_id) THEN
      RAISE EXCEPTION 'Downtown U refund activation rejected';
    END IF;

    SELECT count(*) INTO collision_count
    FROM public.downtown_u_credit_transactions AS t
    WHERE t.idempotency_key='purchase_refund:'||prior_application.square_refund_id
      OR (t.source_type='square_refund' AND t.source_id=prior_application.square_refund_id)
      OR (t.transaction_type='purchase_refund' AND t.source_id=prior_application.square_refund_id);

    IF prior_application.status='applied' THEN
      IF prior_application.available_credits_before<expected_delta
        OR prior_application.applied_at IS DISTINCT FROM
          prior_application.authoritative_updated_at::TIMESTAMPTZ THEN
        RAISE EXCEPTION 'Downtown U refund activation rejected';
      END IF;
      SELECT count(*) INTO topology_count
      FROM public.downtown_u_refund_reconciliations AS q
      WHERE q.refund_application_id=prior_application.id;
      IF topology_count<>0 THEN RAISE EXCEPTION 'Downtown U refund activation rejected'; END IF;
      IF expected_delta>0 THEN
        expected_ledger_count := expected_ledger_count+1;
        expected_refunded_at := prior_application.authoritative_updated_at::TIMESTAMPTZ;
        IF collision_count<>1 THEN RAISE EXCEPTION 'Downtown U refund activation rejected'; END IF;
        SELECT count(*) INTO topology_count
        FROM public.downtown_u_credit_transactions AS t
        WHERE t.transaction_type='purchase_refund'
          AND t.purchase_id=purchase.id AND t.student_id=purchase.student_id
          AND t.redemption_id IS NULL
          AND t.ledger_sequence>0
          AND t.resulting_balance=(SELECT COALESCE(sum(chain.delta),0)::INTEGER
            FROM public.downtown_u_credit_transactions AS chain
            WHERE chain.student_id=t.student_id AND chain.ledger_sequence<=t.ledger_sequence)
          AND t.delta=-expected_delta
          AND t.resulting_balance=prior_application.available_credits_before-expected_delta
          AND t.reason='verified Square refund'
          AND t.idempotency_key='purchase_refund:'||prior_application.square_refund_id
          AND t.actor_type='square_webhook' AND t.actor_id=prior_application.source_event_id
          AND t.source_type='square_refund' AND t.source_id=prior_application.square_refund_id
          AND t.metadata=pg_catalog.jsonb_build_object(
            'amountCents',prior_application.authoritative_amount_cents,
            'currency',prior_application.authoritative_currency);
        IF topology_count<>1 THEN RAISE EXCEPTION 'Downtown U refund activation rejected'; END IF;
      ELSIF collision_count<>0 THEN
        RAISE EXCEPTION 'Downtown U refund activation rejected';
      END IF;
      prior_applied_credits := prior_applied_credits+expected_delta;
    ELSIF prior_application.status='reconciliation_required' THEN
      IF expected_delta=0 OR prior_application.available_credits_before>=expected_delta
        OR prior_application.applied_at IS NOT NULL OR collision_count<>0 THEN
        RAISE EXCEPTION 'Downtown U refund activation rejected';
      END IF;
      expected_reconciliation_count := expected_reconciliation_count+1;
      SELECT count(*) INTO topology_count
      FROM public.downtown_u_refund_reconciliations AS q
      WHERE q.refund_application_id=prior_application.id
        AND q.purchase_id=purchase.id AND q.student_id=purchase.student_id
        AND q.reason_code='insufficient_available_credits'
        AND q.required_credits=expected_delta
        AND q.available_credits=prior_application.available_credits_before
        AND q.available_credits<q.required_credits AND q.status='open';
      IF topology_count<>1 THEN RAISE EXCEPTION 'Downtown U refund activation rejected'; END IF;
    ELSE
      RAISE EXCEPTION 'Downtown U refund activation rejected';
    END IF;
  END LOOP;

  SELECT count(*) INTO topology_count
  FROM public.downtown_u_credit_transactions AS t
  WHERE t.purchase_id=purchase.id AND t.transaction_type='purchase_refund';
  IF topology_count<>expected_ledger_count THEN
    RAISE EXCEPTION 'Downtown U refund activation rejected';
  END IF;
  SELECT count(*) INTO topology_count
  FROM public.downtown_u_refund_reconciliations AS q WHERE q.purchase_id=purchase.id;
  IF topology_count<>expected_reconciliation_count THEN
    RAISE EXCEPTION 'Downtown U refund activation rejected';
  END IF;
  expected_purchase_status := CASE WHEN prior_applied_credits=0 THEN 'paid'
    WHEN prior_applied_credits=purchase.credits_granted THEN 'refunded'
    ELSE 'partially_refunded' END;
  IF purchase.refunded_credits IS DISTINCT FROM prior_applied_credits
    OR purchase.status IS DISTINCT FROM expected_purchase_status
    OR purchase.refunded_at IS DISTINCT FROM expected_refunded_at THEN
    RAISE EXCEPTION 'Downtown U refund activation rejected';
  END IF;

  -- The payment advisory lock serializes assignment of this immutable,
  -- gap-free purchase-local sequence.
  PERFORM 1 FROM public.downtown_u_refund_applications AS r
  WHERE r.purchase_id=purchase.id ORDER BY r.refund_sequence FOR UPDATE;
  SELECT COALESCE(max(r.refund_sequence),0)+1,
         COALESCE(sum(r.authoritative_amount_cents),0)+requested_amount_cents
    INTO next_refund_sequence,cumulative_cents
  FROM public.downtown_u_refund_applications AS r WHERE r.purchase_id=purchase.id;
  IF cumulative_cents > purchase.price_cents THEN RAISE EXCEPTION 'Downtown U refund activation rejected'; END IF;
  IF cumulative_cents = purchase.price_cents THEN
    target_credits := purchase.credits_granted;
  ELSE
    target_credits := (cumulative_cents * purchase.credits_granted / purchase.price_cents)::INTEGER;
  END IF;
  IF target_credits > purchase.credits_granted OR target_credits < purchase.refunded_credits THEN
    RAISE EXCEPTION 'Downtown U refund activation rejected';
  END IF;
  delta_credits := target_credits - purchase.refunded_credits;
  SELECT s.credit_balance INTO available_credits FROM public.downtown_u_students AS s
  WHERE s.id=purchase.student_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Downtown U refund activation rejected'; END IF;

  -- Reserve both canonical identities before recording any application, including
  -- zero-credit and reconciliation outcomes which intentionally create no ledger row.
  SELECT count(*) INTO collision_count FROM public.downtown_u_credit_transactions AS t
  WHERE t.idempotency_key='purchase_refund:'||requested_refund_id
    OR (t.source_type='square_refund' AND t.source_id=requested_refund_id)
    OR (t.transaction_type='purchase_refund' AND t.source_id=requested_refund_id);
  IF collision_count <> 0 THEN RAISE EXCEPTION 'Downtown U refund activation rejected'; END IF;

  IF delta_credits > available_credits THEN
    INSERT INTO public.downtown_u_refund_applications
      (square_refund_id,source_event_id,square_payment_id,square_order_id,purchase_id,student_id,
       authoritative_amount_cents,authoritative_currency,authoritative_location_id,
       authoritative_updated_at,refund_sequence,cumulative_refunded_cents,target_refunded_credits,
       credit_delta,available_credits_before,status)
    VALUES (requested_refund_id,requested_event_id,requested_payment_id,requested_order_id,
      purchase.id,purchase.student_id,requested_amount_cents,requested_currency,requested_location_id,
      requested_updated_at,next_refund_sequence,cumulative_cents::INTEGER,target_credits,
      delta_credits,available_credits,'reconciliation_required')
    RETURNING * INTO application;
    INSERT INTO public.downtown_u_refund_reconciliations
      (refund_application_id,purchase_id,student_id,reason_code,required_credits,available_credits)
    VALUES (application.id,purchase.id,purchase.student_id,'insufficient_available_credits',
      delta_credits,available_credits);
    outcome := 'reconciliation_required';
  ELSE
    INSERT INTO public.downtown_u_refund_applications
      (square_refund_id,source_event_id,square_payment_id,square_order_id,purchase_id,student_id,
       authoritative_amount_cents,authoritative_currency,authoritative_location_id,
       authoritative_updated_at,refund_sequence,cumulative_refunded_cents,target_refunded_credits,
       credit_delta,available_credits_before,status,applied_at)
    VALUES (requested_refund_id,requested_event_id,requested_payment_id,requested_order_id,
      purchase.id,purchase.student_id,requested_amount_cents,requested_currency,requested_location_id,
      requested_updated_at,next_refund_sequence,cumulative_cents::INTEGER,target_credits,
      delta_credits,available_credits,'applied',parsed_updated_at)
    RETURNING * INTO application;
    IF delta_credits > 0 THEN
      INSERT INTO public.downtown_u_credit_transactions
        (student_id,purchase_id,delta,resulting_balance,transaction_type,reason,idempotency_key,
         actor_type,actor_id,source_type,source_id,metadata)
      VALUES (purchase.student_id,purchase.id,-delta_credits,available_credits-delta_credits,
        'purchase_refund','verified Square refund','purchase_refund:'||requested_refund_id,
        'square_webhook',requested_event_id,'square_refund',requested_refund_id,
        pg_catalog.jsonb_build_object('amountCents',requested_amount_cents,'currency',requested_currency));
      next_status := CASE WHEN target_credits=purchase.credits_granted THEN 'refunded' ELSE 'partially_refunded' END;
      UPDATE public.downtown_u_plan_purchases AS p SET refunded_credits=target_credits,
        status=next_status,refunded_at=parsed_updated_at,updated_at=pg_catalog.clock_timestamp()
      WHERE p.id=purchase.id;
    END IF;
    outcome := 'applied';
  END IF;

  UPDATE public.downtown_u_webhook_events AS e SET status='completed',
    completed_at=pg_catalog.clock_timestamp(),claim_token=NULL,updated_at=pg_catalog.clock_timestamp()
  WHERE e.square_event_id=requested_event_id AND e.status='processing'
    AND e.claim_token=requested_claim_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'Downtown U refund activation rejected'; END IF;
  RETURN NEXT;
END
$function$;

REVOKE UPDATE (status,refunded_credits,refunded_at,updated_at)
  ON public.downtown_u_plan_purchases FROM downtown_u_runtime;
REVOKE ALL ON FUNCTION public.downtown_u_activate_verified_refund(
  TEXT,UUID,TEXT,TEXT,TEXT,TEXT,INTEGER,TEXT,TEXT,TEXT
) FROM PUBLIC, downtown_u_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_activate_verified_refund(
  TEXT,UUID,TEXT,TEXT,TEXT,TEXT,INTEGER,TEXT,TEXT,TEXT
) TO downtown_u_runtime;

COMMIT;
