import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOperatorAuthCryptography } from "../../../../server/downtown-u/operator/auth-crypto";
import type { SendOperatorMagicLinkInput, SendOperatorSmsOtpInput } from "../../../../server/downtown-u/operator/auth-delivery";
import { OperatorAuthService } from "../../../../server/downtown-u/operator/auth-service";
import { PostgresOperatorAuthStore } from "../../../../server/downtown-u/operator/postgres-auth-store";
import { assertDowntownUOperatorRuntimeIdentity } from "../../../../server/downtown-u/operator/postgres-runtime-identity";
import {
  createOperatorAuthHandler,
  type NodeOperatorAuthResponse,
  type OperatorAuthEndpoint,
} from "../auth-handler";

const baseUrl = process.env.TEST_DATABASE_URL;
const run = baseUrl ? describe : describe.skip;
const suffix = `${process.pid}_${Date.now()}`;
const databaseName = `du_auth_full_stack_${suffix}`;
const operatorLogin = `du_auth_full_stack_login_${suffix}`;
const operatorPassword = `FullStack-${suffix}-Password`;
const origin = "https://operator.example.test";
const email = `full-stack-${suffix}@example.test`;
const phone = "+12025550191";
const displayName = "Full Stack Operator";
const migrationNames = [
  "202608040001_downtown_u_phase1.sql",
  "202608040002_downtown_u_webhook_events.sql",
  "202608040003_downtown_u_payment_activation.sql",
  "202608040004_downtown_u_refund_activation.sql",
  "202608040005_downtown_u_auth.sql",
  "202608040006_downtown_u_student_portal.sql",
  "202608040007_downtown_u_checkout.sql",
  "202608040008_downtown_u_kitchen_outbox.sql",
  "202608040009_downtown_u_operator_audit.sql",
  "202608040010_downtown_u_operator_auth_capabilities.sql",
  "202608040011_downtown_u_operator_dashboard_reads.sql",
  "202608040012_downtown_u_operator_eligibility_mutations.sql",
];
const migrations = migrationNames.map((name) => readFileSync(resolve(process.cwd(), "db/migrations", name), "utf8"));

let admin: Pool;
let owner: Pool;
let operator: Pool;
let operatorId: string;
let preflightCalls = 0;

function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

async function ownerWrite<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('downtown_u.operator_write',pg_backend_pid()::text||':'||pg_current_xact_id()::text,true)");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

interface CapturedResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}
function response(): { captured: CapturedResponse; adapter: NodeOperatorAuthResponse } {
  const captured: CapturedResponse = { status: 0, body: undefined, headers: {} };
  return {
    captured,
    adapter: {
      setHeader(name, value) { captured.headers[name] = value; },
      status(status) {
        return {
          json(body) { captured.status = status; captured.body = body; },
          end() { captured.status = status; },
        };
      },
    },
  };
}

function rawRequest(method: "GET" | "POST", body: unknown | undefined, cookie?: string) {
  const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8");
  const headers: Record<string, string> = method === "POST"
    ? { origin, "sec-fetch-site": "same-origin", "content-type": "application/json", "content-length": String(bytes.length) }
    : {};
  if (cookie !== undefined) headers.cookie = cookie;
  const rawHeaders = Object.entries(headers).flatMap(([name, value]) => [name, value]);
  return Object.assign(Readable.from(bytes.length === 0 ? [] : [bytes]), { method, headers, rawHeaders });
}

async function invoke(
  endpoint: OperatorAuthEndpoint,
  service: OperatorAuthService,
  body: unknown | undefined,
  cookie?: string,
): Promise<CapturedResponse> {
  const output = response();
  const method = endpoint === "session" ? "GET" : "POST";
  await createOperatorAuthHandler(endpoint, origin, async () => ({ service, now: () => new Date() }))(
    rawRequest(method, body, cookie),
    output.adapter,
  );
  return output.captured;
}

