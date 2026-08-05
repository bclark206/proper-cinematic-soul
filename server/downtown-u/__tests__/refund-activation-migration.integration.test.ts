import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const baseUrl = process.env.TEST_DATABASE_URL;
const run = baseUrl ? describe : describe.skip;
const suffix = `${process.pid}_${Date.now()}`;
const prefix = `downtown_u_a3c_backfill_${suffix}`;
const migrations = [
  "202608040001_downtown_u_phase1.sql",
  "202608040002_downtown_u_webhook_events.sql",
  "202608040003_downtown_u_payment_activation.sql",
  "202608040004_downtown_u_refund_activation.sql",
].map((name) => readFileSync(resolve(process.cwd(), "db/migrations", name), "utf8"));
let admin: Pool;
const databases = new Set<string>();
function qi(value: string) { return `"${value.replaceAll('"', '""')}"`; }

async function withDatabase<T>(name: string, operation: (pool: Pool) => Promise<T>): Promise<T> {
  const databaseName = `${prefix}_${name}`;
  databases.add(databaseName);
  await admin.query(`CREATE DATABASE ${qi(databaseName)}`);
  const url = new URL(baseUrl!);
  url.pathname = `/${databaseName}`;
  const pool = new Pool({ connectionString: url.toString(), max: 4 });
  try {
    for (const migration of migrations.slice(0, 3)) await pool.query(migration);
    return await operation(pool);
  } finally {
    await pool.end();
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
      [databaseName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${qi(databaseName)}`);
    databases.delete(databaseName);
  }
}

async function addStudent(pool: Pool, email: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    "INSERT INTO downtown_u_students(normalized_email) VALUES ($1) RETURNING id", [email],
  )).rows[0].id;
}

async function addGrant(
  pool: Pool,
  studentId: string,
  key: string,
  ledgerId: string,
  createdAt: string,
): Promise<void> {
  const purchase = (await pool.query<{ id: string }>(`INSERT INTO downtown_u_plan_purchases
    (student_id,plan_id,credits_granted,price_cents,square_payment_id,square_order_id,
     source_event_id,paid_at)
    VALUES ($1,'flex-5',5,6000,$2,$3,$4,now()) RETURNING id`,
  [studentId, `PAY_${key}`, `ORDER_${key}`, `EVENT_${key}`])).rows[0];
  await pool.query(`INSERT INTO downtown_u_credit_transactions
    (id,student_id,purchase_id,delta,resulting_balance,transaction_type,reason,idempotency_key,
     actor_type,actor_id,source_type,source_id,created_at)
    VALUES ($1,$2,$3,5,(SELECT credit_balance+5 FROM downtown_u_students WHERE id=$2),
      'purchase_grant','historical grant',$4,'system','migration-test','fixture',$5,$6)`,
  [ledgerId, studentId, purchase.id, `grant-${key}`, `grant-source-${key}`, createdAt]);
}

async function addReservation(
  pool: Pool,
  studentId: string,
  key: string,
  credits: number,
  ledgerId: string,
  createdAt: string,
): Promise<void> {
  const redemption = (await pool.query<{ id: string }>(`INSERT INTO downtown_u_redemptions
    (student_id,credits,idempotency_key) VALUES ($1,$2,$3) RETURNING id`,
  [studentId, credits, `redemption-${key}`])).rows[0];
  await pool.query(`INSERT INTO downtown_u_credit_transactions
    (id,student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,
     actor_type,actor_id,source_type,source_id,created_at)
    VALUES ($1,$2,$3,-($4::INTEGER),(SELECT credit_balance-($4::INTEGER) FROM downtown_u_students WHERE id=$2),
      'reservation','historical reservation',$5,'system','migration-test','fixture',$6,$7)`,
  [ledgerId, studentId, redemption.id, credits, `reservation-ledger-${key}`,
    `reservation-source-${key}`, createdAt]);
}

async function expectAtomicBackfillFailure(pool: Pool, pattern: RegExp): Promise<void> {
  const client = await pool.connect();
  try {
    await expect(client.query(migrations[3])).rejects.toThrow(pattern);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  expect((await pool.query(`SELECT count(*)::int n FROM pg_attribute
    WHERE attrelid='public.downtown_u_credit_transactions'::regclass
      AND attname='ledger_sequence' AND NOT attisdropped`)).rows[0].n).toBe(0);
  expect((await pool.query(`SELECT tgenabled FROM pg_trigger
    WHERE tgrelid='public.downtown_u_credit_transactions'::regclass
      AND tgname='downtown_u_credit_transactions_immutable'`)).rows[0].tgenabled).toBe("O");
  expect((await pool.query(`SELECT to_regclass('public.downtown_u_refund_applications') AS relation`))
    .rows[0].relation).toBeNull();
}

async function dropPurchaseChecks(pool: Pool): Promise<void> {
  await pool.query(`DO $do$ DECLARE c record; BEGIN
    FOR c IN SELECT conname FROM pg_constraint
      WHERE conrelid='public.downtown_u_plan_purchases'::regclass AND contype='c'
    LOOP EXECUTE format('ALTER TABLE public.downtown_u_plan_purchases DROP CONSTRAINT %I',c.conname); END LOOP;
  END $do$`);
}

async function a3cTopology(pool: Pool): Promise<unknown[]> {
  return (await pool.query(`
    SELECT kind,name,definition FROM (
      SELECT 'column' AS kind, a.attrelid::regclass::text || '.' || a.attname AS name,
        pg_catalog.format_type(a.atttypid,a.atttypmod) AS definition
      FROM pg_catalog.pg_attribute AS a
      WHERE a.attrelid IN (
        'public.downtown_u_credit_transactions'::regclass,
        'public.downtown_u_plan_purchases'::regclass
      ) AND a.attnum>0 AND NOT a.attisdropped
      UNION ALL
      SELECT 'trigger', c.relname || '.' || t.tgname, pg_catalog.pg_get_triggerdef(t.oid)
      FROM pg_catalog.pg_trigger AS t
      JOIN pg_catalog.pg_class AS c ON c.oid=t.tgrelid
      WHERE c.relname IN ('downtown_u_credit_transactions','downtown_u_plan_purchases')
        AND NOT t.tgisinternal
      UNION ALL
      SELECT 'function', p.oid::regprocedure::text, pg_catalog.pg_get_functiondef(p.oid)
      FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_namespace AS n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN (
        'downtown_u_apply_credit_transaction',
        'downtown_u_require_trusted_purchase_grant'
      )
    ) AS topology ORDER BY kind,name
  `)).rows;
}

async function waitForBlockedTableLock(pool: Pool, pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = (await pool.query<{ waiting: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_locks AS l
        JOIN pg_catalog.pg_class AS c ON c.oid=l.relation
        JOIN pg_catalog.pg_stat_activity AS a ON a.pid=l.pid
        WHERE l.pid=$1 AND NOT l.granted AND l.locktype='relation'
          AND l.mode='ShareRowExclusiveLock'
          AND c.oid='public.downtown_u_credit_transactions'::regclass
          AND a.wait_event_type='Lock'
      ) AS waiting
    `, [pid])).rows[0];
    if (state.waiting) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`migration backend ${pid} did not wait for its A3c table lock`);
}

