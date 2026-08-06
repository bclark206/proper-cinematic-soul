BEGIN;

CREATE TABLE public.downtown_u_checkout_attempts (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{16,45}$'),
  plan_id TEXT NOT NULL REFERENCES public.downtown_u_plans(id),
  normalized_email TEXT CHECK (normalized_email IS NULL OR (normalized_email=pg_catalog.lower(pg_catalog.btrim(normalized_email)) AND pg_catalog.length(normalized_email) BETWEEN 3 AND 254)),
  request_actor BYTEA CHECK (request_actor IS NULL OR pg_catalog.octet_length(request_actor)=32),
  state TEXT NOT NULL DEFAULT 'started' CHECK (state IN ('started','order_created','payment_created','paid','activated','operator_review','failed')),
  square_order_id TEXT UNIQUE CHECK (square_order_id IS NULL OR square_order_id ~ '^[A-Za-z0-9_-]{1,192}$'),
  square_payment_id TEXT UNIQUE CHECK (square_payment_id IS NULL OR square_payment_id ~ '^[A-Za-z0-9_-]{1,192}$'),
  purchase_id UUID UNIQUE REFERENCES public.downtown_u_plan_purchases(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  redacted_at TIMESTAMPTZ,
  CHECK ((state='started' AND square_order_id IS NULL AND square_payment_id IS NULL)
    OR (state='order_created' AND square_order_id IS NOT NULL AND square_payment_id IS NULL)
    OR (state IN ('payment_created','paid','activated') AND square_order_id IS NOT NULL AND square_payment_id IS NOT NULL)
    OR state IN ('operator_review','failed')),
  CHECK ((state='activated')=(purchase_id IS NOT NULL)),
  CHECK ((redacted_at IS NULL AND normalized_email IS NOT NULL AND request_actor IS NOT NULL)
    OR (redacted_at IS NOT NULL AND normalized_email IS NULL AND request_actor IS NULL))
);
CREATE INDEX downtown_u_checkout_email_rate_idx ON public.downtown_u_checkout_attempts(normalized_email,created_at);
CREATE INDEX downtown_u_checkout_actor_rate_idx ON public.downtown_u_checkout_attempts(request_actor,created_at);
CREATE INDEX downtown_u_checkout_created_idx ON public.downtown_u_checkout_attempts(created_at);
CREATE INDEX downtown_u_checkout_retention_idx ON public.downtown_u_checkout_attempts(created_at)
  WHERE state IN ('activated','operator_review','failed');

CREATE FUNCTION public.downtown_u_checkout_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
DECLARE allowed BOOLEAN:=false;
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'checkout attempts are immutable'; END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
   OR NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
   OR (OLD.square_order_id IS NOT NULL AND NEW.square_order_id IS DISTINCT FROM OLD.square_order_id)
   OR (OLD.square_payment_id IS NOT NULL AND NEW.square_payment_id IS DISTINCT FROM OLD.square_payment_id)
   OR (OLD.purchase_id IS NOT NULL AND NEW.purchase_id IS DISTINCT FROM OLD.purchase_id) THEN RAISE EXCEPTION 'checkout attempt identity is immutable'; END IF;
 IF NEW.normalized_email IS DISTINCT FROM OLD.normalized_email
   OR NEW.request_actor IS DISTINCT FROM OLD.request_actor
   OR NEW.redacted_at IS DISTINCT FROM OLD.redacted_at THEN
   IF NOT (OLD.redacted_at IS NULL AND OLD.normalized_email IS NOT NULL AND OLD.request_actor IS NOT NULL
     AND NEW.normalized_email IS NULL AND NEW.request_actor IS NULL AND NEW.redacted_at IS NOT NULL
     AND ((OLD.state IN ('activated','operator_review','failed') AND NEW.state=OLD.state)
       OR (OLD.state IN ('started','order_created','payment_created','paid') AND NEW.state='operator_review'))
     AND OLD.created_at < pg_catalog.clock_timestamp()-interval '90 days'
     AND pg_catalog.current_setting('downtown_u.checkout_anonymize',true)
       = pg_catalog.pg_backend_pid()::text||':'||pg_catalog.pg_current_xact_id()::text)
     THEN RAISE EXCEPTION 'checkout attempt identity is immutable'; END IF;
 END IF;
 allowed := (OLD.state,NEW.state) IN (('started','order_created'),('started','operator_review'),('started','failed'),
   ('order_created','payment_created'),('order_created','operator_review'),('order_created','failed'),
   ('payment_created','paid'),('payment_created','activated'),('payment_created','operator_review'),('payment_created','failed'),
   ('operator_review','activated'),('operator_review','failed'),
   ('paid','activated'),('paid','operator_review'),('failed','operator_review')) OR OLD.state=NEW.state;
 IF NOT allowed THEN RAISE EXCEPTION 'invalid checkout transition'; END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER downtown_u_checkout_immutable BEFORE UPDATE OR DELETE ON public.downtown_u_checkout_attempts FOR EACH ROW EXECUTE FUNCTION public.downtown_u_checkout_guard();
CREATE TRIGGER downtown_u_checkout_no_truncate BEFORE TRUNCATE ON public.downtown_u_checkout_attempts FOR EACH STATEMENT EXECUTE FUNCTION public.downtown_u_checkout_guard();

/* Migration 009 will introduce the operator role. Until then this bounded,
 * owner-only capability is the sole supported retention path. It preserves the
 * checkout/provider/purchase/state audit and removes only email and actor PII. */
CREATE FUNCTION public.downtown_u_checkout_anonymize(requested_limit INTEGER)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE affected INTEGER; now_at TIMESTAMPTZ:=pg_catalog.clock_timestamp();
BEGIN
 IF requested_limit IS NULL OR requested_limit<1 OR requested_limit>500 THEN
   RAISE EXCEPTION 'invalid checkout anonymization limit';
 END IF;
 PERFORM pg_catalog.set_config('downtown_u.checkout_anonymize',
   pg_catalog.pg_backend_pid()::text||':'||pg_catalog.pg_current_xact_id()::text,true);
 WITH eligible AS (
   SELECT id FROM public.downtown_u_checkout_attempts
   WHERE redacted_at IS NULL AND created_at < now_at-interval '90 days'
   ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT requested_limit
 )
 UPDATE public.downtown_u_checkout_attempts x
 SET state=CASE WHEN x.state IN ('started','order_created','payment_created','paid') THEN 'operator_review' ELSE x.state END,
     normalized_email=NULL,request_actor=NULL,redacted_at=now_at,updated_at=now_at
 FROM eligible WHERE x.id=eligible.id;
 GET DIAGNOSTICS affected=ROW_COUNT;
 PERFORM pg_catalog.set_config('downtown_u.checkout_anonymize','',true);
 RETURN affected;
END $f$;

CREATE FUNCTION public.downtown_u_checkout_begin(requested_key TEXT,requested_plan TEXT,requested_email TEXT,requested_actor BYTEA)
RETURNS SETOF public.downtown_u_checkout_attempts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE existing public.downtown_u_checkout_attempts%ROWTYPE; now_at TIMESTAMPTZ;
BEGIN
 IF requested_key IS NULL OR requested_key!~'^[A-Za-z0-9_-]{16,45}$' OR requested_email IS NULL
   OR requested_email<>pg_catalog.lower(pg_catalog.btrim(requested_email)) OR pg_catalog.length(requested_email) NOT BETWEEN 3 AND 254
   OR requested_actor IS NULL OR pg_catalog.octet_length(requested_actor)<>32 THEN RAISE EXCEPTION 'invalid checkout'; END IF;
 /* Every admission takes the same lock classes in the same order. The global
  * lock makes all three rolling limits exact across serverless instances. */
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(requested_key,0));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(requested_email,1));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.encode(requested_actor,'hex'),2));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('downtown-u-checkout-global',3));
 SELECT * INTO existing FROM public.downtown_u_checkout_attempts WHERE idempotency_key=requested_key;
 IF FOUND THEN
   IF existing.plan_id IS DISTINCT FROM requested_plan OR existing.normalized_email IS DISTINCT FROM requested_email
      OR existing.request_actor IS DISTINCT FROM requested_actor
      THEN RAISE EXCEPTION USING ERRCODE='DU409',MESSAGE='checkout conflict'; END IF;
   RETURN NEXT existing; RETURN;
 END IF;
 now_at:=pg_catalog.clock_timestamp();
 IF (SELECT count(*) FROM public.downtown_u_checkout_attempts WHERE normalized_email=requested_email AND created_at>now_at-interval '15 minutes')>=5
   OR (SELECT count(*) FROM public.downtown_u_checkout_attempts WHERE request_actor=requested_actor AND created_at>now_at-interval '15 minutes')>=10
   OR (SELECT count(*) FROM public.downtown_u_checkout_attempts WHERE created_at>now_at-interval '5 minutes')>=200
   THEN RAISE EXCEPTION USING ERRCODE='DU429',MESSAGE='checkout rate limited'; END IF;
 INSERT INTO public.downtown_u_checkout_attempts(idempotency_key,plan_id,normalized_email,request_actor,created_at,updated_at)
 VALUES(requested_key,requested_plan,requested_email,requested_actor,now_at,now_at) RETURNING * INTO existing;
 RETURN NEXT existing;
