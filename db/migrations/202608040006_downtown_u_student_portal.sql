BEGIN;

-- Stock PostgreSQL databases grant database CREATE to PUBLIC. Harden the
-- authoritative database transactionally; %I safely quotes its actual name.
DO $database$
BEGIN
  EXECUTE pg_catalog.format('REVOKE CREATE ON DATABASE %I FROM PUBLIC', pg_catalog.current_database());
END
$database$;

DO $role$
BEGIN
  CREATE ROLE downtown_u_jobs NOLOGIN;
EXCEPTION
  WHEN duplicate_object THEN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='downtown_u_jobs'
      AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls) THEN
      RAISE EXCEPTION 'Existing downtown_u_jobs role is not the required least-privilege NOLOGIN role';
    END IF;
END
$role$;
REVOKE ALL ON SCHEMA public FROM downtown_u_jobs;
GRANT USAGE ON SCHEMA public TO downtown_u_jobs;

-- Trusted, owner-managed menu. The migration deliberately seeds no products:
-- approved Square catalog mappings are deployment data, never application input.
CREATE TABLE public.downtown_u_meal_rules (
  id TEXT PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,80}$'),
  display_name TEXT NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120 AND display_name !~ '[[:cntrl:]]'),
  square_catalog_object_id TEXT NOT NULL UNIQUE CHECK (length(btrim(square_catalog_object_id)) BETWEEN 1 AND 192 AND square_catalog_object_id !~ '[[:space:][:cntrl:]]'),
  base_credits INTEGER NOT NULL CHECK (base_credits BETWEEN 1 AND 20),
  active BOOLEAN NOT NULL DEFAULT FALSE,
  available_from TIMESTAMPTZ,
  available_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (available_from IS NULL OR available_until IS NULL OR available_from < available_until)
);

CREATE TABLE public.downtown_u_meal_modifiers (
  id TEXT NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{1,80}$'),
  meal_id TEXT NOT NULL REFERENCES public.downtown_u_meal_rules(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120 AND display_name !~ '[[:cntrl:]]'),
  square_catalog_object_id TEXT NOT NULL CHECK (length(btrim(square_catalog_object_id)) BETWEEN 1 AND 192 AND square_catalog_object_id !~ '[[:space:][:cntrl:]]'),
  credit_delta INTEGER NOT NULL CHECK (credit_delta BETWEEN -19 AND 20),
  active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (meal_id,id),
  UNIQUE (meal_id,square_catalog_object_id)
);
CREATE INDEX downtown_u_meal_rules_public_menu_idx ON public.downtown_u_meal_rules (active,available_from,available_until,id);
CREATE INDEX downtown_u_meal_modifiers_public_menu_idx ON public.downtown_u_meal_modifiers (meal_id,active,id);

CREATE FUNCTION public.downtown_u_valid_modifier_snapshot(candidate JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS $function$
DECLARE item JSONB; previous_id TEXT; item_id TEXT; item_name TEXT; square_id TEXT; delta_text TEXT;
BEGIN
  IF pg_catalog.jsonb_typeof(candidate)<>'array' OR pg_catalog.jsonb_array_length(candidate)>10 THEN RETURN false; END IF;
  FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(candidate) LOOP
    IF pg_catalog.jsonb_typeof(item)<>'object' OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(item))<>4
      OR NOT (item ?& ARRAY['id','name','squareCatalogObjectId','creditDelta'])
      OR pg_catalog.jsonb_typeof(item->'id')<>'string' OR pg_catalog.jsonb_typeof(item->'name')<>'string'
      OR pg_catalog.jsonb_typeof(item->'squareCatalogObjectId')<>'string' OR pg_catalog.jsonb_typeof(item->'creditDelta')<>'number'
    THEN RETURN false; END IF;
    item_id:=item->>'id'; item_name:=item->>'name'; square_id:=item->>'squareCatalogObjectId'; delta_text:=item->>'creditDelta';
    IF item_id!~'^[A-Za-z0-9_-]{1,80}$' OR (previous_id IS NOT NULL AND item_id<=previous_id)
      OR item_name<>pg_catalog.btrim(item_name) OR pg_catalog.length(item_name) NOT BETWEEN 1 AND 120 OR item_name~'[[:cntrl:]]'
      OR pg_catalog.length(square_id) NOT BETWEEN 1 AND 192 OR square_id~'[[:space:][:cntrl:]]'
      OR delta_text!~'^-?(0|[1-9][0-9]*)$' OR delta_text::numeric NOT BETWEEN -20 AND 20
    THEN RETURN false; END IF;
    previous_id:=item_id;
  END LOOP;
  RETURN true;
