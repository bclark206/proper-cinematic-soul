BEGIN;

DO $role$
BEGIN
  CREATE ROLE downtown_u_kitchen_jobs NOLOGIN;
EXCEPTION WHEN duplicate_object THEN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='downtown_u_kitchen_jobs'
    AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'Existing downtown_u_kitchen_jobs role is unsafe';
  END IF;
END $role$;
REVOKE ALL ON SCHEMA public FROM downtown_u_kitchen_jobs;
GRANT USAGE ON SCHEMA public TO downtown_u_kitchen_jobs;

/* Owner-controlled singleton. Disabling stops claims, never enqueue durability. */
CREATE TABLE public.downtown_u_kitchen_config (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  location_id TEXT NOT NULL DEFAULT 'LPPWSSV03BHK8' CHECK (location_id='LPPWSSV03BHK8'),
  enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
INSERT INTO public.downtown_u_kitchen_config(singleton) VALUES(true);

CREATE TABLE public.downtown_u_kitchen_order_outbox (
  redemption_id UUID PRIMARY KEY REFERENCES public.downtown_u_redemptions(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('pending','leased','created','cancel_pending','cancelled','operator_review')),
  lease_action TEXT CHECK (lease_action IS NULL OR lease_action IN ('create','cancel')),
  location_id TEXT NOT NULL CHECK (location_id='LPPWSSV03BHK8'),
  reference_id TEXT NOT NULL UNIQUE CHECK (reference_id ~ '^[0-9a-f-]{36}$'),
  create_idempotency_key TEXT NOT NULL UNIQUE CHECK (create_idempotency_key ~ '^du-create-[0-9a-f-]{36}$'),
  cancel_idempotency_key TEXT NOT NULL UNIQUE CHECK (cancel_idempotency_key ~ '^du-cancel-[0-9a-f-]{36}$'),
  meal_name TEXT NOT NULL CHECK (length(btrim(meal_name)) BETWEEN 1 AND 120 AND meal_name !~ '[[:cntrl:]]'),
  meal_catalog_object_id TEXT NOT NULL CHECK (length(meal_catalog_object_id) BETWEEN 1 AND 192 AND meal_catalog_object_id !~ '[[:space:][:cntrl:]]'),
  modifiers JSONB NOT NULL CHECK (public.downtown_u_valid_modifier_snapshot(modifiers)),
  square_order_id TEXT UNIQUE CHECK (square_order_id IS NULL OR square_order_id ~ '^[A-Za-z0-9_-]{1,192}$'),
  square_order_version BIGINT CHECK (square_order_version IS NULL OR square_order_version>=0),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 12),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,48}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  provider_created_at TIMESTAMPTZ,
  provider_cancelled_at TIMESTAMPTZ,
  CHECK ((lease_token IS NULL)=(lease_expires_at IS NULL)
    AND (lease_token IS NULL)=(lease_action IS NULL)),
  CHECK (lease_token IS NULL OR state IN ('leased','cancel_pending')),
  CHECK (state<>'leased' OR (lease_token IS NOT NULL AND lease_action='create')),
  CHECK (state NOT IN ('pending','created','cancelled','operator_review') OR (lease_token IS NULL AND lease_action IS NULL)),
  /* A historical redeemed identity can lack an unknowable provider version, but
   * partial identity is never accepted on an actionable row. */
  CHECK ((square_order_id IS NULL AND square_order_version IS NULL)
    OR (square_order_id IS NOT NULL AND (square_order_version IS NOT NULL OR state='operator_review'))),
  CHECK (provider_created_at IS NULL OR square_order_id IS NOT NULL),
  CHECK (state<>'created' OR (square_order_id IS NOT NULL AND provider_created_at IS NOT NULL)),
  CHECK (state<>'cancelled' OR lease_token IS NULL)
);
CREATE INDEX downtown_u_kitchen_claim_idx ON public.downtown_u_kitchen_order_outbox(next_attempt_at,created_at,redemption_id)
  WHERE state IN ('pending','leased','cancel_pending');
