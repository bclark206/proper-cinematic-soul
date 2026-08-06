import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const baseUrl = process.env.TEST_DATABASE_URL;
const run = baseUrl ? describe : describe.skip;
const suffix = `${process.pid}_${Date.now()}`;
const databaseName = `downtown_u_operator_auth_${suffix}`;
const operatorLogin = `du_operator_auth_login_${suffix}`;
const hostileRole = `du_operator_auth_hostile_${suffix}`;
const migrationNames = [
  "202608040001_downtown_u_phase1.sql", "202608040002_downtown_u_webhook_events.sql",
  "202608040003_downtown_u_payment_activation.sql", "202608040004_downtown_u_refund_activation.sql",
  "202608040005_downtown_u_auth.sql", "202608040006_downtown_u_student_portal.sql",
  "202608040007_downtown_u_checkout.sql", "202608040008_downtown_u_kitchen_outbox.sql",
  "202608040009_downtown_u_operator_audit.sql", "202608040010_downtown_u_operator_auth_capabilities.sql",
];
const migrations = migrationNames.map((name) => readFileSync(resolve(process.cwd(), "db/migrations", name), "utf8"));
let admin: Pool;
let pool: Pool;
let counter = 0;

function qi(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
function verifier(): Buffer { counter += 1; const result = Buffer.alloc(32); result.writeUInt32BE(counter, 28); return result; }
function uuid(): string { counter += 1; return `10000000-0000-4000-8000-${counter.toString().padStart(12, "0")}`; }
function code(error: unknown): string | undefined { return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined; }
async function principal<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query(`SET SESSION AUTHORIZATION ${qi(operatorLogin)}`); return await operation(client); }
  finally { await client.query("RESET SESSION AUTHORIZATION").catch(() => undefined); client.release(); }
}
async function provision(label: string, activeRole = true): Promise<{ id: string; email: string; phone: string }> {
  const email = `${label}-${counter++}@example.edu`;
  const phone = `+1202${String(5550000 + counter).padStart(7, "0")}`;
  const id = (await pool.query<{ id: string }>(`INSERT INTO downtown_u_operator_accounts
    (normalized_email,normalized_phone,display_name,provisioning_reference) VALUES ($1,$2,$3,$4) RETURNING id`,
  [email, phone, `Operator ${label}`, `provision:${label}:${counter}`])).rows[0].id;
  if (activeRole) await pool.query(`INSERT INTO downtown_u_operator_account_roles(account_id,role_code,assigned_by_reference)
    VALUES ($1,'eligibility_reviewer',$2)`, [id, `assign:${label}:${counter}`]);
  return { id, email, phone };
}
type Begun = { outcome: string; email_challenge_id: string | null; expires_at: Date | null; flowId: string; flow: Buffer; emailProof: Buffer };
async function begin(email: string): Promise<Begun> {
  const flowId = uuid(); const emailId = uuid(); const flow = verifier(); const emailProof = verifier();
  const row = await principal(async (client) => (await client.query(`SELECT * FROM downtown_u_operator_auth_begin($1,$2,$3,$4,$5,$6,$7)`,
    [flowId, email, 1, flow, emailId, emailProof, `begin-correlation-${counter++}`])).rows[0]);
  return { ...row, flowId, flow, emailProof };
}
type Sms = { outcome: string; sms_challenge_id: string | null; normalized_phone: string | null; expires_at: Date | null; smsId: string; smsProof: Buffer };
async function verifyEmail(auth: Begun, emailId = auth.email_challenge_id!, proof = auth.emailProof): Promise<Sms> {
  const smsId = uuid(); const smsProof = verifier();
  const row = await principal(async (client) => (await client.query(`SELECT * FROM downtown_u_operator_auth_verify_email($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [auth.flowId, 1, auth.flow, emailId, 1, proof, smsId, 1, smsProof, `email-correlation-${counter++}`])).rows[0]);
  return { ...row, smsId, smsProof };
}
async function finish(auth: Begun, sms: Sms, sessionId = uuid(), sessionProof = verifier()) {
  const row = await principal(async (client) => (await client.query(`SELECT * FROM downtown_u_operator_auth_finish_sign_in($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [auth.flowId, 1, auth.flow, sms.smsId, 1, sms.smsProof, sessionId, 1, sessionProof, `finish-correlation-${counter++}`])).rows[0]);
  return { ...row, requestedSessionId: sessionId, sessionProof };
}
async function validate(session: { requestedSessionId: string; sessionProof: Buffer }, role: string | null, gate: string, proof = session.sessionProof) {
  return principal(async (client) => (await client.query(`SELECT * FROM downtown_u_operator_auth_validate_session($1,1::smallint,$2,$3,$4,$5)`,
    [session.requestedSessionId, proof, role, gate, `validate-correlation-${counter++}`])).rows[0]);
}
async function beginReauth(session: { requestedSessionId: string; sessionProof: Buffer }) {
  const challengeId = uuid(); const challengeProof = verifier();
  const row = await principal(async (client) => (await client.query(`SELECT * FROM downtown_u_operator_auth_begin_reauth($1,1::smallint,$2,$3,1::smallint,$4,$5)`,
    [session.requestedSessionId, session.sessionProof, challengeId, challengeProof, `reauth-begin-correlation-${counter++}`])).rows[0]);
  return { ...row, challengeId, challengeProof };
}
async function finishReauth(session: { requestedSessionId: string; sessionProof: Buffer }, challenge: { challengeId: string; challengeProof: Buffer }, proof = challenge.challengeProof) {
  return principal(async (client) => (await client.query(`SELECT * FROM downtown_u_operator_auth_finish_reauth($1,1::smallint,$2,$3,1::smallint,$4,$5)`,
    [session.requestedSessionId, session.sessionProof, challenge.challengeId, proof, `reauth-finish-correlation-${counter++}`])).rows[0]);
}
async function revoke(sessionId: string, proof: Buffer) {
  return principal(async (client) => (await client.query(`SELECT * FROM downtown_u_operator_auth_revoke_session($1,1::smallint,$2,$3)`,
    [sessionId, proof, `revoke-correlation-${counter++}`])).rows[0]);
}
async function waitBlocked(pid:number):Promise<void>{
  for(let attempt=0;attempt<100;attempt+=1){
    const row=(await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0];
    if(row?.wait_event_type==="Lock") return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error(`backend ${pid} did not reach lock barrier`);
}
async function lockOrderRace(kind: "verify" | "finish"): Promise<void> {
  const operator = await provision(`lock-${kind}-${counter}`); const auth = await begin(operator.email);
  const sms = kind === "finish" ? await verifyEmail(auth) : undefined;
  await pool.query("UPDATE downtown_u_operator_auth_flows SET created_at=created_at-interval '2 minutes' WHERE id=$1", [auth.flowId]);
  const blocker=await pool.connect(); const beginClient=await pool.connect(); const proofClient=await pool.connect();
  const nextFlow=uuid(); const nextEmail=uuid();
  try {
    const beginPid=(await beginClient.query<{pid:number}>("SELECT pg_backend_pid() pid")).rows[0].pid;
    const proofPid=(await proofClient.query<{pid:number}>("SELECT pg_backend_pid() pid")).rows[0].pid;
    await blocker.query("BEGIN"); await blocker.query("SELECT 1 FROM downtown_u_operator_accounts WHERE id=$1 FOR UPDATE",[operator.id]);
    for (const client of [beginClient,proofClient]) {
      await client.query("BEGIN"); await client.query("SET LOCAL lock_timeout='4s'");
      await client.query(`SET LOCAL SESSION AUTHORIZATION ${qi(operatorLogin)}`);
    }
    const beginning=beginClient.query("SELECT * FROM downtown_u_operator_auth_begin($1,$2,1::smallint,$3,$4,$5,$6)",
      [nextFlow,operator.email,verifier(),nextEmail,verifier(),`lock-begin-correlation-${counter++}`])
      .then(async result=>{await beginClient.query("COMMIT");return result;});
    await waitBlocked(beginPid);
    const proving=(kind==="verify"
      ? proofClient.query("SELECT * FROM downtown_u_operator_auth_verify_email($1,1::smallint,$2,$3,1::smallint,$4,$5,1::smallint,$6,$7)",
        [auth.flowId,auth.flow,auth.email_challenge_id,auth.emailProof,uuid(),verifier(),`lock-email-correlation-${counter++}`])
      : proofClient.query("SELECT * FROM downtown_u_operator_auth_finish_sign_in($1,1::smallint,$2,$3,1::smallint,$4,$5,1::smallint,$6,$7)",
        [auth.flowId,auth.flow,sms!.smsId,sms!.smsProof,uuid(),verifier(),`lock-finish-correlation-${counter++}`]))
      .then(async result=>{await proofClient.query("COMMIT");return result;});
    await waitBlocked(proofPid); await blocker.query("COMMIT");
    const settled=await Promise.allSettled([beginning,proving]);
    const errors=settled.filter((x):x is PromiseRejectedResult=>x.status==="rejected").map(x=>code(x.reason));
    expect(errors).not.toContain("40P01"); expect(errors).not.toContain("55P03");
    expect(settled.every(x=>x.status==="fulfilled")).toBe(true);
    const state=await pool.query("SELECT status,count(*) OVER()::int total FROM downtown_u_operator_auth_flows WHERE operator_id=$1 ORDER BY created_at DESC LIMIT 1",[operator.id]);
    expect(state.rows).toHaveLength(1); expect(state.rows[0]).toMatchObject({status:"pending_email",total:2});
  } finally {
    await blocker.query("ROLLBACK").catch(()=>undefined); await beginClient.query("ROLLBACK").catch(()=>undefined); await proofClient.query("ROLLBACK").catch(()=>undefined);
    blocker.release(); beginClient.release(); proofClient.release();
  }
}

run.sequential("operator C1+C2 authentication capabilities on real PostgreSQL 16", () => {
  beforeAll(async () => {
    const parsed = new URL(baseUrl!); const baseDatabase = parsed.pathname.slice(1);
    if (!["", "localhost", "127.0.0.1", "::1"].includes(parsed.hostname) && !/(test|disposable)/i.test(baseDatabase)) throw new Error("TEST_DATABASE_URL must be local or test-named");
    admin = new Pool({ connectionString: baseUrl, max: 2 });
    const version = Number((await admin.query("SHOW server_version_num")).rows[0].server_version_num);
    if (version < 160000 || version >= 170000) throw new Error(`PostgreSQL 16 required, got ${version}`);
    await admin.query(`CREATE DATABASE ${qi(databaseName)}`);
    await admin.query(`CREATE ROLE ${qi(hostileRole)} NOLOGIN`);
    const url = new URL(baseUrl!); url.pathname = `/${databaseName}`; pool = new Pool({ connectionString: url.toString(), max: 12 });
    for (const migration of migrations.slice(0, 9)) await pool.query(migration);
    await pool.query(`ALTER DEFAULT PRIVILEGES GRANT SELECT,INSERT,UPDATE ON TABLES TO ${qi(hostileRole)}`);
    await pool.query(`ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO ${qi(hostileRole)}`);
    await pool.query(migrations[9]);
    await admin.query(`CREATE ROLE ${qi(operatorLogin)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(`GRANT downtown_u_operator_runtime TO ${qi(operatorLogin)}`);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP ROLE IF EXISTS ${qi(operatorLogin)}`).catch(async () => { await admin.query(`REVOKE downtown_u_operator_runtime FROM ${qi(operatorLogin)}`); await admin.query(`DROP ROLE ${qi(operatorLogin)}`); });
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${qi(databaseName)}`);
      await admin.query(`DROP ROLE IF EXISTS ${qi(hostileRole)}`);
      await admin.end();
    }
  }, 30_000);

  it("denies every direct relation and exposes exactly seven non-grantable executes", async () => {
    await principal(async (client) => {
      expect((await client.query("SELECT has_schema_privilege(current_user,'public','USAGE') AS usage,has_schema_privilege(current_user,'public','CREATE') AS can_create")).rows[0]).toEqual({ usage: true, can_create: false });
      await expect(client.query("SELECT * FROM downtown_u_operator_accounts")).rejects.toSatisfy((error: unknown) => code(error) === "42501");
      const functions = (await client.query(`SELECT p.oid::regprocedure::text signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname LIKE 'downtown_u_operator_%' AND has_function_privilege(current_user,p.oid,'EXECUTE') ORDER BY 1`)).rows.map((row) => row.signature);
      expect(functions).toHaveLength(7);
      expect(functions.join("\n")).toContain("downtown_u_operator_auth_begin");
      expect(functions.join("\n")).toContain("downtown_u_operator_auth_verify_email");
      expect(functions.join("\n")).toContain("downtown_u_operator_auth_finish_sign_in");
      expect(functions.join("\n")).toContain("downtown_u_operator_auth_validate_session");
      expect(functions.join("\n")).toContain("downtown_u_operator_auth_begin_reauth");
      expect(functions.join("\n")).toContain("downtown_u_operator_auth_finish_reauth");
      expect(functions.join("\n")).toContain("downtown_u_operator_auth_revoke_session");
    });
    const leaked = await pool.query(`SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      AND (c.relname LIKE 'downtown_u_operator_%' OR c.relname='downtown_u_eligibility_events') AND c.relowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user)`);
    expect(leaked.rows[0].n).toBe(0);
  });

  it("makes unknown, disabled, malformed and rate-limited begin responses indistinguishable", async () => {
    const unknown = await begin("unknown@example.edu");
    expect(unknown).toMatchObject({ outcome: "accepted", email_challenge_id: null, expires_at: null });
    const disabled = await provision("disabled");
    await pool.query("UPDATE downtown_u_operator_accounts SET status='disabled',disabled_at=clock_timestamp() WHERE id=$1", [disabled.id]);
    const disabledResult = await begin(disabled.email);
    const malformed = await begin(` ${disabled.email}`);
    expect(disabledResult).toMatchObject({ outcome: "accepted", email_challenge_id: null, expires_at: null });
    expect(malformed).toMatchObject({ outcome: "accepted", email_challenge_id: null, expires_at: null });
    const known = await provision("rate");
    expect((await begin(known.email)).email_challenge_id).not.toBeNull();
    expect(await begin(known.email)).toMatchObject({ outcome: "accepted", email_challenge_id: null, expires_at: null });
    const unknownEvents = await pool.query("SELECT operator_id,flow_id,session_id FROM downtown_u_operator_security_events WHERE correlation_id LIKE 'begin-correlation-%' AND operator_id IS NULL");
    expect(unknownEvents.rows.length).toBeGreaterThanOrEqual(2);
    expect(unknownEvents.rows.every((row) => row.flow_id === null && row.session_id === null)).toBe(true);
  });

  it("requires email before SMS, bounds wrong attempts at five, and rejects replay/cross-flow", async () => {
    const first = await provision("proof-a"); const second = await provision("proof-b");
    const auth = await begin(first.email); const other = await begin(second.email);
    const premature = await finish(auth, { outcome: "invalid", sms_challenge_id: null, normalized_phone: null, expires_at: null, smsId: uuid(), smsProof: verifier() });
    expect(premature.outcome).toBe("invalid");
    expect((await verifyEmail(auth, other.email_challenge_id!, auth.emailProof)).outcome).toBe("invalid");
    for (let attempt = 1; attempt <= 6; attempt += 1) expect((await verifyEmail(auth, auth.email_challenge_id!, verifier())).outcome).toBe("invalid");
    expect((await pool.query("SELECT attempt_count,status FROM downtown_u_operator_auth_challenges WHERE id=$1", [auth.email_challenge_id])).rows[0]).toEqual({ attempt_count: 5, status: "revoked" });
    expect((await verifyEmail(auth)).outcome).toBe("invalid");
  });

  it("consumes email exactly once, creates unique SMS, and returns immutable phone only on success", async () => {
    const operator = await provision("email-success"); const auth = await begin(operator.email); const sms = await verifyEmail(auth);
    expect(sms).toMatchObject({ outcome: "verified", sms_challenge_id: sms.smsId, normalized_phone: operator.phone });
    expect((await verifyEmail(auth)).outcome).toBe("invalid");
    const rows = await pool.query("SELECT factor,status,verified_at=consumed_at same_time FROM downtown_u_operator_auth_challenges WHERE flow_id=$1 ORDER BY factor", [auth.flowId]);
    expect(rows.rows).toEqual([{ factor: "email_magic_link", status: "consumed", same_time: true }, { factor: "sms_otp", status: "pending", same_time: null }]);
  });

  it("bounds wrong SMS attempts at five and terminally revokes the flow", async () => {
    const operator = await provision("sms-attempts"); const auth = await begin(operator.email); const sms = await verifyEmail(auth);
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      expect((await finish(auth, { ...sms, smsProof: verifier() })).outcome).toBe("invalid");
    }
    expect((await pool.query("SELECT attempt_count,status FROM downtown_u_operator_auth_challenges WHERE id=$1", [sms.smsId])).rows[0])
      .toEqual({ attempt_count: 5, status: "revoked" });
    expect((await pool.query("SELECT status FROM downtown_u_operator_auth_flows WHERE id=$1", [auth.flowId])).rows[0].status).toBe("revoked");
  });

  it("requires active account and a current role at finish", async () => {
    const noRole = await provision("no-role", false); const auth = await begin(noRole.email); const sms = await verifyEmail(auth);
    expect((await finish(auth, sms)).outcome).toBe("invalid");
    await pool.query("INSERT INTO downtown_u_operator_account_roles(account_id,role_code,assigned_by_reference) VALUES ($1,'audit_exporter','assign:no-role')", [noRole.id]);
    await pool.query("UPDATE downtown_u_operator_accounts SET status='disabled',disabled_at=clock_timestamp() WHERE id=$1", [noRole.id]);
    expect((await finish(auth, sms)).outcome).toBe("invalid");
  });

  it("mints exactly one 8h/30m MFA session and rejects replay", async () => {
    const operator = await provision("mint"); const auth = await begin(operator.email); const sms = await verifyEmail(auth); const result = await finish(auth, sms);
    expect(result).toMatchObject({ outcome: "authenticated", session_id: result.requestedSessionId, operator_id: operator.id, display_name: "Operator mint", role_codes: ["eligibility_reviewer"] });
    expect(new Date(result.absolute_expires).getTime() - new Date(result.idle_expires).getTime()).toBe(7.5 * 60 * 60 * 1000);
    expect((await finish(auth, sms)).outcome).toBe("invalid");
    expect((await pool.query("SELECT count(*)::int n FROM downtown_u_operator_sessions WHERE consumed_auth_flow_id=$1", [auth.flowId])).rows[0].n).toBe(1);
  });

  it("serializes concurrent finish so exactly one caller mints", async () => {
    const operator = await provision("concurrent"); const auth = await begin(operator.email); const sms = await verifyEmail(auth);
    const [a, b] = await Promise.all([finish(auth, sms), finish(auth, sms)]);
    expect([a.outcome, b.outcome].sort()).toEqual(["authenticated", "invalid"]);
    expect((await pool.query("SELECT count(*)::int n FROM downtown_u_operator_sessions WHERE consumed_auth_flow_id=$1", [auth.flowId])).rows[0].n).toBe(1);
  });

  it("keeps account-flow-challenge lock order for begin versus verify-email",async()=>{
    for(let run=0;run<3;run+=1) await lockOrderRace("verify");
  },20_000);

  it("keeps account-flow-challenge lock order for begin versus finish-sign-in",async()=>{
    for(let run=0;run<3;run+=1) await lockOrderRace("finish");
  },20_000);

  it("propagates session UUID/digest collisions and rolls all factor state back", async () => {
    const source = await provision("collision-source"); const sa = await begin(source.email); const ss = await verifyEmail(sa); const minted = await finish(sa, ss);
    const target = await provision("collision-target"); const ta = await begin(target.email); const ts = await verifyEmail(ta);
    await expect(finish(ta, ts, minted.session_id, verifier())).rejects.toSatisfy((error: unknown) => code(error) === "23505");
    let state = (await pool.query("SELECT f.status flow,c.status sms FROM downtown_u_operator_auth_flows f JOIN downtown_u_operator_auth_challenges c ON c.flow_id=f.id AND c.factor='sms_otp' WHERE f.id=$1", [ta.flowId])).rows[0];
    expect(state).toEqual({ flow: "pending_sms", sms: "pending" });
    await expect(finish(ta, ts, uuid(), minted.sessionProof)).rejects.toSatisfy((error: unknown) => code(error) === "23505");
    state = (await pool.query("SELECT f.status flow,c.status sms FROM downtown_u_operator_auth_flows f JOIN downtown_u_operator_auth_challenges c ON c.flow_id=f.id AND c.factor='sms_otp' WHERE f.id=$1", [ta.flowId])).rows[0];
    expect(state).toEqual({ flow: "pending_sms", sms: "pending" });
    expect((await finish(ta, ts)).outcome).toBe("authenticated");
  });

  it("authorizes the fixed role/gate matrix, honors default-off gates, and never rolls denied or invalid sessions", async () => {
    const operator = await provision("matrix");
    for (const role of ["reconciliation_operator", "credit_adjuster", "audit_exporter"]) {
      await pool.query("INSERT INTO downtown_u_operator_account_roles(account_id,role_code,assigned_by_reference) VALUES ($1,$2,$3)", [operator.id, role, `assign:matrix:${role}`]);
    }
    // Mint through the ordinary C1 path without bypassing factor checks.
    const auth = await begin(operator.email); const sms = await verifyEmail(auth); const minted = await finish(auth, sms);
    const before = (await pool.query("SELECT last_seen_at FROM downtown_u_operator_sessions WHERE id=$1", [minted.requestedSessionId])).rows[0].last_seen_at;
    expect((await validate(minted, "eligibility_reviewer", "read")).outcome).toBe("denied");
    expect((await validate(minted, "eligibility_reviewer", "read", verifier())).outcome).toBe("invalid");
    expect((await pool.query("SELECT last_seen_at FROM downtown_u_operator_sessions WHERE id=$1", [minted.requestedSessionId])).rows[0].last_seen_at).toEqual(before);
    await pool.query("UPDATE downtown_u_operator_config SET read_enabled=true,mutations_enabled=true,exports_enabled=true,updated_at=clock_timestamp()");
    for (const role of ["eligibility_reviewer", "reconciliation_operator", "credit_adjuster"]) {
      expect((await validate(minted, role, "read")).outcome).toBe("authorized");
      expect((await validate(minted, role, "mutations")).outcome).toBe("reauth_required");
      expect((await validate(minted, role, "exports")).outcome).toBe("denied");
    }
    expect((await validate(minted, "audit_exporter", "read")).outcome).toBe("authorized");
    expect((await validate(minted, "audit_exporter", "exports")).outcome).toBe("reauth_required");
    expect((await validate(minted, "audit_exporter", "mutations")).outcome).toBe("denied");
    expect((await validate(minted, null, "read")).role_codes).toEqual(["audit_exporter", "credit_adjuster", "eligibility_reviewer", "reconciliation_operator"]);
    await pool.query("UPDATE downtown_u_operator_account_roles SET revoked_at=clock_timestamp(),revocation_reference='revoke:matrix:test' WHERE account_id=$1 AND role_code='eligibility_reviewer' AND revoked_at IS NULL", [operator.id]);
    const afterRevoke = await validate(minted, "eligibility_reviewer", "read");
    expect(afterRevoke.outcome).toBe("denied");
    expect(afterRevoke.role_codes).toEqual(["audit_exporter", "credit_adjuster", "reconciliation_operator"]);
  });

  it("performs session-bound reauth, enforces attempts/replay/cross-session and exact five-minute freshness", async () => {
    const a = await provision("reauth-a"); const aa = await begin(a.email); const as = await verifyEmail(aa); const sessionA = await finish(aa, as);
    const b = await provision("reauth-b"); const ba = await begin(b.email); const bs = await verifyEmail(ba); const sessionB = await finish(ba, bs);
    await pool.query("UPDATE downtown_u_operator_config SET read_enabled=true,mutations_enabled=true,updated_at=clock_timestamp()");
    const challenge = await beginReauth(sessionA);
    expect(challenge).toMatchObject({ outcome: "started", challenge_id: challenge.challengeId, normalized_phone: a.phone });
    expect((await beginReauth(sessionA)).outcome).toBe("denied");
    expect((await finishReauth(sessionB, challenge)).outcome).toBe("invalid");
    for (let n = 0; n < 4; n += 1) expect((await finishReauth(sessionA, challenge, verifier())).outcome).toBe("invalid");
    expect((await finishReauth(sessionA, challenge)).outcome).toBe("reauthenticated");
    expect((await finishReauth(sessionA, challenge)).outcome).toBe("invalid");
    expect((await validate(sessionA, "eligibility_reviewer", "mutations")).outcome).toBe("authorized");
    await pool.query(`UPDATE downtown_u_operator_auth_challenges SET created_at=clock_timestamp()-interval '6 minutes',
      verified_at=clock_timestamp()-interval '5 minutes',consumed_at=clock_timestamp()-interval '5 minutes',
      expires_at=clock_timestamp()+interval '4 minutes',updated_at=clock_timestamp() WHERE id=$1`, [challenge.challengeId]);
    expect((await validate(sessionA, "eligibility_reviewer", "mutations")).outcome).toBe("reauth_required");
  });

  it("bounds wrong reauth attempts at five and lazily expires stale sessions", async () => {
    const operator = await provision("reauth-bounds"); const auth = await begin(operator.email); const sms = await verifyEmail(auth); const session = await finish(auth, sms);
    await pool.query("UPDATE downtown_u_operator_config SET read_enabled=true,updated_at=clock_timestamp()");
    const challenge = await beginReauth(session);
    for (let n = 0; n < 6; n += 1) expect((await finishReauth(session, challenge, verifier())).outcome).toBe("invalid");
    expect((await pool.query("SELECT attempt_count,status FROM downtown_u_operator_auth_challenges WHERE id=$1", [challenge.challengeId])).rows[0]).toEqual({ attempt_count: 5, status: "revoked" });
    await pool.query("UPDATE downtown_u_operator_sessions SET idle_expires_at=clock_timestamp()+interval '10 milliseconds',updated_at=clock_timestamp() WHERE id=$1", [session.requestedSessionId]);
    await pool.query("SELECT pg_sleep(0.03)");
    expect((await validate(session, null, "read")).outcome).toBe("invalid");
    expect((await pool.query("SELECT status FROM downtown_u_operator_sessions WHERE id=$1", [session.requestedSessionId])).rows[0].status).toBe("expired");
  });

  it("logs out with a constant replay-safe result, binds credentials, clears pending reauth, and ignores account/gate state", async () => {
    const operator = await provision("logout"); const auth = await begin(operator.email); const sms = await verifyEmail(auth); const session = await finish(auth, sms);
    await pool.query("UPDATE downtown_u_operator_config SET read_enabled=true,updated_at=clock_timestamp()");
    const challenges = await Promise.all([beginReauth(session), beginReauth(session)]);
    expect(challenges.map((row) => row.outcome).sort()).toEqual(["denied", "started"]);
    const challenge = challenges.find((row) => row.outcome === "started")!;
    expect((await pool.query("SELECT count(*)::int n FROM downtown_u_operator_auth_challenges WHERE session_id=$1 AND purpose='reauth' AND status='pending'", [session.requestedSessionId])).rows[0].n).toBe(1);
    expect(await revoke(session.requestedSessionId, verifier())).toEqual({ outcome: "accepted" });
    expect((await pool.query("SELECT status FROM downtown_u_operator_sessions WHERE id=$1", [session.requestedSessionId])).rows[0].status).toBe("active");
    await pool.query("UPDATE downtown_u_operator_accounts SET status='disabled',disabled_at=clock_timestamp() WHERE id=$1", [operator.id]);
    expect((await validate(session, null, "read")).outcome).toBe("invalid");
    await pool.query("UPDATE downtown_u_operator_config SET read_enabled=false,updated_at=clock_timestamp()");
    expect(await revoke(session.requestedSessionId, session.sessionProof)).toEqual({ outcome: "accepted" });
    expect(await revoke(session.requestedSessionId, session.sessionProof)).toEqual({ outcome: "accepted" });
    expect(await revoke(uuid(), verifier())).toEqual({ outcome: "accepted" });
    expect((await pool.query("SELECT status,revoked_at IS NOT NULL revoked FROM downtown_u_operator_sessions WHERE id=$1", [session.requestedSessionId])).rows[0]).toEqual({ status: "revoked", revoked: true });
    expect((await pool.query("SELECT status FROM downtown_u_operator_auth_challenges WHERE id=$1", [challenge.challengeId])).rows[0].status).toBe("revoked");
    expect((await pool.query("SELECT count(*)::int n FROM downtown_u_operator_security_events WHERE session_id=$1 AND event_code='revocation'", [session.requestedSessionId])).rows[0].n).toBe(1);
  });

  it("expires stale proofs generically and keeps bounded identifier-free evidence with exact ACLs", async () => {
    const operator = await provision("expiry"); const auth = await begin(operator.email);
    await pool.query("UPDATE downtown_u_operator_auth_challenges SET created_at=created_at-interval '11 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [auth.email_challenge_id]);
    expect((await verifyEmail(auth)).outcome).toBe("invalid");
    const badEvidence = await pool.query(`SELECT count(*)::int n FROM downtown_u_operator_security_events WHERE correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$'`);
    expect(badEvidence.rows[0].n).toBe(0);
    const acl = await pool.query(`SELECT p.proname,acl.privilege_type,acl.is_grantable,coalesce(r.rolname,'PUBLIC') grantee
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      LEFT JOIN pg_roles r ON r.oid=acl.grantee WHERE n.nspname='public' AND p.proname LIKE 'downtown_u_operator_%' AND acl.grantee<>p.proowner ORDER BY 1`);
    expect(acl.rows).toHaveLength(7);
    expect(acl.rows.every((row) => row.grantee === "downtown_u_operator_runtime" && row.privilege_type === "EXECUTE" && row.is_grantable === false)).toBe(true);
    expect((await pool.query(`SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
      WHERE n.nspname='public' AND (c.relname LIKE 'downtown_u_operator_%' OR c.relname='downtown_u_eligibility_events') AND acl.grantee<>c.relowner`)).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'downtown_u_operator_%' AND has_function_privilege($1,p.oid,'EXECUTE')`, [hostileRole])).rows[0].n).toBe(0);
    await principal(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SELECT set_config('downtown_u.operator_write','caller-sentinel',true)");
        await client.query("SELECT * FROM downtown_u_operator_auth_begin($1,'guc-unknown@example.edu',1::smallint,$2,$3,$4,'guc-restore-correlation-0001')",
          [uuid(), verifier(), uuid(), verifier()]);
        expect((await client.query("SELECT current_setting('downtown_u.operator_write',true) value")).rows[0].value).toBe("caller-sentinel");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    });
  });
});
