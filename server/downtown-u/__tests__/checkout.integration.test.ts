import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TrustedEnrollmentCommand } from "../enrollment-service";
import { PostgresPaymentActivationStore } from "../postgres-payment-activation-store";
import {
  CheckoutConflictError,
  CheckoutRateLimitError,
  PostgresCheckoutStore,
} from "../postgres-checkout-store";
import { assertDowntownUJobRuntimeIdentity } from "../postgres-job-runtime-identity";
import { assertDowntownURuntimeIdentity } from "../postgres-runtime-identity";
import { PostgresWebhookEventStore } from "../postgres-webhook-event-store";

const baseUrl = process.env.TEST_DATABASE_URL;
const run = baseUrl ? describe : describe.skip;
const suffix = `${process.pid}_${Date.now()}`;
const databaseName = `downtown_u_checkout_${suffix}`;
const runtimeLogin = `downtown_u_checkout_web_${suffix}`;
const jobLogin = `downtown_u_checkout_job_${suffix}`;
const password = randomUUID().replaceAll("-", "");
const migrations = [
  "202608040001_downtown_u_phase1.sql",
  "202608040002_downtown_u_webhook_events.sql",
  "202608040003_downtown_u_payment_activation.sql",
  "202608040004_downtown_u_refund_activation.sql",
  "202608040005_downtown_u_auth.sql",
  "202608040006_downtown_u_student_portal.sql",
  "202608040007_downtown_u_checkout.sql",
  "202608040008_downtown_u_kitchen_outbox.sql",
].map((name) => readFileSync(resolve(process.cwd(), "db/migrations", name), "utf8"));
let admin: Pool;
let owner: Pool;
let runtime: Pool;
let jobs: Pool;
let runtimeUrl: string;
const qi = (value: string) => `"${value.replaceAll('"', '""')}"`;
const actor = (tag: string) => createHash("sha256").update(tag).digest();
const key = (tag: string) => createHash("sha256").update(tag).digest("base64url").slice(0, 24);
const dbCode = (error: unknown) => typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;

function payment(tag: string, email: string, orderId: string, paymentId: string): TrustedEnrollmentCommand {
  return {
    paymentId, orderId, planId: "flex-5", amount: 6000, currency: "USD", locationId: "LOC_1",
    email, squareCustomerId: `CUSTOMER_${tag}`, paidAt: "2026-08-05T12:00:00.123456789Z",
    eligibility: "pending",
  };
}
async function activate(tag: string, command: TrustedEnrollmentCommand) {
  const eventId = `EVT_CHECKOUT_${tag}`;
  const bodyHash = createHash("sha256").update(tag).digest("hex");
  const claim = await new PostgresWebhookEventStore(runtime).claim(eventId, "payment.updated", bodyHash);
  if (claim.outcome !== "claimed") throw new Error("expected webhook claim");
  return new PostgresPaymentActivationStore(runtime).activate({
    eventId, eventType: "payment.updated", bodyHash, resourceId: command.paymentId,
    claimToken: claim.claimToken, attemptCount: claim.attemptCount,
  }, command);
}
async function newAttempt(tag: string, email = `${tag}@example.edu`, requestActor = actor(tag)) {
  return new PostgresCheckoutStore(runtime).begin({
    idempotencyKey: key(tag), planId: "flex-5", normalizedEmail: email, requestActor,
  });
}
async function withIds(tag: string, email = `${tag}@example.edu`) {
  const store = new PostgresCheckoutStore(runtime);
  let attempt = await newAttempt(tag, email);
  const orderId = `ORDER_${tag}`;
  const paymentId = `PAY_${tag}`;
  attempt = await store.recordOrder(attempt.id, orderId);
  attempt = await store.recordPayment(attempt.id, paymentId);
  return { store, attempt, orderId, paymentId };
}