CREATE INDEX downtown_u_kitchen_lease_idx ON public.downtown_u_kitchen_order_outbox(lease_expires_at)
  WHERE lease_token IS NOT NULL;

CREATE FUNCTION public.downtown_u_kitchen_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'kitchen outbox audit is immutable'; END IF;
  IF pg_catalog.current_setting('downtown_u.kitchen_write',true) IS DISTINCT FROM
    pg_catalog.pg_backend_pid()::text||':'||pg_catalog.pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'kitchen outbox is capability controlled';
  END IF;
  IF NEW.redemption_id IS DISTINCT FROM OLD.redemption_id OR NEW.location_id IS DISTINCT FROM OLD.location_id
    OR NEW.reference_id IS DISTINCT FROM OLD.reference_id OR NEW.create_idempotency_key IS DISTINCT FROM OLD.create_idempotency_key
    OR NEW.cancel_idempotency_key IS DISTINCT FROM OLD.cancel_idempotency_key OR NEW.meal_name IS DISTINCT FROM OLD.meal_name
    OR NEW.meal_catalog_object_id IS DISTINCT FROM OLD.meal_catalog_object_id OR NEW.modifiers IS DISTINCT FROM OLD.modifiers
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR (OLD.square_order_id IS NOT NULL AND NEW.square_order_id IS DISTINCT FROM OLD.square_order_id)
    OR (OLD.square_order_version IS NOT NULL AND
      (NEW.square_order_version IS NULL OR NEW.square_order_version<OLD.square_order_version)) THEN
    RAISE EXCEPTION 'kitchen outbox identity is immutable';
  END IF;
  RETURN NEW;
END $f$;
CREATE TRIGGER downtown_u_kitchen_outbox_guard BEFORE UPDATE OR DELETE ON public.downtown_u_kitchen_order_outbox
  FOR EACH ROW EXECUTE FUNCTION public.downtown_u_kitchen_guard();
CREATE TRIGGER downtown_u_kitchen_outbox_no_truncate BEFORE TRUNCATE ON public.downtown_u_kitchen_order_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION public.downtown_u_kitchen_guard();

CREATE FUNCTION public.downtown_u_kitchen_enqueue() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE redemption_state TEXT; redemption_expires_at TIMESTAMPTZ; now_at TIMESTAMPTZ:=pg_catalog.clock_timestamp();
BEGIN
  SELECT r.status,r.expires_at INTO STRICT redemption_state,redemption_expires_at
    FROM public.downtown_u_redemptions r WHERE r.id=NEW.redemption_id FOR SHARE;
  INSERT INTO public.downtown_u_kitchen_order_outbox(redemption_id,state,location_id,reference_id,create_idempotency_key,cancel_idempotency_key,
    meal_name,meal_catalog_object_id,modifiers,created_at,updated_at,next_attempt_at)
  VALUES(NEW.redemption_id,CASE WHEN redemption_state='reserved' AND redemption_expires_at>now_at THEN 'pending' ELSE 'cancelled' END,
    'LPPWSSV03BHK8',NEW.redemption_id::text,'du-create-'||NEW.redemption_id::text,'du-cancel-'||NEW.redemption_id::text,
    NEW.meal_display_name,NEW.meal_square_catalog_object_id,NEW.modifiers,NEW.created_at,now_at,now_at);
  RETURN NEW;
END $f$;
CREATE TRIGGER downtown_u_kitchen_enqueue AFTER INSERT ON public.downtown_u_reservation_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.downtown_u_kitchen_enqueue();

/* Backfill only a still-valid reservation as actionable. Historical redemptions
 * are quarantined because migration 008 cannot prove which system made the order.
 * A syntactically valid known identity is retained even though its version is not. */
