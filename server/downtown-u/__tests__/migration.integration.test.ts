import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DowntownUCredits, IdempotencyConflictError } from "../credits";
import { PostgresCreditStore } from "../postgres-credit-store";
import { PostgresStudentAccountStore } from "../postgres-student-account-store";

const migration = readFileSync(resolve(process.cwd(), "db/migrations/202608040001_downtown_u_phase1.sql"), "utf8");
const baseUrl = process.env.TEST_DATABASE_URL;
const run = baseUrl ? describe : describe.skip;
const databaseName = `downtown_u_test_${process.pid}_${Date.now()}`;
let admin: Pool;
let pool: Pool;
let testDatabaseUrl: string;

function quotedIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}
async function student(email: string): Promise<string> {
  const result = await pool.query<{ id: string }>("INSERT INTO downtown_u_students (normalized_email) VALUES ($1) RETURNING id", [email]);
  return result.rows[0].id;
}
async function purchase(studentId: string, suffix: string): Promise<string> {
  const result = await pool.query<{ id: string }>(`INSERT INTO downtown_u_plan_purchases
    (student_id, plan_id, credits_granted, price_cents, square_payment_id, square_order_id, source_event_id, paid_at)
    VALUES ($1,'flex-5',5,6000,$2,$3,$4,now()) RETURNING id`,
  [studentId, `payment-${suffix}`, `order-${suffix}`, `event-${suffix}`]);
  return result.rows[0].id;
}
async function grant(studentId: string, purchaseId: string, suffix: string, credits = 5): Promise<void> {
  await pool.query(`INSERT INTO downtown_u_credit_transactions
    (student_id,purchase_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
    VALUES ($1,$2,$3,$3,'purchase_grant','verified','grant-' || $4,'system','test','test_grant',$4)`,
  [studentId, purchaseId, credits, suffix]);
}