run.sequential("embedded checkout capabilities on stock PostgreSQL 16", () => {
  beforeAll(async () => {
    const parsed = new URL(baseUrl!);
    const local = parsed.hostname === "" || ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    if (!local && !/(test|testing|disposable)/i.test(parsed.pathname)) throw new Error("unsafe TEST_DATABASE_URL");
    admin = new Pool({ connectionString: baseUrl, max: 2 });
    await admin.query(`CREATE DATABASE ${qi(databaseName)}`);
    parsed.pathname = `/${databaseName}`;
    owner = new Pool({ connectionString: parsed.toString(), max: 30 });
    const version = Number((await owner.query("SHOW server_version_num")).rows[0].server_version_num);
    if (version < 160000 || version >= 170000) throw new Error(`PostgreSQL 16 required, got ${version}`);
    for (const migration of migrations) await owner.query(migration);
    await admin.query(`CREATE ROLE ${qi(runtimeLogin)} LOGIN PASSWORD '${password}'`);
    await admin.query(`CREATE ROLE ${qi(jobLogin)} LOGIN PASSWORD '${password}'`);
    await admin.query(`GRANT downtown_u_runtime TO ${qi(runtimeLogin)}`);
    await admin.query(`GRANT downtown_u_jobs TO ${qi(jobLogin)}`);
    const web = new URL(parsed); web.username = runtimeLogin; web.password = password; runtimeUrl = web.toString();
    runtime = new Pool({ connectionString: runtimeUrl, max: 30 });
    const job = new URL(parsed); job.username = jobLogin; job.password = password;
    jobs = new Pool({ connectionString: job.toString(), max: 4 });
    await assertDowntownURuntimeIdentity(runtime as never);
    await assertDowntownUJobRuntimeIdentity(jobs as never);
  }, 30_000);

  afterAll(async () => {
    await runtime?.end(); await jobs?.end(); await owner?.end();
    if (admin) {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${qi(databaseName)}`);
      await admin.query(`DROP ROLE IF EXISTS ${qi(runtimeLogin)}`);
      await admin.query(`DROP ROLE IF EXISTS ${qi(jobLogin)}`);
      await admin.end();
    }
  }, 30_000);

  it("preflights in the same transaction before every capability", async () => {
    let checks = 0;
    const store = new PostgresCheckoutStore(runtime, async (queryable) => {
      checks += 1;
      await assertDowntownURuntimeIdentity(queryable);
    });
    let attempt = await store.begin({ idempotencyKey: key("surface"), planId: "flex-5", normalizedEmail: "surface@example.edu", requestActor: actor("surface") });
    attempt = await store.recordOrder(attempt.id, "ORDER_SURFACE");
    attempt = await store.recordOrder(attempt.id, "ORDER_SURFACE");
    attempt = await store.recordPayment(attempt.id, "PAY_SURFACE");
    attempt = await store.recordPayment(attempt.id, "PAY_SURFACE");
    await store.transition(attempt.id, "paid");
    await store.readPublic(attempt.id);
    expect(checks).toBe(7);
  });

  it("serializes idempotent concurrency and rejects every identity collision", async () => {
    const store = new PostgresCheckoutStore(runtime);
    const input = { idempotencyKey: key("idem-race"), planId: "flex-5" as const, normalizedEmail: "idem-race@example.edu", requestActor: actor("idem-race") };
    const same = await Promise.all(Array.from({ length: 16 }, () => store.begin(input)));
    expect(new Set(same.map((row) => row.id)).size).toBe(1);
    await expect(store.begin({ ...input, planId: "scholar-10" })).rejects.toBeInstanceOf(CheckoutConflictError);
    await expect(store.begin({ ...input, normalizedEmail: "changed@example.edu" })).rejects.toBeInstanceOf(CheckoutConflictError);
    await expect(store.begin({ ...input, requestActor: actor("changed") })).rejects.toBeInstanceOf(CheckoutConflictError);

    const collisionKey = key("collision-race");
    const raced = await Promise.allSettled([
      store.begin({ idempotencyKey: collisionKey, planId: "flex-5", normalizedEmail: "collision-a@example.edu", requestActor: actor("collision-a") }),
      store.begin({ idempotencyKey: collisionKey, planId: "scholar-10", normalizedEmail: "collision-b@example.edu", requestActor: actor("collision-b") }),
    ]);
    expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(raced.find((result) => result.status === "rejected")).toMatchObject({ reason: expect.any(CheckoutConflictError) });
  });

  it("allows exactly five per email and exact idempotent retry bypasses the exhausted budget", async () => {
    const store = new PostgresCheckoutStore(runtime);
    const email = "email-rate@example.edu";
    const requestActor = actor("email-rate");
    const inputs = Array.from({ length: 6 }, (_, index) => ({
      idempotencyKey: key(`email-rate-${index}`), planId: "flex-5" as const, normalizedEmail: email, requestActor,
    }));
    const settled = await Promise.allSettled(inputs.map((input) => store.begin(input)));
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(settled.find((result) => result.status === "rejected")).toMatchObject({ reason: expect.any(CheckoutRateLimitError) });
    const accepted = inputs[settled.findIndex((result) => result.status === "fulfilled")];
    await expect(store.begin(accepted)).resolves.toMatchObject({ idempotencyKey: accepted.idempotencyKey });
    await expect(store.begin({ ...accepted, planId: "scholar-10" })).rejects.toBeInstanceOf(CheckoutConflictError);
  });

  it("allows exactly ten per request actor under concurrent distinct-email admission", async () => {
    const store = new PostgresCheckoutStore(runtime);
    const requestActor = actor("actor-rate");
    const settled = await Promise.allSettled(Array.from({ length: 11 }, (_, index) => store.begin({
      idempotencyKey: key(`actor-rate-${index}`), planId: "flex-5",
      normalizedEmail: `actor-rate-${index}@example.edu`, requestActor,
    })));
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(10);
    expect(settled.find((result) => result.status === "rejected")).toMatchObject({ reason: expect.any(CheckoutRateLimitError) });
  });

  it("keeps provider IDs immutable, retries stable, and makes review non-resumable", async () => {
    const store = new PostgresCheckoutStore(runtime);
    let attempt = await newAttempt("state");
    attempt = await store.recordOrder(attempt.id, "ORDER_STATE");
    await expect(store.recordOrder(attempt.id, "ORDER_STATE")).resolves.toEqual(attempt);
    await expect(store.recordOrder(attempt.id, "ORDER_CHANGED")).rejects.toBeInstanceOf(CheckoutConflictError);
    attempt = await store.recordPayment(attempt.id, "PAY_STATE");
    await expect(store.recordPayment(attempt.id, "PAY_STATE")).resolves.toEqual(attempt);
    await expect(store.recordPayment(attempt.id, "PAY_CHANGED")).rejects.toBeInstanceOf(CheckoutConflictError);
    const review = await store.transition(attempt.id, "operator_review");
    await expect(store.recordOrder(review.id, "ORDER_STATE")).resolves.toEqual(review);
    await expect(store.transition(review.id, "paid")).rejects.toBeInstanceOf(CheckoutConflictError);
  });

  it("reconciles one exact verified purchase both before and after paid", async () => {
    for (const timing of ["before", "after"] as const) {
      const tag = `RACE_${timing.toUpperCase()}`;
      const email = `${tag.toLowerCase()}@example.edu`;
      const { store, attempt, orderId, paymentId } = await withIds(tag, email);
      if (timing === "after") await expect(store.transition(attempt.id, "paid")).resolves.toMatchObject({ state: "paid" });
      await expect(activate(tag, payment(tag, email, orderId, paymentId))).resolves.toEqual({ outcome: "activated" });
      if (timing === "before") await expect(store.transition(attempt.id, "paid")).resolves.toMatchObject({ state: "activated" });
      await expect(store.readPublic(attempt.id)).resolves.toEqual({ state: "activated" });
      expect((await owner.query("SELECT count(*)::int n FROM downtown_u_plan_purchases WHERE square_payment_id=$1", [paymentId])).rows[0].n).toBe(1);
      expect((await owner.query("SELECT count(*)::int n FROM downtown_u_credit_transactions WHERE source_id=$1", [paymentId])).rows[0].n).toBe(1);
    }
  });

  it("reconciles an authoritative webhook that commits after order but before payment ID recording", async () => {
    const tag = "ORDER_WEBHOOK_PAYMENT";
    const email = "order-webhook-payment@example.edu";
    const store = new PostgresCheckoutStore(runtime);
    let attempt = await newAttempt(tag, email);
    const orderId = `ORDER_${tag}`;
    const paymentId = `PAY_${tag}`;
    attempt = await store.recordOrder(attempt.id, orderId);

    await expect(activate(tag, payment(tag, email, orderId, paymentId)))
      .resolves.toEqual({ outcome: "activated" });
    await expect(store.readPublic(attempt.id)).resolves.toEqual({ state: "order_created" });

    attempt = await store.recordPayment(attempt.id, paymentId);
    expect(attempt.state).toBe("activated");
    await expect(store.readPublic(attempt.id)).resolves.toEqual({ state: "activated" });
  });

  it("commits a mismatched authoritative purchase and grant atomically but quarantines checkout", async () => {
    const tag = "MISMATCH";
    const checkoutEmail = "checkout-mismatch@example.edu";
    const { store, attempt, orderId, paymentId } = await withIds(tag, checkoutEmail);
    await store.transition(attempt.id, "paid");
    await expect(activate(tag, payment(tag, "authoritative-mismatch@example.edu", orderId, paymentId)))
      .resolves.toEqual({ outcome: "activated" });
    await expect(store.readPublic(attempt.id)).resolves.toEqual({ state: "operator_review" });
    expect((await owner.query("SELECT count(*)::int n FROM downtown_u_plan_purchases WHERE square_payment_id=$1", [paymentId])).rows[0].n).toBe(1);
    expect((await owner.query("SELECT count(*)::int n FROM downtown_u_credit_transactions WHERE source_id=$1", [paymentId])).rows[0].n).toBe(1);

    const unrelated = payment("UNRELATED", "unrelated@example.edu", "ORDER_UNRELATED", "PAY_UNRELATED");
    await expect(activate("UNRELATED", unrelated)).resolves.toEqual({ outcome: "activated" });
    expect((await owner.query("SELECT count(*)::int n FROM downtown_u_plan_purchases WHERE square_payment_id='PAY_UNRELATED'")).rows[0].n).toBe(1);
  });

  it("denies direct table/helper access, deletion, truncation, and checkout capability to jobs", async () => {
    const seeded = await newAttempt("denial");
    for (const sql of [
      "SELECT * FROM public.downtown_u_checkout_attempts",
      "DELETE FROM public.downtown_u_checkout_attempts",
      "TRUNCATE public.downtown_u_checkout_attempts",
      "SELECT public.downtown_u_checkout_guard()",
      "SELECT public.downtown_u_checkout_activate()",
    ]) await expect(runtime.query(sql)).rejects.toSatisfy((error: unknown) => dbCode(error) === "42501");
    await expect(owner.query("DELETE FROM public.downtown_u_checkout_attempts WHERE id=$1", [seeded.id])).rejects.toThrow(/immutable/);
    await expect(owner.query("TRUNCATE public.downtown_u_checkout_attempts")).rejects.toThrow(/immutable/);
    await expect(jobs.query("SELECT * FROM public.downtown_u_checkout_begin('abcdefghijklmnop','flex-5','job@example.edu',decode(repeat('00',32),'hex'))"))
      .rejects.toSatisfy((error: unknown) => dbCode(error) === "42501");
    await expect(jobs.query("SELECT * FROM public.downtown_u_checkout_attempts")).rejects.toSatisfy((error: unknown) => dbCode(error) === "42501");
    await expect(runtime.query("SELECT public.downtown_u_reverse_expired_reservations(1)"))
      .rejects.toSatisfy((error: unknown) => dbCode(error) === "42501");
    expect((await owner.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'downtown\\_u\\_%' AND c.relkind='S'")).rows[0].n).toBe(0);
  });

  it("anonymizes bounded old terminal and abandoned attempts while preserving checkout audit and status", async () => {
    const studentId = (await owner.query<{ id: string }>(
      "INSERT INTO downtown_u_students(normalized_email) VALUES('retention-purchase@example.edu') RETURNING id",
    )).rows[0].id;
    const purchaseId = (await owner.query<{ id: string }>(`INSERT INTO downtown_u_plan_purchases
      (student_id,plan_id,credits_granted,price_cents,square_payment_id,square_order_id,source_event_id,paid_at)
      VALUES($1,'flex-5',5,6000,'RETENTION_PAYMENT_0','RETENTION_ORDER_0','RETENTION_EVENT',clock_timestamp()) RETURNING id`,
    [studentId])).rows[0].id;
    const terminalStates = ["activated", "operator_review", "failed"] as const;
    const ids: string[] = [];
    for (const [index, state] of terminalStates.entries()) {
      const row = await owner.query<{ id: string }>(`INSERT INTO public.downtown_u_checkout_attempts
        (idempotency_key,plan_id,normalized_email,request_actor,state,square_order_id,square_payment_id,purchase_id,created_at,updated_at)
        VALUES($1,'flex-5',$2,$3,$4,$5,$6,$7,clock_timestamp()-interval '91 days',clock_timestamp()-interval '91 days') RETURNING id`,
      [key(`retention-${state}`), `retention-${state}@example.edu`, actor(`retention-${state}`), state,
        state === "failed" ? null : `RETENTION_ORDER_${index}`,
        state === "activated" ? `RETENTION_PAYMENT_${index}` : null,
        state === "activated" ? purchaseId : null]);
      ids.push(row.rows[0].id);
    }
    const pending = await owner.query<{ id: string }>(`INSERT INTO public.downtown_u_checkout_attempts
      (idempotency_key,plan_id,normalized_email,request_actor,created_at,updated_at)
      VALUES($1,'flex-5','retention-pending@example.edu',$2,clock_timestamp()-interval '91 days',clock_timestamp()-interval '91 days') RETURNING id`,
    [key("retention-pending"), actor("retention-pending")]);

    await expect(runtime.query("SELECT public.downtown_u_checkout_anonymize(1)"))
      .rejects.toSatisfy((error: unknown) => dbCode(error) === "42501");
    await expect(jobs.query("SELECT public.downtown_u_checkout_anonymize(1)"))
      .rejects.toSatisfy((error: unknown) => dbCode(error) === "42501");
    expect((await owner.query("SELECT public.downtown_u_checkout_anonymize(2) AS n")).rows[0].n).toBe(2);
    expect((await owner.query("SELECT public.downtown_u_checkout_anonymize(2) AS n")).rows[0].n).toBe(2);

    const retained = (await owner.query(`SELECT id,state,normalized_email,request_actor,redacted_at,
      square_order_id,square_payment_id,purchase_id FROM public.downtown_u_checkout_attempts
      WHERE id=ANY($1::uuid[]) ORDER BY id`, [ids])).rows;
    expect(retained).toHaveLength(3);
    expect(retained.every((row) => row.normalized_email === null && row.request_actor === null && row.redacted_at !== null)).toBe(true);
    expect(retained.map((row) => row.state).sort()).toEqual([...terminalStates].sort());
    expect((await owner.query("SELECT state,normalized_email,request_actor,redacted_at FROM public.downtown_u_checkout_attempts WHERE id=$1", [pending.rows[0].id])).rows[0])
      .toMatchObject({ state: "operator_review", normalized_email: null, request_actor: null, redacted_at: expect.any(Date) });
    for (const id of ids) await expect(new PostgresCheckoutStore(runtime).readPublic(id)).resolves.toMatchObject({ state: expect.any(String) });
    await expect(owner.query("DELETE FROM public.downtown_u_checkout_attempts WHERE id=$1", [ids[0]])).rejects.toThrow(/immutable/);
  });

  it("fails runtime and job preflight on representative checkout function drift", async () => {
    await owner.query("ALTER FUNCTION public.downtown_u_checkout_begin(text,text,text,bytea) SECURITY INVOKER");
    await expect(assertDowntownURuntimeIdentity(runtime as never)).rejects.toThrow(/Unsafe/);
    await expect(assertDowntownUJobRuntimeIdentity(jobs as never)).rejects.toThrow(/Unsafe/);
    await owner.query("ALTER FUNCTION public.downtown_u_checkout_begin(text,text,text,bytea) SECURITY DEFINER");
    await expect(assertDowntownURuntimeIdentity(runtime as never)).resolves.toBeUndefined();
    await expect(assertDowntownUJobRuntimeIdentity(jobs as never)).resolves.toBeUndefined();
  });

  it("allows exactly 200 globally and rejects the 201st deterministically", async () => {
    const existing = Number((await owner.query("SELECT count(*)::int n FROM downtown_u_checkout_attempts WHERE created_at>clock_timestamp()-interval '5 minutes'")).rows[0].n);
    for (let index = existing; index < 199; index += 1) {
      await owner.query(`INSERT INTO downtown_u_checkout_attempts
        (idempotency_key,plan_id,normalized_email,request_actor) VALUES($1,'flex-5',$2,$3)`,
      [key(`global-fill-${index}`), `global-fill-${index}@example.edu`, actor(`global-fill-${index}`)]);
    }
    const store = new PostgresCheckoutStore(runtime);
    await expect(store.begin({ idempotencyKey: key("global-200"), planId: "flex-5", normalizedEmail: "global-200@example.edu", requestActor: actor("global-200") })).resolves.toMatchObject({ state: "started" });
    await expect(store.begin({ idempotencyKey: key("global-201"), planId: "flex-5", normalizedEmail: "global-201@example.edu", requestActor: actor("global-201") })).rejects.toBeInstanceOf(CheckoutRateLimitError);
  });
});
