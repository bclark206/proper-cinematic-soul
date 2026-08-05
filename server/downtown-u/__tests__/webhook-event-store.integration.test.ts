import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDowntownURuntimeIdentity } from "../postgres-runtime-identity";
import { PostgresWebhookEventStore } from "../postgres-webhook-event-store";
import { WebhookEventConflictError, WebhookEventTransitionError } from "../webhook-event-store";

const baseUrl = process.env.TEST_DATABASE_URL;
const run = baseUrl ? describe : describe.skip;
const databaseName = `downtown_u_webhook_test_${process.pid}_${Date.now()}`;
const runtimeLogin = `downtown_u_webhook_login_${process.pid}_${Date.now()}`;
const runtimePassword = randomUUID().replaceAll("-", "");
const migrations = ["202608040001_downtown_u_phase1.sql", "202608040002_downtown_u_webhook_events.sql", "202608040003_downtown_u_payment_activation.sql", "202608040004_downtown_u_refund_activation.sql", "202608040005_downtown_u_auth.sql", "202608040006_downtown_u_student_portal.sql"].map((name) => readFileSync(resolve(process.cwd(), "db/migrations", name), "utf8"));
let admin: Pool;
let owner: Pool;
let runtime: Pool;
let runtimeUrl: string;
function qi(value: string) { return `"${value.replaceAll('"', '""')}"`; }
function code(error: unknown) { return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined; }
const exactGateTrigger = `CREATE TRIGGER downtown_u_00_purchase_grant_gate
  BEFORE INSERT ON public.downtown_u_credit_transactions
  FOR EACH ROW EXECUTE FUNCTION public.downtown_u_require_trusted_purchase_grant()`;
async function freshPreflight() {
  const pool = new Pool({ connectionString: runtimeUrl, max: 2 });
  try {
    await assertDowntownURuntimeIdentity(pool);
  } finally {
    await pool.end();
  }
}