END $function$;

CREATE TABLE public.downtown_u_reservation_snapshots (
  redemption_id UUID PRIMARY KEY REFERENCES public.downtown_u_redemptions(id) ON DELETE RESTRICT,
  meal_rule_id TEXT NOT NULL REFERENCES public.downtown_u_meal_rules(id) ON DELETE RESTRICT,
  meal_public_id TEXT NOT NULL CHECK (meal_public_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  meal_display_name TEXT NOT NULL CHECK (length(btrim(meal_display_name)) BETWEEN 1 AND 120 AND meal_display_name !~ '[[:cntrl:]]'),
  meal_square_catalog_object_id TEXT NOT NULL CHECK (meal_square_catalog_object_id=btrim(meal_square_catalog_object_id) AND length(meal_square_catalog_object_id) BETWEEN 1 AND 192 AND meal_square_catalog_object_id !~ '[[:space:][:cntrl:]]'),
  modifiers JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (public.downtown_u_valid_modifier_snapshot(modifiers)),
  credits INTEGER NOT NULL CHECK (credits BETWEEN 1 AND 40),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX downtown_u_reservation_snapshots_rate_idx ON public.downtown_u_reservation_snapshots (created_at,redemption_id);

CREATE FUNCTION public.downtown_u_reject_reservation_snapshot_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  RAISE EXCEPTION 'downtown_u_reservation_snapshots is immutable';
END $function$;
CREATE TRIGGER downtown_u_reservation_snapshots_immutable
BEFORE UPDATE OR DELETE ON public.downtown_u_reservation_snapshots
FOR EACH ROW EXECUTE FUNCTION public.downtown_u_reject_reservation_snapshot_mutation();
CREATE TRIGGER downtown_u_reservation_snapshots_no_truncate
BEFORE TRUNCATE ON public.downtown_u_reservation_snapshots
FOR EACH STATEMENT EXECUTE FUNCTION public.downtown_u_reject_reservation_snapshot_mutation();

-- Phase 4 exposes only credential-scoped capabilities, never direct menu,
-- snapshot, student, redemption, or ledger access.
REVOKE ALL ON public.downtown_u_students,public.downtown_u_plan_purchases,
  public.downtown_u_redemptions,public.downtown_u_credit_transactions,
  public.downtown_u_meal_rules,public.downtown_u_meal_modifiers,
  public.downtown_u_reservation_snapshots FROM PUBLIC,downtown_u_runtime,downtown_u_jobs;
REVOKE ALL ON FUNCTION public.downtown_u_reject_reservation_snapshot_mutation(),public.downtown_u_valid_modifier_snapshot(JSONB) FROM PUBLIC,downtown_u_runtime,downtown_u_jobs;

CREATE FUNCTION public.downtown_u_student_principal(requested_session TEXT, requested_version SMALLINT, requested_digest BYTEA)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE student UUID;
BEGIN
  IF requested_session IS NULL OR requested_session!~'^[A-Za-z0-9_-]{43}$'
    OR requested_version IS DISTINCT FROM 1 OR requested_digest IS NULL
    OR pg_catalog.octet_length(requested_digest)<>32 THEN RAISE EXCEPTION 'invalid principal'; END IF;
  SELECT x.student_id INTO student FROM public.downtown_u_auth_sessions x
    WHERE x.session_id=requested_session AND x.verifier_version=requested_version
      AND x.token_digest=requested_digest FOR UPDATE OF x;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid principal'; END IF;
  PERFORM 1 FROM public.downtown_u_students s WHERE s.id=student FOR UPDATE OF s;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid principal'; END IF;
  IF EXISTS (SELECT 1 FROM public.downtown_u_auth_sessions x WHERE x.session_id=requested_session
      AND (x.revoked_at IS NOT NULL OR x.expires_at<=pg_catalog.clock_timestamp()))
    OR EXISTS (SELECT 1 FROM public.downtown_u_students s WHERE s.id=student
      AND (s.deleted_at IS NOT NULL OR s.eligibility_status<>'approved'))
  THEN RAISE EXCEPTION 'invalid principal'; END IF;
  RETURN student;
END $function$;

CREATE FUNCTION public.downtown_u_student_me(requested_session TEXT, requested_version SMALLINT, requested_digest BYTEA)
RETURNS TABLE(payload JSONB) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE requested_student UUID:=public.downtown_u_student_principal(requested_session,requested_version,requested_digest);
BEGIN
  RETURN QUERY SELECT pg_catalog.jsonb_build_object('studentId',s.id,'email',s.normalized_email,'phone',s.normalized_phone,
    'eligibilityStatus',s.eligibility_status,'availableCredits',s.credit_balance,
    'activePlan',CASE WHEN p.id IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object('planId',p.plan_id,'creditsGranted',p.credits_granted,
      'priceCents',p.price_cents,'currency',p.currency,'status',p.status,'paidAt',p.paid_at) END)
  FROM public.downtown_u_students s LEFT JOIN LATERAL (SELECT x.id,x.plan_id,x.credits_granted,x.price_cents,x.currency,x.status,x.paid_at
    FROM public.downtown_u_plan_purchases x WHERE x.student_id=s.id AND x.status<>'refunded' ORDER BY x.paid_at DESC,x.id DESC LIMIT 1) p ON true
  WHERE s.id=requested_student;
END $function$;

CREATE FUNCTION public.downtown_u_student_meals(requested_session TEXT, requested_version SMALLINT, requested_digest BYTEA)
RETURNS TABLE(payload JSONB) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE requested_student UUID:=public.downtown_u_student_principal(requested_session,requested_version,requested_digest); now_at TIMESTAMPTZ;
BEGIN
  now_at:=pg_catalog.clock_timestamp();
  RETURN QUERY SELECT pg_catalog.jsonb_build_object('id',m.id,'name',m.display_name,'baseCredits',m.base_credits,
    'modifiers',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',x.id,'name',x.display_name,'creditDelta',x.credit_delta) ORDER BY x.id)
      FROM public.downtown_u_meal_modifiers x WHERE x.meal_id=m.id AND x.active),'[]'::jsonb))
  FROM public.downtown_u_meal_rules m WHERE m.active AND (m.available_from IS NULL OR m.available_from<=now_at)
    AND (m.available_until IS NULL OR m.available_until>now_at) ORDER BY m.id;
