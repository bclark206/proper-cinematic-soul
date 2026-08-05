import type { Pool } from "pg";

const verifiedPools = new WeakMap<Pool, Promise<void>>();

interface IdentityRow { safe_runtime_identity: boolean; }

/** Fail closed unless the pool authenticates directly as the exact bounded runtime identity. */
export function assertDowntownURuntimeIdentity(pool: Pool): Promise<void> {
  const existing = verifiedPools.get(pool);
  if (existing) return existing;

  const verification = pool.query<IdentityRow>(`
    WITH identity AS (
      SELECT r.oid, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
             r.rolreplication, r.rolbypassrls
      FROM pg_catalog.pg_roles AS r WHERE r.rolname = CURRENT_USER
    ), runtime_role AS (
      SELECT r.oid, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
             r.rolreplication, r.rolbypassrls
      FROM pg_catalog.pg_roles AS r WHERE r.rolname = 'downtown_u_runtime'
    ), expected_relations (
      relname, columns, table_select, table_insert, table_update, table_delete,
      table_truncate, table_references, table_trigger, insert_columns, update_columns
    ) AS (VALUES
      ('downtown_u_plans', ARRAY['id','credits','price_cents','active']::text[],
        true,false,false,false,false,false,false, ARRAY[]::text[], ARRAY[]::text[]),
      ('downtown_u_students', ARRAY['id','normalized_email','normalized_phone','square_customer_id','eligibility_status','credit_balance','eligibility_reviewed_at','approved_at','rejected_at','suspended_at','created_at','updated_at','deleted_at']::text[],
        true,false,false,false,false,false,false, ARRAY[]::text[], ARRAY[]::text[]),
      ('downtown_u_plan_purchases', ARRAY['id','student_id','plan_id','credits_granted','price_cents','currency','square_payment_id','square_order_id','source_event_id','status','refunded_credits','paid_at','refunded_at','created_at','updated_at','authoritative_paid_at','authoritative_normalized_email','authoritative_normalized_phone','authoritative_square_customer_id']::text[],
        true,false,false,false,false,false,false,
        ARRAY[]::text[],
        ARRAY['status','refunded_credits','refunded_at','updated_at']::text[]),
      ('downtown_u_redemptions', ARRAY['id','student_id','credits','idempotency_key','status','square_order_id','reserved_at','redeemed_at','reversed_at','expires_at','created_at','updated_at']::text[],
        true,true,false,false,false,false,false, ARRAY[]::text[],
        ARRAY['status','square_order_id','redeemed_at','reversed_at','expires_at','updated_at']::text[]),
      ('downtown_u_credit_transactions', ARRAY['id','student_id','purchase_id','redemption_id','delta','resulting_balance','transaction_type','reason','idempotency_key','actor_type','actor_id','source_type','source_id','metadata','created_at']::text[],
        true,true,false,false,false,false,false, ARRAY[]::text[], ARRAY[]::text[]),
      ('downtown_u_balance_update_authorizations', ARRAY['backend_pid','transaction_id','student_id','new_balance']::text[],
        false,false,false,false,false,false,false, ARRAY[]::text[], ARRAY[]::text[]),
      ('downtown_u_webhook_events', ARRAY['square_event_id','event_type','raw_body_sha256','status','attempt_count','received_at','started_at','completed_at','failed_at','failure_code','failure_detail','claim_token','created_at','updated_at']::text[],
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
      ('downtown_u_webhook_events_protect', '', pg_catalog.to_regprocedure('public.downtown_u_webhook_events_protect()')::oid, false, false),
      ('downtown_u_claim_webhook_event', 'text, text, text', pg_catalog.to_regprocedure('public.downtown_u_claim_webhook_event(text,text,text)')::oid, true, true),
      ('downtown_u_complete_webhook_event', 'text, uuid', pg_catalog.to_regprocedure('public.downtown_u_complete_webhook_event(text,uuid)')::oid, true, true),
      ('downtown_u_fail_webhook_event', 'text, uuid, text, text', pg_catalog.to_regprocedure('public.downtown_u_fail_webhook_event(text,uuid,text,text)')::oid, true, true),
      ('downtown_u_reject_webhook_event', 'text, uuid, text, text', pg_catalog.to_regprocedure('public.downtown_u_reject_webhook_event(text,uuid,text,text)')::oid, true, true),
      ('downtown_u_upsert_pending_student', 'text, text, text', pg_catalog.to_regprocedure('public.downtown_u_upsert_pending_student(text,text,text)')::oid, true, true),
      ('downtown_u_activate_verified_payment', 'text, uuid, text, text, text, text, integer, integer, text, text, text, text, text, text',
        pg_catalog.to_regprocedure('public.downtown_u_activate_verified_payment(text,uuid,text,text,text,text,integer,integer,text,text,text,text,text,text)')::oid, true, true)
    ), downtown_functions AS (
      SELECT p.oid, p.proname, pg_catalog.oidvectortypes(p.proargtypes) AS identity_arguments,
             p.proowner, p.prosecdef, l.lanname, p.proconfig
      FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
      WHERE n.nspname = 'public' AND p.proname LIKE 'downtown!_u!_%' ESCAPE '!'
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
        pg_catalog.to_regprocedure('public.downtown_u_require_trusted_purchase_grant()')::oid, 'O', true,true,false, true,false,false,false, ARRAY[]::text[], NULL::text, 0::smallint, '')
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
      AND pg_catalog.pg_has_role(CURRENT_USER, 'downtown_u_runtime', 'MEMBER')
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
      FROM identity AS i CROSS JOIN runtime_role AS rr), false) AS safe_runtime_identity
  `).then((result) => {
    if (result.rows.length !== 1 || result.rows[0].safe_runtime_identity !== true) {
      throw new Error("Unsafe Downtown U runtime database identity");
    }
  });

  // Cache failures too: a pool that failed validation must remain fail closed.
  verifiedPools.set(pool, verification);
  return verification;
}