run.sequential("Downtown U migration on real PostgreSQL", () => {
  beforeAll(async () => {
    const parsed = new URL(baseUrl!);
    const baseDatabase = parsed.pathname.slice(1);
    const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
    if (!local && !/(^|[_-])(test|testing|disposable)([_-]|$)/i.test(baseDatabase)) {
      throw new Error("Refusing integration tests: TEST_DATABASE_URL must be local or explicitly test-named");
    }
    admin = new Pool({ connectionString: baseUrl, max: 2 });
    await admin.query(`CREATE DATABASE ${quotedIdentifier(databaseName)}`);
    parsed.pathname = `/${databaseName}`;
    testDatabaseUrl = parsed.toString();
    pool = new Pool({ connectionString: testDatabaseUrl, max: 8 });
    await pool.query(migration);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid()", [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(databaseName)}`);
      await admin.end();
    }
  }, 30_000);

  it("rejects canonical-plan and purchase-economics tampering", async () => {
    await expect(pool.query("UPDATE downtown_u_plans SET credits=6 WHERE id='flex-5'"))
      .rejects.toThrow(/canonical plan economics are immutable/i);
    const id = await student("canonical@example.edu");
    await expect(pool.query(`INSERT INTO downtown_u_plan_purchases
      (student_id,plan_id,credits_granted,price_cents,square_payment_id,square_order_id,source_event_id,paid_at)
      VALUES ($1,'flex-5',6,6000,'bad-payment','bad-order','bad-event',now())`, [id]))
      .rejects.toSatisfy((error: unknown) => errorCode(error) === "23503");
  });

  it("rejects duplicate payment, order, event, idempotency, and source identifiers", async () => {
    const id = await student("duplicates@example.edu");
    const purchaseId = await purchase(id, "duplicate");
    for (const [paymentId, orderId, eventId] of [
      ["payment-duplicate", "order-new-1", "event-new-1"],
      ["payment-new-2", "order-duplicate", "event-new-2"],
      ["payment-new-3", "order-new-3", "event-duplicate"],
    ]) {
      await expect(pool.query(`INSERT INTO downtown_u_plan_purchases
        (student_id,plan_id,credits_granted,price_cents,square_payment_id,square_order_id,source_event_id,paid_at)
        VALUES ($1,'flex-5',5,6000,$2,$3,$4,now())`, [id, paymentId, orderId, eventId]))
        .rejects.toSatisfy((error: unknown) => errorCode(error) === "23505");
    }
    await grant(id, purchaseId, "duplicate-source");
    await expect(pool.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,purchase_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,-1,4,'purchase_refund','verified','grant-duplicate-source','system','test','another','another')`, [id, purchaseId]))
      .rejects.toSatisfy((error: unknown) => errorCode(error) === "23505");
    await expect(pool.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,purchase_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,-1,4,'purchase_refund','verified','another-key','system','test','test_grant','duplicate-source')`, [id, purchaseId]))
      .rejects.toSatisfy((error: unknown) => errorCode(error) === "23505");
    await pool.query("INSERT INTO downtown_u_redemptions (student_id,credits,idempotency_key) VALUES ($1,1,'redemption-key')", [id]);
    await expect(pool.query("INSERT INTO downtown_u_redemptions (student_id,credits,idempotency_key) VALUES ($1,1,'redemption-key')", [id]))
      .rejects.toSatisfy((error: unknown) => errorCode(error) === "23505");
  });

  it("rejects broken or negative balance chains and direct cached-balance mutation", async () => {
    const id = await student("balances@example.edu");
    const purchaseId = await purchase(id, "balances");
    await expect(pool.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,purchase_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,5,4,'purchase_grant','broken','broken-chain','system','test','test','broken-chain')`, [id, purchaseId]))
      .rejects.toThrow(/balance chain mismatch/i);
    await expect(pool.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,purchase_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,-1,-1,'purchase_refund','negative','negative-chain','system','test','test','negative-chain')`, [id, purchaseId]))
      .rejects.toThrow(/credit balance cannot be negative/i);
    await expect(pool.query("UPDATE downtown_u_students SET credit_balance=100 WHERE id=$1", [id]))
      .rejects.toThrow(/balance may only change through the credit ledger/i);
    expect((await pool.query("SELECT credit_balance FROM downtown_u_students WHERE id=$1", [id])).rows[0].credit_balance).toBe(0);
  });

  it("makes ledger UPDATE, DELETE, and TRUNCATE impossible", async () => {
    const id = await student("append-only@example.edu");
    const purchaseId = await purchase(id, "append-only");
    await grant(id, purchaseId, "append-only");
    await expect(pool.query("UPDATE downtown_u_credit_transactions SET reason='changed' WHERE idempotency_key='grant-append-only'"))
      .rejects.toThrow(/append-only/i);
    await expect(pool.query("DELETE FROM downtown_u_credit_transactions WHERE idempotency_key='grant-append-only'"))
      .rejects.toThrow(/append-only/i);
    await expect(pool.query("TRUNCATE downtown_u_credit_transactions"))
      .rejects.toThrow(/append-only/i);
  });

  it("rejects cross-student purchase and redemption attribution", async () => {
    const owner = await student("owner@example.edu");
    const other = await student("other@example.edu");
    const purchaseId = await purchase(owner, "ownership");
    await expect(pool.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,purchase_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,5,5,'purchase_grant','cross','cross-purchase','system','test','test','cross-purchase')`, [other, purchaseId]))
      .rejects.toThrow(/purchase not found for student/i);
    const otherPurchaseId = await purchase(other, "ownership-other");
    await grant(other, otherPurchaseId, "ownership-other");
    const redemption = await pool.query<{ id: string }>("INSERT INTO downtown_u_redemptions (student_id,credits,idempotency_key) VALUES ($1,1,'owned-redemption') RETURNING id", [owner]);
    await expect(pool.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,-1,4,'reservation','cross','cross-redemption','student','test','test','cross-redemption')`, [other, redemption.rows[0].id]))
      .rejects.toThrow(/redemption not found for student/i);
  });

  it("serializes concurrent last-credit debits so only one succeeds", async () => {
    const id = await student("concurrent@example.edu");
    const purchaseId = await purchase(id, "concurrent");
    await grant(id, purchaseId, "concurrent");
    const warmup = (await pool.query<{ id: string }>("INSERT INTO downtown_u_redemptions (student_id,credits,idempotency_key) VALUES ($1,4,'concurrent-warmup') RETURNING id", [id])).rows[0].id;
    await pool.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,-4,1,'reservation','warmup','concurrent-warmup-debit','student','test','test','concurrent-warmup-debit')`, [id, warmup]);
    const redemptions = await Promise.all(["a", "b"].map(async (suffix) =>
      (await pool.query<{ id: string }>("INSERT INTO downtown_u_redemptions (student_id,credits,idempotency_key) VALUES ($1,1,$2) RETURNING id", [id, `concurrent-${suffix}`])).rows[0].id));
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      await first.query(`INSERT INTO downtown_u_credit_transactions
        (student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
        VALUES ($1,$2,-1,0,'reservation','concurrent','concurrent-debit-a','student','test','test','concurrent-debit-a')`, [id, redemptions[0]]);
      const secondAttempt = second.query(`INSERT INTO downtown_u_credit_transactions
        (student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
        VALUES ($1,$2,-1,0,'reservation','concurrent','concurrent-debit-b','student','test','test','concurrent-debit-b')`, [id, redemptions[1]]);
      await first.query("COMMIT");
      await expect(secondAttempt).rejects.toThrow(/balance chain mismatch/i);
      await second.query("ROLLBACK");
    } finally {
      first.release();
      second.release();
    }
    expect((await pool.query("SELECT credit_balance FROM downtown_u_students WHERE id=$1", [id])).rows[0].credit_balance).toBe(0);
  });

  it("enforces actor and metadata idempotency signatures in PostgresCreditStore", async () => {
    const id = await student("store-signatures@example.edu");
    const credits = new DowntownUCredits(new PostgresCreditStore(pool));
    const purchaseInput = { studentId: id, planId: "flex-5", squarePaymentId: "store-payment", squareOrderId: "store-order", sourceEventId: "store-event", actorId: "webhook-a", metadata: { attempt: 1 } } as const;
    const bought = await credits.grantPaidPurchase(purchaseInput);
    await expect(credits.grantPaidPurchase({ ...purchaseInput, actorId: "webhook-b" })).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(credits.grantPaidPurchase({ ...purchaseInput, metadata: { attempt: 2 } })).rejects.toBeInstanceOf(IdempotencyConflictError);
    const reservationInput = { studentId: id, credits: 1, idempotencyKey: "store-reserve", actorId: id, metadata: { cart: "a" } } as const;
    const reserved = await credits.reserve(reservationInput);
    await expect(credits.reserve({ ...reservationInput, actorId: "other" })).rejects.toBeInstanceOf(IdempotencyConflictError);
    const reversalInput = { redemptionId: reserved.id, idempotencyKey: "store-reversal", reason: "failed", actorId: "orders", metadata: { attempt: 1 } } as const;
    await credits.reverseRedemption(reversalInput);
    await expect(credits.reverseRedemption({ ...reversalInput, metadata: { attempt: 2 } })).rejects.toBeInstanceOf(IdempotencyConflictError);
    const refundInput = { purchaseId: bought.id, creditsToReverse: 1, idempotencyKey: "store-refund", actorId: "webhook-a", metadata: { refund: "a" } } as const;
    await credits.refundPurchase(refundInput);
    await expect(credits.refundPurchase({ ...refundInput, metadata: { refund: "b" } })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("persists and reads back canonical metadata identically across key order", async () => {
    const id = await student("canonical-metadata@example.edu");
    const credits = new DowntownUCredits(new PostgresCreditStore(pool));
    const input = {
      studentId: id,
      planId: "flex-5",
      squarePaymentId: "canonical-metadata-payment",
      squareOrderId: "canonical-metadata-order",
      sourceEventId: "canonical-metadata-event",
      actorId: "canonical-metadata-webhook",
      metadata: { z: 1, nested: { y: true, a: "value" }, a: [null, 2, "three"] },
    } as const;

    const purchaseRecord = await credits.grantPaidPurchase(input);
    await expect(credits.grantPaidPurchase({
      ...input,
      metadata: { a: [null, 2, "three"], nested: { a: "value", y: true }, z: 1 },
    })).resolves.toEqual(purchaseRecord);
    const persisted = await pool.query<{ metadata: unknown }>(
      "SELECT metadata FROM downtown_u_credit_transactions WHERE purchase_id=$1 AND transaction_type='purchase_grant'",
      [purchaseRecord.id],
    );
    expect(persisted.rows[0].metadata).toEqual({ a: [null, 2, "three"], nested: { a: "value", y: true }, z: 1 });
  });

  it("preserves special JSON keys and includes __proto__ in Postgres idempotency", async () => {
    const id = await student("proto-metadata@example.edu");
    const credits = new DowntownUCredits(new PostgresCreditStore(pool));
    const input = {
      studentId: id,
      planId: "flex-5",
      squarePaymentId: "proto-metadata-payment",
      squareOrderId: "proto-metadata-order",
      sourceEventId: "proto-metadata-event",
      actorId: "proto-metadata-webhook",
      metadata: JSON.parse('{"__proto__":{"root":"first"},"constructor":"root-constructor","nested":{"__proto__":"nested-value","constructor":"nested-constructor","prototype":"nested-prototype"},"prototype":"root-prototype"}') as Record<string, never>,
    } as const;

    const purchaseRecord = await credits.grantPaidPurchase(input);
    const persisted = (await pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM downtown_u_credit_transactions WHERE purchase_id=$1 AND transaction_type='purchase_grant'",
      [purchaseRecord.id],
    )).rows[0].metadata;
    const nested = persisted.nested as Record<string, unknown>;
    expect(Object.hasOwn(persisted, "__proto__")).toBe(true);
    expect(Object.hasOwn(persisted, "constructor")).toBe(true);
    expect(Object.hasOwn(persisted, "prototype")).toBe(true);
    expect(Object.hasOwn(nested, "__proto__")).toBe(true);
    expect(persisted.__proto__).toEqual({ root: "first" });
    expect(nested.__proto__).toBe("nested-value");
    expect(({} as Record<string, unknown>).root).toBeUndefined();

    await expect(credits.grantPaidPurchase({
      ...input,
      metadata: JSON.parse('{"__proto__":{"root":"changed"},"constructor":"root-constructor","nested":{"__proto__":"nested-value","constructor":"nested-constructor","prototype":"nested-prototype"},"prototype":"root-prototype"}') as Record<string, never>,
    })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("enforces exact ledger economics, uniqueness, and cumulative refund limits", async () => {
    const id = await student("ledger-semantics@example.edu");
    const purchaseId = await purchase(id, "ledger-semantics");
    await expect(grant(id, purchaseId, "wrong-grant", 4)).rejects.toThrow(/purchase grant must equal/i);
    await grant(id, purchaseId, "right-grant");
    await expect(pool.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,purchase_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,5,10,'purchase_grant','duplicate','duplicate-grant','system','test','test','duplicate-grant')`, [id, purchaseId]))
      .rejects.toSatisfy((error: unknown) => errorCode(error) === "23505");

    const redemption = (await pool.query<{ id: string }>("INSERT INTO downtown_u_redemptions (student_id,credits,idempotency_key) VALUES ($1,2,'semantic-redemption') RETURNING id", [id])).rows[0].id;
    await expect(pool.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,-1,4,'reservation','wrong','wrong-reservation','student','test','test','wrong-reservation')`, [id, redemption]))
      .rejects.toThrow(/reservation debit must equal/i);
    await pool.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,-2,3,'reservation','right','right-reservation','student','test','test','right-reservation')`, [id, redemption]);
    await expect(pool.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,-2,1,'reservation','duplicate','duplicate-reservation','student','test','test','duplicate-reservation')`, [id, redemption]))
      .rejects.toSatisfy((error: unknown) => errorCode(error) === "23505");
    await expect(pool.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,1,4,'redemption_reversal','wrong','wrong-reversal','system','test','test','wrong-reversal')`, [id, redemption]))
      .rejects.toThrow(/redemption reversal must equal/i);
    await pool.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,2,5,'redemption_reversal','right','right-reversal','system','test','test','right-reversal')`, [id, redemption]);
    await expect(pool.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,2,7,'redemption_reversal','duplicate','duplicate-reversal','system','test','test','duplicate-reversal')`, [id, redemption]))
      .rejects.toSatisfy((error: unknown) => errorCode(error) === "23505");

    await pool.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,purchase_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,-3,2,'purchase_refund','partial','partial-refund','system','test','test','partial-refund')`, [id, purchaseId]);
    await expect(pool.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,purchase_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,-3,0,'purchase_refund','too-much','excess-refund','system','test','test','excess-refund')`, [id, purchaseId]))
      .rejects.toThrow(/purchase refund credits exceed/i);
  });

  it("rejects an orphan reversal through the runtime role without minting, but permits reservation then reversal", async () => {
    const client = await pool.connect();
    try {
      await client.query("SET ROLE downtown_u_runtime");
      const id = (await client.query<{ id: string }>(
        "INSERT INTO downtown_u_students(normalized_email) VALUES ('orphan-runtime@example.edu') RETURNING id",
      )).rows[0].id;
      const purchaseId = (await client.query<{ id: string }>(`INSERT INTO downtown_u_plan_purchases
        (student_id,plan_id,credits_granted,price_cents,square_payment_id,square_order_id,source_event_id,paid_at)
        VALUES ($1,'flex-5',5,6000,'orphan-payment','orphan-order','orphan-event',now()) RETURNING id`, [id])).rows[0].id;
      await client.query(`INSERT INTO downtown_u_credit_transactions
        (student_id,purchase_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
        VALUES ($1,$2,5,5,'purchase_grant','verified','orphan-grant','system','test','test','orphan-grant')`, [id, purchaseId]);
      const orphan = (await client.query<{ id: string }>(
        "INSERT INTO downtown_u_redemptions(student_id,credits,idempotency_key) VALUES ($1,2,'orphan-runtime') RETURNING id", [id],
      )).rows[0].id;

      await expect(client.query(`INSERT INTO downtown_u_credit_transactions
        (student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
        VALUES ($1,$2,2,7,'redemption_reversal','forged','orphan-reversal','system','attacker','test','orphan-reversal')`, [id, orphan]))
        .rejects.toThrow(/reversal requires exactly one reservation ledger entry/i);
      expect((await client.query("SELECT credit_balance FROM downtown_u_students WHERE id=$1", [id])).rows[0].credit_balance).toBe(5);
      expect((await client.query("SELECT count(*)::int AS count FROM downtown_u_credit_transactions WHERE redemption_id=$1", [orphan])).rows[0].count).toBe(0);

      const normal = (await client.query<{ id: string }>(
        "INSERT INTO downtown_u_redemptions(student_id,credits,idempotency_key) VALUES ($1,2,'normal-runtime') RETURNING id", [id],
      )).rows[0].id;
      await client.query(`INSERT INTO downtown_u_credit_transactions
        (student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
        VALUES ($1,$2,-2,3,'reservation','reserve','normal-reservation','student','test','test','normal-reservation')`, [id, normal]);
      await client.query(`INSERT INTO downtown_u_credit_transactions
        (student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
        VALUES ($1,$2,2,5,'redemption_reversal','reverse','normal-reversal','system','test','test','normal-reversal')`, [id, normal]);
      expect((await client.query("SELECT credit_balance FROM downtown_u_students WHERE id=$1", [id])).rows[0].credit_balance).toBe(5);
    } finally {
      await client.query("RESET ROLE");
      client.release();
    }
  });

  it("rejects mutation bypasses for purchase and redemption economics and ownership", async () => {
    const id = await student("immutability@example.edu");
    const purchaseId = await purchase(id, "immutability");
    await grant(id, purchaseId, "immutability");
    await expect(pool.query("UPDATE downtown_u_plan_purchases SET credits_granted=6 WHERE id=$1", [purchaseId]))
      .rejects.toThrow(/purchase economics and ownership are immutable/i);
    await expect(pool.query("UPDATE downtown_u_plan_purchases SET refunded_credits=1, status='partially_refunded', refunded_at=now() WHERE id=$1", [purchaseId]))
      .rejects.toThrow(/refund state must equal the immutable ledger/i);
    const redemption = (await pool.query<{ id: string }>("INSERT INTO downtown_u_redemptions (student_id,credits,idempotency_key) VALUES ($1,1,'immutable-redemption') RETURNING id", [id])).rows[0].id;
    await pool.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,-1,4,'reservation','right','immutable-reservation','student','test','test','immutable-reservation')`, [id, redemption]);
    await expect(pool.query("UPDATE downtown_u_redemptions SET credits=2 WHERE id=$1", [redemption]))
      .rejects.toThrow(/redemption economics and ownership are immutable/i);
    const orphan = (await pool.query<{ id: string }>("INSERT INTO downtown_u_redemptions (student_id,credits,idempotency_key) VALUES ($1,1,'orphan-redemption') RETURNING id", [id])).rows[0].id;
    await expect(pool.query("UPDATE downtown_u_redemptions SET status='redeemed', square_order_id='bypass', redeemed_at=now() WHERE id=$1", [orphan]))
      .rejects.toThrow(/state must be backed by the immutable ledger/i);
  });

  it("gives runtime only repository privileges and no trigger-function capability", async () => {
    const client = await pool.connect();
    try {
      await client.query("SET ROLE downtown_u_runtime");
      expect((await client.query("SELECT has_schema_privilege(current_user,'public','CREATE') AS allowed")).rows[0].allowed).toBe(false);
      expect((await client.query("SELECT has_function_privilege(current_user,'public.downtown_u_apply_credit_transaction()','EXECUTE') AS allowed")).rows[0].allowed).toBe(false);
      await expect(client.query("SELECT * FROM downtown_u_balance_update_authorizations")).rejects.toSatisfy((error: unknown) => errorCode(error) === "42501");
      await expect(client.query("CREATE TABLE public.runtime_ddl_forbidden(id int)")).rejects.toSatisfy((error: unknown) => errorCode(error) === "42501");
      await expect(client.query("ALTER TABLE downtown_u_credit_transactions DISABLE TRIGGER ALL")).rejects.toSatisfy((error: unknown) => errorCode(error) === "42501");
      await expect(client.query("UPDATE downtown_u_credit_transactions SET reason='x'")).rejects.toSatisfy((error: unknown) => errorCode(error) === "42501");
      await expect(client.query("DELETE FROM downtown_u_credit_transactions")).rejects.toSatisfy((error: unknown) => errorCode(error) === "42501");
      await expect(client.query("TRUNCATE downtown_u_credit_transactions")).rejects.toSatisfy((error: unknown) => errorCode(error) === "42501");
      await expect(client.query("UPDATE downtown_u_students SET eligibility_status='approved' WHERE false")).rejects.toSatisfy((error: unknown) => errorCode(error) === "42501");
      await client.query("CREATE TEMP TABLE spoof_students (id uuid, credit_balance integer)");
      await expect(client.query("CREATE TRIGGER spoof BEFORE INSERT ON spoof_students FOR EACH ROW EXECUTE FUNCTION public.downtown_u_apply_credit_transaction()"))
        .rejects.toSatisfy((error: unknown) => errorCode(error) === "42501");
    } finally {
      await client.query("RESET ROLE");
      client.release();
    }

    const runtimeUrl = new URL(testDatabaseUrl);
    runtimeUrl.searchParams.set("options", "-c role=downtown_u_runtime");
    const runtimePool = new Pool({ connectionString: runtimeUrl.toString(), max: 2 });
    try {
      for (const [suffix, column, value] of [
        ["positive-balance", "credit_balance", "5"],
        ["zero-balance", "credit_balance", "0"],
        ["eligibility", "eligibility_status", "'approved'"],
      ]) {
        await expect(runtimePool.query(
          `INSERT INTO downtown_u_students(normalized_email,${column}) VALUES ('runtime-${suffix}@example.edu',${value})`,
        )).rejects.toSatisfy((error: unknown) => errorCode(error) === "42501");
        expect((await pool.query("SELECT count(*)::int AS count FROM downtown_u_students WHERE normalized_email=$1", [`runtime-${suffix}@example.edu`])).rows[0].count).toBe(0);
      }
      const account = await (new PostgresStudentAccountStore(runtimePool)).upsert({
        normalizedEmail: "runtime-account@example.edu",
        normalizedPhone: "+15555550123",
        squareCustomerId: "runtime-customer",
      });
      expect(account).toMatchObject({
        normalizedEmail: "runtime-account@example.edu",
        normalizedPhone: "+15555550123",
        squareCustomerId: "runtime-customer",
        eligibilityStatus: "pending",
      });
      expect((await pool.query("SELECT credit_balance FROM downtown_u_students WHERE id=$1", [account.id])).rows[0].credit_balance).toBe(0);
      const runtimeId = (await runtimePool.query<{ id: string }>("INSERT INTO downtown_u_students(normalized_email) VALUES ('runtime@example.edu') RETURNING id")).rows[0].id;
      const forgedId = (await runtimePool.query<{ id: string }>("INSERT INTO downtown_u_students(normalized_email) VALUES ('runtime-forged@example.edu') RETURNING id")).rows[0].id;
      await expect(runtimePool.query(`INSERT INTO downtown_u_credit_transactions
        (student_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
        VALUES ($1,100,100,'manual_adjustment','forged mint','forged-mint','system','runtime','forged','mint')`, [forgedId]))
        .rejects.toSatisfy((error: unknown) => errorCode(error) === "23514");
      expect((await runtimePool.query("SELECT credit_balance FROM downtown_u_students WHERE id=$1", [forgedId])).rows[0].credit_balance).toBe(0);
      const credits = new DowntownUCredits(new PostgresCreditStore(runtimePool));
      const bought = await credits.grantPaidPurchase({ studentId: runtimeId, planId: "flex-5", squarePaymentId: "runtime-payment", squareOrderId: "runtime-order", sourceEventId: "runtime-event", actorId: "runtime-webhook" });
      await credits.reserve({ studentId: runtimeId, credits: 1, idempotencyKey: "runtime-reserve", actorId: runtimeId });
      expect(bought.creditsGranted).toBe(5);
    } finally {
      await runtimePool.end();
    }
  });

  it("creates the supporting semantic lookup indexes", async () => {
    const indexes = (await pool.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='downtown_u_credit_transactions'")).rows.map(({ indexdef }) => indexdef).join("\n");
    expect(indexes).toMatch(/\(purchase_id, transaction_type\)/i);
    expect(indexes).toMatch(/\(redemption_id, transaction_type\)/i);
  });
});