END $function$;

CREATE FUNCTION public.downtown_u_student_purchases(requested_session TEXT, requested_version SMALLINT, requested_digest BYTEA, requested_limit INTEGER,cursor_created TIMESTAMPTZ,cursor_id UUID)
RETURNS TABLE(payload JSONB) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE requested_student UUID:=public.downtown_u_student_principal(requested_session,requested_version,requested_digest);
BEGIN
 IF requested_limit IS NULL OR requested_limit<1 OR requested_limit>101 OR (cursor_created IS NULL)<>(cursor_id IS NULL) THEN RAISE EXCEPTION 'invalid request'; END IF;
 RETURN QUERY SELECT pg_catalog.jsonb_build_object('id',p.id,'planId',p.plan_id,'creditsGranted',p.credits_granted,'priceCents',p.price_cents,
  'currency',p.currency,'status',p.status,'refundedCredits',p.refunded_credits,'paidAt',p.paid_at,'createdAt',p.created_at)
 FROM public.downtown_u_plan_purchases p WHERE p.student_id=requested_student AND (cursor_created IS NULL OR (p.created_at,p.id)<(cursor_created,cursor_id))
 ORDER BY p.created_at DESC,p.id DESC LIMIT requested_limit;
END $function$;

CREATE FUNCTION public.downtown_u_student_reservations(requested_session TEXT, requested_version SMALLINT, requested_digest BYTEA, requested_limit INTEGER,cursor_created TIMESTAMPTZ,cursor_id UUID)
RETURNS TABLE(payload JSONB) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE requested_student UUID:=public.downtown_u_student_principal(requested_session,requested_version,requested_digest);
BEGIN
 IF requested_limit IS NULL OR requested_limit<1 OR requested_limit>101 OR (cursor_created IS NULL)<>(cursor_id IS NULL) THEN RAISE EXCEPTION 'invalid request'; END IF;
 RETURN QUERY SELECT pg_catalog.jsonb_build_object('id',r.id,'mealId',s.meal_public_id,'mealName',s.meal_display_name,'modifiers',
   COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',v->>'id','name',v->>'name','creditDelta',(v->>'creditDelta')::integer) ORDER BY v->>'id') FROM pg_catalog.jsonb_array_elements(s.modifiers) v),'[]'::jsonb),
   'credits',r.credits,'status',r.status,'reservedAt',r.reserved_at,'expiresAt',r.expires_at,'reversedAt',r.reversed_at,'createdAt',r.created_at)
 FROM public.downtown_u_redemptions r JOIN public.downtown_u_reservation_snapshots s ON s.redemption_id=r.id
 WHERE r.student_id=requested_student AND (cursor_created IS NULL OR (r.created_at,r.id)<(cursor_created,cursor_id))
 ORDER BY r.created_at DESC,r.id DESC LIMIT requested_limit;
