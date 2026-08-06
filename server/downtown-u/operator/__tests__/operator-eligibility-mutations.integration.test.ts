import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const baseUrl = process.env.TEST_DATABASE_URL;
const run = baseUrl ? describe : describe.skip;
const suffix = `${process.pid}_${Date.now()}`;
const databaseName = `du_eligibility_${suffix}`;
const operatorLogin = `du_eligibility_login_${suffix}`;
const hostileRole = `du_eligibility_hostile_${suffix}`;
const historicalAccountId = "72000000-0000-4000-8000-000000000001";
const historicalFlowId = "72000000-0000-4000-8000-000000000002";
const historicalSessionId = "72000000-0000-4000-8000-000000000003";
const historicalStudentId = "72000000-0000-4000-8000-000000000004";
const historicalAuditId = "72000000-0000-4000-8000-000000000005";
const historicalEventId = "72000000-0000-4000-8000-000000000006";
const historicalKey = "opm:v1:72000000-0000-4000-8000-000000000007";
const historicalCorrelation = "eligibility-historical-correlation-0001";
const historicalProof = Buffer.alloc(32, 72);
const migrationNames = [
  "202608040001_downtown_u_phase1.sql", "202608040002_downtown_u_webhook_events.sql",
  "202608040003_downtown_u_payment_activation.sql", "202608040004_downtown_u_refund_activation.sql",
  "202608040005_downtown_u_auth.sql", "202608040006_downtown_u_student_portal.sql",
  "202608040007_downtown_u_checkout.sql", "202608040008_downtown_u_kitchen_outbox.sql",
  "202608040009_downtown_u_operator_audit.sql", "202608040010_downtown_u_operator_auth_capabilities.sql",
  "202608040011_downtown_u_operator_dashboard_reads.sql", "202608040012_downtown_u_operator_eligibility_mutations.sql",
];
const functionCall = `SELECT * FROM public.downtown_u_operator_set_eligibility(
  $1,$2::smallint,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`;
let admin: Pool;
let pool: Pool;
let serial = 1;
function qi(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
function uuid(): string { return `71000000-0000-4000-8000-${String(serial++).padStart(12, "0")}`; }
function key(): string { return `opm:v1:${uuid()}`; }
function correlation(): string { return `eligibility-correlation-${serial++}`; }
function verifier(): Buffer { const value = Buffer.alloc(32); value.writeUInt32BE(serial++); return value; }
type Principal = { accountId: string; sessionId: string; proof: Buffer };
type Intent = { key: string; auditId: string; eventId: string; studentId: string; expectedStatus: string; expectedUpdatedAt: Date; decision: string; reasonCode: string; reason: string };

async function asOperator<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`SET SESSION AUTHORIZATION ${qi(operatorLogin)}`);
    return await operation(client);
  } finally {
    await client.query("RESET SESSION AUTHORIZATION").catch(() => undefined);
    client.release();
  }
}
async function controlled(statement: string, values: unknown[] = []): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('downtown_u.operator_write',pg_backend_pid()::text||':'||pg_current_xact_id()::text,true)");
    await client.query(statement, values);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
