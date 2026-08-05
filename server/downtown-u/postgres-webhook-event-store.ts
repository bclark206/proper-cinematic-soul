import type { Pool } from "pg";
import { assertDowntownURuntimeIdentity } from "./postgres-runtime-identity";
import { withPostgresTransaction } from "./postgres-transaction";
import {
  WebhookEventConflictError,
  WebhookEventTransitionError,
  type WebhookClaimResult,
  type WebhookEventStore,
} from "./webhook-event-store";

interface ClaimRow { outcome: string; claim_token: string | null; attempt_count: number; }
interface TransitionRow { transitioned: boolean; }
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const FAILURE_DETAIL = /^[\x20-\x7e]{1,256}$/;

export class PostgresWebhookEventStore implements WebhookEventStore {
  constructor(
    private readonly pool: Pool,
    private readonly identityPreflight: (pool: Pool) => Promise<void> = assertDowntownURuntimeIdentity,
  ) {}

  async claim(eventId: string, eventType: string, bodyHash: string): Promise<WebhookClaimResult> {
    await this.identityPreflight(this.pool);
    return withPostgresTransaction(this.pool, async (client) => {
      const result = await client.query<ClaimRow>(
        "SELECT * FROM public.downtown_u_claim_webhook_event($1, $2, $3)",
        [eventId, eventType, bodyHash],
      );
      const row = result.rows[0];
      if (!row) throw new Error("PostgreSQL webhook claim returned no outcome");
      if (row.outcome === "conflict") throw new WebhookEventConflictError();
      if (row.outcome === "claimed") {
        if (!row.claim_token) throw new Error("PostgreSQL webhook claim omitted its token");
        return { outcome: "claimed", claimToken: row.claim_token, attemptCount: row.attempt_count };
      }
      if (row.outcome === "in_progress" || row.outcome === "duplicate" || row.outcome === "exhausted") {
        return { outcome: row.outcome, attemptCount: row.attempt_count };
      }
      throw new Error("PostgreSQL webhook claim returned an unknown outcome");
    });
  }

  async complete(eventId: string, claimToken: string): Promise<void> {
    await this.transition("SELECT * FROM public.downtown_u_complete_webhook_event($1, $2)", [eventId, claimToken]);
  }

  async fail(eventId: string, claimToken: string, failureCode: string, failureDetail: string): Promise<void> {
    if (!FAILURE_CODE.test(failureCode)) throw new TypeError("Invalid webhook failure code");
    if (!FAILURE_DETAIL.test(failureDetail)) throw new TypeError("Invalid webhook failure detail");
    await this.transition("SELECT * FROM public.downtown_u_fail_webhook_event($1, $2, $3, $4)", [eventId, claimToken, failureCode, failureDetail]);
  }

  async reject(eventId: string, claimToken: string, failureCode: string, failureDetail: string): Promise<void> {
    if (!FAILURE_CODE.test(failureCode)) throw new TypeError("Invalid webhook failure code");
    if (!FAILURE_DETAIL.test(failureDetail)) throw new TypeError("Invalid webhook failure detail");
    await this.transition("SELECT * FROM public.downtown_u_reject_webhook_event($1, $2, $3, $4)", [eventId, claimToken, failureCode, failureDetail]);
  }

  private async transition(sql: string, values: string[]): Promise<void> {
    await this.identityPreflight(this.pool);
    await withPostgresTransaction(this.pool, async (client) => {
      const result = await client.query<TransitionRow>(sql, values);
      if (result.rows[0]?.transitioned !== true) throw new WebhookEventTransitionError();
    });
  }
}
