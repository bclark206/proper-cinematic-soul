import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TrustedEnrollmentCommand } from "../enrollment-service";
import { PaymentActivationConflictError } from "../payment-activation";
import { PostgresPaymentActivationStore } from "../postgres-payment-activation-store";
import { assertDowntownURuntimeIdentity } from "../postgres-runtime-identity";
import { PostgresStudentAccountStore } from "../postgres-student-account-store";
import { PostgresWebhookEventStore } from "../postgres-webhook-event-store";
import { WebhookEventConflictError, WebhookEventTransitionError } from "../webhook-event-store";

const baseUrl = process.env.TEST_DATABASE_URL;
const run = baseUrl ? describe : describe.skip;
const suffix = `${process.pid}_${Date.now()}`;
const databaseName = `downtown_u_activation_test_${suffix}`;
const runtimeLogin = `downtown_u_activation_login_${suffix}`;
const runtimePassword = randomUUID().replaceAll("-", "");
const migrations = [
  "202608040001_downtown_u_phase1.sql",
  "202608040002_downtown_u_webhook_events.sql",
  "202608040003_downtown_u_payment_activation.sql",
].map((name) => readFileSync(resolve(process.cwd(), "db/migrations", name), "utf8"));
let admin: Pool;
let owner: Pool;
let runtime: Pool;
let runtimeConnectionString: string;
function qi(value: string) { return `"${value.replaceAll('"', '""')}"`; }
function dbCode(error: unknown) { return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined; }
function command(id: string, overrides: Partial<TrustedEnrollmentCommand> = {}): TrustedEnrollmentCommand {
  return {
    paymentId: `PAY_${id}`, orderId: `ORDER_${id}`, planId: "flex-5", amount: 6000,
    currency: "USD", locationId: "LOC_1", email: `${id.toLowerCase()}@example.com`,
    phone: `+1415555${String(1000 + id.length).padStart(4, "0")}`,
    squareCustomerId: `CUSTOMER_${id}`, paidAt: "2026-08-04T12:00:00.123456789Z",
    eligibility: "pending", ...overrides,
  };
}
async function claimed(eventId: string, body = eventId) {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const result = await new PostgresWebhookEventStore(runtime).claim(eventId, "payment.updated", bodyHash);
  if (result.outcome !== "claimed") throw new Error(`Expected claimed, got ${result.outcome}`);
  return { eventId, eventType: "payment.updated" as const, bodyHash, resourceId: `PAY_${eventId.replace("EVT_", "")}`, claimToken: result.claimToken, attemptCount: result.attemptCount };
}
async function counts(filter = "TRUE") {
  const [students, purchases, ledger] = await Promise.all([
    owner.query(`SELECT count(*)::int count FROM public.downtown_u_students WHERE ${filter}`),
    owner.query("SELECT count(*)::int count FROM public.downtown_u_plan_purchases"),
    owner.query("SELECT count(*)::int count FROM public.downtown_u_credit_transactions WHERE transaction_type='purchase_grant'"),
  ]);
  return [students.rows[0].count, purchases.rows[0].count, ledger.rows[0].count];
}
async function seedExistingPurchase(
  claim: Awaited<ReturnType<typeof claimed>>,
  trusted: TrustedEnrollmentCommand,
  withContactSnapshot: boolean,
) {
  const student = (await owner.query(`INSERT INTO public.downtown_u_students
    (normalized_email,normalized_phone,square_customer_id) VALUES ($1,$2,$3) RETURNING id`,
  [trusted.email ?? null, trusted.phone ?? null, trusted.squareCustomerId ?? null])).rows[0];
  const purchase = (await owner.query(`INSERT INTO public.downtown_u_plan_purchases
    (student_id,plan_id,credits_granted,price_cents,currency,square_payment_id,square_order_id,
     source_event_id,paid_at,authoritative_paid_at,authoritative_normalized_email,
     authoritative_normalized_phone,authoritative_square_customer_id)
    VALUES ($1,'flex-5',5,6000,'USD',$2,$3,$4,$5::text::timestamptz,$5::text,
      $6::text,$7::text,$8::text) RETURNING id`, [student.id, trusted.paymentId, trusted.orderId,
    claim.eventId, trusted.paidAt, withContactSnapshot ? trusted.email ?? null : null,
    withContactSnapshot ? trusted.phone ?? null : null,
    withContactSnapshot ? trusted.squareCustomerId ?? null : null])).rows[0];
  await owner.query(`INSERT INTO public.downtown_u_credit_transactions
    (student_id,purchase_id,delta,resulting_balance,transaction_type,reason,idempotency_key,
     actor_type,actor_id,source_type,source_id,metadata)
    VALUES ($1,$2,5,5,'purchase_grant','verified Square payment',$3,
     'square_webhook',$4,'square_payment',$5,$6::jsonb)`, [student.id, purchase.id,
    `purchase_grant:${trusted.paymentId}`, claim.eventId, trusted.paymentId,
    JSON.stringify({ currency: trusted.currency, locationId: trusted.locationId })]);
  return { student, purchase };
}

