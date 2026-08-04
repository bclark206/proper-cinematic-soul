BEGIN;

-- PostgreSQL 16 provides gen_random_uuid() in core; no extension install (and no
-- extension-owner privilege) is required.
DO $role$
BEGIN
  CREATE ROLE downtown_u_runtime NOLOGIN;
EXCEPTION
  WHEN duplicate_object THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname = 'downtown_u_runtime' AND NOT rolcanlogin
        AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
        AND NOT rolreplication AND NOT rolbypassrls
    ) THEN
      RAISE EXCEPTION 'Existing downtown_u_runtime role is not the required least-privilege NOLOGIN role';
    END IF;
END
$role$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM downtown_u_runtime;
GRANT USAGE ON SCHEMA public TO downtown_u_runtime;

CREATE TABLE public.downtown_u_plans (
  id TEXT PRIMARY KEY,
  credits INTEGER NOT NULL CHECK (credits > 0),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  CHECK ((id, credits, price_cents) IN (
    ('flex-5', 5, 6000),
    ('scholar-10', 10, 11000),
    ('resident-20', 20, 21000),
    ('semester-40', 40, 40000)
  ))
);

INSERT INTO public.downtown_u_plans (id, credits, price_cents) VALUES
  ('flex-5', 5, 6000),
  ('scholar-10', 10, 11000),
  ('resident-20', 20, 21000),
  ('semester-40', 40, 40000);
CREATE UNIQUE INDEX downtown_u_plans_economics_key ON public.downtown_u_plans (id, credits, price_cents);

CREATE FUNCTION public.downtown_u_protect_plan_economics() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Downtown U canonical plan economics are immutable';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.credits IS DISTINCT FROM OLD.credits
    OR NEW.price_cents IS DISTINCT FROM OLD.price_cents THEN
    RAISE EXCEPTION 'Downtown U canonical plan economics are immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER downtown_u_plans_protect_economics
BEFORE UPDATE OR DELETE ON public.downtown_u_plans
FOR EACH ROW EXECUTE FUNCTION public.downtown_u_protect_plan_economics();

CREATE TABLE public.downtown_u_students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_email TEXT UNIQUE,
  normalized_phone TEXT UNIQUE,
  square_customer_id TEXT UNIQUE,
  eligibility_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (eligibility_status IN ('pending', 'approved', 'rejected', 'suspended')),
  credit_balance INTEGER NOT NULL DEFAULT 0 CHECK (credit_balance >= 0),
  eligibility_reviewed_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  suspended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CHECK (normalized_email IS NOT NULL OR normalized_phone IS NOT NULL),
  CHECK (normalized_email IS NULL OR (normalized_email = lower(btrim(normalized_email))
    AND length(normalized_email) <= 254
    AND normalized_email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')),
  CHECK (normalized_phone IS NULL OR normalized_phone ~ '^[+][1-9][0-9]{7,14}$'),
  CHECK (approved_at IS NULL OR eligibility_status IN ('approved', 'suspended')),
  CHECK (rejected_at IS NULL OR eligibility_status = 'rejected'),
  CHECK (suspended_at IS NULL OR eligibility_status = 'suspended')
);

CREATE TABLE public.downtown_u_plan_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.downtown_u_students(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL REFERENCES public.downtown_u_plans(id) ON DELETE RESTRICT,
  credits_granted INTEGER NOT NULL CHECK (credits_granted > 0),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  square_payment_id TEXT NOT NULL UNIQUE CHECK (length(btrim(square_payment_id)) > 0),
  square_order_id TEXT NOT NULL UNIQUE CHECK (length(btrim(square_order_id)) > 0),
  source_event_id TEXT NOT NULL UNIQUE CHECK (length(btrim(source_event_id)) > 0),
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'partially_refunded', 'refunded')),
  refunded_credits INTEGER NOT NULL DEFAULT 0 CHECK (refunded_credits >= 0 AND refunded_credits <= credits_granted),
  paid_at TIMESTAMPTZ NOT NULL,
  refunded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, student_id),
  FOREIGN KEY (plan_id, credits_granted, price_cents) REFERENCES public.downtown_u_plans(id, credits, price_cents),
  CHECK ((status = 'paid' AND refunded_credits = 0 AND refunded_at IS NULL)
      OR (status = 'partially_refunded' AND refunded_credits > 0 AND refunded_credits < credits_granted AND refunded_at IS NOT NULL)
      OR (status = 'refunded' AND refunded_credits = credits_granted AND refunded_at IS NOT NULL))
);

CREATE TABLE public.downtown_u_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.downtown_u_students(id) ON DELETE RESTRICT,
  credits INTEGER NOT NULL CHECK (credits > 0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(btrim(idempotency_key)) > 0),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'redeemed', 'reversed', 'cancelled')),
  square_order_id TEXT UNIQUE,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  redeemed_at TIMESTAMPTZ,
  reversed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, student_id),
  CHECK ((status = 'reserved' AND redeemed_at IS NULL AND reversed_at IS NULL)
      OR (status = 'redeemed' AND redeemed_at IS NOT NULL AND square_order_id IS NOT NULL AND reversed_at IS NULL)
      OR (status = 'reversed' AND reversed_at IS NOT NULL)
      OR status = 'cancelled')
);

