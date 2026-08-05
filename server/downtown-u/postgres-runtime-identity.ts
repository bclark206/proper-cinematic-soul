import type { PoolClient } from "pg";

export type Queryable = Pick<PoolClient, "query">;

interface IdentityRow { safe_runtime_identity: boolean; }

/** Fail closed unless the connection authenticates directly as the exact bounded runtime identity. */
export function assertDowntownURuntimeIdentity(queryable: Queryable): Promise<void> {
  return queryable.query<IdentityRow>(`
    WITH identity AS (
      SELECT r.oid, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
             r.rolreplication, r.rolbypassrls
      FROM pg_catalog.pg_roles AS r WHERE r.rolname = CURRENT_USER
    ), runtime_role AS (
      SELECT r.oid, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
             r.rolreplication, r.rolbypassrls
      FROM pg_catalog.pg_roles AS r WHERE r.rolname = 'downtown_u_runtime'
    ), jobs_role AS (
      SELECT r.oid, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
             r.rolreplication, r.rolbypassrls
      FROM pg_catalog.pg_roles AS r WHERE r.rolname = 'downtown_u_jobs'
    ), expected_relations (
      relname, columns, table_select, table_insert, table_update, table_delete,
      table_truncate, table_references, table_trigger, insert_columns, update_columns
    ) AS (VALUES
      ('downtown_u_plans', ARRAY['id','credits','price_cents','active']::text[],
        true,false,false,false,false,false,false, ARRAY[]::text[], ARRAY[]::text[]),
      ('downtown_u_students', ARRAY['id','normalized_email','normalized_phone','square_customer_id','eligibility_status','credit_balance','eligibility_reviewed_at','approved_at','rejected_at','suspended_at','created_at','updated_at','deleted_at']::text[],
        false,false,false,false,false,false,false, ARRAY[]::text[], ARRAY[]::text[]),
      ('downtown_u_plan_purchases', ARRAY['id','student_id','plan_id','credits_granted','price_cents','currency','square_payment_id','square_order_id','source_event_id','status','refunded_credits','paid_at','refunded_at','created_at','updated_at','authoritative_paid_at','authoritative_normalized_email','authoritative_normalized_phone','authoritative_square_customer_id']::text[],
        false,false,false,false,false,false,false,
        ARRAY[]::text[], ARRAY[]::text[]),
      ('downtown_u_redemptions', ARRAY['id','student_id','credits','idempotency_key','status','square_order_id','reserved_at','redeemed_at','reversed_at','expires_at','created_at','updated_at']::text[],
        false,false,false,false,false,false,false, ARRAY[]::text[], ARRAY[]::text[]),
      ('downtown_u_credit_transactions', ARRAY['id','student_id','purchase_id','redemption_id','delta','resulting_balance','transaction_type','reason','idempotency_key','actor_type','actor_id','source_type','source_id','metadata','created_at','ledger_sequence']::text[],
        false,false,false,false,false,false,false, ARRAY[]::text[], ARRAY[]::text[]),
      ('downtown_u_balance_update_authorizations', ARRAY['backend_pid','transaction_id','student_id','new_balance']::text[],
        false,false,false,false,false,false,false, ARRAY[]::text[], ARRAY[]::text[]),
      ('downtown_u_webhook_events', ARRAY['square_event_id','event_type','raw_body_sha256','status','attempt_count','received_at','started_at','completed_at','failed_at','failure_code','failure_detail','claim_token','created_at','updated_at']::text[],
        false,false,false,false,false,false,false, ARRAY[]::text[], ARRAY[]::text[]),
      ('downtown_u_refund_applications', ARRAY['id','square_refund_id','source_event_id','square_payment_id','square_order_id','purchase_id','student_id','authoritative_amount_cents','authoritative_currency','authoritative_location_id','authoritative_updated_at','refund_sequence','cumulative_refunded_cents','target_refunded_credits','credit_delta','available_credits_before','status','created_at','applied_at']::text[],
        false,false,false,false,false,false,false, ARRAY[]::text[], ARRAY[]::text[]),
      ('downtown_u_refund_reconciliations', ARRAY['id','refund_application_id','purchase_id','student_id','reason_code','required_credits','available_credits','status','created_at']::text[],
        false,false,false,false,false,false,false, ARRAY[]::text[], ARRAY[]::text[]),
      ('downtown_u_auth_challenges', ARRAY['challenge_id','contact_type','normalized_contact','student_id','method','verifier_version','verifier_digest','expires_at','max_attempts','attempt_count','consumed_at','revoked_at','status','created_at']::text[],
        false,false,false,false,false,false,false, ARRAY[]::text[], ARRAY[]::text[]),
      ('downtown_u_auth_sessions', ARRAY['session_id','student_id','verifier_version','token_digest','issued_at','expires_at','revoked_at','last_seen_at']::text[],
        false,false,false,false,false,false,false, ARRAY[]::text[], ARRAY[]::text[]),
      ('downtown_u_meal_rules', ARRAY['id','display_name','square_catalog_object_id','base_credits','active','available_from','available_until','created_at','updated_at']::text[],
        false,false,false,false,false,false,false, ARRAY[]::text[], ARRAY[]::text[]),
      ('downtown_u_meal_modifiers', ARRAY['id','meal_id','display_name','square_catalog_object_id','credit_delta','active','created_at','updated_at']::text[],
        false,false,false,false,false,false,false, ARRAY[]::text[], ARRAY[]::text[]),
      ('downtown_u_reservation_snapshots', ARRAY['redemption_id','meal_rule_id','meal_public_id','meal_display_name','meal_square_catalog_object_id','modifiers','credits','created_at']::text[],
        false,false,false,false,false,false,false, ARRAY[]::text[], ARRAY[]::text[])
    ), downtown_relations AS (
      SELECT c.oid, c.relname, c.relowner
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname LIKE 'downtown!_u!_%' ESCAPE '!'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    ), downtown_sequences AS (
      SELECT c.oid
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname LIKE 'downtown!_u!_%' ESCAPE '!'
        AND c.relkind = 'S'
    ), expected_columns AS (
      SELECT e.relname, expanded.attname
      FROM expected_relations AS e
      CROSS JOIN LATERAL unnest(e.columns) AS expanded(attname)
    ), downtown_columns AS (
      SELECT d.oid, d.relname, a.attname
      FROM downtown_relations AS d
      JOIN pg_catalog.pg_attribute AS a ON a.attrelid = d.oid
      WHERE a.attnum > 0 AND NOT a.attisdropped
    ), expected_auth_columns (
      relname, attnum, attname, formatted_type, not_null, default_expression,
      identity_kind, generated_kind
    ) AS (VALUES
      ('downtown_u_auth_challenges',1,'challenge_id','text',true,NULL::text,'',''),
      ('downtown_u_auth_challenges',2,'contact_type','text',true,NULL::text,'',''),
      ('downtown_u_auth_challenges',3,'normalized_contact','text',true,NULL::text,'',''),
      ('downtown_u_auth_challenges',4,'student_id','uuid',false,NULL::text,'',''),
      ('downtown_u_auth_challenges',5,'method','text',true,NULL::text,'',''),
      ('downtown_u_auth_challenges',6,'verifier_version','smallint',true,NULL::text,'',''),
      ('downtown_u_auth_challenges',7,'verifier_digest','bytea',true,NULL::text,'',''),
      ('downtown_u_auth_challenges',8,'expires_at','timestamp with time zone',true,NULL::text,'',''),
      ('downtown_u_auth_challenges',9,'max_attempts','smallint',true,NULL::text,'',''),
      ('downtown_u_auth_challenges',10,'attempt_count','smallint',true,'0','',''),
      ('downtown_u_auth_challenges',11,'consumed_at','timestamp with time zone',false,NULL::text,'',''),
      ('downtown_u_auth_challenges',12,'revoked_at','timestamp with time zone',false,NULL::text,'',''),
      ('downtown_u_auth_challenges',13,'status','text',true,'''active''::text','',''),
      ('downtown_u_auth_challenges',14,'created_at','timestamp with time zone',true,'clock_timestamp()','',''),
      ('downtown_u_auth_sessions',1,'session_id','text',true,NULL::text,'',''),
      ('downtown_u_auth_sessions',2,'student_id','uuid',true,NULL::text,'',''),
      ('downtown_u_auth_sessions',3,'verifier_version','smallint',true,NULL::text,'',''),
      ('downtown_u_auth_sessions',4,'token_digest','bytea',true,NULL::text,'',''),
      ('downtown_u_auth_sessions',5,'issued_at','timestamp with time zone',true,'clock_timestamp()','',''),
      ('downtown_u_auth_sessions',6,'expires_at','timestamp with time zone',true,NULL::text,'',''),
      ('downtown_u_auth_sessions',7,'revoked_at','timestamp with time zone',false,NULL::text,'',''),
      ('downtown_u_auth_sessions',8,'last_seen_at','timestamp with time zone',true,'clock_timestamp()','','')
    ), auth_relation_catalog AS (
      SELECT d.oid, d.relname, c.relkind, c.relpersistence, c.relrowsecurity,
        c.relforcerowsecurity, c.relreplident, c.reloptions, c.relispartition,
        c.relhasrules, c.relam, am.amname AS access_method
      FROM downtown_relations AS d
      JOIN pg_catalog.pg_class AS c ON c.oid=d.oid
      LEFT JOIN pg_catalog.pg_am AS am ON am.oid=c.relam
      WHERE d.relname IN ('downtown_u_auth_challenges','downtown_u_auth_sessions')
    ), auth_rewrite_rules AS (
      SELECT r.oid, r.ev_class
      FROM pg_catalog.pg_rewrite AS r
      JOIN auth_relation_catalog AS c ON c.oid=r.ev_class
    ), auth_columns AS (
      SELECT d.relname, a.attnum::integer AS attnum, a.attname,
        pg_catalog.format_type(a.atttypid,a.atttypmod) AS formatted_type,
        a.attnotnull AS not_null, pg_catalog.pg_get_expr(ad.adbin,ad.adrelid,true) AS default_expression,
        a.attidentity::text AS identity_kind, a.attgenerated::text AS generated_kind, a.attisdropped
      FROM downtown_relations AS d
      JOIN pg_catalog.pg_attribute AS a ON a.attrelid=d.oid AND a.attnum>0
      LEFT JOIN pg_catalog.pg_attrdef AS ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
      WHERE d.relname IN ('downtown_u_auth_challenges','downtown_u_auth_sessions')
        AND NOT a.attisdropped
    ), expected_auth_constraints (relname, conname, constraint_type, definition) AS (VALUES
      ('downtown_u_auth_challenges','downtown_u_auth_challenges_challenge_id_check','c','CHECK (challenge_id ~ ''^[A-Za-z0-9_-]{32,96}$''::text)'),
      ('downtown_u_auth_challenges','downtown_u_auth_challenges_check','c','CHECK (contact_type = ''email''::text AND normalized_contact = lower(btrim(normalized_contact)) AND length(normalized_contact) <= 254 AND normalized_contact ~ ''^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$''::text OR contact_type = ''phone''::text AND normalized_contact ~ ''^[+][1-9][0-9]{7,14}$''::text)'),
      ('downtown_u_auth_challenges','downtown_u_auth_challenges_check1','c','CHECK (contact_type = ''email''::text AND method = ''email_magic_link''::text OR contact_type = ''phone''::text AND method = ''sms_otp''::text)'),
      ('downtown_u_auth_challenges','downtown_u_auth_challenges_check2','c','CHECK (attempt_count >= 0 AND attempt_count <= max_attempts)'),
      ('downtown_u_auth_challenges','downtown_u_auth_challenges_check3','c','CHECK (expires_at > created_at AND expires_at <= (created_at + ''00:30:00''::interval))'),
      ('downtown_u_auth_challenges','downtown_u_auth_challenges_check4','c','CHECK (status = ''active''::text AND consumed_at IS NULL AND revoked_at IS NULL AND attempt_count < max_attempts OR status = ''consumed''::text AND consumed_at IS NOT NULL AND revoked_at IS NULL OR (status = ANY (ARRAY[''expired''::text, ''exhausted''::text])) AND consumed_at IS NULL AND revoked_at IS NULL OR status = ''revoked''::text AND consumed_at IS NULL AND revoked_at IS NOT NULL)'),
      ('downtown_u_auth_challenges','downtown_u_auth_challenges_contact_type_check','c','CHECK (contact_type = ANY (ARRAY[''email''::text, ''phone''::text]))'),
      ('downtown_u_auth_challenges','downtown_u_auth_challenges_max_attempts_check','c','CHECK (max_attempts >= 1 AND max_attempts <= 10)'),
      ('downtown_u_auth_challenges','downtown_u_auth_challenges_pkey','p','PRIMARY KEY (challenge_id)'),
      ('downtown_u_auth_challenges','downtown_u_auth_challenges_status_check','c','CHECK (status = ANY (ARRAY[''active''::text, ''consumed''::text, ''expired''::text, ''exhausted''::text, ''revoked''::text]))'),
      ('downtown_u_auth_challenges','downtown_u_auth_challenges_student_id_fkey','f','FOREIGN KEY (student_id) REFERENCES downtown_u_students(id) ON DELETE RESTRICT'),
      ('downtown_u_auth_challenges','downtown_u_auth_challenges_verifier_digest_check','c','CHECK (octet_length(verifier_digest) = 32)'),
      ('downtown_u_auth_challenges','downtown_u_auth_challenges_verifier_version_check','c','CHECK (verifier_version = 1)'),
      ('downtown_u_auth_sessions','downtown_u_auth_sessions_check','c','CHECK (expires_at > issued_at AND expires_at <= (issued_at + ''31 days''::interval))'),
      ('downtown_u_auth_sessions','downtown_u_auth_sessions_check1','c','CHECK (last_seen_at >= issued_at AND last_seen_at <= expires_at)'),
      ('downtown_u_auth_sessions','downtown_u_auth_sessions_check2','c','CHECK (revoked_at IS NULL OR revoked_at >= issued_at)'),
      ('downtown_u_auth_sessions','downtown_u_auth_sessions_pkey','p','PRIMARY KEY (session_id)'),
      ('downtown_u_auth_sessions','downtown_u_auth_sessions_session_id_check','c','CHECK (session_id ~ ''^[A-Za-z0-9_-]{32,96}$''::text)'),
      ('downtown_u_auth_sessions','downtown_u_auth_sessions_student_id_fkey','f','FOREIGN KEY (student_id) REFERENCES downtown_u_students(id) ON DELETE RESTRICT'),
      ('downtown_u_auth_sessions','downtown_u_auth_sessions_token_digest_check','c','CHECK (octet_length(token_digest) = 32)'),
      ('downtown_u_auth_sessions','downtown_u_auth_sessions_token_digest_key','u','UNIQUE (token_digest)'),
      ('downtown_u_auth_sessions','downtown_u_auth_sessions_verifier_version_check','c','CHECK (verifier_version = 1)')
    ), auth_constraints AS (
      SELECT d.relname, x.conname, x.contype::text AS constraint_type,
        pg_catalog.pg_get_constraintdef(x.oid,true) AS definition
      FROM downtown_relations AS d JOIN pg_catalog.pg_constraint AS x ON x.conrelid=d.oid
      WHERE d.relname IN ('downtown_u_auth_challenges','downtown_u_auth_sessions')
    ), expected_auth_indexes (relname, index_name, definition, predicate) AS (VALUES
      ('downtown_u_auth_challenges','downtown_u_auth_challenges_contact_rate_idx','CREATE INDEX downtown_u_auth_challenges_contact_rate_idx ON downtown_u_auth_challenges USING btree (contact_type, normalized_contact, method, created_at DESC)',NULL::text),
      ('downtown_u_auth_challenges','downtown_u_auth_challenges_one_active','CREATE UNIQUE INDEX downtown_u_auth_challenges_one_active ON downtown_u_auth_challenges USING btree (contact_type, normalized_contact, method) WHERE status = ''active''::text','status = ''active''::text'),
      ('downtown_u_auth_challenges','downtown_u_auth_challenges_pkey','CREATE UNIQUE INDEX downtown_u_auth_challenges_pkey ON downtown_u_auth_challenges USING btree (challenge_id)',NULL::text),
      ('downtown_u_auth_sessions','downtown_u_auth_sessions_pkey','CREATE UNIQUE INDEX downtown_u_auth_sessions_pkey ON downtown_u_auth_sessions USING btree (session_id)',NULL::text),
      ('downtown_u_auth_sessions','downtown_u_auth_sessions_student_idx','CREATE INDEX downtown_u_auth_sessions_student_idx ON downtown_u_auth_sessions USING btree (student_id, expires_at)',NULL::text),
      ('downtown_u_auth_sessions','downtown_u_auth_sessions_token_digest_key','CREATE UNIQUE INDEX downtown_u_auth_sessions_token_digest_key ON downtown_u_auth_sessions USING btree (token_digest)',NULL::text)
    ), auth_indexes AS (
      SELECT d.relname, i.relname AS index_name, pg_catalog.pg_get_indexdef(i.oid,0,true) AS definition,
        pg_catalog.pg_get_expr(x.indpred,x.indrelid,true) AS predicate
      FROM downtown_relations AS d JOIN pg_catalog.pg_index AS x ON x.indrelid=d.oid
      JOIN pg_catalog.pg_class AS i ON i.oid=x.indexrelid
      WHERE d.relname IN ('downtown_u_auth_challenges','downtown_u_auth_sessions')
    ), auth_relation_acls AS (
      SELECT d.oid, d.relowner, acl.grantee, acl.grantor, acl.privilege_type, acl.is_grantable
      FROM downtown_relations AS d JOIN pg_catalog.pg_class AS c ON c.oid=d.oid
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,
        pg_catalog.acldefault('r',d.relowner))) AS acl
      WHERE d.relname IN ('downtown_u_auth_challenges','downtown_u_auth_sessions')
    ), auth_column_acls AS (
      SELECT d.oid, a.attname, acl.grantee, acl.grantor, acl.privilege_type, acl.is_grantable
      FROM downtown_relations AS d JOIN pg_catalog.pg_attribute AS a ON a.attrelid=d.oid AND a.attnum>0
      CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) AS acl
      WHERE d.relname IN ('downtown_u_auth_challenges','downtown_u_auth_sessions')
    ), expected_portal_relation_fingerprints (relname, expected_sha256) AS (VALUES
      ('downtown_u_meal_modifiers','c38c3eb77413cf4b8c7de7484794ac5831ee398b6542f490540557d4d13f9352'),
      ('downtown_u_meal_rules','a92657c07620bd2652fbe00ea61f9b3bbd4aa9d188c967cd3b10e98bbaa09994'),
      ('downtown_u_reservation_snapshots','a7b764c571ca95184997a5241036f1be515bed9f51cd2abf5051cbc9c52169c2')
    ), portal_relation_fingerprints AS (
      /* PG16-pinned complete descriptors: columns/types/null/default/identity/generated,
       * relation flags/access method, inheritance/rules, constraints/indexes/predicates,
       * and normalized relation plus column ACL topology. */
      SELECT c.relname, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
        'relation',pg_catalog.jsonb_build_object('relkind',c.relkind,'persistence',c.relpersistence,'rowsecurity',c.relrowsecurity,'forcerowsecurity',c.relforcerowsecurity,'replident',c.relreplident,'options',c.reloptions,'ispartition',c.relispartition,'hasrules',c.relhasrules,'access_method',am.amname),
        'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('attnum',a.attnum,'name',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',pg_catalog.pg_get_expr(ad.adbin,ad.adrelid,true),'identity',a.attidentity,'generated',a.attgenerated,'acl',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('grantee_owner',z.grantee=c.relowner,'grantor_owner',z.grantor=c.relowner,'privilege',z.privilege_type,'grantable',z.is_grantable) ORDER BY z.grantee,z.privilege_type),'[]'::jsonb) FROM pg_catalog.aclexplode(a.attacl) z)) ORDER BY a.attnum) FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
        'constraints',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',x.conname,'type',x.contype,'definition',pg_catalog.pg_get_constraintdef(x.oid,true)) ORDER BY x.conname),'[]'::jsonb) FROM pg_catalog.pg_constraint x WHERE x.conrelid=c.oid),
        'indexes',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',i.relname,'definition',pg_catalog.pg_get_indexdef(i.oid,0,true),'predicate',pg_catalog.pg_get_expr(x.indpred,x.indrelid,true)) ORDER BY i.relname),'[]'::jsonb) FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=c.oid),
        'relation_acl',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('grantee_owner',z.grantee=c.relowner,'grantor_owner',z.grantor=c.relowner,'privilege',z.privilege_type,'grantable',z.is_grantable) ORDER BY z.grantee,z.privilege_type),'[]'::jsonb) FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) z),
        'inherits',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('child',h.inhrelid::pg_catalog.regclass::text,'parent',h.inhparent::pg_catalog.regclass::text,'seq',h.inhseqno) ORDER BY h.inhseqno),'[]'::jsonb) FROM pg_catalog.pg_inherits h WHERE h.inhrelid=c.oid OR h.inhparent=c.oid),
        'rules',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.pg_get_ruledef(r.oid,true) ORDER BY r.rulename),'[]'::jsonb) FROM pg_catalog.pg_rewrite r WHERE r.ev_class=c.oid)
      )::text,'UTF8')),'hex') AS descriptor_sha256
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_catalog.pg_am am ON am.oid=c.relam JOIN expected_portal_relation_fingerprints e ON e.relname=c.relname
      WHERE n.nspname='public'
    ), expected_functions (
      proname, identity_arguments, expected_oid, allow_execute, security_definer
    ) AS (VALUES
      ('downtown_u_protect_plan_economics', '', pg_catalog.to_regprocedure('public.downtown_u_protect_plan_economics()')::oid, false, false),
      ('downtown_u_apply_credit_transaction', '', pg_catalog.to_regprocedure('public.downtown_u_apply_credit_transaction()')::oid, false, true),
      ('downtown_u_reject_direct_balance_update', '', pg_catalog.to_regprocedure('public.downtown_u_reject_direct_balance_update()')::oid, false, true),
      ('downtown_u_protect_purchase_fields', '', pg_catalog.to_regprocedure('public.downtown_u_protect_purchase_fields()')::oid, false, false),
      ('downtown_u_protect_redemption_fields', '', pg_catalog.to_regprocedure('public.downtown_u_protect_redemption_fields()')::oid, false, false),
      ('downtown_u_reject_credit_transaction_mutation', '', pg_catalog.to_regprocedure('public.downtown_u_reject_credit_transaction_mutation()')::oid, false, false),
      ('downtown_u_require_trusted_purchase_grant', '', pg_catalog.to_regprocedure('public.downtown_u_require_trusted_purchase_grant()')::oid, false, false),
      ('downtown_u_reject_refund_record_mutation', '', pg_catalog.to_regprocedure('public.downtown_u_reject_refund_record_mutation()')::oid, false, false),
      ('downtown_u_webhook_events_protect', '', pg_catalog.to_regprocedure('public.downtown_u_webhook_events_protect()')::oid, false, false),
      ('downtown_u_claim_webhook_event', 'text, text, text', pg_catalog.to_regprocedure('public.downtown_u_claim_webhook_event(text,text,text)')::oid, true, true),
      ('downtown_u_complete_webhook_event', 'text, uuid', pg_catalog.to_regprocedure('public.downtown_u_complete_webhook_event(text,uuid)')::oid, true, true),
      ('downtown_u_fail_webhook_event', 'text, uuid, text, text', pg_catalog.to_regprocedure('public.downtown_u_fail_webhook_event(text,uuid,text,text)')::oid, true, true),
      ('downtown_u_reject_webhook_event', 'text, uuid, text, text', pg_catalog.to_regprocedure('public.downtown_u_reject_webhook_event(text,uuid,text,text)')::oid, true, true),
      ('downtown_u_upsert_pending_student', 'text, text, text', pg_catalog.to_regprocedure('public.downtown_u_upsert_pending_student(text,text,text)')::oid, true, true),
      ('downtown_u_activate_verified_payment', 'text, uuid, text, text, text, text, integer, integer, text, text, text, text, text, text',
        pg_catalog.to_regprocedure('public.downtown_u_activate_verified_payment(text,uuid,text,text,text,text,integer,integer,text,text,text,text,text,text)')::oid, true, true),
      ('downtown_u_activate_verified_refund', 'text, uuid, text, text, text, text, integer, text, text, text',
        pg_catalog.to_regprocedure('public.downtown_u_activate_verified_refund(text,uuid,text,text,text,text,integer,text,text,text)')::oid, true, true),
      ('downtown_u_auth_protect_challenge', '', pg_catalog.to_regprocedure('public.downtown_u_auth_protect_challenge()')::oid, false, false),
      ('downtown_u_auth_protect_session', '', pg_catalog.to_regprocedure('public.downtown_u_auth_protect_session()')::oid, false, false),
      ('downtown_u_create_auth_challenge', 'text, text, text, text, smallint, bytea', pg_catalog.to_regprocedure('public.downtown_u_create_auth_challenge(text,text,text,text,smallint,bytea)')::oid, true, true),
      ('downtown_u_consume_auth_challenge', 'text, smallint, bytea, text, smallint, bytea', pg_catalog.to_regprocedure('public.downtown_u_consume_auth_challenge(text,smallint,bytea,text,smallint,bytea)')::oid, true, true),
      ('downtown_u_validate_auth_session', 'text, smallint, bytea', pg_catalog.to_regprocedure('public.downtown_u_validate_auth_session(text,smallint,bytea)')::oid, true, true),
      ('downtown_u_revoke_auth_session', 'text, smallint, bytea', pg_catalog.to_regprocedure('public.downtown_u_revoke_auth_session(text,smallint,bytea)')::oid, true, true),
      ('downtown_u_student_principal', 'text, smallint, bytea', pg_catalog.to_regprocedure('public.downtown_u_student_principal(text,smallint,bytea)')::oid, false, true),
      ('downtown_u_student_me', 'text, smallint, bytea', pg_catalog.to_regprocedure('public.downtown_u_student_me(text,smallint,bytea)')::oid, true, true),
      ('downtown_u_student_meals', 'text, smallint, bytea', pg_catalog.to_regprocedure('public.downtown_u_student_meals(text,smallint,bytea)')::oid, true, true),
      ('downtown_u_student_purchases', 'text, smallint, bytea, integer, timestamp with time zone, uuid', pg_catalog.to_regprocedure('public.downtown_u_student_purchases(text,smallint,bytea,integer,timestamp with time zone,uuid)')::oid, true, true),
      ('downtown_u_student_reservations', 'text, smallint, bytea, integer, timestamp with time zone, uuid', pg_catalog.to_regprocedure('public.downtown_u_student_reservations(text,smallint,bytea,integer,timestamp with time zone,uuid)')::oid, true, true),
      ('downtown_u_student_reserve', 'text, smallint, bytea, text, text[], text', pg_catalog.to_regprocedure('public.downtown_u_student_reserve(text,smallint,bytea,text,text[],text)')::oid, true, true),
      ('downtown_u_student_reverse', 'text, smallint, bytea, uuid, text', pg_catalog.to_regprocedure('public.downtown_u_student_reverse(text,smallint,bytea,uuid,text)')::oid, true, true),
      ('downtown_u_reverse_expired_reservations', 'integer', pg_catalog.to_regprocedure('public.downtown_u_reverse_expired_reservations(integer)')::oid, false, true),
      ('downtown_u_reject_reservation_snapshot_mutation', '', pg_catalog.to_regprocedure('public.downtown_u_reject_reservation_snapshot_mutation()')::oid, false, false),
      ('downtown_u_valid_modifier_snapshot', 'jsonb', pg_catalog.to_regprocedure('public.downtown_u_valid_modifier_snapshot(jsonb)')::oid, false, false)
    ), downtown_functions AS (
      SELECT p.oid, p.proname, pg_catalog.oidvectortypes(p.proargtypes) AS identity_arguments,
             p.proowner, p.prosecdef, l.lanname, p.proconfig, p.proacl
      FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
      WHERE n.nspname = 'public' AND p.proname LIKE 'downtown!_u!_%' ESCAPE '!'
    ), expected_auth_function_fingerprints (function_oid, expected_sha256) AS (VALUES
      (pg_catalog.to_regprocedure('public.downtown_u_auth_protect_challenge()')::oid, '8e044f7c953a183c1d8489df99d3e9592bd14045add0066e164fbe86077f904e'),
      (pg_catalog.to_regprocedure('public.downtown_u_auth_protect_session()')::oid, '30d1854c0d7c4ecaa987f340cf22d519455aaa8f4b0d809b3d4d947338723ad6'),
      (pg_catalog.to_regprocedure('public.downtown_u_consume_auth_challenge(text,smallint,bytea,text,smallint,bytea)')::oid, 'cd7a4bb26a06f1a33afa4a55760af214ec9c8d646e95479d24cfeef900df98bc'),
      (pg_catalog.to_regprocedure('public.downtown_u_create_auth_challenge(text,text,text,text,smallint,bytea)')::oid, '8a50348b98628d29eaea71e9f4cc2a1fdcce5b9e9d6ab0c94dd3a8f2d81850ee'),
      (pg_catalog.to_regprocedure('public.downtown_u_revoke_auth_session(text,smallint,bytea)')::oid, '05b59dd8b9f11ffaac6dbab8c3315954119c969476364bb9ee1da2c8d258cd8c'),
      (pg_catalog.to_regprocedure('public.downtown_u_validate_auth_session(text,smallint,bytea)')::oid, '0f1fb137a59ae03bee69d09695fcac90ee14712be6ad87a79870accd9864980b'),
      (pg_catalog.to_regprocedure('public.downtown_u_student_principal(text,smallint,bytea)')::oid, '899d9c7222dcdbb6ed5b7722ca9532de2412ace6891a8a6517648dc9a0007cf2'),
      (pg_catalog.to_regprocedure('public.downtown_u_student_me(text,smallint,bytea)')::oid, '057df997c00028f0f04aee75ebfeff12542b80b0e77cf6fbc21931b6155ee8dd'),
      (pg_catalog.to_regprocedure('public.downtown_u_student_purchases(text,smallint,bytea,integer,timestamp with time zone,uuid)')::oid, 'c5ec332c1aed359e23fc0651af13b752148d03550c372a498b8a8f77ce568b66'),
      (pg_catalog.to_regprocedure('public.downtown_u_student_reservations(text,smallint,bytea,integer,timestamp with time zone,uuid)')::oid, '9f4c4d1148a46fcc51a11f63151a541b3ca3aebd7364d3f136df6d96628c3f26'),
      (pg_catalog.to_regprocedure('public.downtown_u_student_meals(text,smallint,bytea)')::oid, '6d6e3fab4749fcc2b22584ee820bcc0bf8133c9e05e711219d2404170059c25b'),
      (pg_catalog.to_regprocedure('public.downtown_u_student_reserve(text,smallint,bytea,text,text[],text)')::oid, 'b97b0aa746e98e683bedb904673e4b9c78f480aa9367d4dcaa7e90487c26242c'),
      (pg_catalog.to_regprocedure('public.downtown_u_student_reverse(text,smallint,bytea,uuid,text)')::oid, '6f334c7a8e049a608c622c0deac3a336af9121450902bea44d259a844ddb78e0'),
      (pg_catalog.to_regprocedure('public.downtown_u_reverse_expired_reservations(integer)')::oid, '8508e828ccc1e5c152072088559306f3a9fb7ac0ff133fbb8bcad9d3fa19936a'),
      (pg_catalog.to_regprocedure('public.downtown_u_reject_reservation_snapshot_mutation()')::oid, '1f47bc39de65bec0bdfea7fea44886f3bbd679ef7ba1523ef6ffe684b287575b'),
      (pg_catalog.to_regprocedure('public.downtown_u_valid_modifier_snapshot(jsonb)')::oid, '68794dc2383bf4f0bf7621a22bbb2747a81a18265fd62a7107986676ebb3a4ca')
    ), auth_function_fingerprints AS (
      /*
       * Migration-pinned PG16 descriptor. jsonb's stable key ordering makes a
       * canonical catalog-only representation. Include function body/binary,
       * normalized result and every argument type/mode/name, plus every pg_proc
       * execution attribute applicable to PL/pgSQL. Migration definition changes
       * intentionally require regenerating and reviewing the SHA-256 values above.
       */
      SELECT p.oid AS function_oid,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((pg_catalog.jsonb_build_object(
          'prosrc',p.prosrc, 'probin',p.probin,
          'result_type',pg_catalog.format_type(p.prorettype,NULL),
          'arg_types',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.format_type(x.type_oid,NULL) ORDER BY x.ordinality)
            FROM pg_catalog.unnest(COALESCE(p.proallargtypes,p.proargtypes::oid[]))
              WITH ORDINALITY AS x(type_oid,ordinality)),'[]'::jsonb),
          'arg_modes',COALESCE(pg_catalog.to_jsonb(p.proargmodes),'[]'::jsonb),
          'arg_names',COALESCE(pg_catalog.to_jsonb(p.proargnames),'[]'::jsonb),
          'prokind',p.prokind, 'returns_set',p.proretset,
          'input_count',p.pronargs, 'volatility',p.provolatile, 'strict',p.proisstrict,
          'security_definer',p.prosecdef, 'leakproof',p.proleakproof, 'parallel',p.proparallel,
          'support',CASE WHEN p.prosupport=0 THEN '-' ELSE p.prosupport::pg_catalog.regproc::text END,
          'cost',p.procost, 'rows',p.prorows, 'language',l.lanname,
          'config',COALESCE(pg_catalog.to_jsonb(p.proconfig),'[]'::jsonb),
          'transform_types',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.format_type(x.type_oid,NULL) ORDER BY x.ordinality)
            FROM pg_catalog.unnest(p.protrftypes) WITH ORDINALITY AS x(type_oid,ordinality)),'[]'::jsonb),
          'sql_body',COALESCE(pg_catalog.pg_get_expr(p.prosqlbody,0,true),''),
          'variadic_type',CASE WHEN p.provariadic=0 THEN '-' ELSE pg_catalog.format_type(p.provariadic,NULL) END,
          'argument_defaults',COALESCE(pg_catalog.pg_get_expr(p.proargdefaults,0,true),''),
          'default_count',p.pronargdefaults
        )::text),'UTF8')),'hex') AS descriptor_sha256
      FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_language AS l ON l.oid=p.prolang
      JOIN expected_auth_function_fingerprints AS e ON e.function_oid=p.oid
    ), function_acls AS (
      SELECT d.oid AS function_oid, acl.grantee, acl.grantor,
             acl.privilege_type, acl.is_grantable
      FROM downtown_functions AS d
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(d.proacl, pg_catalog.acldefault('f', d.proowner))
      ) AS acl
    ), trusted_owner AS (
      SELECT p.proowner AS oid
      FROM pg_catalog.pg_proc AS p
      WHERE p.oid = pg_catalog.to_regprocedure('public.downtown_u_require_trusted_purchase_grant()')
    ), expected_triggers (
      tgname, relname, function_oid, enabled, is_row, is_before, is_instead,
      on_insert, on_delete, on_update, on_truncate, update_columns,
      when_expression, argument_count, arguments_hex
    ) AS (VALUES
      ('downtown_u_plans_protect_economics', 'downtown_u_plans',
        pg_catalog.to_regprocedure('public.downtown_u_protect_plan_economics()')::oid, 'O', true,true,false, false,true,true,false, ARRAY[]::text[], NULL::text, 0::smallint, ''),
      ('downtown_u_apply_credit_transaction_trigger', 'downtown_u_credit_transactions',
        pg_catalog.to_regprocedure('public.downtown_u_apply_credit_transaction()')::oid, 'O', true,true,false, true,false,false,false, ARRAY[]::text[], NULL::text, 0::smallint, ''),
      ('downtown_u_students_ledger_balance_only', 'downtown_u_students',
        pg_catalog.to_regprocedure('public.downtown_u_reject_direct_balance_update()')::oid, 'O', true,true,false, false,false,true,false, ARRAY['credit_balance']::text[], 'old.credit_balance IS DISTINCT FROM new.credit_balance', 0::smallint, ''),
      ('downtown_u_plan_purchases_protect_fields', 'downtown_u_plan_purchases',
        pg_catalog.to_regprocedure('public.downtown_u_protect_purchase_fields()')::oid, 'O', true,true,false, false,false,true,false, ARRAY[]::text[], NULL::text, 0::smallint, ''),
      ('downtown_u_redemptions_protect_fields', 'downtown_u_redemptions',
        pg_catalog.to_regprocedure('public.downtown_u_protect_redemption_fields()')::oid, 'O', true,true,false, false,false,true,false, ARRAY[]::text[], NULL::text, 0::smallint, ''),
      ('downtown_u_credit_transactions_immutable', 'downtown_u_credit_transactions',
        pg_catalog.to_regprocedure('public.downtown_u_reject_credit_transaction_mutation()')::oid, 'O', true,true,false, false,true,true,false, ARRAY[]::text[], NULL::text, 0::smallint, ''),
      ('downtown_u_credit_transactions_no_truncate', 'downtown_u_credit_transactions',
        pg_catalog.to_regprocedure('public.downtown_u_reject_credit_transaction_mutation()')::oid, 'O', false,true,false, false,false,false,true, ARRAY[]::text[], NULL::text, 0::smallint, ''),
      ('downtown_u_webhook_events_protect_trigger', 'downtown_u_webhook_events',
        pg_catalog.to_regprocedure('public.downtown_u_webhook_events_protect()')::oid, 'O', true,true,false, false,false,true,false, ARRAY[]::text[], NULL::text, 0::smallint, ''),
      ('downtown_u_00_purchase_grant_gate', 'downtown_u_credit_transactions',
        pg_catalog.to_regprocedure('public.downtown_u_require_trusted_purchase_grant()')::oid, 'O', true,true,false, true,false,false,false, ARRAY[]::text[], NULL::text, 0::smallint, ''),
      ('downtown_u_refund_applications_immutable', 'downtown_u_refund_applications',
        pg_catalog.to_regprocedure('public.downtown_u_reject_refund_record_mutation()')::oid, 'O', true,true,false, false,true,true,false, ARRAY[]::text[], NULL::text, 0::smallint, ''),
      ('downtown_u_refund_applications_no_truncate', 'downtown_u_refund_applications',
        pg_catalog.to_regprocedure('public.downtown_u_reject_refund_record_mutation()')::oid, 'O', false,true,false, false,false,false,true, ARRAY[]::text[], NULL::text, 0::smallint, ''),
      ('downtown_u_refund_reconciliations_immutable', 'downtown_u_refund_reconciliations',
        pg_catalog.to_regprocedure('public.downtown_u_reject_refund_record_mutation()')::oid, 'O', true,true,false, false,true,true,false, ARRAY[]::text[], NULL::text, 0::smallint, ''),
      ('downtown_u_refund_reconciliations_no_truncate', 'downtown_u_refund_reconciliations',
        pg_catalog.to_regprocedure('public.downtown_u_reject_refund_record_mutation()')::oid, 'O', false,true,false, false,false,false,true, ARRAY[]::text[], NULL::text, 0::smallint, ''),
      ('downtown_u_auth_challenges_immutable', 'downtown_u_auth_challenges', pg_catalog.to_regprocedure('public.downtown_u_auth_protect_challenge()')::oid, 'O', true,true,false, false,true,true,false, ARRAY[]::text[], NULL::text, 0::smallint, ''),
      ('downtown_u_auth_challenges_no_truncate', 'downtown_u_auth_challenges', pg_catalog.to_regprocedure('public.downtown_u_auth_protect_challenge()')::oid, 'O', false,true,false, false,false,false,true, ARRAY[]::text[], NULL::text, 0::smallint, ''),
      ('downtown_u_auth_sessions_immutable', 'downtown_u_auth_sessions', pg_catalog.to_regprocedure('public.downtown_u_auth_protect_session()')::oid, 'O', true,true,false, false,true,true,false, ARRAY[]::text[], NULL::text, 0::smallint, ''),
      ('downtown_u_auth_sessions_no_truncate', 'downtown_u_auth_sessions', pg_catalog.to_regprocedure('public.downtown_u_auth_protect_session()')::oid, 'O', false,true,false, false,false,false,true, ARRAY[]::text[], NULL::text, 0::smallint, '')
      ,('downtown_u_reservation_snapshots_immutable', 'downtown_u_reservation_snapshots', pg_catalog.to_regprocedure('public.downtown_u_reject_reservation_snapshot_mutation()')::oid, 'O', true,true,false, false,true,true,false, ARRAY[]::text[], NULL::text, 0::smallint, '')
      ,('downtown_u_reservation_snapshots_no_truncate', 'downtown_u_reservation_snapshots', pg_catalog.to_regprocedure('public.downtown_u_reject_reservation_snapshot_mutation()')::oid, 'O', false,true,false, false,false,false,true, ARRAY[]::text[], NULL::text, 0::smallint, '')
    ), downtown_triggers AS (
      -- pg_trigger.tgtype is a documented bit mask: ROW=1, BEFORE=2,
      -- INSERT=4, DELETE=8, UPDATE=16, TRUNCATE=32, INSTEAD=64.
      SELECT t.tgname, c.relname, t.tgfoid AS function_oid, t.tgenabled::text AS enabled,
        (t.tgtype & 1) <> 0 AS is_row, (t.tgtype & 2) <> 0 AS is_before,
        (t.tgtype & 64) <> 0 AS is_instead, (t.tgtype & 4) <> 0 AS on_insert,
        (t.tgtype & 8) <> 0 AS on_delete, (t.tgtype & 16) <> 0 AS on_update,
        (t.tgtype & 32) <> 0 AS on_truncate,
        COALESCE(ARRAY(
          SELECT a.attname::text FROM pg_catalog.unnest(t.tgattr::smallint[]) AS x(attnum)
          JOIN pg_catalog.pg_attribute AS a ON a.attrelid=t.tgrelid AND a.attnum=x.attnum
          ORDER BY a.attname
        ), ARRAY[]::text[]) AS update_columns,
        -- pg_get_expr(tgqual,tgrelid,true) is the normalized representation
        -- except for the one expected predicate: PG16 cannot deparse an OLD/NEW
        -- expression as one relation, so use its canonical trigger deparser.
        CASE
          WHEN t.tgqual IS NULL THEN NULL
          WHEN t.tgname = 'downtown_u_students_ledger_balance_only' THEN pg_catalog.substring(
            pg_catalog.pg_get_triggerdef(t.oid, true),
            ' WHEN \\((.*)\\) EXECUTE FUNCTION '
          )
          ELSE pg_catalog.pg_get_expr(t.tgqual, t.tgrelid, true)
        END AS when_expression,
        t.tgnargs AS argument_count, pg_catalog.encode(t.tgargs, 'hex') AS arguments_hex
      FROM pg_catalog.pg_trigger AS t
      JOIN downtown_relations AS c ON c.oid=t.tgrelid
      WHERE NOT t.tgisinternal
    )
    SELECT COALESCE((SELECT i.rolcanlogin
      AND SESSION_USER = CURRENT_USER
      AND NOT i.rolsuper AND NOT i.rolcreatedb AND NOT i.rolcreaterole
      AND NOT i.rolreplication AND NOT i.rolbypassrls
      AND NOT rr.rolcanlogin AND NOT rr.rolsuper AND NOT rr.rolcreatedb
      AND NOT rr.rolcreaterole AND NOT rr.rolreplication AND NOT rr.rolbypassrls
      AND NOT jr.rolcanlogin AND NOT jr.rolsuper AND NOT jr.rolcreatedb
      AND NOT jr.rolcreaterole AND NOT jr.rolreplication AND NOT jr.rolbypassrls
      AND pg_catalog.pg_has_role(CURRENT_USER, 'downtown_u_runtime', 'MEMBER')
      AND NOT pg_catalog.pg_has_role(CURRENT_USER, 'downtown_u_jobs', 'MEMBER')
      AND NOT pg_catalog.has_schema_privilege(CURRENT_USER, 'public', 'CREATE')
      AND NOT pg_catalog.has_database_privilege(CURRENT_USER, CURRENT_DATABASE(), 'CREATE')
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles AS inherited
        WHERE inherited.oid NOT IN (i.oid, 'downtown_u_runtime'::pg_catalog.regrole)
          AND pg_catalog.pg_has_role(CURRENT_USER, inherited.oid, 'MEMBER')
      )
      AND NOT EXISTS (
        SELECT 1 FROM downtown_relations AS d
        WHERE pg_catalog.pg_has_role(CURRENT_USER, d.relowner, 'MEMBER')
      )
      AND NOT EXISTS (
        SELECT 1 FROM downtown_functions AS d
        WHERE pg_catalog.pg_has_role(CURRENT_USER, d.proowner, 'MEMBER')
      )
      AND (SELECT count(*) FROM trusted_owner) = 1
      AND NOT EXISTS (
        SELECT 1 FROM downtown_relations AS d CROSS JOIN trusted_owner AS o
        WHERE d.relowner <> o.oid
      )
      AND NOT EXISTS (
        SELECT 1 FROM downtown_functions AS d CROSS JOIN trusted_owner AS o
        WHERE d.proowner <> o.oid
      )
      AND NOT EXISTS (
        SELECT 1 FROM downtown_sequences
      )
      AND NOT EXISTS (
        SELECT 1 FROM expected_relations AS e
        FULL JOIN downtown_relations AS d USING (relname)
        WHERE e.relname IS NULL OR d.relname IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM expected_columns AS e
        FULL JOIN downtown_columns AS d USING (relname, attname)
        WHERE e.relname IS NULL OR d.relname IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM expected_auth_columns AS e
        FULL JOIN auth_columns AS d USING (relname,attnum)
        WHERE e.relname IS NULL OR d.relname IS NULL
          OR d.attname<>e.attname OR d.formatted_type<>e.formatted_type
          OR d.not_null<>e.not_null OR d.default_expression IS DISTINCT FROM e.default_expression
          OR d.identity_kind<>e.identity_kind OR d.generated_kind<>e.generated_kind
      )
      AND NOT EXISTS (
        SELECT 1 FROM auth_relation_catalog AS c
        WHERE c.relkind<>'r' OR c.relpersistence<>'p' OR c.relrowsecurity OR c.relforcerowsecurity
            OR c.relreplident<>'d' OR c.reloptions IS NOT NULL OR c.relispartition OR c.relhasrules
            OR c.relam IS DISTINCT FROM (SELECT am.oid FROM pg_catalog.pg_am AS am WHERE am.amname='heap')
            OR c.access_method IS DISTINCT FROM 'heap'
            OR EXISTS (SELECT 1 FROM pg_catalog.pg_inherits AS h
              WHERE h.inhrelid=c.oid OR h.inhparent=c.oid)
      )
      AND (SELECT count(*) FROM auth_relation_catalog) = 2
      AND NOT EXISTS (SELECT 1 FROM auth_rewrite_rules)
      AND NOT EXISTS (
        SELECT 1 FROM expected_auth_constraints AS e
        FULL JOIN auth_constraints AS d USING (relname,conname)
        WHERE e.relname IS NULL OR d.relname IS NULL OR d.constraint_type<>e.constraint_type
          OR d.definition<>e.definition
      )
      AND NOT EXISTS (
        SELECT 1 FROM expected_auth_indexes AS e
        FULL JOIN auth_indexes AS d USING (relname,index_name)
        WHERE e.relname IS NULL OR d.relname IS NULL OR d.definition<>e.definition
          OR d.predicate IS DISTINCT FROM e.predicate
      )
      AND NOT EXISTS (
        SELECT 1 FROM auth_relation_acls AS a
        WHERE a.grantee<>a.relowner OR a.grantor<>a.relowner OR a.is_grantable
          OR a.privilege_type NOT IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
      )
      AND (SELECT count(*) FROM auth_relation_acls) = 14
      AND NOT EXISTS (SELECT 1 FROM auth_column_acls)
      AND NOT EXISTS (
        SELECT 1 FROM expected_portal_relation_fingerprints e
        FULL JOIN portal_relation_fingerprints d USING (relname)
        WHERE e.relname IS NULL OR d.relname IS NULL OR d.descriptor_sha256<>e.expected_sha256
      )
      AND (SELECT count(*) FROM portal_relation_fingerprints)=3
      AND NOT EXISTS (
        SELECT 1 FROM expected_relations AS e JOIN downtown_relations AS d USING (relname)
        WHERE pg_catalog.has_table_privilege(CURRENT_USER, d.oid, 'SELECT') <> e.table_select
           OR pg_catalog.has_table_privilege(CURRENT_USER, d.oid, 'INSERT') <> e.table_insert
           OR pg_catalog.has_table_privilege(CURRENT_USER, d.oid, 'UPDATE') <> e.table_update
           OR pg_catalog.has_table_privilege(CURRENT_USER, d.oid, 'DELETE') <> e.table_delete
           OR pg_catalog.has_table_privilege(CURRENT_USER, d.oid, 'TRUNCATE') <> e.table_truncate
           OR pg_catalog.has_table_privilege(CURRENT_USER, d.oid, 'REFERENCES') <> e.table_references
           OR pg_catalog.has_table_privilege(CURRENT_USER, d.oid, 'TRIGGER') <> e.table_trigger
      )
      AND NOT EXISTS (
        SELECT 1
        FROM expected_relations AS e JOIN downtown_relations AS r USING (relname)
        JOIN downtown_columns AS d ON d.oid = r.oid
        WHERE pg_catalog.has_column_privilege(CURRENT_USER, d.oid, d.attname, 'SELECT') <> e.table_select
           OR pg_catalog.has_column_privilege(CURRENT_USER, d.oid, d.attname, 'INSERT')
                <> (e.table_insert OR d.attname = ANY(e.insert_columns))
           OR pg_catalog.has_column_privilege(CURRENT_USER, d.oid, d.attname, 'UPDATE')
                <> (e.table_update OR d.attname = ANY(e.update_columns))
           OR pg_catalog.has_column_privilege(CURRENT_USER, d.oid, d.attname, 'REFERENCES') <> e.table_references
      )
      AND NOT EXISTS (
        SELECT 1 FROM expected_functions AS e
        FULL JOIN downtown_functions AS d
          ON d.oid = e.expected_oid AND d.proname = e.proname
          AND d.identity_arguments = e.identity_arguments
        WHERE e.proname IS NULL OR d.proname IS NULL OR e.expected_oid IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM expected_functions AS e JOIN downtown_functions AS d
          ON d.oid = e.expected_oid AND d.proname = e.proname
          AND d.identity_arguments = e.identity_arguments
        WHERE pg_catalog.has_function_privilege(CURRENT_USER, d.oid, 'EXECUTE') <> e.allow_execute
           OR d.prosecdef <> e.security_definer
           OR d.lanname <> 'plpgsql'
           OR d.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
      )
      AND NOT EXISTS (
        SELECT 1 FROM expected_auth_function_fingerprints AS e
        FULL JOIN auth_function_fingerprints AS d USING (function_oid)
        WHERE e.function_oid IS NULL OR d.function_oid IS NULL
          OR d.descriptor_sha256 <> e.expected_sha256
      )
      AND (SELECT count(*) FROM auth_function_fingerprints) = 16
      AND NOT EXISTS (
        SELECT 1 FROM expected_functions AS e JOIN downtown_functions AS d
          ON d.oid = e.expected_oid AND d.proname = e.proname
          AND d.identity_arguments = e.identity_arguments
        WHERE (SELECT count(*) FROM function_acls AS a
               WHERE a.function_oid=d.oid AND a.grantee<>d.proowner)
                <> CASE WHEN e.proname='downtown_u_reverse_expired_reservations' THEN 1 WHEN e.allow_execute THEN 1 ELSE 0 END
           OR EXISTS (
             SELECT 1 FROM function_acls AS a
             WHERE a.function_oid=d.oid AND a.grantee<>d.proowner
               AND (a.grantee<>CASE WHEN e.proname='downtown_u_reverse_expired_reservations' THEN jr.oid ELSE rr.oid END OR a.grantor<>d.proowner
                 OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
           )
      )
      AND NOT EXISTS (
        SELECT 1 FROM expected_triggers AS e
        FULL JOIN downtown_triggers AS d USING (tgname, relname)
        WHERE e.tgname IS NULL OR d.tgname IS NULL
          OR e.function_oid IS NULL OR d.function_oid <> e.function_oid
          OR d.enabled <> e.enabled OR d.is_row <> e.is_row
          OR d.is_before <> e.is_before OR d.is_instead <> e.is_instead
          OR d.on_insert <> e.on_insert OR d.on_delete <> e.on_delete
          OR d.on_update <> e.on_update OR d.on_truncate <> e.on_truncate
          OR d.update_columns <> e.update_columns
          OR d.when_expression IS DISTINCT FROM e.when_expression
          OR d.argument_count <> e.argument_count
          OR d.arguments_hex <> e.arguments_hex
      )
      FROM identity AS i CROSS JOIN runtime_role AS rr CROSS JOIN jobs_role AS jr), false) AS safe_runtime_identity
  `).then((result) => {
    if (result.rows.length !== 1 || result.rows[0].safe_runtime_identity !== true) {
      throw new Error("Unsafe Downtown U runtime database identity");
    }
  });
}
