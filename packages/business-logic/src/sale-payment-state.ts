/**
 * Cómo se presenta el cobro de una venta (Admin y POS): qué medio de pago es y — sobre todo para
 * Mercado Pago — si el dinero REALMENTE llegó. Lógica pura (sin red ni React) para poder probarla.
 *
 * Una venta Mercado Pago no se muestra como "COMPLETED/Transferencia": su medio es "Mercado Pago" y
 * su estado principal dice si el pago está pendiente, confirmado, o no se acreditó (cancelado/vencido).
 * El estado lo decide el backend (`sales.status` + `payments.verification_status`); acá sólo se traduce.
 */

export type SalePaymentTone = "success" | "warning" | "danger" | "neutral";

export interface SalePaymentInput {
  /** `sales.status`: DRAFT | PENDING_PAYMENT | COMPLETED | CANCELLED | REFUNDED. */
  saleStatus: string;
  /** `payments.method` (CASH | TRANSFER | DEBIT | CREDIT | OTHER) o null si la venta no informa medio. */
  method: string | null;
  /** `payments.provider`: hoy sólo MERCADOPAGO; null = medio manual. */
  provider: string | null;
  /** `payments.verification_status` (NOT_REQUIRED para medios manuales). */
  verificationStatus: string | null;
}

export interface SalePaymentView {
  /** Medio de pago para mostrar: "Mercado Pago" nunca aparece como "Transferencia". */
  methodLabel: string;
  /** Estado principal de la tarjeta de la venta (lo que el dueño lee de un vistazo). */
  badge: string;
  /** Aclaración corta bajo el estado (por qué / qué hacer); null si no hace falta. */
  detail: string | null;
  tone: SalePaymentTone;
  isMercadoPago: boolean;
  /** ¿El dinero de esta venta cuenta como cobrado? Sólo COMPLETED (para Mercado Pago, sólo acreditado). */
  collected: boolean;
}

const METHOD_LABELS: Record<string, string> = {
  CASH: "Efectivo",
  TRANSFER: "Transferencia",
  DEBIT: "Débito",
  CREDIT: "Crédito",
  OTHER: "Otro"
};

export const SALE_STATUS_LABELS: Record<string, string> = {
  DRAFT: "BORRADOR",
  PENDING_PAYMENT: "PAGO PENDIENTE",
  COMPLETED: "COMPLETADA",
  CANCELLED: "ANULADA",
  REFUNDED: "DEVUELTA"
};

export function paymentMethodLabel(method: string | null | undefined, provider?: string | null): string {
  if (provider === "MERCADOPAGO") return "Mercado Pago";
  return method ? (METHOD_LABELS[method] ?? method) : "Sin medio informado";
}

export function describeSalePayment(input: SalePaymentInput): SalePaymentView {
  const isMercadoPago = input.provider === "MERCADOPAGO";
  const methodLabel = paymentMethodLabel(input.method, input.provider);
  const collected = input.saleStatus === "COMPLETED";

  if (!isMercadoPago) {
    const badge = SALE_STATUS_LABELS[input.saleStatus] ?? input.saleStatus;
    const tone: SalePaymentTone = input.saleStatus === "CANCELLED" ? "danger" : input.saleStatus === "COMPLETED" ? "success" : "warning";
    return { methodLabel, badge, detail: null, tone, isMercadoPago, collected };
  }

  const verification = input.verificationStatus;
  const view = (badge: string, detail: string | null, tone: SalePaymentTone): SalePaymentView => ({ methodLabel, badge, detail, tone, isMercadoPago, collected });

  switch (input.saleStatus) {
    case "COMPLETED":
      if (verification === "CONFIRMED") return view("PAGO CONFIRMADO", "Mercado Pago acreditó el pago · venta completada", "success");
      if (verification === "REFUNDED") return view("PAGO DEVUELTO", "Mercado Pago informó una devolución", "warning");
      return view("SIN VERIFICAR", "Venta completada sin acreditación confirmada: revisar", "danger");
    case "PENDING_PAYMENT":
      if (verification === "MISMATCH") return view("MONTO DISTINTO", "Mercado Pago acreditó otro importe: revisar", "danger");
      if (verification === "ERROR") return view("PAGO PENDIENTE", "El cobro no pudo generarse: sin acreditación", "warning");
      return view("PAGO PENDIENTE", "Esperando que Mercado Pago acredite el pago", "warning");
    case "CANCELLED":
      if (verification === "EXPIRED") return view("VENCIDO · NO ACREDITADO", "El cobro venció sin pago · venta anulada", "danger");
      if (verification === "CONFIRMED") return view("ANULADA · PAGO ACREDITADO", "El pago llegó y la venta se anuló: devolver el dinero", "danger");
      return view("CANCELADO · NO ACREDITADO", "El cobro se canceló sin pago · venta anulada", "danger");
    default:
      return view(SALE_STATUS_LABELS[input.saleStatus] ?? input.saleStatus, null, "neutral");
  }
}