async function principal(role = "eligibility_reviewer", reauthAge = "1 minute", existingAccountId?: string): Promise<Principal> {
  const accountId = existingAccountId ?? uuid(), flowId = uuid(), sessionId = uuid(), proof = verifier();
  if (!existingAccountId) {
    await pool.query(`INSERT INTO downtown_u_operator_accounts(id,normalized_email,normalized_phone,display_name,provisioning_reference)
      VALUES($1,$2,$3,'Eligibility reviewer',$4)`, [accountId, `eligibility-${serial}@example.edu`, `+1202${String(serial).padStart(7, "0")}`, `eligibility:${serial}`]);
    if (role) await pool.query("INSERT INTO downtown_u_operator_account_roles(account_id,role_code,assigned_by_reference) VALUES($1,$2,$3)", [accountId, role, `assign:${serial}`]);
  }
  await pool.query(`INSERT INTO downtown_u_operator_auth_flows
    (id,operator_id,flow_verifier,status,created_at,updated_at,expires_at,completed_at,consumed_at)
    VALUES($1,$2,$3,'consumed',statement_timestamp()-interval '2 hours',statement_timestamp()-interval '1 hour',statement_timestamp()-interval '90 minutes',statement_timestamp()-interval '70 minutes',statement_timestamp()-interval '60 minutes')`,
  [flowId, accountId, verifier()]);
  await pool.query(`INSERT INTO downtown_u_operator_sessions
    (id,operator_id,consumed_auth_flow_id,session_verifier,status,absolute_expires_at,idle_expires_at,last_seen_at,created_at,updated_at)
    VALUES($1,$2,$3,$4,'active',statement_timestamp()+interval '6 hours',statement_timestamp()+interval '20 minutes',statement_timestamp()-interval '1 minute',statement_timestamp()-interval '2 hours',statement_timestamp())`,
  [sessionId, accountId, flowId, proof]);
  if (reauthAge !== "none") await pool.query(`INSERT INTO downtown_u_operator_auth_challenges
    (id,operator_id,session_id,purpose,factor,status,challenge_verifier,created_at,updated_at,expires_at,verified_at,consumed_at)
    VALUES($1,$2,$3,'reauth','sms_otp','consumed',$4,statement_timestamp()-interval '6 minutes',statement_timestamp()-interval '${reauthAge}',statement_timestamp()+interval '4 minutes',statement_timestamp()-interval '${reauthAge}',statement_timestamp()-interval '${reauthAge}')`,
  [uuid(), accountId, sessionId, verifier()]);
  return { accountId, sessionId, proof };
}
async function student(status = "pending", deleted = false): Promise<{ id: string; updatedAt: Date }> {
  const id = uuid();
  const row = (await pool.query(`INSERT INTO downtown_u_students
    (id,normalized_email,normalized_phone,square_customer_id,eligibility_status,credit_balance,eligibility_reviewed_at,approved_at,rejected_at,suspended_at,created_at,updated_at,deleted_at)
    VALUES($1,$2,$3,$4,$5,7,CASE WHEN $5='pending' THEN NULL ELSE '2026-08-01T10:00:00Z'::timestamptz END,
      CASE WHEN $5 IN ('approved','suspended') THEN '2026-08-01T10:00:00Z'::timestamptz END,
      CASE WHEN $5='rejected' THEN '2026-08-01T10:00:00Z'::timestamptz END,CASE WHEN $5='suspended' THEN '2026-08-02T10:00:00Z'::timestamptz END,
      '2026-08-01T09:00:00Z','2026-08-03T10:00:00.123Z',CASE WHEN $6 THEN '2026-08-04T10:00:00Z'::timestamptz END) RETURNING updated_at`,
  [id, `student-${serial}@example.edu`, `+1310${String(serial++).padStart(7, "0")}`, `sq-${serial}`, status, deleted])).rows[0];
  return { id, updatedAt: row.updated_at };
}
function intent(target: { id: string; updatedAt: Date }, decision: string, reasonCode: string, reason = "Eligibility evidence reviewed"): Intent {
  return { key: key(), auditId: uuid(), eventId: uuid(), studentId: target.id, expectedStatus: "pending", expectedUpdatedAt: target.updatedAt, decision, reasonCode, reason };
}
async function mutate(p: Principal, i: Intent, overrides: Partial<Intent> = {}, client?: PoolClient) {
  const x = { ...i, ...overrides };
  const values = [p.sessionId, 1, p.proof, correlation(), x.key, x.auditId, x.eventId, x.studentId, x.expectedStatus, x.expectedUpdatedAt, x.decision, x.reasonCode, x.reason];
  if (client) return (await client.query(functionCall, values)).rows[0];
  return asOperator(async (c) => (await c.query(functionCall, values)).rows[0]);
}
async function snapshot(studentId: string) {
  return (await pool.query(`SELECT to_jsonb(s) student,
    (SELECT count(*)::int FROM downtown_u_credit_transactions WHERE student_id=s.id) ledger_count,
    (SELECT count(*)::int FROM downtown_u_plan_purchases WHERE student_id=s.id) purchase_count,
    (SELECT count(*)::int FROM downtown_u_redemptions WHERE student_id=s.id) redemption_count
    FROM downtown_u_students s WHERE s.id=$1`, [studentId])).rows[0];
}

