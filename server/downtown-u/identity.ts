const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const PHONE_INPUT_PATTERN = /^\+?[0-9() .-]+$/;

export function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) throw new Error("Invalid email");
  return normalized;
}

export function normalizePhone(value: string): string {
  const trimmed = value.trim();
  if (!PHONE_INPUT_PATTERN.test(trimmed)) throw new Error("Invalid phone");
  let digits = trimmed.replace(/\D/g, "");
  if (!trimmed.startsWith("+") && digits.length === 10) digits = `1${digits}`;
  const normalized = `+${digits}`;
  if (!E164_PATTERN.test(normalized)) throw new Error("Invalid phone");
  return normalized;
}