run.sequential("operator auth full stack on stock PostgreSQL 16", () => {
  beforeAll(async () => {
    const parsed = new URL(baseUrl!);
    const baseDatabase = parsed.pathname.slice(1);
    if (!["", "localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
      && !/(^|[_-])(test|testing|disposable)([_-]|$)/i.test(baseDatabase)) {
      throw new Error("Refusing integration test: TEST_DATABASE_URL must be local or explicitly test-named");
    }
    admin = new Pool({ connectionString: baseUrl, max: 2 });
    const version = Number((await admin.query("SHOW server_version_num")).rows[0].server_version_num);
    if (version < 160000 || version >= 170000) throw new Error(`PostgreSQL 16 required, got ${version}`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    const ownerUrl = new URL(baseUrl!);
    ownerUrl.pathname = `/${databaseName}`;
    owner = new Pool({ connectionString: ownerUrl.toString(), max: 3 });
    for (const migration of migrations) await owner.query(migration);

    await admin.query(`CREATE ROLE ${quoteIdentifier(operatorLogin)} LOGIN PASSWORD '${operatorPassword.replaceAll("'", "''")}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(`GRANT downtown_u_operator_runtime TO ${quoteIdentifier(operatorLogin)}`);
    const operatorUrl = new URL(ownerUrl);
    operatorUrl.hostname = "127.0.0.1";
    operatorUrl.username = operatorLogin;
    operatorUrl.password = operatorPassword;
    operator = new Pool({ connectionString: operatorUrl.toString(), max: 2, allowExitOnIdle: true });

    operatorId = await ownerWrite(async (client) => {
      const account = await client.query<{ id: string }>(`INSERT INTO downtown_u_operator_accounts
        (normalized_email,normalized_phone,display_name,provisioning_reference)
        VALUES ($1,$2,$3,$4) RETURNING id`, [email, phone, displayName, `provision:${suffix}`]);
      await client.query(`INSERT INTO downtown_u_operator_account_roles
        (account_id,role_code,assigned_by_reference) VALUES ($1,'reconciliation_operator',$2)`,
      [account.rows[0].id, `role:${suffix}`]);
      await client.query("UPDATE downtown_u_operator_config SET read_enabled=true,updated_at=clock_timestamp() WHERE singleton=true");
      return account.rows[0].id;
    });
  }, 30_000);

  afterAll(async () => {
    await operator?.end();
    await owner?.end();
    if (admin) {
      await admin.query(`REVOKE downtown_u_operator_runtime FROM ${quoteIdentifier(operatorLogin)}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(operatorLogin)}`).catch(() => undefined);
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
      await admin.end();
    }
  }, 30_000);

  it("proves email link, SMS MFA, session kill switch, reauth, and logout through the HTTP boundary", async () => {
    await expect(ownerWrite((client) => client.query(
      "UPDATE downtown_u_operator_accounts SET normalized_email='changed@example.test' WHERE id=$1",
      [operatorId],
    ))).rejects.toThrow(/immutable/i);
    await expect(operator.query("SELECT * FROM downtown_u_operator_accounts LIMIT 0"))
      .rejects.toSatisfy((error: unknown) => errorCode(error) === "42501");

    const waitUntilPromises: Promise<unknown>[] = [];
    const magicLinks: Array<SendOperatorMagicLinkInput & { committed: boolean }> = [];
    const smsMessages: Array<SendOperatorSmsOtpInput & { committed: boolean }> = [];
    const delivery = {
      async sendMagicLink(input: SendOperatorMagicLinkInput) {
        const committed = (await owner.query<{ count: number }>(
          "SELECT count(*)::int count FROM downtown_u_operator_auth_challenges WHERE id=$1 AND status='pending'",
          [input.challengeId],
        )).rows[0].count === 1;
        magicLinks.push({ ...input, committed });
      },
      async sendSmsOtp(input: SendOperatorSmsOtpInput) {
        const committed = (await owner.query<{ count: number }>(
          `SELECT count(*)::int count FROM downtown_u_operator_auth_challenges
           WHERE factor='sms_otp' AND status='pending' AND operator_id=$1`, [operatorId],
        )).rows[0].count === 1;
        smsMessages.push({ ...input, committed });
      },
    };
    const admission = Object.freeze({
      admitRequestLink: async () => true,
      admitEmailVerification: async () => true,
      admitSmsVerification: async () => true,
      admitReauthIssuance: async () => true,
      admitReauthVerification: async () => true,
    });
    const secret = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 17)).toString("base64url");
    const cryptography = createOperatorAuthCryptography(secret);
    const store = new PostgresOperatorAuthStore(operator, async (client) => {
      preflightCalls += 1;
      await assertDowntownUOperatorRuntimeIdentity(client);
    });
    const service = new OperatorAuthService({
      store,
      cryptography,
      admission,
      delivery,
      publicOrigin: origin,
      waitUntil(promise) { waitUntilPromises.push(promise); },
      clock: () => new Date(),
    });
    const flushDelivery = async () => {
      const pending = waitUntilPromises.splice(0);
      await Promise.all(pending);
    };

    const requested = await invoke("request-link", service, { email });
    expect(requested).toMatchObject({ status: 202, body: { accepted: true } });
    expect(magicLinks).toEqual([]);
    await flushDelivery();
    expect(magicLinks).toHaveLength(1);
    const link = magicLinks[0];
    expect(link).toMatchObject({ normalizedEmail: email, publicOrigin: origin, committed: true });
    const capturedLink = new URL("/", link.publicOrigin);
    capturedLink.hash = `/downtown-u/operator/auth?${new URLSearchParams({
      flowId: link.flowId,
      flowVerifier: link.flowVerifier,
      challengeId: link.challengeId,
      verifier: link.challengeVerifier,
    }).toString()}`;
    expect(capturedLink.pathname).toBe("/");
    expect(capturedLink.search).toBe("");
    expect(new URLSearchParams(capturedLink.hash.split("?", 2)[1])).toEqual(new URLSearchParams({
      flowId: link.flowId,
      flowVerifier: link.flowVerifier,
      challengeId: link.challengeId,
      verifier: link.challengeVerifier,
    }));
    const initialDb = await owner.query(`SELECT octet_length(f.flow_verifier) flow_bytes,
      octet_length(c.challenge_verifier) challenge_bytes,encode(f.flow_verifier,'hex') flow_digest,
      encode(c.challenge_verifier,'hex') challenge_digest
      FROM downtown_u_operator_auth_flows f JOIN downtown_u_operator_auth_challenges c ON c.flow_id=f.id
      WHERE f.id=$1 AND c.id=$2`, [link.flowId, link.challengeId]);
    expect(initialDb.rows[0]).toMatchObject({ flow_bytes: 32, challenge_bytes: 32 });
    expect(initialDb.rows[0].flow_digest).not.toBe(link.flowVerifier);
    expect(initialDb.rows[0].challenge_digest).not.toBe(link.challengeVerifier);

    const emailVerified = await invoke("verify-email", service, {
      flowId: link.flowId,
      flowVerifier: link.flowVerifier,
      challengeId: link.challengeId,
      verifier: link.challengeVerifier,
    });
    expect(emailVerified).toMatchObject({ status: 200, body: { mfaRequired: true } });
    expect(smsMessages).toEqual([]);
    await flushDelivery();
    expect(smsMessages).toHaveLength(1);
    const signInSms = smsMessages[0];
    expect(signInSms).toMatchObject({ normalizedPhone: phone, purpose: "sign_in", committed: true });
    expect(emailVerified.body).toEqual({ mfaRequired: true, smsChallengeId: expect.any(String) });
    const smsChallengeId = (emailVerified.body as { smsChallengeId: string }).smsChallengeId;
    expect((await owner.query(`SELECT factor,status FROM downtown_u_operator_auth_challenges
      WHERE flow_id=$1 ORDER BY factor`, [link.flowId])).rows).toEqual([
      { factor: "email_magic_link", status: "consumed" },
      { factor: "sms_otp", status: "pending" },
    ]);

    const signedIn = await invoke("verify-sms", service, {
      flowId: link.flowId,
      flowVerifier: link.flowVerifier,
      challengeId: smsChallengeId,
      otp: signInSms.otp,
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body).toEqual({ authenticated: true, operator: { displayName, roles: ["reconciliation_operator"] } });
    const setCookie = signedIn.headers["Set-Cookie"];
    expect(setCookie).toMatch(/^__Host-downtown_u_operator_session=v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}; Max-Age=\d+; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
    const cookie = setCookie.split(";", 1)[0];
    const sessionId = cookie.split(".")[1];
    const authState = await owner.query(`SELECT f.status flow_status,s.status session_status,
      octet_length(s.session_verifier) session_bytes,encode(s.session_verifier,'hex') session_digest,
      (SELECT count(*)::int FROM downtown_u_operator_sessions WHERE consumed_auth_flow_id=f.id) session_count
      FROM downtown_u_operator_auth_flows f JOIN downtown_u_operator_sessions s ON s.consumed_auth_flow_id=f.id
      WHERE f.id=$1`, [link.flowId]);
    expect(authState.rows).toEqual([expect.objectContaining({
      flow_status: "consumed", session_status: "active", session_bytes: 32, session_count: 1,
    })]);
    expect(authState.rows[0].session_digest).not.toBe(cookie.split(".")[2]);
    expect((await owner.query("SELECT status FROM downtown_u_operator_auth_challenges WHERE id=$1", [smsChallengeId])).rows[0].status).toBe("consumed");

    const current = await invoke("session", service, undefined, cookie);
    expect(current).toMatchObject({ status: 200, body: {
      authenticated: true, operator: { displayName, roles: ["reconciliation_operator"] }, smsReauthFresh: false,
    } });
    await ownerWrite((client) => client.query(`UPDATE downtown_u_operator_accounts
      SET status='disabled',disabled_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`, [operatorId]));
    expect(await invoke("session", service, undefined, cookie)).toMatchObject({ status: 401, body: { authenticated: false } });
    await ownerWrite((client) => client.query(`UPDATE downtown_u_operator_accounts
      SET status='active',disabled_at=NULL,updated_at=clock_timestamp() WHERE id=$1`, [operatorId]));

    const reauthRequested = await invoke("reauth-request", service, {}, cookie);
    expect(reauthRequested).toMatchObject({ status: 202, body: { accepted: true } });
    expect(smsMessages).toHaveLength(1);
    await flushDelivery();
    expect(smsMessages).toHaveLength(2);
    const reauthSms = smsMessages[1];
    expect(reauthSms).toMatchObject({ normalizedPhone: phone, purpose: "reauth", committed: true });
    const pendingReauth = await owner.query<{ id: string }>(`SELECT id FROM downtown_u_operator_auth_challenges
      WHERE session_id=$1 AND purpose='reauth' AND status='pending'`, [sessionId]);
    expect(pendingReauth.rows).toHaveLength(1);
    const reauthVerified = await invoke("reauth-verify", service, {
      challengeId: pendingReauth.rows[0].id,
      otp: reauthSms.otp,
    }, cookie);
    expect(reauthVerified).toEqual(expect.objectContaining({
      status: 200, body: { reauthenticated: true, validForSeconds: 300 },
    }));
    expect(await invoke("session", service, undefined, cookie)).toMatchObject({
      status: 200, body: { authenticated: true, smsReauthFresh: true },
    });

    const loggedOut = await invoke("logout", service, {}, cookie);
    expect(loggedOut.status).toBe(204);
    expect(loggedOut.body).toBeUndefined();
    expect(loggedOut.headers["Set-Cookie"]).toBe("__Host-downtown_u_operator_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict");
    expect(await invoke("session", service, undefined, cookie)).toMatchObject({ status: 401, body: { authenticated: false } });
    expect((await owner.query(`SELECT status,revoked_at IS NOT NULL revoked FROM downtown_u_operator_sessions
      WHERE id=$1`, [sessionId])).rows[0]).toEqual({ status: "revoked", revoked: true });
    expect((await owner.query(`SELECT count(*)::int count FROM downtown_u_operator_auth_challenges
      WHERE session_id=$1 AND status='pending'`, [sessionId])).rows[0].count).toBe(0);

    expect(preflightCalls).toBe(10);
    const evidence = await owner.query(`SELECT event_code,outcome,factor,correlation_id,
      operator_id,flow_id,session_id FROM downtown_u_operator_security_events ORDER BY created_at,id`);
    expect(evidence.rows.length).toBeGreaterThanOrEqual(10);
    const transitionCount = (eventCode: string, outcome: string, factor: string | null) => evidence.rows.filter((row) =>
      row.event_code === eventCode && row.outcome === outcome && row.factor === factor).length;
    expect(transitionCount("issuance", "succeeded", "email_magic_link")).toBe(1);
    expect(transitionCount("success", "succeeded", "email_magic_link")).toBe(1);
    expect(transitionCount("issuance", "succeeded", "sms_otp")).toBe(1);
    expect(transitionCount("success", "succeeded", "sms_otp")).toBe(2);
    expect(transitionCount("success", "succeeded", null)).toBe(2);
    expect(transitionCount("failure", "denied", null)).toBe(2);
    expect(transitionCount("revocation", "succeeded", null)).toBe(1);
    const evidenceText = JSON.stringify(evidence.rows);
    for (const forbidden of [email, phone, link.flowVerifier, link.challengeVerifier,
      signInSms.otp, cookie.split(".")[2], reauthSms.otp]) {
      expect(evidenceText).not.toContain(forbidden);
    }
    const sensitiveColumns = await owner.query(`SELECT column_name,data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name='downtown_u_operator_security_events'
        AND (data_type IN ('json','jsonb') OR column_name ~ '(email|phone|token|otp)')`);
    expect(sensitiveColumns.rows).toEqual([]);

    const persistedAuthText = JSON.stringify((await owner.query(`SELECT
      encode(f.flow_verifier,'hex') flow_digest,
      jsonb_agg(jsonb_build_object('factor',c.factor,'digest',encode(c.challenge_verifier,'hex'))) challenges,
      encode(s.session_verifier,'hex') session_digest
      FROM downtown_u_operator_auth_flows f
      JOIN downtown_u_operator_auth_challenges c ON c.flow_id=f.id OR c.session_id=$2
      JOIN downtown_u_operator_sessions s ON s.consumed_auth_flow_id=f.id
      WHERE f.id=$1 GROUP BY f.flow_verifier,s.session_verifier`, [link.flowId, sessionId])).rows);
    for (const raw of [link.flowVerifier, link.challengeVerifier, signInSms.otp, cookie.split(".")[2], reauthSms.otp]) {
      expect(persistedAuthText).not.toContain(raw);
    }
  }, 30_000);
});
