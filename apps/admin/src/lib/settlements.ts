import type { PaymentMethod } from "@carnicerias/types";

export const PAYMENT_METHODS: PaymentMethod[] = ["CASH", "TRANSFER", "DEBIT", "CREDIT", "OTHER"];
export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  CASH: "Efectivo",
  TRANSFER: "Transferencia",
  DEBIT: "Débito",
  CREDIT: "Crédito",
  OTHER: "Otros"
};

export interface SettlementOverview {
  branchId: string;
  branchName: string;
  lastSettlementAt: string | null;
  periodStart: string;
  periodEnd: string;
  totalSalesCents: number;
  expectedCashCents: number;
}

export interface EmployeeSettlementTotal {
  profileId: string;
  displayName: string;
  ticketCount: number;
  salesCents: number;
}

export interface DeviceSyncSnapshot {
  deviceId: string;
  label: string;
  status: string;
  lastSeenAt: string;
}

export interface SettlementPreview {
  branchId: string;
  branchName: string;
  periodStart: string;
  periodEnd: string;
  timezone: string;
  totalSalesCents: number;
  ticketCount: number;
  soldWeightGrams: number;
  paymentTotals: Partial<Record<PaymentMethod, number>>;
  employeeTotals: EmployeeSettlementTotal[];
  devices: DeviceSyncSnapshot[];
}

export interface SettlementHistoryItem extends Omit<SettlementPreview, "timezone" | "devices"> {
  id: string;
  expectedCashCents: number;
  receivedCashCents: number;
  differenceCents: number;
  deviceSyncSnapshot: DeviceSyncSnapshot[];
  notes: string | null;
  status: "CONFIRMED" | "VOIDED";
  createdBy: string;
  createdByName: string;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
  hasLaterMovements: boolean;
}

export function settlementDifference(expectedCashCents: number, receivedCashCents: number) {
  if (!Number.isSafeInteger(expectedCashCents) || !Number.isSafeInteger(receivedCashCents) || expectedCashCents < 0 || receivedCashCents < 0) {
    throw new RangeError("Invalid settlement amounts");
  }
  return receivedCashCents - expectedCashCents;
}

export function parsePesosToCents(value: string) {
  const normalized = value.trim().replace(",", ".");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) throw new RangeError("Importe inválido");
  const cents = BigInt(match[1] ?? "") * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (cents < 0n || cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Importe inválido");
  return Number(cents);
}

export function toOrganizationLocalInput(iso: string, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return `${parts.year ?? ""}-${parts.month ?? ""}-${parts.day ?? ""}T${parts.hour ?? ""}:${parts.minute ?? ""}`;
}

export function organizationLocalDate(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}
