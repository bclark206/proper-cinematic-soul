import { normalizeEmail, normalizePhone } from "./identity";

export type EligibilityStatus = "pending" | "approved" | "rejected" | "suspended";
export interface StudentAccount {
  id: string;
  normalizedEmail?: string;
  normalizedPhone?: string;
  squareCustomerId?: string;
  eligibilityStatus: EligibilityStatus;
}
export interface StudentAccountStore {
  upsert(input: { normalizedEmail?: string; normalizedPhone?: string; squareCustomerId?: string }): Promise<StudentAccount>;
}

export class StudentAccounts {
  constructor(private readonly store: StudentAccountStore) {}

  upsert(input: { email?: string; phone?: string; squareCustomerId?: string }): Promise<StudentAccount> {
    const normalizedEmail = input.email === undefined ? undefined : normalizeEmail(input.email);
    const normalizedPhone = input.phone === undefined ? undefined : normalizePhone(input.phone);
    if (!normalizedEmail && !normalizedPhone) throw new Error("Email or phone is required");
    const squareCustomerId = input.squareCustomerId?.trim();
    if (squareCustomerId !== undefined && (squareCustomerId.length === 0 || squareCustomerId.length > 255)) throw new Error("Invalid Square customer ID");
    return this.store.upsert({ normalizedEmail, normalizedPhone, ...(squareCustomerId ? { squareCustomerId } : {}) });
  }
}
