BEGIN;

/* Keyset indexes are deliberately aligned to the fixed list predicates. */
CREATE INDEX downtown_u_students_operator_status_created_idx
  ON public.downtown_u_students(eligibility_status,created_at DESC,id DESC);
CREATE INDEX downtown_u_students_operator_created_idx
  ON public.downtown_u_students(created_at DESC,id DESC);
CREATE INDEX downtown_u_plan_purchases_operator_status_created_idx
  ON public.downtown_u_plan_purchases(status,created_at DESC,id DESC);
CREATE INDEX downtown_u_plan_purchases_operator_student_created_idx
  ON public.downtown_u_plan_purchases(student_id,created_at DESC,id DESC);
CREATE INDEX downtown_u_plan_purchases_operator_created_idx
  ON public.downtown_u_plan_purchases(created_at DESC,id DESC);
CREATE INDEX downtown_u_redemptions_operator_status_created_idx
  ON public.downtown_u_redemptions(status,created_at DESC,id DESC);
CREATE INDEX downtown_u_redemptions_operator_student_created_idx
  ON public.downtown_u_redemptions(student_id,created_at DESC,id DESC);
CREATE INDEX downtown_u_redemptions_operator_created_idx
  ON public.downtown_u_redemptions(created_at DESC,id DESC);
CREATE INDEX downtown_u_operator_cases_created_idx
  ON public.downtown_u_operator_reconciliation_cases(created_at DESC,id DESC);
CREATE INDEX downtown_u_operator_cases_student_created_idx
  ON public.downtown_u_operator_reconciliation_cases(student_id,created_at DESC,id DESC);

/* Owner-only, transaction-local principal check. Public list functions supply one
 * of the fixed capability codes; no role name is accepted from their caller. */
CREATE FUNCTION public.downtown_u_operator_read_principal(
  requested_session_id uuid, requested_session_version smallint, requested_session_verifier bytea,
  requested_capability_code text, requested_correlation_id text)
