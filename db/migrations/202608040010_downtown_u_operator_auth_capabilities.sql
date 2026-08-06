BEGIN;

/* C1: externally-HMACed email-link + SMS sign-in. Raw delivery secrets never
 * cross this boundary; callers supply versioned 32-byte opaque verifiers. */
CREATE UNIQUE INDEX downtown_u_operator_auth_flows_one_live_per_operator
  ON public.downtown_u_operator_auth_flows(operator_id)
  WHERE status IN ('pending_email','pending_sms','complete');
CREATE INDEX downtown_u_operator_auth_flows_rate_idx
  ON public.downtown_u_operator_auth_flows(operator_id,created_at DESC);

CREATE FUNCTION public.downtown_u_operator_auth_begin(
  requested_flow_id uuid, requested_normalized_email text, requested_version smallint,
  requested_flow_verifier bytea, requested_email_challenge_id uuid,
  requested_email_challenge_verifier bytea, requested_correlation_id text)
RETURNS TABLE(outcome text,email_challenge_id uuid,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE
  account_row public.downtown_u_operator_accounts%ROWTYPE;
  now_at TIMESTAMPTZ := pg_catalog.clock_timestamp();
  flow_expiry TIMESTAMPTZ;
  previous_setting TEXT;
  affected_rows BIGINT;
  recent_minute BIGINT;
  recent_hour BIGINT;
BEGIN
  IF requested_correlation_id IS NULL OR requested_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid correlation id';
  END IF;

  IF requested_flow_id IS NULL OR requested_email_challenge_id IS NULL
     OR requested_version IS NULL OR requested_version<>1
     OR requested_flow_verifier IS NULL OR pg_catalog.octet_length(requested_flow_verifier)<>32
     OR requested_email_challenge_verifier IS NULL OR pg_catalog.octet_length(requested_email_challenge_verifier)<>32
     OR requested_normalized_email IS NULL
     OR requested_normalized_email<>pg_catalog.lower(pg_catalog.btrim(requested_normalized_email))
     OR pg_catalog.length(requested_normalized_email) NOT BETWEEN 3 AND 254
     OR requested_normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN
    previous_setting := pg_catalog.current_setting('downtown_u.operator_write',true);
    PERFORM pg_catalog.set_config('downtown_u.operator_write',pg_catalog.pg_backend_pid()::TEXT||':'||pg_catalog.pg_current_xact_id()::TEXT,true);
    INSERT INTO public.downtown_u_operator_security_events(operator_id,flow_id,session_id,event_code,outcome,factor,correlation_id)
      VALUES(NULL,NULL,NULL,'failure','denied','email_magic_link',requested_correlation_id);
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count writing security event'; END IF;
    PERFORM pg_catalog.set_config('downtown_u.operator_write',COALESCE(previous_setting,''),true);
    RETURN QUERY SELECT 'accepted'::TEXT,NULL::UUID,NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT a.* INTO account_row FROM public.downtown_u_operator_accounts AS a
    WHERE a.normalized_email=requested_normalized_email FOR UPDATE;
  IF NOT FOUND OR account_row.status<>'active' THEN
    previous_setting := pg_catalog.current_setting('downtown_u.operator_write',true);
    PERFORM pg_catalog.set_config('downtown_u.operator_write',pg_catalog.pg_backend_pid()::TEXT||':'||pg_catalog.pg_current_xact_id()::TEXT,true);
    INSERT INTO public.downtown_u_operator_security_events(operator_id,flow_id,session_id,event_code,outcome,factor,correlation_id)
      VALUES(NULL,NULL,NULL,'issuance','observed','email_magic_link',requested_correlation_id);
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count writing security event'; END IF;
    PERFORM pg_catalog.set_config('downtown_u.operator_write',COALESCE(previous_setting,''),true);
    RETURN QUERY SELECT 'accepted'::TEXT,NULL::UUID,NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT pg_catalog.count(*) FILTER (WHERE f.created_at>now_at-INTERVAL '1 minute'),
         pg_catalog.count(*) FILTER (WHERE f.created_at>now_at-INTERVAL '1 hour')
    INTO recent_minute,recent_hour
    FROM public.downtown_u_operator_auth_flows AS f WHERE f.operator_id=account_row.id;
  IF recent_minute>=1 OR recent_hour>=5 THEN
    previous_setting := pg_catalog.current_setting('downtown_u.operator_write',true);
    PERFORM pg_catalog.set_config('downtown_u.operator_write',pg_catalog.pg_backend_pid()::TEXT||':'||pg_catalog.pg_current_xact_id()::TEXT,true);
    INSERT INTO public.downtown_u_operator_security_events(operator_id,flow_id,session_id,event_code,outcome,factor,correlation_id)
      VALUES(account_row.id,NULL,NULL,'failure','denied','email_magic_link',requested_correlation_id);
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count writing security event'; END IF;
    PERFORM pg_catalog.set_config('downtown_u.operator_write',COALESCE(previous_setting,''),true);
    RETURN QUERY SELECT 'accepted'::TEXT,NULL::UUID,NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  PERFORM 1 FROM public.downtown_u_operator_auth_flows AS f
    WHERE f.operator_id=account_row.id AND f.status IN ('pending_email','pending_sms','complete')
    ORDER BY f.id FOR UPDATE;
  PERFORM 1 FROM public.downtown_u_operator_auth_challenges AS c
    WHERE c.operator_id=account_row.id AND c.status IN ('pending','verified')
      AND c.flow_id IN (SELECT f.id FROM public.downtown_u_operator_auth_flows AS f
        WHERE f.operator_id=account_row.id AND f.status IN ('pending_email','pending_sms','complete'))
    ORDER BY c.id FOR UPDATE;
  UPDATE public.downtown_u_operator_auth_challenges AS c SET status='revoked',revoked_at=now_at,updated_at=now_at
    WHERE c.operator_id=account_row.id AND c.status IN ('pending','verified')
      AND c.flow_id IN (SELECT f.id FROM public.downtown_u_operator_auth_flows AS f
        WHERE f.operator_id=account_row.id AND f.status IN ('pending_email','pending_sms','complete'));
  UPDATE public.downtown_u_operator_auth_flows AS f SET status='revoked',revoked_at=now_at,updated_at=now_at
    WHERE f.operator_id=account_row.id AND f.status IN ('pending_email','pending_sms','complete');

  flow_expiry := now_at+INTERVAL '15 minutes';
  INSERT INTO public.downtown_u_operator_auth_flows
    (id,operator_id,verifier_version,flow_verifier,status,created_at,updated_at,expires_at)
    VALUES(requested_flow_id,account_row.id,1,requested_flow_verifier,'pending_email',now_at,now_at,flow_expiry);
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count inserting auth flow'; END IF;
  INSERT INTO public.downtown_u_operator_auth_challenges
    (id,operator_id,flow_id,purpose,factor,status,verifier_version,challenge_verifier,expires_at,created_at,updated_at)
    VALUES(requested_email_challenge_id,account_row.id,requested_flow_id,'sign_in','email_magic_link','pending',1,
      requested_email_challenge_verifier,now_at+INTERVAL '10 minutes',now_at,now_at);
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count inserting email challenge'; END IF;

  previous_setting := pg_catalog.current_setting('downtown_u.operator_write',true);
  PERFORM pg_catalog.set_config('downtown_u.operator_write',pg_catalog.pg_backend_pid()::TEXT||':'||pg_catalog.pg_current_xact_id()::TEXT,true);
  INSERT INTO public.downtown_u_operator_security_events(operator_id,flow_id,event_code,outcome,factor,correlation_id)
    VALUES(account_row.id,requested_flow_id,'issuance','succeeded','email_magic_link',requested_correlation_id);
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count writing security event'; END IF;
  PERFORM pg_catalog.set_config('downtown_u.operator_write',COALESCE(previous_setting,''),true);
  RETURN QUERY SELECT 'accepted'::TEXT,requested_email_challenge_id,now_at+INTERVAL '10 minutes';
END $function$;

CREATE FUNCTION public.downtown_u_operator_auth_verify_email(
  requested_flow_id uuid, requested_flow_version smallint, requested_flow_verifier bytea,
  requested_email_challenge_id uuid, requested_email_version smallint, requested_email_challenge_verifier bytea,
  requested_sms_challenge_id uuid, requested_sms_version smallint, requested_sms_challenge_verifier bytea,
  requested_correlation_id text)
RETURNS TABLE(outcome text,sms_challenge_id uuid,normalized_phone text,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE
  lookup_operator_id UUID;
  flow_row public.downtown_u_operator_auth_flows%ROWTYPE;
  account_row public.downtown_u_operator_accounts%ROWTYPE;
  email_row public.downtown_u_operator_auth_challenges%ROWTYPE;
  now_at TIMESTAMPTZ := pg_catalog.clock_timestamp();
  sms_expiry TIMESTAMPTZ;
  previous_setting TEXT;
  affected_rows BIGINT;
  valid_proof BOOLEAN := false;
  evidence_code TEXT := 'failure';
BEGIN
  IF requested_correlation_id IS NULL OR requested_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid correlation id';
  END IF;
  SELECT f.operator_id INTO lookup_operator_id FROM public.downtown_u_operator_auth_flows AS f WHERE f.id=requested_flow_id;
  IF FOUND THEN
    SELECT a.* INTO account_row FROM public.downtown_u_operator_accounts AS a WHERE a.id=lookup_operator_id FOR UPDATE;
    IF FOUND THEN
      SELECT f.* INTO flow_row FROM public.downtown_u_operator_auth_flows AS f
        WHERE f.id=requested_flow_id AND f.operator_id=lookup_operator_id FOR UPDATE;
    END IF;
    IF flow_row.id IS NOT NULL THEN
      SELECT c.* INTO email_row FROM public.downtown_u_operator_auth_challenges AS c
        WHERE c.id=requested_email_challenge_id AND c.flow_id=flow_row.id AND c.operator_id=lookup_operator_id
          AND c.purpose='sign_in' AND c.factor='email_magic_link' FOR UPDATE;

    IF flow_row.expires_at<=now_at AND flow_row.status IN ('pending_email','pending_sms') THEN
      UPDATE public.downtown_u_operator_auth_challenges AS c SET status='expired',expired_at=now_at,updated_at=now_at
        WHERE c.id=email_row.id AND c.status='pending' AND c.expires_at<=now_at;
      UPDATE public.downtown_u_operator_auth_challenges AS c SET status='revoked',revoked_at=now_at,updated_at=now_at
        WHERE c.flow_id=flow_row.id AND c.status IN ('pending','verified') AND c.expires_at>now_at;
      UPDATE public.downtown_u_operator_auth_flows AS f SET status='expired',expired_at=now_at,updated_at=now_at
        WHERE f.id=flow_row.id AND f.status IN ('pending_email','pending_sms');
      evidence_code := 'expiry';
    ELSIF email_row.id IS NOT NULL AND email_row.expires_at<=now_at AND email_row.status='pending' THEN
      UPDATE public.downtown_u_operator_auth_challenges AS c SET status='expired',expired_at=now_at,updated_at=now_at WHERE c.id=email_row.id;
      GET DIAGNOSTICS affected_rows = ROW_COUNT;
      IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count expiring email challenge'; END IF;
      UPDATE public.downtown_u_operator_auth_flows AS f SET status='revoked',revoked_at=now_at,updated_at=now_at
        WHERE f.id=flow_row.id AND f.status='pending_email';
      evidence_code := 'expiry';
    ELSE
      valid_proof := flow_row.status='pending_email' AND account_row.status='active'
        AND flow_row.expires_at>now_at AND requested_flow_version=1 AND flow_row.verifier_version=requested_flow_version
        AND requested_flow_verifier IS NOT NULL AND pg_catalog.octet_length(requested_flow_verifier)=32
        AND flow_row.flow_verifier=requested_flow_verifier
        AND email_row.id IS NOT NULL AND email_row.status='pending' AND email_row.expires_at>now_at
        AND requested_email_version=1 AND email_row.verifier_version=requested_email_version
        AND requested_email_challenge_verifier IS NOT NULL AND pg_catalog.octet_length(requested_email_challenge_verifier)=32
        AND email_row.challenge_verifier=requested_email_challenge_verifier
        AND requested_sms_challenge_id IS NOT NULL AND requested_sms_version=1
        AND requested_sms_challenge_verifier IS NOT NULL AND pg_catalog.octet_length(requested_sms_challenge_verifier)=32;
      IF NOT valid_proof AND email_row.id IS NOT NULL AND email_row.status='pending' AND email_row.attempt_count<5 THEN
        UPDATE public.downtown_u_operator_auth_challenges AS c SET attempt_count=c.attempt_count+1,
          status=CASE WHEN c.attempt_count+1>=5 THEN 'revoked' ELSE c.status END,
          revoked_at=CASE WHEN c.attempt_count+1>=5 THEN now_at ELSE c.revoked_at END,updated_at=now_at WHERE c.id=email_row.id;
        GET DIAGNOSTICS affected_rows = ROW_COUNT;
        IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count recording email attempt'; END IF;
        IF email_row.attempt_count+1>=5 THEN
          UPDATE public.downtown_u_operator_auth_flows AS f SET status='revoked',revoked_at=now_at,updated_at=now_at
            WHERE f.id=flow_row.id AND f.status='pending_email';
        END IF;
      ELSIF NOT valid_proof AND email_row.id IS NOT NULL AND email_row.status<>'pending' THEN
        evidence_code := 'replay';
      END IF;
    END IF;
    END IF;
  END IF;

  IF NOT valid_proof THEN
    previous_setting := pg_catalog.current_setting('downtown_u.operator_write',true);
    PERFORM pg_catalog.set_config('downtown_u.operator_write',pg_catalog.pg_backend_pid()::TEXT||':'||pg_catalog.pg_current_xact_id()::TEXT,true);
    INSERT INTO public.downtown_u_operator_security_events(operator_id,flow_id,event_code,outcome,factor,correlation_id)
      VALUES(CASE WHEN flow_row.id IS NULL THEN NULL ELSE flow_row.operator_id END,
        CASE WHEN flow_row.id IS NULL THEN NULL ELSE flow_row.id END,evidence_code,'denied','email_magic_link',requested_correlation_id);
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count writing security event'; END IF;
    PERFORM pg_catalog.set_config('downtown_u.operator_write',COALESCE(previous_setting,''),true);
    RETURN QUERY SELECT 'invalid'::TEXT,NULL::UUID,NULL::TEXT,NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  UPDATE public.downtown_u_operator_auth_challenges AS c SET status='consumed',verified_at=now_at,consumed_at=now_at,updated_at=now_at
    WHERE c.id=email_row.id AND c.status='pending';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count consuming email challenge'; END IF;
  UPDATE public.downtown_u_operator_auth_flows AS f SET status='pending_sms',updated_at=now_at
    WHERE f.id=flow_row.id AND f.status='pending_email';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count advancing auth flow'; END IF;
  sms_expiry := LEAST(now_at+INTERVAL '5 minutes',flow_row.expires_at);
  INSERT INTO public.downtown_u_operator_auth_challenges
    (id,operator_id,flow_id,purpose,factor,status,verifier_version,challenge_verifier,expires_at,created_at,updated_at)
    VALUES(requested_sms_challenge_id,flow_row.operator_id,flow_row.id,'sign_in','sms_otp','pending',1,
      requested_sms_challenge_verifier,sms_expiry,now_at,now_at);
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count inserting sms challenge'; END IF;

  previous_setting := pg_catalog.current_setting('downtown_u.operator_write',true);
  PERFORM pg_catalog.set_config('downtown_u.operator_write',pg_catalog.pg_backend_pid()::TEXT||':'||pg_catalog.pg_current_xact_id()::TEXT,true);
  INSERT INTO public.downtown_u_operator_security_events(operator_id,flow_id,event_code,outcome,factor,correlation_id)
    VALUES(flow_row.operator_id,flow_row.id,'success','succeeded','email_magic_link',requested_correlation_id);
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count writing security event'; END IF;
  PERFORM pg_catalog.set_config('downtown_u.operator_write',COALESCE(previous_setting,''),true);
  RETURN QUERY SELECT 'verified'::TEXT,requested_sms_challenge_id,account_row.normalized_phone,sms_expiry;
END $function$;

CREATE FUNCTION public.downtown_u_operator_auth_finish_sign_in(
  requested_flow_id uuid, requested_flow_version smallint, requested_flow_verifier bytea,
  requested_sms_challenge_id uuid, requested_sms_version smallint, requested_sms_challenge_verifier bytea,
  requested_session_id uuid, requested_session_version smallint, requested_session_verifier bytea,
  requested_correlation_id text)
RETURNS TABLE(outcome text,session_id uuid,operator_id uuid,display_name text,role_codes text[],absolute_expires timestamptz,idle_expires timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE
  lookup_operator_id UUID;
  flow_row public.downtown_u_operator_auth_flows%ROWTYPE;
  account_row public.downtown_u_operator_accounts%ROWTYPE;
  email_row public.downtown_u_operator_auth_challenges%ROWTYPE;
  sms_row public.downtown_u_operator_auth_challenges%ROWTYPE;
  now_at TIMESTAMPTZ := pg_catalog.clock_timestamp();
  absolute_at TIMESTAMPTZ;
  idle_at TIMESTAMPTZ;
  roles TEXT[];
  previous_setting TEXT;
  affected_rows BIGINT;
  valid_proof BOOLEAN := false;
  evidence_code TEXT := 'failure';
BEGIN
  IF requested_correlation_id IS NULL OR requested_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid correlation id';
  END IF;
  SELECT f.operator_id INTO lookup_operator_id FROM public.downtown_u_operator_auth_flows AS f WHERE f.id=requested_flow_id;
  IF FOUND THEN
    SELECT a.* INTO account_row FROM public.downtown_u_operator_accounts AS a WHERE a.id=lookup_operator_id FOR UPDATE;
    IF FOUND THEN
      SELECT f.* INTO flow_row FROM public.downtown_u_operator_auth_flows AS f
        WHERE f.id=requested_flow_id AND f.operator_id=lookup_operator_id FOR UPDATE;
    END IF;
    IF flow_row.id IS NOT NULL THEN
    PERFORM 1 FROM public.downtown_u_operator_auth_challenges AS c
      WHERE c.flow_id=flow_row.id AND c.operator_id=lookup_operator_id AND c.purpose='sign_in'
        AND c.factor IN ('email_magic_link','sms_otp') ORDER BY c.id FOR UPDATE;
    SELECT c.* INTO email_row FROM public.downtown_u_operator_auth_challenges AS c
      WHERE c.flow_id=flow_row.id AND c.operator_id=flow_row.operator_id AND c.purpose='sign_in' AND c.factor='email_magic_link';
    SELECT c.* INTO sms_row FROM public.downtown_u_operator_auth_challenges AS c
      WHERE c.id=requested_sms_challenge_id AND c.flow_id=flow_row.id AND c.operator_id=flow_row.operator_id
        AND c.purpose='sign_in' AND c.factor='sms_otp';
    SELECT pg_catalog.array_agg(r.role_code ORDER BY r.role_code) INTO roles
      FROM public.downtown_u_operator_account_roles AS r WHERE r.account_id=flow_row.operator_id AND r.revoked_at IS NULL;

    IF flow_row.expires_at<=now_at AND flow_row.status='pending_sms' THEN
      UPDATE public.downtown_u_operator_auth_challenges AS c SET status='expired',expired_at=now_at,updated_at=now_at
        WHERE c.id=sms_row.id AND c.status='pending' AND c.expires_at<=now_at;
      UPDATE public.downtown_u_operator_auth_flows AS f SET status='expired',expired_at=now_at,updated_at=now_at
        WHERE f.id=flow_row.id AND f.status='pending_sms';
      evidence_code := 'expiry';
    ELSIF sms_row.id IS NOT NULL AND sms_row.expires_at<=now_at AND sms_row.status='pending' THEN
      UPDATE public.downtown_u_operator_auth_challenges AS c SET status='expired',expired_at=now_at,updated_at=now_at WHERE c.id=sms_row.id;
      UPDATE public.downtown_u_operator_auth_flows AS f SET status='revoked',revoked_at=now_at,updated_at=now_at
        WHERE f.id=flow_row.id AND f.status='pending_sms';
      evidence_code := 'expiry';
    ELSE
      valid_proof := flow_row.status='pending_sms' AND account_row.status='active' AND roles IS NOT NULL
        AND flow_row.expires_at>now_at AND requested_flow_version=1 AND flow_row.verifier_version=requested_flow_version
        AND requested_flow_verifier IS NOT NULL AND pg_catalog.octet_length(requested_flow_verifier)=32
        AND flow_row.flow_verifier=requested_flow_verifier
        AND email_row.id IS NOT NULL AND email_row.status='consumed' AND email_row.verified_at IS NOT NULL AND email_row.consumed_at IS NOT NULL
        AND sms_row.id IS NOT NULL AND sms_row.status='pending' AND sms_row.expires_at>now_at
        AND requested_sms_version=1 AND sms_row.verifier_version=requested_sms_version
        AND requested_sms_challenge_verifier IS NOT NULL AND pg_catalog.octet_length(requested_sms_challenge_verifier)=32
        AND sms_row.challenge_verifier=requested_sms_challenge_verifier
        AND requested_session_id IS NOT NULL AND requested_session_version=1
        AND requested_session_verifier IS NOT NULL AND pg_catalog.octet_length(requested_session_verifier)=32;
      IF NOT valid_proof AND sms_row.id IS NOT NULL AND sms_row.status='pending' AND sms_row.attempt_count<5
         AND flow_row.status='pending_sms' THEN
        UPDATE public.downtown_u_operator_auth_challenges AS c SET attempt_count=c.attempt_count+1,
          status=CASE WHEN c.attempt_count+1>=5 THEN 'revoked' ELSE c.status END,
          revoked_at=CASE WHEN c.attempt_count+1>=5 THEN now_at ELSE c.revoked_at END,updated_at=now_at WHERE c.id=sms_row.id;
        GET DIAGNOSTICS affected_rows = ROW_COUNT;
        IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count recording sms attempt'; END IF;
        IF sms_row.attempt_count+1>=5 THEN
          UPDATE public.downtown_u_operator_auth_flows AS f SET status='revoked',revoked_at=now_at,updated_at=now_at
            WHERE f.id=flow_row.id AND f.status='pending_sms';
        END IF;
      ELSIF NOT valid_proof AND (flow_row.status IN ('complete','consumed') OR sms_row.status='consumed') THEN
        evidence_code := 'replay';
      END IF;
    END IF;
    END IF;
  END IF;

  IF NOT valid_proof THEN
    previous_setting := pg_catalog.current_setting('downtown_u.operator_write',true);
    PERFORM pg_catalog.set_config('downtown_u.operator_write',pg_catalog.pg_backend_pid()::TEXT||':'||pg_catalog.pg_current_xact_id()::TEXT,true);
    INSERT INTO public.downtown_u_operator_security_events(operator_id,flow_id,event_code,outcome,factor,correlation_id)
      VALUES(CASE WHEN flow_row.id IS NULL THEN NULL ELSE flow_row.operator_id END,
        CASE WHEN flow_row.id IS NULL THEN NULL ELSE flow_row.id END,evidence_code,'denied','sms_otp',requested_correlation_id);
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count writing security event'; END IF;
    PERFORM pg_catalog.set_config('downtown_u.operator_write',COALESCE(previous_setting,''),true);
    RETURN QUERY SELECT 'invalid'::TEXT,NULL::UUID,NULL::UUID,NULL::TEXT,NULL::TEXT[],NULL::TIMESTAMPTZ,NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  UPDATE public.downtown_u_operator_auth_challenges AS c SET status='consumed',verified_at=now_at,consumed_at=now_at,updated_at=now_at
    WHERE c.id=sms_row.id AND c.status='pending';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count consuming sms challenge'; END IF;
  UPDATE public.downtown_u_operator_auth_flows AS f SET status='complete',completed_at=now_at,updated_at=now_at
    WHERE f.id=flow_row.id AND f.status='pending_sms';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count completing auth flow'; END IF;
  UPDATE public.downtown_u_operator_auth_flows AS f SET status='consumed',consumed_at=now_at,updated_at=now_at
    WHERE f.id=flow_row.id AND f.status='complete' AND f.completed_at=now_at;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count consuming auth flow'; END IF;
  absolute_at := now_at+INTERVAL '8 hours';
  idle_at := now_at+INTERVAL '30 minutes';
  INSERT INTO public.downtown_u_operator_sessions
    (id,operator_id,consumed_auth_flow_id,consumed_flow_status,verifier_version,session_verifier,status,
     absolute_expires_at,idle_expires_at,last_seen_at,created_at,updated_at)
    VALUES(requested_session_id,flow_row.operator_id,flow_row.id,'consumed',1,requested_session_verifier,'active',
      absolute_at,idle_at,now_at,now_at,now_at);
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count inserting session'; END IF;

  previous_setting := pg_catalog.current_setting('downtown_u.operator_write',true);
  PERFORM pg_catalog.set_config('downtown_u.operator_write',pg_catalog.pg_backend_pid()::TEXT||':'||pg_catalog.pg_current_xact_id()::TEXT,true);
  INSERT INTO public.downtown_u_operator_security_events(operator_id,flow_id,session_id,event_code,outcome,factor,correlation_id)
    VALUES(flow_row.operator_id,flow_row.id,requested_session_id,'success','succeeded','sms_otp',requested_correlation_id);
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count writing security event'; END IF;
  PERFORM pg_catalog.set_config('downtown_u.operator_write',COALESCE(previous_setting,''),true);
  RETURN QUERY SELECT 'authenticated'::TEXT,requested_session_id,flow_row.operator_id,account_row.display_name,roles,absolute_at,idle_at;
END $function$;

/* C2: session authorization, session-bound SMS reauthentication and logout. */
CREATE UNIQUE INDEX downtown_u_operator_reauth_one_pending_per_session
  ON public.downtown_u_operator_auth_challenges(session_id)
  WHERE purpose='reauth' AND factor='sms_otp' AND status='pending';
CREATE INDEX downtown_u_operator_reauth_rate_idx
  ON public.downtown_u_operator_auth_challenges(session_id,created_at DESC)
  WHERE purpose='reauth' AND factor='sms_otp';

CREATE FUNCTION public.downtown_u_operator_auth_validate_session(
  requested_session_id uuid, requested_session_version smallint, requested_session_verifier bytea,
  requested_role_code text, requested_gate_code text, requested_correlation_id text)
RETURNS TABLE(outcome text,operator_id uuid,display_name text,role_codes text[],gate_code text,
  absolute_expires_at timestamptz,idle_expires_at timestamptz,reauthenticated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE
  session_row public.downtown_u_operator_sessions%ROWTYPE;
  account_row public.downtown_u_operator_accounts%ROWTYPE;
  config_row public.downtown_u_operator_config%ROWTYPE;
  now_at TIMESTAMPTZ := pg_catalog.clock_timestamp();
  roles TEXT[];
  latest_reauth TIMESTAMPTZ;
  result_code TEXT := 'invalid';
  previous_setting TEXT;
  affected_rows BIGINT;
  credential_ok BOOLEAN := false;
  role_ok BOOLEAN := false;
  gate_ok BOOLEAN := false;
  evidence_code TEXT := 'failure';
BEGIN
  IF requested_correlation_id IS NULL OR requested_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid correlation id';
  END IF;
  SELECT s.* INTO session_row FROM public.downtown_u_operator_sessions AS s
    WHERE s.id=requested_session_id FOR UPDATE;
  IF FOUND THEN
    SELECT a.* INTO STRICT account_row FROM public.downtown_u_operator_accounts AS a
      WHERE a.id=session_row.operator_id FOR UPDATE;
    SELECT c.* INTO STRICT config_row FROM public.downtown_u_operator_config AS c
      WHERE c.singleton=true FOR UPDATE;
    SELECT pg_catalog.array_agg(r.role_code ORDER BY r.role_code) INTO roles
      FROM public.downtown_u_operator_account_roles AS r
      WHERE r.account_id=session_row.operator_id AND r.revoked_at IS NULL;
    SELECT pg_catalog.max(c.consumed_at) INTO latest_reauth
      FROM public.downtown_u_operator_auth_challenges AS c
      WHERE c.session_id=session_row.id AND c.operator_id=session_row.operator_id
        AND c.purpose='reauth' AND c.factor='sms_otp' AND c.status='consumed';

    credential_ok := session_row.status='active' AND requested_session_version=1
      AND session_row.verifier_version=requested_session_version
      AND requested_session_verifier IS NOT NULL
      AND pg_catalog.octet_length(requested_session_verifier)=32
      AND session_row.session_verifier=requested_session_verifier;
    IF credential_ok AND (session_row.idle_expires_at<=now_at OR session_row.absolute_expires_at<=now_at) THEN
      UPDATE public.downtown_u_operator_sessions AS s SET status='expired',updated_at=now_at
        WHERE s.id=session_row.id AND s.status='active';
      GET DIAGNOSTICS affected_rows = ROW_COUNT;
      IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count expiring session'; END IF;
      evidence_code := 'expiry';
      credential_ok := false;
    END IF;
    IF credential_ok AND account_row.status='active' THEN
      role_ok := roles IS NOT NULL AND (requested_role_code IS NULL OR requested_role_code=ANY(roles));
      gate_ok := requested_gate_code IN ('read','mutations','exports')
        AND config_row.read_enabled
        AND (requested_gate_code<>'mutations' OR config_row.mutations_enabled)
        AND (requested_gate_code<>'exports' OR config_row.exports_enabled)
        AND (requested_gate_code='read'
          OR (requested_gate_code='mutations' AND requested_role_code IN ('eligibility_reviewer','reconciliation_operator','credit_adjuster'))
          OR (requested_gate_code='exports' AND requested_role_code='audit_exporter'));
      IF NOT role_ok OR NOT gate_ok OR requested_gate_code NOT IN ('read','mutations','exports') THEN
        result_code := 'denied';
      ELSIF requested_gate_code IN ('mutations','exports')
        AND (latest_reauth IS NULL OR NOT (latest_reauth>now_at-INTERVAL '5 minutes')) THEN
        result_code := 'reauth_required';
      ELSE
        result_code := 'authorized';
      END IF;
      IF result_code IN ('authorized','reauth_required') THEN
        UPDATE public.downtown_u_operator_sessions AS s
          SET last_seen_at=now_at,idle_expires_at=LEAST(now_at+INTERVAL '30 minutes',session_row.absolute_expires_at),updated_at=now_at
          WHERE s.id=session_row.id AND s.status='active';
        GET DIAGNOSTICS affected_rows = ROW_COUNT;
        IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count rolling session'; END IF;
        session_row.last_seen_at := now_at;
        session_row.idle_expires_at := LEAST(now_at+INTERVAL '30 minutes',session_row.absolute_expires_at);
      END IF;
    END IF;
  END IF;
  previous_setting := pg_catalog.current_setting('downtown_u.operator_write',true);
  PERFORM pg_catalog.set_config('downtown_u.operator_write',pg_catalog.pg_backend_pid()::TEXT||':'||pg_catalog.pg_current_xact_id()::TEXT,true);
  INSERT INTO public.downtown_u_operator_security_events(operator_id,session_id,event_code,outcome,correlation_id)
    VALUES(CASE WHEN session_row.id IS NULL THEN NULL ELSE session_row.operator_id END,
      CASE WHEN session_row.id IS NULL THEN NULL ELSE session_row.id END,
      CASE WHEN result_code='authorized' THEN 'success' ELSE evidence_code END,
      CASE WHEN result_code='authorized' THEN 'succeeded' WHEN result_code='reauth_required' THEN 'observed' ELSE 'denied' END,
      requested_correlation_id);
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count writing security event'; END IF;
  PERFORM pg_catalog.set_config('downtown_u.operator_write',COALESCE(previous_setting,''),true);
  IF result_code='invalid' THEN
    RETURN QUERY SELECT result_code,NULL::UUID,NULL::TEXT,NULL::TEXT[],NULL::TEXT,NULL::TIMESTAMPTZ,NULL::TIMESTAMPTZ,NULL::TIMESTAMPTZ;
  ELSE
    RETURN QUERY SELECT result_code,session_row.operator_id,account_row.display_name,roles,requested_gate_code,
      session_row.absolute_expires_at,session_row.idle_expires_at,latest_reauth;
  END IF;
END $function$;

CREATE FUNCTION public.downtown_u_operator_auth_begin_reauth(
  requested_session_id uuid, requested_session_version smallint, requested_session_verifier bytea,
  requested_challenge_id uuid, requested_challenge_version smallint, requested_challenge_verifier bytea,
  requested_correlation_id text)
RETURNS TABLE(outcome text,challenge_id uuid,normalized_phone text,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE
  session_row public.downtown_u_operator_sessions%ROWTYPE;
  account_row public.downtown_u_operator_accounts%ROWTYPE;
  config_row public.downtown_u_operator_config%ROWTYPE;
  now_at TIMESTAMPTZ := pg_catalog.clock_timestamp();
  rolled_idle TIMESTAMPTZ;
  challenge_expiry TIMESTAMPTZ;
  roles_count BIGINT;
  recent_minute BIGINT;
  recent_hour BIGINT;
  pending_count BIGINT;
  affected_rows BIGINT;
  previous_setting TEXT;
  valid_session BOOLEAN := false;
BEGIN
  IF requested_correlation_id IS NULL OR requested_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid correlation id';
  END IF;
  SELECT s.* INTO session_row FROM public.downtown_u_operator_sessions AS s WHERE s.id=requested_session_id FOR UPDATE;
  IF FOUND THEN
    SELECT a.* INTO STRICT account_row FROM public.downtown_u_operator_accounts AS a WHERE a.id=session_row.operator_id FOR UPDATE;
    SELECT c.* INTO STRICT config_row FROM public.downtown_u_operator_config AS c WHERE c.singleton=true FOR UPDATE;
    PERFORM 1 FROM public.downtown_u_operator_auth_challenges AS c
      WHERE c.session_id=session_row.id AND c.purpose='reauth' ORDER BY c.id FOR UPDATE;
    SELECT pg_catalog.count(*) INTO roles_count FROM public.downtown_u_operator_account_roles AS r
      WHERE r.account_id=session_row.operator_id AND r.revoked_at IS NULL;
    valid_session := session_row.status='active' AND requested_session_version=1
      AND session_row.verifier_version=requested_session_version
      AND requested_session_verifier IS NOT NULL AND pg_catalog.octet_length(requested_session_verifier)=32
      AND session_row.session_verifier=requested_session_verifier;
    IF valid_session AND (session_row.idle_expires_at<=now_at OR session_row.absolute_expires_at<=now_at) THEN
      UPDATE public.downtown_u_operator_sessions AS s SET status='expired',updated_at=now_at WHERE s.id=session_row.id AND s.status='active';
      GET DIAGNOSTICS affected_rows = ROW_COUNT;
      IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count expiring session'; END IF;
      valid_session := false;
    END IF;
  END IF;
  IF NOT valid_session OR account_row.status<>'active' OR roles_count<1 OR NOT config_row.read_enabled
    OR requested_challenge_id IS NULL OR requested_challenge_version<>1
    OR requested_challenge_verifier IS NULL OR pg_catalog.octet_length(requested_challenge_verifier)<>32 THEN
    RETURN QUERY SELECT 'invalid'::TEXT,NULL::UUID,NULL::TEXT,NULL::TIMESTAMPTZ;
    RETURN;
  END IF;
  SELECT pg_catalog.count(*) FILTER (WHERE c.created_at>now_at-INTERVAL '1 minute'),
         pg_catalog.count(*) FILTER (WHERE c.created_at>now_at-INTERVAL '1 hour')
    INTO recent_minute,recent_hour FROM public.downtown_u_operator_auth_challenges AS c
    WHERE c.session_id=session_row.id AND c.purpose='reauth' AND c.factor='sms_otp';
  IF recent_minute>=1 OR recent_hour>=5 THEN
    RETURN QUERY SELECT 'denied'::TEXT,NULL::UUID,NULL::TEXT,NULL::TIMESTAMPTZ;
    RETURN;
  END IF;
  SELECT pg_catalog.count(*) INTO pending_count FROM public.downtown_u_operator_auth_challenges AS c
    WHERE c.session_id=session_row.id AND c.purpose='reauth' AND c.factor='sms_otp' AND c.status='pending';
  UPDATE public.downtown_u_operator_auth_challenges AS c SET status='revoked',revoked_at=now_at,updated_at=now_at
    WHERE c.session_id=session_row.id AND c.purpose='reauth' AND c.factor='sms_otp' AND c.status='pending';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows<>pending_count THEN RAISE EXCEPTION 'unexpected row count revoking pending reauth'; END IF;
  rolled_idle := LEAST(now_at+INTERVAL '30 minutes',session_row.absolute_expires_at);
  challenge_expiry := LEAST(now_at+INTERVAL '5 minutes',rolled_idle,session_row.absolute_expires_at);
  INSERT INTO public.downtown_u_operator_auth_challenges
    (id,operator_id,session_id,purpose,factor,status,verifier_version,challenge_verifier,expires_at,created_at,updated_at)
    VALUES(requested_challenge_id,session_row.operator_id,session_row.id,'reauth','sms_otp','pending',1,
      requested_challenge_verifier,challenge_expiry,now_at,now_at);
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count inserting reauth challenge'; END IF;
  UPDATE public.downtown_u_operator_sessions AS s SET last_seen_at=now_at,idle_expires_at=rolled_idle,updated_at=now_at
    WHERE s.id=session_row.id AND s.status='active';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count rolling session'; END IF;
  previous_setting := pg_catalog.current_setting('downtown_u.operator_write',true);
  PERFORM pg_catalog.set_config('downtown_u.operator_write',pg_catalog.pg_backend_pid()::TEXT||':'||pg_catalog.pg_current_xact_id()::TEXT,true);
  INSERT INTO public.downtown_u_operator_security_events(operator_id,session_id,event_code,outcome,factor,correlation_id)
    VALUES(session_row.operator_id,session_row.id,'issuance','succeeded','sms_otp',requested_correlation_id);
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count writing security event'; END IF;
  PERFORM pg_catalog.set_config('downtown_u.operator_write',COALESCE(previous_setting,''),true);
  RETURN QUERY SELECT 'started'::TEXT,requested_challenge_id,account_row.normalized_phone,challenge_expiry;
END $function$;

CREATE FUNCTION public.downtown_u_operator_auth_finish_reauth(
  requested_session_id uuid, requested_session_version smallint, requested_session_verifier bytea,
  requested_challenge_id uuid, requested_challenge_version smallint, requested_challenge_verifier bytea,
  requested_correlation_id text)
RETURNS TABLE(outcome text,reauthenticated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE
  session_row public.downtown_u_operator_sessions%ROWTYPE;
  account_row public.downtown_u_operator_accounts%ROWTYPE;
  config_row public.downtown_u_operator_config%ROWTYPE;
  challenge_row public.downtown_u_operator_auth_challenges%ROWTYPE;
  now_at TIMESTAMPTZ := pg_catalog.clock_timestamp();
  roles_count BIGINT;
  affected_rows BIGINT;
  previous_setting TEXT;
  valid_session BOOLEAN := false;
  valid_proof BOOLEAN := false;
  evidence_code TEXT := 'failure';
BEGIN
  IF requested_correlation_id IS NULL OR requested_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid correlation id';
  END IF;
  SELECT s.* INTO session_row FROM public.downtown_u_operator_sessions AS s WHERE s.id=requested_session_id FOR UPDATE;
  IF FOUND THEN
    SELECT a.* INTO STRICT account_row FROM public.downtown_u_operator_accounts AS a WHERE a.id=session_row.operator_id FOR UPDATE;
    SELECT c.* INTO STRICT config_row FROM public.downtown_u_operator_config AS c WHERE c.singleton=true FOR UPDATE;
    SELECT c.* INTO challenge_row FROM public.downtown_u_operator_auth_challenges AS c
      WHERE c.id=requested_challenge_id FOR UPDATE;
    SELECT pg_catalog.count(*) INTO roles_count FROM public.downtown_u_operator_account_roles AS r
      WHERE r.account_id=session_row.operator_id AND r.revoked_at IS NULL;
    valid_session := session_row.status='active' AND requested_session_version=1
      AND session_row.verifier_version=requested_session_version
      AND requested_session_verifier IS NOT NULL AND pg_catalog.octet_length(requested_session_verifier)=32
      AND session_row.session_verifier=requested_session_verifier;
    IF valid_session AND (session_row.idle_expires_at<=now_at OR session_row.absolute_expires_at<=now_at) THEN
      UPDATE public.downtown_u_operator_sessions AS s SET status='expired',updated_at=now_at WHERE s.id=session_row.id AND s.status='active';
      GET DIAGNOSTICS affected_rows = ROW_COUNT;
      IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count expiring session'; END IF;
      valid_session := false;
      evidence_code := 'expiry';
    END IF;
    IF valid_session AND account_row.status='active' AND roles_count>0 AND config_row.read_enabled
      AND challenge_row.id IS NOT NULL AND challenge_row.operator_id=session_row.operator_id
      AND challenge_row.session_id=session_row.id AND challenge_row.purpose='reauth' AND challenge_row.factor='sms_otp' THEN
      IF challenge_row.status='pending' AND challenge_row.expires_at<=now_at THEN
        UPDATE public.downtown_u_operator_auth_challenges AS c SET status='expired',expired_at=now_at,updated_at=now_at
          WHERE c.id=challenge_row.id AND c.status='pending';
        GET DIAGNOSTICS affected_rows = ROW_COUNT;
        IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count expiring reauth challenge'; END IF;
        evidence_code := 'expiry';
      ELSE
        valid_proof := challenge_row.status='pending' AND challenge_row.expires_at>now_at
          AND requested_challenge_version=1 AND challenge_row.verifier_version=requested_challenge_version
          AND requested_challenge_verifier IS NOT NULL AND pg_catalog.octet_length(requested_challenge_verifier)=32
          AND challenge_row.challenge_verifier=requested_challenge_verifier;
        IF NOT valid_proof AND challenge_row.status='pending' AND challenge_row.attempt_count<5 THEN
          UPDATE public.downtown_u_operator_auth_challenges AS c SET attempt_count=c.attempt_count+1,
            status=CASE WHEN c.attempt_count+1>=5 THEN 'revoked' ELSE c.status END,
            revoked_at=CASE WHEN c.attempt_count+1>=5 THEN now_at ELSE c.revoked_at END,updated_at=now_at
            WHERE c.id=challenge_row.id;
          GET DIAGNOSTICS affected_rows = ROW_COUNT;
          IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count recording reauth attempt'; END IF;
        ELSIF challenge_row.status<>'pending' THEN evidence_code := 'replay';
        END IF;
      END IF;
    END IF;
  END IF;
  IF NOT valid_proof THEN
    previous_setting := pg_catalog.current_setting('downtown_u.operator_write',true);
    PERFORM pg_catalog.set_config('downtown_u.operator_write',pg_catalog.pg_backend_pid()::TEXT||':'||pg_catalog.pg_current_xact_id()::TEXT,true);
    INSERT INTO public.downtown_u_operator_security_events(operator_id,session_id,event_code,outcome,factor,correlation_id)
      VALUES(CASE WHEN session_row.id IS NULL THEN NULL ELSE session_row.operator_id END,
        CASE WHEN session_row.id IS NULL THEN NULL ELSE session_row.id END,evidence_code,'denied','sms_otp',requested_correlation_id);
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count writing security event'; END IF;
    PERFORM pg_catalog.set_config('downtown_u.operator_write',COALESCE(previous_setting,''),true);
    RETURN QUERY SELECT 'invalid'::TEXT,NULL::TIMESTAMPTZ;
    RETURN;
  END IF;
  UPDATE public.downtown_u_operator_auth_challenges AS c
    SET status='consumed',verified_at=now_at,consumed_at=now_at,updated_at=now_at
    WHERE c.id=challenge_row.id AND c.status='pending';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count consuming reauth challenge'; END IF;
  UPDATE public.downtown_u_operator_sessions AS s
    SET last_seen_at=now_at,idle_expires_at=LEAST(now_at+INTERVAL '30 minutes',session_row.absolute_expires_at),updated_at=now_at
    WHERE s.id=session_row.id AND s.status='active';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count rolling session'; END IF;
  previous_setting := pg_catalog.current_setting('downtown_u.operator_write',true);
  PERFORM pg_catalog.set_config('downtown_u.operator_write',pg_catalog.pg_backend_pid()::TEXT||':'||pg_catalog.pg_current_xact_id()::TEXT,true);
  INSERT INTO public.downtown_u_operator_security_events(operator_id,session_id,event_code,outcome,factor,correlation_id)
    VALUES(session_row.operator_id,session_row.id,'success','succeeded','sms_otp',requested_correlation_id);
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count writing security event'; END IF;
  PERFORM pg_catalog.set_config('downtown_u.operator_write',COALESCE(previous_setting,''),true);
  RETURN QUERY SELECT 'reauthenticated'::TEXT,now_at;
END $function$;

CREATE FUNCTION public.downtown_u_operator_auth_revoke_session(
  requested_session_id uuid, requested_session_version smallint, requested_session_verifier bytea,
  requested_correlation_id text)
RETURNS TABLE(outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE
  session_row public.downtown_u_operator_sessions%ROWTYPE;
  now_at TIMESTAMPTZ := pg_catalog.clock_timestamp();
  pending_count BIGINT;
  affected_rows BIGINT;
  previous_setting TEXT;
BEGIN
  IF requested_correlation_id IS NULL OR requested_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid correlation id';
  END IF;
  SELECT s.* INTO session_row FROM public.downtown_u_operator_sessions AS s WHERE s.id=requested_session_id FOR UPDATE;
  IF FOUND AND session_row.status='active' AND requested_session_version=1
    AND session_row.verifier_version=requested_session_version
    AND requested_session_verifier IS NOT NULL AND pg_catalog.octet_length(requested_session_verifier)=32
    AND session_row.session_verifier=requested_session_verifier THEN
    UPDATE public.downtown_u_operator_sessions AS s SET status='revoked',revoked_at=now_at,updated_at=now_at
      WHERE s.id=session_row.id AND s.status='active';
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count revoking session'; END IF;
    SELECT pg_catalog.count(*) INTO pending_count FROM public.downtown_u_operator_auth_challenges AS c
      WHERE c.session_id=session_row.id AND c.purpose='reauth' AND c.status='pending';
    UPDATE public.downtown_u_operator_auth_challenges AS c SET status='revoked',revoked_at=now_at,updated_at=now_at
      WHERE c.session_id=session_row.id AND c.purpose='reauth' AND c.status='pending';
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows<>pending_count THEN RAISE EXCEPTION 'unexpected row count revoking pending reauth'; END IF;
    previous_setting := pg_catalog.current_setting('downtown_u.operator_write',true);
    PERFORM pg_catalog.set_config('downtown_u.operator_write',pg_catalog.pg_backend_pid()::TEXT||':'||pg_catalog.pg_current_xact_id()::TEXT,true);
    INSERT INTO public.downtown_u_operator_security_events(operator_id,session_id,event_code,outcome,correlation_id)
      VALUES(session_row.operator_id,session_row.id,'revocation','succeeded',requested_correlation_id);
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count writing security event'; END IF;
    PERFORM pg_catalog.set_config('downtown_u.operator_write',COALESCE(previous_setting,''),true);
  END IF;
  RETURN QUERY SELECT 'accepted'::TEXT;
END $function$;

/* Keep the owner-controlled gate singleton present while allowing only gate values
 * and updated_at to change. This helper is executable by the trusted owner only. */
CREATE FUNCTION public.downtown_u_operator_config_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') OR NEW.singleton IS DISTINCT FROM OLD.singleton THEN
    RAISE EXCEPTION 'operator configuration singleton is immutable';
  END IF;
  RETURN NEW;
END $function$;
CREATE TRIGGER downtown_u_operator_config_guard
  BEFORE UPDATE OR DELETE ON public.downtown_u_operator_config
  FOR EACH ROW EXECUTE FUNCTION public.downtown_u_operator_config_guard();
CREATE TRIGGER downtown_u_operator_config_no_truncate
  BEFORE TRUNCATE ON public.downtown_u_operator_config
  FOR EACH STATEMENT EXECUTE FUNCTION public.downtown_u_operator_config_guard();

/* Capability ACL: schema resolution only, no relation/sequence/column access.
 * Ambient hostile defaults are normalized from catalogs before the allowlist. */
REVOKE CREATE ON SCHEMA public FROM downtown_u_operator_runtime;
GRANT USAGE ON SCHEMA public TO downtown_u_operator_runtime;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM downtown_u_operator_runtime;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM downtown_u_operator_runtime;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM downtown_u_operator_runtime;

DO $acl$
DECLARE migration_owner OID; capability_oid OID; target RECORD; allowlisted BOOLEAN;
BEGIN
  SELECT oid INTO STRICT migration_owner FROM pg_catalog.pg_roles WHERE rolname=CURRENT_USER;
  SELECT oid INTO STRICT capability_oid FROM pg_catalog.pg_roles WHERE rolname='downtown_u_operator_runtime';

  FOR target IN
    SELECT c.relname,c.relkind,c.relowner,acl.grantee,r.rolname grantee_name
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) acl
    LEFT JOIN pg_catalog.pg_roles r ON r.oid=acl.grantee
    WHERE n.nspname='public' AND c.relkind IN ('r','v','S')
      AND (c.relname LIKE 'downtown_u_operator_%' OR c.relname='downtown_u_eligibility_events') AND acl.grantee<>migration_owner
  LOOP
    IF target.relowner<>migration_owner THEN RAISE EXCEPTION 'operator relation is not migration-owner controlled';
    ELSIF target.grantee=0 THEN EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON %s %I.%I FROM PUBLIC',CASE WHEN target.relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END,'public',target.relname);
    ELSIF target.grantee_name IS NULL THEN RAISE EXCEPTION 'operator relation ACL references unknown role';
    ELSE EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON %s %I.%I FROM %I',CASE WHEN target.relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END,'public',target.relname,target.grantee_name);
    END IF;
  END LOOP;

  FOR target IN
    SELECT c.relname,a.attname,acl.grantee,r.rolname grantee_name
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) acl LEFT JOIN pg_catalog.pg_roles r ON r.oid=acl.grantee
    WHERE n.nspname='public' AND c.relkind IN ('r','v')
      AND (c.relname LIKE 'downtown_u_operator_%' OR c.relname='downtown_u_eligibility_events') AND acl.grantee<>migration_owner
  LOOP
    IF target.grantee=0 THEN EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES (%I) ON TABLE %I.%I FROM PUBLIC',target.attname,'public',target.relname);
    ELSIF target.grantee_name IS NULL THEN RAISE EXCEPTION 'operator column ACL references unknown role';
    ELSE EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES (%I) ON TABLE %I.%I FROM %I',target.attname,'public',target.relname,target.grantee_name);
    END IF;
  END LOOP;

  FOR target IN
    SELECT p.oid,p.proname,p.proowner,pg_catalog.pg_get_function_identity_arguments(p.oid) identity_arguments,
      acl.grantee,r.rolname grantee_name
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
    LEFT JOIN pg_catalog.pg_roles r ON r.oid=acl.grantee
    WHERE n.nspname='public' AND p.proname LIKE 'downtown_u_operator_%' AND acl.grantee<>migration_owner
  LOOP
    IF target.proowner<>migration_owner THEN RAISE EXCEPTION 'operator function is not migration-owner controlled';
    ELSIF target.grantee=0 THEN EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON FUNCTION %I.%I(%s) FROM PUBLIC','public',target.proname,target.identity_arguments);
    ELSIF target.grantee_name IS NULL THEN RAISE EXCEPTION 'operator function ACL references unknown role';
    ELSE EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON FUNCTION %I.%I(%s) FROM %I','public',target.proname,target.identity_arguments,target.grantee_name);
    END IF;
  END LOOP;
END $acl$;

GRANT EXECUTE ON FUNCTION public.downtown_u_operator_auth_begin(uuid,text,smallint,bytea,uuid,bytea,text) TO downtown_u_operator_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_operator_auth_verify_email(uuid,smallint,bytea,uuid,smallint,bytea,uuid,smallint,bytea,text) TO downtown_u_operator_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_operator_auth_finish_sign_in(uuid,smallint,bytea,uuid,smallint,bytea,uuid,smallint,bytea,text) TO downtown_u_operator_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_operator_auth_validate_session(uuid,smallint,bytea,text,text,text) TO downtown_u_operator_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_operator_auth_begin_reauth(uuid,smallint,bytea,uuid,smallint,bytea,text) TO downtown_u_operator_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_operator_auth_finish_reauth(uuid,smallint,bytea,uuid,smallint,bytea,text) TO downtown_u_operator_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_operator_auth_revoke_session(uuid,smallint,bytea,text) TO downtown_u_operator_runtime;

DO $assert$
DECLARE migration_owner OID; capability_oid OID;
BEGIN
  SELECT oid INTO STRICT migration_owner FROM pg_catalog.pg_roles WHERE rolname=CURRENT_USER;
  SELECT oid INTO STRICT capability_oid FROM pg_catalog.pg_roles WHERE rolname='downtown_u_operator_runtime';
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) acl
    WHERE n.nspname='public' AND c.relkind IN ('r','v','S')
      AND (c.relname LIKE 'downtown_u_operator_%' OR c.relname='downtown_u_eligibility_events')
      AND (c.relowner<>migration_owner OR acl.grantee<>migration_owner)
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) acl
    WHERE n.nspname='public' AND (c.relname LIKE 'downtown_u_operator_%' OR c.relname='downtown_u_eligibility_events') AND acl.grantee<>migration_owner
  ) THEN RAISE EXCEPTION 'non-owner operator relation ACL remains'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
    WHERE n.nspname='public' AND p.proname LIKE 'downtown_u_operator_%' AND
      (p.proowner<>migration_owner OR acl.grantee NOT IN (migration_owner,capability_oid)
       OR (acl.grantee=capability_oid AND (p.proname NOT IN ('downtown_u_operator_auth_begin','downtown_u_operator_auth_verify_email','downtown_u_operator_auth_finish_sign_in','downtown_u_operator_auth_validate_session','downtown_u_operator_auth_begin_reauth','downtown_u_operator_auth_finish_reauth','downtown_u_operator_auth_revoke_session')
         OR acl.privilege_type<>'EXECUTE' OR acl.is_grantable)))
  ) OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
    WHERE n.nspname='public' AND p.proname LIKE 'downtown_u_operator_auth_%' AND acl.grantee=capability_oid
      AND acl.privilege_type='EXECUTE' AND NOT acl.is_grantable)<>7
  THEN RAISE EXCEPTION 'operator function ACL is not exact'; END IF;
END $assert$;

COMMIT;