END $f$;

CREATE FUNCTION public.downtown_u_checkout_record(requested_id UUID,requested_kind TEXT,requested_square_id TEXT)
RETURNS SETOF public.downtown_u_checkout_attempts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE x public.downtown_u_checkout_attempts%ROWTYPE; linked_purchase UUID; exact_purchase BOOLEAN:=false;
BEGIN
 IF requested_square_id IS NULL OR requested_square_id!~'^[A-Za-z0-9_-]{1,192}$' OR requested_kind NOT IN ('order','payment') THEN RAISE EXCEPTION 'invalid checkout'; END IF;
 SELECT * INTO x FROM public.downtown_u_checkout_attempts WHERE id=requested_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'checkout unavailable'; END IF;
 IF requested_kind='order' THEN
   IF x.square_order_id=requested_square_id THEN RETURN NEXT x; RETURN; END IF;
   IF x.state<>'started' OR x.square_order_id IS NOT NULL
     THEN RAISE EXCEPTION USING ERRCODE='DU409',MESSAGE='checkout conflict'; END IF;
   UPDATE public.downtown_u_checkout_attempts SET square_order_id=requested_square_id,state='order_created',updated_at=pg_catalog.clock_timestamp() WHERE id=x.id RETURNING * INTO x;
 ELSE
   IF x.square_payment_id=requested_square_id THEN RETURN NEXT x; RETURN; END IF;
   IF x.state<>'order_created' OR x.square_order_id IS NULL OR x.square_payment_id IS NOT NULL
     THEN RAISE EXCEPTION USING ERRCODE='DU409',MESSAGE='checkout conflict'; END IF;
   UPDATE public.downtown_u_checkout_attempts SET square_payment_id=requested_square_id,state='payment_created',updated_at=pg_catalog.clock_timestamp() WHERE id=x.id RETURNING * INTO x;
   /* A verified webhook can commit between Square's response and this durable
    * ID write. Reconcile that ordering without another provider call. */
   SELECT p.id,
     p.square_order_id=x.square_order_id AND p.square_payment_id=x.square_payment_id
       AND p.plan_id=x.plan_id AND s.normalized_email=x.normalized_email
   INTO linked_purchase,exact_purchase
   FROM public.downtown_u_plan_purchases p JOIN public.downtown_u_students s ON s.id=p.student_id
   WHERE p.square_order_id=x.square_order_id OR p.square_payment_id=x.square_payment_id
   ORDER BY (p.square_order_id=x.square_order_id AND p.square_payment_id=x.square_payment_id
     AND p.plan_id=x.plan_id AND s.normalized_email=x.normalized_email) DESC LIMIT 1;
   IF linked_purchase IS NOT NULL THEN
     IF exact_purchase THEN
       UPDATE public.downtown_u_checkout_attempts SET state='activated',purchase_id=linked_purchase,updated_at=pg_catalog.clock_timestamp() WHERE id=x.id RETURNING * INTO x;
     ELSE
       UPDATE public.downtown_u_checkout_attempts SET state='operator_review',updated_at=pg_catalog.clock_timestamp() WHERE id=x.id RETURNING * INTO x;
     END IF;
   END IF;
 END IF;
 RETURN NEXT x;