INSERT INTO public.downtown_u_kitchen_order_outbox(redemption_id,state,location_id,reference_id,create_idempotency_key,cancel_idempotency_key,
 meal_name,meal_catalog_object_id,modifiers,square_order_id,error_code,created_at,updated_at,next_attempt_at)
SELECT s.redemption_id,
 CASE WHEN r.status='reserved' AND r.expires_at>pg_catalog.clock_timestamp() THEN 'pending'
      WHEN r.status='redeemed' THEN 'operator_review' ELSE 'cancelled' END,
 'LPPWSSV03BHK8',s.redemption_id::text,'du-create-'||s.redemption_id::text,'du-cancel-'||s.redemption_id::text,
 s.meal_display_name,s.meal_square_catalog_object_id,s.modifiers,
 CASE WHEN r.status='redeemed' AND r.square_order_id~'^[A-Za-z0-9_-]{1,192}$' THEN r.square_order_id ELSE NULL END,
 CASE WHEN r.status='redeemed' THEN 'historical_redemption' ELSE NULL END,
 s.created_at,pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp()
FROM public.downtown_u_reservation_snapshots s JOIN public.downtown_u_redemptions r ON r.id=s.redemption_id;

CREATE FUNCTION public.downtown_u_kitchen_redemption_cancelled() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE now_at TIMESTAMPTZ:=pg_catalog.clock_timestamp();
BEGIN
 IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('reversed','cancelled') THEN
   PERFORM pg_catalog.set_config('downtown_u.kitchen_write',pg_catalog.pg_backend_pid()::text||':'||pg_catalog.pg_current_xact_id()::text,true);
   UPDATE public.downtown_u_kitchen_order_outbox SET
     state=CASE WHEN state='pending' AND attempt_count=0 THEN 'cancelled' ELSE 'cancel_pending' END,
     lease_token=CASE WHEN state='pending' AND attempt_count=0 THEN NULL ELSE lease_token END,
     lease_expires_at=CASE WHEN state='pending' AND attempt_count=0 THEN NULL ELSE lease_expires_at END,
     lease_action=CASE WHEN state='pending' AND attempt_count=0 THEN NULL ELSE lease_action END,
     next_attempt_at=CASE WHEN lease_token IS NULL THEN now_at ELSE next_attempt_at END,
     updated_at=now_at,error_code=NULL
   WHERE redemption_id=NEW.id AND state IN ('pending','leased','created','cancel_pending');
 END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER downtown_u_kitchen_redemption_cancel AFTER UPDATE OF status ON public.downtown_u_redemptions
 FOR EACH ROW EXECUTE FUNCTION public.downtown_u_kitchen_redemption_cancelled();

