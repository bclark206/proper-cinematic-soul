import { Pool, type PoolConfig } from "pg";
import { withPostgresTransaction } from "../postgres-transaction";
import { OPERATOR_ROLES, type OperatorRole } from "./types";
import type { OperatorAuthStore as OperatorAuthServiceStore } from "./auth-service";
import {
  assertDowntownUOperatorRuntimeIdentity,
  type OperatorQueryable,
} from "./postgres-runtime-identity";

export type OperatorUuid = string;
export type OperatorVerifierVersion = 1;
export type OperatorGate = "read" | "mutations" | "exports";
export const OPERATOR_VERIFIER_VERSION: OperatorVerifierVersion = 1;

interface Correlated { correlationId: string }
interface SessionProof extends Correlated {
  sessionId: OperatorUuid; sessionVersion: OperatorVerifierVersion; sessionDigest: Buffer;
}
export interface BeginOperatorAuthInput extends Correlated {
  flowId: OperatorUuid; normalizedEmail: string; version: OperatorVerifierVersion; flowDigest: Buffer;
  emailChallengeId: OperatorUuid; emailChallengeDigest: Buffer;
}
export interface VerifyOperatorEmailInput extends Correlated {
  flowId: OperatorUuid; flowVersion: OperatorVerifierVersion; flowDigest: Buffer;
  emailChallengeId: OperatorUuid; emailChallengeVersion: OperatorVerifierVersion; emailChallengeDigest: Buffer;
  smsChallengeId: OperatorUuid; smsChallengeVersion: OperatorVerifierVersion; smsChallengeDigest: Buffer;
}
export interface FinishOperatorSignInInput extends Correlated {
  flowId: OperatorUuid; flowVersion: OperatorVerifierVersion; flowDigest: Buffer;
  smsChallengeId: OperatorUuid; smsChallengeVersion: OperatorVerifierVersion; smsChallengeDigest: Buffer;
  sessionId: OperatorUuid; sessionVersion: OperatorVerifierVersion; sessionDigest: Buffer;
}
export interface ValidateOperatorSessionInput extends SessionProof { roleCode: OperatorRole | null; gateCode: OperatorGate }
export interface BeginOperatorReauthInput extends SessionProof {
  challengeId: OperatorUuid; challengeVersion: OperatorVerifierVersion; challengeDigest: Buffer;
}
export type FinishOperatorReauthInput = BeginOperatorReauthInput;
export type RevokeOperatorSessionInput = SessionProof;

export interface OperatorAuthStoreInputs {
  begin: BeginOperatorAuthInput; verifyEmail: VerifyOperatorEmailInput; finishSignIn: FinishOperatorSignInInput;
  validateSession: ValidateOperatorSessionInput; beginReauth: BeginOperatorReauthInput;
  finishReauth: FinishOperatorReauthInput; revoke: RevokeOperatorSessionInput;
}
export type OperatorIdentity = {
  operatorId: OperatorUuid; displayName: string; roleCodes: OperatorRole[];
  absoluteExpiresAt: Date; idleExpiresAt: Date;
};
export interface OperatorAuthStore {
  begin(input: BeginOperatorAuthInput): Promise<{ outcome: "accepted"; emailChallengeId?: OperatorUuid; expiresAt?: Date }>;
  verifyEmail(input: VerifyOperatorEmailInput): Promise<{ outcome: "invalid" } | { outcome: "verified"; smsChallengeId: OperatorUuid; normalizedPhone: string; expiresAt: Date }>;
  finishSignIn(input: FinishOperatorSignInInput): Promise<{ outcome: "invalid" } | ({ outcome: "authenticated"; sessionId: OperatorUuid } & OperatorIdentity)>;
  validateSession(input: ValidateOperatorSessionInput): Promise<{ outcome: "invalid" | "denied" | "reauth_required" } | ({ outcome: "authorized"; gateCode: OperatorGate; reauthenticatedAt: Date | null } & OperatorIdentity)>;
  beginReauth(input: BeginOperatorReauthInput): Promise<{ outcome: "invalid" | "denied" } | { outcome: "started"; challengeId: OperatorUuid; normalizedPhone: string; expiresAt: Date }>;
  finishReauth(input: FinishOperatorReauthInput): Promise<{ outcome: "invalid" } | { outcome: "reauthenticated"; reauthenticatedAt: Date }>;
  revoke(input: RevokeOperatorSessionInput): Promise<{ outcome: "accepted" }>;
}

export class OperatorAuthStoreError extends Error {
  readonly kind = "unavailable" as const;
  constructor(cause: unknown) {
    super("Downtown U operator authentication storage unavailable", { cause });
    this.name = "OperatorAuthStoreError";
  }
}