CREATE TABLE public.downtown_u_credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.downtown_u_students(id) ON DELETE RESTRICT,
  purchase_id UUID,
  redemption_id UUID,
  delta INTEGER NOT NULL CHECK (delta <> 0),
  resulting_balance INTEGER NOT NULL CHECK (resulting_balance >= 0),
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('purchase_grant', 'purchase_refund', 'reservation', 'redemption_reversal')),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(btrim(idempotency_key)) > 0),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('student', 'square_webhook', 'order_service', 'system')),
  actor_id TEXT NOT NULL CHECK (length(btrim(actor_id)) > 0),
  source_type TEXT NOT NULL CHECK (length(btrim(source_type)) > 0),
  source_id TEXT NOT NULL CHECK (length(btrim(source_id)) > 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((transaction_type IN ('purchase_grant', 'redemption_reversal') AND delta > 0)
      OR (transaction_type IN ('purchase_refund', 'reservation') AND delta < 0)),
  CHECK ((transaction_type IN ('purchase_grant', 'purchase_refund')) = (purchase_id IS NOT NULL)),
  CHECK ((transaction_type IN ('reservation', 'redemption_reversal')) = (redemption_id IS NOT NULL)),
  FOREIGN KEY (purchase_id, student_id) REFERENCES public.downtown_u_plan_purchases(id, student_id) ON DELETE RESTRICT,
  FOREIGN KEY (redemption_id, student_id) REFERENCES public.downtown_u_redemptions(id, student_id) ON DELETE RESTRICT,
  UNIQUE (source_type, source_id)
);

CREATE INDEX downtown_u_credit_transactions_student_created_idx
  ON public.downtown_u_credit_transactions (student_id, created_at, id);
CREATE INDEX downtown_u_plan_purchases_student_idx ON public.downtown_u_plan_purchases (student_id, created_at);
CREATE INDEX downtown_u_redemptions_student_idx ON public.downtown_u_redemptions (student_id, created_at);
CREATE UNIQUE INDEX downtown_u_credit_transactions_one_purchase_grant
  ON public.downtown_u_credit_transactions (purchase_id, transaction_type)
  WHERE transaction_type = 'purchase_grant';
CREATE UNIQUE INDEX downtown_u_credit_transactions_one_reservation
  ON public.downtown_u_credit_transactions (redemption_id, transaction_type)
  WHERE transaction_type = 'reservation';
CREATE UNIQUE INDEX downtown_u_credit_transactions_one_reversal
  ON public.downtown_u_credit_transactions (redemption_id, transaction_type)
  WHERE transaction_type = 'redemption_reversal';
CREATE INDEX downtown_u_credit_transactions_purchase_type_idx
  ON public.downtown_u_credit_transactions (purchase_id, transaction_type)
  WHERE purchase_id IS NOT NULL;
CREATE INDEX downtown_u_credit_transactions_redemption_type_idx
  ON public.downtown_u_credit_transactions (redemption_id, transaction_type)
  WHERE redemption_id IS NOT NULL;

-- A private, transaction-scoped capability lets only the ledger trigger update
-- the cached balance. It is never granted to the runtime role.
CREATE TABLE public.downtown_u_balance_update_authorizations (
  backend_pid INTEGER NOT NULL,
  transaction_id BIGINT NOT NULL,
  student_id UUID NOT NULL,
  new_balance INTEGER NOT NULL,
  PRIMARY KEY (backend_pid, transaction_id, student_id)
);
REVOKE ALL ON public.downtown_u_balance_update_authorizations FROM PUBLIC;
REVOKE ALL ON public.downtown_u_balance_update_authorizations FROM downtown_u_runtime;

CREATE FUNCTION public.downtown_u_apply_credit_transaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  current_balance INTEGER;
  referenced_credits INTEGER;
  refunded_credits INTEGER;
  reservation_count INTEGER;
BEGIN
  SELECT s.credit_balance INTO current_balance
  FROM public.downtown_u_students AS s WHERE s.id = NEW.student_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Downtown U student not found'; END IF;

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
      -- Student then redemption row locks are taken in the same order for both
      -- reservations and reversals, so a concurrent pair cannot race this check.
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

CREATE TRIGGER downtown_u_apply_credit_transaction_trigger
BEFORE INSERT ON public.downtown_u_credit_transactions
FOR EACH ROW EXECUTE FUNCTION public.downtown_u_apply_credit_transaction();

CREATE FUNCTION public.downtown_u_reject_direct_balance_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE authorized BOOLEAN;
BEGIN
  DELETE FROM public.downtown_u_balance_update_authorizations
  WHERE backend_pid = pg_backend_pid() AND transaction_id = txid_current()
    AND student_id = NEW.id AND new_balance = NEW.credit_balance
  RETURNING TRUE INTO authorized;
  IF authorized IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Downtown U balance may only change through the credit ledger';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER downtown_u_students_ledger_balance_only