run.sequential("eligibility mutations on pristine PostgreSQL 16 migrations 001-012", () => {
  beforeAll(async () => {
    const parsed = new URL(baseUrl!);
    if (!["", "localhost", "127.0.0.1", "::1"].includes(parsed.hostname) && !/(test|disposable)/i.test(parsed.pathname)) throw new Error("Refusing non-test PostgreSQL");
    admin = new Pool({ connectionString: baseUrl, max: 2 });
    const version = Number((await admin.query("SHOW server_version_num")).rows[0].server_version_num);
    if (version < 160000 || version >= 170000) throw new Error(`PostgreSQL 16 required, got ${version}`);
    await admin.query(`CREATE DATABASE ${qi(databaseName)}`);
    await admin.query(`CREATE ROLE ${qi(hostileRole)} NOLOGIN`);
    const url = new URL(baseUrl!); url.pathname = `/${databaseName}`; pool = new Pool({ connectionString: url.toString(), max: 12 });
    const migrations = migrationNames.map((name) => readFileSync(resolve(process.cwd(), "db/migrations", name), "utf8"));
    for (const migration of migrations.slice(0, 11)) await pool.query(migration);
    await pool.query(`INSERT INTO downtown_u_operator_accounts(id,normalized_email,normalized_phone,display_name,provisioning_reference)
      VALUES($1,'historical-reviewer@example.edu','+12025550720','Historical reviewer','eligibility:historical')`, [historicalAccountId]);
    await pool.query("INSERT INTO downtown_u_operator_account_roles(account_id,role_code,assigned_by_reference) VALUES($1,'eligibility_reviewer','eligibility:historical')", [historicalAccountId]);
    await pool.query(`INSERT INTO downtown_u_operator_auth_flows
      (id,operator_id,flow_verifier,status,created_at,updated_at,expires_at,completed_at,consumed_at)
      VALUES($1,$2,$3,'consumed',statement_timestamp()-interval '2 hours',statement_timestamp()-interval '1 hour',statement_timestamp()-interval '90 minutes',statement_timestamp()-interval '70 minutes',statement_timestamp()-interval '60 minutes')`,
    [historicalFlowId, historicalAccountId, Buffer.alloc(32, 71)]);
    await pool.query(`INSERT INTO downtown_u_operator_sessions
      (id,operator_id,consumed_auth_flow_id,session_verifier,status,absolute_expires_at,idle_expires_at,last_seen_at,created_at,updated_at)
      VALUES($1,$2,$3,$4,'active',statement_timestamp()+interval '6 hours',statement_timestamp()+interval '20 minutes',statement_timestamp()-interval '1 minute',statement_timestamp()-interval '2 hours',statement_timestamp())`,
    [historicalSessionId, historicalAccountId, historicalFlowId, historicalProof]);
    await pool.query(`INSERT INTO downtown_u_operator_auth_challenges
      (id,operator_id,session_id,purpose,factor,status,challenge_verifier,created_at,updated_at,expires_at,verified_at,consumed_at)
      VALUES('72000000-0000-4000-8000-000000000008',$1,$2,'reauth','sms_otp','consumed',$3,statement_timestamp()-interval '2 minutes',statement_timestamp()-interval '1 minute',statement_timestamp()+interval '4 minutes',statement_timestamp()-interval '1 minute',statement_timestamp()-interval '1 minute')`,
    [historicalAccountId, historicalSessionId, Buffer.alloc(32, 73)]);
    await pool.query(`INSERT INTO downtown_u_students
      (id,normalized_email,normalized_phone,square_customer_id,eligibility_status,credit_balance,created_at,updated_at)
      VALUES($1,'historical-student@example.edu','+12025550721','sq-historical-student','pending',7,'2026-08-01T09:00:00Z','2026-08-03T10:00:00.123Z')`, [historicalStudentId]);
    await controlled(`WITH inserted_audit AS (
      INSERT INTO downtown_u_operator_audit_events
        (id,operator_id,session_id,action_code,target_type,target_id,reason_code,reason,idempotency_key,correlation_id,created_at)
        VALUES($1,$2,$3,'eligibility_approve','student',$4,'documentation_verified','Historical eligibility evidence',$5,$6,'2026-08-03T11:00:00Z')
        RETURNING id)
      INSERT INTO downtown_u_eligibility_events
        (id,operator_id,session_id,student_id,from_status,to_status,reason_code,reason,idempotency_key,correlation_id,audit_event_id,created_at)
      SELECT $7,$2,$3,$4::uuid,'pending','approved','documentation_verified','Historical eligibility evidence',$5,$6,id,'2026-08-03T11:00:00Z'
      FROM inserted_audit`,
    [historicalAuditId, historicalAccountId, historicalSessionId, historicalStudentId, historicalKey, historicalCorrelation, historicalEventId]);
    await pool.query(`ALTER DEFAULT PRIVILEGES GRANT SELECT,INSERT,UPDATE ON TABLES TO ${qi(hostileRole)}`);
    await pool.query(`ALTER DEFAULT PRIVILEGES GRANT USAGE ON SEQUENCES TO ${qi(hostileRole)}`);
    await pool.query(`ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO ${qi(hostileRole)}`);
    await pool.query(migrations[11]);
    await admin.query(`CREATE ROLE ${qi(operatorLogin)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(`GRANT downtown_u_operator_runtime TO ${qi(operatorLogin)}`);
    await pool.query("UPDATE downtown_u_operator_config SET read_enabled=true,mutations_enabled=true,updated_at=clock_timestamp()");
  }, 30_000);
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${qi(databaseName)}`);
      await admin.query(`DROP ROLE IF EXISTS ${qi(operatorLogin)}`);
      await admin.query(`DROP ROLE IF EXISTS ${qi(hostileRole)}`);
      await admin.end();
    }
  }, 30_000);

  it.each([
    ["pending", "approve", "documentation_verified", "approved"],
    ["pending", "reject", "documentation_incomplete", "rejected"],
    ["approved", "suspend", "safety_hold", "suspended"],
    ["suspended", "reinstate", "hold_cleared", "approved"],
  ])("performs %s --%s--> %s atomically with exact timestamps and redaction", async (from, decision, reasonCode, to) => {
    const p = await principal(); const target = await student(from); const before = await snapshot(target.id);
    const i = intent(target, decision, reasonCode); i.expectedStatus = from;
    const result = await mutate(p, i);
    expect(result).toMatchObject({ outcome: "updated", replayed: false, item: { studentId: target.id, eligibilityStatus: to } });
    const replay = await mutate(p, i, { auditId: uuid(), eventId: uuid(), expectedUpdatedAt: new Date(0) });
    expect(replay).toEqual({ ...result, replayed: true });
    expect(Object.keys(result.item).sort()).toEqual(["approvedAt", "eligibilityReviewedAt", "eligibilityStatus", "rejectedAt", "studentId", "suspendedAt", "updatedAt"].filter((k) => result.item[k] !== undefined).sort());
    const after = await snapshot(target.id); const s = after.student;
    expect(s.updated_at).toEqual(s.eligibility_reviewed_at);
    if (decision === "approve") expect(s.approved_at).toEqual(s.updated_at);
    if (decision === "reject") expect(s.rejected_at).toEqual(s.updated_at);
    if (decision === "suspend") { expect(s.suspended_at).toEqual(s.updated_at); expect(s.approved_at).toEqual(before.student.approved_at); }
    if (decision === "reinstate") { expect(s.suspended_at).toBeNull(); expect(s.approved_at).toEqual(before.student.approved_at); }
    for (const column of ["id", "normalized_email", "normalized_phone", "square_customer_id", "credit_balance", "created_at", "deleted_at"]) expect(s[column]).toEqual(before.student[column]);
    expect({ ledger_count: after.ledger_count, purchase_count: after.purchase_count, redemption_count: after.redemption_count }).toEqual({ ledger_count: before.ledger_count, purchase_count: before.purchase_count, redemption_count: before.redemption_count });
    const evidence = await pool.query(`SELECT a.*,e.id event_id,e.from_status,e.to_status,e.audit_event_id,e.created_at event_created_at
      FROM downtown_u_operator_audit_events a JOIN downtown_u_eligibility_events e ON e.audit_event_id=a.id WHERE a.idempotency_key=$1`, [i.key]);
    expect(evidence.rows).toHaveLength(1);
    expect(evidence.rows[0]).toMatchObject({ id: i.auditId, event_id: i.eventId, operator_id: p.accountId, session_id: p.sessionId, action_code: `eligibility_${decision}`, target_type: "student", target_id: target.id, reason_code: reasonCode, reason: i.reason, from_status: from, to_status: to, audit_event_id: i.auditId });
    expect(evidence.rows[0].created_at).toEqual(evidence.rows[0].event_created_at);
  });

  it("rejects every illegal edge, same-state edge, and wrong decision/reason pairing without writes", async () => {
    const legal = new Set(["pending:approve", "pending:reject", "approved:suspend", "suspended:reinstate"]);
    const reasons: Record<string, string> = { approve: "documentation_verified", reject: "policy_ineligible", suspend: "policy_hold", reinstate: "hold_cleared" };
    const p = await principal();
    for (const status of ["pending", "approved", "rejected", "suspended"]) for (const decision of Object.keys(reasons)) {
      if (legal.has(`${status}:${decision}`)) continue;
      const target = await student(status); const i = intent(target, decision, reasons[decision]); i.expectedStatus = status;
      expect(await mutate(p, i)).toEqual({ outcome: "conflict", replayed: false, item: null });
      expect((await pool.query("SELECT count(*)::int n FROM downtown_u_operator_audit_events WHERE idempotency_key=$1", [i.key])).rows[0].n).toBe(0);
    }
    const target = await student();
    for (const [decision, badReason] of [["approve", "policy_hold"], ["reject", "documentation_verified"], ["suspend", "hold_cleared"], ["reinstate", "safety_hold"]]) {
      const i = intent(target, decision, badReason); expect((await mutate(p, i)).outcome).toBe("invalid");
    }
  });

  it("distinguishes stale status/time, missing/deleted targets and malformed inputs", async () => {
    const p = await principal(); const target = await student();
    expect(await mutate(p, intent(target, "approve", "documentation_verified"), { expectedStatus: "approved" })).toEqual({ outcome: "stale_state", replayed: false, item: null });
    expect((await mutate(p, intent(target, "approve", "documentation_verified"), { expectedUpdatedAt: new Date(target.updatedAt.getTime() + 1) })).outcome).toBe("stale_state");
    const missing = intent({ id: uuid(), updatedAt: new Date() }, "approve", "documentation_verified");
    expect((await mutate(p, missing)).outcome).toBe("not_found");
    const deleted = await student("pending", true); expect((await mutate(p, intent(deleted, "approve", "documentation_verified"))).outcome).toBe("not_found");
    const valid = intent(target, "approve", "documentation_verified");
    for (const overrides of [
      { key: "opm:v1:AAAAAAAA-0000-4000-8000-000000000000" }, { key: `other:v1:${uuid()}` },
      { key: "opm:v2:71000000-0000-4000-8000-000000000001" },
      { key: "opm:v1:7100000-00000-4000-8000-000000000001" },
      { key: "opm:v1:71000000-0000-9000-8000-000000000001" },
      { key: "opm:v1:71000000-0000-4000-7000-000000000001" },
      { auditId: null as unknown as string },
      { eventId: null as unknown as string }, { reason: " padded" }, { reason: "e\u0301" }, { reason: "line\ncontrol" },
      { reason: "x".repeat(501) }, { reasonCode: "DOCUMENTATION_VERIFIED" }, { expectedUpdatedAt: null as unknown as Date },
    ]) expect((await mutate(p, valid, overrides)).outcome).toBe("invalid");
    const nullVersionValues = [p.sessionId, null, p.proof, correlation(), key(), uuid(), uuid(), target.id,
      "pending", target.updatedAt, "approve", "documentation_verified", "Eligibility evidence reviewed"];
    expect(await asOperator(async (c) => (await c.query(functionCall, nullVersionValues)).rows[0]))
      .toEqual({ outcome: "invalid", replayed: false, item: null });
  });

  it("accepts a canonical lowercase UUIDv7 idempotency key and replays its committed result", async () => {
    const p = await principal(); const target = await student();
    const i = intent(target, "approve", "documentation_verified");
    i.key = "opm:v1:71000000-0000-7000-8000-000000000001";
    const updated = await mutate(p, i);
    expect(updated).toMatchObject({ outcome: "updated", replayed: false, item: { studentId: target.id, eligibilityStatus: "approved" } });
    expect(await mutate(p, i, { auditId: uuid(), eventId: uuid(), expectedUpdatedAt: new Date(0) }))
      .toEqual({ ...updated, replayed: true });
  });

  it("always reauthorizes before replay and replays exact intent across sessions after a later transition", async () => {
    const p = await principal(); const target = await student(); const approve = intent(target, "approve", "documentation_verified");
    const original = await mutate(p, approve); const approvedAt = new Date(original.item.updatedAt);
    const current = { id: target.id, updatedAt: approvedAt }; const suspend = intent(current, "suspend", "safety_hold"); suspend.expectedStatus = "approved";
    const suspended = await mutate(p, suspend);
    expect(suspended.outcome).toBe("updated");
    const reinstateTarget = { id: target.id, updatedAt: new Date(suspended.item.updatedAt) };
    const reinstate = intent(reinstateTarget, "reinstate", "hold_cleared"); reinstate.expectedStatus = "suspended";
    expect((await mutate(p, reinstate)).outcome).toBe("updated");
    const secondSession = await principal("", "1 minute", p.accountId);
    const replay = await mutate(secondSession, approve, { auditId: uuid(), eventId: uuid(), expectedUpdatedAt: new Date(0) });
    expect(replay).toEqual({ ...original, replayed: true });
    expect(await mutate(p, suspend, { auditId: uuid(), eventId: uuid(), expectedUpdatedAt: new Date(0) }))
      .toEqual({ ...suspended, replayed: true });
    expect((await pool.query("SELECT count(*)::int n FROM downtown_u_operator_audit_events WHERE idempotency_key=$1", [approve.key])).rows[0].n).toBe(1);
    await pool.query("UPDATE downtown_u_operator_config SET mutations_enabled=false,updated_at=clock_timestamp()");
    try { expect((await mutate(p, approve)).outcome).toBe("denied"); } finally { await pool.query("UPDATE downtown_u_operator_config SET mutations_enabled=true,updated_at=clock_timestamp()"); }
  });

  it("returns idempotency_conflict for actor/target/decision/reason mismatch and partial or extra topology", async () => {
    const p = await principal(); const other = await principal(); const target = await student(); const first = intent(target, "approve", "documentation_verified");
    expect((await mutate(p, first)).outcome).toBe("updated");
    for (const [actor, overrides] of [
      [other, {}], [p, { studentId: (await student()).id }], [p, { decision: "reject", reasonCode: "policy_ineligible" }],
      [p, { reasonCode: "documentation_incomplete" }], [p, { reason: "Changed semantic reason" }],
    ] as [Principal, Partial<Intent>][]) expect((await mutate(actor, first, overrides)).outcome).toBe("idempotency_conflict");

    const partial = intent(await student(), "approve", "documentation_verified");
    await controlled(`INSERT INTO downtown_u_operator_audit_events(id,operator_id,session_id,action_code,target_type,target_id,reason_code,reason,idempotency_key,correlation_id)
      VALUES($1,$2,$3,'eligibility_approve','student',$4,$5,$6,$7,$8)`, [partial.auditId, p.accountId, p.sessionId, partial.studentId, partial.reasonCode, partial.reason, partial.key, correlation()]);
    expect((await mutate(p, partial)).outcome).toBe("idempotency_conflict");

    const extra = intent(await student(), "approve", "documentation_verified"); const corr = correlation();
    await controlled(`INSERT INTO downtown_u_operator_audit_events(id,operator_id,session_id,action_code,target_type,target_id,reason_code,reason,idempotency_key,correlation_id)
      VALUES($1,$2,$3,'eligibility_approve','student',$4,$5,$6,$7,$8)`, [extra.auditId, p.accountId, p.sessionId, extra.studentId, extra.reasonCode, extra.reason, extra.key, corr]);
    for (let n = 0; n < 2; n++) await controlled(`INSERT INTO downtown_u_eligibility_events(id,operator_id,session_id,student_id,from_status,to_status,reason_code,reason,idempotency_key,correlation_id,audit_event_id,result_item)
      VALUES($1,$2,$3,$4,'pending','approved',$5,$6,$7,$8,$9,
        jsonb_build_object('studentId',$4::uuid,'eligibilityStatus','approved','eligibilityReviewedAt','2026-08-03T11:00:00.000Z','updatedAt','2026-08-03T11:00:00.000Z','approvedAt','2026-08-03T11:00:00.000Z'))`, [uuid(), p.accountId, p.sessionId, extra.studentId, extra.reasonCode, extra.reason, key(), corr, extra.auditId]);
    expect((await mutate(p, extra)).outcome).toBe("idempotency_conflict");

    for (const family of ["case", "resolution", "adjustment"] as const) {
      const crossDomainTarget = await student(); const crossDomain = intent(crossDomainTarget, "approve", "documentation_verified");
      expect((await mutate(p, crossDomain)).outcome).toBe("updated");
      const audit = (await pool.query("SELECT correlation_id FROM downtown_u_operator_audit_events WHERE id=$1", [crossDomain.auditId])).rows[0];
      if (family === "case") {
        await controlled(`INSERT INTO downtown_u_operator_reconciliation_cases
          (id,source_type,source_id,student_id,reason_code,reason,idempotency_key,correlation_id,audit_event_id,created_by_operator_id,created_by_session_id,origin)
          VALUES($1,'refund',$2,$3,'documentation_verified','Cross-domain case fixture',$4,$5,$6,$7,$8,'operator')`,
        [uuid(), `cross-domain-${uuid()}`, crossDomainTarget.id, key(), audit.correlation_id, crossDomain.auditId, p.accountId, p.sessionId]);
      } else if (family === "resolution") {
        const caseId = uuid();
        await controlled(`INSERT INTO downtown_u_operator_reconciliation_cases
          (id,source_type,source_id,student_id,reason_code,reason,idempotency_key,correlation_id,origin)
          VALUES($1,'refund',$2,$3,'documentation_verified','Resolution source fixture',$4,$5,'source_sync')`,
        [caseId, `resolution-source-${uuid()}`, crossDomainTarget.id, key(), correlation()]);
        await controlled(`INSERT INTO downtown_u_operator_reconciliation_resolutions
          (id,case_id,operator_id,session_id,resolution_code,reason_code,reason,idempotency_key,correlation_id,audit_event_id,target_type,target_id)
          VALUES($1,$2,$3,$4,'reviewed','documentation_verified','Cross-domain resolution fixture',$5,$6,$7,'student',$8)`,
        [uuid(), caseId, p.accountId, p.sessionId, key(), audit.correlation_id, crossDomain.auditId, crossDomainTarget.id]);
      } else {
        await controlled(`INSERT INTO downtown_u_operator_adjustments
          (id,operator_id,session_id,student_id,delta,reason_code,reason,idempotency_key,correlation_id,audit_event_id,target_type,target_id)
          VALUES($1,$2,$3,$4,1,'documentation_verified','Cross-domain adjustment fixture',$5,$6,$7,'student',$8)`,
        [uuid(), p.accountId, p.sessionId, crossDomainTarget.id, key(), audit.correlation_id, crossDomain.auditId, crossDomainTarget.id]);
      }
      expect(await mutate(p, crossDomain)).toEqual({ outcome: "idempotency_conflict", replayed: false, item: null });
    }
  });

  it("preserves historical null snapshots but rejects their replay and every new null snapshot", async () => {
    const constraint = await pool.query(`SELECT convalidated,pg_get_constraintdef(oid,true) definition FROM pg_constraint
      WHERE conrelid='downtown_u_eligibility_events'::regclass AND conname='downtown_u_eligibility_events_result_item_not_null_check'`);
    expect(constraint.rows).toEqual([{ convalidated: false, definition: "CHECK (result_item IS NOT NULL) NOT VALID" }]);
    expect((await pool.query("SELECT result_item FROM downtown_u_eligibility_events WHERE id=$1", [historicalEventId])).rows[0].result_item).toBeNull();
    const historicalPrincipal = { accountId: historicalAccountId, sessionId: historicalSessionId, proof: historicalProof };
    const historicalIntent: Intent = { key: historicalKey, auditId: uuid(), eventId: uuid(), studentId: historicalStudentId,
      expectedStatus: "pending", expectedUpdatedAt: new Date("2026-08-03T10:00:00.123Z"), decision: "approve",
      reasonCode: "documentation_verified", reason: "Historical eligibility evidence" };
    expect(await mutate(historicalPrincipal, historicalIntent)).toEqual({ outcome: "idempotency_conflict", replayed: false, item: null });

    const p = await principal(); const target = await student(); const i = intent(target, "approve", "documentation_verified");
    expect((await mutate(p, i)).outcome).toBe("updated");
    await expect(controlled(`INSERT INTO downtown_u_eligibility_events
      (id,operator_id,session_id,student_id,from_status,to_status,reason_code,reason,idempotency_key,correlation_id,audit_event_id,created_at,result_item)
      SELECT $1,operator_id,session_id,$2,'pending','approved',reason_code,reason,$3,correlation_id,id,created_at,NULL
      FROM downtown_u_operator_audit_events WHERE id=$4`, [uuid(), target.id, key(), i.auditId])).rejects.toMatchObject({ code: "23514" });
  });

  it("bounds application audit/event ID collisions under a new idempotency key", async () => {
    const p = await principal(); const firstTarget = await student(); const first = intent(firstTarget, "approve", "documentation_verified");
    expect((await mutate(p, first)).outcome).toBe("updated");
    const auditCollision = intent(await student(), "approve", "documentation_verified"); auditCollision.auditId = first.auditId;
    const eventCollision = intent(await student(), "approve", "documentation_verified"); eventCollision.eventId = first.eventId;
    expect(await mutate(p, auditCollision)).toEqual({ outcome: "idempotency_conflict", replayed: false, item: null });
    expect(await mutate(p, eventCollision)).toEqual({ outcome: "idempotency_conflict", replayed: false, item: null });
    for (const collision of [auditCollision, eventCollision]) {
      expect((await pool.query("SELECT count(*)::int n FROM downtown_u_operator_audit_events WHERE idempotency_key=$1", [collision.key])).rows[0].n).toBe(0);
      expect((await pool.query("SELECT eligibility_status FROM downtown_u_students WHERE id=$1", [collision.studentId])).rows[0].eligibility_status).toBe("pending");
    }
  });

  it("keeps the stored response snapshot append-only", async () => {
    const p = await principal(); const target = await student(); const i = intent(target, "approve", "documentation_verified");
    const result = await mutate(p, i);
    expect((await pool.query("SELECT result_item FROM downtown_u_eligibility_events WHERE id=$1", [i.eventId])).rows[0].result_item).toEqual(result.item);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('downtown_u.operator_write',pg_backend_pid()::text||':'||pg_current_xact_id()::text,true)");
      await expect(client.query("UPDATE downtown_u_eligibility_events SET result_item='{}'::jsonb WHERE id=$1", [i.eventId])).rejects.toThrow(/append-only/);
      await client.query("ROLLBACK");
    } finally { await client.query("ROLLBACK").catch(() => undefined); client.release(); }
  });

  it("rechecks session/account/role/gates/fresh session-bound reauth including strict five-minute boundary", async () => {
    const target = await student();
    const cases: [string, Principal, () => Promise<void>, string][] = [
      ["wrong digest", await principal(), async () => undefined, "invalid"], ["disabled", await principal(), async () => undefined, "denied"],
      ["revoked role", await principal(), async () => undefined, "denied"], ["no reauth", await principal("eligibility_reviewer", "none"), async () => undefined, "reauth_required"],
      ["five minutes", await principal("eligibility_reviewer", "5 minutes"), async () => undefined, "reauth_required"],
    ];
    cases[0][1].proof = Buffer.alloc(32, 250);
    cases[1][2] = async () => { await pool.query("UPDATE downtown_u_operator_accounts SET status='disabled',disabled_at=clock_timestamp() WHERE id=$1", [cases[1][1].accountId]); };
    cases[2][2] = async () => { await pool.query("UPDATE downtown_u_operator_account_roles SET revoked_at=clock_timestamp(),revocation_reference='test:revoke' WHERE account_id=$1", [cases[2][1].accountId]); };
    for (const [, p, prepare, outcome] of cases) { await prepare(); expect((await mutate(p, intent(target, "approve", "documentation_verified"))).outcome).toBe(outcome); }
    const freshOther = await principal();
    const wrongSession = await principal("", "none", freshOther.accountId);
    expect((await mutate(wrongSession, intent(target, "approve", "documentation_verified"))).outcome).toBe("reauth_required");
    const wrongOperator = await principal();
    await expect(pool.query(`INSERT INTO downtown_u_operator_auth_challenges
      (id,operator_id,session_id,purpose,factor,status,challenge_verifier,created_at,updated_at,expires_at,verified_at,consumed_at)
      VALUES($1,$2,$3,'reauth','sms_otp','consumed',$4,statement_timestamp()-interval '2 minutes',statement_timestamp()-interval '1 minute',statement_timestamp()+interval '4 minutes',statement_timestamp()-interval '1 minute',statement_timestamp()-interval '1 minute')`,
    [uuid(), wrongOperator.accountId, wrongSession.sessionId, verifier()])).rejects.toMatchObject({ code: "23503" });
    const future = await principal("eligibility_reviewer", "none");
    await pool.query(`INSERT INTO downtown_u_operator_auth_challenges
      (id,operator_id,session_id,purpose,factor,status,challenge_verifier,created_at,updated_at,expires_at,verified_at,consumed_at)
      VALUES($1,$2,$3,'reauth','sms_otp','consumed',$4,statement_timestamp()-interval '1 minute',statement_timestamp()+interval '1 minute',statement_timestamp()+interval '5 minutes',statement_timestamp()+interval '1 minute',statement_timestamp()+interval '1 minute')`,
    [uuid(), future.accountId, future.sessionId, verifier()]);
    expect((await mutate(future, intent(target, "approve", "documentation_verified"))).outcome).toBe("reauth_required");
    await pool.query("UPDATE downtown_u_operator_config SET read_enabled=false,updated_at=clock_timestamp()");
    try { expect((await mutate(await principal(), intent(target, "approve", "documentation_verified"))).outcome).toBe("denied"); }
    finally { await pool.query("UPDATE downtown_u_operator_config SET read_enabled=true,updated_at=clock_timestamp()"); }
  });

  it("rolls student and both evidence inserts back on a forced mid-capability failure", async () => {
    const p = await principal(); const target = await student(); const before = await snapshot(target.id); const i = intent(target, "approve", "documentation_verified");
    await pool.query(`CREATE FUNCTION public.du_test_fail_eligibility() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'forced eligibility evidence failure'; END$$`);
    await pool.query("CREATE TRIGGER du_test_fail_eligibility BEFORE INSERT ON downtown_u_eligibility_events FOR EACH ROW EXECUTE FUNCTION public.du_test_fail_eligibility()");
    try { await expect(mutate(p, i)).rejects.toThrow(/forced eligibility evidence failure/); }
    finally { await pool.query("DROP TRIGGER du_test_fail_eligibility ON downtown_u_eligibility_events"); await pool.query("DROP FUNCTION public.du_test_fail_eligibility()") }
    expect(await snapshot(target.id)).toEqual(before);
    expect((await pool.query("SELECT count(*)::int n FROM downtown_u_operator_audit_events WHERE id=$1", [i.auditId])).rows[0].n).toBe(0);
  });

  it("serializes same-key and different-key same-student contenders without deadlocks or raw errors", async () => {
    const p = await principal(); const target = await student(); const i = intent(target, "approve", "documentation_verified");
    const a = await pool.connect(), b = await pool.connect();
    try {
      await a.query("BEGIN"); await a.query(`SET LOCAL SESSION AUTHORIZATION ${qi(operatorLogin)}`);
      expect((await mutate(p, i, {}, a)).outcome).toBe("updated");
      await b.query("BEGIN"); await b.query(`SET LOCAL SESSION AUTHORIZATION ${qi(operatorLogin)}`); await b.query("SET LOCAL statement_timeout='2s'");
      const waiting = mutate(p, i, { auditId: uuid(), eventId: uuid() }, b);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100)); await a.query("COMMIT");
      expect(await waiting).toMatchObject({ outcome: "updated", replayed: true }); await b.query("COMMIT");
    } catch (error) { await a.query("ROLLBACK").catch(() => undefined); await b.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { a.release(); b.release(); }

    const target2 = await student(); const x = intent(target2, "approve", "documentation_verified"); const y = intent(target2, "reject", "policy_ineligible");
    const results = await Promise.all([mutate(p, x), mutate(p, y)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["stale_state", "updated"]);
    expect(results.every((r) => r.outcome !== "deadlock_detected")).toBe(true);
  });

  it("linearizes role, gate and account races behind authorization locks", async () => {
    for (const update of [
      "UPDATE downtown_u_operator_accounts SET status='disabled',disabled_at=clock_timestamp() WHERE id=$1",
      "UPDATE downtown_u_operator_account_roles SET revoked_at=clock_timestamp(),revocation_reference='race:revoke' WHERE account_id=$1 AND revoked_at IS NULL",
      "UPDATE downtown_u_operator_config SET mutations_enabled=false,updated_at=clock_timestamp() WHERE singleton=true",
    ]) {
      const p = await principal(); const target = await student(); const actor = await pool.connect(); const owner = await pool.connect();
      try {
        await actor.query("BEGIN"); await actor.query(`SET LOCAL SESSION AUTHORIZATION ${qi(operatorLogin)}`);
        expect((await mutate(p, intent(target, "approve", "documentation_verified"), {}, actor)).outcome).toBe("updated");
        await owner.query("BEGIN"); await owner.query("SET LOCAL statement_timeout='250ms'");
        await expect(owner.query(update, update.includes("config") ? [] : [p.accountId])).rejects.toMatchObject({ code: "57014" });
        await owner.query("ROLLBACK"); await actor.query("ROLLBACK");
      } finally { await owner.query("ROLLBACK").catch(() => undefined); await actor.query("ROLLBACK").catch(() => undefined); owner.release(); actor.release(); }
    }
  });

  it("denies reverse-order owner disable, role revoke and gate races without writes or deadlock", async () => {
    for (const update of [
      "UPDATE downtown_u_operator_accounts SET status='disabled',disabled_at=clock_timestamp() WHERE id=$1",
      "UPDATE downtown_u_operator_account_roles SET revoked_at=clock_timestamp(),revocation_reference='race:reverse' WHERE account_id=$1 AND revoked_at IS NULL",
      "UPDATE downtown_u_operator_config SET mutations_enabled=false,updated_at=clock_timestamp() WHERE singleton=true",
    ]) {
      const p = await principal(); const target = await student(); const before = await snapshot(target.id); const i = intent(target, "approve", "documentation_verified");
      const owner = await pool.connect(); const actor = await pool.connect();
      try {
        await owner.query("BEGIN");
        await owner.query(update, update.includes("config") ? [] : [p.accountId]);
        await actor.query("BEGIN"); await actor.query(`SET LOCAL SESSION AUTHORIZATION ${qi(operatorLogin)}`);
        await actor.query("SET LOCAL statement_timeout='2s'");
        const waiting = mutate(p, i, {}, actor);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        await owner.query("COMMIT");
        expect(await waiting).toEqual({ outcome: "denied", replayed: false, item: null });
        await actor.query("COMMIT");
        expect(await snapshot(target.id)).toEqual(before);
        expect((await pool.query("SELECT count(*)::int n FROM downtown_u_operator_audit_events WHERE idempotency_key=$1", [i.key])).rows[0].n).toBe(0);
      } finally {
        await owner.query("ROLLBACK").catch(() => undefined); await actor.query("ROLLBACK").catch(() => undefined);
        owner.release(); actor.release();
        if (update.includes("config")) await pool.query("UPDATE downtown_u_operator_config SET mutations_enabled=true,updated_at=clock_timestamp()");
      }
    }
  });

  it("exposes exactly twelve functions and no direct relation, sequence, column or hostile-default privilege", async () => {
    await asOperator(async (client) => {
      const functions = await client.query(`SELECT p.oid::regprocedure::text name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname LIKE 'downtown_u_operator_%' AND has_function_privilege(current_user,p.oid,'EXECUTE')`);
      expect(functions.rows).toHaveLength(12);
      expect(functions.rows.filter((r) => r.name.startsWith("downtown_u_operator_set_eligibility("))).toHaveLength(1);
      const leaks = await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r' AND (has_table_privilege(current_user,c.oid,'SELECT') OR has_table_privilege(current_user,c.oid,'INSERT') OR has_table_privilege(current_user,c.oid,'UPDATE'))`);
      expect(leaks.rows).toEqual([]);
      const sequenceLeaks = await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='S' AND (has_sequence_privilege(current_user,c.oid,'USAGE') OR has_sequence_privilege(current_user,c.oid,'SELECT'))`);
      expect(sequenceLeaks.rows).toEqual([]);
      const columnLeaks = await client.query(`SELECT c.relname,a.attname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        WHERE n.nspname='public' AND c.relkind='r' AND (has_column_privilege(current_user,c.oid,a.attnum,'SELECT') OR has_column_privilege(current_user,c.oid,a.attnum,'UPDATE'))`);
      expect(columnLeaks.rows).toEqual([]);
      await expect(client.query("SELECT * FROM downtown_u_students LIMIT 0")).rejects.toMatchObject({ code: "42501" });
    });
    expect((await pool.query(`SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND (has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT') OR has_table_privilege($1,c.oid,'UPDATE'))`, [hostileRole])).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND has_function_privilege($1,p.oid,'EXECUTE')`, [hostileRole])).rows[0].n).toBe(0);
  });
});
