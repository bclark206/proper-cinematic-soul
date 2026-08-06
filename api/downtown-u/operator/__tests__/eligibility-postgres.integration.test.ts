import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOperatorAuthCryptography } from "../../../../server/downtown-u/operator/auth-crypto";
import { PostgresOperatorEligibilityStore } from "../../../../server/downtown-u/operator/postgres-eligibility-store";
import { createOperatorEligibilityHandler, type NodeOperatorEligibilityResponse } from "../eligibility-handler";

const baseUrl = process.env.TEST_DATABASE_URL;
const run = baseUrl ? describe : describe.skip;
const suffix = `${process.pid}_${Date.now()}`;
const databaseName = `du_eligibility_api_${suffix}`;
const login = `du_eligibility_api_login_${suffix}`;
const password = `local-${suffix}`;
const origin = "https://operator.example.test";
const secret = "AyQ7Gu1FZ6fR1esxrvIGvIN8Yl-Bhb12oZSjgqU2xLY";
const sessionId = "81000000-0000-4000-8000-000000000001";
const accountId = "81000000-0000-4000-8000-000000000002";
const studentId = "81000000-0000-4000-8000-000000000003";
const bearer = "A".repeat(43);
const key = "opm:v1:81000000-0000-4000-8000-000000000004";
const ids = ["81000000-0000-4000-8000-000000000005", "81000000-0000-4000-8000-000000000006", "81000000-0000-4000-8000-000000000007"];
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
let expectedUpdatedAt: string;
function qi(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
function response() {
  const result = { status: 0, body: undefined as unknown, headers: {} as Record<string, string> };
  const adapter: NodeOperatorEligibilityResponse = {
    setHeader(name, value) { result.headers[name] = value; },
    status(status) { return { json(value) { result.status = status; result.body = value; } }; },
  };
  return { result, adapter };
}

run.sequential("eligibility API through pristine PG16 runtime capability", () => {
  beforeAll(async () => {
    if (baseUrl !== "postgresql:///postgres") throw new Error("Eligibility API seam requires local TEST_DATABASE_URL=postgresql:///postgres");
    admin = new Pool({ connectionString: baseUrl, max: 2 });
    const version = Number((await admin.query("SHOW server_version_num")).rows[0].server_version_num);
    if (version < 160000 || version >= 170000) throw new Error(`PostgreSQL 16 required, got ${version}`);
    await admin.query(`CREATE DATABASE ${qi(databaseName)}`);
    owner = new Pool({ database: databaseName, max: 4 });
    for (const name of migrationNames) await owner.query(readFileSync(resolve(process.cwd(), "db/migrations", name), "utf8"));
    await admin.query(`CREATE ROLE ${qi(login)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(`GRANT downtown_u_operator_runtime TO ${qi(login)}`);
    runtime = new Pool({ database: databaseName, user: login, password, max: 2 });
    const crypto = createOperatorAuthCryptography(secret);
    const proof = crypto.digestSession(sessionId, bearer);
    const flowId = "81000000-0000-4000-8000-000000000008";
    await owner.query("UPDATE downtown_u_operator_config SET read_enabled=true,mutations_enabled=true,updated_at=clock_timestamp()");
    await owner.query(`INSERT INTO downtown_u_operator_accounts(id,normalized_email,normalized_phone,display_name,provisioning_reference)
      VALUES($1,'api-reviewer@example.edu','+12025550123','API reviewer','eligibility-api:test')`, [accountId]);
    await owner.query("INSERT INTO downtown_u_operator_account_roles(account_id,role_code,assigned_by_reference) VALUES($1,'eligibility_reviewer','eligibility-api:test')", [accountId]);
    await owner.query(`INSERT INTO downtown_u_operator_auth_flows
      (id,operator_id,flow_verifier,status,created_at,updated_at,expires_at,completed_at,consumed_at)
      VALUES($1,$2,$3,'consumed',statement_timestamp()-interval '2 hours',statement_timestamp()-interval '1 hour',statement_timestamp()-interval '90 minutes',statement_timestamp()-interval '70 minutes',statement_timestamp()-interval '60 minutes')`, [flowId, accountId, Buffer.alloc(32, 2)]);
    await owner.query(`INSERT INTO downtown_u_operator_sessions
      (id,operator_id,consumed_auth_flow_id,session_verifier,status,absolute_expires_at,idle_expires_at,last_seen_at,created_at,updated_at)
      VALUES($1,$2,$3,$4,'active',statement_timestamp()+interval '6 hours',statement_timestamp()+interval '20 minutes',statement_timestamp()-interval '1 minute',statement_timestamp()-interval '2 hours',statement_timestamp())`, [sessionId, accountId, flowId, proof]);
    await owner.query(`INSERT INTO downtown_u_operator_auth_challenges
      (id,operator_id,session_id,purpose,factor,status,challenge_verifier,created_at,updated_at,expires_at,verified_at,consumed_at)
      VALUES('81000000-0000-4000-8000-000000000009',$1,$2,'reauth','sms_otp','consumed',$3,statement_timestamp()-interval '2 minutes',statement_timestamp()-interval '1 minute',statement_timestamp()+interval '4 minutes',statement_timestamp()-interval '1 minute',statement_timestamp()-interval '1 minute')`, [accountId, sessionId, Buffer.alloc(32, 3)]);
    const student = await owner.query(`INSERT INTO downtown_u_students
      (id,normalized_email,normalized_phone,square_customer_id,eligibility_status,credit_balance,created_at,updated_at)
      VALUES($1,'api-student@example.edu','+12025550124','sq-api-student','pending',7,statement_timestamp()-interval '1 day','2026-08-03T10:00:00.123Z') RETURNING updated_at`, [studentId]);
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

  it("preflights the runtime login, invokes migration 012, and returns exact 200 item plus evidence", async () => {
    const body = { studentId, expectedStatus: "pending", expectedUpdatedAt, decision: "approve", reasonCode: "documentation_verified", reason: "Documents verified through API" };
    const raw = JSON.stringify(body);
    const headers = { origin, "sec-fetch-site": "same-origin", "content-type": "application/json", "idempotency-key": key, cookie: `__Host-downtown_u_operator_session=v1.${sessionId}.${bearer}` };
    const request = Object.assign(Readable.from([raw]), { method: "POST", url: "/api/downtown-u/operator/eligibility-decisions", headers, rawHeaders: Object.entries(headers).flat() });
    let uuidIndex = 0;
    const handler = createOperatorEligibilityHandler(origin, async () => ({
      admission: { async admit() { return { outcome: "admitted" as const }; } },
      cryptography: createOperatorAuthCryptography(secret),
      store: new PostgresOperatorEligibilityStore(runtime),
    }), { randomUUID: () => ids[uuidIndex++] });
    const output = response();
    await handler(request, output.adapter);
    expect(output.result.status).toBe(200);
    expect(output.result.body).toEqual({ result: {
      studentId, eligibilityStatus: "approved", eligibilityReviewedAt: expect.stringMatching(/\.\d{3}Z$/),
      approvedAt: expect.stringMatching(/\.\d{3}Z$/), updatedAt: expect.stringMatching(/\.\d{3}Z$/),
    }, replayed: false });
    const evidence = await owner.query(`SELECT a.action_code,a.target_id,a.reason,e.from_status,e.to_status
      FROM downtown_u_operator_audit_events a JOIN downtown_u_eligibility_events e ON e.audit_event_id=a.id WHERE a.idempotency_key=$1`, [key]);
    expect(evidence.rows).toEqual([{ action_code: "eligibility_approve", target_id: studentId, reason: body.reason, from_status: "pending", to_status: "approved" }]);
  });
});