END $f$;

CREATE FUNCTION public.downtown_u_checkout_transition(requested_id UUID,requested_state TEXT)
RETURNS SETOF public.downtown_u_checkout_attempts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE x public.downtown_u_checkout_attempts%ROWTYPE; linked_purchase UUID; related_purchase BOOLEAN:=false;
BEGIN
 IF requested_state NOT IN ('paid','operator_review','failed') THEN RAISE EXCEPTION 'invalid checkout'; END IF;
 SELECT * INTO x FROM public.downtown_u_checkout_attempts WHERE id=requested_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'checkout unavailable'; END IF;
 IF x.state='activated' THEN RETURN NEXT x; RETURN; END IF;
 IF requested_state='paid' THEN
   IF x.state NOT IN ('payment_created','paid') THEN
     RAISE EXCEPTION USING ERRCODE='DU409',MESSAGE='checkout conflict';
   END IF;
   SELECT p.id INTO linked_purchase FROM public.downtown_u_plan_purchases p
   JOIN public.downtown_u_students s ON s.id=p.student_id
   WHERE p.square_order_id=x.square_order_id AND p.square_payment_id=x.square_payment_id
     AND p.plan_id=x.plan_id AND s.normalized_email=x.normalized_email;
   SELECT EXISTS(SELECT 1 FROM public.downtown_u_plan_purchases p
     WHERE p.square_order_id=x.square_order_id OR p.square_payment_id=x.square_payment_id) INTO related_purchase;
 END IF;
 IF linked_purchase IS NOT NULL THEN
   RETURN QUERY UPDATE public.downtown_u_checkout_attempts SET state='activated',purchase_id=linked_purchase,updated_at=pg_catalog.clock_timestamp()
   WHERE id=requested_id RETURNING *; RETURN;
 END IF;
 IF requested_state='paid' AND related_purchase THEN requested_state:='operator_review'; END IF;
 RETURN QUERY UPDATE public.downtown_u_checkout_attempts SET state=requested_state,updated_at=pg_catalog.clock_timestamp()
 WHERE id=requested_id RETURNING *;