CREATE FUNCTION public.downtown_u_kitchen_claim(requested_limit INTEGER)
RETURNS TABLE(lease_token UUID,action TEXT,redemption_id UUID,location_id TEXT,reference_id TEXT,idempotency_key TEXT,
 meal_name TEXT,meal_catalog_object_id TEXT,modifiers JSONB,square_order_id TEXT,square_order_version BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE now_at TIMESTAMPTZ; candidate RECORD; outbox public.downtown_u_kitchen_order_outbox%ROWTYPE;
 redemption public.downtown_u_redemptions%ROWTYPE; token UUID; chosen_action TEXT;
BEGIN
 IF requested_limit IS NULL OR requested_limit<1 OR requested_limit>20 THEN RAISE EXCEPTION 'invalid kitchen claim'; END IF;
 PERFORM 1 FROM public.downtown_u_kitchen_config c WHERE c.singleton FOR SHARE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.downtown_u_kitchen_config c WHERE c.singleton AND c.enabled AND c.location_id='LPPWSSV03BHK8') THEN RETURN; END IF;
 PERFORM pg_catalog.set_config('downtown_u.kitchen_write',pg_catalog.pg_backend_pid()::text||':'||pg_catalog.pg_current_xact_id()::text,true);
 now_at:=pg_catalog.clock_timestamp();
 /* This discovery query intentionally takes no outbox row lock. Every contender
  * subsequently uses student -> redemption -> outbox, the expiry job's order. */
 FOR candidate IN
   SELECT o.redemption_id,r.student_id FROM public.downtown_u_kitchen_order_outbox o
   JOIN public.downtown_u_redemptions r ON r.id=o.redemption_id
   WHERE o.state IN ('pending','leased','cancel_pending') AND o.next_attempt_at<=now_at
     AND (o.lease_expires_at IS NULL OR o.lease_expires_at<=now_at)
   ORDER BY o.next_attempt_at,o.created_at,o.redemption_id LIMIT requested_limit
 LOOP
   PERFORM 1 FROM public.downtown_u_students s WHERE s.id=candidate.student_id FOR SHARE;
   SELECT r.* INTO redemption FROM public.downtown_u_redemptions r
     WHERE r.id=candidate.redemption_id AND r.student_id=candidate.student_id FOR UPDATE SKIP LOCKED;
   IF NOT FOUND THEN CONTINUE; END IF;
   SELECT o.* INTO outbox FROM public.downtown_u_kitchen_order_outbox o WHERE o.redemption_id=candidate.redemption_id FOR UPDATE;
   now_at:=pg_catalog.clock_timestamp();
   IF NOT FOUND OR outbox.state NOT IN ('pending','leased','cancel_pending') OR outbox.next_attempt_at>now_at
     OR (outbox.lease_expires_at IS NOT NULL AND outbox.lease_expires_at>now_at) THEN CONTINUE; END IF;

   IF redemption.status<>'reserved' OR redemption.expires_at IS NULL OR redemption.expires_at<=now_at THEN
     IF outbox.state='pending' AND outbox.attempt_count=0 THEN
       UPDATE public.downtown_u_kitchen_order_outbox o SET state='cancelled',lease_token=NULL,lease_expires_at=NULL,
         lease_action=NULL,error_code=NULL,updated_at=now_at WHERE o.redemption_id=outbox.redemption_id;
       CONTINUE;
     END IF;
     UPDATE public.downtown_u_kitchen_order_outbox o SET state='cancel_pending',updated_at=now_at
       WHERE o.redemption_id=outbox.redemption_id;
     outbox.state:='cancel_pending';
   END IF;

   IF outbox.attempt_count>=12 THEN
     UPDATE public.downtown_u_kitchen_order_outbox o SET state='operator_review',lease_token=NULL,lease_expires_at=NULL,
       lease_action=NULL,error_code='attempts_exhausted',updated_at=now_at WHERE o.redemption_id=outbox.redemption_id;
     CONTINUE;
   END IF;
   chosen_action:=CASE WHEN outbox.state='cancel_pending' AND outbox.square_order_id IS NOT NULL THEN 'cancel' ELSE 'create' END;
   token:=pg_catalog.gen_random_uuid();
   UPDATE public.downtown_u_kitchen_order_outbox o SET state=CASE WHEN outbox.state='cancel_pending' THEN 'cancel_pending' ELSE 'leased' END,
     lease_action=chosen_action,lease_token=token,lease_expires_at=now_at+interval '45 seconds',attempt_count=o.attempt_count+1,
     error_code=NULL,updated_at=now_at WHERE o.redemption_id=outbox.redemption_id;
   lease_token:=token;action:=chosen_action;redemption_id:=outbox.redemption_id;location_id:=outbox.location_id;
   reference_id:=outbox.reference_id;idempotency_key:=CASE WHEN chosen_action='create' THEN outbox.create_idempotency_key ELSE outbox.cancel_idempotency_key END;
   meal_name:=outbox.meal_name;meal_catalog_object_id:=outbox.meal_catalog_object_id;modifiers:=outbox.modifiers;
   square_order_id:=outbox.square_order_id;square_order_version:=outbox.square_order_version;RETURN NEXT;
 END LOOP;
END $f$;

