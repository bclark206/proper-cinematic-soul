import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresKitchenJobStore, assertDowntownUKitchenJobIdentity, type KitchenClaim } from "../postgres-kitchen-job-store";

const base = process.env.TEST_DATABASE_URL;
const run = base ? describe : describe.skip;
const suffix = `${process.pid}_${Date.now()}`;
const db = `du_kitchen_${suffix}`;
const login = `du_kitchen_login_${suffix}`;
const password = randomUUID().replaceAll("-", "");
const qi = (value: string) => `"${value.replaceAll('"', '""')}"`;
const names = ["downtown_u_phase1", "downtown_u_webhook_events", "downtown_u_payment_activation", "downtown_u_refund_activation", "downtown_u_auth", "downtown_u_student_portal", "downtown_u_checkout", "downtown_u_kitchen_outbox"];
const migrations = names.map((name, index) => readFileSync(resolve(process.cwd(), "db/migrations", `20260804000${index + 1}_${name}.sql`), "utf8"));

let admin: Pool;
let owner: Pool;
let jobs: Pool;
let store: PostgresKitchenJobStore;
let legacyLive: string;
let legacyStale: string;
let legacyRedeemed: string;
let legacyReversed: string;

async function controlled(sql: string, values: unknown[] = []): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('downtown_u.kitchen_write',pg_backend_pid()::text||':'||pg_current_xact_id()::text,true)");
    await client.query(sql, values);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seed(tag: string, expires = "15 minutes"): Promise<{ sid: string; rid: string }> {
  const sid = (await owner.query("INSERT INTO downtown_u_students(normalized_email,credit_balance) VALUES($1,10) RETURNING id", [`${tag}@example.edu`])).rows[0].id;
  await owner.query("INSERT INTO downtown_u_meal_rules(id,display_name,square_catalog_object_id,base_credits,active) VALUES($1,$2,$3,2,true)", [tag, `Meal ${tag}`, `VAR_${tag}`]);
  const rid = (await owner.query("INSERT INTO downtown_u_redemptions(student_id,credits,idempotency_key,expires_at) VALUES($1,2,$2,clock_timestamp()+$3::interval) RETURNING id", [sid, `reservation_${tag}`, expires])).rows[0].id;
  await owner.query("INSERT INTO downtown_u_reservation_snapshots(redemption_id,meal_rule_id,meal_public_id,meal_display_name,meal_square_catalog_object_id,credits) VALUES($1,$2,$2,$3,$4,2)", [rid, tag, `Meal ${tag}`, `VAR_${tag}`]);
  await owner.query("INSERT INTO downtown_u_credit_transactions(student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id,metadata) VALUES($1,$2,-2,8,'reservation','meal_reserved',$3,'student',($1::uuid)::text,'reservation_request',$4,jsonb_build_object('mealId',$5::text))", [sid, rid, `reservation:reservation_${tag}`, `reservation_${tag}`, tag]);
  return { sid, rid };
}

async function reverse(sid: string, rid: string, reason = "student_cancelled"): Promise<void> {
  await owner.query("INSERT INTO downtown_u_credit_transactions(student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id) VALUES($1,$2,2,10,'redemption_reversal',$3,$4,'student',($1::uuid)::text,'student_cancellation',$5)", [sid, rid, reason, `cancel:${rid}`, rid]);
  await owner.query("UPDATE downtown_u_redemptions SET status='reversed',reversed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1", [rid]);
}

async function legacyReservation(student: string, key: string, expires: string, resultingBalance: number): Promise<string> {
  const rid = (await owner.query("INSERT INTO downtown_u_redemptions(student_id,credits,idempotency_key,expires_at) VALUES($1,2,$2,clock_timestamp()+$3::interval) RETURNING id", [student, key, expires])).rows[0].id;
  await owner.query("INSERT INTO downtown_u_reservation_snapshots(redemption_id,meal_rule_id,meal_public_id,meal_display_name,meal_square_catalog_object_id,credits) VALUES($1,'legacy','legacy','Legacy meal','VAR_LEGACY',2)", [rid]);
  await owner.query("INSERT INTO downtown_u_credit_transactions(student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id,metadata) VALUES($1,$2,-2,$5,'reservation','meal_reserved',$3,'student',($1::uuid)::text,'reservation_request',$4,jsonb_build_object('mealId','legacy'))", [student, rid, `reservation:${key}`, key, resultingBalance]);
  return rid;
}

