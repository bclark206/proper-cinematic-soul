import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresOperatorEligibilityStore, type OperatorEligibilityMutationInput } from "../postgres-eligibility-store";

const baseUrl = process.env.TEST_DATABASE_URL;
const run = baseUrl ? describe : describe.skip;
const suffix = `${process.pid}_${Date.now()}`;
const databaseName = `du_eligibility_store_${suffix}`;
const login = `du_eligibility_store_login_${suffix}`;
const password = `local-${suffix}`;
const accountId = "91000000-0000-4000-8000-000000000001";
const firstSessionId = "91000000-0000-4000-8000-000000000002";
const secondSessionId = "91000000-0000-4000-8000-000000000003";
const studentId = "91000000-0000-4000-8000-000000000004";
const sessionDigest = Buffer.alloc(32, 17);
const secondSessionDigest = Buffer.alloc(32, 18);
const idempotencyKey = "opm:v1:91000000-0000-7000-8000-000000000005";
const migrationNames = [
  "202608040001_downtown_u_phase1.sql", "202608040002_downtown_u_webhook_events.sql",
  "202608040003_downtown_u_payment_activation.sql", "202608040004_downtown_u_refund_activation.sql",
  "202608040005_downtown_u_auth.sql", "202608040006_downtown_u_student_portal.sql",
  "202608040007_downtown_u_checkout.sql", "202608040008_downtown_u_kitchen_outbox.sql",
  "202608040009_downtown_u_operator_audit.sql", "202608040010_downtown_u_operator_auth_capabilities.sql",
  "202608040011_downtown_u_operator_dashboard_reads.sql", "202608040012_downtown_u_operator_eligibility_mutations.sql",
];
let admin: Pool;
let owner: Pool;
let runtime: Pool;
let store: PostgresOperatorEligibilityStore;
let expectedUpdatedAt: string;
let updated: Awaited<ReturnType<PostgresOperatorEligibilityStore["mutate"]>>;
function qi(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
function input(overrides: Partial<OperatorEligibilityMutationInput> = {}): OperatorEligibilityMutationInput {
  return {
    sessionId: firstSessionId,
    sessionVersion: 1,
    sessionDigest,
    correlationId: "operator-mutation:91000000-0000-4000-8000-000000000006",
    idempotencyKey,
    auditId: "91000000-0000-4000-8000-000000000007",
    eventId: "91000000-0000-4000-8000-000000000008",
    studentId,
    expectedStatus: "pending",
    expectedUpdatedAt,
    decision: "approve",
    reasonCode: "documentation_verified",
    reason: "Production store PostgreSQL seam verified",
    ...overrides,
  };
}

run.sequential("production eligibility store on pristine PostgreSQL 16", () => {
  beforeAll(async () => {
    if (baseUrl !== "postgresql:///postgres") throw new Error("Eligibility store seam requires local TEST_DATABASE_URL=postgresql:///postgres");
    admin = new Pool({ connectionString: baseUrl, max: 2 });
    const version = Number((await admin.query("SHOW server_version_num")).rows[0].server_version_num);
    if (version < 160000 || version >= 170000) throw new Error(`PostgreSQL 16 required, got ${version}`);
    await admin.query(`CREATE DATABASE ${qi(databaseName)}`);
    owner = new Pool({ database: databaseName, max: 4 });
    for (const name of migrationNames) await owner.query(readFileSync(resolve(process.cwd(), "db/migrations", name), "utf8"));
    await admin.query(`CREATE ROLE ${qi(login)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(`GRANT downtown_u_operator_runtime TO ${qi(login)}`);
    runtime = new Pool({ host: "127.0.0.1", database: databaseName, user: login, password, max: 2 });
    store = new PostgresOperatorEligibilityStore(runtime);

    await owner.query("UPDATE downtown_u_operator_config SET read_enabled=true,mutations_enabled=true,updated_at=clock_timestamp()");
    await owner.query(`INSERT INTO downtown_u_operator_accounts(id,normalized_email,normalized_phone,display_name,provisioning_reference)
      VALUES($1,'store-reviewer@example.edu','+12025550131','Store reviewer','eligibility-store:test')`, [accountId]);
    await owner.query("INSERT INTO downtown_u_operator_account_roles(account_id,role_code,assigned_by_reference) VALUES($1,'eligibility_reviewer','eligibility-store:test')", [accountId]);
    for (const [index, sessionId] of [firstSessionId, secondSessionId].entries()) {
      const flowId = `91000000-0000-4000-8000-00000000001${index}`;
      const challengeId = `91000000-0000-4000-8000-00000000002${index}`;
      await owner.query(`INSERT INTO downtown_u_operator_auth_flows
        (id,operator_id,flow_verifier,status,created_at,updated_at,expires_at,completed_at,consumed_at)
        VALUES($1,$2,$3,'consumed',statement_timestamp()-interval '2 hours',statement_timestamp()-interval '1 hour',statement_timestamp()-interval '90 minutes',statement_timestamp()-interval '70 minutes',statement_timestamp()-interval '60 minutes')`,
      [flowId, accountId, Buffer.alloc(32, 30 + index)]);
      await owner.query(`INSERT INTO downtown_u_operator_sessions
        (id,operator_id,consumed_auth_flow_id,session_verifier,status,absolute_expires_at,idle_expires_at,last_seen_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,'active',statement_timestamp()+interval '6 hours',statement_timestamp()+interval '20 minutes',statement_timestamp()-interval '1 minute',statement_timestamp()-interval '2 hours',statement_timestamp())`,
      [sessionId, accountId, flowId, index === 0 ? sessionDigest : secondSessionDigest]);
      await owner.query(`INSERT INTO downtown_u_operator_auth_challenges
        (id,operator_id,session_id,purpose,factor,status,challenge_verifier,created_at,updated_at,expires_at,verified_at,consumed_at)
        VALUES($1,$2,$3,'reauth','sms_otp','consumed',$4,statement_timestamp()-interval '2 minutes',statement_timestamp()-interval '1 minute',statement_timestamp()+interval '4 minutes',statement_timestamp()-interval '1 minute',statement_timestamp()-interval '1 minute')`,
      [challengeId, accountId, sessionId, Buffer.alloc(32, 40 + index)]);
    }
    const student = await owner.query(`INSERT INTO downtown_u_students
      (id,normalized_email,normalized_phone,square_customer_id,eligibility_status,credit_balance,created_at,updated_at)
      VALUES($1,'store-student@example.edu','+12025550132','sq-store-student','pending',7,statement_timestamp()-interval '1 day','2026-08-03T10:00:00.123Z') RETURNING updated_at`, [studentId]);
    expectedUpdatedAt = student.rows[0].updated_at.toISOString();
  }, 30_000);

  afterAll(async () => {
    await runtime?.end(); await owner?.end();
    if (admin) {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${qi(databaseName)}`);
      await admin.query(`DROP ROLE IF EXISTS ${qi(login)}`);
      await admin.end();
    }
  }, 30_000);

  it("uses the actual store and default identity preflight to commit the exact JSONB result and evidence", async () => {
    updated = await store.mutate(input());
    expect(updated).toMatchObject({ outcome: "updated", replayed: false, item: { studentId, eligibilityStatus: "approved" } });
    if (updated.outcome !== "updated") throw new Error("expected update");
    const committed = await owner.query(`SELECT s.eligibility_status,s.eligibility_reviewed_at,s.approved_at,s.updated_at,
      a.id audit_id,a.operator_id,a.session_id audit_session_id,a.action_code,a.target_id,a.reason_code,a.reason,a.idempotency_key,
      e.id event_id,e.session_id event_session_id,e.from_status,e.to_status,e.audit_event_id,e.result_item
      FROM downtown_u_students s
      JOIN downtown_u_operator_audit_events a ON a.target_id=s.id::text
      JOIN downtown_u_eligibility_events e ON e.audit_event_id=a.id
      WHERE s.id=$1 AND a.idempotency_key=$2`, [studentId, idempotencyKey]);
    expect(committed.rows).toHaveLength(1);
    const row = committed.rows[0];
    expect(row.result_item).toEqual(updated.item);
    expect(row).toMatchObject({
      eligibility_status: "approved", audit_id: input().auditId, event_id: input().eventId,
      operator_id: accountId, audit_session_id: firstSessionId, event_session_id: firstSessionId,
      action_code: "eligibility_approve", target_id: studentId, reason_code: "documentation_verified",
      reason: input().reason, idempotency_key: idempotencyKey, from_status: "pending", to_status: "approved",
      audit_event_id: input().auditId,
    });
    expect(row.eligibility_reviewed_at.toISOString()).toBe(updated.item.eligibilityReviewedAt);
    expect(row.approved_at.toISOString()).toBe(updated.item.approvedAt);
    expect(row.updated_at.toISOString()).toBe(updated.item.updatedAt);
  });

  it("reauthorizes a current second session and replays the exact stored item despite new IDs/state", async () => {
    if (updated.outcome !== "updated") throw new Error("missing original update");
    const replay = await store.mutate(input({
      sessionId: secondSessionId,
      sessionDigest: secondSessionDigest,
      correlationId: "operator-mutation:91000000-0000-4000-8000-000000000031",
      auditId: "91000000-0000-4000-8000-000000000032",
      eventId: "91000000-0000-4000-8000-000000000033",
      expectedUpdatedAt: "1970-01-01T00:00:00.000Z",
    }));
    expect(replay).toEqual({ ...updated, replayed: true });
    expect((await owner.query("SELECT count(*)::int n FROM downtown_u_operator_audit_events WHERE idempotency_key=$1", [idempotencyKey])).rows[0].n).toBe(1);
    expect((await owner.query("SELECT count(*)::int n FROM downtown_u_eligibility_events WHERE audit_event_id=$1", [input().auditId])).rows[0].n).toBe(1);
  });

  it("returns a bounded capability conflict for the same key with different semantic intent and grants no relation access", async () => {
    await expect(store.mutate(input({
      sessionId: secondSessionId,
      sessionDigest: secondSessionDigest,
      correlationId: "operator-mutation:91000000-0000-4000-8000-000000000041",
      auditId: "91000000-0000-4000-8000-000000000042",
      eventId: "91000000-0000-4000-8000-000000000043",
      decision: "reject",
      reasonCode: "policy_ineligible",
    }))).resolves.toEqual({ outcome: "idempotency_conflict", replayed: false, item: null });
    await expect(runtime.query("SELECT * FROM public.downtown_u_students LIMIT 0")).rejects.toMatchObject({ code: "42501" });
    const leaks = await runtime.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','S') AND
      (CASE WHEN c.relkind='S' THEN has_sequence_privilege(current_user,c.oid,'USAGE,SELECT,UPDATE')
        ELSE has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE') END)`);
    expect(leaks.rows).toEqual([]);
  });
});
