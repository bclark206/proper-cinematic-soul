BEGIN;

/* Migration 009 predates mutation responses. Preserve the exact response as
 * append-only evidence rather than reconstructing it from a mutable student. */
ALTER TABLE public.downtown_u_eligibility_events ADD COLUMN result_item JSONB;
ALTER TABLE public.downtown_u_eligibility_events
  ADD CONSTRAINT downtown_u_eligibility_events_result_item_shape_check CHECK (
    result_item IS NULL OR (
      pg_catalog.jsonb_typeof(result_item)='object'
      AND (result_item - ARRAY['studentId','eligibilityStatus','eligibilityReviewedAt','approvedAt','rejectedAt','suspendedAt','updatedAt'])='{}'::JSONB
      AND result_item ?& ARRAY['studentId','eligibilityStatus','eligibilityReviewedAt','updatedAt']
      AND pg_catalog.jsonb_typeof(result_item->'studentId')='string'
      AND pg_catalog.jsonb_typeof(result_item->'eligibilityStatus')='string'
      AND result_item->>'eligibilityStatus' IN ('approved','rejected','suspended')
      AND pg_catalog.jsonb_typeof(result_item->'eligibilityReviewedAt')='string'
      AND pg_catalog.jsonb_typeof(result_item->'updatedAt')='string'
      AND (NOT result_item?'approvedAt' OR pg_catalog.jsonb_typeof(result_item->'approvedAt')='string')
      AND (NOT result_item?'rejectedAt' OR pg_catalog.jsonb_typeof(result_item->'rejectedAt')='string')
      AND (NOT result_item?'suspendedAt' OR pg_catalog.jsonb_typeof(result_item->'suspendedAt')='string')
    ));
ALTER TABLE public.downtown_u_eligibility_events
  ADD CONSTRAINT downtown_u_eligibility_events_result_item_not_null_check CHECK (result_item IS NOT NULL) NOT VALID;