END $function$;

CREATE FUNCTION public.downtown_u_student_reserve(requested_session TEXT,requested_version SMALLINT,requested_digest BYTEA,
 requested_meal_id TEXT,requested_modifier_ids TEXT[],requested_key TEXT)
RETURNS TABLE(payload JSONB) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE now_at TIMESTAMPTZ; student_row public.downtown_u_students%ROWTYPE; rule_row public.downtown_u_meal_rules%ROWTYPE;
 redemption_row public.downtown_u_redemptions%ROWTYPE; snap public.downtown_u_reservation_snapshots%ROWTYPE; debit public.downtown_u_credit_transactions%ROWTYPE;
 canonical_ids TEXT[]; modifier_snapshot JSONB; modifier_count INTEGER; total_credits INTEGER;
 requested_student UUID:=public.downtown_u_student_principal(requested_session,requested_version,requested_digest);
BEGIN
 IF requested_meal_id IS NULL OR requested_meal_id!~'^[A-Za-z0-9_-]{1,80}$' OR requested_modifier_ids IS NULL
   OR pg_catalog.cardinality(requested_modifier_ids)>10
   OR (pg_catalog.cardinality(requested_modifier_ids)>0 AND (pg_catalog.array_ndims(requested_modifier_ids) IS DISTINCT FROM 1 OR pg_catalog.array_lower(requested_modifier_ids,1) IS DISTINCT FROM 1))
   OR requested_key IS NULL OR requested_key!~'^[A-Za-z0-9_-]{16,96}$' THEN RAISE EXCEPTION 'invalid request'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.unnest(requested_modifier_ids) x WHERE x IS NULL OR x!~'^[A-Za-z0-9_-]{1,80}$') THEN RAISE EXCEPTION 'invalid request'; END IF;
 SELECT COALESCE(pg_catalog.array_agg(x ORDER BY x),'{}'::text[]),count(*) INTO canonical_ids,modifier_count FROM (SELECT DISTINCT x FROM pg_catalog.unnest(requested_modifier_ids) x) q;
 IF modifier_count<>pg_catalog.cardinality(requested_modifier_ids) THEN RAISE EXCEPTION 'invalid request'; END IF;
 SELECT * INTO student_row FROM public.downtown_u_students WHERE id=requested_student FOR UPDATE;
 SELECT r.* INTO redemption_row FROM public.downtown_u_redemptions r WHERE r.idempotency_key=requested_key FOR UPDATE;
 IF FOUND THEN
   SELECT * INTO snap FROM public.downtown_u_reservation_snapshots s WHERE s.redemption_id=redemption_row.id;
   IF NOT FOUND THEN RAISE EXCEPTION 'idempotency conflict'; END IF;
   SELECT * INTO debit FROM public.downtown_u_credit_transactions t WHERE t.redemption_id=redemption_row.id AND t.transaction_type='reservation';
   IF NOT FOUND OR redemption_row.student_id IS DISTINCT FROM requested_student OR snap.meal_public_id IS DISTINCT FROM requested_meal_id
     OR COALESCE((SELECT pg_catalog.array_agg(v->>'id' ORDER BY v->>'id') FROM pg_catalog.jsonb_array_elements(snap.modifiers) v),'{}'::text[]) IS DISTINCT FROM canonical_ids
     OR redemption_row.credits IS DISTINCT FROM snap.credits OR debit.student_id IS DISTINCT FROM requested_student
     OR debit.delta IS DISTINCT FROM -snap.credits OR debit.idempotency_key IS DISTINCT FROM 'reservation:'||requested_key
     OR debit.reason IS DISTINCT FROM 'meal_reserved' OR debit.actor_type IS DISTINCT FROM 'student'
     OR debit.actor_id IS DISTINCT FROM requested_student::text OR debit.source_type IS DISTINCT FROM 'reservation_request'
     OR debit.source_id IS DISTINCT FROM requested_key OR debit.metadata IS DISTINCT FROM pg_catalog.jsonb_build_object('mealId',snap.meal_public_id)
     OR (SELECT count(*) FROM public.downtown_u_credit_transactions t WHERE t.redemption_id=redemption_row.id AND t.transaction_type='reservation')<>1
     THEN RAISE EXCEPTION 'idempotency conflict'; END IF;
 ELSE
   SELECT * INTO rule_row FROM public.downtown_u_meal_rules m WHERE m.id=requested_meal_id FOR SHARE;
   now_at:=pg_catalog.clock_timestamp();
   IF NOT FOUND OR NOT rule_row.active OR (rule_row.available_from IS NOT NULL AND rule_row.available_from>now_at)
     OR (rule_row.available_until IS NOT NULL AND rule_row.available_until<=now_at) THEN RAISE EXCEPTION 'invalid request'; END IF;
   IF (SELECT count(*) FROM public.downtown_u_reservation_snapshots s JOIN public.downtown_u_redemptions r ON r.id=s.redemption_id
       WHERE r.student_id=requested_student AND s.created_at>now_at-interval '10 minutes')>=20 THEN RAISE EXCEPTION 'rate limited'; END IF;
   SELECT count(*),COALESCE(pg_catalog.sum(x.credit_delta),0),COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id',x.id,'name',x.display_name,'squareCatalogObjectId',x.square_catalog_object_id,'creditDelta',x.credit_delta) ORDER BY x.id),'[]'::jsonb)
     INTO modifier_count,total_credits,modifier_snapshot FROM public.downtown_u_meal_modifiers x WHERE x.meal_id=rule_row.id AND x.active AND x.id=ANY(canonical_ids);
   IF modifier_count<>pg_catalog.cardinality(canonical_ids) THEN RAISE EXCEPTION 'invalid request'; END IF;
   total_credits:=rule_row.base_credits+total_credits;
   IF total_credits<1 OR total_credits>40 THEN RAISE EXCEPTION 'invalid request'; END IF;
   IF student_row.credit_balance<total_credits THEN RAISE EXCEPTION 'insufficient credits'; END IF;
   INSERT INTO public.downtown_u_redemptions(student_id,credits,idempotency_key,reserved_at,expires_at,created_at,updated_at)
    VALUES(requested_student,total_credits,requested_key,now_at,now_at+interval '15 minutes',now_at,now_at) RETURNING * INTO redemption_row;
   INSERT INTO public.downtown_u_reservation_snapshots(redemption_id,meal_rule_id,meal_public_id,meal_display_name,meal_square_catalog_object_id,modifiers,credits,created_at)
    VALUES(redemption_row.id,rule_row.id,rule_row.id,rule_row.display_name,rule_row.square_catalog_object_id,modifier_snapshot,total_credits,now_at) RETURNING * INTO snap;
   INSERT INTO public.downtown_u_credit_transactions(student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id,metadata,created_at)
    VALUES(requested_student,redemption_row.id,-total_credits,student_row.credit_balance-total_credits,'reservation','meal_reserved','reservation:'||requested_key,
      'student',requested_student::text,'reservation_request',requested_key,pg_catalog.jsonb_build_object('mealId',rule_row.id),now_at);
   IF (SELECT count(*) FROM public.downtown_u_credit_transactions t WHERE t.redemption_id=redemption_row.id)<>1
     OR (SELECT count(*) FROM public.downtown_u_reservation_snapshots s WHERE s.redemption_id=redemption_row.id)<>1
     THEN RAISE EXCEPTION 'invalid reservation topology'; END IF;
 END IF;
 RETURN QUERY SELECT pg_catalog.jsonb_build_object('id',redemption_row.id,'mealId',snap.meal_public_id,'mealName',snap.meal_display_name,
   'modifiers',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',v->>'id','name',v->>'name','creditDelta',(v->>'creditDelta')::integer) ORDER BY v->>'id') FROM pg_catalog.jsonb_array_elements(snap.modifiers) v),'[]'::jsonb),
   'credits',redemption_row.credits,'status',redemption_row.status,'reservedAt',redemption_row.reserved_at,'expiresAt',redemption_row.expires_at,'reversedAt',redemption_row.reversed_at);
