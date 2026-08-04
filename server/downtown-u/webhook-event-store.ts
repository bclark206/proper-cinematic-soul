export type WebhookClaimResult =
  | { outcome: "claimed"; claimToken: string; attemptCount: number }
  | { outcome: "in_progress" | "duplicate" | "exhausted"; attemptCount: number };

export interface WebhookEventStore {
  claim(eventId: string, eventType: string, bodyHash: string): Promise<WebhookClaimResult>;
  complete(eventId: string, claimToken: string): Promise<void>;
  fail(eventId: string, claimToken: string, failureCode: string, failureDetail: string): Promise<void>;
}

export class WebhookEventConflictError extends Error {
  constructor() { super("Webhook event identity conflict"); this.name = "WebhookEventConflictError"; }
}

export class WebhookEventTransitionError extends Error {
  constructor() { super("Webhook event transition was not owned by this claim"); this.name = "WebhookEventTransitionError"; }
}