run.sequential("atomic verified payment activation on PostgreSQL 16", () => {
  beforeAll(async () => {
    const parsed = new URL(baseUrl!);
    const baseDatabase = parsed.pathname.slice(1);
    if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
      && !/(^|[_-])(test|testing|disposable)([_-]|$)/i.test(baseDatabase)) {
      throw new Error("Refusing integration tests: TEST_DATABASE_URL must be local or explicitly test-named");
    }
    admin = new Pool({ connectionString: baseUrl, max: 2 });
    await admin.query(`CREATE DATABASE ${qi(databaseName)}`);
    parsed.pathname = `/${databaseName}`;
    owner = new Pool({ connectionString: parsed.toString(), max: 12 });
    const version = Number((await owner.query("SHOW server_version_num")).rows[0].server_version_num);
    if (version < 160000 || version >= 170000) throw new Error(`Payment activation tests require PostgreSQL 16, got ${version}`);
    for (const migration of migrations) await owner.query(migration);
    await owner.query(`CREATE ROLE ${qi(runtimeLogin)} LOGIN PASSWORD '${runtimePassword}'`);
    await owner.query(`GRANT downtown_u_runtime TO ${qi(runtimeLogin)}`);
    const runtimeUrl = new URL(parsed);
    runtimeUrl.username = runtimeLogin;
    runtimeUrl.password = runtimePassword;
    runtimeConnectionString = runtimeUrl.toString();
    runtime = new Pool({ connectionString: runtimeConnectionString, max: 20 });
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

  it("creates pending student, canonical purchase, exact authoritative paidAt, one grant, and completed claim", async () => {
    const claim = await claimed("EVT_VALID");
    await expect(new PostgresPaymentActivationStore(runtime).activate(claim, command("VALID"))).resolves.toEqual({ outcome: "activated" });
    const row = (await owner.query(`SELECT s.eligibility_status,s.credit_balance,p.*,t.delta,t.resulting_balance,t.metadata
      FROM public.downtown_u_students s JOIN public.downtown_u_plan_purchases p ON p.student_id=s.id
      JOIN public.downtown_u_credit_transactions t ON t.purchase_id=p.id WHERE p.source_event_id='EVT_VALID'`)).rows[0];
    expect(row).toMatchObject({ eligibility_status: "pending", credit_balance: 5, plan_id: "flex-5", credits_granted: 5,
      price_cents: 6000, square_payment_id: "PAY_VALID", square_order_id: "ORDER_VALID",
      authoritative_paid_at: "2026-08-04T12:00:00.123456789Z", delta: 5, resulting_balance: 5,
      metadata: { currency: "USD", locationId: "LOC_1" } });
    expect((await owner.query("SELECT status,claim_token FROM public.downtown_u_webhook_events WHERE square_event_id='EVT_VALID'")).rows[0])
      .toEqual({ status: "completed", claim_token: null });
    expect(Object.keys(row.metadata).sort()).toEqual(["currency", "locationId"]);
  });

  it("activates a customer-only authoritative identity with safe defaults and one exact grant", async () => {
    const claim = await claimed("EVT_CUSTOMER_ONLY");
    const trusted = command("CUSTOMER_ONLY", { email: undefined, phone: undefined });
    await expect(new PostgresPaymentActivationStore(runtime).activate(claim, trusted))
      .resolves.toEqual({ outcome: "activated" });
    const result = await owner.query(`SELECT s.normalized_email,s.normalized_phone,s.square_customer_id,
      s.eligibility_status,s.credit_balance,p.credits_granted,p.authoritative_normalized_email,
      p.authoritative_normalized_phone,p.authoritative_square_customer_id,t.delta,t.resulting_balance,e.status
      FROM public.downtown_u_students s
      JOIN public.downtown_u_plan_purchases p ON p.student_id=s.id
      JOIN public.downtown_u_credit_transactions t ON t.purchase_id=p.id
      JOIN public.downtown_u_webhook_events e ON e.square_event_id=p.source_event_id
      WHERE p.source_event_id='EVT_CUSTOMER_ONLY'`);
    expect(result.rows).toEqual([{
      normalized_email: null, normalized_phone: null, square_customer_id: "CUSTOMER_CUSTOMER_ONLY",
      authoritative_normalized_email: null, authoritative_normalized_phone: null,
      authoritative_square_customer_id: "CUSTOMER_CUSTOMER_ONLY",
      eligibility_status: "pending", credit_balance: 5, credits_granted: 5,
      delta: 5, resulting_balance: 5, status: "completed",
    }]);
    expect((await owner.query("SELECT count(*)::int count FROM public.downtown_u_plan_purchases WHERE source_event_id='EVT_CUSTOMER_ONLY'")).rows[0].count).toBe(1);
    expect((await owner.query("SELECT count(*)::int count FROM public.downtown_u_credit_transactions WHERE source_id='PAY_CUSTOMER_ONLY'")).rows[0].count).toBe(1);
  });

  it("rolls student, purchase, grant, and completion back when a final ledger constraint fails", async () => {
    const claim = await claimed("EVT_ROLLBACK");
    const blockerStudent = (await owner.query(
      "INSERT INTO public.downtown_u_students(normalized_email) VALUES ('rollback-blocker@example.com') RETURNING id",
    )).rows[0].id;
    const blockerPurchase = (await owner.query(`INSERT INTO public.downtown_u_plan_purchases
      (student_id,plan_id,credits_granted,price_cents,square_payment_id,square_order_id,source_event_id,paid_at)
      VALUES ($1,'flex-5',5,6000,'PAY_ROLLBACK_BLOCKER','ORDER_ROLLBACK_BLOCKER','EVT_ROLLBACK_BLOCKER',now()) RETURNING id`,
    [blockerStudent])).rows[0].id;
    await owner.query(`INSERT INTO public.downtown_u_credit_transactions
      (student_id,purchase_id,delta,resulting_balance,transaction_type,reason,idempotency_key,
       actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,5,5,'purchase_grant','owner fixture','rollback-blocker-grant',
       'system','test','square_payment','PAY_ROLLBACK')`, [blockerStudent, blockerPurchase]);
    const before = await counts();
    await expect(new PostgresPaymentActivationStore(runtime).activate(claim, command("ROLLBACK")))
      .rejects.toBeInstanceOf(PaymentActivationConflictError);
    expect(await counts()).toEqual(before);
    expect(await counts("normalized_email='rollback@example.com'")).toEqual([0, before[1], before[2]]);
    expect((await owner.query("SELECT status,claim_token::text FROM public.downtown_u_webhook_events WHERE square_event_id='EVT_ROLLBACK'")).rows[0])
      .toEqual({ status: "processing", claim_token: claim.claimToken });
  });

  it("rejects a stale token before any local effect", async () => {
    const claim = await claimed("EVT_STALE");
    const before = await counts();
    await expect(new PostgresPaymentActivationStore(runtime).activate(
      { ...claim, claimToken: "00000000-0000-0000-0000-000000000000" }, command("STALE"),
    )).rejects.toBeInstanceOf(PaymentActivationConflictError);
    expect(await counts()).toEqual(before);
    expect((await owner.query("SELECT count(*)::int count FROM public.downtown_u_students WHERE normalized_email='stale@example.com'")).rows[0].count).toBe(0);
  });

  it("rejects malformed trusted inputs inside the database function before any effect", async () => {
    const claim = await claimed("EVT_DB_VALIDATION");
    const trusted = command("DB_VALIDATION");
    const sql = `SELECT * FROM public.downtown_u_activate_verified_payment(
      $1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`;
    const valid: unknown[] = [
      claim.eventId, claim.claimToken, claim.resourceId, trusted.paymentId, trusted.orderId,
      trusted.planId, 5, trusted.amount, trusted.currency, trusted.locationId, trusted.paidAt,
      trusted.email, trusted.phone, trusted.squareCustomerId,
    ];
    for (const [index, invalid] of [[2, "PAY_OTHER"], [6, 40], [7, 1], [11, "Not-Normalized@example.com"]] as const) {
      const values = [...valid];
      values[index] = invalid;
      await expect(runtime.query(sql, values)).rejects.toSatisfy((error: unknown) => dbCode(error) === "P0001");
    }
    expect((await owner.query("SELECT count(*)::int count FROM public.downtown_u_plan_purchases WHERE source_event_id=$1", [claim.eventId])).rows[0].count).toBe(0);
    expect((await owner.query("SELECT status,claim_token::text FROM public.downtown_u_webhook_events WHERE square_event_id=$1", [claim.eventId])).rows[0])
      .toEqual({ status: "processing", claim_token: claim.claimToken });
  });

  it("gives one claim/grant under concurrent replay and returns a stable completed duplicate", async () => {
    const eventStore = new PostgresWebhookEventStore(runtime);
    const results = await Promise.all(Array.from({ length: 12 }, () => eventStore.claim("EVT_CONCURRENT", "payment.updated", "c".repeat(64))));
    expect(results.filter((result) => result.outcome === "claimed")).toHaveLength(1);
    const winner = results.find((result) => result.outcome === "claimed");
    if (!winner || winner.outcome !== "claimed") throw new Error("missing winner");
    await new PostgresPaymentActivationStore(runtime).activate({
      eventId: "EVT_CONCURRENT", eventType: "payment.updated", bodyHash: "c".repeat(64), resourceId: "PAY_CONCURRENT",
      claimToken: winner.claimToken, attemptCount: 1,
    }, command("CONCURRENT"));
    await expect(eventStore.claim("EVT_CONCURRENT", "payment.updated", "c".repeat(64))).resolves.toMatchObject({ outcome: "duplicate" });
    expect((await owner.query("SELECT count(*)::int count FROM public.downtown_u_plan_purchases WHERE square_payment_id='PAY_CONCURRENT'")).rows[0].count).toBe(1);
    expect((await owner.query("SELECT count(*)::int count FROM public.downtown_u_credit_transactions WHERE source_id='PAY_CONCURRENT'")).rows[0].count).toBe(1);
  });

  it("serializes two distinct events racing the same payment and grants exactly once", async () => {
    const first = { ...(await claimed("EVT_RACE_A")), resourceId: "PAY_RACE" };
    const second = { ...(await claimed("EVT_RACE_B")), resourceId: "PAY_RACE" };
    const trusted = command("RACE");
    const stores = [new PostgresPaymentActivationStore(runtime), new PostgresPaymentActivationStore(runtime)];
    const results = await Promise.allSettled([
      stores[0].activate(first, trusted), stores[1].activate(second, trusted),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: expect.any(PaymentActivationConflictError) });
    expect((await owner.query("SELECT count(*)::int count FROM public.downtown_u_plan_purchases WHERE square_payment_id='PAY_RACE'")).rows[0].count).toBe(1);
    expect((await owner.query("SELECT count(*)::int count FROM public.downtown_u_credit_transactions WHERE source_id='PAY_RACE'")).rows[0].count).toBe(1);
    expect((await owner.query("SELECT count(*)::int count FROM public.downtown_u_webhook_events WHERE square_event_id IN ('EVT_RACE_A','EVT_RACE_B') AND status='completed'")).rows[0].count).toBe(1);
  });

  it("fails closed for payment, order, event/body, and contact conflicts without extra grants", async () => {
    await expect(new PostgresWebhookEventStore(runtime).claim("EVT_VALID", "payment.updated", "f".repeat(64))).rejects.toBeInstanceOf(WebhookEventConflictError);
    const before = await counts();
    for (const [id, overrides] of [
      ["CONFLICT_PAYMENT", { paymentId: "PAY_VALID" }],
      ["CONFLICT_ORDER", { orderId: "ORDER_VALID" }],
    ] as const) {
      const claim = await claimed(`EVT_${id}`);
      await expect(new PostgresPaymentActivationStore(runtime).activate(claim, command(id, overrides)))
        .rejects.toBeInstanceOf(PaymentActivationConflictError);
    }
    const contactClaim = await claimed("EVT_CONTACT");
    await expect(new PostgresPaymentActivationStore(runtime).activate(contactClaim, command("CONTACT", {
      email: "valid@example.com", phone: "+14155559999", squareCustomerId: "CUSTOMER_CONTACT",
    }))).rejects.toBeInstanceOf(PaymentActivationConflictError);
    expect(await counts()).toEqual(before);
  });

  it("fails closed across every authoritative purchase signature dimension and preserves exact replay", async () => {
    const eventStore = new PostgresWebhookEventStore(runtime);
    const store = new PostgresPaymentActivationStore(runtime);
    const baseClaim = await claimed("EVT_SIGNATURE");
    const baseCommand = command("SIGNATURE");
    await expect(store.activate(baseClaim, baseCommand)).resolves.toEqual({ outcome: "activated" });
    await expect(eventStore.claim("EVT_SIGNATURE", "payment.updated", baseClaim.bodyHash))
      .resolves.toMatchObject({ outcome: "duplicate" });

    const immutable = async () => (await owner.query(`SELECT
      s.id,s.normalized_email,s.normalized_phone,s.square_customer_id,s.eligibility_status,s.credit_balance,
      p.id AS purchase_id,p.plan_id,p.credits_granted,p.price_cents,p.currency,p.square_payment_id,
      p.square_order_id,p.source_event_id,p.authoritative_paid_at,p.status,p.refunded_credits,
      t.id AS grant_id,t.delta,t.resulting_balance,t.idempotency_key,t.actor_id,t.source_id,t.metadata
      FROM public.downtown_u_plan_purchases p
      JOIN public.downtown_u_students s ON s.id=p.student_id
      JOIN public.downtown_u_credit_transactions t ON t.purchase_id=p.id
      WHERE p.square_payment_id='PAY_SIGNATURE'`)).rows;
    const original = await immutable();
    const originalCounts = await counts();

    const collisions: Array<[string, Partial<TrustedEnrollmentCommand>, Partial<Awaited<ReturnType<typeof claimed>>>]> = [
      ["PLAN", { planId: "scholar-10", amount: 11000 }, {}],
      ["UNKNOWN_PLAN", { planId: "unknown-plan" as TrustedEnrollmentCommand["planId"] }, {}],
      ["AMOUNT", { amount: 5999 }, {}],
      ["CURRENCY", { currency: "CAD" as TrustedEnrollmentCommand["currency"] }, {}],
      ["PAID_AT", { paidAt: "2026-08-04T12:00:01.123456789Z" }, {}],
      ["LOCATION", { locationId: "LOC_2" }, {}],
      ["SOURCE_EVENT", {}, {}],
      ["PAYMENT_ID", { paymentId: "PAY_SIGNATURE_CHANGED" }, { resourceId: "PAY_SIGNATURE_CHANGED" }],
      ["ORDER_ID", { orderId: "ORDER_SIGNATURE_CHANGED" }, {}],
    ];
    for (const [id, overrides, claimOverrides] of collisions) {
      const collisionClaim = {
        ...(await claimed(`EVT_SIGNATURE_${id}`)),
        resourceId: baseCommand.paymentId,
        ...claimOverrides,
      };
      await expect(store.activate(collisionClaim, { ...baseCommand, ...overrides }))
        .rejects.toBeInstanceOf(PaymentActivationConflictError);
      expect(await immutable()).toEqual(original);
      expect(await counts()).toEqual(originalCounts);
      expect((await owner.query(
        "SELECT status,claim_token::text FROM public.downtown_u_webhook_events WHERE square_event_id=$1",
        [collisionClaim.eventId],
      )).rows[0]).toEqual({ status: "processing", claim_token: collisionClaim.claimToken });
    }

    await expect(eventStore.claim("EVT_SIGNATURE", "payment.updated", "0".repeat(64)))
      .rejects.toBeInstanceOf(WebhookEventConflictError);
    expect(await immutable()).toEqual(original);
    expect(await counts()).toEqual(originalCounts);
    expect((await owner.query("SELECT status FROM public.downtown_u_webhook_events WHERE square_event_id='EVT_SIGNATURE'")).rows[0].status).toBe("completed");
  });

  it("checks the full signature on the existing-purchase duplicate path before stable exact completion", async () => {
    const claim = await claimed("EVT_EXISTING_SIGNATURE");
    const trusted = command("EXISTING_SIGNATURE");
    const student = (await owner.query(`INSERT INTO public.downtown_u_students
      (normalized_email,normalized_phone,square_customer_id) VALUES ($1,$2,$3) RETURNING id`,
    [trusted.email, trusted.phone, trusted.squareCustomerId])).rows[0];
    const purchase = (await owner.query(`INSERT INTO public.downtown_u_plan_purchases
      (student_id,plan_id,credits_granted,price_cents,currency,square_payment_id,square_order_id,
       source_event_id,paid_at,authoritative_paid_at,authoritative_normalized_email,
       authoritative_normalized_phone,authoritative_square_customer_id)
      VALUES ($1,'flex-5',5,6000,'USD',$2,$3,$4,$5::timestamptz,$6::text,$7,$8,$9) RETURNING id`,
    [student.id, trusted.paymentId, trusted.orderId, claim.eventId, trusted.paidAt, trusted.paidAt,
      trusted.email, trusted.phone, trusted.squareCustomerId])).rows[0];
    await owner.query(`INSERT INTO public.downtown_u_credit_transactions
      (student_id,purchase_id,delta,resulting_balance,transaction_type,reason,idempotency_key,
       actor_type,actor_id,source_type,source_id,metadata)
      VALUES ($1,$2,5,5,'purchase_grant','verified Square payment',$3,
       'square_webhook',$4,'square_payment',$5,$6::jsonb)`,
    [student.id, purchase.id, `purchase_grant:${trusted.paymentId}`, claim.eventId, trusted.paymentId,
      JSON.stringify({ currency: trusted.currency, locationId: trusted.locationId })]);

    const snapshot = async () => (await owner.query(`SELECT s.credit_balance,p.*,t.*
      FROM public.downtown_u_students s
      JOIN public.downtown_u_plan_purchases p ON p.student_id=s.id
      JOIN public.downtown_u_credit_transactions t ON t.purchase_id=p.id
      WHERE p.id=$1`, [purchase.id])).rows;
    const original = await snapshot();
    const originalCounts = await counts();
    for (const overrides of [
      { planId: "scholar-10" as const, amount: 11000 },
      { amount: 5999 },
      { currency: "CAD" as TrustedEnrollmentCommand["currency"] },
      { paidAt: "2026-08-04T12:00:01.123456789Z" },
      { locationId: "LOC_2" },
      { email: undefined },
      { email: "changed@example.com" },
      { phone: undefined },
      { phone: "+14155559876" },
      { squareCustomerId: undefined },
      { squareCustomerId: "CUSTOMER_CHANGED" },
    ]) {
      await expect(new PostgresPaymentActivationStore(runtime).activate(claim, { ...trusted, ...overrides }))
        .rejects.toBeInstanceOf(PaymentActivationConflictError);
      expect(await snapshot()).toEqual(original);
      expect(await counts()).toEqual(originalCounts);
      expect((await owner.query("SELECT status FROM public.downtown_u_webhook_events WHERE square_event_id=$1", [claim.eventId])).rows[0].status).toBe("processing");
    }
    await expect(new PostgresPaymentActivationStore(runtime).activate(claim, trusted))
      .resolves.toEqual({ outcome: "duplicate" });
    expect(await snapshot()).toEqual(original);
    expect(await counts()).toEqual(originalCounts);
    expect((await owner.query("SELECT status,claim_token FROM public.downtown_u_webhook_events WHERE square_event_id=$1", [claim.eventId])).rows[0])
      .toEqual({ status: "completed", claim_token: null });
  });

  it("fails closed for historical purchases whose contact signature is absent", async () => {
    const claim = await claimed("EVT_HISTORICAL_CONTACT");
    const trusted = command("HISTORICAL_CONTACT", { phone: "+14155550201" });
    await seedExistingPurchase(claim, trusted, false);
    const before = await counts();
    await expect(new PostgresPaymentActivationStore(runtime).activate(claim, trusted))
      .rejects.toBeInstanceOf(PaymentActivationConflictError);
    expect(await counts()).toEqual(before);
    expect((await owner.query("SELECT status,claim_token::text FROM public.downtown_u_webhook_events WHERE square_event_id=$1", [claim.eventId])).rows[0])
      .toEqual({ status: "processing", claim_token: claim.claimToken });
  });

  it("requires exact explicit/null replay of a customer-only purchase signature", async () => {
    const claim = await claimed("EVT_CUSTOMER_EXACT");
    const trusted = command("CUSTOMER_EXACT", { email: undefined, phone: undefined });
    const seeded = await seedExistingPurchase(claim, trusted, true);
    const snapshot = async () => (await owner.query(`SELECT s.credit_balance,p.*,t.*
      FROM public.downtown_u_students s JOIN public.downtown_u_plan_purchases p ON p.student_id=s.id
      JOIN public.downtown_u_credit_transactions t ON t.purchase_id=p.id WHERE p.id=$1`,
    [seeded.purchase.id])).rows;
    const original = await snapshot();
    const before = await counts();
    for (const overrides of [{ email: "added@example.com" }, { phone: "+14155550123" }]) {
      await expect(new PostgresPaymentActivationStore(runtime).activate(claim, { ...trusted, ...overrides }))
        .rejects.toBeInstanceOf(PaymentActivationConflictError);
      expect(await snapshot()).toEqual(original);
      expect(await counts()).toEqual(before);
      expect((await owner.query("SELECT status FROM public.downtown_u_webhook_events WHERE square_event_id=$1", [claim.eventId])).rows[0].status)
        .toBe("processing");
    }
    await expect(new PostgresPaymentActivationStore(runtime).activate(claim, trusted))
      .resolves.toEqual({ outcome: "duplicate" });
    expect(await snapshot()).toEqual(original);
    expect(await counts()).toEqual(before);
  });

  it("allows a distinct purchase to enrich one compatible customer-only student", async () => {
    const first = await claimed("EVT_MULTI_A");
    const second = await claimed("EVT_MULTI_B");
    const customer = { squareCustomerId: "CUSTOMER_MULTI" };
    const store = new PostgresPaymentActivationStore(runtime);
    await store.activate(first, command("MULTI_A", { ...customer, email: undefined, phone: undefined }));
    await store.activate(second, command("MULTI_B", {
      ...customer, email: "multi@example.com", phone: "+14155550123",
      planId: "scholar-10", amount: 11000,
    }));
    const student = (await owner.query("SELECT id,credit_balance FROM public.downtown_u_students WHERE normalized_email='multi@example.com'")).rows[0];
    expect(student.credit_balance).toBe(15);
    expect((await owner.query("SELECT count(*)::int count FROM public.downtown_u_plan_purchases WHERE student_id=$1", [student.id])).rows[0].count).toBe(2);
    expect((await owner.query("SELECT count(*)::int count FROM public.downtown_u_credit_transactions WHERE student_id=$1 AND transaction_type='purchase_grant'", [student.id])).rows[0].count).toBe(2);
  });

  it("serializes activation with exact and partially-overlapping student upserts", async () => {
    const activationStore = new PostgresPaymentActivationStore(runtime);
    const studentStore = new PostgresStudentAccountStore(runtime);

    // Repeated independent races exercise both possible lock acquisition orders.
    for (let iteration = 0; iteration < 12; iteration += 1) {
      const id = `ACTIVATION_UPSERT_${iteration}`;
      const claim = await claimed(`EVT_${id}`);
      const trusted = command(id, {
        email: `activation-upsert-${iteration}@example.com`,
        phone: `+1415556${String(iteration).padStart(4, "0")}`,
        squareCustomerId: `CUSTOMER_ACTIVATION_UPSERT_${iteration}`,
      });

      const [activation, exact, partial] = await Promise.all([
        activationStore.activate(claim, trusted),
        studentStore.upsert({
          normalizedEmail: trusted.email!, normalizedPhone: trusted.phone!,
          squareCustomerId: trusted.squareCustomerId!,
        }),
        studentStore.upsert({ squareCustomerId: trusted.squareCustomerId! }),
      ]);

      expect(activation).toEqual({ outcome: "activated" });
      expect(exact.id).toBe(partial.id);
      const result = await owner.query(`SELECT s.id,s.normalized_email,s.normalized_phone,
        s.square_customer_id,s.credit_balance,count(DISTINCT p.id)::int AS purchases,
        count(DISTINCT t.id)::int AS grants,bool_and(e.status='completed') AS completed,
        bool_or(e.status='rejected') AS rejected
        FROM public.downtown_u_students s
        LEFT JOIN public.downtown_u_plan_purchases p ON p.student_id=s.id
        LEFT JOIN public.downtown_u_credit_transactions t
          ON t.purchase_id=p.id AND t.transaction_type='purchase_grant'
        LEFT JOIN public.downtown_u_webhook_events e ON e.square_event_id=p.source_event_id
        WHERE s.normalized_email=$1 OR s.normalized_phone=$2 OR s.square_customer_id=$3
        GROUP BY s.id`, [trusted.email, trusted.phone, trusted.squareCustomerId]);
      expect(result.rows).toEqual([{
        id: exact.id, normalized_email: trusted.email, normalized_phone: trusted.phone,
        square_customer_id: trusted.squareCustomerId, credit_balance: 5,
        purchases: 1, grants: 1, completed: true, rejected: false,
      }]);
    }
  }, 30_000);

  it("fails closed when one activation identity spans multiple existing students", async () => {
    const trusted = command("MULTI_ROW_COLLISION", {
      email: "multi-row-collision@example.com",
      phone: "+14155560999",
      squareCustomerId: "CUSTOMER_MULTI_ROW_COLLISION",
    });
    await owner.query(
      "INSERT INTO public.downtown_u_students(normalized_email) VALUES ($1)",
      [trusted.email],
    );
    await owner.query(
      "INSERT INTO public.downtown_u_students(normalized_phone,square_customer_id) VALUES ($1,$2)",
      [trusted.phone, trusted.squareCustomerId],
    );
    const claim = await claimed("EVT_MULTI_ROW_COLLISION");
    const before = await counts();

    await expect(new PostgresPaymentActivationStore(runtime).activate(claim, trusted))
      .rejects.toBeInstanceOf(PaymentActivationConflictError);
    expect(await counts()).toEqual(before);
    expect((await owner.query(
      "SELECT status,claim_token::text FROM public.downtown_u_webhook_events WHERE square_event_id=$1",
      [claim.eventId],
    )).rows[0]).toEqual({ status: "processing", claim_token: claim.claimToken });
    expect((await owner.query(
      "SELECT count(*)::int count FROM public.downtown_u_plan_purchases WHERE source_event_id=$1",
      [claim.eventId],
    )).rows[0].count).toBe(0);
  });

  it("requires the low-privilege direct runtime identity and denies privilege attacks", async () => {
    const claim = await claimed("EVT_OWNER_DENIED");
    await expect(new PostgresPaymentActivationStore(owner).activate(claim, command("OWNER_DENIED"))).rejects.toThrow(/unsafe/i);
    const seededStudent = (await owner.query(
      "INSERT INTO public.downtown_u_students(normalized_email) VALUES ('grantless-owner-seed@example.com') RETURNING id",
    )).rows[0].id;
    const grantlessPurchase = (await owner.query(`INSERT INTO public.downtown_u_plan_purchases
      (student_id,plan_id,credits_granted,price_cents,square_payment_id,square_order_id,source_event_id,paid_at)
      VALUES ($1,'flex-5',5,6000,'PAY_GRANTLESS','ORDER_GRANTLESS','EVT_GRANTLESS',now()) RETURNING id`,
    [seededStudent])).rows[0].id;
    await expect(runtime.query(`INSERT INTO public.downtown_u_plan_purchases
      (student_id,plan_id,credits_granted,price_cents,square_payment_id,square_order_id,source_event_id,paid_at)
      VALUES ($1,'flex-5',5,6000,'PAY_FORGED','ORDER_FORGED','EVT_FORGED',now())`, [seededStudent]))
      .rejects.toSatisfy((error: unknown) => dbCode(error) === "42501");
    await expect(runtime.query(`INSERT INTO public.downtown_u_credit_transactions
      (student_id,purchase_id,delta,resulting_balance,transaction_type,reason,idempotency_key,
       actor_type,actor_id,source_type,source_id)
      VALUES ($1,$2,5,5,'purchase_grant','forged','forged-grant',
       'square_webhook','EVT_FORGED','square_payment','PAY_FORGED')`, [seededStudent, grantlessPurchase]))
      .rejects.toThrow(/payment activation rejected/i);
    expect((await owner.query("SELECT count(*)::int count FROM public.downtown_u_credit_transactions WHERE purchase_id=$1", [grantlessPurchase])).rows[0].count).toBe(0);
    for (const sql of [
      "SELECT * FROM public.downtown_u_webhook_events",
      "UPDATE public.downtown_u_students SET eligibility_status='approved'",
      "UPDATE public.downtown_u_students SET credit_balance=999",
      "CREATE TABLE public.downtown_u_activation_attack(id int)",
      "UPDATE public.downtown_u_plan_purchases SET authoritative_paid_at='2026-01-01T00:00:00Z'",
      "UPDATE public.downtown_u_plan_purchases SET authoritative_normalized_email='attack@example.com'",
      "UPDATE public.downtown_u_plan_purchases SET authoritative_normalized_phone='+14155550123'",
      "UPDATE public.downtown_u_plan_purchases SET authoritative_square_customer_id='CUSTOMER_ATTACK'",
      "SET ROLE pg_database_owner",
      "SELECT public.downtown_u_require_trusted_purchase_grant()",
    ]) await expect(runtime.query(sql)).rejects.toSatisfy((error: unknown) => dbCode(error) === "42501");
    for (const [column, value] of [
      ["authoritative_normalized_email", "owner-attack@example.com"],
      ["authoritative_normalized_phone", "+14155550123"],
      ["authoritative_square_customer_id", "CUSTOMER_OWNER_ATTACK"],
    ]) {
      await expect(owner.query(`UPDATE public.downtown_u_plan_purchases SET ${column}=$1 WHERE square_payment_id='PAY_VALID'`, [value]))
        .rejects.toSatisfy((error: unknown) => dbCode(error) === "P0001");
    }
    await expect(runtime.query(`INSERT INTO public.downtown_u_students
      (normalized_email,normalized_phone,square_customer_id) VALUES (NULL,NULL,NULL)`))
      .rejects.toSatisfy((error: unknown) => dbCode(error) === "42501");
    for (const sql of [
      "INSERT INTO public.downtown_u_students(normalized_email,eligibility_status) VALUES ('attack@example.com','approved')",
      "INSERT INTO public.downtown_u_students(normalized_email,credit_balance) VALUES ('attack@example.com',999)",
    ]) await expect(runtime.query(sql)).rejects.toSatisfy((error: unknown) => dbCode(error) === "42501");
  });

  it("denies direct identity DML and validates bounded Square customer IDs through the upsert capability", async () => {
    await expect(runtime.query(
      "INSERT INTO public.downtown_u_students(normalized_email) VALUES ('direct-valid@example.com')",
    )).rejects.toSatisfy((error: unknown) => dbCode(error) === "42501");
    await expect(runtime.query(
      "UPDATE public.downtown_u_students SET normalized_email='direct-changed@example.com' WHERE normalized_email='valid@example.com'",
    )).rejects.toSatisfy((error: unknown) => dbCode(error) === "42501");
    for (const invalid of ["", " ", "customer!symbol", "X".repeat(193)]) {
      await expect(runtime.query(
        "INSERT INTO public.downtown_u_students(normalized_email,square_customer_id) VALUES ($1,$2)",
        [`invalid-${invalid.length}@example.com`, invalid],
      )).rejects.toSatisfy((error: unknown) => dbCode(error) === "42501");
      await expect(runtime.query(
        "UPDATE public.downtown_u_students SET square_customer_id=$1 WHERE normalized_email='valid@example.com'",
        [invalid],
      )).rejects.toSatisfy((error: unknown) => dbCode(error) === "42501");
      await expect(runtime.query(
        "SELECT * FROM public.downtown_u_upsert_pending_student($1,$2,$3)",
        [`invalid-${invalid.length}@example.com`, null, invalid],
      )).rejects.toSatisfy((error: unknown) => dbCode(error) === "22023");
    }
    await expect(runtime.query(
      "SELECT * FROM public.downtown_u_upsert_pending_student(NULL,NULL,NULL)",
    )).rejects.toSatisfy((error: unknown) => dbCode(error) === "22023");

    const customerOnly = await runtime.query(
      "SELECT * FROM public.downtown_u_upsert_pending_student(NULL,NULL,$1)",
      ["CUSTOMER_UPSERT_CAPABILITY"],
    );
    expect(customerOnly.rows).toHaveLength(1);
    expect(customerOnly.rows[0]).toMatchObject({
      normalized_email: null, normalized_phone: null,
      square_customer_id: "CUSTOMER_UPSERT_CAPABILITY", eligibility_status: "pending",
    });
    for (const values of [
      ["Not-Normalized@example.com", null, null],
      [null, "4155550123", null],
    ]) await expect(runtime.query(
      "SELECT * FROM public.downtown_u_upsert_pending_student($1,$2,$3)", values,
    )).rejects.toSatisfy((error: unknown) => dbCode(error) === "22023");
  });

  it("makes permanent rejection terminal, token-bound, and replay-stable", async () => {
    const store = new PostgresWebhookEventStore(runtime);
    const claim = await claimed("EVT_REJECTED");
    await expect(store.reject(
      claim.eventId, "00000000-0000-0000-0000-000000000000",
      "payment_validation_failed", "Authoritative payment validation failed",
    )).rejects.toBeInstanceOf(WebhookEventTransitionError);
    await store.reject(claim.eventId, claim.claimToken, "payment_validation_failed", "Authoritative payment validation failed");
    await expect(store.reject(claim.eventId, claim.claimToken, "payment_validation_failed", "Authoritative payment validation failed"))
      .rejects.toBeInstanceOf(WebhookEventTransitionError);
    await expect(store.claim(claim.eventId, claim.eventType, claim.bodyHash))
      .resolves.toEqual({ outcome: "duplicate", attemptCount: 1 });
    await expect(store.claim(claim.eventId, claim.eventType, "0".repeat(64)))
      .rejects.toBeInstanceOf(WebhookEventConflictError);
    expect((await owner.query(
      "SELECT status,attempt_count,claim_token,failure_code,failure_detail FROM public.downtown_u_webhook_events WHERE square_event_id=$1",
      [claim.eventId],
    )).rows[0]).toEqual({
      status: "rejected", attempt_count: 1, claim_token: null,
      failure_code: "payment_validation_failed", failure_detail: "Authoritative payment validation failed",
    });
  });

  it("keeps transient failure retryable with a new token and incremented attempt", async () => {
    const store = new PostgresWebhookEventStore(runtime);
    const claim = await claimed("EVT_TRANSIENT");
    await store.fail(claim.eventId, claim.claimToken, "square_temporarily_unavailable", "Square validation temporarily unavailable");
    const replay = await store.claim(claim.eventId, claim.eventType, claim.bodyHash);
    expect(replay).toMatchObject({ outcome: "claimed", attemptCount: 2 });
    if (replay.outcome !== "claimed") throw new Error("Expected retryable claim");
    expect(replay.claimToken).not.toBe(claim.claimToken);
  });
});
