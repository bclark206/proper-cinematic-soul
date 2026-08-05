import type { Pool } from "pg";
import {
  AUTH_VERIFIER_VERSION, type AuthContactType, type AuthMethod,
} from "./auth";
import { assertDowntownURuntimeIdentity, type Queryable } from "./postgres-runtime-identity";
import { withPostgresTransaction } from "./postgres-transaction";

export interface CreateChallengeCommand {
  challengeId: string; contactType: AuthContactType; normalizedContact: string; method: AuthMethod; digest: Buffer;
}
export interface ConsumeChallengeCommand {
  challengeId: string; digest: Buffer; sessionId: string; sessionDigest: Buffer;
}
export interface SessionCredential { sessionId: string; digest: Buffer }
export type CreateChallengeResult = { outcome: "accepted"; challengeId?: string; expiresAt?: Date };
export type ConsumeChallengeResult =
  | { outcome: "invalid" }
  | { outcome: "authenticated"; sessionId: string; studentId: string; expiresAt: Date };
export type ValidateSessionResult =
  | { outcome: "invalid" }
  | { outcome: "valid"; studentId: string; eligibilityStatus: "approved"; creditBalance: number; expiresAt: Date };

/** Narrow persistence boundary used by the authentication service and delivery layer. */
export interface AuthStore {
  createChallenge(command: CreateChallengeCommand): Promise<CreateChallengeResult>;
  consumeChallenge(command: ConsumeChallengeCommand): Promise<ConsumeChallengeResult>;
  validateSession(credential: SessionCredential): Promise<ValidateSessionResult>;
  revokeSession(credential: SessionCredential): Promise<{ outcome: "accepted" }>;
}

export class AuthStoreError extends Error {
  constructor(cause: unknown) { super("Downtown U authentication storage failed", { cause }); this.name = "AuthStoreError"; }
}
async function runIdentityPreflight(
  preflight: (queryable: Queryable) => Promise<void>, queryable: Queryable,
): Promise<void> {
  try { await preflight(queryable); }
  catch (cause) { throw new AuthStoreError(cause); }
}

interface Row { outcome: string; challenge_id?: string | null; session_id?: string | null; student_id?: string | null;
  eligibility_status?: string | null; credit_balance?: number | null; expires_at?: Date | null }
function knownConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && ["P0001","22023","23503","23505","23514"].includes(String(error.code));
}
function validDigest(value: Buffer): boolean { return Buffer.isBuffer(value) && value.length === 32; }
function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}
function oneRow(result: { rowCount: number | null; rows: Row[] }): Row {
  if (result.rowCount !== 1 || result.rows.length !== 1) throw new Error("Invalid auth capability result");
  return result.rows[0];
}

export class PostgresAuthStore implements AuthStore {
  constructor(private readonly pool: Pool,
    private readonly identityPreflight: (queryable: Queryable) => Promise<void> = assertDowntownURuntimeIdentity) {}

  async createChallenge(command: CreateChallengeCommand): Promise<CreateChallengeResult> {
    if (!validDigest(command.digest)) return { outcome: "accepted" };
    try {
      return await withPostgresTransaction(this.pool, async (client) => {
        await runIdentityPreflight(this.identityPreflight,client);
        const row = oneRow(await client.query<Row>(`SELECT * FROM public.downtown_u_create_auth_challenge(
          $1,$2,$3,$4,$5::smallint,$6::bytea)`, [command.challengeId,
          command.contactType,command.normalizedContact,command.method,AUTH_VERIFIER_VERSION,command.digest]));
        if (row.outcome !== "accepted") throw new Error("Invalid auth capability outcome");
        if (row.challenge_id == null && row.expires_at == null) return { outcome: "accepted" };
        if (typeof row.challenge_id !== "string" || !validDate(row.expires_at))
          throw new Error("Invalid auth capability outcome");
        return { outcome: "accepted", challengeId: row.challenge_id, expiresAt: row.expires_at };
      });
    } catch (error) {
      if (error instanceof AuthStoreError) throw error;
      if (knownConflict(error)) return { outcome: "accepted" };
      throw new AuthStoreError(error);
    }
  }

  async consumeChallenge(command: ConsumeChallengeCommand): Promise<ConsumeChallengeResult> {
    if (!validDigest(command.digest) || !validDigest(command.sessionDigest)) return { outcome: "invalid" };
    try {
      return await withPostgresTransaction(this.pool, async (client) => {
        await runIdentityPreflight(this.identityPreflight,client);
        const row = oneRow(await client.query<Row>(`SELECT * FROM public.downtown_u_consume_auth_challenge(
          $1,$2::smallint,$3::bytea,$4,$5::smallint,$6::bytea)`, [command.challengeId,
          AUTH_VERIFIER_VERSION,command.digest,command.sessionId,AUTH_VERIFIER_VERSION,command.sessionDigest]));
        if (row.outcome === "invalid") return { outcome: "invalid" };
        if (row.outcome !== "authenticated" || typeof row.session_id !== "string"
          || typeof row.student_id !== "string" || !validDate(row.expires_at))
          throw new Error("Invalid auth capability outcome");
        return { outcome: "authenticated",sessionId:row.session_id,studentId:row.student_id,expiresAt:row.expires_at };
      });
    } catch (error) {
      if (error instanceof AuthStoreError) throw error;
      if (knownConflict(error)) return { outcome: "invalid" };
      throw new AuthStoreError(error);
    }
  }

  async validateSession(credential: SessionCredential): Promise<ValidateSessionResult> {
    if (!validDigest(credential.digest)) return { outcome: "invalid" };
    try {
      return await withPostgresTransaction(this.pool, async (client) => {
        await runIdentityPreflight(this.identityPreflight,client);
        const row = oneRow(await client.query<Row>(`SELECT * FROM public.downtown_u_validate_auth_session(
          $1,$2::smallint,$3::bytea)`,[credential.sessionId,AUTH_VERIFIER_VERSION,credential.digest]));
        if (row.outcome === "invalid") return { outcome: "invalid" };
        if (row.outcome !== "valid" || !row.student_id || row.eligibility_status !== "approved"
          || typeof row.credit_balance !== "number" || !Number.isSafeInteger(row.credit_balance)
          || !validDate(row.expires_at))
          throw new Error("Invalid auth capability outcome");
        return { outcome:"valid",studentId:row.student_id,eligibilityStatus:"approved",
          creditBalance:row.credit_balance,expiresAt:row.expires_at };
      });
    } catch (error) {
      if (error instanceof AuthStoreError) throw error;
      if (knownConflict(error)) return { outcome: "invalid" };
      throw new AuthStoreError(error);
    }
  }

  async revokeSession(credential: SessionCredential): Promise<{ outcome: "accepted" }> {
    if (!validDigest(credential.digest)) return { outcome: "accepted" };
    try {
      return await withPostgresTransaction(this.pool, async (client) => {
        await runIdentityPreflight(this.identityPreflight,client);
        const row=oneRow(await client.query<Row>(`SELECT * FROM public.downtown_u_revoke_auth_session(
          $1,$2::smallint,$3::bytea)`,[credential.sessionId,AUTH_VERIFIER_VERSION,credential.digest]));
        if(row.outcome!=="accepted") throw new Error("Invalid auth capability outcome");
        return { outcome:"accepted" };
      });
    } catch(error) {
      if(error instanceof AuthStoreError) throw error;
      if(knownConflict(error)) return { outcome:"accepted" };
      throw new AuthStoreError(error);
    }
  }
}
