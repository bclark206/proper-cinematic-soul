BEGIN;

LOCK TABLE public.downtown_u_students IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE public.downtown_u_auth_challenges (
  challenge_id TEXT PRIMARY KEY CHECK (challenge_id ~ '^[A-Za-z0-9_-]{32,96}$'),
  contact_type TEXT NOT NULL CHECK (contact_type IN ('email','phone')),
  normalized_contact TEXT NOT NULL CHECK (
    (contact_type='email' AND normalized_contact=lower(btrim(normalized_contact))
      AND length(normalized_contact)<=254
      AND normalized_contact ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')
    OR (contact_type='phone' AND normalized_contact ~ '^[+][1-9][0-9]{7,14}$')),
  student_id UUID REFERENCES public.downtown_u_students(id) ON DELETE RESTRICT,
  method TEXT NOT NULL CHECK (
    (contact_type='email' AND method='email_magic_link') OR
    (contact_type='phone' AND method='sms_otp')),
  verifier_version SMALLINT NOT NULL CHECK (verifier_version=1),
  verifier_digest BYTEA NOT NULL CHECK (octet_length(verifier_digest)=32),
  expires_at TIMESTAMPTZ NOT NULL,
  max_attempts SMALLINT NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND max_attempts),
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed','expired','exhausted','revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '30 minutes'),
  CHECK ((status='active' AND consumed_at IS NULL AND revoked_at IS NULL AND attempt_count<max_attempts)
    OR (status='consumed' AND consumed_at IS NOT NULL AND revoked_at IS NULL)
    OR (status IN ('expired','exhausted') AND consumed_at IS NULL AND revoked_at IS NULL)
    OR (status='revoked' AND consumed_at IS NULL AND revoked_at IS NOT NULL))
);
CREATE INDEX downtown_u_auth_challenges_contact_rate_idx
  ON public.downtown_u_auth_challenges(contact_type,normalized_contact,method,created_at DESC);
CREATE UNIQUE INDEX downtown_u_auth_challenges_one_active
  ON public.downtown_u_auth_challenges(contact_type,normalized_contact,method) WHERE status='active';

CREATE TABLE public.downtown_u_auth_sessions (
  session_id TEXT PRIMARY KEY CHECK (session_id ~ '^[A-Za-z0-9_-]{32,96}$'),
  student_id UUID NOT NULL REFERENCES public.downtown_u_students(id) ON DELETE RESTRICT,
  verifier_version SMALLINT NOT NULL CHECK (verifier_version=1),
  token_digest BYTEA NOT NULL UNIQUE CHECK (octet_length(token_digest)=32),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at>issued_at AND expires_at<=issued_at+interval '31 days'),
  CHECK (last_seen_at>=issued_at AND last_seen_at<=expires_at),
  CHECK (revoked_at IS NULL OR revoked_at>=issued_at)
);
CREATE INDEX downtown_u_auth_sessions_student_idx ON public.downtown_u_auth_sessions(student_id,expires_at);

CREATE FUNCTION public.downtown_u_auth_protect_challenge() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Downtown U auth challenges cannot be deleted or truncated'; END IF;
  IF NEW.challenge_id IS DISTINCT FROM OLD.challenge_id OR NEW.contact_type IS DISTINCT FROM OLD.contact_type
    OR NEW.normalized_contact IS DISTINCT FROM OLD.normalized_contact OR NEW.student_id IS DISTINCT FROM OLD.student_id
    OR NEW.method IS DISTINCT FROM OLD.method OR NEW.verifier_version IS DISTINCT FROM OLD.verifier_version
    OR NEW.verifier_digest IS DISTINCT FROM OLD.verifier_digest OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.attempt_count<OLD.attempt_count OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at AND OLD.consumed_at IS NOT NULL
    OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at AND OLD.revoked_at IS NOT NULL
    OR OLD.status<>'active' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Downtown U auth challenge security fields are immutable';
  END IF;
  RETURN NEW;
END $function$;
CREATE TRIGGER downtown_u_auth_challenges_immutable BEFORE UPDATE OR DELETE ON public.downtown_u_auth_challenges
  FOR EACH ROW EXECUTE FUNCTION public.downtown_u_auth_protect_challenge();
