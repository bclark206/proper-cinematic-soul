import { z } from "zod";

const MAX_RESPONSE_BYTES = 256 * 1024;
const TIMEOUT_MS = 10_000;
const id = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
const uuid = z.string().uuid();
const iso = z.string().datetime({ offset: true });
const cursor = z.string().min(1).max(512).regex(/^[A-Za-z0-9_.-]+$/);
const key = z.string().min(16).max(96).regex(/^[A-Za-z0-9_-]+$/);
const planId = z.enum(["flex-5", "scholar-10", "resident-20", "semester-40"]);

const modifierSchema = z.object({ id, name: z.string().min(1).max(120), creditDelta: z.number().int().min(-20).max(20) }).strict();
const reservationSchema = z.object({
  id: uuid, mealId: id, mealName: z.string().min(1).max(120), modifiers: z.array(modifierSchema).max(10),
  credits: z.number().int().min(1).max(40), status: z.enum(["reserved", "redeemed", "reversed"]),
  reservedAt: iso, expiresAt: iso, reversedAt: iso.optional(),
}).strict();
const meSchema = z.object({
  studentId: uuid, email: z.string().email().max(254).nullable(), phone: z.string().min(1).max(16).nullable(),
  eligibilityStatus: z.literal("approved"), availableCredits: z.number().int().nonnegative(),
  activePlan: z.object({ planId, creditsGranted: z.number().int().positive(), priceCents: z.number().int().positive(),
    currency: z.literal("USD"), status: z.enum(["paid", "partially_refunded"]), paidAt: iso }).strict().nullable(),
}).strict();
const mealSchema = z.object({ id, name: z.string().min(1).max(120), baseCredits: z.number().int().min(1).max(20), modifiers: z.array(modifierSchema).max(50) }).strict();
const purchaseSchema = z.object({
  id: uuid, planId, creditsGranted: z.number().int().positive(), priceCents: z.number().int().positive(), currency: z.literal("USD"),
  status: z.enum(["paid", "partially_refunded", "refunded"]), refundedCredits: z.number().int().nonnegative(), paidAt: iso, createdAt: iso,
}).strict();
const page = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item).max(100), nextCursor: cursor.nullable() }).strict();

export type DowntownUMe = z.infer<typeof meSchema>;
export type DowntownUMeal = z.infer<typeof mealSchema>;
export type DowntownUReservation = z.infer<typeof reservationSchema>;
export type DowntownUPurchase = z.infer<typeof purchaseSchema>;
export type DowntownUPage<T> = { items: T[]; nextCursor: string | null };
export type DowntownUFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type DowntownUErrorKind = "unauthorized" | "forbidden" | "not-found" | "invalid-request" | "conflict" |
  "insufficient-credits" | "rate-limited" | "unavailable" | "timeout" | "network" | "invalid-response";

export class DowntownUApiError extends Error {
  constructor(public readonly kind: DowntownUErrorKind, public readonly retryAfterSeconds?: number) {
    super(kind); this.name = "DowntownUApiError";
  }
}

const baseInit = (method: "GET" | "POST", signal: AbortSignal): RequestInit => ({
  method, credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer", signal,
});

async function boundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw new DowntownUApiError("invalid-response");
  const length = response.headers.get("Content-Length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) throw new DowntownUApiError("invalid-response");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new DowntownUApiError("invalid-response");
  try { return JSON.parse(text) as unknown; } catch { throw new DowntownUApiError("invalid-response"); }
}

function retryAfter(response: Response): number | undefined {
  const raw = response.headers.get("Retry-After");
  return raw && /^\d{1,6}$/.test(raw) ? Number(raw) : undefined;
}

async function failure(response: Response): Promise<never> {
  let code = "";
  try {
    const data = await boundedJson(response);
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      const descriptor = Object.getOwnPropertyDescriptor(data, "error");
      if (descriptor && "value" in descriptor && typeof descriptor.value === "string") code = descriptor.value;
    }
  } catch { /* status remains authoritative and details are intentionally discarded */ }
  if (response.status === 401) throw new DowntownUApiError("unauthorized");
  if (response.status === 403) throw new DowntownUApiError("forbidden");
  if (response.status === 404) throw new DowntownUApiError("not-found");
  if (response.status === 400) throw new DowntownUApiError("invalid-request");
  if (response.status === 409) throw new DowntownUApiError(code === "insufficient_credits" ? "insufficient-credits" : "conflict");
  if (response.status === 429) throw new DowntownUApiError("rate-limited", retryAfter(response));
  throw new DowntownUApiError("unavailable");
}

