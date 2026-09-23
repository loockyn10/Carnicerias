import type { PaymentMethod } from "@carnicerias/types";

/**
 * Un ticket nuevo (o uno reseteado tras confirmar/cancelar una venta, cambiar
 * de sucursal, cerrar sesión de operador, etc.) siempre arranca sin método de
 * pago elegido: la empleada no debe poder ver/decir un precio antes de saber
 * cómo va a pagar el cliente.
 */
export const INITIAL_PAYMENT_METHOD: PaymentMethod | null = null;

/**
 * Los importes monetarios (precio/kg, subtotal, descuentos, promoción, TOTAL)
 * sólo se muestran una vez elegido el método de pago — ni en el footer del
 * ticket ni en el modal de agregar/modificar peso, para que la empleada no
 * pueda ver/decir un precio antes de saber cómo va a pagar el cliente.
 */
export function shouldDisplayTicketAmounts(paymentMethod: PaymentMethod | null): boolean {
  return paymentMethod !== null;
}

export function isSaleConfirmable(input: {
  paymentMethod: PaymentMethod | null;
  ticketLength: number;
  loading: boolean;
  deviceNeedsBinding: boolean;
}): boolean {
  return input.paymentMethod !== null && input.ticketLength > 0 && !input.loading && !input.deviceNeedsBinding;
}

/**
 * Guard defensivo para completeSale(): no confiar únicamente en el `disabled`
 * del botón. Devuelve el mensaje a mostrar si la venta no puede completarse
 * por falta de método de pago, o `null` si puede seguir.
 */
export function validatePaymentMethodForSale(paymentMethod: PaymentMethod | null): string | null {
  return paymentMethod === null ? "Seleccioná un método de pago." : null;
}
