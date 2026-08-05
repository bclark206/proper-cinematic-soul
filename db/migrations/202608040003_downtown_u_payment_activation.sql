BEGIN;

-- Phase one intentionally required email or phone. A3 activation accepts the
-- equally authoritative Square customer identity, while retaining the exact
-- known constraint name so an unexpected predecessor schema fails closed.
ALTER TABLE public.downtown_u_students
  DROP CONSTRAINT downtown_u_students_check;
ALTER TABLE public.downtown_u_students
  ADD CONSTRAINT downtown_u_students_check
  CHECK (normalized_email IS NOT NULL OR normalized_phone IS NOT NULL OR square_customer_id IS NOT NULL);
ALTER TABLE public.downtown_u_students
  ADD CONSTRAINT downtown_u_students_square_customer_id_format
  CHECK (square_customer_id IS NULL OR (
    length(square_customer_id) BETWEEN 1 AND 192
    AND square_customer_id ~ '^[A-Za-z0-9_-]+$'
  ));

ALTER TABLE public.downtown_u_plan_purchases
  ADD COLUMN authoritative_paid_at TEXT;
ALTER TABLE public.downtown_u_plan_purchases
  ADD COLUMN authoritative_normalized_email TEXT,
  ADD COLUMN authoritative_normalized_phone TEXT,
  ADD COLUMN authoritative_square_customer_id TEXT;
ALTER TABLE public.downtown_u_plan_purchases
  ADD CONSTRAINT downtown_u_plan_purchases_authoritative_paid_at_format
  CHECK (authoritative_paid_at IS NULL OR (
    length(authoritative_paid_at) BETWEEN 20 AND 35
    AND authoritative_paid_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$'
  ));
ALTER TABLE public.downtown_u_plan_purchases
  ADD CONSTRAINT downtown_u_plan_purchases_authoritative_email_format
  CHECK (authoritative_normalized_email IS NULL OR (
    authoritative_normalized_email = lower(btrim(authoritative_normalized_email))
    AND length(authoritative_normalized_email) <= 254
    AND authoritative_normalized_email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  )),
  ADD CONSTRAINT downtown_u_plan_purchases_authoritative_phone_format
  CHECK (authoritative_normalized_phone IS NULL
    OR authoritative_normalized_phone ~ '^[+][1-9][0-9]{7,14}$'),
  ADD CONSTRAINT downtown_u_plan_purchases_authoritative_customer_format
  CHECK (authoritative_square_customer_id IS NULL OR (
    length(authoritative_square_customer_id) BETWEEN 1 AND 192
    AND authoritative_square_customer_id ~ '^[A-Za-z0-9_-]+$'
  ));

CREATE OR REPLACE FUNCTION public.downtown_u_protect_purchase_fields() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
DECLARE ledger_refunded INTEGER;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.student_id IS DISTINCT FROM OLD.student_id
    OR NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.credits_granted IS DISTINCT FROM OLD.credits_granted
    OR NEW.price_cents IS DISTINCT FROM OLD.price_cents OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.square_payment_id IS DISTINCT FROM OLD.square_payment_id
    OR NEW.square_order_id IS DISTINCT FROM OLD.square_order_id
    OR NEW.source_event_id IS DISTINCT FROM OLD.source_event_id
    OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
    OR NEW.authoritative_paid_at IS DISTINCT FROM OLD.authoritative_paid_at
    OR NEW.authoritative_normalized_email IS DISTINCT FROM OLD.authoritative_normalized_email
    OR NEW.authoritative_normalized_phone IS DISTINCT FROM OLD.authoritative_normalized_phone
    OR NEW.authoritative_square_customer_id IS DISTINCT FROM OLD.authoritative_square_customer_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Downtown U purchase economics and ownership are immutable';
  END IF;
  IF NEW.refunded_credits < OLD.refunded_credits OR (OLD.status = 'refunded' AND NEW.status <> 'refunded') THEN
    RAISE EXCEPTION 'Downtown U purchase refund state cannot move backwards';
  END IF;
  SELECT COALESCE(-sum(t.delta), 0) INTO ledger_refunded
  FROM public.downtown_u_credit_transactions AS t
  WHERE t.purchase_id = OLD.id AND t.transaction_type = 'purchase_refund';
  IF NEW.refunded_credits <> ledger_refunded THEN
    RAISE EXCEPTION 'Downtown U purchase refund state must equal the immutable ledger';
  END IF;
  RETURN NEW;