CREATE TRIGGER downtown_u_auth_challenges_no_truncate BEFORE TRUNCATE ON public.downtown_u_auth_challenges
  FOR EACH STATEMENT EXECUTE FUNCTION public.downtown_u_auth_protect_challenge();

CREATE FUNCTION public.downtown_u_auth_protect_session() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Downtown U auth sessions cannot be deleted or truncated'; END IF;
  IF NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.student_id IS DISTINCT FROM OLD.student_id
    OR NEW.verifier_version IS DISTINCT FROM OLD.verifier_version OR NEW.token_digest IS DISTINCT FROM OLD.token_digest
    OR NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at AND OLD.revoked_at IS NOT NULL
    OR NEW.last_seen_at<OLD.last_seen_at THEN
    RAISE EXCEPTION 'Downtown U auth session security fields are immutable';
  END IF;
  RETURN NEW;
END $function$;
CREATE TRIGGER downtown_u_auth_sessions_immutable BEFORE UPDATE OR DELETE ON public.downtown_u_auth_sessions
  FOR EACH ROW EXECUTE FUNCTION public.downtown_u_auth_protect_session();
CREATE TRIGGER downtown_u_auth_sessions_no_truncate BEFORE TRUNCATE ON public.downtown_u_auth_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION public.downtown_u_auth_protect_session();

