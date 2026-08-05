import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TrustedEnrollmentCommand, TrustedRefundCommand } from "../enrollment-service";
import { RefundActivationConflictError } from "../payment-activation";
import { PostgresPaymentActivationStore } from "../postgres-payment-activation-store";
import { PostgresRefundActivationStore } from "../postgres-refund-activation-store";
import { assertDowntownURuntimeIdentity } from "../postgres-runtime-identity";
import { PostgresWebhookEventStore } from "../postgres-webhook-event-store";

const baseUrl = process.env.TEST_DATABASE_URL;
const run = baseUrl ? describe : describe.skip;
const suffix = `${process.pid}_${Date.now()}`;
const databaseName = `downtown_u_refund_test_${suffix}`;
const runtimeLogin = `downtown_u_refund_login_${suffix}`;
const unrelatedRole = `downtown_u_refund_unrelated_${suffix}`;
const password = randomUUID().replaceAll("-", "");
const migrations = [1, 2, 3, 4, 5].map((number) => readFileSync(resolve(
  process.cwd(), "db/migrations",
  `20260804000${number}_downtown_u_${["phase1", "webhook_events", "payment_activation", "refund_activation", "auth"][number - 1]}.sql`,
), "utf8"));
let admin: Pool;
let owner: Pool;
let runtime: Pool;
function qi(value: string) { return `"${value.replaceAll('"', '""')}"`; }
function payment(id: string): TrustedEnrollmentCommand {
  return { paymentId: `PAY_${id}`, orderId: `ORDER_${id}`, planId: "flex-5", amount: 6000,
    currency: "USD", locationId: "LOC_1", email: `${id.toLowerCase()}@example.com`,
    paidAt: "2026-08-04T12:00:00.123456789Z", eligibility: "pending" };
}
async function claim(eventId: string, eventType: "payment.updated" | "refund.updated", resourceId: string) {
  const bodyHash = createHash("sha256").update(eventId).digest("hex");
  const result = await new PostgresWebhookEventStore(runtime).claim(eventId, eventType, bodyHash);
  if (result.outcome !== "claimed") throw new Error("claim failed");
  return { eventId, eventType, bodyHash, resourceId, claimToken: result.claimToken, attemptCount: result.attemptCount };
}
async function activatePurchase(id: string) {
  const command = payment(id);
  await new PostgresPaymentActivationStore(runtime).activate(
    await claim(`EVT_PAY_${id}`, "payment.updated", command.paymentId), command,
  );
  return command;
}
function refund(id: string, paymentCommand: TrustedEnrollmentCommand, amount: number): TrustedRefundCommand {
  return { refundId: `REFUND_${id}`, paymentId: paymentCommand.paymentId,
    orderId: paymentCommand.orderId, amount, currency: "USD", locationId: "LOC_1",
    updatedAt: `2026-08-05T12:00:${id.length.toString().padStart(2, "0")}.123456789Z` };
}
async function activateRefund(command: TrustedRefundCommand) {
  return new PostgresRefundActivationStore(runtime).activate(
    await claim(`EVT_${command.refundId}`, "refund.updated", command.refundId), command,
  );
}
async function seedOwnerLedgerCollision(refundId: string, id: string) {
  const paid = await activatePurchase(`COLLISION_OWNER_${id}`);
  const purchase = (await owner.query(
    "SELECT id,student_id FROM downtown_u_plan_purchases WHERE square_payment_id=$1", [paid.paymentId],
  )).rows[0];
  const redemption = (await owner.query(`INSERT INTO downtown_u_redemptions
    (student_id,credits,idempotency_key) VALUES ($1,1,$2) RETURNING id`,
  [purchase.student_id, `collision-redemption-${id}`])).rows[0];
  await owner.query(`INSERT INTO downtown_u_credit_transactions
    (student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,
     actor_type,actor_id,source_type,source_id)
    VALUES ($1,$2,-1,4,'reservation','owner collision',$3,'system','fixture','fixture',$4)`,
  [purchase.student_id,redemption.id,`purchase_refund:${refundId}`,`collision-source-${id}`]);
}
async function seedDuplicate(id: string, orderId: string | null = `ORDER_DUP_${id}`) {
  const paid = payment(`DUP_${id}`);
  paid.orderId = `ORDER_DUP_${id}`;
  await new PostgresPaymentActivationStore(runtime).activate(
    await claim(`EVT_PAY_DUP_${id}`, "payment.updated", paid.paymentId), paid,
  );
  const command: TrustedRefundCommand = {
    refundId: `REFUND_DUP_${id}`, paymentId: paid.paymentId,
    ...(orderId === null ? {} : { orderId }),
    amount: 600, currency: "USD", locationId: "LOC_1",
    updatedAt: "2026-08-05T13:00:00.123456789Z",
  };
  const claimed = await claim(`EVT_REFUND_DUP_${id}`, "refund.updated", command.refundId);
  const purchase = (await owner.query(
    "SELECT id,student_id FROM downtown_u_plan_purchases WHERE square_payment_id=$1", [paid.paymentId],
  )).rows[0];
  await owner.query(`INSERT INTO downtown_u_refund_applications
    (square_refund_id,source_event_id,square_payment_id,square_order_id,purchase_id,student_id,
     authoritative_amount_cents,authoritative_currency,authoritative_location_id,
     authoritative_updated_at,refund_sequence,cumulative_refunded_cents,target_refunded_credits,
     credit_delta,available_credits_before,status,applied_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text,1,$7,0,0,5,'applied',$10::timestamptz)`, [
    command.refundId, claimed.eventId, command.paymentId, command.orderId ?? null,
    purchase.id, purchase.student_id, command.amount, command.currency,
    command.locationId, command.updatedAt,
  ]);
  return { paid, command, claimed, purchase };
}
async function effects(paymentId: string) {
  return (await owner.query(`SELECT
    (SELECT count(*)::int FROM downtown_u_refund_applications r WHERE r.square_payment_id=$1) applications,
    (SELECT count(*)::int FROM downtown_u_refund_reconciliations q JOIN downtown_u_plan_purchases p ON p.id=q.purchase_id WHERE p.square_payment_id=$1) reconciliations,
    (SELECT count(*)::int FROM downtown_u_credit_transactions t JOIN downtown_u_plan_purchases p ON p.id=t.purchase_id WHERE p.square_payment_id=$1) ledger,
    (SELECT refunded_credits FROM downtown_u_plan_purchases WHERE square_payment_id=$1) refunded_credits,
    (SELECT status FROM downtown_u_plan_purchases WHERE square_payment_id=$1) purchase_status,
    (SELECT s.credit_balance FROM downtown_u_students s JOIN downtown_u_plan_purchases p ON p.student_id=s.id WHERE p.square_payment_id=$1) balance`, [paymentId])).rows[0];
}