run.sequential("A3c historical ledger backfill on PostgreSQL 16", () => {
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
  });

  afterAll(async () => {
    if (admin) {
      for (const database of databases) {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
          [database],
        );
        await admin.query(`DROP DATABASE IF EXISTS ${qi(database)}`);
      }
      await admin.end();
    }
  }, 30_000);

  it("reconstructs per-student balance transitions despite conflicting timestamp and UUID order", async () => {
    await withDatabase("success", async (pool) => {
      const first = await addStudent(pool, "backfill-first@example.com");
      await addGrant(pool, first, "FIRST", "ffffffff-ffff-4fff-8fff-ffffffffffff", "2099-01-01T00:00:00Z");
      await addReservation(pool, first, "FIRST", 2, "00000000-0000-4000-8000-000000000001", "2000-01-01T00:00:00Z");

      const second = await addStudent(pool, "backfill-second@example.com");
      await addGrant(pool, second, "SECOND", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "2026-08-04T12:00:00Z");
      await addReservation(pool, second, "SECOND", 1, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "2026-08-04T12:00:00Z");
      await addStudent(pool, "backfill-empty@example.com");

      await expect(pool.query(migrations[3])).resolves.toBeTruthy();
      const rows = (await pool.query(`SELECT student_id,id,ledger_sequence FROM downtown_u_credit_transactions
        ORDER BY student_id,ledger_sequence`)).rows;
      expect(rows.filter((row) => row.student_id === first)).toEqual([
        { student_id: first, id: "ffffffff-ffff-4fff-8fff-ffffffffffff", ledger_sequence: "1" },
        { student_id: first, id: "00000000-0000-4000-8000-000000000001", ledger_sequence: "2" },
      ]);
      expect(rows.filter((row) => row.student_id === second)).toEqual([
        { student_id: second, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ledger_sequence: "1" },
        { student_id: second, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ledger_sequence: "2" },
      ]);
    });
  }, 30_000);

  it("waits for concurrent legacy refund DML, then rejects its committed state atomically", async () => {
    await withDatabase("concurrent_legacy_refund", async (pool) => {
      const student = await addStudent(pool, "concurrent-legacy-refund@example.com");
      await addGrant(pool, student, "CONCURRENT", "55555555-5555-4555-8555-555555555555", "2026-08-04T12:00:00Z");
      const before = await a3cTopology(pool);
      const writer = await pool.connect();
      const migrator = await pool.connect();
      let migrationSettled = false;
      try {
        await writer.query("BEGIN");
        await writer.query(`INSERT INTO downtown_u_credit_transactions
          (student_id,purchase_id,delta,resulting_balance,transaction_type,reason,idempotency_key,
           actor_type,actor_id,source_type,source_id)
          VALUES ($1,(SELECT id FROM downtown_u_plan_purchases WHERE student_id=$1),-1,4,
            'purchase_refund','concurrent legacy fixture','concurrent-legacy-refund-key',
            'system','fixture','fixture','concurrent-legacy-refund')`, [student]);

        const migrationPid = (await migrator.query<{ pid: number }>(
          "SELECT pg_catalog.pg_backend_pid() AS pid",
        )).rows[0].pid;
        const migrationResult = migrator.query(migrations[3]).then(
          () => ({ error: null }),
          (error: unknown) => ({ error }),
        ).finally(() => { migrationSettled = true; });

        await waitForBlockedTableLock(pool, migrationPid);
        expect(migrationSettled).toBe(false);
        await writer.query("COMMIT");
        const { error } = await migrationResult;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/pre-A3c refund state|not canonical/i);
        await migrator.query("ROLLBACK");

        expect(await a3cTopology(pool)).toEqual(before);
        expect((await pool.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_attribute
          WHERE attrelid='public.downtown_u_credit_transactions'::regclass
            AND attname='ledger_sequence' AND NOT attisdropped`)).rows[0].n).toBe(0);
        expect((await pool.query(`SELECT to_regclass('public.downtown_u_refund_applications') AS applications,
          to_regclass('public.downtown_u_refund_reconciliations') AS reconciliations`)).rows[0])
          .toEqual({ applications: null, reconciliations: null });
        expect((await pool.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_proc AS p
          JOIN pg_catalog.pg_namespace AS n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname IN (
            'downtown_u_activate_verified_refund','downtown_u_reject_refund_record_mutation'
          )`)).rows[0].n).toBe(0);
        expect((await pool.query(`SELECT tgenabled FROM pg_catalog.pg_trigger
          WHERE tgrelid='public.downtown_u_credit_transactions'::regclass
            AND tgname='downtown_u_credit_transactions_immutable'`)).rows[0].tgenabled).toBe("O");
      } finally {
        if (!migrationSettled) await writer.query("ROLLBACK").catch(() => undefined);
        writer.release();
        migrator.release();
      }
    });
  }, 30_000);

  it("aborts atomically when one prior balance has multiple possible next rows", async () => {
    await withDatabase("ambiguous", async (pool) => {
      const student = await addStudent(pool, "backfill-ambiguous@example.com");
      await addGrant(pool, student, "AMBIGUOUS_A", "11111111-1111-4111-8111-111111111111", "2026-08-04T12:00:00Z");
      await addGrant(pool, student, "AMBIGUOUS_B", "22222222-2222-4222-8222-222222222222", "2026-08-04T12:00:00Z");
      await pool.query("ALTER TABLE downtown_u_credit_transactions DISABLE TRIGGER downtown_u_credit_transactions_immutable");
      await pool.query("UPDATE downtown_u_credit_transactions SET resulting_balance=5 WHERE id='22222222-2222-4222-8222-222222222222'");
      await pool.query("ALTER TABLE downtown_u_credit_transactions ENABLE TRIGGER downtown_u_credit_transactions_immutable");
      await expectAtomicBackfillFailure(pool, /ambiguous|inconsistent/i);
    });
  }, 30_000);

  it("aborts atomically when the reconstructed final balance differs from the student cache", async () => {
    await withDatabase("final_mismatch", async (pool) => {
      const student = await addStudent(pool, "backfill-mismatch@example.com");
      await addGrant(pool, student, "MISMATCH", "33333333-3333-4333-8333-333333333333", "2026-08-04T12:00:00Z");
      await pool.query("ALTER TABLE downtown_u_students DISABLE TRIGGER downtown_u_students_ledger_balance_only");
      await pool.query("UPDATE downtown_u_students SET credit_balance=4 WHERE id=$1", [student]);
      await pool.query("ALTER TABLE downtown_u_students ENABLE TRIGGER downtown_u_students_ledger_balance_only");
      await expectAtomicBackfillFailure(pool, /final balance|inconsistent/i);
    });
  }, 30_000);

  it.each([
    ["legacy_ledger", "ledger"],
    ["legacy_refunded_credits", "credits"],
    ["legacy_status", "status"],
    ["legacy_refunded_at", "time"],
  ])("aborts atomically for %s before introducing any A3c structure", async (name, corruption) => {
    await withDatabase(name, async (pool) => {
      const student = await addStudent(pool, `${name}@example.com`);
      await addGrant(pool, student, name, "44444444-4444-4444-8444-444444444444", "2026-08-04T12:00:00Z");
      if (corruption === "ledger") {
        await pool.query(`INSERT INTO downtown_u_credit_transactions
          (student_id,purchase_id,delta,resulting_balance,transaction_type,reason,idempotency_key,
           actor_type,actor_id,source_type,source_id)
          VALUES ($1,(SELECT id FROM downtown_u_plan_purchases WHERE student_id=$1),-1,4,
            'purchase_refund','legacy fixture','legacy-refund-key','system','fixture','fixture','legacy-refund')`,
        [student]);
      } else {
        await dropPurchaseChecks(pool);
        await pool.query("ALTER TABLE downtown_u_plan_purchases DISABLE TRIGGER downtown_u_plan_purchases_protect_fields");
        const assignment = corruption === "credits" ? "refunded_credits=1"
          : corruption === "status" ? "status='partially_refunded'"
            : "refunded_at='2026-08-05T12:00:00Z'::timestamptz";
        await pool.query(`UPDATE downtown_u_plan_purchases SET ${assignment}`);
        await pool.query("ALTER TABLE downtown_u_plan_purchases ENABLE TRIGGER downtown_u_plan_purchases_protect_fields");
      }
      await expectAtomicBackfillFailure(pool, /pre-A3c refund state|not canonical/i);
    });
  }, 30_000);
});