async function request<T>(url: string, init: Omit<RequestInit, "signal">, schema?: z.ZodType<T>, fetcher: DowntownUFetch = fetch): Promise<T> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let response: Response;
    try { response = await fetcher(url, { ...init, signal: controller.signal }); }
    catch { throw new DowntownUApiError(controller.signal.aborted ? "timeout" : "network"); }
    if (!response.ok) return await failure(response);
    if (response.status === 204) {
      if (schema) throw new DowntownUApiError("invalid-response");
      return undefined as T;
    }
    const data = await boundedJson(response);
    if (!schema) return data as T;
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new DowntownUApiError("invalid-response");
    return parsed.data;
  } finally { globalThis.clearTimeout(timer); }
}

function get<T>(url: string, schema: z.ZodType<T>, fetcher?: DowntownUFetch): Promise<T> {
  const controller = new AbortController();
  return request(url, baseInit("GET", controller.signal), schema, fetcher);
}
function post<T>(url: string, body: string, schema: z.ZodType<T> | undefined, fetcher?: DowntownUFetch): Promise<T> {
  const controller = new AbortController();
  return request(url, { ...baseInit("POST", controller.signal), headers: { "Content-Type": "application/json" }, body }, schema, fetcher);
}

export const getMe = (fetcher?: DowntownUFetch) => get("/api/downtown-u/me", meSchema, fetcher);
export const getMeals = (fetcher?: DowntownUFetch) => get("/api/downtown-u/meals", z.object({ items: z.array(mealSchema).max(100) }).strict(), fetcher);
export const getPurchases = (next: string | null = null, fetcher?: DowntownUFetch) => get(
  `/api/downtown-u/purchases?${new URLSearchParams({ limit: "25", ...(next ? { cursor: cursor.parse(next) } : {}) })}`,
  page(purchaseSchema), fetcher,
);
export const getReservations = (next: string | null = null, fetcher?: DowntownUFetch) => get(
  `/api/downtown-u/reservations?${new URLSearchParams({ limit: "25", ...(next ? { cursor: cursor.parse(next) } : {}) })}`,
  page(reservationSchema), fetcher,
);
export const requestMagicLink = (email: string, fetcher?: DowntownUFetch) => post(
  "/api/downtown-u/request-link", JSON.stringify({ email }), z.object({ accepted: z.literal(true) }).strict(), fetcher,
);
export const sendCode = (phone: string, fetcher?: DowntownUFetch) => post(
  "/api/downtown-u/send-code", JSON.stringify({ phone }), z.object({ accepted: z.literal(true) }).strict(), fetcher,
);
export const verifyCode = (challengeId: string, verifier: string, fetcher?: DowntownUFetch) => post(
  "/api/downtown-u/verify-code", JSON.stringify({ challengeId, verifier }), z.object({ authenticated: z.literal(true) }).strict(), fetcher,
);
export const reserveMeal = (input: { mealId: string; modifierIds: string[]; idempotencyKey: string }, fetcher?: DowntownUFetch) => {
  const validated = z.object({ mealId: id, modifierIds: z.array(id).max(10).refine((items) => new Set(items).size === items.length), idempotencyKey: key }).strict().parse(input);
  return post("/api/downtown-u/reservations", JSON.stringify(validated), reservationSchema, fetcher);
};
export const cancelReservation = (reservationId: string, idempotencyKey: string, fetcher?: DowntownUFetch) => post(
  `/api/downtown-u/reservations/${uuid.parse(reservationId)}/cancel`, JSON.stringify({ idempotencyKey: key.parse(idempotencyKey) }), reservationSchema, fetcher,
);
export const logout = (fetcher?: DowntownUFetch) => post<void>("/api/downtown-u/logout", "{}", undefined, fetcher);

export function createIdempotencyKey(cryptoImpl: Pick<Crypto, "getRandomValues"> = crypto): string {
  const bytes = new Uint8Array(24); cryptoImpl.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