END
$function$;

-- Permanent processor dispositions are terminal. Replace the known phase-two
-- constraints exactly so an unexpected predecessor schema fails closed.
ALTER TABLE public.downtown_u_webhook_events
  DROP CONSTRAINT downtown_u_webhook_events_status_check;
ALTER TABLE public.downtown_u_webhook_events
  DROP CONSTRAINT downtown_u_webhook_events_check;
ALTER TABLE public.downtown_u_webhook_events
  ADD CONSTRAINT downtown_u_webhook_events_status_check
  CHECK (status IN ('new', 'processing', 'completed', 'failed', 'rejected')),
  ADD CONSTRAINT downtown_u_webhook_events_check CHECK (
    (status = 'new' AND attempt_count = 0 AND started_at IS NULL AND completed_at IS NULL AND failed_at IS NULL AND failure_code IS NULL AND failure_detail IS NULL AND claim_token IS NULL)
    OR (status = 'processing' AND attempt_count BETWEEN 1 AND 1000 AND started_at IS NOT NULL AND completed_at IS NULL AND failed_at IS NULL AND failure_code IS NULL AND failure_detail IS NULL AND claim_token IS NOT NULL)
    OR (status = 'completed' AND attempt_count BETWEEN 1 AND 1000 AND started_at IS NOT NULL AND completed_at IS NOT NULL AND failed_at IS NULL AND failure_code IS NULL AND failure_detail IS NULL AND claim_token IS NULL)
    OR (status IN ('failed', 'rejected') AND attempt_count BETWEEN 1 AND 1000 AND started_at IS NOT NULL AND completed_at IS NULL AND failed_at IS NOT NULL AND failure_code IS NOT NULL AND failure_detail IS NOT NULL AND claim_token IS NULL)
  );

