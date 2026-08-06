
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const baseUrl = process.env.TEST_DATABASE_URL;
const run = baseUrl ? describe : describe.skip;
const suffix = `${process.pid}_${Date.now()}`;
const databaseName = `downtown_u_operator_${suffix}`;
const unsafeDatabaseName = `${databaseName}_unsafe`;
const operatorLogin = `du_operator_login_${suffix}`;
const hostileAclRole = `du_hostile_acl_${suffix}`;
const migrationNames = [
  "202608040001_downtown_u_phase1.sql",
  "202608040002_downtown_u_webhook_events.sql",
  "202608040003_downtown_u_payment_activation.sql",
  "202608040004_downtown_u_refund_activation.sql",
  "202608040005_downtown_u_auth.sql",
  "202608040006_downtown_u_student_portal.sql",
  "202608040007_downtown_u_checkout.sql",
  "202608040008_downtown_u_kitchen_outbox.sql",
  "202608040009_downtown_u_operator_audit.sql",
];
const migrations = migrationNames.map((name) =>
  readFileSync(resolve(process.cwd(), "db/migrations", name), "utf8"));
let admin: Pool;
let pool: Pool;
let testUrl: URL;
let studentId: string;
let refundSourceId: string;
let kitchenSourceId: string;
let refundSourceBefore: unknown;
let kitchenSourceBefore: unknown;

function qi(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}
let verifierCounter = 0;
function opaqueVerifier(): Buffer {
  verifierCounter += 1;
  const value = Buffer.alloc(32);
  value.writeUInt32BE(verifierCounter, 28);
  return value;
}
async function expectDenied(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toSatisfy((error: unknown) => errorCode(error) === "42501");
}
async function asPrincipal<T>(principal: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`SET SESSION AUTHORIZATION ${qi(principal)}`);
    return await operation(client);
  } finally {
    await client.query("RESET SESSION AUTHORIZATION").catch(() => undefined);
    client.release();
  }
}
async function controlled(client: Pool | PoolClient, statement: string, values: unknown[] = []): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`SELECT set_config('downtown_u.operator_write',
      pg_backend_pid()::text||':'||pg_current_xact_id()::text,true)`);
    await client.query(statement, values);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