run.sequential("durable kitchen outbox on stock PostgreSQL 16", () => {
  beforeAll(async () => {
    const url = new URL(base!);
    if (!["localhost", "127.0.0.1", "::1", ""].includes(url.hostname) && !/(test|disposable)/i.test(url.pathname)) throw new Error("unsafe TEST_DATABASE_URL");
    admin = new Pool({ connectionString: base });
    await admin.query(`CREATE DATABASE ${qi(db)}`);
    url.pathname = `/${db}`;
    owner = new Pool({ connectionString: url.toString() });
    const version = Number((await owner.query("SHOW server_version_num")).rows[0].server_version_num);
    if (version < 160000 || version >= 170000) throw new Error("PostgreSQL 16 required");
    for (const migration of migrations.slice(0, 7)) await owner.query(migration);

    const student = (await owner.query("INSERT INTO downtown_u_students(normalized_email,credit_balance) VALUES('legacy@example.edu',20) RETURNING id")).rows[0].id;
    await owner.query("INSERT INTO downtown_u_meal_rules(id,display_name,square_catalog_object_id,base_credits,active) VALUES('legacy','Legacy meal','VAR_LEGACY',2,true)");
    legacyLive = await legacyReservation(student, "legacy_live", "15 minutes", 18);
    legacyStale = await legacyReservation(student, "legacy_stale", "-1 second", 16);
    legacyRedeemed = await legacyReservation(student, "legacy_redeemed", "15 minutes", 14);
    await owner.query("UPDATE downtown_u_redemptions SET status='redeemed',square_order_id='ORDER_HISTORICAL',redeemed_at=clock_timestamp() WHERE id=$1", [legacyRedeemed]);
    legacyReversed = await legacyReservation(student, "legacy_reversed", "15 minutes", 12);
    await owner.query("INSERT INTO downtown_u_credit_transactions(student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id) VALUES($1,$2,2,14,'redemption_reversal','reservation_expired',$3,'system','expiry_job','reservation_expiry',($2::uuid)::text)", [student, legacyReversed, `expiry:${legacyReversed}`]);
    await owner.query("UPDATE downtown_u_redemptions SET status='reversed',reversed_at=clock_timestamp() WHERE id=$1", [legacyReversed]);

    await owner.query(migrations[7]);
    await owner.query("UPDATE downtown_u_kitchen_config SET enabled=true");
    await admin.query(`CREATE ROLE ${qi(login)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(`GRANT downtown_u_kitchen_jobs TO ${qi(login)}`);
    const jobUrl = new URL(url.toString());
    jobUrl.username = login;
    jobUrl.password = password;
    jobs = new Pool({ connectionString: jobUrl.toString() });
    store = new PostgresKitchenJobStore(jobs);
    await assertDowntownUKitchenJobIdentity(jobs as never);
  }, 30_000);

  afterAll(async () => {
    await jobs?.end();
    await owner?.end();
    if (admin) {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", [db]);
      await admin.query(`DROP DATABASE IF EXISTS ${qi(db)}`);
      await admin.query(`DROP ROLE IF EXISTS ${qi(login)}`);
      await admin.end();
    }
  }, 30_000);

  it("backfills valid reservations, quarantines historical redeemed identity, and safely closes stale/reversed history", async () => {
    const rows = (await owner.query("SELECT redemption_id::text,state,square_order_id,square_order_version,error_code FROM downtown_u_kitchen_order_outbox WHERE redemption_id=ANY($1::uuid[])", [[legacyLive, legacyStale, legacyRedeemed, legacyReversed]])).rows;
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ redemption_id: legacyLive, state: "pending" }),
      expect.objectContaining({ redemption_id: legacyStale, state: "cancelled" }),
      expect.objectContaining({ redemption_id: legacyRedeemed, state: "operator_review", square_order_id: "ORDER_HISTORICAL", square_order_version: null, error_code: "historical_redemption" }),
      expect.objectContaining({ redemption_id: legacyReversed, state: "cancelled" }),
    ]));
    const claim = (await store.claim(1))[0];
    expect(claim.redemptionId).toBe(legacyLive);
    expect(await store.finalize(claim, "ORDER_LEGACY", 1)).toBe("created");
  });

  it("never creates a never-attempted snapshot that is invalid at enqueue or claim", async () => {
    const invalid = await seed("expired_enqueue", "-1 second");
    expect((await owner.query("SELECT state FROM downtown_u_kitchen_order_outbox WHERE redemption_id=$1", [invalid.rid])).rows[0].state).toBe("cancelled");
    const between = await seed("expired_claim");
    await owner.query("UPDATE downtown_u_redemptions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [between.rid]);
    expect((await store.claim(20)).some(claim => claim.redemptionId === between.rid)).toBe(false);
    expect((await owner.query("SELECT state,attempt_count FROM downtown_u_kitchen_order_outbox WHERE redemption_id=$1", [between.rid])).rows[0]).toEqual({ state: "cancelled", attempt_count: 0 });
  });

  it("recovers an ambiguous expired create with the same key and durably handles a no-ID failure", async () => {
    const { rid } = await seed("ambiguous_expiry");
    const first = (await store.claim(1))[0];
    await owner.query("UPDATE downtown_u_redemptions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [rid]);
    await controlled("UPDATE downtown_u_kitchen_order_outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE redemption_id=$1", [rid]);
    const recovered = (await store.claim(1))[0];
    expect(recovered).toMatchObject({ redemptionId: rid, action: "create", idempotencyKey: first.idempotencyKey });
    expect(await store.fail(recovered, "provider_timeout", false, 1)).toBe("cancel_pending");
    expect((await owner.query("SELECT state,lease_token,lease_action,error_code FROM downtown_u_kitchen_order_outbox WHERE redemption_id=$1", [rid])).rows[0]).toEqual({ state: "cancel_pending", lease_token: null, lease_action: null, error_code: "provider_timeout" });
    await controlled("UPDATE downtown_u_kitchen_order_outbox SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE redemption_id=$1", [rid]);
    expect((await store.claim(1))[0]).toMatchObject({ action: "create", idempotencyKey: first.idempotencyKey });
  });

  it("uses the locked fresh clock at finalize and sends an observed post-expiry order to cancellation", async () => {
    const { rid } = await seed("expired_finalize");
    const claim = (await store.claim(1))[0];
    await owner.query("UPDATE downtown_u_redemptions SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [rid]);
    expect(await store.finalize(claim, "ORDER_TOO_LATE", 4)).toBe("cancel_pending");
    expect((await owner.query("SELECT status FROM downtown_u_redemptions WHERE id=$1", [rid])).rows[0].status).toBe("reserved");
    expect((await store.claim(1))[0]).toMatchObject({ action: "cancel", squareOrderId: "ORDER_TOO_LATE" });
  });

  it("turns a legitimate redeemed-to-reversed transition into cancel_pending", async () => {
    const { sid, rid } = await seed("redeemed_reverse");
    const create = (await store.claim(1))[0];
    expect(await store.finalize(create, "ORDER_REVERSED", 2)).toBe("created");
    await reverse(sid, rid);
    expect((await owner.query("SELECT state,square_order_id FROM downtown_u_kitchen_order_outbox WHERE redemption_id=$1", [rid])).rows[0]).toEqual({ state: "cancel_pending", square_order_id: "ORDER_REVERSED" });
    expect((await store.claim(1))[0]).toMatchObject({ action: "cancel", squareOrderId: "ORDER_REVERSED" });
  });

  it("quarantines exhausted cancel_pending recovery rather than silently retaining a lease", async () => {
    const { rid } = await seed("cancel_exhaustion");
    const claim = (await store.claim(1))[0];
    await owner.query("UPDATE downtown_u_redemptions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [rid]);
    await controlled("UPDATE downtown_u_kitchen_order_outbox SET state='cancel_pending',attempt_count=11,lease_token=NULL,lease_expires_at=NULL,lease_action=NULL,next_attempt_at=clock_timestamp()-interval '1 second' WHERE redemption_id=$1", [rid]);
    const last = (await store.claim(1))[0];
    expect(last).toMatchObject({ action: "create", idempotencyKey: claim.idempotencyKey });
    expect(await store.fail(last, "provider_timeout", false, 1)).toBe("operator_review");
    expect((await owner.query("SELECT state,attempt_count,lease_token,error_code FROM downtown_u_kitchen_order_outbox WHERE redemption_id=$1", [rid])).rows[0]).toEqual({ state: "operator_review", attempt_count: 12, lease_token: null, error_code: "provider_timeout" });
  });

  it("rejects a failure whose lease expires while SELECT FOR UPDATE waits", async () => {
    const { rid } = await seed("fail_lock_expiry");
    const claim = (await store.claim(1))[0];
    const blocker = await owner.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT set_config('downtown_u.kitchen_write',pg_backend_pid()::text||':'||pg_current_xact_id()::text,true)");
      await blocker.query("UPDATE downtown_u_kitchen_order_outbox SET lease_expires_at=clock_timestamp()+interval '500 milliseconds' WHERE redemption_id=$1", [rid]);
      const failure = store.fail(claim, "provider_timeout", false, 1);
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await owner.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%downtown_u_kitchen_fail%'");
        if (result.rowCount) { waiting = true; break; }
        await new Promise(resolveWait => setTimeout(resolveWait, 10));
      }
      expect(waiting).toBe(true);
      await new Promise(resolveWait => setTimeout(resolveWait, 550));
      await blocker.query("COMMIT");
      await expect(failure).rejects.toThrow(/stale kitchen lease/);
      await controlled("UPDATE downtown_u_kitchen_order_outbox SET state='operator_review',lease_token=NULL,lease_expires_at=NULL,lease_action=NULL,error_code='stale_test_lease' WHERE redemption_id=$1", [rid]);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("keeps known provider versions immutable and enforces atomic lease metadata", async () => {
    const { rid } = await seed("controlled_invariants");
    await controlled("UPDATE downtown_u_kitchen_order_outbox SET square_order_id='ORDER_INVARIANT',square_order_version=3 WHERE redemption_id=$1", [rid]);
    await controlled("UPDATE downtown_u_kitchen_order_outbox SET square_order_version=4 WHERE redemption_id=$1", [rid]);
    await expect(controlled("UPDATE downtown_u_kitchen_order_outbox SET square_order_version=NULL WHERE redemption_id=$1", [rid])).rejects.toThrow(/identity is immutable/);
    await expect(controlled("UPDATE downtown_u_kitchen_order_outbox SET square_order_version=3 WHERE redemption_id=$1", [rid])).rejects.toThrow(/identity is immutable/);
    await expect(controlled("UPDATE downtown_u_kitchen_order_outbox SET state='cancel_pending',lease_action='create' WHERE redemption_id=$1", [rid])).rejects.toMatchObject({ code: "23514" });
    await expect(controlled("UPDATE downtown_u_kitchen_order_outbox SET state='cancel_pending',lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '1 minute',lease_action=NULL WHERE redemption_id=$1", [rid])).rejects.toMatchObject({ code: "23514" });
    expect((await owner.query("SELECT square_order_version,lease_token,lease_expires_at,lease_action FROM downtown_u_kitchen_order_outbox WHERE redemption_id=$1", [rid])).rows[0]).toEqual({ square_order_version: "4", lease_token: null, lease_expires_at: null, lease_action: null });
    await controlled("UPDATE downtown_u_kitchen_order_outbox SET state='operator_review',error_code='invariant_test_done' WHERE redemption_id=$1", [rid]);
  });

  it("bounds concurrent expiry, cancellation, claim, and finalize without deadlock", async () => {
    const items: Array<{ sid: string; rid: string; claim: KitchenClaim }> = [];
    for (let index = 0; index < 4; index++) {
      const seeded = await seed(`deadlock_${index}`);
      items.push({ ...seeded, claim: (await store.claim(1))[0] });
      await owner.query("UPDATE downtown_u_redemptions SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [seeded.rid]);
    }
    const expiryClient = await owner.connect();
    const claimClient = await jobs.connect();
    try {
      await expiryClient.query("SET statement_timeout='5s'");
      await claimClient.query("SET statement_timeout='5s'");
      await Promise.all([
        expiryClient.query("SELECT downtown_u_reverse_expired_reservations(100)"),
        ...items.map((item, index) => store.finalize(item.claim, `ORDER_DEADLOCK_${index}`, 1)),
        (async () => { await assertDowntownUKitchenJobIdentity(claimClient as never); await claimClient.query("SELECT * FROM downtown_u_kitchen_claim(20)"); })(),
      ]);
    } finally {
      expiryClient.release();
      claimClient.release();
    }
    const rows = (await owner.query("SELECT state FROM downtown_u_kitchen_order_outbox WHERE redemption_id=ANY($1::uuid[])", [items.map(item => item.rid)])).rows;
    expect(rows).toHaveLength(4);
    expect(rows.every(row => row.state === "cancel_pending" || row.state === "cancelled")).toBe(true);
  }, 15_000);

  it("fails closed while disabled and denies direct or unrelated capabilities", async () => {
    await owner.query("UPDATE downtown_u_kitchen_config SET enabled=false");
    expect(await store.claim(1)).toEqual([]);
    await owner.query("UPDATE downtown_u_kitchen_config SET enabled=true");
    for (const sql of ["SELECT * FROM downtown_u_kitchen_order_outbox", "UPDATE downtown_u_kitchen_config SET enabled=false", "SELECT * FROM downtown_u_students", "SELECT downtown_u_reverse_expired_reservations(1)", "TRUNCATE downtown_u_kitchen_order_outbox"]) {
      await expect(jobs.query(sql)).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("pins disable, drop, and function-redirection drift for both host-table trigger attachments", async () => {
    const attachments = [
      { table: "downtown_u_reservation_snapshots", name: "downtown_u_kitchen_enqueue", create: "CREATE TRIGGER downtown_u_kitchen_enqueue AFTER INSERT ON downtown_u_reservation_snapshots FOR EACH ROW EXECUTE FUNCTION downtown_u_kitchen_enqueue()" },
      { table: "downtown_u_redemptions", name: "downtown_u_kitchen_redemption_cancel", create: "CREATE TRIGGER downtown_u_kitchen_redemption_cancel AFTER UPDATE OF status ON downtown_u_redemptions FOR EACH ROW EXECUTE FUNCTION downtown_u_kitchen_redemption_cancelled()" },
    ];
    for (const attachment of attachments) {
      await owner.query(`ALTER TABLE ${attachment.table} DISABLE TRIGGER ${attachment.name}`);
      await expect(assertDowntownUKitchenJobIdentity(jobs as never)).rejects.toThrow(/Unsafe/);
      await owner.query(`ALTER TABLE ${attachment.table} ENABLE TRIGGER ${attachment.name}`);
      await owner.query(`DROP TRIGGER ${attachment.name} ON ${attachment.table}`);
      await expect(assertDowntownUKitchenJobIdentity(jobs as never)).rejects.toThrow(/Unsafe/);
      await owner.query(attachment.create);
      await owner.query(`CREATE OR REPLACE TRIGGER ${attachment.name} ${attachment.table === "downtown_u_redemptions" ? "AFTER UPDATE OF status" : "AFTER INSERT"} ON ${attachment.table} FOR EACH ROW EXECUTE FUNCTION downtown_u_reject_reservation_snapshot_mutation()`);
      await expect(assertDowntownUKitchenJobIdentity(jobs as never)).rejects.toThrow(/Unsafe/);
      await owner.query(`DROP TRIGGER ${attachment.name} ON ${attachment.table}`);
      await owner.query(attachment.create);
      await expect(assertDowntownUKitchenJobIdentity(jobs as never)).resolves.toBeUndefined();
    }
  });

  it("rejects extra kitchen trigger attachments on any host schema or relation", async () => {
    await owner.query("CREATE SCHEMA kitchen_attacker");
    await owner.query("CREATE TABLE kitchen_attacker.compatible_host(id uuid,redemption_id uuid,status text)");
    try {
      await owner.query("CREATE TRIGGER unrelated_enqueue AFTER INSERT ON kitchen_attacker.compatible_host FOR EACH ROW EXECUTE FUNCTION public.downtown_u_kitchen_enqueue()");
      await expect(assertDowntownUKitchenJobIdentity(jobs as never)).rejects.toThrow(/Unsafe/);
      await owner.query("DROP TRIGGER unrelated_enqueue ON kitchen_attacker.compatible_host");
      await expect(assertDowntownUKitchenJobIdentity(jobs as never)).resolves.toBeUndefined();

      await owner.query("CREATE TRIGGER unrelated_cancel AFTER UPDATE OF status ON kitchen_attacker.compatible_host FOR EACH ROW EXECUTE FUNCTION public.downtown_u_kitchen_redemption_cancelled()");
      await expect(assertDowntownUKitchenJobIdentity(jobs as never)).rejects.toThrow(/Unsafe/);
      await owner.query("DROP TRIGGER unrelated_cancel ON kitchen_attacker.compatible_host");
      await expect(assertDowntownUKitchenJobIdentity(jobs as never)).resolves.toBeUndefined();

      await owner.query("CREATE TRIGGER downtown_u_kitchen_disguised BEFORE UPDATE ON kitchen_attacker.compatible_host FOR EACH ROW EXECUTE FUNCTION public.downtown_u_reject_reservation_snapshot_mutation()");
      await expect(assertDowntownUKitchenJobIdentity(jobs as never)).rejects.toThrow(/Unsafe/);
      await owner.query("DROP TRIGGER downtown_u_kitchen_disguised ON kitchen_attacker.compatible_host");
      await expect(assertDowntownUKitchenJobIdentity(jobs as never)).resolves.toBeUndefined();
    } finally {
      await owner.query("DROP SCHEMA kitchen_attacker CASCADE");
    }
  });

  it("detects kitchen relation, function, and ACL drift", async () => {
    await owner.query("ALTER FUNCTION downtown_u_kitchen_claim(integer) SECURITY INVOKER");
    await expect(assertDowntownUKitchenJobIdentity(jobs as never)).rejects.toThrow(/Unsafe/);
    await owner.query("ALTER FUNCTION downtown_u_kitchen_claim(integer) SECURITY DEFINER");
    await owner.query("ALTER TABLE downtown_u_kitchen_order_outbox DISABLE TRIGGER downtown_u_kitchen_outbox_guard");
    await expect(assertDowntownUKitchenJobIdentity(jobs as never)).rejects.toThrow(/Unsafe/);
    await owner.query("ALTER TABLE downtown_u_kitchen_order_outbox ENABLE TRIGGER downtown_u_kitchen_outbox_guard");
    await owner.query(`GRANT SELECT ON downtown_u_kitchen_order_outbox TO ${qi(login)}`);
    await expect(assertDowntownUKitchenJobIdentity(jobs as never)).rejects.toThrow(/Unsafe/);
    await owner.query(`REVOKE SELECT ON downtown_u_kitchen_order_outbox FROM ${qi(login)}`);
    await expect(assertDowntownUKitchenJobIdentity(jobs as never)).resolves.toBeUndefined();
  });
});