type CapabilityRow = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CORRELATION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$/;
const PHONE = /^\+[1-9][0-9]{7,14}$/;
function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function digest(value: unknown): value is Buffer { return Buffer.isBuffer(value) && value.length === 32; }
function date(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()); }
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }
function roles(value: unknown): value is OperatorRole[] {
  return Array.isArray(value) && value.length > 0 && value.length <= OPERATOR_ROLES.length
    && value.every((x, i) => typeof x === "string" && (OPERATOR_ROLES as readonly string[]).includes(x)
      && (i === 0 || String(value[i - 1]) < x));
}
function exactKeys(row: CapabilityRow, expected: readonly string[]): boolean {
  const keys = Object.keys(row).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}
function one(result: { rowCount: number | null; rows: CapabilityRow[] }, keys: readonly string[]): CapabilityRow {
  if (result.rowCount !== 1 || result.rows.length !== 1 || !exactKeys(result.rows[0], keys)
    || Object.values(result.rows[0]).some(Buffer.isBuffer)) throw new Error("Invalid operator capability result");
  return result.rows[0];
}
function validCommon(input: Correlated): boolean { return CORRELATION.test(input.correlationId); }
function validSession(input: SessionProof): boolean {
  return validCommon(input) && uuid(input.sessionId) && input.sessionVersion === 1 && digest(input.sessionDigest);
}

export class PostgresOperatorAuthStore implements OperatorAuthStore, OperatorAuthServiceStore {
  constructor(
    private readonly pool: Pool,
    private readonly preflight: (queryable: OperatorQueryable) => Promise<void> = assertDowntownUOperatorRuntimeIdentity,
  ) {}

  private async call<T>(operation: (client: OperatorQueryable) => Promise<T>): Promise<T> {
    try {
      return await withPostgresTransaction(this.pool, async (client) => {
        await this.preflight(client);
        return operation(client);
      });
    } catch (cause) {
      if (cause instanceof OperatorAuthStoreError) throw cause;
      throw new OperatorAuthStoreError(cause);
    }
  }

  async begin(x: BeginOperatorAuthInput): ReturnType<OperatorAuthStore["begin"]> {
    if (!validCommon(x) || !uuid(x.flowId) || !uuid(x.emailChallengeId) || x.version !== 1
      || !digest(x.flowDigest) || !digest(x.emailChallengeDigest) || !text(x.normalizedEmail, 254)) return { outcome: "accepted" };
    return this.call(async (client) => {
      const row = one(await client.query(`SELECT * FROM public.downtown_u_operator_auth_begin(
        $1::uuid,$2::text,$3::smallint,$4::bytea,$5::uuid,$6::bytea,$7::text)`,
      [x.flowId,x.normalizedEmail,x.version,x.flowDigest,x.emailChallengeId,x.emailChallengeDigest,x.correlationId]),
      ["outcome","email_challenge_id","expires_at"]);
      if (row.outcome !== "accepted") throw new Error("Invalid operator capability outcome");
      if (row.email_challenge_id === null && row.expires_at === null) return { outcome: "accepted" };
      if (!uuid(row.email_challenge_id) || !date(row.expires_at)) throw new Error("Invalid operator capability outcome");
      return { outcome: "accepted", emailChallengeId: row.email_challenge_id, expiresAt: row.expires_at };
    });
  }

  async verifyEmail(x: VerifyOperatorEmailInput): ReturnType<OperatorAuthStore["verifyEmail"]> {
    if (!validCommon(x) || !uuid(x.flowId) || !uuid(x.emailChallengeId) || !uuid(x.smsChallengeId)
      || x.flowVersion !== 1 || x.emailChallengeVersion !== 1 || x.smsChallengeVersion !== 1
      || !digest(x.flowDigest) || !digest(x.emailChallengeDigest) || !digest(x.smsChallengeDigest)) return { outcome: "invalid" };
    return this.call(async (client) => {
      const row=one(await client.query(`SELECT * FROM public.downtown_u_operator_auth_verify_email(
        $1::uuid,$2::smallint,$3::bytea,$4::uuid,$5::smallint,$6::bytea,$7::uuid,$8::smallint,$9::bytea,$10::text)`,
      [x.flowId,x.flowVersion,x.flowDigest,x.emailChallengeId,x.emailChallengeVersion,x.emailChallengeDigest,x.smsChallengeId,x.smsChallengeVersion,x.smsChallengeDigest,x.correlationId]),
      ["outcome","sms_challenge_id","normalized_phone","expires_at"]);
      if (row.outcome === "invalid" && row.sms_challenge_id === null && row.normalized_phone === null && row.expires_at === null) return { outcome:"invalid" };
      if (row.outcome !== "verified" || !uuid(row.sms_challenge_id) || typeof row.normalized_phone !== "string"
        || !PHONE.test(row.normalized_phone) || !date(row.expires_at)) throw new Error("Invalid operator capability outcome");
      return { outcome:"verified",smsChallengeId:row.sms_challenge_id,normalizedPhone:row.normalized_phone,expiresAt:row.expires_at };
    });
  }

