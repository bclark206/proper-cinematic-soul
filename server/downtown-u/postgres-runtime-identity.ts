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
        true,false,false,false,false,false,false,
        ARRAY['normalized_email','normalized_phone','square_customer_id']::text[],
        ARRAY['normalized_email','normalized_phone','square_customer_id','updated_at']::text[]),
      ('downtown_u_plan_purchases', ARRAY['id','student_id','plan_id','credits_granted','price_cents','currency','square_payment_id','square_order_id','source_event_id','status','refunded_credits','paid_at','refunded_at','created_at','updated_at']::text[],
        true,true,false,false,false,false,false, ARRAY[]::text[],
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
    ), expected_functions (proname, identity_arguments, expected_oid, allow_execute) AS (VALUES
      ('downtown_u_protect_plan_economics', '', pg_catalog.to_regprocedure('public.downtown_u_protect_plan_economics()')::oid, false),
      ('downtown_u_apply_credit_transaction', '', pg_catalog.to_regprocedure('public.downtown_u_apply_credit_transaction()')::oid, false),
      ('downtown_u_reject_direct_balance_update', '', pg_catalog.to_regprocedure('public.downtown_u_reject_direct_balance_update()')::oid, false),
      ('downtown_u_protect_purchase_fields', '', pg_catalog.to_regprocedure('public.downtown_u_protect_purchase_fields()')::oid, false),
      ('downtown_u_protect_redemption_fields', '', pg_catalog.to_regprocedure('public.downtown_u_protect_redemption_fields()')::oid, false),
      ('downtown_u_reject_credit_transaction_mutation', '', pg_catalog.to_regprocedure('public.downtown_u_reject_credit_transaction_mutation()')::oid, false),
      ('downtown_u_webhook_events_protect', '', pg_catalog.to_regprocedure('public.downtown_u_webhook_events_protect()')::oid, false),
      ('downtown_u_claim_webhook_event', 'text, text, text', pg_catalog.to_regprocedure('public.downtown_u_claim_webhook_event(text,text,text)')::oid, true),
      ('downtown_u_complete_webhook_event', 'text, uuid', pg_catalog.to_regprocedure('public.downtown_u_complete_webhook_event(text,uuid)')::oid, true),
      ('downtown_u_fail_webhook_event', 'text, uuid, text, text', pg_catalog.to_regprocedure('public.downtown_u_fail_webhook_event(text,uuid,text,text)')::oid, true)
    ), downtown_functions AS (
      SELECT p.oid, p.proname, pg_catalog.oidvectortypes(p.proargtypes) AS identity_arguments,
             p.proowner
      FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'downtown!_u!_%' ESCAPE '!'
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