END $function$;

CREATE FUNCTION public.downtown_u_student_reverse(requested_session TEXT,requested_version SMALLINT,requested_digest BYTEA,requested_reservation UUID,requested_key TEXT)
RETURNS TABLE(payload JSONB) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE now_at TIMESTAMPTZ; student_row public.downtown_u_students%ROWTYPE; redemption_row public.downtown_u_redemptions%ROWTYPE;
 snap public.downtown_u_reservation_snapshots%ROWTYPE; debit public.downtown_u_credit_transactions%ROWTYPE; duplicate public.downtown_u_credit_transactions%ROWTYPE;
 requested_student UUID:=public.downtown_u_student_principal(requested_session,requested_version,requested_digest);
BEGIN
 IF requested_reservation IS NULL OR requested_key IS NULL OR requested_key!~'^[A-Za-z0-9_-]{16,96}$' THEN RAISE EXCEPTION 'invalid request'; END IF;
 SELECT * INTO student_row FROM public.downtown_u_students WHERE id=requested_student FOR UPDATE;
 SELECT * INTO redemption_row FROM public.downtown_u_redemptions WHERE id=requested_reservation AND student_id=requested_student FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not found'; END IF;
 now_at:=pg_catalog.clock_timestamp();
 SELECT * INTO snap FROM public.downtown_u_reservation_snapshots WHERE redemption_id=redemption_row.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'invalid reservation'; END IF;
 SELECT * INTO debit FROM public.downtown_u_credit_transactions WHERE redemption_id=redemption_row.id AND transaction_type='reservation';
 IF NOT FOUND OR debit.student_id IS DISTINCT FROM requested_student OR debit.delta IS DISTINCT FROM -redemption_row.credits
   OR debit.idempotency_key IS DISTINCT FROM 'reservation:'||redemption_row.idempotency_key
   OR debit.reason IS DISTINCT FROM 'meal_reserved' OR debit.actor_type IS DISTINCT FROM 'student'
   OR debit.actor_id IS DISTINCT FROM requested_student::text OR debit.source_type IS DISTINCT FROM 'reservation_request'
   OR debit.source_id IS DISTINCT FROM redemption_row.idempotency_key
   OR debit.metadata IS DISTINCT FROM pg_catalog.jsonb_build_object('mealId',snap.meal_public_id)
   OR snap.credits IS DISTINCT FROM redemption_row.credits
   OR (SELECT count(*) FROM public.downtown_u_credit_transactions t WHERE t.redemption_id=redemption_row.id AND t.transaction_type='reservation')<>1
   THEN RAISE EXCEPTION 'invalid reservation'; END IF;
 SELECT * INTO duplicate FROM public.downtown_u_credit_transactions WHERE idempotency_key='cancel:'||requested_key;
 IF FOUND THEN
   IF duplicate.student_id IS DISTINCT FROM requested_student OR duplicate.redemption_id IS DISTINCT FROM redemption_row.id
    OR duplicate.transaction_type IS DISTINCT FROM 'redemption_reversal' OR duplicate.reason IS DISTINCT FROM 'student_cancelled'
    OR duplicate.delta IS DISTINCT FROM redemption_row.credits OR duplicate.actor_type IS DISTINCT FROM 'student'
    OR duplicate.actor_id IS DISTINCT FROM requested_student::text OR duplicate.source_type IS DISTINCT FROM 'student_cancellation'
    OR duplicate.source_id IS DISTINCT FROM requested_key OR duplicate.metadata IS DISTINCT FROM '{}'::jsonb
    OR redemption_row.status IS DISTINCT FROM 'reversed' OR redemption_row.reversed_at IS NULL
    THEN RAISE EXCEPTION 'idempotency conflict'; END IF;
 ELSE
   IF redemption_row.status<>'reserved' THEN RAISE EXCEPTION 'not cancellable'; END IF;
   IF redemption_row.expires_at IS NULL OR redemption_row.expires_at<=now_at THEN RAISE EXCEPTION 'expired reservation'; END IF;
   IF (SELECT count(*) FROM public.downtown_u_credit_transactions t WHERE t.student_id=requested_student
       AND t.transaction_type='redemption_reversal' AND t.reason='student_cancelled'
       AND t.created_at>now_at-interval '10 minutes')>=10 THEN RAISE EXCEPTION 'rate limited'; END IF;
   INSERT INTO public.downtown_u_credit_transactions(student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id,metadata,created_at)
    VALUES(requested_student,redemption_row.id,redemption_row.credits,student_row.credit_balance+redemption_row.credits,'redemption_reversal','student_cancelled',
      'cancel:'||requested_key,'student',requested_student::text,'student_cancellation',requested_key,'{}',now_at);
   UPDATE public.downtown_u_redemptions SET status='reversed',reversed_at=now_at,updated_at=now_at WHERE id=redemption_row.id RETURNING * INTO redemption_row;
 END IF;
 RETURN QUERY SELECT pg_catalog.jsonb_build_object('id',redemption_row.id,'mealId',snap.meal_public_id,'mealName',snap.meal_display_name,
  'modifiers',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',v->>'id','name',v->>'name','creditDelta',(v->>'creditDelta')::integer) ORDER BY v->>'id') FROM pg_catalog.jsonb_array_elements(snap.modifiers) v),'[]'::jsonb),
  'credits',redemption_row.credits,'status',redemption_row.status,'reservedAt',redemption_row.reserved_at,'expiresAt',redemption_row.expires_at,'reversedAt',redemption_row.reversed_at);