CREATE FUNCTION public.downtown_u_create_auth_challenge(
  requested_challenge_id TEXT, requested_contact_type TEXT, requested_contact TEXT,
  requested_method TEXT, requested_version SMALLINT, requested_digest BYTEA
) RETURNS TABLE(outcome TEXT, challenge_id TEXT, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE now_at TIMESTAMPTZ := pg_catalog.clock_timestamp(); matched_student UUID; recent_count INTEGER;
BEGIN
  IF requested_challenge_id IS NULL OR requested_challenge_id !~ '^[A-Za-z0-9_-]{32,96}$'
    OR requested_contact_type NOT IN ('email','phone') OR requested_contact IS NULL
    OR (requested_contact_type='email' AND (requested_method IS DISTINCT FROM 'email_magic_link'
      OR requested_contact<>lower(btrim(requested_contact)) OR length(requested_contact)>254
      OR requested_contact !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'))
    OR (requested_contact_type='phone' AND (requested_method IS DISTINCT FROM 'sms_otp'
      OR requested_contact !~ '^[+][1-9][0-9]{7,14}$'))
    OR requested_version IS DISTINCT FROM 1 OR requested_digest IS NULL OR octet_length(requested_digest)<>32
    THEN RAISE EXCEPTION 'Downtown U auth challenge rejected'; END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'auth:'||requested_contact_type||':'||requested_contact||':'||requested_method,0));
  SELECT count(*) INTO recent_count FROM public.downtown_u_auth_challenges c
    WHERE c.contact_type=requested_contact_type AND c.normalized_contact=requested_contact AND c.method=requested_method
      AND c.created_at>now_at-pg_catalog.make_interval(secs=>3600);
  IF recent_count>=5 OR EXISTS (SELECT 1 FROM public.downtown_u_auth_challenges c
    WHERE c.contact_type=requested_contact_type AND c.normalized_contact=requested_contact AND c.method=requested_method
      AND c.created_at>now_at-pg_catalog.make_interval(secs=>60)) THEN
    RETURN QUERY SELECT 'accepted'::TEXT,NULL::TEXT,NULL::TIMESTAMPTZ; RETURN;
  END IF;
  UPDATE public.downtown_u_auth_challenges c SET status='revoked',revoked_at=now_at
    WHERE c.contact_type=requested_contact_type AND c.normalized_contact=requested_contact
      AND c.method=requested_method AND c.status='active';
  IF requested_contact_type='email' THEN
    SELECT s.id INTO matched_student FROM public.downtown_u_students s
      WHERE s.normalized_email=requested_contact LIMIT 1;
  ELSE
    SELECT s.id INTO matched_student FROM public.downtown_u_students s
      WHERE s.normalized_phone=requested_contact LIMIT 1;
  END IF;
  INSERT INTO public.downtown_u_auth_challenges(challenge_id,contact_type,normalized_contact,student_id,method,
    verifier_version,verifier_digest,expires_at,max_attempts,created_at)
  VALUES(requested_challenge_id,requested_contact_type,requested_contact,matched_student,requested_method,
    requested_version,requested_digest,now_at+pg_catalog.make_interval(secs=>600),5,now_at);
  RETURN QUERY SELECT 'accepted'::TEXT,requested_challenge_id,now_at+pg_catalog.make_interval(secs=>600);
END $function$;

CREATE FUNCTION public.downtown_u_consume_auth_challenge(
  requested_challenge_id TEXT, requested_version SMALLINT, requested_digest BYTEA,
  requested_session_id TEXT, requested_session_version SMALLINT, requested_session_digest BYTEA
) RETURNS TABLE(outcome TEXT, session_id TEXT, student_id UUID, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE c public.downtown_u_auth_challenges%ROWTYPE; s public.downtown_u_students%ROWTYPE;
  now_at TIMESTAMPTZ:=pg_catalog.clock_timestamp(); eligible BOOLEAN:=false;
BEGIN
  IF requested_challenge_id IS NULL OR requested_challenge_id !~ '^[A-Za-z0-9_-]{32,96}$'
    OR requested_version IS DISTINCT FROM 1 OR requested_digest IS NULL OR octet_length(requested_digest)<>32
    OR requested_session_id IS NULL OR requested_session_id !~ '^[A-Za-z0-9_-]{32,96}$'
    OR requested_session_version IS DISTINCT FROM 1 OR requested_session_digest IS NULL OR octet_length(requested_session_digest)<>32 THEN
    RETURN QUERY SELECT 'invalid'::TEXT,NULL::TEXT,NULL::UUID,NULL::TIMESTAMPTZ; RETURN;
  END IF;
  SELECT * INTO c FROM public.downtown_u_auth_challenges x WHERE x.challenge_id=requested_challenge_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'invalid'::TEXT,NULL::TEXT,NULL::UUID,NULL::TIMESTAMPTZ; RETURN; END IF;
  IF c.status<>'active' THEN RETURN QUERY SELECT 'invalid'::TEXT,NULL::TEXT,NULL::UUID,NULL::TIMESTAMPTZ; RETURN; END IF;
  IF c.expires_at<=now_at THEN UPDATE public.downtown_u_auth_challenges SET status='expired' WHERE challenge_id=c.challenge_id;
    RETURN QUERY SELECT 'invalid'::TEXT,NULL::TEXT,NULL::UUID,NULL::TIMESTAMPTZ; RETURN; END IF;
  IF c.verifier_version IS DISTINCT FROM requested_version OR c.verifier_digest IS DISTINCT FROM requested_digest THEN
    UPDATE public.downtown_u_auth_challenges SET attempt_count=attempt_count+1,
      status=CASE WHEN attempt_count+1>=max_attempts THEN 'exhausted' ELSE status END WHERE challenge_id=c.challenge_id;
    RETURN QUERY SELECT 'invalid'::TEXT,NULL::TEXT,NULL::UUID,NULL::TIMESTAMPTZ; RETURN;
  END IF;
  IF c.contact_type='email' THEN
    SELECT * INTO s FROM public.downtown_u_students x WHERE x.normalized_email=c.normalized_contact
      AND x.id=c.student_id AND x.eligibility_status='approved' AND x.deleted_at IS NULL FOR UPDATE;
  ELSE
    SELECT * INTO s FROM public.downtown_u_students x WHERE x.normalized_phone=c.normalized_contact
      AND x.id=c.student_id AND x.eligibility_status='approved' AND x.deleted_at IS NULL FOR UPDATE;
  END IF;
  eligible := FOUND;
  UPDATE public.downtown_u_auth_challenges SET status='consumed',consumed_at=now_at WHERE challenge_id=c.challenge_id;
  IF NOT eligible OR s.id IS NULL THEN RETURN QUERY SELECT 'invalid'::TEXT,NULL::TEXT,NULL::UUID,NULL::TIMESTAMPTZ; RETURN; END IF;
  INSERT INTO public.downtown_u_auth_sessions(session_id,student_id,verifier_version,token_digest,issued_at,expires_at,last_seen_at)
    VALUES(requested_session_id,s.id,requested_session_version,requested_session_digest,now_at,
      now_at+pg_catalog.make_interval(secs=>86400),now_at);
  RETURN QUERY SELECT 'authenticated'::TEXT,requested_session_id,s.id,
    now_at+pg_catalog.make_interval(secs=>86400);
END $function$;

CREATE FUNCTION public.downtown_u_validate_auth_session(
 requested_session_id TEXT, requested_version SMALLINT, requested_digest BYTEA
) RETURNS TABLE(outcome TEXT, student_id UUID, eligibility_status TEXT, credit_balance INTEGER, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE now_at TIMESTAMPTZ:=pg_catalog.clock_timestamp();
BEGIN
  RETURN QUERY WITH candidate AS MATERIALIZED (
    SELECT x.session_id,x.student_id,x.expires_at FROM public.downtown_u_auth_sessions x
    JOIN public.downtown_u_students s ON s.id=x.student_id
    WHERE x.session_id=requested_session_id AND requested_version=1 AND x.verifier_version=requested_version
      AND requested_digest IS NOT NULL AND octet_length(requested_digest)=32 AND x.token_digest=requested_digest
      AND x.revoked_at IS NULL AND x.expires_at>now_at AND s.deleted_at IS NULL AND s.eligibility_status='approved'
    FOR UPDATE OF x
  ), touched AS MATERIALIZED (UPDATE public.downtown_u_auth_sessions x SET last_seen_at=now_at FROM candidate c
    WHERE x.session_id=c.session_id AND x.last_seen_at<now_at-interval '5 minutes' RETURNING x.session_id)
  SELECT 'valid'::TEXT,s.id,s.eligibility_status,s.credit_balance,c.expires_at
    FROM candidate c JOIN public.downtown_u_students s ON s.id=c.student_id
    LEFT JOIN touched t ON t.session_id=c.session_id;
  IF NOT FOUND THEN RETURN QUERY SELECT 'invalid'::TEXT,NULL::UUID,NULL::TEXT,NULL::INTEGER,NULL::TIMESTAMPTZ; END IF;
END $function$;

CREATE FUNCTION public.downtown_u_revoke_auth_session(requested_session_id TEXT, requested_version SMALLINT, requested_digest BYTEA)
RETURNS TABLE(outcome TEXT) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  UPDATE public.downtown_u_auth_sessions x SET revoked_at=pg_catalog.clock_timestamp()
  WHERE x.session_id=requested_session_id AND requested_version=1 AND x.verifier_version=requested_version
    AND requested_digest IS NOT NULL AND octet_length(requested_digest)=32 AND x.token_digest=requested_digest AND x.revoked_at IS NULL;
  RETURN QUERY SELECT 'accepted'::TEXT;
END $function$;

REVOKE ALL ON public.downtown_u_auth_challenges,public.downtown_u_auth_sessions FROM PUBLIC,downtown_u_runtime;
REVOKE ALL ON FUNCTION public.downtown_u_auth_protect_challenge(),public.downtown_u_auth_protect_session() FROM PUBLIC,downtown_u_runtime;
REVOKE ALL ON FUNCTION public.downtown_u_create_auth_challenge(TEXT,TEXT,TEXT,TEXT,SMALLINT,BYTEA) FROM PUBLIC,downtown_u_runtime;
REVOKE ALL ON FUNCTION public.downtown_u_consume_auth_challenge(TEXT,SMALLINT,BYTEA,TEXT,SMALLINT,BYTEA) FROM PUBLIC,downtown_u_runtime;
REVOKE ALL ON FUNCTION public.downtown_u_validate_auth_session(TEXT,SMALLINT,BYTEA) FROM PUBLIC,downtown_u_runtime;
REVOKE ALL ON FUNCTION public.downtown_u_revoke_auth_session(TEXT,SMALLINT,BYTEA) FROM PUBLIC,downtown_u_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_create_auth_challenge(TEXT,TEXT,TEXT,TEXT,SMALLINT,BYTEA) TO downtown_u_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_consume_auth_challenge(TEXT,SMALLINT,BYTEA,TEXT,SMALLINT,BYTEA) TO downtown_u_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_validate_auth_session(TEXT,SMALLINT,BYTEA) TO downtown_u_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_revoke_auth_session(TEXT,SMALLINT,BYTEA) TO downtown_u_runtime;

COMMIT;
