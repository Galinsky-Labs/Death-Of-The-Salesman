export const CURRENCY_MINOR_UNITS = { USD: 2, EUR: 2, GBP: 2, JPY: 0, KWD: 3 } as const;
export type Currency = keyof typeof CURRENCY_MINOR_UNITS;
export type AccountKind = "cash" | "allocated" | "reserved" | "incurred" | "paid" | "offset";
export type BudgetAccount = { id: string; organizationId: string; currency: Currency; kind: AccountKind };
export type Posting = { accountId: string; amountMinor: string };
export type Journal = { id: string; organizationId: string; currency: Currency; idempotencyKey: string; postings: readonly Posting[] };
export type Reservation = { id: string; organizationId: string; accountId: string; currency: Currency; amountMinor: string; state: "open" | "settled" | "released" };
export type InvoiceAmounts = { currency: Currency; allocatedMinor: string; incurredMinor: string; paidMinor: string };
const MAX = 9223372036854775807n;
const MIN = -9223372036854775808n;
export function currency(value: string): Currency {
  if (!Object.hasOwn(CURRENCY_MINOR_UNITS, value)) throw new Error("Unsupported currency");
  return value as Currency;
}
export function minor(value: unknown, signed = false): bigint {
  if (typeof value !== "string" || !(signed ? /^(0|-?[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(value) || value.length > 20) throw new Error("Minor units must be canonical integer strings");
  const n = BigInt(value);
  if (n > MAX || n < (signed ? MIN : 0n)) throw new Error("Minor units exceed signed 64-bit storage");
  return n;
}
export function decimalToMinor(value: string, code: Currency): string {
  const digits = CURRENCY_MINOR_UNITS[currency(code)];
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value) || value.length > 30) throw new Error("Invalid decimal money string");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > digits) throw new Error("Fraction exceeds currency minor units; rounding is not implicit");
  return minor((BigInt(whole!) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, "0") || "0")).toString()).toString();
}
export function validateJournal(journal: Journal, accounts: readonly BudgetAccount[]): void {
  currency(journal.currency);
  if (!journal.idempotencyKey.trim() || journal.idempotencyKey.length > 120 || journal.postings.length < 2 || journal.postings.length > 200) throw new Error("Invalid journal shape");
  const ids = new Set<string>(); let total = 0n;
  for (const posting of journal.postings) {
    const account = accounts.find(a => a.id === posting.accountId && a.organizationId === journal.organizationId);
    if (!account || account.currency !== journal.currency) throw new Error("Posting account tenant/currency mismatch");
    if (ids.has(posting.accountId)) throw new Error("Combine repeated account postings before submission");
    ids.add(posting.accountId);
    const amount = minor(posting.amountMinor, true);
    if (amount === 0n) throw new Error("Zero posting is not an entry");
    total += amount;
  }
  if (total !== 0n) throw new Error("Journal debits and credits must balance exactly");
}
export function reconcile(accounts: readonly BudgetAccount[], journals: readonly Journal[]): Readonly<Record<string, string>> {
  const balances: Record<string, bigint> = Object.fromEntries(accounts.map(a => [a.id, 0n]));
  const journalIds = new Set<string>(), keys = new Set<string>();
  for (const journal of journals) {
    validateJournal(journal, accounts);
    const key = `${journal.organizationId}:${journal.idempotencyKey}`;
    if (journalIds.has(journal.id) || keys.has(key)) throw new Error("Duplicate journal or idempotency key");
    journalIds.add(journal.id); keys.add(key);
    for (const posting of journal.postings) balances[posting.accountId] = balances[posting.accountId]! + minor(posting.amountMinor, true);
  }
  return Object.fromEntries(Object.entries(balances).map(([id, balance]) => [id, balance.toString()]));
}
export function validateInvoice(invoice: InvoiceAmounts): void {
  currency(invoice.currency);
  minor(invoice.allocatedMinor); const incurred = minor(invoice.incurredMinor), paid = minor(invoice.paidMinor);
  if (paid > incurred) throw new Error("Paid invoice amount cannot exceed incurred amount");
}
export function validateReservation(reservation: Reservation, account: BudgetAccount): void {
  if (reservation.organizationId !== account.organizationId || reservation.accountId !== account.id || reservation.currency !== account.currency) throw new Error("Reservation account tenant/currency mismatch");
  if (minor(reservation.amountMinor) === 0n || !["open", "settled", "released"].includes(reservation.state)) throw new Error("Invalid reservation");
}