BEFORE UPDATE OF credit_balance ON public.downtown_u_students
FOR EACH ROW WHEN (OLD.credit_balance IS DISTINCT FROM NEW.credit_balance)
EXECUTE FUNCTION public.downtown_u_reject_direct_balance_update();

CREATE FUNCTION public.downtown_u_protect_purchase_fields() RETURNS trigger
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
    OR NEW.paid_at IS DISTINCT FROM OLD.paid_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
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

CREATE TRIGGER downtown_u_plan_purchases_protect_fields
BEFORE UPDATE ON public.downtown_u_plan_purchases
FOR EACH ROW EXECUTE FUNCTION public.downtown_u_protect_purchase_fields();

CREATE FUNCTION public.downtown_u_protect_redemption_fields() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
DECLARE reservation_count INTEGER; reversal_count INTEGER;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.student_id IS DISTINCT FROM OLD.student_id
    OR NEW.credits IS DISTINCT FROM OLD.credits OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Downtown U redemption economics and ownership are immutable';
  END IF;
  IF OLD.status <> NEW.status AND NOT (
    (OLD.status = 'reserved' AND NEW.status IN ('redeemed', 'reversed', 'cancelled'))
    OR (OLD.status = 'redeemed' AND NEW.status = 'reversed')
  ) THEN
    RAISE EXCEPTION 'Downtown U invalid redemption state transition';
  END IF;
  IF NEW.status <> 'reserved' THEN
    SELECT count(*) FILTER (WHERE t.transaction_type = 'reservation'),
           count(*) FILTER (WHERE t.transaction_type = 'redemption_reversal')
      INTO reservation_count, reversal_count
    FROM public.downtown_u_credit_transactions AS t WHERE t.redemption_id = OLD.id;
    IF reservation_count <> 1 OR (NEW.status = 'reversed' AND reversal_count <> 1) THEN
      RAISE EXCEPTION 'Downtown U redemption state must be backed by the immutable ledger';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER downtown_u_redemptions_protect_fields
BEFORE UPDATE ON public.downtown_u_redemptions
FOR EACH ROW EXECUTE FUNCTION public.downtown_u_protect_redemption_fields();

CREATE FUNCTION public.downtown_u_reject_credit_transaction_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'downtown_u_credit_transactions is append-only';
END
$function$;

CREATE TRIGGER downtown_u_credit_transactions_immutable
BEFORE UPDATE OR DELETE ON public.downtown_u_credit_transactions
FOR EACH ROW EXECUTE FUNCTION public.downtown_u_reject_credit_transaction_mutation();
CREATE TRIGGER downtown_u_credit_transactions_no_truncate
BEFORE TRUNCATE ON public.downtown_u_credit_transactions
FOR EACH STATEMENT EXECUTE FUNCTION public.downtown_u_reject_credit_transaction_mutation();

-- Trigger invocation does not require callers to have direct function EXECUTE.
-- Revoke every trigger function so it cannot be called or attached by runtime.
REVOKE ALL ON FUNCTION public.downtown_u_apply_credit_transaction() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.downtown_u_reject_direct_balance_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.downtown_u_protect_plan_economics() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.downtown_u_protect_purchase_fields() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.downtown_u_protect_redemption_fields() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.downtown_u_reject_credit_transaction_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.downtown_u_apply_credit_transaction() FROM downtown_u_runtime;
REVOKE ALL ON FUNCTION public.downtown_u_reject_direct_balance_update() FROM downtown_u_runtime;
REVOKE ALL ON FUNCTION public.downtown_u_protect_plan_economics() FROM downtown_u_runtime;
REVOKE ALL ON FUNCTION public.downtown_u_protect_purchase_fields() FROM downtown_u_runtime;
REVOKE ALL ON FUNCTION public.downtown_u_protect_redemption_fields() FROM downtown_u_runtime;
REVOKE ALL ON FUNCTION public.downtown_u_reject_credit_transaction_mutation() FROM downtown_u_runtime;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM downtown_u_runtime;
GRANT SELECT ON public.downtown_u_plans TO downtown_u_runtime;
GRANT SELECT ON public.downtown_u_students TO downtown_u_runtime;
GRANT INSERT (normalized_email, normalized_phone, square_customer_id)
  ON public.downtown_u_students TO downtown_u_runtime;
GRANT UPDATE (normalized_email, normalized_phone, square_customer_id, updated_at)
  ON public.downtown_u_students TO downtown_u_runtime;
GRANT SELECT, INSERT ON public.downtown_u_plan_purchases TO downtown_u_runtime;
GRANT UPDATE (status, refunded_credits, refunded_at, updated_at)
  ON public.downtown_u_plan_purchases TO downtown_u_runtime;
GRANT SELECT, INSERT ON public.downtown_u_redemptions TO downtown_u_runtime;
GRANT UPDATE (status, square_order_id, redeemed_at, reversed_at, expires_at, updated_at)
  ON public.downtown_u_redemptions TO downtown_u_runtime;
GRANT SELECT, INSERT ON public.downtown_u_credit_transactions TO downtown_u_runtime;

COMMIT;
