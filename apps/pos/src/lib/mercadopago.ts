import { parseBranchConfigResponse, type MercadoPagoConfigResult } from "./mercadopago-availability";
import { parseActionEnvelope, type MercadoPagoActionResult } from "./mercadopago-state";
import { supabase } from "./supabase";

/**
 * Cliente de las Edge Functions de Mercado Pago. El POS sólo manda ids de venta/dispositivo/operador
 * (y el monto de la venta ya validada localmente); NUNCA lleva credenciales de Mercado Pago ni
 * decide un estado de cobro: todo estado vuelve del backend.
 */
export interface MercadoPagoContext {
  deviceId: string;
  operatorProfileId: string;
  operatorToken: string;
}

const NETWORK_FAILURE: MercadoPagoActionResult = {
  ok: false,
  code: "NETWORK",
  message: "Sin conexión con el servidor de cobros.",
  order: null
};

async function callFunction(name: string, body: Record<string, unknown>): Promise<MercadoPagoActionResult> {
  try {
    const result = await supabase.functions.invoke<unknown>(name, { body });
    const data: unknown = result.data;
    const error: unknown = result.error;
    if (error) {
      // FunctionsHttpError: el cuerpo de la respuesta no-2xx trae el sobre { ok:false, code, message }.
      const context = (error as { context?: unknown }).context;
      if (context instanceof Response) {
        try {
          return parseActionEnvelope(await context.json());
        } catch {
          return NETWORK_FAILURE;
        }
      }
      return NETWORK_FAILURE;
    }
    return parseActionEnvelope(data);
  } catch {
    return NETWORK_FAILURE;
  }
}

/**
 * ¿Esta caja puede cobrar con Mercado Pago? Devuelve el resultado COMPLETO, incluido el error de la
 * RPC con su código, para poder diagnosticar por qué el botón no aparece (antes cualquier error se
 * convertía en `false` en silencio). Nunca lanza.
 */
export async function fetchMercadoPagoConfig(deviceId: string, expectedBranchId: string | null): Promise<MercadoPagoConfigResult> {
  try {
    const { data, error } = await supabase.rpc("mp_get_branch_config", { p_device_id: deviceId });
    return parseBranchConfigResponse(data, error, expectedBranchId);
  } catch (thrown) {
    return { status: "error", code: "NETWORK", message: thrown instanceof Error ? thrown.message : "Sin respuesta del servidor" };
  }
}

/** Genera (o recupera, es idempotente por venta) el cobro. `retry` abre un intento nuevo tras vencer/cancelar. */
export function createMercadoPagoOrder(context: MercadoPagoContext, saleId: string, amountCents: number, retry = false) {
  return callFunction("mp-create-order", {
    deviceId: context.deviceId, saleId, amountCents,
    operatorProfileId: context.operatorProfileId, operatorToken: context.operatorToken, retry
  });
}

export function fetchMercadoPagoStatus(deviceId: string, saleId: string) {
  return callFunction("mp-order-status", { deviceId, saleId });
}

export function cancelMercadoPagoOrder(deviceId: string, saleId: string) {
  return callFunction("mp-cancel-order", { deviceId, saleId });
}