  async finishSignIn(x: FinishOperatorSignInInput): ReturnType<OperatorAuthStore["finishSignIn"]> {
    if (!validCommon(x) || !uuid(x.flowId) || !uuid(x.smsChallengeId) || !uuid(x.sessionId)
      || x.flowVersion!==1 || x.smsChallengeVersion!==1 || x.sessionVersion!==1
      || !digest(x.flowDigest) || !digest(x.smsChallengeDigest) || !digest(x.sessionDigest)) return { outcome:"invalid" };
    return this.call(async (client) => {
      const row=one(await client.query(`SELECT * FROM public.downtown_u_operator_auth_finish_sign_in(
        $1::uuid,$2::smallint,$3::bytea,$4::uuid,$5::smallint,$6::bytea,$7::uuid,$8::smallint,$9::bytea,$10::text)`,
      [x.flowId,x.flowVersion,x.flowDigest,x.smsChallengeId,x.smsChallengeVersion,x.smsChallengeDigest,x.sessionId,x.sessionVersion,x.sessionDigest,x.correlationId]),
      ["outcome","session_id","operator_id","display_name","role_codes","absolute_expires","idle_expires"]);
      if (row.outcome === "invalid" && [row.session_id,row.operator_id,row.display_name,row.role_codes,row.absolute_expires,row.idle_expires].every(v=>v===null)) return { outcome:"invalid" };
      if (row.outcome!=="authenticated" || !uuid(row.session_id) || !uuid(row.operator_id) || !text(row.display_name,120)
        || !roles(row.role_codes) || !date(row.absolute_expires) || !date(row.idle_expires)) throw new Error("Invalid operator capability outcome");
      return { outcome:"authenticated",sessionId:row.session_id,operatorId:row.operator_id,displayName:row.display_name,
        roleCodes:row.role_codes,absoluteExpiresAt:row.absolute_expires,idleExpiresAt:row.idle_expires };
    });
  }

  async validateSession(x: ValidateOperatorSessionInput): ReturnType<OperatorAuthStore["validateSession"]> {
    if (!validSession(x) || (x.roleCode!==null && !(OPERATOR_ROLES as readonly string[]).includes(x.roleCode))
      || !(["read","mutations","exports"] as const).includes(x.gateCode)) return { outcome:"invalid" };
    return this.call(async (client) => {
      const row=one(await client.query(`SELECT * FROM public.downtown_u_operator_auth_validate_session(
        $1::uuid,$2::smallint,$3::bytea,$4::text,$5::text,$6::text)`,
      [x.sessionId,x.sessionVersion,x.sessionDigest,x.roleCode,x.gateCode,x.correlationId]),
      ["outcome","operator_id","display_name","role_codes","gate_code","absolute_expires_at","idle_expires_at","reauthenticated_at"]);
      if (row.outcome==="invalid" && [row.operator_id,row.display_name,row.role_codes,row.gate_code,row.absolute_expires_at,row.idle_expires_at,row.reauthenticated_at].every(v=>v===null)) return { outcome:"invalid" };
      const validIdentity = uuid(row.operator_id) && text(row.display_name,120) && roles(row.role_codes)
        && row.gate_code===x.gateCode && date(row.absolute_expires_at) && date(row.idle_expires_at)
        && (row.reauthenticated_at===null || date(row.reauthenticated_at));
      if ((row.outcome==="denied" || row.outcome==="reauth_required") && validIdentity) return { outcome:row.outcome };
      if (row.outcome!=="authorized" || !validIdentity) throw new Error("Invalid operator capability outcome");
      return { outcome:"authorized",operatorId:row.operator_id as string,displayName:row.display_name as string,
        roleCodes:row.role_codes as OperatorRole[],gateCode:x.gateCode,
        absoluteExpiresAt:row.absolute_expires_at as Date,idleExpiresAt:row.idle_expires_at as Date,
        reauthenticatedAt:row.reauthenticated_at as Date|null };
    });
  }