RETURNS TABLE(outcome text,operator_id uuid,role_codes text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE
  session_row public.downtown_u_operator_sessions%ROWTYPE;
  account_row public.downtown_u_operator_accounts%ROWTYPE;
  config_row public.downtown_u_operator_config%ROWTYPE;
  roles TEXT[];
  now_at TIMESTAMPTZ:=pg_catalog.clock_timestamp();
  result_code TEXT:='invalid';
  previous_setting TEXT;
  affected_rows BIGINT;
  credential_ok BOOLEAN:=false;
  role_ok BOOLEAN:=false;
  evidence_code TEXT:='failure';
BEGIN
  IF requested_correlation_id IS NULL OR requested_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid correlation id';
  END IF;
  IF requested_capability_code NOT IN ('students_global','students_exact','purchases_global','purchases_exact',
    'redemptions_global','redemptions_exact','reconciliation_list') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid capability';
  END IF;

  SELECT s.* INTO session_row FROM public.downtown_u_operator_sessions AS s
    WHERE s.id=requested_session_id FOR UPDATE;
  IF FOUND THEN
    SELECT a.* INTO STRICT account_row FROM public.downtown_u_operator_accounts AS a
      WHERE a.id=session_row.operator_id FOR SHARE;
    SELECT c.* INTO STRICT config_row FROM public.downtown_u_operator_config AS c
      WHERE c.singleton=true FOR SHARE;
    PERFORM 1 FROM public.downtown_u_operator_account_roles AS r
      WHERE r.account_id=session_row.operator_id AND r.revoked_at IS NULL
      ORDER BY r.role_code,r.id FOR SHARE;
    SELECT pg_catalog.array_agg(r.role_code ORDER BY r.role_code) INTO roles
      FROM public.downtown_u_operator_account_roles AS r
      WHERE r.account_id=session_row.operator_id AND r.revoked_at IS NULL;

    credential_ok:=session_row.status='active' AND requested_session_version=1
      AND session_row.verifier_version=requested_session_version
      AND requested_session_verifier IS NOT NULL
      AND pg_catalog.octet_length(requested_session_verifier)=32
      AND session_row.session_verifier=requested_session_verifier;
    IF credential_ok AND (session_row.idle_expires_at<=now_at OR session_row.absolute_expires_at<=now_at) THEN
      UPDATE public.downtown_u_operator_sessions AS s SET status='expired',updated_at=now_at
        WHERE s.id=session_row.id AND s.status='active';
      GET DIAGNOSTICS affected_rows=ROW_COUNT;
      IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count expiring session'; END IF;
      credential_ok:=false; evidence_code:='expiry';
    END IF;
    IF credential_ok THEN
      role_ok:=CASE requested_capability_code
        WHEN 'students_global' THEN roles&&ARRAY['eligibility_reviewer','reconciliation_operator']::TEXT[]
        WHEN 'students_exact' THEN roles&&ARRAY['eligibility_reviewer','reconciliation_operator','credit_adjuster']::TEXT[]
        WHEN 'purchases_global' THEN 'reconciliation_operator'=ANY(roles)
        WHEN 'purchases_exact' THEN roles&&ARRAY['reconciliation_operator','credit_adjuster']::TEXT[]
        WHEN 'redemptions_global' THEN 'reconciliation_operator'=ANY(roles)
        WHEN 'redemptions_exact' THEN roles&&ARRAY['reconciliation_operator','credit_adjuster']::TEXT[]
        WHEN 'reconciliation_list' THEN 'reconciliation_operator'=ANY(roles)
        ELSE false END;
      IF account_row.status='active' AND config_row.read_enabled AND role_ok THEN
        result_code:='authorized';
        UPDATE public.downtown_u_operator_sessions AS s SET last_seen_at=now_at,
          idle_expires_at=LEAST(now_at+INTERVAL '30 minutes',session_row.absolute_expires_at),updated_at=now_at
          WHERE s.id=session_row.id AND s.status='active';
        GET DIAGNOSTICS affected_rows=ROW_COUNT;
        IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count rolling session'; END IF;
      ELSE result_code:='denied'; END IF;
    END IF;
  END IF;

  previous_setting:=pg_catalog.current_setting('downtown_u.operator_write',true);
  PERFORM pg_catalog.set_config('downtown_u.operator_write',pg_catalog.pg_backend_pid()::TEXT||':'||pg_catalog.pg_current_xact_id()::TEXT,true);
  INSERT INTO public.downtown_u_operator_security_events(operator_id,session_id,event_code,outcome,correlation_id)
    VALUES(CASE WHEN session_row.id IS NULL THEN NULL ELSE session_row.operator_id END,
      CASE WHEN session_row.id IS NULL THEN NULL ELSE session_row.id END,
      CASE WHEN result_code='authorized' THEN 'success' ELSE evidence_code END,
      CASE WHEN result_code='authorized' THEN 'succeeded' ELSE 'denied' END,requested_correlation_id);
  GET DIAGNOSTICS affected_rows=ROW_COUNT;
  IF affected_rows<>1 THEN RAISE EXCEPTION 'unexpected row count writing security event'; END IF;
  PERFORM pg_catalog.set_config('downtown_u.operator_write',COALESCE(previous_setting,''),true);
  IF result_code='invalid' THEN RETURN QUERY SELECT result_code,NULL::UUID,NULL::TEXT[];
  ELSE RETURN QUERY SELECT result_code,session_row.operator_id,roles; END IF;
END $function$;

CREATE FUNCTION public.downtown_u_operator_read_students(
  requested_session_id uuid, requested_session_version smallint, requested_session_verifier bytea,
  requested_correlation_id text, requested_limit integer, cursor_created_at timestamptz, cursor_id uuid,
  requested_eligibility_status text, requested_student_id uuid)
RETURNS TABLE(outcome text,items jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE principal RECORD; result_items JSONB;
BEGIN
  IF requested_limit IS NULL OR requested_limit NOT BETWEEN 1 AND 101
    OR (cursor_created_at IS NULL)<>(cursor_id IS NULL)
    OR (requested_eligibility_status IS NOT NULL AND requested_eligibility_status NOT IN ('pending','approved','rejected','suspended')) THEN
    RETURN QUERY SELECT 'invalid'::TEXT,NULL::JSONB; RETURN;
  END IF;
  SELECT * INTO STRICT principal FROM public.downtown_u_operator_read_principal(requested_session_id,requested_session_version,
    requested_session_verifier,CASE WHEN requested_student_id IS NULL THEN 'students_global' ELSE 'students_exact' END,requested_correlation_id);
  IF principal.outcome<>'authorized' THEN RETURN QUERY SELECT principal.outcome,NULL::JSONB; RETURN; END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(x.item ORDER BY x.created_at DESC,x.id DESC),'[]'::JSONB) INTO result_items FROM (
    SELECT s.id,s.created_at,pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'id',s.id,'eligibilityStatus',s.eligibility_status,
      'maskedEmail',CASE WHEN s.normalized_email IS NULL THEN NULL ELSE pg_catalog.left(s.normalized_email,1)||'***@'||
        pg_catalog.left(pg_catalog.split_part(s.normalized_email,'@',2),1)||'***'||
        pg_catalog.substring(pg_catalog.split_part(s.normalized_email,'@',2),'\.[^.]+$') END,
      'maskedPhone',CASE WHEN s.normalized_phone IS NULL THEN NULL ELSE '+'||pg_catalog.repeat('*',pg_catalog.length(s.normalized_phone)-5)||pg_catalog.right(s.normalized_phone,4) END,
      'eligibilityReviewedAt',s.eligibility_reviewed_at,'approvedAt',s.approved_at,'rejectedAt',s.rejected_at,
      'suspendedAt',s.suspended_at,'createdAt',s.created_at,'updatedAt',s.updated_at,'deletedAt',s.deleted_at)) item
    FROM public.downtown_u_students AS s WHERE (requested_student_id IS NULL OR s.id=requested_student_id)
      AND (requested_eligibility_status IS NULL OR s.eligibility_status=requested_eligibility_status)
      AND (cursor_created_at IS NULL OR (s.created_at,s.id)<(cursor_created_at,cursor_id))
    ORDER BY s.created_at DESC,s.id DESC LIMIT requested_limit) x;
  RETURN QUERY SELECT 'authorized'::TEXT,result_items;
