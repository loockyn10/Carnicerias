import type { PaymentMethod } from "@carnicerias/types";

/**
 * Un ticket nuevo (o uno reseteado tras confirmar/cancelar una venta, cambiar
 * de sucursal, cerrar sesión de operador, etc.) siempre arranca sin método de
 * pago elegido: la empleada no debe poder ver/decir un precio antes de saber
 * cómo va a pagar el cliente.
 */
export const INITIAL_PAYMENT_METHOD: PaymentMethod | null = null;

/**
 * Medio de pago con el que arranca un ticket nuevo (y al que vuelve después de vender/cancelar/resetear).
 * En el POS de Central (la sucursal productiva que decide el servidor, nunca el nombre) es Efectivo: el
 * mostrador vende casi todo en efectivo y los precios se ven desde el primer producto. En el resto de las
 * sucursales no cambia: sin medio elegido hasta que la empleada lo toque (INITIAL_PAYMENT_METHOD).
 */
export function initialPaymentMethodFor(centralPos: boolean): PaymentMethod | null {
  return centralPos ? "CASH" : INITIAL_PAYMENT_METHOD;
}

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
  /** Total a cobrar ya con el descuento general. Un ticket que queda en $0 (descuento 100%) no se cobra. */
  totalCents?: bigint;
}): boolean {
  return input.paymentMethod !== null && input.ticketLength > 0 && !input.loading && !input.deviceNeedsBinding
    && (input.totalCents === undefined || input.totalCents > 0n);
}

/**
 * Guard defensivo para completeSale(): no confiar únicamente en el `disabled`
 * del botón. Devuelve el mensaje a mostrar si la venta no puede completarse
 * por falta de método de pago, o `null` si puede seguir.
 */
export function validatePaymentMethodForSale(paymentMethod: PaymentMethod | null): string | null {
  return paymentMethod === null ? "Seleccioná un método de pago." : null;
}

/**
 * Botones de método de pago que se ofrecen. En una sucursal con Mercado Pago obligatorio la
 * "Transferencia" manual no existe (el único medio digital es Mercado Pago, verificado por el backend);
 * Efectivo y Tarjeta no cambian.
 */
export function filterPaymentMethodButtons<T extends { value: PaymentMethod }>(buttons: readonly T[], manualTransferOffered: boolean): T[] {
  return buttons.filter((button) => button.value !== "TRANSFER" || manualTransferOffered);
}