run.sequential("durable webhook claims on PostgreSQL 16", () => {
  beforeAll(async () => {
    const parsed = new URL(baseUrl!);
    const baseDb = parsed.pathname.slice(1);
    if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) && !/(^|[_-])(test|testing|disposable)([_-]|$)/i.test(baseDb)) throw new Error("Refusing integration tests: TEST_DATABASE_URL must be local or explicitly test-named");
    admin = new Pool({ connectionString: baseUrl, max: 2 });
    await admin.query(`CREATE DATABASE ${qi(databaseName)}`);
    parsed.pathname = `/${databaseName}`;
    owner = new Pool({ connectionString: parsed.toString(), max: 30 });
    const serverVersion = Number((await owner.query("SHOW server_version_num")).rows[0].server_version_num);
    if (serverVersion < 160000 || serverVersion >= 170000) {
      throw new Error(`Webhook integration tests require PostgreSQL 16, got ${serverVersion}`);
    }
    await owner.query(migrations[0]);
    await owner.query(migrations[1]);
    await owner.query(migrations[2]);
    await owner.query(migrations[3]);
    await owner.query(migrations[4]);
    await owner.query(migrations[5]);
    await owner.query(`CREATE ROLE ${qi(runtimeLogin)} LOGIN PASSWORD '${runtimePassword}'`);
    await owner.query(`GRANT downtown_u_runtime TO ${qi(runtimeLogin)}`);
    const loginUrl = new URL(parsed);
    loginUrl.username = runtimeLogin;
    loginUrl.password = runtimePassword;
    runtimeUrl = loginUrl.toString();
    runtime = new Pool({ connectionString: runtimeUrl, max: 30 });
  }, 30_000);
  afterAll(async () => {
    await runtime?.end(); await owner?.end();
    if (admin) {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${qi(databaseName)}`);
      await admin.query(`DROP ROLE IF EXISTS ${qi(runtimeLogin)}`);
      await admin.end();
    }
  }, 30_000);

  it("allows one of 24 concurrent identical claims and stores one minimal row", async () => {
    const stores = Array.from({ length: 24 }, () => new PostgresWebhookEventStore(runtime));
    const outcomes = await Promise.all(stores.map((store) => store.claim("evt_concurrent", "payment.updated", "a".repeat(64))));
    expect(outcomes.filter((x) => x.outcome === "claimed")).toHaveLength(1);
    expect(outcomes.filter((x) => x.outcome === "in_progress")).toHaveLength(23);
    const row = await owner.query("SELECT * FROM public.downtown_u_webhook_events WHERE square_event_id='evt_concurrent'");
    expect(row.rowCount).toBe(1);
    expect(Object.keys(row.rows[0]).sort()).toEqual(["attempt_count","claim_token","completed_at","created_at","event_type","failed_at","failure_code","failure_detail","raw_body_sha256","received_at","square_event_id","started_at","status","updated_at"].sort());
  });

  it("returns stable duplicate/in-progress and rejects changed identity", async () => {
    const store = new PostgresWebhookEventStore(runtime);
    const first = await store.claim("evt_identity", "refund.updated", "b".repeat(64));
    expect(first.outcome).toBe("claimed");
    await expect(store.claim("evt_identity", "refund.updated", "b".repeat(64))).resolves.toMatchObject({ outcome: "in_progress", attemptCount: 1 });
    await expect(store.claim("evt_identity", "payment.updated", "b".repeat(64))).rejects.toBeInstanceOf(WebhookEventConflictError);
    await expect(store.claim("evt_identity", "refund.updated", "c".repeat(64))).rejects.toBeInstanceOf(WebhookEventConflictError);
    if (first.outcome === "claimed") await store.complete("evt_identity", first.claimToken);
    await expect(store.claim("evt_identity", "refund.updated", "b".repeat(64))).resolves.toMatchObject({ outcome: "duplicate", attemptCount: 1 });
  });

  it("enforces completion ownership and atomically retries failed claims", async () => {
    const store = new PostgresWebhookEventStore(runtime);
    const first = await store.claim("evt_retry", "payment.updated", "d".repeat(64));
    if (first.outcome !== "claimed") throw new Error("expected claim");
    await expect(store.complete("evt_retry", "00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(WebhookEventTransitionError);
    await store.fail("evt_retry", first.claimToken, "upstream_timeout", "retryable upstream failure");
    const retry = await store.claim("evt_retry", "payment.updated", "d".repeat(64));
    expect(retry).toMatchObject({ outcome: "claimed", attemptCount: 2 });
    if (retry.outcome !== "claimed") throw new Error("expected retry");
    expect(retry.claimToken).not.toBe(first.claimToken);
    await expect(store.complete("evt_retry", first.claimToken)).rejects.toBeInstanceOf(WebhookEventTransitionError);
    await store.complete("evt_retry", retry.claimToken);
    await expect(store.complete("evt_retry", retry.claimToken)).rejects.toBeInstanceOf(WebhookEventTransitionError);
    await expect(store.claim("evt_retry", "payment.updated", "d".repeat(64))).resolves.toMatchObject({ outcome: "duplicate", attemptCount: 2 });
  });

  it("takes over an abandoned five-minute lease with a new token but never reopens completed work", async () => {
    const staleToken = randomUUID();
    await owner.query(`INSERT INTO public.downtown_u_webhook_events
      (square_event_id,event_type,raw_body_sha256,status,attempt_count,received_at,started_at,claim_token)
      VALUES ('evt_stale','payment.updated',repeat('e',64),'processing',1,
        clock_timestamp()-interval '6 minutes',clock_timestamp()-interval '6 minutes',$1)`, [staleToken]);
    const store = new PostgresWebhookEventStore(runtime);
    const takeover = await store.claim("evt_stale", "payment.updated", "e".repeat(64));
    expect(takeover).toMatchObject({ outcome: "claimed", attemptCount: 2 });
    if (takeover.outcome !== "claimed") throw new Error("expected stale takeover");
    expect(takeover.claimToken).not.toBe(staleToken);
    await expect(store.complete("evt_stale", staleToken)).rejects.toBeInstanceOf(WebhookEventTransitionError);
    await store.complete("evt_stale", takeover.claimToken);
    await expect(store.claim("evt_stale", "payment.updated", "e".repeat(64))).resolves.toMatchObject({ outcome: "duplicate", attemptCount: 2 });
  });

  it("rejects owner/admin store wiring and RESET ROLE cannot increase runtime authority", async () => {
    await expect(new PostgresWebhookEventStore(owner).claim("evt_owner", "payment.updated", "1".repeat(64))).rejects.toThrow(/unsafe/i);

    expect((await runtime.query("SELECT CURRENT_USER = SESSION_USER AS direct_login")).rows[0].direct_login).toBe(true);
    await runtime.query("RESET ROLE");
    expect((await runtime.query("SELECT CURRENT_USER = SESSION_USER AS direct_login")).rows[0].direct_login).toBe(true);

    for (const sql of [
      "UPDATE public.downtown_u_webhook_events SET status='completed'",
      "CREATE TABLE public.downtown_u_illegal_ddl(id integer)",
      "UPDATE public.downtown_u_students SET credit_balance=999",
    ]) await expect(runtime.query(sql)).rejects.toSatisfy((e: unknown) => code(e) === "42501");
  });

  it("rejects an unexpected effective column grant on a fresh pool and accepts it after revoke", async () => {
    await owner.query(`GRANT UPDATE (eligibility_status) ON public.downtown_u_students TO ${qi(runtimeLogin)}`);
    const unsafe = new Pool({ connectionString: runtimeUrl, max: 2 });
    try {
      await expect(new PostgresWebhookEventStore(unsafe).claim("evt_bad_column_grant", "payment.updated", "2".repeat(64))).rejects.toThrow(/unsafe/i);
    } finally {
      await unsafe.end();
      await owner.query(`REVOKE UPDATE (eligibility_status) ON public.downtown_u_students FROM ${qi(runtimeLogin)}`);
    }

    const safe = new Pool({ connectionString: runtimeUrl, max: 2 });
    try {
      await expect(new PostgresWebhookEventStore(safe).claim("evt_column_grant_restored", "payment.updated", "3".repeat(64))).resolves.toMatchObject({ outcome: "claimed" });
    } finally {
      await safe.end();
    }
  });

  it("rejects ownership by any role the runtime login can assume and works after exact restoration", async () => {
    const originalOwner = (await owner.query<{ owner_name: string }>(
      "SELECT pg_get_userbyid(relowner) AS owner_name FROM pg_class WHERE oid='public.downtown_u_webhook_events'::regclass",
    )).rows[0].owner_name;
    await owner.query("ALTER TABLE public.downtown_u_webhook_events OWNER TO downtown_u_runtime");
    const unsafe = new Pool({ connectionString: runtimeUrl, max: 2 });
    try {
      await expect(new PostgresWebhookEventStore(unsafe).claim("evt_assumable_owner", "payment.updated", "4".repeat(64))).rejects.toThrow(/unsafe/i);
    } finally {
      await unsafe.end();
      await owner.query(`ALTER TABLE public.downtown_u_webhook_events OWNER TO ${qi(originalOwner)}`);
    }

    const safe = new Pool({ connectionString: runtimeUrl, max: 2 });
    try {
      await expect(new PostgresWebhookEventStore(safe).claim("evt_owner_restored", "payment.updated", "5".repeat(64))).resolves.toMatchObject({ outcome: "claimed" });
    } finally {
      await safe.end();
    }
  });

  it("rejects unexpected effective EXECUTE on a non-allowlisted Downtown U routine", async () => {
    await owner.query(`GRANT EXECUTE ON FUNCTION public.downtown_u_webhook_events_protect() TO ${qi(runtimeLogin)}`);
    const unsafe = new Pool({ connectionString: runtimeUrl, max: 2 });
    try {
      await expect(new PostgresWebhookEventStore(unsafe).claim("evt_bad_function_grant", "payment.updated", "6".repeat(64))).rejects.toThrow(/unsafe/i);
    } finally {
      await unsafe.end();
      await owner.query(`REVOKE EXECUTE ON FUNCTION public.downtown_u_webhook_events_protect() FROM ${qi(runtimeLogin)}`);
    }
  });

  it("rejects unsafe assumable runtime-role flags and unexpected Downtown U sequences", async () => {
    await owner.query("ALTER ROLE downtown_u_runtime LOGIN");
    const unsafeRole = new Pool({ connectionString: runtimeUrl, max: 2 });
    try {
      await expect(new PostgresWebhookEventStore(unsafeRole).claim("evt_unsafe_runtime_role", "payment.updated", "7".repeat(64))).rejects.toThrow(/unsafe/i);
    } finally {
      await unsafeRole.end();
      await owner.query("ALTER ROLE downtown_u_runtime NOLOGIN");
    }

    await owner.query("CREATE SEQUENCE public.downtown_u_unexpected_sequence");
    const unsafeSequence = new Pool({ connectionString: runtimeUrl, max: 2 });
    try {
      await expect(new PostgresWebhookEventStore(unsafeSequence).claim("evt_unexpected_sequence", "payment.updated", "8".repeat(64))).rejects.toThrow(/unsafe/i);
    } finally {
      await unsafeSequence.end();
      await owner.query("DROP SEQUENCE public.downtown_u_unexpected_sequence");
    }

    const safe = new Pool({ connectionString: runtimeUrl, max: 2 });
    try {
      await expect(new PostgresWebhookEventStore(safe).claim("evt_role_and_sequence_restored", "payment.updated", "9".repeat(64))).resolves.toMatchObject({ outcome: "claimed" });
    } finally {
      await safe.end();
    }
  });

  it("accepts only the exact enabled purchase-grant gate topology on fresh pools", async () => {
    await expect(freshPreflight()).resolves.toBeUndefined();
    const triggers = (await owner.query<{ tgname: string; tgnargs: number; arguments_hex: string; definition: string }>(`SELECT tgname,tgnargs,
      encode(tgargs,'hex') AS arguments_hex,pg_get_triggerdef(oid,true) AS definition
      FROM pg_catalog.pg_trigger
      WHERE tgrelid='public.downtown_u_credit_transactions'::regclass AND NOT tgisinternal
      AND tgname IN ('downtown_u_00_purchase_grant_gate','downtown_u_apply_credit_transaction_trigger')
      ORDER BY tgname`)).rows;
    expect(triggers.map((row) => row.tgname)).toEqual([
      "downtown_u_00_purchase_grant_gate",
      "downtown_u_apply_credit_transaction_trigger",
    ]);
    expect(triggers.every((trigger) => trigger.tgnargs === 0 && trigger.arguments_hex === "")).toBe(true);
    expect((await owner.query<{ definition: string }>(`SELECT pg_get_triggerdef(oid,true) AS definition
      FROM pg_catalog.pg_trigger WHERE tgname='downtown_u_students_ledger_balance_only'`)).rows[0].definition)
      .toContain("WHEN (old.credit_balance IS DISTINCT FROM new.credit_balance)");

    try {
      await owner.query(`ALTER TABLE public.downtown_u_credit_transactions
        DISABLE TRIGGER downtown_u_00_purchase_grant_gate`);
      await expect(freshPreflight()).rejects.toThrow(/unsafe/i);
    } finally {
      await owner.query(`ALTER TABLE public.downtown_u_credit_transactions
        ENABLE TRIGGER downtown_u_00_purchase_grant_gate`);
    }
    await expect(freshPreflight()).resolves.toBeUndefined();

    for (const driftedGateTrigger of [
      `CREATE TRIGGER downtown_u_00_purchase_grant_gate
        BEFORE INSERT ON public.downtown_u_credit_transactions
        FOR EACH ROW WHEN (false)
        EXECUTE FUNCTION public.downtown_u_require_trusted_purchase_grant()`,
      `CREATE TRIGGER downtown_u_00_purchase_grant_gate
        BEFORE INSERT ON public.downtown_u_credit_transactions
        FOR EACH ROW EXECUTE FUNCTION public.downtown_u_require_trusted_purchase_grant('drift')`,
    ]) {
      try {
        await owner.query(`DROP TRIGGER downtown_u_00_purchase_grant_gate
          ON public.downtown_u_credit_transactions`);
        await owner.query(driftedGateTrigger);
        await expect(freshPreflight()).rejects.toThrow(/unsafe/i);
      } finally {
        await owner.query(`DROP TRIGGER IF EXISTS downtown_u_00_purchase_grant_gate
          ON public.downtown_u_credit_transactions`);
        await owner.query(exactGateTrigger);
      }
      await expect(freshPreflight()).resolves.toBeUndefined();
    }

    try {
      await owner.query(`DROP TRIGGER downtown_u_00_purchase_grant_gate
        ON public.downtown_u_credit_transactions`);
      await expect(freshPreflight()).rejects.toThrow(/unsafe/i);
      for (const wrongGateTrigger of [
        `CREATE TRIGGER downtown_u_00_purchase_grant_gate
          AFTER INSERT ON public.downtown_u_credit_transactions
          FOR EACH ROW EXECUTE FUNCTION public.downtown_u_require_trusted_purchase_grant()`,
        `CREATE TRIGGER downtown_u_00_purchase_grant_gate
          BEFORE UPDATE ON public.downtown_u_credit_transactions
          FOR EACH ROW EXECUTE FUNCTION public.downtown_u_require_trusted_purchase_grant()`,
        `CREATE TRIGGER downtown_u_00_purchase_grant_gate
          BEFORE INSERT ON public.downtown_u_credit_transactions
          FOR EACH ROW EXECUTE FUNCTION public.downtown_u_apply_credit_transaction()`,
      ]) {
        await owner.query(wrongGateTrigger);
        await expect(freshPreflight()).rejects.toThrow(/unsafe/i);
        await owner.query(`DROP TRIGGER downtown_u_00_purchase_grant_gate
          ON public.downtown_u_credit_transactions`);
      }
    } finally {
      await owner.query(`DROP TRIGGER IF EXISTS downtown_u_00_purchase_grant_gate
        ON public.downtown_u_credit_transactions`);
      await owner.query(exactGateTrigger);
    }
    await expect(freshPreflight()).resolves.toBeUndefined();

    try {
      await owner.query(`CREATE TRIGGER downtown_u_unexpected_topology_trigger
        BEFORE INSERT ON public.downtown_u_credit_transactions
        FOR EACH ROW EXECUTE FUNCTION public.downtown_u_require_trusted_purchase_grant()`);
      await expect(freshPreflight()).rejects.toThrow(/unsafe/i);
    } finally {
      await owner.query(`DROP TRIGGER IF EXISTS downtown_u_unexpected_topology_trigger
        ON public.downtown_u_credit_transactions`);
    }
    await expect(freshPreflight()).resolves.toBeUndefined();
  });

  it("accepts only exact function security, language, config, and trusted ownership", async () => {
    await expect(freshPreflight()).resolves.toBeUndefined();

    for (const [drift, restore] of [
      [
        "ALTER FUNCTION public.downtown_u_require_trusted_purchase_grant() SECURITY DEFINER",
        "ALTER FUNCTION public.downtown_u_require_trusted_purchase_grant() SECURITY INVOKER",
      ],
      [
        "ALTER FUNCTION public.downtown_u_activate_verified_payment(text,uuid,text,text,text,text,integer,integer,text,text,text,text,text,text) SECURITY INVOKER",
        "ALTER FUNCTION public.downtown_u_activate_verified_payment(text,uuid,text,text,text,text,integer,integer,text,text,text,text,text,text) SECURITY DEFINER",
      ],
      [
        "ALTER FUNCTION public.downtown_u_upsert_pending_student(text,text,text) SET search_path TO pg_catalog, public",
        "ALTER FUNCTION public.downtown_u_upsert_pending_student(text,text,text) SET search_path TO pg_catalog",
      ],
    ] as const) {
      try {
        await owner.query(drift);
        await expect(freshPreflight()).rejects.toThrow(/unsafe/i);
      } finally {
        await owner.query(restore);
      }
      await expect(freshPreflight()).resolves.toBeUndefined();
    }

    const originalOwner = (await owner.query<{ owner_name: string }>(`SELECT pg_get_userbyid(proowner) AS owner_name
      FROM pg_catalog.pg_proc
      WHERE oid='public.downtown_u_upsert_pending_student(text,text,text)'::regprocedure`)).rows[0].owner_name;
    const driftOwner = `downtown_u_drift_owner_${process.pid}_${Date.now()}`;
    try {
      await owner.query(`CREATE ROLE ${qi(driftOwner)} NOLOGIN`);
      await owner.query(`ALTER FUNCTION public.downtown_u_upsert_pending_student(text,text,text)
        OWNER TO ${qi(driftOwner)}`);
      await expect(freshPreflight()).rejects.toThrow(/unsafe/i);
    } finally {
      await owner.query(`ALTER FUNCTION public.downtown_u_upsert_pending_student(text,text,text)
        OWNER TO ${qi(originalOwner)}`);
      await owner.query(`DROP ROLE IF EXISTS ${qi(driftOwner)}`);
    }
    await owner.query(`REVOKE ALL ON FUNCTION public.downtown_u_upsert_pending_student(text,text,text)
      FROM PUBLIC, downtown_u_runtime`);
    await owner.query(`GRANT EXECUTE ON FUNCTION public.downtown_u_upsert_pending_student(text,text,text)
      TO downtown_u_runtime`);
    await expect(freshPreflight()).resolves.toBeUndefined();
  });

  it("denies runtime direct DML, DDL, identity mutation, and function attachment", async () => {
    for (const sql of [
      "INSERT INTO public.downtown_u_webhook_events(square_event_id,event_type,raw_body_sha256,status,attempt_count,received_at) VALUES ('x','payment.updated',repeat('a',64),'processing',1,now())",
      "UPDATE public.downtown_u_webhook_events SET square_event_id='changed'",
      "DELETE FROM public.downtown_u_webhook_events",
      "TRUNCATE public.downtown_u_webhook_events",
      "ALTER TABLE public.downtown_u_webhook_events DISABLE TRIGGER ALL",
      "ALTER TABLE public.downtown_u_credit_transactions DISABLE TRIGGER downtown_u_00_purchase_grant_gate",
      "DROP TRIGGER downtown_u_00_purchase_grant_gate ON public.downtown_u_credit_transactions",
      "CREATE TRIGGER downtown_u_runtime_attack BEFORE INSERT ON public.downtown_u_credit_transactions FOR EACH ROW EXECUTE FUNCTION public.downtown_u_require_trusted_purchase_grant()",
      "SELECT public.downtown_u_require_trusted_purchase_grant()",
      "ALTER FUNCTION public.downtown_u_require_trusted_purchase_grant() SECURITY DEFINER",
      "ALTER FUNCTION public.downtown_u_activate_verified_payment(text,uuid,text,text,text,text,integer,integer,text,text,text,text,text,text) SECURITY INVOKER",
      "ALTER FUNCTION public.downtown_u_upsert_pending_student(text,text,text) SET search_path TO public",
      "ALTER FUNCTION public.downtown_u_upsert_pending_student(text,text,text) OWNER TO downtown_u_runtime",
    ]) await expect(runtime.query(sql)).rejects.toSatisfy((e: unknown) => code(e) === "42501");
    await runtime.query("CREATE TEMP TABLE attach_target(id int)");
    await expect(runtime.query("CREATE TRIGGER attached BEFORE INSERT ON attach_target FOR EACH ROW EXECUTE FUNCTION public.downtown_u_webhook_events_protect()")) .rejects.toSatisfy((e: unknown) => code(e) === "42501");
    expect((await runtime.query("SELECT has_table_privilege(current_user,'public.downtown_u_webhook_events','SELECT') allowed")).rows[0].allowed).toBe(false);
  });

  it("enforces field/state constraints, bounded attempts, immutability, and operational indexes", async () => {
    await expect(owner.query("SELECT * FROM public.downtown_u_fail_webhook_event('evt_concurrent','00000000-0000-0000-0000-000000000000','bad code','x')")).rejects.toThrow(/failure code/i);
    await expect(owner.query("SELECT * FROM public.downtown_u_fail_webhook_event('evt_concurrent','00000000-0000-0000-0000-000000000000','safe_code',E'unsafe\\ndetail')")).rejects.toThrow(/failure detail/i);
    await expect(owner.query("INSERT INTO public.downtown_u_webhook_events(square_event_id,event_type,raw_body_sha256,status,attempt_count,received_at,started_at) VALUES ('evt_bad_state','payment.updated',repeat('e',64),'processing',1,now(),now())")).rejects.toSatisfy((e: unknown) => code(e) === "23514");
    await expect(owner.query("INSERT INTO public.downtown_u_webhook_events(square_event_id,event_type,raw_body_sha256,status,attempt_count,received_at) VALUES ('evt_bad_hash','payment.updated','NOT_A_HASH','new',0,now())")).rejects.toSatisfy((e: unknown) => code(e) === "23514");
    await expect(owner.query("UPDATE public.downtown_u_webhook_events SET event_type='refund.updated' WHERE square_event_id='evt_concurrent'")).rejects.toThrow(/identity is immutable/i);

    await owner.query("INSERT INTO public.downtown_u_webhook_events(square_event_id,event_type,raw_body_sha256,status,attempt_count,received_at,started_at,failed_at,failure_code,failure_detail) VALUES ('evt_exhausted','payment.updated',repeat('f',64),'failed',1000,now()-interval '1 second',now()-interval '1 second',now(),'retry_limit','safe redacted failure')");
    await expect(new PostgresWebhookEventStore(runtime).claim("evt_exhausted", "payment.updated", "f".repeat(64))).resolves.toMatchObject({ outcome: "exhausted", attemptCount: 1000 });

    const defs = (await owner.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='downtown_u_webhook_events'")).rows.map((r) => r.indexdef).join("\n");
    expect(defs).toMatch(/\(status, updated_at\)/i);
    expect(defs).toMatch(/\(received_at\)/i);
  });
});