END $f$;

CREATE FUNCTION public.downtown_u_checkout_status(requested_id UUID) RETURNS TABLE(state TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 RETURN QUERY SELECT x.state FROM public.downtown_u_checkout_attempts x WHERE x.id=requested_id;
END $f$;

CREATE FUNCTION public.downtown_u_checkout_activate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 /* Checkout correlation never blocks the authoritative purchase/grant. Exact
  * identities link once; a one-ID/economics/contact collision stays review. */
 UPDATE public.downtown_u_checkout_attempts x SET
   state=CASE WHEN x.square_order_id=NEW.square_order_id AND x.square_payment_id=NEW.square_payment_id
     AND x.plan_id=NEW.plan_id AND x.normalized_email=s.normalized_email THEN 'activated' ELSE 'operator_review' END,
   purchase_id=CASE WHEN x.square_order_id=NEW.square_order_id AND x.square_payment_id=NEW.square_payment_id
     AND x.plan_id=NEW.plan_id AND x.normalized_email=s.normalized_email THEN NEW.id ELSE NULL END,
   updated_at=pg_catalog.clock_timestamp()
 FROM public.downtown_u_students s WHERE s.id=NEW.student_id
   AND x.square_payment_id IS NOT NULL
   AND (x.square_order_id=NEW.square_order_id OR x.square_payment_id=NEW.square_payment_id)
   AND x.state IN ('order_created','payment_created','paid','operator_review','failed');
 RETURN NEW;
END $f$;
CREATE TRIGGER downtown_u_checkout_purchase_link AFTER INSERT OR UPDATE ON public.downtown_u_plan_purchases FOR EACH ROW EXECUTE FUNCTION public.downtown_u_checkout_activate();

REVOKE ALL ON public.downtown_u_checkout_attempts FROM PUBLIC,downtown_u_runtime;
REVOKE ALL ON FUNCTION public.downtown_u_checkout_guard(),public.downtown_u_checkout_activate(),
 public.downtown_u_checkout_anonymize(INTEGER),
 public.downtown_u_checkout_begin(TEXT,TEXT,TEXT,BYTEA),public.downtown_u_checkout_record(UUID,TEXT,TEXT),
 public.downtown_u_checkout_transition(UUID,TEXT),public.downtown_u_checkout_status(UUID) FROM PUBLIC,downtown_u_runtime;
REVOKE ALL ON FUNCTION public.downtown_u_checkout_anonymize(INTEGER) FROM PUBLIC,downtown_u_runtime,downtown_u_jobs;
GRANT EXECUTE ON FUNCTION public.downtown_u_checkout_begin(TEXT,TEXT,TEXT,BYTEA),public.downtown_u_checkout_record(UUID,TEXT,TEXT),
 public.downtown_u_checkout_transition(UUID,TEXT),public.downtown_u_checkout_status(UUID) TO downtown_u_runtime;

COMMIT;