CREATE FUNCTION public.downtown_u_kitchen_finalize(requested_token UUID,requested_action TEXT,requested_order_id TEXT,requested_version BIGINT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE outbox public.downtown_u_kitchen_order_outbox%ROWTYPE; redemption public.downtown_u_redemptions%ROWTYPE; now_at TIMESTAMPTZ;
BEGIN
 IF requested_token IS NULL OR requested_action NOT IN ('create','cancel') OR requested_order_id IS NULL OR requested_order_id!~'^[A-Za-z0-9_-]{1,192}$'
   OR requested_version IS NULL OR requested_version<0 THEN RAISE EXCEPTION 'invalid kitchen finalize'; END IF;
 SELECT r.* INTO redemption FROM public.downtown_u_kitchen_order_outbox o JOIN public.downtown_u_redemptions r ON r.id=o.redemption_id
   WHERE o.lease_token=requested_token FOR UPDATE OF r;
 IF NOT FOUND THEN RAISE EXCEPTION 'stale kitchen lease'; END IF;
 SELECT * INTO outbox FROM public.downtown_u_kitchen_order_outbox WHERE lease_token=requested_token FOR UPDATE;
 now_at:=pg_catalog.clock_timestamp();
 IF NOT FOUND OR outbox.lease_action<>requested_action OR outbox.lease_expires_at<=now_at
   OR (outbox.square_order_id IS NOT NULL AND (outbox.square_order_id<>requested_order_id OR requested_version<outbox.square_order_version)) THEN
   RAISE EXCEPTION 'stale kitchen lease';
 END IF;
 PERFORM pg_catalog.set_config('downtown_u.kitchen_write',pg_catalog.pg_backend_pid()::text||':'||pg_catalog.pg_current_xact_id()::text,true);
 IF requested_action='create' THEN
   /* Fresh time is read while the redemption lock is held. Expiry at or before
    * this instant can never become redeemed; the observed order is cancelled. */
   IF redemption.status='reserved' AND redemption.expires_at IS NOT NULL AND redemption.expires_at>now_at THEN
     UPDATE public.downtown_u_redemptions SET status='redeemed',square_order_id=requested_order_id,redeemed_at=now_at,updated_at=now_at WHERE id=redemption.id;
     UPDATE public.downtown_u_kitchen_order_outbox SET state='created',square_order_id=requested_order_id,square_order_version=requested_version,
       provider_created_at=COALESCE(provider_created_at,now_at),lease_token=NULL,lease_expires_at=NULL,lease_action=NULL,error_code=NULL,updated_at=now_at
       WHERE redemption_id=redemption.id;
     RETURN 'created';
   END IF;
   UPDATE public.downtown_u_kitchen_order_outbox SET state='cancel_pending',square_order_id=requested_order_id,square_order_version=requested_version,
     provider_created_at=COALESCE(provider_created_at,now_at),lease_token=NULL,lease_expires_at=NULL,lease_action=NULL,error_code=NULL,
     next_attempt_at=now_at,updated_at=now_at WHERE redemption_id=redemption.id;
   RETURN 'cancel_pending';
 ELSE
   IF outbox.square_order_id IS DISTINCT FROM requested_order_id OR outbox.square_order_version>requested_version THEN
     RAISE EXCEPTION 'kitchen provider conflict';
   END IF;
   UPDATE public.downtown_u_kitchen_order_outbox SET state='cancelled',square_order_version=requested_version,provider_cancelled_at=now_at,
     lease_token=NULL,lease_expires_at=NULL,lease_action=NULL,error_code=NULL,updated_at=now_at WHERE redemption_id=redemption.id;
   RETURN 'cancelled';
 END IF;
END $f$;

CREATE FUNCTION public.downtown_u_kitchen_fail(requested_token UUID,requested_code TEXT,requested_permanent BOOLEAN,requested_delay_seconds INTEGER,
 requested_observed_order_id TEXT DEFAULT NULL,requested_observed_version BIGINT DEFAULT NULL)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE outbox public.downtown_u_kitchen_order_outbox%ROWTYPE; next_state TEXT; now_at TIMESTAMPTZ;
BEGIN
 IF requested_token IS NULL OR requested_code IS NULL OR requested_code!~'^[a-z0-9_]{1,48}$' OR requested_permanent IS NULL
   OR requested_delay_seconds IS NULL OR requested_delay_seconds<1 OR requested_delay_seconds>3600
   OR ((requested_observed_order_id IS NULL)<>(requested_observed_version IS NULL))
   OR (requested_observed_order_id IS NOT NULL AND (requested_observed_order_id!~'^[A-Za-z0-9_-]{1,192}$' OR requested_observed_version<0))
   THEN RAISE EXCEPTION 'invalid kitchen failure'; END IF;
 SELECT * INTO outbox FROM public.downtown_u_kitchen_order_outbox WHERE lease_token=requested_token FOR UPDATE;
 now_at:=pg_catalog.clock_timestamp();
 IF NOT FOUND OR outbox.lease_expires_at<=now_at THEN RAISE EXCEPTION 'stale kitchen lease'; END IF;
 IF requested_observed_order_id IS NOT NULL AND
   (outbox.lease_action<>'create' OR (outbox.square_order_id IS NOT NULL AND outbox.square_order_id<>requested_observed_order_id)
    OR (outbox.square_order_version IS NOT NULL AND requested_observed_version<outbox.square_order_version)) THEN
   RAISE EXCEPTION 'kitchen provider conflict';
 END IF;
 next_state:=CASE WHEN requested_permanent OR outbox.attempt_count>=12 THEN 'operator_review'
   WHEN outbox.lease_action='cancel' OR outbox.state='cancel_pending' THEN 'cancel_pending' ELSE 'pending' END;
 PERFORM pg_catalog.set_config('downtown_u.kitchen_write',pg_catalog.pg_backend_pid()::text||':'||pg_catalog.pg_current_xact_id()::text,true);
 UPDATE public.downtown_u_kitchen_order_outbox SET state=next_state,lease_token=NULL,lease_expires_at=NULL,lease_action=NULL,error_code=requested_code,
   square_order_id=COALESCE(square_order_id,requested_observed_order_id),
   square_order_version=CASE WHEN requested_observed_version IS NULL THEN square_order_version ELSE GREATEST(square_order_version,requested_observed_version) END,
   provider_created_at=CASE WHEN requested_observed_order_id IS NULL THEN provider_created_at ELSE COALESCE(provider_created_at,now_at) END,
   next_attempt_at=now_at+pg_catalog.make_interval(secs=>requested_delay_seconds),updated_at=now_at WHERE redemption_id=outbox.redemption_id;
 RETURN next_state;
END $f$;

REVOKE ALL ON public.downtown_u_kitchen_config,public.downtown_u_kitchen_order_outbox FROM PUBLIC,downtown_u_runtime,downtown_u_jobs,downtown_u_kitchen_jobs;
REVOKE ALL ON FUNCTION public.downtown_u_kitchen_guard(),public.downtown_u_kitchen_enqueue(),public.downtown_u_kitchen_redemption_cancelled(),
 public.downtown_u_kitchen_claim(INTEGER),public.downtown_u_kitchen_finalize(UUID,TEXT,TEXT,BIGINT),public.downtown_u_kitchen_fail(UUID,TEXT,BOOLEAN,INTEGER,TEXT,BIGINT)
 FROM PUBLIC,downtown_u_runtime,downtown_u_jobs,downtown_u_kitchen_jobs;
GRANT EXECUTE ON FUNCTION public.downtown_u_kitchen_claim(INTEGER),public.downtown_u_kitchen_finalize(UUID,TEXT,TEXT,BIGINT),
 public.downtown_u_kitchen_fail(UUID,TEXT,BOOLEAN,INTEGER,TEXT,BIGINT) TO downtown_u_kitchen_jobs;

COMMIT;