  async beginReauth(x: BeginOperatorReauthInput): ReturnType<OperatorAuthStore["beginReauth"]> {
    if (!validSession(x) || !uuid(x.challengeId) || x.challengeVersion!==1 || !digest(x.challengeDigest)) return { outcome:"invalid" };
    return this.call(async (client) => {
      const row=one(await client.query(`SELECT * FROM public.downtown_u_operator_auth_begin_reauth(
        $1::uuid,$2::smallint,$3::bytea,$4::uuid,$5::smallint,$6::bytea,$7::text)`,
      [x.sessionId,x.sessionVersion,x.sessionDigest,x.challengeId,x.challengeVersion,x.challengeDigest,x.correlationId]),
      ["outcome","challenge_id","normalized_phone","expires_at"]);
      if ((row.outcome==="invalid" || row.outcome==="denied") && row.challenge_id===null && row.normalized_phone===null && row.expires_at===null) return { outcome:row.outcome };
      if (row.outcome!=="started" || !uuid(row.challenge_id) || typeof row.normalized_phone!=="string"
        || !PHONE.test(row.normalized_phone) || !date(row.expires_at)) throw new Error("Invalid operator capability outcome");
      return { outcome:"started",challengeId:row.challenge_id,normalizedPhone:row.normalized_phone,expiresAt:row.expires_at };
    });
  }

  async finishReauth(x: FinishOperatorReauthInput): ReturnType<OperatorAuthStore["finishReauth"]> {
    if (!validSession(x) || !uuid(x.challengeId) || x.challengeVersion!==1 || !digest(x.challengeDigest)) return { outcome:"invalid" };
    return this.call(async (client) => {
      const row=one(await client.query(`SELECT * FROM public.downtown_u_operator_auth_finish_reauth(
        $1::uuid,$2::smallint,$3::bytea,$4::uuid,$5::smallint,$6::bytea,$7::text)`,
      [x.sessionId,x.sessionVersion,x.sessionDigest,x.challengeId,x.challengeVersion,x.challengeDigest,x.correlationId]),
      ["outcome","reauthenticated_at"]);
      if (row.outcome==="invalid" && row.reauthenticated_at===null) return { outcome:"invalid" };
      if (row.outcome!=="reauthenticated" || !date(row.reauthenticated_at)) throw new Error("Invalid operator capability outcome");
      return { outcome:"reauthenticated",reauthenticatedAt:row.reauthenticated_at };
    });
  }

  async revoke(x: RevokeOperatorSessionInput): ReturnType<OperatorAuthStore["revoke"]> {
    if (!validSession(x)) return { outcome:"accepted" };
    return this.call(async (client) => {
      const row=one(await client.query(`SELECT * FROM public.downtown_u_operator_auth_revoke_session(
        $1::uuid,$2::smallint,$3::bytea,$4::text)`,[x.sessionId,x.sessionVersion,x.sessionDigest,x.correlationId]),["outcome"]);
      if (row.outcome!=="accepted") throw new Error("Invalid operator capability outcome");
      return { outcome:"accepted" };
    });
  }
}

let productionPool: Pool | undefined;
const SAFE_PARAMETERS = new Set(["sslmode","channel_binding"]);
export function operatorDatabasePoolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const raw=env.DOWNTOWN_U_OPERATOR_DATABASE_URL;
  if (!raw) throw new Error("DOWNTOWN_U_OPERATOR_DATABASE_URL is required");
  let url: URL;
  try { url=new URL(raw); } catch { throw new Error("Invalid operator database URL"); }
  if (!(["postgres:","postgresql:"] as const).includes(url.protocol as "postgres:" | "postgresql:")
    || !url.username || !url.password || !url.pathname || url.pathname==="/") throw new Error("Invalid operator database URL");
  if (url.hash) throw new Error("Unsafe operator database URL fragment");
  const parameters=[...url.searchParams.entries()];
  if (parameters.length!==2 || new Set(parameters.map(([key])=>key)).size!==parameters.length
    || parameters.some(([key])=>!SAFE_PARAMETERS.has(key))) throw new Error("Unsafe operator database URL parameter");
  if (url.searchParams.getAll("sslmode").length!==1 || url.searchParams.get("sslmode")!=="verify-full")
    throw new Error("Unsafe operator database SSL mode");
  if (url.searchParams.getAll("channel_binding").length!==1 || url.searchParams.get("channel_binding")!=="require")
    throw new Error("Unsafe operator database channel binding mode");
  return { connectionString:raw,max:5,idleTimeoutMillis:10_000,connectionTimeoutMillis:5_000,allowExitOnIdle:true };
}
export function getDowntownUOperatorPool(env: NodeJS.ProcessEnv = process.env): Pool {
  if (!productionPool) productionPool=new Pool(operatorDatabasePoolConfig(env));
  return productionPool;
}