END $function$;

CREATE FUNCTION public.downtown_u_reverse_expired_reservations(requested_limit INTEGER)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE now_at TIMESTAMPTZ; candidate RECORD; student_row public.downtown_u_students%ROWTYPE;
 redemption_row public.downtown_u_redemptions%ROWTYPE; snap public.downtown_u_reservation_snapshots%ROWTYPE;
 debit public.downtown_u_credit_transactions%ROWTYPE; duplicate public.downtown_u_credit_transactions%ROWTYPE; reversed_count INTEGER:=0;
BEGIN
 IF requested_limit IS NULL OR requested_limit<1 OR requested_limit>100 THEN RAISE EXCEPTION 'invalid request'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('downtown_u_expiry_job',0));
 now_at:=pg_catalog.clock_timestamp();
 FOR candidate IN SELECT r.id,r.student_id FROM public.downtown_u_redemptions r
   JOIN public.downtown_u_reservation_snapshots s ON s.redemption_id=r.id
   WHERE r.status='reserved' AND r.expires_at IS NOT NULL AND r.expires_at<=now_at
   ORDER BY r.expires_at,r.id LIMIT requested_limit
 LOOP
   -- Keep the universal student -> redemption lock order, then recheck state.
   SELECT * INTO student_row FROM public.downtown_u_students WHERE id=candidate.student_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'invalid reservation'; END IF;
   SELECT * INTO redemption_row FROM public.downtown_u_redemptions WHERE id=candidate.id AND student_id=candidate.student_id FOR UPDATE;
   now_at:=pg_catalog.clock_timestamp();
   IF NOT FOUND OR redemption_row.status<>'reserved' OR redemption_row.expires_at IS NULL OR redemption_row.expires_at>now_at THEN CONTINUE; END IF;
   SELECT * INTO snap FROM public.downtown_u_reservation_snapshots WHERE redemption_id=redemption_row.id;
   IF NOT FOUND OR snap.credits IS DISTINCT FROM redemption_row.credits THEN RAISE EXCEPTION 'invalid reservation'; END IF;
   SELECT * INTO debit FROM public.downtown_u_credit_transactions WHERE redemption_id=redemption_row.id AND transaction_type='reservation';
   IF NOT FOUND OR debit.student_id IS DISTINCT FROM redemption_row.student_id OR debit.delta IS DISTINCT FROM -redemption_row.credits
     OR debit.idempotency_key IS DISTINCT FROM 'reservation:'||redemption_row.idempotency_key
     OR debit.reason IS DISTINCT FROM 'meal_reserved' OR debit.actor_type IS DISTINCT FROM 'student'
     OR debit.actor_id IS DISTINCT FROM redemption_row.student_id::text OR debit.source_type IS DISTINCT FROM 'reservation_request'
     OR debit.source_id IS DISTINCT FROM redemption_row.idempotency_key
     OR debit.metadata IS DISTINCT FROM pg_catalog.jsonb_build_object('mealId',snap.meal_public_id)
     OR (SELECT count(*) FROM public.downtown_u_credit_transactions t WHERE t.redemption_id=redemption_row.id AND t.transaction_type='reservation')<>1
     THEN RAISE EXCEPTION 'invalid reservation'; END IF;
   SELECT * INTO duplicate FROM public.downtown_u_credit_transactions WHERE idempotency_key='expiry:'||redemption_row.id::text;
   IF FOUND THEN
     IF duplicate.student_id IS DISTINCT FROM redemption_row.student_id OR duplicate.redemption_id IS DISTINCT FROM redemption_row.id
       OR duplicate.delta IS DISTINCT FROM redemption_row.credits OR duplicate.transaction_type IS DISTINCT FROM 'redemption_reversal'
       OR duplicate.reason IS DISTINCT FROM 'reservation_expired' OR duplicate.actor_type IS DISTINCT FROM 'system'
       OR duplicate.actor_id IS DISTINCT FROM 'expiry_job' OR duplicate.source_type IS DISTINCT FROM 'reservation_expiry'
       OR duplicate.source_id IS DISTINCT FROM redemption_row.id::text OR duplicate.metadata IS DISTINCT FROM '{}'::jsonb
       THEN RAISE EXCEPTION 'idempotency conflict'; END IF;
     RAISE EXCEPTION 'invalid reservation state';
   END IF;
   INSERT INTO public.downtown_u_credit_transactions(student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id,metadata,created_at)
    VALUES(redemption_row.student_id,redemption_row.id,redemption_row.credits,student_row.credit_balance+redemption_row.credits,'redemption_reversal','reservation_expired',
      'expiry:'||redemption_row.id::text,'system','expiry_job','reservation_expiry',redemption_row.id::text,'{}',now_at);
   UPDATE public.downtown_u_redemptions SET status='reversed',reversed_at=now_at,updated_at=now_at WHERE id=redemption_row.id;
   reversed_count:=reversed_count+1;
 END LOOP;
 RETURN reversed_count;
