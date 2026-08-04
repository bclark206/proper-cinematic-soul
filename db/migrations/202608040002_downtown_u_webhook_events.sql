BEGIN;

DO $role_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'downtown_u_runtime' AND NOT rolcanlogin
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Phase 2 requires the least-privilege downtown_u_runtime role from Phase 1';
  END IF;
END
$role_check$;

CREATE TABLE public.downtown_u_webhook_events (
  square_event_id TEXT PRIMARY KEY CHECK (square_event_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  event_type TEXT NOT NULL CHECK (length(event_type) <= 128 AND event_type ~ '^[a-z][a-z0-9_-]*([.][a-z][a-z0-9_-]*)+$'),
  raw_body_sha256 TEXT NOT NULL CHECK (raw_body_sha256 ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('new', 'processing', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 0 AND 1000),
  received_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  failure_code TEXT CHECK (failure_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  failure_detail TEXT CHECK (length(failure_detail) BETWEEN 1 AND 256 AND failure_detail ~ '^[ -~]+$'),
  claim_token UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  CHECK (
    (status = 'new' AND attempt_count = 0 AND started_at IS NULL AND completed_at IS NULL AND failed_at IS NULL AND failure_code IS NULL AND failure_detail IS NULL AND claim_token IS NULL)
    OR (status = 'processing' AND attempt_count BETWEEN 1 AND 1000 AND started_at IS NOT NULL AND completed_at IS NULL AND failed_at IS NULL AND failure_code IS NULL AND failure_detail IS NULL AND claim_token IS NOT NULL)
    OR (status = 'completed' AND attempt_count BETWEEN 1 AND 1000 AND started_at IS NOT NULL AND completed_at IS NOT NULL AND failed_at IS NULL AND failure_code IS NULL AND failure_detail IS NULL AND claim_token IS NULL)
    OR (status = 'failed' AND attempt_count BETWEEN 1 AND 1000 AND started_at IS NOT NULL AND completed_at IS NULL AND failed_at IS NOT NULL AND failure_code IS NOT NULL AND failure_detail IS NOT NULL AND claim_token IS NULL)
  ),
  CHECK (started_at IS NULL OR started_at >= received_at),
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  CHECK (failed_at IS NULL OR failed_at >= started_at),
  CHECK (updated_at >= created_at)
);

CREATE INDEX downtown_u_webhook_events_status_updated_idx ON public.downtown_u_webhook_events (status, updated_at);
CREATE INDEX downtown_u_webhook_events_received_idx ON public.downtown_u_webhook_events (received_at);

CREATE FUNCTION public.downtown_u_webhook_events_protect() RETURNS trigger
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
    OR (OLD.status = 'processing' AND NEW.status IN ('completed', 'failed') AND NEW.attempt_count = OLD.attempt_count)
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

CREATE TRIGGER downtown_u_webhook_events_protect_trigger
BEFORE UPDATE ON public.downtown_u_webhook_events
FOR EACH ROW EXECUTE FUNCTION public.downtown_u_webhook_events_protect();

CREATE FUNCTION public.downtown_u_claim_webhook_event(
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
  ELSIF existing.status = 'completed' THEN
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

CREATE FUNCTION public.downtown_u_complete_webhook_event(requested_event_id TEXT, requested_claim_token UUID)
RETURNS TABLE(transitioned BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  RETURN QUERY
  WITH changed AS (
    UPDATE public.downtown_u_webhook_events AS e
    SET status='completed', completed_at=pg_catalog.clock_timestamp(), claim_token=NULL,
        updated_at=pg_catalog.clock_timestamp()
    WHERE e.square_event_id=requested_event_id AND e.status='processing'
      AND e.claim_token=requested_claim_token
    RETURNING 1
  ) SELECT EXISTS(SELECT 1 FROM changed);
END
$function$;

CREATE FUNCTION public.downtown_u_fail_webhook_event(
  requested_event_id TEXT, requested_claim_token UUID, requested_failure_code TEXT, requested_failure_detail TEXT
) RETURNS TABLE(transitioned BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  IF requested_failure_code IS NULL OR requested_failure_code !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'Invalid webhook failure code' USING ERRCODE='22023';
  END IF;
  IF requested_failure_detail IS NULL OR length(requested_failure_detail) NOT BETWEEN 1 AND 256 OR requested_failure_detail !~ '^[ -~]+$' THEN
    RAISE EXCEPTION 'Invalid webhook failure detail' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH changed AS (
    UPDATE public.downtown_u_webhook_events AS e
    SET status='failed', failed_at=pg_catalog.clock_timestamp(), failure_code=requested_failure_code,
        failure_detail=requested_failure_detail, claim_token=NULL, updated_at=pg_catalog.clock_timestamp()
    WHERE e.square_event_id=requested_event_id AND e.status='processing'
      AND e.claim_token=requested_claim_token
    RETURNING 1
  ) SELECT EXISTS(SELECT 1 FROM changed);
END
$function$;

REVOKE ALL ON TABLE public.downtown_u_webhook_events FROM PUBLIC;
REVOKE ALL ON TABLE public.downtown_u_webhook_events FROM downtown_u_runtime;
REVOKE ALL ON FUNCTION public.downtown_u_webhook_events_protect() FROM PUBLIC, downtown_u_runtime;
REVOKE ALL ON FUNCTION public.downtown_u_claim_webhook_event(TEXT,TEXT,TEXT) FROM PUBLIC, downtown_u_runtime;
REVOKE ALL ON FUNCTION public.downtown_u_complete_webhook_event(TEXT,UUID) FROM PUBLIC, downtown_u_runtime;
REVOKE ALL ON FUNCTION public.downtown_u_fail_webhook_event(TEXT,UUID,TEXT,TEXT) FROM PUBLIC, downtown_u_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_claim_webhook_event(TEXT,TEXT,TEXT) TO downtown_u_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_complete_webhook_event(TEXT,UUID) TO downtown_u_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_fail_webhook_event(TEXT,UUID,TEXT,TEXT) TO downtown_u_runtime;

COMMIT;
