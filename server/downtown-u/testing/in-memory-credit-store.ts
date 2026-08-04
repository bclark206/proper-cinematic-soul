import { canonicalJson, IdempotencyConflictError, InsufficientCreditsError, InvalidCreditOperationError, type ActorType, type CreditStore, type LedgerEntry, type LedgerMetadata, type PurchaseRecord, type RedemptionRecord } from "../credits";

export class InMemoryCreditStore implements CreditStore {
  private readonly balances = new Map<string, number>();
  private readonly purchases = new Map<string, PurchaseRecord>();
  private readonly purchaseSources = new Map<string, string>();
  private readonly redemptions = new Map<string, RedemptionRecord>();
  private readonly redemptionKeys = new Map<string, string>();
  private readonly redemptionOrders = new Map<string, string>();
  private readonly ledger: LedgerEntry[] = [];
  private readonly ledgerKeys = new Map<string, LedgerEntry>();
  private readonly operationSignatures = new Map<string, string>();
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();

  addStudent(id: string): void { this.balances.set(id, 0); }
  async balance(studentId: string): Promise<number> { return this.balances.get(studentId) ?? 0; }
  ledgerFor(studentId: string): LedgerEntry[] { return this.ledger.filter((entry) => entry.studentId === studentId).map((entry) => structuredClone(entry)); }