async function createAudit(operatorId: string, sessionId: string, actionCode: string,
  idempotencyKey: string, correlationId: string): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('downtown_u.operator_write',
      pg_backend_pid()::text||':'||pg_current_xact_id()::text,true)`);
    const id = (await client.query<{ id: string }>(`INSERT INTO downtown_u_operator_audit_events
      (operator_id,session_id,action_code,target_type,target_id,reason_code,reason,idempotency_key,correlation_id)
      VALUES ($1,$2,$3,'student','fixture-target','test_reason','Controlled test',$4,$5) RETURNING id`,
    [operatorId, sessionId, actionCode, idempotencyKey, correlationId])).rows[0].id;
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function provisionOperator(email: string, phone: string): Promise<{ accountId: string; flowId: string; sessionId: string }> {
  const accountId = (await pool.query<{ id: string }>(`INSERT INTO downtown_u_operator_accounts
    (normalized_email,normalized_phone,display_name,provisioning_reference)
    VALUES ($1,$2,'Migration Test Operator',$3) RETURNING id`,
  [email, phone, `provision:${email}`])).rows[0].id;
  const flowId = (await pool.query<{ id: string }>(`INSERT INTO downtown_u_operator_auth_flows
    (operator_id,status,flow_verifier,created_at,updated_at,expires_at,completed_at,consumed_at)
    VALUES ($1,'consumed',$2,now()-interval '1 second',now(),now()+interval '10 minutes',now(),now()) RETURNING id`,
  [accountId, opaqueVerifier()])).rows[0].id;
  for (const factor of ["email_magic_link", "sms_otp"]) {
    await pool.query(`INSERT INTO downtown_u_operator_auth_challenges
      (operator_id,flow_id,purpose,factor,status,challenge_verifier,created_at,updated_at,expires_at,verified_at,consumed_at)
      VALUES ($1,$2,'sign_in',$3,'consumed',$4,now()-interval '1 second',now(),now()+interval '10 minutes',now(),now())`,
    [accountId, flowId, factor, opaqueVerifier()]);
  }
  const sessionId = (await pool.query<{ id: string }>(`INSERT INTO downtown_u_operator_sessions
    (operator_id,consumed_auth_flow_id,session_verifier,created_at,updated_at,absolute_expires_at,idle_expires_at,last_seen_at)
    VALUES ($1,$2,$3,now()-interval '1 second',now(),now()+interval '7 hours',now()+interval '29 minutes',now()) RETURNING id`,
  [accountId, flowId, opaqueVerifier()])).rows[0].id;
  return { accountId, flowId, sessionId };
}

run.sequential("operator migration 009 on real PostgreSQL 16", () => {
  beforeAll(async () => {
    const parsed = new URL(baseUrl!);
    const baseDatabase = parsed.pathname.slice(1);
    if (!["", "localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
      && !/(^|[_-])(test|testing|disposable)([_-]|$)/i.test(baseDatabase)) {
      throw new Error("Refusing integration tests: TEST_DATABASE_URL must be local or explicitly test-named");
    }
    admin = new Pool({ connectionString: baseUrl, max: 2 });
    const version = Number((await admin.query("SHOW server_version_num")).rows[0].server_version_num);
    if (version < 160000 || version >= 170000) throw new Error(`PostgreSQL 16 required, got ${version}`);
    await admin.query(`CREATE DATABASE ${qi(databaseName)}`);
    await admin.query(`CREATE ROLE ${qi(hostileAclRole)} NOLOGIN`);
    testUrl = new URL(baseUrl!);
    testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 6 });

    for (const migration of migrations.slice(0, 8)) await pool.query(migration);
    await pool.query(`ALTER DEFAULT PRIVILEGES GRANT INSERT,SELECT ON TABLES TO ${qi(hostileAclRole)}`);
    await pool.query(`ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO ${qi(hostileAclRole)}`);
    studentId = (await pool.query<{ id: string }>(
      "INSERT INTO downtown_u_students(normalized_email) VALUES ('operator-backfill@example.edu') RETURNING id",
    )).rows[0].id;
    const purchaseId = (await pool.query<{ id: string }>(`INSERT INTO downtown_u_plan_purchases
      (student_id,plan_id,credits_granted,price_cents,square_payment_id,square_order_id,source_event_id,paid_at)
      VALUES ($1,'flex-5',5,6000,'operator-backfill-payment','operator-backfill-order','operator-backfill-event',now()) RETURNING id`,
    [studentId])).rows[0].id;
    const applicationId = (await pool.query<{ id: string }>(`INSERT INTO downtown_u_refund_applications
      (square_refund_id,source_event_id,square_payment_id,square_order_id,purchase_id,student_id,
       authoritative_amount_cents,authoritative_currency,authoritative_location_id,authoritative_updated_at,
       refund_sequence,cumulative_refunded_cents,target_refunded_credits,credit_delta,available_credits_before,status)
      VALUES ('operator-refund','operator-refund-event','operator-backfill-payment','operator-backfill-order',$1,$2,
       6000,'USD','LPPWSSV03BHK8','2026-08-05T00:00:00Z',1,6000,5,5,0,'reconciliation_required') RETURNING id`,
    [purchaseId, studentId])).rows[0].id;
    refundSourceId = (await pool.query<{ id: string }>(`INSERT INTO downtown_u_refund_reconciliations
      (refund_application_id,purchase_id,student_id,reason_code,required_credits,available_credits)
      VALUES ($1,$2,$3,'insufficient_available_credits',5,0) RETURNING id`,
    [applicationId, purchaseId, studentId])).rows[0].id;

    await pool.query(`INSERT INTO downtown_u_meal_rules
      (id,display_name,square_catalog_object_id,base_credits,active)
      VALUES ('operator-fixture-meal','Fixture Meal','CATALOG_OPERATOR_FIXTURE',1,false)`);
    kitchenSourceId = (await pool.query<{ id: string }>(`INSERT INTO downtown_u_redemptions
      (student_id,credits,idempotency_key,status,square_order_id,redeemed_at)
      VALUES ($1,1,'operator-kitchen-redemption','redeemed','ORDER_OPERATOR_FIXTURE',now()) RETURNING id`, [studentId])).rows[0].id;
    await pool.query(`INSERT INTO downtown_u_reservation_snapshots
      (redemption_id,meal_rule_id,meal_public_id,meal_display_name,meal_square_catalog_object_id,modifiers,credits)
      VALUES ($1,'operator-fixture-meal','operator-fixture-meal','Fixture Meal','CATALOG_OPERATOR_FIXTURE','[]',1)`,
    [kitchenSourceId]);
    await pool.query("BEGIN");
    await pool.query(`SELECT set_config('downtown_u.kitchen_write',
      pg_backend_pid()::text||':'||pg_current_xact_id()::text,true)`);
    await pool.query(`UPDATE downtown_u_kitchen_order_outbox
      SET state='operator_review',error_code='fixture_review',updated_at=clock_timestamp()
      WHERE redemption_id=$1`, [kitchenSourceId]);
    await pool.query("COMMIT");
    refundSourceBefore = (await pool.query("SELECT to_jsonb(q) AS row FROM downtown_u_refund_reconciliations q WHERE id=$1", [refundSourceId])).rows[0].row;
    kitchenSourceBefore = (await pool.query("SELECT to_jsonb(o) AS row FROM downtown_u_kitchen_order_outbox o WHERE redemption_id=$1", [kitchenSourceId])).rows[0].row;

    await pool.query(migrations[8]);
    await admin.query(`CREATE ROLE ${qi(operatorLogin)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(`GRANT downtown_u_operator_runtime TO ${qi(operatorLogin)}`);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP ROLE IF EXISTS ${qi(operatorLogin)}`).catch(async () => {
        await admin.query(`REVOKE downtown_u_operator_runtime FROM ${qi(operatorLogin)}`).catch(() => undefined);
        await admin.query(`DROP ROLE IF EXISTS ${qi(operatorLogin)}`);
      });
      for (const name of [unsafeDatabaseName, databaseName]) {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
          [name],
        );
        await admin.query(`DROP DATABASE IF EXISTS ${qi(name)}`);
      }
      await admin.query(`DROP ROLE IF EXISTS ${qi(hostileAclRole)}`);
      await admin.end();
    }
  }, 30_000);

  it("applies authoritative migrations 001-009 atomically and leaves all gates false", async () => {
    expect((await pool.query(`SELECT to_regclass('public.downtown_u_operator_accounts') AS relation,
      to_regclass('public.downtown_u_operator_adjustments') AS adjustments`)).rows[0]).toEqual({
      relation: "downtown_u_operator_accounts", adjustments: "downtown_u_operator_adjustments",
    });
    expect((await pool.query("SELECT read_enabled,mutations_enabled,exports_enabled FROM downtown_u_operator_config")).rows)
      .toEqual([{ read_enabled: false, mutations_enabled: false, exports_enabled: false }]);
  });

  it("makes the capability role and its dedicated LOGIN powerless outside exactly one membership", async () => {
    const role = (await pool.query(`SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconfig
      FROM pg_roles WHERE rolname='downtown_u_operator_runtime'`)).rows[0];
    expect(role).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false,
      rolreplication: false, rolbypassrls: false, rolconfig: null });
    const memberships = (await pool.query<{ roles: string[] }>(`SELECT coalesce(json_agg(r.rolname ORDER BY r.rolname),'[]') roles
      FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE u.rolname=$1`,
    [operatorLogin])).rows[0].roles;
    expect(memberships).toEqual(["downtown_u_operator_runtime"]);
    expect((await pool.query(`SELECT count(*)::int n FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
      WHERE r.rolname=$1`, [operatorLogin])).rows[0].n).toBe(0);

    await asPrincipal(operatorLogin, async (client) => {
      expect((await client.query(`SELECT has_schema_privilege(current_user,'public','CREATE') create_schema,
        has_database_privilege(current_user,current_database(),'CREATE') create_database`)).rows[0])
        .toEqual({ create_schema: false, create_database: false });
      for (const relation of ["downtown_u_operator_accounts", "downtown_u_operator_auth_flows",
        "downtown_u_operator_auth_challenges", "downtown_u_operator_sessions", "downtown_u_students", "downtown_u_credit_transactions",
        "downtown_u_refund_reconciliations", "downtown_u_kitchen_order_outbox"]) {
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
          expect((await client.query("SELECT has_table_privilege(current_user,$1,$2) allowed", [`public.${relation}`, privilege])).rows[0].allowed).toBe(false);
        }
        await expectDenied(client.query(`SELECT * FROM public.${relation} LIMIT 0`));
      }
      expect((await client.query(`SELECT has_function_privilege(current_user,
        'public.downtown_u_operator_append_only_guard()','EXECUTE') allowed`)).rows[0].allowed).toBe(false);
      const exposed = (await client.query(`SELECT p.oid::regprocedure::text name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND (p.proname LIKE 'downtown_u_student_%' OR p.proname LIKE 'downtown_u_kitchen_%'
          OR p.proname LIKE 'downtown_u_%webhook%' OR p.proname LIKE 'downtown_u_%auth%' OR p.proname LIKE 'downtown_u_%checkout%')
          AND has_function_privilege(current_user,p.oid,'EXECUTE')`)).rows;
      expect(exposed).toEqual([]);
      await expectDenied(client.query("CREATE TABLE public.operator_login_forbidden(id int)"));
    });
  });

  it("normalizes hostile default ACLs to migration-owner-only for every operator relation and function", async () => {
    const leakedRelations = (await pool.query(`SELECT c.relname,grantee.rolname
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
      LEFT JOIN pg_roles grantee ON grantee.oid=acl.grantee
      WHERE n.nspname='public' AND c.relkind IN ('r','v')
        AND (c.relname LIKE 'downtown_u_operator_%' OR c.relname='downtown_u_eligibility_events')
        AND acl.grantee<>c.relowner`)).rows;
    const leakedFunctions = (await pool.query(`SELECT p.oid::regprocedure::text name,grantee.rolname
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      LEFT JOIN pg_roles grantee ON grantee.oid=acl.grantee
      WHERE n.nspname='public' AND p.proname LIKE 'downtown_u_operator_%'
        AND acl.grantee<>p.proowner`)).rows;
    expect(leakedRelations).toEqual([]);
    expect(leakedFunctions).toEqual([]);
    expect((await pool.query(`SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','v')
        AND (c.relname LIKE 'downtown_u_operator_%' OR c.relname='downtown_u_eligibility_events')
        AND (has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT'))`, [hostileAclRole])).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE 'downtown_u_operator_%'
        AND has_function_privilege($1,p.oid,'EXECUTE')`, [hostileAclRole])).rows[0].n).toBe(0);
    expect((await pool.query("SELECT has_schema_privilege('downtown_u_runtime','public','USAGE') allowed")).rows[0].allowed).toBe(true);
  });

  it.each(["downtown_u_runtime", "downtown_u_jobs", "downtown_u_kitchen_jobs"])(
    "withholds every operator relation and function from existing principal %s", async (principal) => {
      await asPrincipal(principal, async (client) => {
        const leakedRelations = (await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname LIKE 'downtown_u_operator_%'
            AND (has_table_privilege(current_user,c.oid,'SELECT') OR has_table_privilege(current_user,c.oid,'INSERT')
              OR has_table_privilege(current_user,c.oid,'UPDATE') OR has_table_privilege(current_user,c.oid,'DELETE')
              OR has_table_privilege(current_user,c.oid,'TRUNCATE'))`)).rows;
        expect(leakedRelations).toEqual([]);
        expect((await client.query(`SELECT has_function_privilege(current_user,
          'public.downtown_u_operator_append_only_guard()','EXECUTE') allowed`)).rows[0].allowed).toBe(false);
        await expectDenied(client.query("SELECT * FROM downtown_u_operator_accounts LIMIT 0"));
      });
    },
  );

  it("enforces immutable contacts, consumed-flow MFA, reauth binding, replay resistance and session bounds", async () => {
    const first = await provisionOperator("owner-a@example.edu", "+12025550101");
    const second = await provisionOperator("owner-b@example.edu", "+12025550102");
    const columns = (await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='downtown_u_operator_accounts'`)).rows.map((row) => row.column_name);
    expect(columns.some((column) => /pass|secret|hash|credential/i.test(column))).toBe(false);
    for (const [column, value] of [["normalized_email", "changed@example.edu"], ["normalized_phone", "+12025550999"], ["provisioning_reference", "changed-ref"]]) {
      await expect(pool.query(`UPDATE downtown_u_operator_accounts SET ${column}=$1 WHERE id=$2`, [value, first.accountId])).rejects.toThrow(/immutable/i);
    }
    await expect(pool.query(`INSERT INTO downtown_u_operator_auth_flows
      (operator_id,flow_verifier,expires_at) VALUES ($1,'raw'::bytea,now()+interval '5 minutes')`, [first.accountId]))
      .rejects.toSatisfy((error: unknown) => errorCode(error) === "23514");
    const pendingFlow = (await pool.query<{ id: string }>(`INSERT INTO downtown_u_operator_auth_flows
      (operator_id,flow_verifier,expires_at) VALUES ($1,$2,now()+interval '5 minutes') RETURNING id`,
    [first.accountId, opaqueVerifier()])).rows[0].id;
    await expect(pool.query(`INSERT INTO downtown_u_operator_sessions
      (operator_id,consumed_auth_flow_id,session_verifier,created_at,updated_at,absolute_expires_at,idle_expires_at,last_seen_at)
      VALUES ($1,$2,$3,now()-interval '1 second',now(),now()+interval '1 hour',now()+interval '20 minutes',now())`,
    [first.accountId, pendingFlow, opaqueVerifier()])).rejects.toSatisfy((error: unknown) => errorCode(error) === "23503");
    await expect(pool.query(`INSERT INTO downtown_u_operator_auth_challenges
      (operator_id,flow_id,purpose,factor,challenge_verifier,expires_at)
      VALUES ($1,$2,'sign_in','email_magic_link',$3,now()+interval '5 minutes')`,
    [second.accountId, pendingFlow, opaqueVerifier()])).rejects.toSatisfy((error: unknown) => errorCode(error) === "23503");
    await expect(pool.query(`INSERT INTO downtown_u_operator_auth_challenges
      (operator_id,session_id,purpose,factor,challenge_verifier,expires_at)
      VALUES ($1,$2,'reauth','sms_otp',$3,now()+interval '5 minutes')`,
    [second.accountId, first.sessionId, opaqueVerifier()])).rejects.toSatisfy((error: unknown) => errorCode(error) === "23503");
    await expect(pool.query(`INSERT INTO downtown_u_operator_auth_challenges
      (operator_id,session_id,purpose,factor,challenge_verifier,expires_at)
      VALUES ($1,$2,'reauth','email_magic_link',$3,now()+interval '5 minutes')`,
    [first.accountId, first.sessionId, opaqueVerifier()])).rejects.toSatisfy((error: unknown) => errorCode(error) === "23514");
    await expect(pool.query(`INSERT INTO downtown_u_operator_sessions
      (operator_id,consumed_auth_flow_id,session_verifier,absolute_expires_at,idle_expires_at,last_seen_at)
      VALUES ($1,$2,$3,now()+interval '9 hours',now()+interval '31 minutes',now())`,
    [second.accountId, second.flowId, opaqueVerifier()])).rejects.toSatisfy((error: unknown) => ["23514", "23505"].includes(errorCode(error) ?? ""));
    await expect(pool.query(`INSERT INTO downtown_u_operator_auth_flows
      (operator_id,flow_verifier,expires_at) VALUES ($1,$2,now()+interval '5 minutes')`,
    [second.accountId, opaqueVerifier().fill(77)])).resolves.toBeTruthy();
    await expect(pool.query(`INSERT INTO downtown_u_operator_auth_flows
      (operator_id,flow_verifier,expires_at) VALUES ($1,$2,now()+interval '5 minutes')`,
    [second.accountId, Buffer.alloc(32, 77)])).rejects.toSatisfy((error: unknown) => errorCode(error) === "23505");
    await expect(pool.query(`INSERT INTO downtown_u_operator_auth_challenges
      (operator_id,flow_id,purpose,factor,challenge_verifier,expires_at)
      VALUES ($1,$2,'sign_in','sms_otp','short'::bytea,now()+interval '5 minutes')`,
    [first.accountId, pendingFlow])).rejects.toSatisfy((error: unknown) => errorCode(error) === "23514");
    await expect(controlled(pool, `INSERT INTO downtown_u_operator_audit_events
      (operator_id,session_id,action_code,target_type,target_id,reason_code,reason,idempotency_key,correlation_id)
      VALUES ($1,$2,'cross_actor','student','cross','test_reason','Cross actor rejection','cross-actor-key-0001','cross-correlation-0001')`,
    [second.accountId, first.sessionId])).rejects.toSatisfy((error: unknown) => errorCode(error) === "23503");
    const sessionColumns = (await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='downtown_u_operator_sessions'`)).rows.map((row) => row.column_name);
    expect(sessionColumns).not.toEqual(expect.arrayContaining(["assurance_level", "recent_reauth_at", "mfa_verified_at"]));
    expect(second.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("permits rolling idle expiry while rejecting impossible session chronology and bounds", async () => {
    const operatorId = (await pool.query<{ id: string }>(`INSERT INTO downtown_u_operator_accounts
      (normalized_email,normalized_phone,display_name,provisioning_reference)
      VALUES ('rolling-idle@example.edu','+12025550107','Rolling Idle Operator','provision:rolling-idle') RETURNING id`)).rows[0].id;
    const consumedFlowId = (await pool.query<{ id: string }>(`INSERT INTO downtown_u_operator_auth_flows
      (operator_id,status,flow_verifier,created_at,updated_at,expires_at,completed_at,consumed_at)
      VALUES ($1,'consumed',$2,now()-interval '1 second',now(),now()+interval '10 minutes',now(),now()) RETURNING id`,
    [operatorId, opaqueVerifier()])).rows[0].id;
    for (const factor of ["email_magic_link", "sms_otp"]) {
      await pool.query(`INSERT INTO downtown_u_operator_auth_challenges
        (operator_id,flow_id,purpose,factor,status,challenge_verifier,created_at,updated_at,expires_at,verified_at,consumed_at)
        VALUES ($1,$2,'sign_in',$3,'consumed',$4,now()-interval '1 second',now(),now()+interval '10 minutes',now(),now())`,
      [operatorId, consumedFlowId, factor, opaqueVerifier()]);
    }
    await expect(pool.query(`INSERT INTO downtown_u_operator_sessions
      (operator_id,consumed_auth_flow_id,session_verifier,created_at,last_seen_at,updated_at,idle_expires_at,absolute_expires_at)
      VALUES ($1,$2,$3,now()-interval '20 minutes',now(),now(),now()+interval '30 minutes',now()+interval '7 hours')`,
    [operatorId, consumedFlowId, opaqueVerifier()])).resolves.toBeTruthy();

    const rejectedFlowId = (await pool.query<{ id: string }>(`INSERT INTO downtown_u_operator_auth_flows
      (operator_id,status,flow_verifier,created_at,updated_at,expires_at,completed_at,consumed_at)
      VALUES ($1,'consumed',$2,now()-interval '1 second',now(),now()+interval '10 minutes',now(),now()) RETURNING id`,
    [operatorId, opaqueVerifier()])).rows[0].id;
    for (const factor of ["email_magic_link", "sms_otp"]) {
      await pool.query(`INSERT INTO downtown_u_operator_auth_challenges
        (operator_id,flow_id,purpose,factor,status,challenge_verifier,created_at,updated_at,expires_at,verified_at,consumed_at)
        VALUES ($1,$2,'sign_in',$3,'consumed',$4,now()-interval '1 second',now(),now()+interval '10 minutes',now(),now())`,
      [operatorId, rejectedFlowId, factor, opaqueVerifier()]);
    }
    const invalidChronologies = [
      ["now()-interval '20 minutes'", "now()", "now()", "now()+interval '31 minutes'", "now()+interval '7 hours'"],
      ["now()-interval '20 minutes'", "now()-interval '21 minutes'", "now()", "now()+interval '5 minutes'", "now()+interval '7 hours'"],
      ["now()-interval '20 minutes'", "now()", "now()-interval '1 minute'", "now()+interval '20 minutes'", "now()+interval '7 hours'"],
      ["now()-interval '20 minutes'", "now()", "now()", "now()+interval '30 minutes'", "now()+interval '20 minutes'"],
      ["now()-interval '20 minutes'", "now()", "now()", "now()+interval '20 minutes'", "now()+interval '7 hours 41 minutes'"],
    ];
    for (const [createdAt, lastSeenAt, updatedAt, idleExpiresAt, absoluteExpiresAt] of invalidChronologies) {
      await expect(pool.query(`INSERT INTO downtown_u_operator_sessions
        (operator_id,consumed_auth_flow_id,session_verifier,created_at,last_seen_at,updated_at,idle_expires_at,absolute_expires_at)
        VALUES ($1,$2,$3,${createdAt},${lastSeenAt},${updatedAt},${idleExpiresAt},${absoluteExpiresAt})`,
      [operatorId, rejectedFlowId, opaqueVerifier()])).rejects.toSatisfy((error: unknown) => errorCode(error) === "23514");
    }
  });

  it("requires the exact tx-local owner setting and keeps all evidence append-only with no PUBLIC execute", async () => {
    const operator = await provisionOperator("evidence@example.edu", "+12025550106");
    const values = [operator.accountId, operator.sessionId, studentId];
    const auditStatement = `INSERT INTO downtown_u_operator_audit_events(operator_id,session_id,action_code,target_type,target_id,reason_code,reason,idempotency_key,correlation_id)
      VALUES ($1,$2,'view_account','student',$3,'test_reason','Controlled test','audit-evidence-key-0001','audit-correlation-0001')`;
    await expect(pool.query(auditStatement, values)).rejects.toThrow(/owner capability controlled/i);
    await controlled(pool, auditStatement, values);

    const eligibilityAudit = await createAudit(operator.accountId, operator.sessionId, "eligibility_change",
      "audit-eligibility-0001", "eligibility-correlation-0001");
    const caseAudit = await createAudit(operator.accountId, operator.sessionId, "case_create",
      "audit-case-create-0001", "manual-case-correlation-0001");
    const adjustmentAudit = await createAudit(operator.accountId, operator.sessionId, "credit_adjust",
      "audit-adjustment-0001", "adjustment-correlation-0001");
    const inserts = [
      [`INSERT INTO downtown_u_eligibility_events(operator_id,session_id,student_id,from_status,to_status,reason_code,reason,idempotency_key,correlation_id,audit_event_id)
        VALUES ($1,$2,$3,'pending','approved','test_reason','Controlled test','eligibility-key-0001','eligibility-correlation-0001',$4)`, [...values, eligibilityAudit]],
      [`INSERT INTO downtown_u_operator_reconciliation_cases(source_type,source_id,student_id,reason_code,reason,idempotency_key,correlation_id,audit_event_id,created_by_operator_id,created_by_session_id,origin)
        VALUES ('kitchen','manual-case-source',$3,'test_reason','Controlled test','manual-case-key-0001','manual-case-correlation-0001',$4,$1,$2,'operator')`, [...values, caseAudit]],
      [`INSERT INTO downtown_u_operator_adjustments(operator_id,session_id,student_id,delta,reason_code,reason,idempotency_key,correlation_id,audit_event_id,target_type,target_id)
        VALUES ($1,$2,$3,1,'test_reason','Controlled test','adjustment-key-0001','adjustment-correlation-0001',$4,'student','operator-adjustment-target')`, [...values, adjustmentAudit]],
      [`INSERT INTO downtown_u_operator_security_events(operator_id,session_id,event_code,outcome,factor,correlation_id)
        VALUES ($1,$2,'success','succeeded','sms_otp','security-correlation-0001')`, values.slice(0, 2)],
      [`INSERT INTO downtown_u_operator_owner_events(target_operator_id,event_code,admin_reference,reason_code,reason,correlation_id)
        VALUES ($1,'account_provision','admin-fixture','test_reason','Controlled provisioning','owner-correlation-0001')`, values.slice(0, 1)],
    ] as const;
    for (const [statement, parameters] of inserts) {
      const queryParameters: unknown[] = [...parameters] as unknown[];
      await expect(pool.query(statement, queryParameters)).rejects.toThrow(/owner capability controlled/i);
      await controlled(pool, statement, queryParameters);
    }
    const caseId = (await pool.query<{ id: string }>("SELECT id FROM downtown_u_operator_reconciliation_cases WHERE source_id='manual-case-source'")).rows[0].id;
    const resolutionAudit = await createAudit(operator.accountId, operator.sessionId, "case_resolve",
      "audit-resolution-0001", "resolution-correlation-0001");
    const resolution = `INSERT INTO downtown_u_operator_reconciliation_resolutions
      (case_id,operator_id,session_id,resolution_code,reason_code,reason,idempotency_key,correlation_id,audit_event_id,target_type,target_id)
      VALUES ($1,$2,$3,'confirmed','test_reason','Controlled resolution','resolution-key-0001','resolution-correlation-0001',$4,'case','manual-case-source')`;
    await expect(pool.query(resolution, [caseId, operator.accountId, operator.sessionId, resolutionAudit])).rejects.toThrow(/owner capability controlled/i);
    await controlled(pool, resolution, [caseId, operator.accountId, operator.sessionId, resolutionAudit]);

    for (const table of ["downtown_u_operator_audit_events", "downtown_u_eligibility_events",
      "downtown_u_operator_reconciliation_cases", "downtown_u_operator_reconciliation_resolutions", "downtown_u_operator_adjustments",
      "downtown_u_operator_security_events", "downtown_u_operator_owner_events"]) {
      for (const statement of [`UPDATE ${table} SET created_at=created_at`, `DELETE FROM ${table}`]) {
        await pool.query("BEGIN");
        await pool.query(`SELECT set_config('downtown_u.operator_write',pg_backend_pid()::text||':'||pg_current_xact_id()::text,true)`);
        await expect(pool.query(statement)).rejects.toThrow(/append-only/i);
        await pool.query("ROLLBACK");
      }
      await pool.query("BEGIN");
      await pool.query(`SELECT set_config('downtown_u.operator_write',pg_backend_pid()::text||':'||pg_current_xact_id()::text,true)`);
      await expect(pool.query(`TRUNCATE ${table}`)).rejects.toThrow();
      await pool.query("ROLLBACK");
    }
    expect((await pool.query(`SELECT has_function_privilege('public','public.downtown_u_operator_append_only_guard()','EXECUTE') allowed`)).rows[0].allowed).toBe(false);
  });

  it("rejects audit and eligibility idempotency-key reuse across actions and students", async () => {
    const operator = await provisionOperator("global-idempotency@example.edu", "+12025550108");
    const secondStudentId = (await pool.query<{ id: string }>(
      "INSERT INTO downtown_u_students(normalized_email) VALUES ('global-idempotency-student@example.edu') RETURNING id",
    )).rows[0].id;

    await createAudit(operator.accountId, operator.sessionId, "first_action",
      "audit-global-key-0001", "audit-global-correlation-0001");
    await expect(createAudit(operator.accountId, operator.sessionId, "second_action",
      "audit-global-key-0001", "audit-global-correlation-0002"))
      .rejects.toSatisfy((error: unknown) => errorCode(error) === "23505");

    const firstEligibilityAudit = await createAudit(operator.accountId, operator.sessionId, "eligibility_first",
      "audit-global-key-0002", "eligibility-global-correlation-0001");
    await controlled(pool, `INSERT INTO downtown_u_eligibility_events
      (operator_id,session_id,student_id,from_status,to_status,reason_code,reason,idempotency_key,correlation_id,audit_event_id)
      VALUES ($1,$2,$3,'pending','approved','test_reason','First valid eligibility event',
        'eligibility-global-key-0001','eligibility-global-correlation-0001',$4)`,
    [operator.accountId, operator.sessionId, studentId, firstEligibilityAudit]);

    const secondEligibilityAudit = await createAudit(operator.accountId, operator.sessionId, "eligibility_second",
      "audit-global-key-0003", "eligibility-global-correlation-0002");
    await expect(controlled(pool, `INSERT INTO downtown_u_eligibility_events
      (operator_id,session_id,student_id,from_status,to_status,reason_code,reason,idempotency_key,correlation_id,audit_event_id)
      VALUES ($1,$2,$3,'pending','rejected','test_reason','Second valid eligibility event',
        'eligibility-global-key-0001','eligibility-global-correlation-0002',$4)`,
    [operator.accountId, operator.sessionId, secondStudentId, secondEligibilityAudit]))
      .rejects.toSatisfy((error: unknown) => errorCode(error) === "23505");
  });

  it("backfills exactly one immutable refund and kitchen case, remains idempotent, and never rewrites sources", async () => {
    expect((await pool.query(`SELECT source_type,count(*)::int n FROM downtown_u_operator_reconciliation_cases
      WHERE (source_type='refund' AND source_id=$1) OR (source_type='kitchen' AND source_id=$2)
      GROUP BY source_type ORDER BY source_type`, [refundSourceId, kitchenSourceId])).rows).toEqual([
      { source_type: "kitchen", n: 1 }, { source_type: "refund", n: 1 },
    ]);
    await controlled(pool, `INSERT INTO downtown_u_operator_reconciliation_cases
      (source_type,source_id,student_id,reason_code,reason,idempotency_key,correlation_id,origin,created_at)
      SELECT 'refund',q.id::text,q.student_id,q.reason_code,'Imported immutable refund reconciliation',
        'operator_case:refund:'||q.id::text,'operator_case:refund:'||q.id::text,'migration_backfill',q.created_at
      FROM downtown_u_refund_reconciliations q ON CONFLICT (source_type,source_id) DO NOTHING`);
    await controlled(pool, `INSERT INTO downtown_u_operator_reconciliation_cases
      (source_type,source_id,student_id,reason_code,reason,idempotency_key,correlation_id,origin,created_at)
      SELECT 'kitchen',o.redemption_id::text,r.student_id,'kitchen_operator_review',
        'Imported kitchen operator review','operator_case:kitchen:'||o.redemption_id::text,
        'operator_case:kitchen:'||o.redemption_id::text,'migration_backfill',o.updated_at
      FROM downtown_u_kitchen_order_outbox o JOIN downtown_u_redemptions r ON r.id=o.redemption_id
      WHERE o.state='operator_review' ON CONFLICT (source_type,source_id) DO NOTHING`);
    expect((await pool.query("SELECT count(*)::int n FROM downtown_u_operator_reconciliation_cases WHERE origin='migration_backfill'")).rows[0].n).toBe(2);
    expect((await pool.query("SELECT to_jsonb(q) AS row FROM downtown_u_refund_reconciliations q WHERE id=$1", [refundSourceId])).rows[0].row).toEqual(refundSourceBefore);
    expect((await pool.query("SELECT to_jsonb(o) AS row FROM downtown_u_kitchen_order_outbox o WHERE redemption_id=$1", [kitchenSourceId])).rows[0].row).toEqual(kitchenSourceBefore);
  });

  it("synchronizes post-migration refund inserts and kitchen review transitions exactly once without changing sources", async () => {
    const syncStudent = (await pool.query<{ id: string }>(
      "INSERT INTO downtown_u_students(normalized_email) VALUES ('operator-sync@example.edu') RETURNING id",
    )).rows[0].id;
    const purchaseId = (await pool.query<{ id: string }>(`INSERT INTO downtown_u_plan_purchases
      (student_id,plan_id,credits_granted,price_cents,square_payment_id,square_order_id,source_event_id,paid_at)
      VALUES ($1,'flex-5',5,6000,'operator-sync-payment','operator-sync-order','operator-sync-event',now()) RETURNING id`,
    [syncStudent])).rows[0].id;
    const applicationId = (await pool.query<{ id: string }>(`INSERT INTO downtown_u_refund_applications
      (square_refund_id,source_event_id,square_payment_id,square_order_id,purchase_id,student_id,
       authoritative_amount_cents,authoritative_currency,authoritative_location_id,authoritative_updated_at,
       refund_sequence,cumulative_refunded_cents,target_refunded_credits,credit_delta,available_credits_before,status)
      VALUES ('operator-sync-refund','operator-sync-refund-event','operator-sync-payment','operator-sync-order',$1,$2,
       6000,'USD','LPPWSSV03BHK8','2026-08-05T00:00:00Z',1,6000,5,5,0,'reconciliation_required') RETURNING id`,
    [purchaseId, syncStudent])).rows[0].id;
    const refund = (await pool.query(`INSERT INTO downtown_u_refund_reconciliations
      (refund_application_id,purchase_id,student_id,reason_code,required_credits,available_credits)
      VALUES ($1,$2,$3,'insufficient_available_credits',5,0) RETURNING *`,
    [applicationId, purchaseId, syncStudent])).rows[0];
    expect((await pool.query(`SELECT count(*)::int n FROM downtown_u_operator_reconciliation_cases
      WHERE source_type='refund' AND source_id=$1`, [refund.id])).rows[0].n).toBe(1);
    expect((await pool.query("SELECT * FROM downtown_u_refund_reconciliations WHERE id=$1", [refund.id])).rows[0])
      .toEqual(refund);

    const redemptionId = (await pool.query<{ id: string }>(`INSERT INTO downtown_u_redemptions
      (student_id,credits,idempotency_key,status,expires_at)
      VALUES ($1,1,'operator-sync-kitchen','reserved',now()+interval '20 minutes') RETURNING id`, [syncStudent])).rows[0].id;
    await pool.query(`INSERT INTO downtown_u_reservation_snapshots
      (redemption_id,meal_rule_id,meal_public_id,meal_display_name,meal_square_catalog_object_id,modifiers,credits)
      VALUES ($1,'operator-fixture-meal','operator-fixture-meal','Fixture Meal','CATALOG_OPERATOR_FIXTURE','[]',1)`, [redemptionId]);
    await pool.query("BEGIN");
    await pool.query(`SELECT set_config('downtown_u.kitchen_write',pg_backend_pid()::text||':'||pg_current_xact_id()::text,true)`);
    await pool.query(`UPDATE downtown_u_kitchen_order_outbox SET state='operator_review',
      error_code='abcdefghijklmnopqrstuvwxyz0123456789_abcdefghijk',updated_at=clock_timestamp() WHERE redemption_id=$1`, [redemptionId]);
    await pool.query("COMMIT");
    const sourceAfter = (await pool.query("SELECT to_jsonb(o) row FROM downtown_u_kitchen_order_outbox o WHERE redemption_id=$1", [redemptionId])).rows[0].row;
    expect((await pool.query(`SELECT reason_code,count(*)::int n FROM downtown_u_operator_reconciliation_cases
      WHERE source_type='kitchen' AND source_id=$1 GROUP BY reason_code`, [redemptionId])).rows)
      .toEqual([{ reason_code: "kitchen_operator_review", n: 1 }]);
    await pool.query("BEGIN");
    await pool.query(`SELECT set_config('downtown_u.kitchen_write',pg_backend_pid()::text||':'||pg_current_xact_id()::text,true)`);
    await pool.query("UPDATE downtown_u_kitchen_order_outbox SET updated_at=clock_timestamp() WHERE redemption_id=$1", [redemptionId]);
    await pool.query("COMMIT");
    expect((await pool.query(`SELECT count(*)::int n FROM downtown_u_operator_reconciliation_cases
      WHERE source_type='kitchen' AND source_id=$1`, [redemptionId])).rows[0].n).toBe(1);
    const sourceAfterRepeat = (await pool.query(
      "SELECT to_jsonb(o) row FROM downtown_u_kitchen_order_outbox o WHERE redemption_id=$1", [redemptionId],
    )).rows[0].row;
    delete sourceAfter.updated_at;
    delete sourceAfterRepeat.updated_at;
    expect(sourceAfterRepeat).toEqual(sourceAfter);
  });

  it("derives resolution state without a mutable case state and enforces one resolution", async () => {
    const columns = (await pool.query<{ attname: string }>(`SELECT attname FROM pg_attribute
      WHERE attrelid='downtown_u_operator_reconciliation_cases'::regclass AND attnum>0 AND NOT attisdropped`)).rows.map((row) => row.attname);
    expect(columns).not.toContain("status");
    expect(columns).not.toContain("state");
    expect(columns).not.toContain("resolved");
    expect((await pool.query("SELECT resolved FROM downtown_u_operator_reconciliation_case_state WHERE source_id='manual-case-source'")).rows[0].resolved).toBe(true);
    const resolution = (await pool.query("SELECT * FROM downtown_u_operator_reconciliation_resolutions WHERE idempotency_key='resolution-key-0001'")).rows[0];
    await expect(controlled(pool, `INSERT INTO downtown_u_operator_reconciliation_resolutions
      (case_id,operator_id,session_id,resolution_code,reason_code,reason,idempotency_key,correlation_id,audit_event_id,target_type,target_id)
      VALUES ($1,$2,$3,'duplicate','test_reason','Duplicate resolution','resolution-key-0002',$4,$5,'case','duplicate-case-resolution')`,
    [resolution.case_id, resolution.operator_id, resolution.session_id, resolution.correlation_id, resolution.audit_event_id]))
      .rejects.toSatisfy((error: unknown) => errorCode(error) === "23505");
  });

  it("preserves legacy ledger constraints and exposes no operator ledger mutation capability", async () => {
    const ledgerStudent = (await pool.query<{ id: string }>("INSERT INTO downtown_u_students(normalized_email) VALUES ('operator-ledger@example.edu') RETURNING id")).rows[0].id;
    const purchase = (await pool.query<{ id: string }>(`INSERT INTO downtown_u_plan_purchases
      (student_id,plan_id,credits_granted,price_cents,square_payment_id,square_order_id,source_event_id,paid_at)
      VALUES ($1,'flex-5',5,6000,'operator-ledger-payment','operator-ledger-order','operator-ledger-event',now()) RETURNING id`,
    [ledgerStudent])).rows[0].id;
    await pool.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,purchase_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id,metadata)
      VALUES ($1,$2,5,5,'purchase_grant','verified Square payment','purchase_grant:operator-ledger-payment',
        'square_webhook','operator-ledger-event','square_payment','operator-ledger-payment','{"currency":"USD","locationId":"LPPWSSV03BHK8"}')`,
    [ledgerStudent, purchase]);
    expect((await pool.query(`SELECT s.credit_balance,(SELECT sum(t.delta)::int FROM downtown_u_credit_transactions t WHERE t.student_id=s.id) balance
      FROM downtown_u_students s WHERE s.id=$1`, [ledgerStudent])).rows[0]).toEqual({ credit_balance: 5, balance: 5 });
    await expect(pool.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
      VALUES ($1,1,6,'operator_adjustment','malformed','malformed-adjustment-key','operator','x','operator_adjustment','missing')`,
    [ledgerStudent])).rejects.toSatisfy((error: unknown) => errorCode(error) === "23514");
    expect((await pool.query(`SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE '%operator%adjust%'`)).rows[0].n).toBe(0);
    await asPrincipal(operatorLogin, async (client) => {
      expect((await client.query("SELECT has_table_privilege(current_user,'downtown_u_credit_transactions','INSERT') allowed")).rows[0].allowed).toBe(false);
      await expectDenied(client.query(`INSERT INTO downtown_u_credit_transactions
        (student_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
        VALUES ($1,1,6,'operator_adjustment','forbidden','forbidden-adjustment-key','operator','x','operator_adjustment','x')`, [ledgerStudent]));
    });
  });

  it("creates lookup indexes and FK/check constraints that reject malformed identities", async () => {
    const indexes = (await pool.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE schemaname='public'
      AND tablename IN ('downtown_u_operator_auth_challenges','downtown_u_operator_sessions')`)).rows.map((row) => row.indexname);
    for (const name of ["downtown_u_operator_auth_challenges_digest_idx", "downtown_u_operator_auth_challenges_expiry_idx",
      "downtown_u_operator_sessions_digest_idx", "downtown_u_operator_sessions_expiry_idx", "downtown_u_operator_sessions_operator_idx"]) {
      expect(indexes).toContain(name);
    }
    const constraints = (await pool.query(`SELECT contype,count(*)::int n FROM pg_constraint
      WHERE connamespace='public'::regnamespace AND conrelid::regclass::text LIKE 'downtown_u_operator_%'
      GROUP BY contype ORDER BY contype`)).rows;
    expect(constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ contype: "c" }), expect.objectContaining({ contype: "f" }), expect.objectContaining({ contype: "u" }),
    ]));
    await expect(pool.query(`INSERT INTO downtown_u_operator_auth_flows
      (operator_id,flow_verifier,expires_at) VALUES (gen_random_uuid(),decode(repeat('ab',32),'hex'),now()+interval '1 minute')`))
      .rejects.toSatisfy((error: unknown) => errorCode(error) === "23503");
    await expect(pool.query(`INSERT INTO downtown_u_operator_auth_challenges
      (operator_id,flow_id,purpose,factor,challenge_verifier,expires_at)
      VALUES (gen_random_uuid(),gen_random_uuid(),'sign_in','email_magic_link',decode(repeat('cd',32),'hex'),now()+interval '1 minute')`))
      .rejects.toSatisfy((error: unknown) => errorCode(error) === "23503");
  });

  it("rejects an unsafe preexisting operator role and rolls migration 009 back without a committed LOGIN window", async () => {
    await admin.query(`CREATE DATABASE ${qi(unsafeDatabaseName)}`);
    const unsafeUrl = new URL(baseUrl!);
    unsafeUrl.pathname = `/${unsafeDatabaseName}`;
    const unsafe = new Pool({ connectionString: unsafeUrl.toString(), max: 2 });
    try {
      for (const migration of migrations.slice(0, 8)) await unsafe.query(migration);
      const client = await unsafe.connect();
      try {
        await client.query("BEGIN");
        await client.query(`REVOKE downtown_u_operator_runtime FROM ${qi(operatorLogin)}`);
        await client.query("ALTER ROLE downtown_u_operator_runtime LOGIN");
        expect((await client.query(`SELECT rolcanlogin,rolconfig FROM pg_roles
          WHERE rolname='downtown_u_operator_runtime'`)).rows[0]).toEqual({ rolcanlogin: true, rolconfig: null });
        await expect(client.query(migrations[8])).rejects.toThrow(/Existing downtown_u_operator_runtime role is unsafe/i);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      expect((await unsafe.query("SELECT to_regclass('public.downtown_u_operator_accounts') relation")).rows[0].relation).toBeNull();
      expect((await unsafe.query(`SELECT count(*)::int n FROM information_schema.columns
        WHERE table_schema='public' AND table_name='downtown_u_credit_transactions' AND column_name='operator_adjustment_id'`)).rows[0].n).toBe(0);
      expect((await pool.query(`SELECT rolcanlogin FROM pg_roles WHERE rolname='downtown_u_operator_runtime'`)).rows[0].rolcanlogin).toBe(false);
      expect((await pool.query(`SELECT count(*)::int n FROM pg_auth_members m
        JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member
        WHERE r.rolname='downtown_u_operator_runtime' AND u.rolname=$1`, [operatorLogin])).rows[0].n).toBe(1);
    } finally {
      await unsafe.end();
    }
  }, 30_000);
});