CREATE OR REPLACE FUNCTION public.downtown_u_webhook_events_protect() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.square_event_id IS DISTINCT FROM OLD.square_event_id
    OR NEW.event_type IS DISTINCT FROM OLD.event_type
    OR NEW.raw_body_sha256 IS DISTINCT FROM OLD.raw_body_sha256
    OR NEW.received_at IS DISTINCT FROM OLD.received_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Downtown U webhook event identity is immutable';
  END IF;
  IF NOT (
    (OLD.status = 'new' AND NEW.status = 'processing' AND OLD.attempt_count = 0 AND NEW.attempt_count = 1)
    OR (OLD.status = 'processing' AND NEW.status IN ('completed', 'failed', 'rejected') AND NEW.attempt_count = OLD.attempt_count)
    OR (OLD.status = 'processing' AND NEW.status = 'processing'
        AND NEW.attempt_count = OLD.attempt_count + 1
        AND NEW.claim_token IS DISTINCT FROM OLD.claim_token)
    OR (OLD.status = 'failed' AND NEW.status = 'processing' AND NEW.attempt_count = OLD.attempt_count + 1)
  ) THEN
    RAISE EXCEPTION 'Invalid Downtown U webhook event state transition';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.downtown_u_claim_webhook_event(
  requested_event_id TEXT, requested_event_type TEXT, requested_body_hash TEXT
) RETURNS TABLE(outcome TEXT, claim_token UUID, attempt_count INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  existing public.downtown_u_webhook_events%ROWTYPE;
  inserted_id TEXT;
  next_token UUID;
BEGIN
  IF requested_event_id IS NULL OR requested_event_id !~ '^[A-Za-z0-9_-]{1,128}$'
    OR requested_event_type IS NULL OR length(requested_event_type) > 128 OR requested_event_type !~ '^[a-z][a-z0-9_-]*([.][a-z][a-z0-9_-]*)+$'
    OR requested_body_hash IS NULL OR requested_body_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid webhook event claim fields' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.downtown_u_webhook_events
    (square_event_id, event_type, raw_body_sha256, status, attempt_count, received_at)
  VALUES (requested_event_id, requested_event_type, requested_body_hash, 'new', 0, pg_catalog.clock_timestamp())
  ON CONFLICT (square_event_id) DO NOTHING RETURNING square_event_id INTO inserted_id;
  IF inserted_id IS NOT NULL THEN
    next_token := pg_catalog.gen_random_uuid();
    UPDATE public.downtown_u_webhook_events AS e
    SET status='processing', attempt_count=1, started_at=pg_catalog.clock_timestamp(),
        claim_token=next_token, updated_at=pg_catalog.clock_timestamp()
    WHERE e.square_event_id=requested_event_id;
    RETURN QUERY SELECT 'claimed'::TEXT, next_token, 1;
    RETURN;
  END IF;
  SELECT e.* INTO existing FROM public.downtown_u_webhook_events AS e
  WHERE e.square_event_id=requested_event_id FOR UPDATE;
  IF existing.event_type IS DISTINCT FROM requested_event_type OR existing.raw_body_sha256 IS DISTINCT FROM requested_body_hash THEN
    RETURN QUERY SELECT 'conflict'::TEXT, NULL::UUID, existing.attempt_count;
  ELSIF existing.status = 'processing'
      AND existing.started_at <= pg_catalog.clock_timestamp() - INTERVAL '5 minutes'
      AND existing.attempt_count >= 1000 THEN
    RETURN QUERY SELECT 'exhausted'::TEXT, NULL::UUID, existing.attempt_count;
  ELSIF existing.status = 'processing'
      AND existing.started_at <= pg_catalog.clock_timestamp() - INTERVAL '5 minutes' THEN
    next_token := pg_catalog.gen_random_uuid();
    UPDATE public.downtown_u_webhook_events AS e
    SET attempt_count=e.attempt_count+1, started_at=pg_catalog.clock_timestamp(),
        claim_token=next_token, updated_at=pg_catalog.clock_timestamp()
    WHERE e.square_event_id=requested_event_id;
    RETURN QUERY SELECT 'claimed'::TEXT, next_token, existing.attempt_count + 1;
  ELSIF existing.status = 'processing' THEN
    RETURN QUERY SELECT 'in_progress'::TEXT, NULL::UUID, existing.attempt_count;
  ELSIF existing.status IN ('completed', 'rejected') THEN
    RETURN QUERY SELECT 'duplicate'::TEXT, NULL::UUID, existing.attempt_count;
  ELSIF existing.status = 'failed' AND existing.attempt_count >= 1000 THEN
    RETURN QUERY SELECT 'exhausted'::TEXT, NULL::UUID, existing.attempt_count;
  ELSIF existing.status = 'failed' THEN
    next_token := pg_catalog.gen_random_uuid();
    UPDATE public.downtown_u_webhook_events AS e
    SET status='processing', attempt_count=e.attempt_count+1, started_at=pg_catalog.clock_timestamp(),
        failed_at=NULL, failure_code=NULL, failure_detail=NULL, claim_token=next_token,
        updated_at=pg_catalog.clock_timestamp()
    WHERE e.square_event_id=requested_event_id;
    RETURN QUERY SELECT 'claimed'::TEXT, next_token, existing.attempt_count + 1;
  ELSE
    RAISE EXCEPTION 'Invalid persisted webhook event state';
  END IF;
END
$function$;

CREATE FUNCTION public.downtown_u_reject_webhook_event(
  requested_event_id TEXT, requested_claim_token UUID, requested_failure_code TEXT, requested_failure_detail TEXT
) RETURNS TABLE(transitioned BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  IF requested_event_id IS NULL OR requested_event_id !~ '^[A-Za-z0-9_-]{1,128}$'
    OR requested_claim_token IS NULL THEN
    RAISE EXCEPTION 'Invalid webhook rejection identity' USING ERRCODE='22023';
  END IF;
  IF requested_failure_code IS NULL OR requested_failure_code !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'Invalid webhook failure code' USING ERRCODE='22023';
  END IF;
  IF requested_failure_detail IS NULL OR length(requested_failure_detail) NOT BETWEEN 1 AND 256 OR requested_failure_detail !~ '^[ -~]+$' THEN
    RAISE EXCEPTION 'Invalid webhook failure detail' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH changed AS (
    UPDATE public.downtown_u_webhook_events AS e
    SET status='rejected', failed_at=pg_catalog.clock_timestamp(), failure_code=requested_failure_code,
        failure_detail=requested_failure_detail, claim_token=NULL, updated_at=pg_catalog.clock_timestamp()
    WHERE e.square_event_id=requested_event_id AND e.status='processing'
      AND e.claim_token=requested_claim_token
    RETURNING 1
  ) SELECT EXISTS(SELECT 1 FROM changed);
END
$function$;

REVOKE ALL ON FUNCTION public.downtown_u_reject_webhook_event(TEXT,UUID,TEXT,TEXT) FROM PUBLIC, downtown_u_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_reject_webhook_event(TEXT,UUID,TEXT,TEXT) TO downtown_u_runtime;

-- The ledger trigger remains SECURITY DEFINER for Phase-one reservations,
-- reversals, and refunds. This invoker-rights gate runs first and makes a
-- purchase grant possible only while DML is executing inside a trusted
-- SECURITY DEFINER routine. A runtime session cannot spoof CURRENT_USER.
CREATE FUNCTION public.downtown_u_require_trusted_purchase_grant() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.transaction_type = 'purchase_grant' AND CURRENT_USER IS DISTINCT FROM
    pg_catalog.pg_get_userbyid((SELECT p.proowner FROM pg_catalog.pg_proc AS p
      WHERE p.oid = 'public.downtown_u_require_trusted_purchase_grant()'::pg_catalog.regprocedure)) THEN
    RAISE EXCEPTION 'Downtown U payment activation rejected';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER downtown_u_00_purchase_grant_gate
BEFORE INSERT ON public.downtown_u_credit_transactions
FOR EACH ROW EXECUTE FUNCTION public.downtown_u_require_trusted_purchase_grant();
-- Alphabetical trigger order is significant: the gate precedes the
-- balance-changing downtown_u_apply_credit_transaction_trigger.
REVOKE ALL ON FUNCTION public.downtown_u_require_trusted_purchase_grant() FROM PUBLIC, downtown_u_runtime;

-- Every runtime writer of student identity enters this one lock namespace.
-- Prefixes, hash seed zero, and lexical ordering are deliberately identical to
-- activation so partially-overlapping identities cannot race into two rows.
CREATE FUNCTION public.downtown_u_upsert_pending_student(
  requested_normalized_email TEXT,
  requested_normalized_phone TEXT,
  requested_square_customer_id TEXT
) RETURNS TABLE(
  id UUID,
  normalized_email TEXT,
  normalized_phone TEXT,
  square_customer_id TEXT,
  eligibility_status TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  matched public.downtown_u_students%ROWTYPE;
  student_count INTEGER;
BEGIN
  IF (requested_normalized_email IS NULL AND requested_normalized_phone IS NULL
      AND requested_square_customer_id IS NULL)
    OR (requested_normalized_email IS NOT NULL AND (
      requested_normalized_email <> pg_catalog.lower(pg_catalog.btrim(requested_normalized_email))
      OR length(requested_normalized_email) > 254
      OR requested_normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'))
    OR (requested_normalized_phone IS NOT NULL
      AND requested_normalized_phone !~ '^[+][1-9][0-9]{7,14}$')
    OR (requested_square_customer_id IS NOT NULL
      AND requested_square_customer_id !~ '^[A-Za-z0-9_-]{1,192}$') THEN
    RAISE EXCEPTION 'Downtown U student identity conflict' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(keys.identity, 0))
  FROM pg_catalog.unnest(ARRAY[
    CASE WHEN requested_normalized_email IS NOT NULL THEN 'email:' || requested_normalized_email END,
    CASE WHEN requested_normalized_phone IS NOT NULL THEN 'phone:' || requested_normalized_phone END,
    CASE WHEN requested_square_customer_id IS NOT NULL THEN 'customer:' || requested_square_customer_id END
  ]::TEXT[]) AS keys(identity)
  WHERE keys.identity IS NOT NULL ORDER BY keys.identity;

  SELECT count(*) INTO student_count
  FROM public.downtown_u_students AS s
  WHERE (requested_normalized_email IS NOT NULL AND s.normalized_email = requested_normalized_email)
     OR (requested_normalized_phone IS NOT NULL AND s.normalized_phone = requested_normalized_phone)
     OR (requested_square_customer_id IS NOT NULL AND s.square_customer_id = requested_square_customer_id);
  IF student_count > 1 THEN
    RAISE EXCEPTION 'Downtown U student identity conflict';
  END IF;

  IF student_count = 1 THEN
    SELECT s.* INTO matched FROM public.downtown_u_students AS s
    WHERE (requested_normalized_email IS NOT NULL AND s.normalized_email = requested_normalized_email)
       OR (requested_normalized_phone IS NOT NULL AND s.normalized_phone = requested_normalized_phone)
       OR (requested_square_customer_id IS NOT NULL AND s.square_customer_id = requested_square_customer_id)
    FOR UPDATE;
    IF (matched.normalized_email IS NOT NULL AND requested_normalized_email IS NOT NULL
        AND matched.normalized_email <> requested_normalized_email)
      OR (matched.normalized_phone IS NOT NULL AND requested_normalized_phone IS NOT NULL
        AND matched.normalized_phone <> requested_normalized_phone)
      OR (matched.square_customer_id IS NOT NULL AND requested_square_customer_id IS NOT NULL
        AND matched.square_customer_id <> requested_square_customer_id) THEN
      RAISE EXCEPTION 'Downtown U student identity conflict';
    END IF;
    UPDATE public.downtown_u_students AS s SET
      normalized_email = COALESCE(s.normalized_email, requested_normalized_email),
      normalized_phone = COALESCE(s.normalized_phone, requested_normalized_phone),
      square_customer_id = COALESCE(s.square_customer_id, requested_square_customer_id),
      updated_at = pg_catalog.now()
    WHERE s.id = matched.id RETURNING s.* INTO matched;
  ELSE
    INSERT INTO public.downtown_u_students
      (normalized_email, normalized_phone, square_customer_id)
    VALUES (requested_normalized_email, requested_normalized_phone, requested_square_customer_id)
    RETURNING * INTO matched;
  END IF;

  RETURN QUERY SELECT matched.id, matched.normalized_email, matched.normalized_phone,
    matched.square_customer_id, matched.eligibility_status;
END
$function$;
REVOKE ALL ON FUNCTION public.downtown_u_upsert_pending_student(TEXT,TEXT,TEXT)
  FROM PUBLIC, downtown_u_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_upsert_pending_student(TEXT,TEXT,TEXT)
  TO downtown_u_runtime;

-- This is the sole A3 activation authority. It takes only bounded values
-- produced by the Square validation boundary; it stores no webhook document.
-- The token-owned webhook row is locked before any local write, all external
-- identities are serialized deterministically, and completion commits in the
-- same transaction as student/purchase/ledger creation.
CREATE FUNCTION public.downtown_u_activate_verified_payment(
  requested_event_id TEXT,
  requested_claim_token UUID,
  requested_resource_id TEXT,
  requested_payment_id TEXT,
  requested_order_id TEXT,
  requested_plan_id TEXT,
  requested_credits INTEGER,
  requested_price_cents INTEGER,
  requested_currency TEXT,
  requested_location_id TEXT,
  requested_paid_at TEXT,
  requested_normalized_email TEXT,
  requested_normalized_phone TEXT,
  requested_square_customer_id TEXT
) RETURNS TABLE(outcome TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  purchase public.downtown_u_plan_purchases%ROWTYPE;
  matched_student public.downtown_u_students%ROWTYPE;
  grant_row public.downtown_u_credit_transactions%ROWTYPE;
  purchase_count INTEGER;
  grant_count INTEGER;
  current_balance INTEGER;
  parsed_paid_at TIMESTAMPTZ;
  matched_student_id UUID;
BEGIN
  -- Syntax and canonical economics are intentionally repeated here rather
  -- than trusted to application validation or mutable table contents.
  IF requested_event_id IS NULL OR requested_event_id !~ '^[A-Za-z0-9_-]{1,128}$'
    OR requested_claim_token IS NULL
    OR requested_resource_id IS NULL OR requested_resource_id !~ '^[A-Za-z0-9_-]{1,192}$'
    OR requested_payment_id IS NULL OR requested_payment_id !~ '^[A-Za-z0-9_-]{1,192}$'
    OR requested_order_id IS NULL OR requested_order_id !~ '^[A-Za-z0-9_-]{1,192}$'
    OR requested_location_id IS NULL OR requested_location_id !~ '^[A-Za-z0-9_-]{1,192}$'
    OR requested_resource_id IS DISTINCT FROM requested_payment_id
    OR requested_payment_id = requested_order_id
    OR requested_currency IS DISTINCT FROM 'USD'
    OR (requested_plan_id, requested_credits, requested_price_cents) NOT IN (
      ('flex-5', 5, 6000), ('scholar-10', 10, 11000),
      ('resident-20', 20, 21000), ('semester-40', 40, 40000)
    )
    OR requested_paid_at IS NULL OR length(requested_paid_at) NOT BETWEEN 20 AND 35
    OR requested_paid_at !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$'
    OR (requested_normalized_email IS NULL AND requested_normalized_phone IS NULL
        AND requested_square_customer_id IS NULL)
    OR (requested_normalized_email IS NOT NULL AND (
      requested_normalized_email <> pg_catalog.lower(pg_catalog.btrim(requested_normalized_email))
      OR length(requested_normalized_email) > 254
      OR requested_normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'))
    OR (requested_normalized_phone IS NOT NULL
      AND requested_normalized_phone !~ '^[+][1-9][0-9]{7,14}$')
    OR (requested_square_customer_id IS NOT NULL
      AND requested_square_customer_id !~ '^[A-Za-z0-9_-]{1,192}$') THEN
    RAISE EXCEPTION 'Downtown U payment activation rejected';
  END IF;

  BEGIN
    parsed_paid_at := requested_paid_at::TIMESTAMPTZ;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Downtown U payment activation rejected';
  END;

  PERFORM 1 FROM public.downtown_u_webhook_events AS e
  WHERE e.square_event_id = requested_event_id
    AND e.event_type = 'payment.updated' AND e.status = 'processing'
    AND e.claim_token = requested_claim_token
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Downtown U payment activation rejected'; END IF;

  -- Purchase identities have a separate deterministic lock set. Student
  -- identities are acquired below by downtown_u_upsert_pending_student.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(keys.identity, 0))
  FROM pg_catalog.unnest(ARRAY[
    'event:' || requested_event_id, 'payment:' || requested_payment_id,
    'order:' || requested_order_id
  ]::TEXT[]) AS keys(identity)
  WHERE keys.identity IS NOT NULL ORDER BY keys.identity;

  SELECT count(*) INTO purchase_count
  FROM public.downtown_u_plan_purchases AS p
  WHERE p.square_payment_id = requested_payment_id
     OR p.square_order_id = requested_order_id
     OR p.source_event_id = requested_event_id;
  IF purchase_count > 1 THEN RAISE EXCEPTION 'Downtown U payment activation rejected'; END IF;

  IF purchase_count = 1 THEN
    SELECT p.* INTO purchase FROM public.downtown_u_plan_purchases AS p
    WHERE p.square_payment_id = requested_payment_id
       OR p.square_order_id = requested_order_id
       OR p.source_event_id = requested_event_id FOR UPDATE;
    IF purchase.plan_id IS DISTINCT FROM requested_plan_id
      OR purchase.credits_granted IS DISTINCT FROM requested_credits
      OR purchase.price_cents IS DISTINCT FROM requested_price_cents
      OR purchase.currency IS DISTINCT FROM requested_currency
      OR purchase.square_payment_id IS DISTINCT FROM requested_payment_id
      OR purchase.square_order_id IS DISTINCT FROM requested_order_id
      OR purchase.source_event_id IS DISTINCT FROM requested_event_id
      OR purchase.authoritative_paid_at IS DISTINCT FROM requested_paid_at
      OR purchase.authoritative_normalized_email IS DISTINCT FROM requested_normalized_email
      OR purchase.authoritative_normalized_phone IS DISTINCT FROM requested_normalized_phone
      OR purchase.authoritative_square_customer_id IS DISTINCT FROM requested_square_customer_id
      OR purchase.status IS DISTINCT FROM 'paid' OR purchase.refunded_credits <> 0 THEN
      RAISE EXCEPTION 'Downtown U payment activation rejected';
    END IF;
    SELECT count(*) INTO grant_count FROM public.downtown_u_credit_transactions AS t
    WHERE t.purchase_id = purchase.id AND t.transaction_type = 'purchase_grant';
    IF grant_count <> 1 THEN RAISE EXCEPTION 'Downtown U payment activation rejected'; END IF;
    SELECT t.* INTO grant_row FROM public.downtown_u_credit_transactions AS t
    WHERE t.purchase_id = purchase.id AND t.transaction_type = 'purchase_grant';
    IF grant_row.student_id IS DISTINCT FROM purchase.student_id
      OR grant_row.delta IS DISTINCT FROM requested_credits
      OR grant_row.transaction_type IS DISTINCT FROM 'purchase_grant'
      OR grant_row.reason IS DISTINCT FROM 'verified Square payment'
      OR grant_row.idempotency_key IS DISTINCT FROM 'purchase_grant:' || requested_payment_id
      OR grant_row.actor_type IS DISTINCT FROM 'square_webhook'
      OR grant_row.actor_id IS DISTINCT FROM requested_event_id
      OR grant_row.source_type IS DISTINCT FROM 'square_payment'
      OR grant_row.source_id IS DISTINCT FROM requested_payment_id
      OR grant_row.metadata IS DISTINCT FROM pg_catalog.jsonb_build_object(
        'currency', requested_currency, 'locationId', requested_location_id) THEN
      RAISE EXCEPTION 'Downtown U payment activation rejected';
    END IF;
    UPDATE public.downtown_u_webhook_events AS e SET
      status='completed', completed_at=pg_catalog.clock_timestamp(), claim_token=NULL,
      updated_at=pg_catalog.clock_timestamp()
    WHERE e.square_event_id=requested_event_id AND e.status='processing'
      AND e.claim_token=requested_claim_token;
    IF NOT FOUND THEN RAISE EXCEPTION 'Downtown U payment activation rejected'; END IF;
    RETURN QUERY SELECT 'duplicate'::TEXT;
    RETURN;
  END IF;

  SELECT u.id INTO matched_student_id
  FROM public.downtown_u_upsert_pending_student(
    requested_normalized_email, requested_normalized_phone, requested_square_customer_id
  ) AS u;
  SELECT s.* INTO matched_student FROM public.downtown_u_students AS s
  WHERE s.id = matched_student_id;

  INSERT INTO public.downtown_u_plan_purchases
    (student_id,plan_id,credits_granted,price_cents,currency,square_payment_id,
     square_order_id,source_event_id,paid_at,authoritative_paid_at,
     authoritative_normalized_email,authoritative_normalized_phone,
     authoritative_square_customer_id)
  VALUES (matched_student.id,requested_plan_id,requested_credits,requested_price_cents,
    requested_currency,requested_payment_id,requested_order_id,requested_event_id,
    parsed_paid_at,requested_paid_at,requested_normalized_email,
    requested_normalized_phone,requested_square_customer_id)
  RETURNING * INTO purchase;

  SELECT s.credit_balance INTO current_balance FROM public.downtown_u_students AS s
  WHERE s.id=matched_student.id FOR UPDATE;
  INSERT INTO public.downtown_u_credit_transactions
    (student_id,purchase_id,delta,resulting_balance,transaction_type,reason,
     idempotency_key,actor_type,actor_id,source_type,source_id,metadata)
  VALUES (matched_student.id,purchase.id,requested_credits,current_balance+requested_credits,
    'purchase_grant','verified Square payment','purchase_grant:'||requested_payment_id,
    'square_webhook',requested_event_id,'square_payment',requested_payment_id,
    pg_catalog.jsonb_build_object('currency',requested_currency,'locationId',requested_location_id));

  UPDATE public.downtown_u_webhook_events AS e SET
    status='completed', completed_at=pg_catalog.clock_timestamp(), claim_token=NULL,
    updated_at=pg_catalog.clock_timestamp()
  WHERE e.square_event_id=requested_event_id AND e.status='processing'
    AND e.claim_token=requested_claim_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'Downtown U payment activation rejected'; END IF;
  RETURN QUERY SELECT 'activated'::TEXT;
END
$function$;

-- Runtime can read purchases for Phase-one refund/idempotency workflows, but it
-- can no longer manufacture either half of a paid purchase. Non-grant ledger
-- inserts remain available for the original redemption/refund workflows.
REVOKE INSERT ON public.downtown_u_plan_purchases FROM downtown_u_runtime;
REVOKE INSERT (student_id, plan_id, credits_granted, price_cents, currency,
  square_payment_id, square_order_id, source_event_id, paid_at,
  authoritative_paid_at, authoritative_normalized_email,
  authoritative_normalized_phone, authoritative_square_customer_id)
  ON public.downtown_u_plan_purchases FROM downtown_u_runtime;
REVOKE INSERT (normalized_email, normalized_phone, square_customer_id)
  ON public.downtown_u_students FROM downtown_u_runtime;
REVOKE UPDATE (normalized_email, normalized_phone, square_customer_id, updated_at)
  ON public.downtown_u_students FROM downtown_u_runtime;
REVOKE ALL ON FUNCTION public.downtown_u_activate_verified_payment(
  TEXT,UUID,TEXT,TEXT,TEXT,TEXT,INTEGER,INTEGER,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT
) FROM PUBLIC, downtown_u_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_activate_verified_payment(
  TEXT,UUID,TEXT,TEXT,TEXT,TEXT,INTEGER,INTEGER,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT
) TO downtown_u_runtime;

COMMIT;