  private id(prefix: string): string { this.sequence += 1; return `${prefix}-${this.sequence}`; }
  private async atomic<T>(operation: () => T | Promise<T>): Promise<T> {
    const prior = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await operation(); } finally { release(); }
  }
  private append(studentId: string, delta: number, type: LedgerEntry["type"], key: string, reason: string,
    actorType: ActorType, actorId: string, sourceType: string, sourceId: string, metadata: LedgerMetadata = {}): LedgerEntry {
    const existing = this.ledgerKeys.get(key);
    if (existing) return existing;
    const current = this.balances.get(studentId);
    if (current === undefined) throw new InvalidCreditOperationError("Student not found");
    const resultingBalance = current + delta;
    if (resultingBalance < 0) throw new InsufficientCreditsError();
    const entry = Object.freeze({ id: this.id("ledger"), studentId, delta, resultingBalance, type, idempotencyKey: key,
      reason, actorType, actorId, sourceType, sourceId, metadata: structuredClone(metadata) });
    this.ledger.push(entry);
    this.ledgerKeys.set(key, entry);
    this.balances.set(studentId, resultingBalance);
    return entry;
  }

  grantPaidPurchase(input: Parameters<CreditStore["grantPaidPurchase"]>[0]): Promise<PurchaseRecord> {
    return this.atomic(() => {
      const sourceKeys = [`payment:${input.squarePaymentId}`, `order:${input.squareOrderId}`, `event:${input.sourceEventId}`];
      const ids = new Set(sourceKeys.map((key) => this.purchaseSources.get(key)).filter(Boolean));
      if (ids.size) {
        if (ids.size !== 1) throw new IdempotencyConflictError();
        const existing = this.purchases.get([...ids][0] as string)!;
        const signature = canonicalJson(["purchase_grant", input.studentId, input.planId, input.credits, input.priceCents, input.squarePaymentId, input.squareOrderId, input.sourceEventId, "square_webhook", input.actorId, "square_payment", input.squarePaymentId, input.metadata ?? {}]);
        if (existing.studentId !== input.studentId || existing.planId !== input.planId || existing.squarePaymentId !== input.squarePaymentId || existing.squareOrderId !== input.squareOrderId || existing.sourceEventId !== input.sourceEventId || existing.creditsGranted !== input.credits || existing.priceCents !== input.priceCents || this.operationSignatures.get(`purchase:${existing.id}`) !== signature) throw new IdempotencyConflictError();
        return { ...existing };
      }
      const purchase: PurchaseRecord = { id: this.id("purchase"), studentId: input.studentId, planId: input.planId, squarePaymentId: input.squarePaymentId, squareOrderId: input.squareOrderId, sourceEventId: input.sourceEventId, creditsGranted: input.credits, priceCents: input.priceCents, status: "paid", refundedCredits: 0 };
      const signature = canonicalJson(["purchase_grant", input.studentId, input.planId, input.credits, input.priceCents, input.squarePaymentId, input.squareOrderId, input.sourceEventId, "square_webhook", input.actorId, "square_payment", input.squarePaymentId, input.metadata ?? {}]);
      this.append(input.studentId, input.credits, "purchase_grant", `purchase:${purchase.id}`, "verified_square_payment", "square_webhook", input.actorId, "square_payment", input.squarePaymentId, input.metadata);
      this.operationSignatures.set(`purchase:${purchase.id}`, signature);
      this.purchases.set(purchase.id, purchase);
      for (const key of sourceKeys) this.purchaseSources.set(key, purchase.id);
      return { ...purchase };
    });
  }

  reserve(input: Parameters<CreditStore["reserve"]>[0]): Promise<RedemptionRecord> {
    return this.atomic(() => {
      const existingId = this.redemptionKeys.get(input.idempotencyKey);
      if (existingId) {
        const existing = this.redemptions.get(existingId)!;
        const signature = canonicalJson(["reservation", input.studentId, input.credits, "student", input.actorId, "reservation_request", input.idempotencyKey, input.metadata ?? {}]);
        if (existing.studentId !== input.studentId || existing.credits !== input.credits || this.operationSignatures.get(`reservation:${input.idempotencyKey}`) !== signature) throw new IdempotencyConflictError();
        return { ...existing };
      }
      const redemption: RedemptionRecord = { id: this.id("redemption"), studentId: input.studentId, credits: input.credits, idempotencyKey: input.idempotencyKey, status: "reserved" };
      this.append(input.studentId, -input.credits, "reservation", `reservation:${input.idempotencyKey}`, "meal_reserved", "student", input.actorId, "reservation_request", input.idempotencyKey, input.metadata);
      this.operationSignatures.set(`reservation:${input.idempotencyKey}`, canonicalJson(["reservation", input.studentId, input.credits, "student", input.actorId, "reservation_request", input.idempotencyKey, input.metadata ?? {}]));
      this.redemptions.set(redemption.id, redemption);
      this.redemptionKeys.set(input.idempotencyKey, redemption.id);
      return { ...redemption };
    });
  }

  redeem(input: Parameters<CreditStore["redeem"]>[0]): Promise<RedemptionRecord> {
    return this.atomic(() => {
      const redemption = this.redemptions.get(input.redemptionId);
      if (!redemption) throw new InvalidCreditOperationError("Redemption not found");
      if (redemption.status === "redeemed" && redemption.squareOrderId === input.squareOrderId) return { ...redemption };
      if (redemption.status !== "reserved") throw new InvalidCreditOperationError("Redemption cannot be redeemed");
      const orderRedemptionId = this.redemptionOrders.get(input.squareOrderId);
      if (orderRedemptionId && orderRedemptionId !== redemption.id) throw new IdempotencyConflictError();
      redemption.status = "redeemed";
      redemption.squareOrderId = input.squareOrderId;
      this.redemptionOrders.set(input.squareOrderId, redemption.id);
      return { ...redemption };
    });
  }

  reverseRedemption(input: Parameters<CreditStore["reverseRedemption"]>[0]): Promise<RedemptionRecord> {
    return this.atomic(() => {
      const redemption = this.redemptions.get(input.redemptionId);
      if (!redemption) throw new InvalidCreditOperationError("Redemption not found");
      const signature = canonicalJson(["redemption_reversal", redemption.id, redemption.studentId, redemption.credits, input.reason, "order_service", input.actorId, "redemption_reversal", input.idempotencyKey, input.metadata ?? {}]);
      const existing = this.ledgerKeys.get(input.idempotencyKey);
      if (existing) {
        if (this.operationSignatures.get(input.idempotencyKey) !== signature) throw new IdempotencyConflictError();
        return { ...redemption };
      }
      if (redemption.status !== "reserved" && redemption.status !== "redeemed") throw new InvalidCreditOperationError("Redemption cannot be reversed");
      this.append(redemption.studentId, redemption.credits, "redemption_reversal", input.idempotencyKey, input.reason, "order_service", input.actorId, "redemption_reversal", input.idempotencyKey, input.metadata);
      this.operationSignatures.set(input.idempotencyKey, signature);
      redemption.status = "reversed";
      return { ...redemption };
    });
  }

  refundPurchase(input: Parameters<CreditStore["refundPurchase"]>[0]): Promise<PurchaseRecord> {
    return this.atomic(() => {
      const purchase = this.purchases.get(input.purchaseId);
      if (!purchase) throw new InvalidCreditOperationError("Purchase not found");
      const signature = canonicalJson(["purchase_refund", purchase.id, purchase.studentId, input.creditsToReverse, "square_refund", "square_webhook", input.actorId, "square_refund", input.idempotencyKey, input.metadata ?? {}]);
      const existing = this.ledgerKeys.get(input.idempotencyKey);
      if (existing) {
        if (this.operationSignatures.get(input.idempotencyKey) !== signature) throw new IdempotencyConflictError();
        return { ...purchase };
      }
      if (purchase.refundedCredits + input.creditsToReverse > purchase.creditsGranted) throw new InvalidCreditOperationError("Refund exceeds purchased credits");
      this.append(purchase.studentId, -input.creditsToReverse, "purchase_refund", input.idempotencyKey, "square_refund", "square_webhook", input.actorId, "square_refund", input.idempotencyKey, input.metadata);
      this.operationSignatures.set(input.idempotencyKey, signature);
      purchase.refundedCredits += input.creditsToReverse;
      purchase.status = purchase.refundedCredits === purchase.creditsGranted ? "refunded" : "partially_refunded";
      return { ...purchase };
    });
  }
}