CREATE FUNCTION public.downtown_u_operator_set_eligibility(
  requested_session_id uuid,
  requested_session_version smallint,
  requested_session_verifier bytea,
  requested_server_correlation_id text,
  requested_idempotency_key text,
  requested_audit_event_id uuid,
  requested_eligibility_event_id uuid,
  requested_student_id uuid,
  requested_expected_status text,
  requested_expected_updated_at timestamptz,
  requested_decision text,
  requested_reason_code text,
  requested_reason text
)
RETURNS TABLE(outcome text,replayed boolean,item jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE
  session_row public.downtown_u_operator_sessions%ROWTYPE;
  account_row public.downtown_u_operator_accounts%ROWTYPE;
  config_row public.downtown_u_operator_config%ROWTYPE;
  student_row public.downtown_u_students%ROWTYPE;
  audit_row public.downtown_u_operator_audit_events%ROWTYPE;
  event_row public.downtown_u_eligibility_events%ROWTYPE;
  now_at TIMESTAMPTZ := pg_catalog.clock_timestamp();
  latest_reauth TIMESTAMPTZ;
  action_code TEXT;
  next_status TEXT;
  result_item JSONB;
  previous_setting TEXT;
  affected_rows BIGINT;
  topology_count BIGINT;
  cross_domain_count BIGINT;
  role_ok BOOLEAN := false;
  credential_ok BOOLEAN := false;
  intent_valid BOOLEAN := false;
BEGIN
  now_at := pg_catalog.date_trunc('milliseconds',now_at);
  action_code := CASE requested_decision
    WHEN 'approve' THEN 'eligibility_approve'
    WHEN 'reject' THEN 'eligibility_reject'
    WHEN 'suspend' THEN 'eligibility_suspend'
    WHEN 'reinstate' THEN 'eligibility_reinstate'
    ELSE NULL END;
  next_status := CASE requested_decision
    WHEN 'approve' THEN 'approved'
    WHEN 'reject' THEN 'rejected'
    WHEN 'suspend' THEN 'suspended'
    WHEN 'reinstate' THEN 'approved'
    ELSE NULL END;

  IF requested_server_correlation_id IS NULL
     OR requested_server_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$'
     OR requested_idempotency_key IS NULL
     OR requested_idempotency_key !~ '^opm:v1:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$'
     OR requested_audit_event_id IS NULL OR requested_eligibility_event_id IS NULL
     OR requested_student_id IS NULL OR requested_expected_updated_at IS NULL
     OR requested_expected_status IS NULL
     OR requested_expected_status NOT IN ('pending','approved','rejected','suspended')
     OR action_code IS NULL
     OR requested_reason_code IS NULL
     OR requested_reason_code NOT IN ('documentation_verified','documentation_incomplete','policy_ineligible','safety_hold','policy_hold','hold_cleared')
     OR requested_reason IS NULL
     OR NOT (requested_reason=pg_catalog.normalize(requested_reason,'NFC'))
     OR NOT (requested_reason=pg_catalog.btrim(requested_reason))
     OR pg_catalog.length(requested_reason) NOT BETWEEN 1 AND 500
     OR requested_reason ~ '[[:cntrl:]]' THEN
    RETURN QUERY SELECT 'invalid'::TEXT,false,NULL::JSONB;
    RETURN;
  END IF;

  intent_valid := (requested_decision='approve' AND requested_reason_code='documentation_verified')
    OR (requested_decision='reject' AND requested_reason_code IN ('documentation_incomplete','policy_ineligible'))
    OR (requested_decision='suspend' AND requested_reason_code IN ('safety_hold','policy_hold'))
    OR (requested_decision='reinstate' AND requested_reason_code='hold_cleared');

  /* The authorization lock order is shared by all operator capabilities. */
  SELECT s.* INTO session_row FROM public.downtown_u_operator_sessions AS s
    WHERE s.id=requested_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::TEXT,false,NULL::JSONB;
    RETURN;
  END IF;
  SELECT a.* INTO STRICT account_row FROM public.downtown_u_operator_accounts AS a
    WHERE a.id=session_row.operator_id FOR SHARE;
  SELECT c.* INTO STRICT config_row FROM public.downtown_u_operator_config AS c
    WHERE c.singleton=true FOR SHARE;
  PERFORM 1 FROM public.downtown_u_operator_account_roles AS r
    WHERE r.account_id=session_row.operator_id AND r.revoked_at IS NULL
    ORDER BY r.role_code,r.id FOR SHARE;
  SELECT pg_catalog.bool_or(r.role_code='eligibility_reviewer') INTO role_ok
    FROM public.downtown_u_operator_account_roles AS r
    WHERE r.account_id=session_row.operator_id AND r.revoked_at IS NULL;

  credential_ok := COALESCE(session_row.status='active'
    AND requested_session_version=1
    AND session_row.verifier_version=requested_session_version
    AND requested_session_verifier IS NOT NULL
    AND pg_catalog.octet_length(requested_session_verifier)=32
    AND session_row.session_verifier=requested_session_verifier,false);
  IF NOT COALESCE(credential_ok,false) THEN
    RETURN QUERY SELECT 'invalid'::TEXT,false,NULL::JSONB;
    RETURN;
  END IF;
  IF session_row.idle_expires_at<=now_at OR session_row.absolute_expires_at<=now_at THEN
    UPDATE public.downtown_u_operator_sessions AS s SET status='expired',updated_at=now_at
      WHERE s.id=session_row.id AND s.status='active';
    RETURN QUERY SELECT 'invalid'::TEXT,false,NULL::JSONB;
    RETURN;
  END IF;
  IF COALESCE(account_row.status<>'active',true) OR NOT COALESCE(config_row.read_enabled,false)
     OR NOT COALESCE(config_row.mutations_enabled,false) OR NOT COALESCE(role_ok,false) THEN
    RETURN QUERY SELECT 'denied'::TEXT,false,NULL::JSONB;
    RETURN;
  END IF;

  SELECT pg_catalog.max(c.consumed_at) INTO latest_reauth
    FROM public.downtown_u_operator_auth_challenges AS c
    WHERE c.session_id=session_row.id AND c.operator_id=session_row.operator_id
      AND c.purpose='reauth' AND c.factor='sms_otp' AND c.status='consumed'
      AND c.consumed_at>now_at-INTERVAL '5 minutes'
      AND c.consumed_at<=now_at;
  UPDATE public.downtown_u_operator_sessions AS s
    SET last_seen_at=now_at,idle_expires_at=LEAST(now_at+INTERVAL '30 minutes',session_row.absolute_expires_at),updated_at=now_at
    WHERE s.id=session_row.id AND s.status='active';
  IF latest_reauth IS NULL THEN
    RETURN QUERY SELECT 'reauth_required'::TEXT,false,NULL::JSONB;
    RETURN;
  END IF;

  /* A global key lock makes the audit idempotency namespace authoritative. */
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('operator_mutation:'||requested_idempotency_key,0));
  /* Caller-selected IDs are locked too, so a concurrent new key cannot escape
   * as a raw unique violation between the collision precheck and insert. */
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('operator_audit_id:'||requested_audit_event_id::TEXT,0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('operator_eligibility_id:'||requested_eligibility_event_id::TEXT,0));
  SELECT a.* INTO audit_row FROM public.downtown_u_operator_audit_events AS a
    WHERE a.idempotency_key=requested_idempotency_key;
  IF FOUND THEN
    SELECT pg_catalog.count(*) INTO topology_count
      FROM public.downtown_u_eligibility_events AS e WHERE e.audit_event_id=audit_row.id;
    SELECT (SELECT pg_catalog.count(*) FROM public.downtown_u_operator_reconciliation_cases AS c WHERE c.audit_event_id=audit_row.id)
      +(SELECT pg_catalog.count(*) FROM public.downtown_u_operator_reconciliation_resolutions AS r WHERE r.audit_event_id=audit_row.id)
      +(SELECT pg_catalog.count(*) FROM public.downtown_u_operator_adjustments AS x WHERE x.audit_event_id=audit_row.id)
      INTO cross_domain_count;
    IF audit_row.operator_id<>session_row.operator_id
       OR audit_row.action_code<>action_code OR audit_row.target_type<>'student'
       OR audit_row.target_id<>requested_student_id::TEXT
       OR audit_row.reason_code<>requested_reason_code OR audit_row.reason<>requested_reason
       OR NOT COALESCE(intent_valid,false) OR topology_count<>1 OR cross_domain_count<>0 THEN
      RETURN QUERY SELECT 'idempotency_conflict'::TEXT,false,NULL::JSONB;
      RETURN;
    END IF;
    SELECT e.* INTO event_row FROM public.downtown_u_eligibility_events AS e
      WHERE e.audit_event_id=audit_row.id;
    IF event_row.operator_id<>audit_row.operator_id OR event_row.session_id<>audit_row.session_id
       OR event_row.student_id<>requested_student_id OR event_row.idempotency_key<>requested_idempotency_key
       OR event_row.correlation_id<>audit_row.correlation_id
       OR event_row.reason_code<>requested_reason_code OR event_row.reason<>requested_reason
       OR event_row.from_status=event_row.to_status OR event_row.to_status<>next_status
       OR event_row.created_at<>audit_row.created_at OR event_row.result_item IS NULL
       OR pg_catalog.jsonb_typeof(event_row.result_item)<>'object'
       OR (event_row.result_item - ARRAY['studentId','eligibilityStatus','eligibilityReviewedAt','approvedAt','rejectedAt','suspendedAt','updatedAt'])<>'{}'::JSONB
       OR NOT (event_row.result_item ?& ARRAY['studentId','eligibilityStatus','eligibilityReviewedAt','updatedAt'])
       OR event_row.result_item->'studentId'<>pg_catalog.to_jsonb(event_row.student_id)
       OR event_row.result_item->'eligibilityStatus'<>pg_catalog.to_jsonb(event_row.to_status)
       OR event_row.result_item->'eligibilityReviewedAt'<>pg_catalog.to_jsonb(pg_catalog.to_char(event_row.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
       OR event_row.result_item->'updatedAt'<>pg_catalog.to_jsonb(pg_catalog.to_char(event_row.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
       OR (event_row.result_item?'approvedAt' AND pg_catalog.jsonb_typeof(event_row.result_item->'approvedAt')<>'string')
       OR (event_row.result_item?'rejectedAt' AND pg_catalog.jsonb_typeof(event_row.result_item->'rejectedAt')<>'string')
       OR (event_row.result_item?'suspendedAt' AND pg_catalog.jsonb_typeof(event_row.result_item->'suspendedAt')<>'string')
       OR NOT ((requested_decision='approve' AND event_row.from_status='pending' AND event_row.to_status='approved')
         OR (requested_decision='reject' AND event_row.from_status='pending' AND event_row.to_status='rejected')
         OR (requested_decision='suspend' AND event_row.from_status='approved' AND event_row.to_status='suspended')
         OR (requested_decision='reinstate' AND event_row.from_status='suspended' AND event_row.to_status='approved'))
       OR (requested_decision='approve' AND (NOT event_row.result_item?'approvedAt'
         OR event_row.result_item->'approvedAt'<>pg_catalog.to_jsonb(pg_catalog.to_char(event_row.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
         OR event_row.result_item?'rejectedAt' OR event_row.result_item?'suspendedAt'))
       OR (requested_decision='reject' AND (NOT event_row.result_item?'rejectedAt'
         OR event_row.result_item->'rejectedAt'<>pg_catalog.to_jsonb(pg_catalog.to_char(event_row.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
         OR event_row.result_item?'approvedAt' OR event_row.result_item?'suspendedAt'))
       OR (requested_decision='suspend' AND (NOT event_row.result_item?'suspendedAt'
         OR event_row.result_item->'suspendedAt'<>pg_catalog.to_jsonb(pg_catalog.to_char(event_row.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
         OR NOT event_row.result_item?'approvedAt' OR event_row.result_item?'rejectedAt'))
       OR (requested_decision='reinstate' AND (event_row.result_item?'suspendedAt'
         OR NOT event_row.result_item?'approvedAt' OR event_row.result_item?'rejectedAt')) THEN
      RETURN QUERY SELECT 'idempotency_conflict'::TEXT,false,NULL::JSONB;
      RETURN;
    END IF;
    result_item := event_row.result_item;
    RETURN QUERY SELECT 'updated'::TEXT,true,result_item;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.downtown_u_operator_audit_events WHERE id=requested_audit_event_id)
     OR EXISTS (SELECT 1 FROM public.downtown_u_eligibility_events WHERE id=requested_eligibility_event_id) THEN
    RETURN QUERY SELECT 'idempotency_conflict'::TEXT,false,NULL::JSONB;
    RETURN;
  END IF;

  IF NOT COALESCE(intent_valid,false) THEN
    RETURN QUERY SELECT 'invalid'::TEXT,false,NULL::JSONB;
    RETURN;
  END IF;

  SELECT s.* INTO student_row FROM public.downtown_u_students AS s
    WHERE s.id=requested_student_id AND s.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT,false,NULL::JSONB;
    RETURN;
  END IF;
  IF student_row.eligibility_status<>requested_expected_status
     OR student_row.updated_at<>requested_expected_updated_at THEN
    RETURN QUERY SELECT 'stale_state'::TEXT,false,NULL::JSONB;
    RETURN;
  END IF;
  IF NOT ((student_row.eligibility_status='pending' AND requested_decision='approve' AND next_status='approved')
       OR (student_row.eligibility_status='pending' AND requested_decision='reject' AND next_status='rejected')
       OR (student_row.eligibility_status='approved' AND requested_decision='suspend' AND next_status='suspended')
       OR (student_row.eligibility_status='suspended' AND requested_decision='reinstate' AND next_status='approved')) THEN
    RETURN QUERY SELECT 'conflict'::TEXT,false,NULL::JSONB;
    RETURN;
  END IF;

  result_item:=pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'studentId',student_row.id,'eligibilityStatus',next_status,
    'eligibilityReviewedAt',pg_catalog.to_char(now_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'approvedAt',pg_catalog.to_char((CASE WHEN requested_decision='approve' THEN now_at ELSE student_row.approved_at END) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'rejectedAt',pg_catalog.to_char((CASE WHEN requested_decision='reject' THEN now_at ELSE student_row.rejected_at END) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'suspendedAt',pg_catalog.to_char((CASE WHEN requested_decision='suspend' THEN now_at WHEN requested_decision='reinstate' THEN NULL ELSE student_row.suspended_at END) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',pg_catalog.to_char(now_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));

  UPDATE public.downtown_u_students AS s SET
    eligibility_status=next_status,eligibility_reviewed_at=now_at,updated_at=now_at,
    approved_at=CASE WHEN requested_decision='approve' THEN now_at ELSE s.approved_at END,
    rejected_at=CASE WHEN requested_decision='reject' THEN now_at ELSE s.rejected_at END,
    suspended_at=CASE WHEN requested_decision='suspend' THEN now_at WHEN requested_decision='reinstate' THEN NULL ELSE s.suspended_at END
    WHERE s.id=student_row.id;
  GET DIAGNOSTICS affected_rows=ROW_COUNT;
  IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count updating eligibility'; END IF;

  previous_setting:=pg_catalog.current_setting('downtown_u.operator_write',true);
  PERFORM pg_catalog.set_config('downtown_u.operator_write',pg_catalog.pg_backend_pid()::TEXT||':'||pg_catalog.pg_current_xact_id()::TEXT,true);
  INSERT INTO public.downtown_u_operator_audit_events
    (id,operator_id,session_id,action_code,target_type,target_id,reason_code,reason,idempotency_key,correlation_id,created_at)
    VALUES(requested_audit_event_id,session_row.operator_id,session_row.id,action_code,'student',student_row.id::TEXT,
      requested_reason_code,requested_reason,requested_idempotency_key,requested_server_correlation_id,now_at);
  GET DIAGNOSTICS affected_rows=ROW_COUNT;
  IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count inserting audit event'; END IF;
  INSERT INTO public.downtown_u_eligibility_events
    (id,operator_id,session_id,student_id,from_status,to_status,reason_code,reason,idempotency_key,correlation_id,audit_event_id,created_at,result_item)
    VALUES(requested_eligibility_event_id,session_row.operator_id,session_row.id,student_row.id,student_row.eligibility_status,next_status,
      requested_reason_code,requested_reason,requested_idempotency_key,requested_server_correlation_id,requested_audit_event_id,now_at,result_item);
  GET DIAGNOSTICS affected_rows=ROW_COUNT;
  IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count inserting eligibility event'; END IF;
  PERFORM pg_catalog.set_config('downtown_u.operator_write',COALESCE(previous_setting,''),true);

  RETURN QUERY SELECT 'updated'::TEXT,false,result_item;
END $function$;

/* Re-normalize ambient defaults and expose exactly twelve capabilities. */
REVOKE CREATE ON SCHEMA public FROM downtown_u_operator_runtime;
GRANT USAGE ON SCHEMA public TO downtown_u_operator_runtime;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM downtown_u_operator_runtime;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM downtown_u_operator_runtime;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM downtown_u_operator_runtime;
DO $acl$
DECLARE migration_owner OID; target RECORD;
BEGIN
  SELECT oid INTO STRICT migration_owner FROM pg_catalog.pg_roles WHERE rolname=CURRENT_USER;
  FOR target IN SELECT p.proname,p.proowner,pg_catalog.pg_get_function_identity_arguments(p.oid) args,acl.grantee,r.rolname
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
    LEFT JOIN pg_catalog.pg_roles r ON r.oid=acl.grantee
    WHERE n.nspname='public' AND p.proname LIKE 'downtown_u_operator_%' AND acl.grantee<>migration_owner
  LOOP
    IF target.proowner<>migration_owner THEN RAISE EXCEPTION 'operator function is not migration-owner controlled';
    ELSIF target.grantee=0 THEN EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON FUNCTION %I.%I(%s) FROM PUBLIC','public',target.proname,target.args);
    ELSIF target.rolname IS NULL THEN RAISE EXCEPTION 'operator function ACL references unknown role';
    ELSE EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON FUNCTION %I.%I(%s) FROM %I','public',target.proname,target.args,target.rolname); END IF;
  END LOOP;
END $acl$;
GRANT EXECUTE ON FUNCTION public.downtown_u_operator_auth_begin(uuid,text,smallint,bytea,uuid,bytea,text) TO downtown_u_operator_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_operator_auth_verify_email(uuid,smallint,bytea,uuid,smallint,bytea,uuid,smallint,bytea,text) TO downtown_u_operator_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_operator_auth_finish_sign_in(uuid,smallint,bytea,uuid,smallint,bytea,uuid,smallint,bytea,text) TO downtown_u_operator_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_operator_auth_validate_session(uuid,smallint,bytea,text,text,text) TO downtown_u_operator_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_operator_auth_begin_reauth(uuid,smallint,bytea,uuid,smallint,bytea,text) TO downtown_u_operator_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_operator_auth_finish_reauth(uuid,smallint,bytea,uuid,smallint,bytea,text) TO downtown_u_operator_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_operator_auth_revoke_session(uuid,smallint,bytea,text) TO downtown_u_operator_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_operator_read_students(uuid,smallint,bytea,text,integer,timestamptz,uuid,text,uuid) TO downtown_u_operator_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_operator_read_purchases(uuid,smallint,bytea,text,integer,timestamptz,uuid,text,uuid,uuid) TO downtown_u_operator_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_operator_read_redemptions(uuid,smallint,bytea,text,integer,timestamptz,uuid,text,uuid,uuid) TO downtown_u_operator_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_operator_read_reconciliation(uuid,smallint,bytea,text,integer,timestamptz,uuid,text,text,uuid,uuid) TO downtown_u_operator_runtime;
GRANT EXECUTE ON FUNCTION public.downtown_u_operator_set_eligibility(uuid,smallint,bytea,text,text,uuid,uuid,uuid,text,timestamptz,text,text,text) TO downtown_u_operator_runtime;
DO $assert$
DECLARE migration_owner OID; capability_oid OID;
BEGIN
  SELECT oid INTO STRICT migration_owner FROM pg_catalog.pg_roles WHERE rolname=CURRENT_USER;
  SELECT oid INTO STRICT capability_oid FROM pg_catalog.pg_roles WHERE rolname='downtown_u_operator_runtime';
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
    WHERE n.nspname='public' AND p.proname LIKE 'downtown_u_operator_%'
      AND (p.proowner<>migration_owner OR acl.grantee NOT IN (migration_owner,capability_oid)
        OR (acl.grantee=capability_oid AND (acl.privilege_type<>'EXECUTE' OR acl.is_grantable))))
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
      WHERE n.nspname='public' AND p.proname LIKE 'downtown_u_operator_%' AND acl.grantee=capability_oid
        AND acl.privilege_type='EXECUTE' AND NOT acl.is_grantable)<>12
  THEN RAISE EXCEPTION 'operator function ACL is not exact'; END IF;
END $assert$;

COMMIT;