END $function$;

CREATE FUNCTION public.downtown_u_operator_read_purchases(
  requested_session_id uuid, requested_session_version smallint, requested_session_verifier bytea,
  requested_correlation_id text, requested_limit integer, cursor_created_at timestamptz, cursor_id uuid,
  requested_status text, requested_student_id uuid, requested_purchase_id uuid)
RETURNS TABLE(outcome text,items jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE principal RECORD; result_items JSONB;
BEGIN
  IF requested_limit IS NULL OR requested_limit NOT BETWEEN 1 AND 101 OR (cursor_created_at IS NULL)<>(cursor_id IS NULL)
    OR (requested_status IS NOT NULL AND requested_status NOT IN ('paid','partially_refunded','refunded')) THEN
    RETURN QUERY SELECT 'invalid'::TEXT,NULL::JSONB; RETURN;
  END IF;
  SELECT * INTO STRICT principal FROM public.downtown_u_operator_read_principal(requested_session_id,requested_session_version,requested_session_verifier,
    CASE WHEN requested_student_id IS NULL AND requested_purchase_id IS NULL THEN 'purchases_global' ELSE 'purchases_exact' END,requested_correlation_id);
  IF principal.outcome<>'authorized' THEN RETURN QUERY SELECT principal.outcome,NULL::JSONB; RETURN; END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(x.item ORDER BY x.created_at DESC,x.id DESC),'[]'::JSONB) INTO result_items FROM (
    SELECT p.id,p.created_at,pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'id',p.id,'studentId',p.student_id,'planId',p.plan_id,'creditsGranted',p.credits_granted,'priceCents',p.price_cents,
      'currency',p.currency,'status',p.status,'refundedCredits',p.refunded_credits,'paidAt',p.paid_at,
      'refundedAt',p.refunded_at,'createdAt',p.created_at,'updatedAt',p.updated_at)) item
    FROM public.downtown_u_plan_purchases AS p WHERE (requested_student_id IS NULL OR p.student_id=requested_student_id)
      AND (requested_purchase_id IS NULL OR p.id=requested_purchase_id) AND (requested_status IS NULL OR p.status=requested_status)
      AND (cursor_created_at IS NULL OR (p.created_at,p.id)<(cursor_created_at,cursor_id))
    ORDER BY p.created_at DESC,p.id DESC LIMIT requested_limit) x;
  RETURN QUERY SELECT 'authorized'::TEXT,result_items;