run.sequential("atomic authoritative refund activation on PostgreSQL 16", () => {
  beforeAll(async () => {
    const parsed = new URL(baseUrl!);
    admin = new Pool({ connectionString: baseUrl });
    await admin.query(`CREATE DATABASE ${qi(databaseName)}`);
    parsed.pathname = `/${databaseName}`;
    owner = new Pool({ connectionString: parsed.toString(), max: 10 });
    const version = Number((await owner.query("SHOW server_version_num")).rows[0].server_version_num);
    if (version < 160000 || version >= 170000) throw new Error(`PostgreSQL 16 required, got ${version}`);
    for (const migration of migrations) await owner.query(migration);
    await owner.query(`CREATE ROLE ${qi(runtimeLogin)} LOGIN PASSWORD '${password}'`);
    await owner.query(`GRANT downtown_u_runtime TO ${qi(runtimeLogin)}`);
    parsed.username = runtimeLogin; parsed.password = password;
    runtime = new Pool({ connectionString: parsed.toString(), max: 15 });
  }, 30_000);

  afterAll(async () => {
    await runtime?.end(); await owner?.end();
    if (admin) {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${qi(databaseName)}`);
      await admin.query(`DROP ROLE IF EXISTS ${qi(runtimeLogin)}`);
      await admin.query(`DROP ROLE IF EXISTS ${qi(unrelatedRole)}`);
      await admin.end();
    }
  }, 30_000);

  it("applies cumulative floor policy, records zero delta, then fully revokes exactly once", async () => {
    const paid = await activatePurchase("FLOOR");
    await expect(activateRefund(refund("FLOOR_A", paid, 600))).resolves.toEqual({ outcome: "applied" });
    let state = (await owner.query("SELECT refunded_credits,status FROM downtown_u_plan_purchases WHERE square_payment_id=$1", [paid.paymentId])).rows[0];
    expect(state).toEqual({ refunded_credits: 0, status: "paid" });
    expect((await owner.query("SELECT credit_delta FROM downtown_u_refund_applications WHERE square_refund_id='REFUND_FLOOR_A'")).rows[0].credit_delta).toBe(0);
    expect((await owner.query("SELECT count(*)::int n FROM downtown_u_credit_transactions WHERE transaction_type='purchase_refund' AND source_id='REFUND_FLOOR_A'")).rows[0].n).toBe(0);

    await expect(activateRefund(refund("FLOOR_B", paid, 600))).resolves.toEqual({ outcome: "applied" });
    await expect(activateRefund(refund("FLOOR_C", paid, 4800))).resolves.toEqual({ outcome: "applied" });
    state = (await owner.query("SELECT refunded_credits,status FROM downtown_u_plan_purchases WHERE square_payment_id=$1", [paid.paymentId])).rows[0];
    expect(state).toEqual({ refunded_credits: 5, status: "refunded" });
    expect((await owner.query("SELECT credit_balance FROM downtown_u_students s JOIN downtown_u_plan_purchases p ON p.student_id=s.id WHERE p.square_payment_id=$1", [paid.paymentId])).rows[0].credit_balance).toBe(0);
    expect((await owner.query("SELECT count(*)::int n,sum(-delta)::int credits FROM downtown_u_credit_transactions WHERE transaction_type='purchase_refund' AND purchase_id=(SELECT id FROM downtown_u_plan_purchases WHERE square_payment_id=$1)", [paid.paymentId])).rows[0]).toEqual({ n: 2, credits: 5 });
    await expect(new PostgresWebhookEventStore(runtime).claim("EVT_REFUND_FLOOR_C", "refund.updated", createHash("sha256").update("EVT_REFUND_FLOOR_C").digest("hex"))).resolves.toMatchObject({ outcome: "duplicate" });
  });

  it("completes into reconciliation without a negative balance or purchase mutation", async () => {
    const paid = await activatePurchase("RECON");
    const purchase = (await owner.query("SELECT id,student_id FROM downtown_u_plan_purchases WHERE square_payment_id=$1", [paid.paymentId])).rows[0];
    await owner.query(`INSERT INTO downtown_u_redemptions(student_id,credits,idempotency_key) VALUES ($1,5,'consume-recon') RETURNING id`, [purchase.student_id]);
    const redemption = (await owner.query("SELECT id FROM downtown_u_redemptions WHERE idempotency_key='consume-recon'")).rows[0];
    await owner.query(`INSERT INTO downtown_u_credit_transactions(student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,-5,0,'reservation','fixture','consume-recon-ledger','system','fixture','reservation_request','consume-recon-source')`, [purchase.student_id, redemption.id]);
    await expect(activateRefund(refund("RECON", paid, 6000))).resolves.toEqual({ outcome: "reconciliation_required" });
    expect((await owner.query("SELECT credit_balance FROM downtown_u_students WHERE id=$1", [purchase.student_id])).rows[0].credit_balance).toBe(0);
    expect((await owner.query("SELECT refunded_credits,status FROM downtown_u_plan_purchases WHERE id=$1", [purchase.id])).rows[0]).toEqual({ refunded_credits: 0, status: "paid" });
    expect((await owner.query("SELECT reason_code,required_credits,available_credits,status FROM downtown_u_refund_reconciliations WHERE purchase_id=$1", [purchase.id])).rows).toEqual([{ reason_code: "insufficient_available_credits", required_credits: 5, available_credits: 0, status: "open" }]);
    expect((await owner.query("SELECT status FROM downtown_u_webhook_events WHERE square_event_id='EVT_REFUND_RECON'")).rows[0].status).toBe("completed");
  });

  it("rejects a noncanonical prior refund ledger and purchase cache with no application", async () => {
    const paid = await activatePurchase("LEGACY_NO_APP");
    const purchase = (await owner.query(
      "SELECT id,student_id FROM downtown_u_plan_purchases WHERE square_payment_id=$1", [paid.paymentId],
    )).rows[0];
    await owner.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,purchase_id,delta,resulting_balance,transaction_type,reason,idempotency_key,
       actor_type,actor_id,source_type,source_id,metadata)
      VALUES ($1,$2,-1,4,'purchase_refund','legacy refund','legacy-refund-key',
        'system','legacy','legacy','legacy-refund','{}'::jsonb)`, [purchase.student_id,purchase.id]);
    await owner.query(`UPDATE downtown_u_plan_purchases SET refunded_credits=1,
      status='partially_refunded',refunded_at='2026-08-05T11:00:00Z' WHERE id=$1`, [purchase.id]);
    const command = refund("LEGACY_NO_APP", paid, 1200);
    const claimed = await claim("EVT_REFUND_LEGACY_NO_APP", "refund.updated", command.refundId);
    await expect(new PostgresRefundActivationStore(runtime).activate(claimed, command))
      .rejects.toBeInstanceOf(RefundActivationConflictError);
    expect((await effects(paid.paymentId)).applications).toBe(0);
    expect((await owner.query("SELECT status FROM downtown_u_webhook_events WHERE square_event_id=$1", [claimed.eventId])).rows[0].status)
      .toBe("processing");
  });

  it("accepts a canonical prior partial, applies the next refund, and replays it stably", async () => {
    const paid = await activatePurchase("CANONICAL_CHAIN");
    await expect(activateRefund(refund("CANONICAL_CHAIN_A", paid, 1200)))
      .resolves.toEqual({ outcome: "applied" });
    const second = refund("CANONICAL_CHAIN_B", paid, 1200);
    const claimed = await claim("EVT_REFUND_CANONICAL_CHAIN_B", "refund.updated", second.refundId);
    const store = new PostgresRefundActivationStore(runtime);
    await expect(store.activate(claimed, second)).resolves.toEqual({ outcome: "applied" });
    const before = await effects(paid.paymentId);
    await owner.query("ALTER TABLE downtown_u_webhook_events DISABLE TRIGGER downtown_u_webhook_events_protect_trigger");
    await owner.query(`UPDATE downtown_u_webhook_events SET status='processing',claim_token=$2,
      completed_at=NULL WHERE square_event_id=$1`, [claimed.eventId,claimed.claimToken]);
    await owner.query("ALTER TABLE downtown_u_webhook_events ENABLE TRIGGER downtown_u_webhook_events_protect_trigger");
    await expect(store.activate(claimed, second)).resolves.toEqual({ outcome: "duplicate" });
    expect(await effects(paid.paymentId)).toEqual(before);
  });

  it("fails closed for over-refund, unknown purchase, stale token, and immutable/direct DML attacks", async () => {
    const paid = await activatePurchase("CONFLICT");
    await expect(activateRefund(refund("OVER", paid, 6001))).rejects.toBeInstanceOf(RefundActivationConflictError);
    const unknown = refund("UNKNOWN", { ...paid, paymentId: "PAY_UNKNOWN", orderId: "ORDER_UNKNOWN" }, 100);
    await expect(activateRefund(unknown)).rejects.toBeInstanceOf(RefundActivationConflictError);
    const command = refund("STALE", paid, 100);
    const stale = await claim("EVT_REFUND_STALE", "refund.updated", command.refundId);
    await expect(new PostgresRefundActivationStore(runtime).activate({ ...stale, claimToken: "00000000-0000-0000-0000-000000000000" }, command)).rejects.toBeInstanceOf(RefundActivationConflictError);
    for (const sql of [
      "INSERT INTO downtown_u_refund_applications DEFAULT VALUES",
      "SELECT * FROM downtown_u_refund_applications",
      "UPDATE downtown_u_plan_purchases SET refunded_credits=1",
      "CREATE TABLE public.downtown_u_refund_attack(id int)",
    ]) await expect(runtime.query(sql)).rejects.toMatchObject({ code: "42501" });
    await expect(owner.query("UPDATE downtown_u_refund_applications SET status='applied'"))
      .rejects.toMatchObject({ code: "P0001" });
  });

  it("returns a stable exact duplicate only after validating persisted topology and completes its claim", async () => {
    const seeded = await seedDuplicate("EXACT");
    await expect(new PostgresRefundActivationStore(runtime).activate(seeded.claimed, seeded.command))
      .resolves.toEqual({ outcome: "duplicate" });
    expect((await owner.query("SELECT status,claim_token FROM downtown_u_webhook_events WHERE square_event_id=$1", [seeded.claimed.eventId])).rows[0])
      .toEqual({ status: "completed", claim_token: null });
    expect(await effects(seeded.paid.paymentId)).toEqual({
      applications: 1, reconciliations: 0, ledger: 1,
      refunded_credits: 0, purchase_status: "paid", balance: 5,
    });
  });

  it("binds a persisted duplicate order to its purchase while preserving authoritative omission", async () => {
    const mismatch = await seedDuplicate("ORDER_MISMATCH", "ORDER_NOT_ON_PURCHASE");
    await expect(new PostgresRefundActivationStore(runtime).activate(mismatch.claimed, mismatch.command))
      .rejects.toBeInstanceOf(RefundActivationConflictError);
    expect((await owner.query("SELECT status FROM downtown_u_webhook_events WHERE square_event_id=$1", [mismatch.claimed.eventId])).rows[0].status)
      .toBe("processing");

    const omitted = await seedDuplicate("ORDER_OMITTED", null);
    await expect(new PostgresRefundActivationStore(runtime).activate(omitted.claimed, omitted.command))
      .resolves.toEqual({ outcome: "duplicate" });
  });

  it("uses immutable ledger sequence rather than misleading created_at order for the grant witness", async () => {
    const paid = await activatePurchase("LEDGER_ORDER");
    const purchase = (await owner.query(
      "SELECT id,student_id FROM downtown_u_plan_purchases WHERE square_payment_id=$1", [paid.paymentId],
    )).rows[0];
    const redemption = (await owner.query(`INSERT INTO downtown_u_redemptions
      (student_id,credits,idempotency_key) VALUES ($1,1,'ledger-order-reservation') RETURNING id`,
    [purchase.student_id])).rows[0];
    await owner.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,
       actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,-1,4,'reservation','fixture','ledger-order-debit','system','fixture',
        'reservation_request','ledger-order-source')`, [purchase.student_id,redemption.id]);
    await owner.query("ALTER TABLE downtown_u_credit_transactions DISABLE TRIGGER downtown_u_credit_transactions_immutable");
    await owner.query(`UPDATE downtown_u_credit_transactions SET created_at='2099-01-01T00:00:00Z'
      WHERE purchase_id=$1 AND transaction_type='purchase_grant'`, [purchase.id]);
    await owner.query("ALTER TABLE downtown_u_credit_transactions ENABLE TRIGGER downtown_u_credit_transactions_immutable");

    await expect(activateRefund(refund("LEDGER_ORDER", paid, 1200)))
      .resolves.toEqual({ outcome: "applied" });
    const ledger = (await owner.query(`SELECT ledger_sequence,resulting_balance FROM downtown_u_credit_transactions
      WHERE student_id=$1 ORDER BY ledger_sequence`, [purchase.student_id])).rows;
    expect(ledger).toEqual([
      { ledger_sequence: "1", resulting_balance: 5 },
      { ledger_sequence: "2", resulting_balance: 4 },
      { ledger_sequence: "3", resulting_balance: 3 },
    ]);
    await expect(runtime.query(`INSERT INTO downtown_u_credit_transactions
      (ledger_sequence,student_id,delta,resulting_balance,transaction_type,reason,idempotency_key,
       actor_type,actor_id,source_type,source_id)
      VALUES (99,$1,-1,2,'reservation','spoof','ledger-spoof','system','fixture','fixture','ledger-spoof')`,
    [purchase.student_id])).rejects.toMatchObject({ code: "42501" });
  });

  it("rejects corrupted duplicate sequence economics and leaves every claim processing", async () => {
    const corruptions = [
      "cumulative_refunded_cents=601", "target_refunded_credits=1",
      "target_refunded_credits=1,credit_delta=1", "refund_sequence=2",
      "applied_at='2026-08-05T13:00:01Z'::timestamptz",
    ];
    for (const [index, assignment] of corruptions.entries()) {
      const seeded = await seedDuplicate(`ECON_${index}`);
      await owner.query("ALTER TABLE downtown_u_refund_applications DISABLE TRIGGER downtown_u_refund_applications_immutable");
      await owner.query(`UPDATE downtown_u_refund_applications SET ${assignment} WHERE square_refund_id=$1`, [seeded.command.refundId]);
      await owner.query("ALTER TABLE downtown_u_refund_applications ENABLE TRIGGER downtown_u_refund_applications_immutable");
      await expect(new PostgresRefundActivationStore(runtime).activate(seeded.claimed, seeded.command))
        .rejects.toBeInstanceOf(RefundActivationConflictError);
      expect((await owner.query("SELECT status FROM downtown_u_webhook_events WHERE square_event_id=$1", [seeded.claimed.eventId])).rows[0].status)
        .toBe("processing");
    }
  });

  it("rejects every omitted A3b grant signature field before new refund processing", async () => {
    const corruptions = [
      "reason='corrupt reason'", "idempotency_key='corrupt-grant-key'",
      "actor_type='system',actor_id='corrupt'", "source_type='fixture',source_id='corrupt-source'",
      "resulting_balance=resulting_balance+1", "metadata='{}'::jsonb",
    ];
    for (const [index, assignment] of corruptions.entries()) {
      const paid = await activatePurchase(`GRANT_CORRUPT_${index}`);
      await owner.query("ALTER TABLE downtown_u_credit_transactions DISABLE TRIGGER downtown_u_credit_transactions_immutable");
      await owner.query(`UPDATE downtown_u_credit_transactions SET ${assignment}
        WHERE purchase_id=(SELECT id FROM downtown_u_plan_purchases WHERE square_payment_id=$1)
          AND transaction_type='purchase_grant'`, [paid.paymentId]);
      await owner.query("ALTER TABLE downtown_u_credit_transactions ENABLE TRIGGER downtown_u_credit_transactions_immutable");
      const command = refund(`GRANT_CORRUPT_${index}`, paid, 600);
      const claimed = await claim(`EVT_${command.refundId}`, "refund.updated", command.refundId);
      await expect(new PostgresRefundActivationStore(runtime).activate(claimed, command))
        .rejects.toBeInstanceOf(RefundActivationConflictError);
      expect((await owner.query("SELECT status FROM downtown_u_webhook_events WHERE square_event_id=$1", [claimed.eventId])).rows[0].status)
        .toBe("processing");
      expect((await effects(paid.paymentId)).applications).toBe(0);
    }

    const duplicate = await seedDuplicate("GRANT_CORRUPT_DUPLICATE");
    await owner.query("ALTER TABLE downtown_u_credit_transactions DISABLE TRIGGER downtown_u_credit_transactions_immutable");
    await owner.query(`UPDATE downtown_u_credit_transactions SET metadata='{}'::jsonb
      WHERE purchase_id=$1 AND transaction_type='purchase_grant'`, [duplicate.purchase.id]);
    await owner.query("ALTER TABLE downtown_u_credit_transactions ENABLE TRIGGER downtown_u_credit_transactions_immutable");
    await expect(new PostgresRefundActivationStore(runtime).activate(duplicate.claimed, duplicate.command))
      .rejects.toBeInstanceOf(RefundActivationConflictError);
    expect((await owner.query("SELECT status FROM downtown_u_webhook_events WHERE square_event_id=$1", [duplicate.claimed.eventId])).rows[0].status)
      .toBe("processing");
  });

  it("rejects malformed reconciliation snapshot topology on duplicate replay", async () => {
    const paid = await activatePurchase("RECON_TOPOLOGY");
    const purchase = (await owner.query("SELECT id,student_id FROM downtown_u_plan_purchases WHERE square_payment_id=$1", [paid.paymentId])).rows[0];
    const command = refund("RECON_TOPOLOGY", paid, 6000);
    const claimed = await claim("EVT_REFUND_RECON_TOPOLOGY", "refund.updated", command.refundId);
    const app = (await owner.query(`INSERT INTO downtown_u_refund_applications
      (square_refund_id,source_event_id,square_payment_id,square_order_id,purchase_id,student_id,
       authoritative_amount_cents,authoritative_currency,authoritative_location_id,authoritative_updated_at,
       refund_sequence,cumulative_refunded_cents,target_refunded_credits,credit_delta,available_credits_before,status)
      VALUES ($1,$2,$3,$4,$5,$6,6000,'USD','LOC_1',$7,1,6000,5,5,0,'reconciliation_required') RETURNING id`,
    [command.refundId,claimed.eventId,command.paymentId,command.orderId,purchase.id,purchase.student_id,command.updatedAt])).rows[0];
    await owner.query(`INSERT INTO downtown_u_refund_reconciliations
      (refund_application_id,purchase_id,student_id,reason_code,required_credits,available_credits)
      VALUES ($1,$2,$3,'insufficient_available_credits',5,1)`, [app.id,purchase.id,purchase.student_id]);
    await expect(new PostgresRefundActivationStore(runtime).activate(claimed, command))
      .rejects.toBeInstanceOf(RefundActivationConflictError);
    expect((await owner.query("SELECT status FROM downtown_u_webhook_events WHERE square_event_id=$1", [claimed.eventId])).rows[0].status)
      .toBe("processing");
  });

  it("accepts exact reconciliation duplicate after counting prior applied credits only", async () => {
    const paid = await activatePurchase("RECON_PRIOR_APPLIED");
    const purchase = (await owner.query("SELECT id,student_id FROM downtown_u_plan_purchases WHERE square_payment_id=$1", [paid.paymentId])).rows[0];
    await owner.query(`INSERT INTO downtown_u_refund_applications
      (square_refund_id,source_event_id,square_payment_id,square_order_id,purchase_id,student_id,
       authoritative_amount_cents,authoritative_currency,authoritative_location_id,authoritative_updated_at,
       refund_sequence,cumulative_refunded_cents,target_refunded_credits,credit_delta,available_credits_before,status,applied_at)
      VALUES ('REFUND_PRIOR_APPLIED','EVT_REFUND_PRIOR_APPLIED',$1,$2,$3,$4,1200,'USD','LOC_1',
        '2026-08-05T14:00:00Z',1,1200,1,1,5,'applied','2026-08-05T14:00:00Z')`,
    [paid.paymentId,paid.orderId,purchase.id,purchase.student_id]);
    await owner.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,purchase_id,delta,resulting_balance,transaction_type,reason,idempotency_key,
       actor_type,actor_id,source_type,source_id,metadata)
      VALUES ($1,$2,-1,4,'purchase_refund','verified Square refund','purchase_refund:REFUND_PRIOR_APPLIED',
        'square_webhook','EVT_REFUND_PRIOR_APPLIED','square_refund','REFUND_PRIOR_APPLIED',
        '{"amountCents":1200,"currency":"USD"}'::jsonb)`, [purchase.student_id,purchase.id]);
    await owner.query(`UPDATE downtown_u_plan_purchases SET refunded_credits=1,status='partially_refunded',
      refunded_at='2026-08-05T14:00:00Z' WHERE id=$1`, [purchase.id]);
    await owner.query(`INSERT INTO downtown_u_redemptions(student_id,credits,idempotency_key)
      VALUES ($1,4,'consume-prior-applied')`, [purchase.student_id]);
    const redemption = (await owner.query("SELECT id FROM downtown_u_redemptions WHERE idempotency_key='consume-prior-applied'")).rows[0];
    await owner.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,
       actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,-4,0,'reservation','fixture','consume-prior-applied-ledger',
        'system','fixture','reservation_request','consume-prior-applied-source')`, [purchase.student_id,redemption.id]);
    const command = refund("RECON_PRIOR_APPLIED", paid, 4800);
    const claimed = await claim("EVT_REFUND_RECON_PRIOR_APPLIED", "refund.updated", command.refundId);
    const app = (await owner.query(`INSERT INTO downtown_u_refund_applications
      (square_refund_id,source_event_id,square_payment_id,square_order_id,purchase_id,student_id,
       authoritative_amount_cents,authoritative_currency,authoritative_location_id,authoritative_updated_at,
       refund_sequence,cumulative_refunded_cents,target_refunded_credits,credit_delta,available_credits_before,status)
      VALUES ($1,$2,$3,$4,$5,$6,4800,'USD','LOC_1',$7,2,6000,5,4,0,'reconciliation_required') RETURNING id`,
    [command.refundId,claimed.eventId,command.paymentId,command.orderId,purchase.id,purchase.student_id,command.updatedAt])).rows[0];
    await owner.query(`INSERT INTO downtown_u_refund_reconciliations
      (refund_application_id,purchase_id,student_id,reason_code,required_credits,available_credits)
      VALUES ($1,$2,$3,'insufficient_available_credits',4,0)`, [app.id,purchase.id,purchase.student_id]);
    await expect(new PostgresRefundActivationStore(runtime).activate(claimed, command))
      .resolves.toEqual({ outcome: "duplicate" });
    expect((await owner.query("SELECT refunded_credits,status FROM downtown_u_plan_purchases WHERE id=$1", [purchase.id])).rows[0])
      .toEqual({ refunded_credits: 1, status: "partially_refunded" });
  });

  it("rejects owner-seeded collision rows for zero-delta and reconciliation duplicates", async () => {
    const zero = await seedDuplicate("ZERO_COLLISION");
    await seedOwnerLedgerCollision(zero.command.refundId, "ZERO");
    await expect(new PostgresRefundActivationStore(runtime).activate(zero.claimed, zero.command))
      .rejects.toBeInstanceOf(RefundActivationConflictError);

    const paid = await activatePurchase("RECON_COLLISION");
    const purchase = (await owner.query("SELECT id,student_id FROM downtown_u_plan_purchases WHERE square_payment_id=$1", [paid.paymentId])).rows[0];
    const command = refund("RECON_COLLISION", paid, 6000);
    const claimed = await claim("EVT_REFUND_RECON_COLLISION", "refund.updated", command.refundId);
    const app = (await owner.query(`INSERT INTO downtown_u_refund_applications
      (square_refund_id,source_event_id,square_payment_id,square_order_id,purchase_id,student_id,
       authoritative_amount_cents,authoritative_currency,authoritative_location_id,authoritative_updated_at,
       refund_sequence,cumulative_refunded_cents,target_refunded_credits,credit_delta,available_credits_before,status)
      VALUES ($1,$2,$3,$4,$5,$6,6000,'USD','LOC_1',$7,1,6000,5,5,0,'reconciliation_required') RETURNING id`,
    [command.refundId,claimed.eventId,command.paymentId,command.orderId,purchase.id,purchase.student_id,command.updatedAt])).rows[0];
    await owner.query(`INSERT INTO downtown_u_refund_reconciliations
      (refund_application_id,purchase_id,student_id,reason_code,required_credits,available_credits)
      VALUES ($1,$2,$3,'insufficient_available_credits',5,0)`, [app.id,purchase.id,purchase.student_id]);
    await seedOwnerLedgerCollision(command.refundId, "RECON");
    await expect(new PostgresRefundActivationStore(runtime).activate(claimed, command))
      .rejects.toBeInstanceOf(RefundActivationConflictError);
    for (const eventId of [zero.claimed.eventId, claimed.eventId]) {
      expect((await owner.query("SELECT status FROM downtown_u_webhook_events WHERE square_event_id=$1", [eventId])).rows[0].status)
        .toBe("processing");
    }
  });

  it("rejects each refund signature conflict without mutating authoritative effects", async () => {
    const variants: Array<[string, (seeded: Awaited<ReturnType<typeof seedDuplicate>>) => { claim?: typeof seeded.claimed; command?: TrustedRefundCommand }]> = [
      ["refund", (s) => ({ claim: { ...s.claimed, resourceId: "REFUND_CHANGED" }, command: { ...s.command, refundId: "REFUND_CHANGED" } })],
      ["payment", (s) => ({ command: { ...s.command, paymentId: "PAY_CHANGED" } })],
      ["order_removed", (s) => ({ command: { ...s.command, orderId: undefined } })],
      ["order_changed", (s) => ({ command: { ...s.command, orderId: "ORDER_CHANGED" } })],
      ["amount", (s) => ({ command: { ...s.command, amount: 601 } })],
      ["currency", (s) => ({ command: { ...s.command, currency: "CAD" } as unknown as TrustedRefundCommand })],
      ["location", (s) => ({ command: { ...s.command, locationId: "LOC_CHANGED" } })],
      ["updated", (s) => ({ command: { ...s.command, updatedAt: "2026-08-05T13:00:01Z" } })],
    ];
    for (const [name, vary] of variants) {
      const seeded = await seedDuplicate(`SIG_${name}`);
      const before = await effects(seeded.paid.paymentId);
      const changed = vary(seeded);
      await expect(new PostgresRefundActivationStore(runtime).activate(
        changed.claim ?? seeded.claimed, changed.command ?? seeded.command,
      )).rejects.toBeInstanceOf(RefundActivationConflictError);
      expect(await effects(seeded.paid.paymentId)).toEqual(before);
      expect((await owner.query("SELECT status FROM downtown_u_webhook_events WHERE square_event_id=$1", [seeded.claimed.eventId])).rows[0].status)
        .toBe("processing");
    }

    const removed = await seedDuplicate("SIG_ORDER_PRESENT", null);
    await expect(new PostgresRefundActivationStore(runtime).activate(
      removed.claimed, { ...removed.command, orderId: removed.paid.orderId },
    )).rejects.toBeInstanceOf(RefundActivationConflictError);

    const source = await seedDuplicate("SIG_SOURCE");
    const secondClaim = await claim("EVT_REFUND_DUP_SIG_SOURCE_CHANGED", "refund.updated", source.command.refundId);
    await expect(new PostgresRefundActivationStore(runtime).activate(secondClaim, source.command))
      .rejects.toBeInstanceOf(RefundActivationConflictError);
    await expect(new PostgresWebhookEventStore(runtime).claim(
      source.claimed.eventId, "refund.updated", "f".repeat(64),
    )).rejects.toBeTruthy();
  });

  it("rejects malformed commands, resource mismatch and invalid economics before any effects", async () => {
    const paid = await activatePurchase("MALFORMED");
    const base = refund("MALFORMED", paid, 1200);
    const claimed = await claim("EVT_REFUND_MALFORMED_CASES", "refund.updated", base.refundId);
    for (const command of [
      { ...base, refundId: "bad space" }, { ...base, paymentId: "bad space" },
      { ...base, amount: 0 }, { ...base, amount: 40_001 },
      { ...base, amount: Number.MAX_SAFE_INTEGER }, { ...base, amount: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, updatedAt: "not-a-time" }, { ...base, locationId: "bad space" },
    ]) await expect(new PostgresRefundActivationStore(runtime).activate(
      { ...claimed, resourceId: command.refundId }, command,
    )).rejects.toBeInstanceOf(RefundActivationConflictError);
    await expect(new PostgresRefundActivationStore(runtime).activate(
      { ...claimed, resourceId: "REFUND_OTHER" }, base,
    )).rejects.toBeInstanceOf(RefundActivationConflictError);
    await expect(runtime.query(`SELECT * FROM public.downtown_u_activate_verified_refund(
      $1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10)`, [
      claimed.eventId, claimed.claimToken, claimed.resourceId, base.refundId,
      base.paymentId, base.orderId, 40_001, base.currency, base.locationId, base.updatedAt,
    ])).rejects.toMatchObject({ code: "P0001" });
    expect((await effects(paid.paymentId)).applications).toBe(0);
  });

  it("serializes concurrent distinct refunds on one payment and never exceeds exact purchase economics", async () => {
    const paid = await activatePurchase("CONCURRENT_DISTINCT");
    const commands = [refund("CONCURRENT_A", paid, 3000), refund("CONCURRENT_B", paid, 3000)];
    const outcomes = await Promise.all(commands.map(activateRefund));
    expect(outcomes).toEqual([{ outcome: "applied" }, { outcome: "applied" }]);
    expect(await effects(paid.paymentId)).toEqual({
      applications: 2, reconciliations: 0, ledger: 3,
      refunded_credits: 5, purchase_status: "refunded", balance: 0,
    });
    expect((await owner.query(`SELECT ledger_sequence FROM downtown_u_credit_transactions
      WHERE student_id=(SELECT student_id FROM downtown_u_plan_purchases WHERE square_payment_id=$1)
      ORDER BY ledger_sequence`, [paid.paymentId])).rows.map((row) => row.ledger_sequence))
      .toEqual(["1", "2", "3"]);

    const capped = await activatePurchase("CONCURRENT_CAP");
    const settled = await Promise.allSettled([
      activateRefund(refund("CAP_A", capped, 4000)), activateRefund(refund("CAP_B", capped, 4000)),
    ]);
    expect(settled.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((x) => x.status === "rejected")).toHaveLength(1);
    const cappedEffects = await effects(capped.paymentId);
    expect(cappedEffects.applications).toBe(1);
    expect(cappedEffects.refunded_credits).toBeLessThanOrEqual(5);
    expect(cappedEffects.balance).toBeGreaterThanOrEqual(0);
  });

  it("rejects non-refund ledger identity reservations before zero and reconciliation applications", async () => {
    const zeroPaid = await activatePurchase("NEW_ZERO_COLLISION");
    const zeroCommand = refund("NEW_ZERO_COLLISION", zeroPaid, 600);
    await seedOwnerLedgerCollision(zeroCommand.refundId, "NEW_ZERO");
    const zeroClaim = await claim("EVT_REFUND_NEW_ZERO_COLLISION", "refund.updated", zeroCommand.refundId);
    await expect(new PostgresRefundActivationStore(runtime).activate(zeroClaim, zeroCommand))
      .rejects.toBeInstanceOf(RefundActivationConflictError);
    expect((await effects(zeroPaid.paymentId)).applications).toBe(0);

    const reconPaid = await activatePurchase("NEW_RECON_COLLISION");
    const reconPurchase = (await owner.query(
      "SELECT id,student_id FROM downtown_u_plan_purchases WHERE square_payment_id=$1", [reconPaid.paymentId],
    )).rows[0];
    const redemption = (await owner.query(`INSERT INTO downtown_u_redemptions
      (student_id,credits,idempotency_key) VALUES ($1,5,'consume-new-recon-collision') RETURNING id`,
    [reconPurchase.student_id])).rows[0];
    await owner.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,redemption_id,delta,resulting_balance,transaction_type,reason,idempotency_key,
       actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,-5,0,'reservation','fixture','consume-new-recon-collision-ledger',
        'system','fixture','fixture','consume-new-recon-collision-source')`,
    [reconPurchase.student_id,redemption.id]);
    const reconCommand = refund("NEW_RECON_COLLISION", reconPaid, 6000);
    await seedOwnerLedgerCollision(reconCommand.refundId, "NEW_RECON");
    const reconClaim = await claim("EVT_REFUND_NEW_RECON_COLLISION", "refund.updated", reconCommand.refundId);
    await expect(new PostgresRefundActivationStore(runtime).activate(reconClaim, reconCommand))
      .rejects.toBeInstanceOf(RefundActivationConflictError);
    expect((await effects(reconPaid.paymentId))).toMatchObject({ applications: 0, reconciliations: 0 });
    for (const eventId of [zeroClaim.eventId, reconClaim.eventId]) {
      expect((await owner.query("SELECT status FROM downtown_u_webhook_events WHERE square_event_id=$1", [eventId])).rows[0].status)
        .toBe("processing");
    }
  });

  it("rolls every activation effect back on a safe late ledger collision and leaves the claim processing", async () => {
    const paid = await activatePurchase("ROLLBACK");
    const purchase = (await owner.query("SELECT id,student_id FROM downtown_u_plan_purchases WHERE square_payment_id=$1", [paid.paymentId])).rows[0];
    const command = refund("ROLLBACK", paid, 1200);
    await owner.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,purchase_id,delta,resulting_balance,transaction_type,reason,idempotency_key,
       actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,-1,4,'purchase_refund','owner collision',$3,'system','fixture','fixture',$3)`,
    [purchase.student_id, purchase.id, `purchase_refund:${command.refundId}`]);
    const claimed = await claim("EVT_REFUND_ROLLBACK", "refund.updated", command.refundId);
    const before = await effects(paid.paymentId);
    await expect(new PostgresRefundActivationStore(runtime).activate(claimed, command))
      .rejects.toBeInstanceOf(RefundActivationConflictError);
    expect(await effects(paid.paymentId)).toEqual(before);
    expect((await owner.query("SELECT status FROM downtown_u_webhook_events WHERE square_event_id=$1", [claimed.eventId])).rows[0].status)
      .toBe("processing");
  });

  it("denies runtime refund DML/capability tampering and owner mutation or truncation", async () => {
    const paid = await activatePurchase("PRIVILEGE");
    const purchase = (await owner.query("SELECT id,student_id FROM downtown_u_plan_purchases WHERE square_payment_id=$1", [paid.paymentId])).rows[0];
    for (const sql of [
      "SELECT * FROM downtown_u_refund_applications", "SELECT * FROM downtown_u_refund_reconciliations",
      "INSERT INTO downtown_u_refund_applications DEFAULT VALUES", "UPDATE downtown_u_refund_applications SET status='applied'",
      "DELETE FROM downtown_u_refund_applications", "TRUNCATE downtown_u_refund_applications",
      "INSERT INTO downtown_u_refund_reconciliations DEFAULT VALUES", "UPDATE downtown_u_refund_reconciliations SET status='open'",
      "DELETE FROM downtown_u_refund_reconciliations", "TRUNCATE downtown_u_refund_reconciliations",
      "SELECT public.downtown_u_reject_refund_record_mutation()",
      "ALTER TABLE public.downtown_u_refund_applications DISABLE TRIGGER ALL",
      "ALTER FUNCTION public.downtown_u_activate_verified_refund(text,uuid,text,text,text,text,integer,text,text,text) SECURITY INVOKER",
      "ALTER FUNCTION public.downtown_u_activate_verified_refund(text,uuid,text,text,text,text,integer,text,text,text) SET search_path TO public",
    ]) await expect(runtime.query(sql)).rejects.toMatchObject({ code: "42501" });
    await expect(runtime.query(`INSERT INTO downtown_u_credit_transactions
      (student_id,purchase_id,delta,resulting_balance,transaction_type,reason,idempotency_key,actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,-1,4,'purchase_refund','attack','attack-refund','square_webhook','attack','square_refund','attack')`,
    [purchase.student_id, purchase.id])).rejects.toMatchObject({ code: "P0001" });
    for (const sql of [
      "UPDATE downtown_u_refund_applications SET status='applied'", "DELETE FROM downtown_u_refund_applications",
      "TRUNCATE downtown_u_refund_applications", "UPDATE downtown_u_refund_reconciliations SET status='open'",
      "DELETE FROM downtown_u_refund_reconciliations", "TRUNCATE downtown_u_refund_reconciliations",
    ]) await expect(owner.query(sql)).rejects.toSatisfy((error: unknown) => {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      return code === "P0001" || code === "0A000";
    });
  });

  it("rechecks exact function ACLs and search_path on the same pool after owner drift", async () => {
    const refundFunction = `public.downtown_u_activate_verified_refund(
      text,uuid,text,text,text,text,integer,text,text,text)`;
    const helperFunction = "public.downtown_u_reject_refund_record_mutation()";
    await owner.query(`CREATE ROLE ${qi(unrelatedRole)} NOLOGIN`);
    await expect(assertDowntownURuntimeIdentity(runtime)).resolves.toBeUndefined();

    await owner.query(`GRANT EXECUTE ON FUNCTION ${refundFunction} TO PUBLIC`);
    await expect(assertDowntownURuntimeIdentity(runtime)).rejects.toThrow(/unsafe/i);
    await owner.query(`REVOKE EXECUTE ON FUNCTION ${refundFunction} FROM PUBLIC`);

    await owner.query(`GRANT EXECUTE ON FUNCTION ${refundFunction} TO ${qi(unrelatedRole)}`);
    await expect(assertDowntownURuntimeIdentity(runtime)).rejects.toThrow(/unsafe/i);
    await owner.query(`REVOKE EXECUTE ON FUNCTION ${refundFunction} FROM ${qi(unrelatedRole)}`);

    await owner.query(`REVOKE EXECUTE ON FUNCTION ${refundFunction} FROM downtown_u_runtime`);
    await owner.query(`GRANT EXECUTE ON FUNCTION ${refundFunction} TO PUBLIC`);
    await expect(assertDowntownURuntimeIdentity(runtime)).rejects.toThrow(/unsafe/i);
    await owner.query(`REVOKE EXECUTE ON FUNCTION ${refundFunction} FROM PUBLIC`);
    await owner.query(`GRANT EXECUTE ON FUNCTION ${refundFunction} TO downtown_u_runtime`);

    await owner.query(`GRANT EXECUTE ON FUNCTION ${refundFunction} TO downtown_u_runtime WITH GRANT OPTION`);
    await expect(assertDowntownURuntimeIdentity(runtime)).rejects.toThrow(/unsafe/i);
    await owner.query(`REVOKE ALL ON FUNCTION ${refundFunction} FROM downtown_u_runtime`);
    await owner.query(`GRANT EXECUTE ON FUNCTION ${refundFunction} TO downtown_u_runtime`);

    for (const role of ["downtown_u_runtime", qi(unrelatedRole)]) {
      await owner.query(`GRANT EXECUTE ON FUNCTION ${helperFunction} TO ${role}`);
      await expect(assertDowntownURuntimeIdentity(runtime)).rejects.toThrow(/unsafe/i);
      await owner.query(`REVOKE EXECUTE ON FUNCTION ${helperFunction} FROM ${role}`);
    }

    await owner.query(`ALTER FUNCTION ${refundFunction} SET search_path TO public`);
    await expect(assertDowntownURuntimeIdentity(runtime)).rejects.toThrow(/unsafe/i);
    await owner.query(`ALTER FUNCTION ${refundFunction} SET search_path TO pg_catalog`);
    // PostgreSQL reports an unprivileged GRANT as a warning/no-op rather than an
    // error; prove the bounded login could not change the ACL.
    await runtime.query(`GRANT EXECUTE ON FUNCTION ${refundFunction} TO PUBLIC`);
    expect((await owner.query(`SELECT count(*)::int AS n
      FROM aclexplode(COALESCE(
        (SELECT proacl FROM pg_proc WHERE oid=$1::regprocedure),
        acldefault('f',(SELECT proowner FROM pg_proc WHERE oid=$1::regprocedure))))
      WHERE grantee=0`, [refundFunction.replace(/\s+/g, "")])).rows[0].n).toBe(0);
    await expect(assertDowntownURuntimeIdentity(runtime)).resolves.toBeUndefined();
  });
});