END $function$;

REVOKE ALL ON FUNCTION public.downtown_u_student_principal(TEXT,SMALLINT,BYTEA),public.downtown_u_student_me(TEXT,SMALLINT,BYTEA),
 public.downtown_u_student_meals(TEXT,SMALLINT,BYTEA),public.downtown_u_student_purchases(TEXT,SMALLINT,BYTEA,INTEGER,TIMESTAMPTZ,UUID),
 public.downtown_u_student_reservations(TEXT,SMALLINT,BYTEA,INTEGER,TIMESTAMPTZ,UUID),public.downtown_u_student_reserve(TEXT,SMALLINT,BYTEA,TEXT,TEXT[],TEXT),
 public.downtown_u_student_reverse(TEXT,SMALLINT,BYTEA,UUID,TEXT),public.downtown_u_reverse_expired_reservations(INTEGER) FROM PUBLIC,downtown_u_runtime,downtown_u_jobs;
GRANT EXECUTE ON FUNCTION public.downtown_u_student_me(TEXT,SMALLINT,BYTEA),public.downtown_u_student_meals(TEXT,SMALLINT,BYTEA),
 public.downtown_u_student_purchases(TEXT,SMALLINT,BYTEA,INTEGER,TIMESTAMPTZ,UUID),public.downtown_u_student_reservations(TEXT,SMALLINT,BYTEA,INTEGER,TIMESTAMPTZ,UUID),
 public.downtown_u_student_reserve(TEXT,SMALLINT,BYTEA,TEXT,TEXT[],TEXT),public.downtown_u_student_reverse(TEXT,SMALLINT,BYTEA,UUID,TEXT) TO downtown_u_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_reverse_expired_reservations(INTEGER) TO downtown_u_jobs;

COMMIT;