END $function$;

CREATE FUNCTION public.downtown_u_operator_read_redemptions(
  requested_session_id uuid, requested_session_version smallint, requested_session_verifier bytea,
  requested_correlation_id text, requested_limit integer, cursor_created_at timestamptz, cursor_id uuid,
  requested_status text, requested_student_id uuid, requested_redemption_id uuid)
RETURNS TABLE(outcome text,items jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE principal RECORD; result_items JSONB;
BEGIN
  IF requested_limit IS NULL OR requested_limit NOT BETWEEN 1 AND 101 OR (cursor_created_at IS NULL)<>(cursor_id IS NULL)
    OR (requested_status IS NOT NULL AND requested_status NOT IN ('reserved','redeemed','reversed','cancelled')) THEN
    RETURN QUERY SELECT 'invalid'::TEXT,NULL::JSONB; RETURN;
  END IF;
  SELECT * INTO STRICT principal FROM public.downtown_u_operator_read_principal(requested_session_id,requested_session_version,requested_session_verifier,
    CASE WHEN requested_student_id IS NULL AND requested_redemption_id IS NULL THEN 'redemptions_global' ELSE 'redemptions_exact' END,requested_correlation_id);
  IF principal.outcome<>'authorized' THEN RETURN QUERY SELECT principal.outcome,NULL::JSONB; RETURN; END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(x.item ORDER BY x.created_at DESC,x.id DESC),'[]'::JSONB) INTO result_items FROM (
    SELECT r.id,r.created_at,pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'id',r.id,'studentId',r.student_id,'mealName',s.meal_display_name,'credits',r.credits,'status',r.status,
      'reservedAt',r.reserved_at,'expiresAt',r.expires_at,'redeemedAt',r.redeemed_at,'reversedAt',r.reversed_at,
      'createdAt',r.created_at,'updatedAt',r.updated_at)) item
    FROM public.downtown_u_redemptions AS r JOIN public.downtown_u_reservation_snapshots AS s ON s.redemption_id=r.id
    WHERE (requested_student_id IS NULL OR r.student_id=requested_student_id)
      AND (requested_redemption_id IS NULL OR r.id=requested_redemption_id) AND (requested_status IS NULL OR r.status=requested_status)
      AND (cursor_created_at IS NULL OR (r.created_at,r.id)<(cursor_created_at,cursor_id))
    ORDER BY r.created_at DESC,r.id DESC LIMIT requested_limit) x;
  RETURN QUERY SELECT 'authorized'::TEXT,result_items;
END $function$;

CREATE FUNCTION public.downtown_u_operator_read_reconciliation(
  requested_session_id uuid, requested_session_version smallint, requested_session_verifier bytea,
  requested_correlation_id text, requested_limit integer, cursor_created_at timestamptz, cursor_id uuid,
  requested_state text, requested_category text, requested_student_id uuid, requested_case_id uuid)
RETURNS TABLE(outcome text,items jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE principal RECORD; result_items JSONB;
BEGIN
  IF requested_limit IS NULL OR requested_limit NOT BETWEEN 1 AND 101 OR (cursor_created_at IS NULL)<>(cursor_id IS NULL)
    OR (requested_state IS NOT NULL AND requested_state NOT IN ('needs_review','resolved'))
    OR (requested_category IS NOT NULL AND requested_category NOT IN ('payment_follow_up','kitchen_follow_up')) THEN
    RETURN QUERY SELECT 'invalid'::TEXT,NULL::JSONB; RETURN;
  END IF;
  SELECT * INTO STRICT principal FROM public.downtown_u_operator_read_principal(requested_session_id,requested_session_version,requested_session_verifier,
    'reconciliation_list',requested_correlation_id);
  IF principal.outcome<>'authorized' THEN RETURN QUERY SELECT principal.outcome,NULL::JSONB; RETURN; END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(x.item ORDER BY x.created_at DESC,x.id DESC),'[]'::JSONB) INTO result_items FROM (
    SELECT c.id,c.created_at,pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'id',c.id,'studentId',c.student_id,'category',CASE c.source_type WHEN 'refund' THEN 'payment_follow_up' ELSE 'kitchen_follow_up' END,
      'state',CASE WHEN r.id IS NULL THEN 'needs_review' ELSE 'resolved' END,'openedAt',c.created_at,'resolvedAt',r.created_at)) item
    FROM public.downtown_u_operator_reconciliation_cases AS c
    LEFT JOIN public.downtown_u_operator_reconciliation_resolutions AS r ON r.case_id=c.id
    WHERE (requested_student_id IS NULL OR c.student_id=requested_student_id)
      AND (requested_case_id IS NULL OR c.id=requested_case_id)
      AND (requested_category IS NULL OR requested_category=CASE c.source_type WHEN 'refund' THEN 'payment_follow_up' ELSE 'kitchen_follow_up' END)
      AND (requested_state IS NULL OR requested_state=CASE WHEN r.id IS NULL THEN 'needs_review' ELSE 'resolved' END)
      AND (cursor_created_at IS NULL OR (c.created_at,c.id)<(cursor_created_at,cursor_id))
    ORDER BY c.created_at DESC,c.id DESC LIMIT requested_limit) x;
  RETURN QUERY SELECT 'authorized'::TEXT,result_items;
END $function$;

/* Re-normalize ambient defaults, then expose exactly seven auth plus four reads. */
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
DO $assert$
DECLARE migration_owner OID; capability_oid OID;
BEGIN
  SELECT oid INTO STRICT migration_owner FROM pg_catalog.pg_roles WHERE rolname=CURRENT_USER;
  SELECT oid INTO STRICT capability_oid FROM pg_catalog.pg_roles WHERE rolname='downtown_u_operator_runtime';
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
    WHERE n.nspname='public' AND p.proname LIKE 'downtown_u_operator_%' AND
      (p.proowner<>migration_owner OR acl.grantee NOT IN (migration_owner,capability_oid)
       OR (acl.grantee=capability_oid AND (p.proname NOT IN ('downtown_u_operator_auth_begin','downtown_u_operator_auth_verify_email',
       'downtown_u_operator_auth_finish_sign_in','downtown_u_operator_auth_validate_session','downtown_u_operator_auth_begin_reauth',
       'downtown_u_operator_auth_finish_reauth','downtown_u_operator_auth_revoke_session','downtown_u_operator_read_students',
       'downtown_u_operator_read_purchases','downtown_u_operator_read_redemptions','downtown_u_operator_read_reconciliation')
       OR acl.privilege_type<>'EXECUTE' OR acl.is_grantable)))
  ) OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
    WHERE n.nspname='public' AND p.proname LIKE 'downtown_u_operator_%' AND acl.grantee=capability_oid
      AND acl.privilege_type='EXECUTE' AND NOT acl.is_grantable)<>11
  THEN RAISE EXCEPTION 'operator function ACL is not exact'; END IF;
END $assert$;

COMMIT;
