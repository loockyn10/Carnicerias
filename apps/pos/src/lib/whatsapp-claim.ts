import { parseClaimResponse, type WhatsAppClaimOutcome } from "./whatsapp-claim-state";
import { supabase } from "./supabase";

/**
 * Cliente de la Edge Function `whatsapp-create-claim`. El POS manda ids de dispositivo/operador/venta; el
 * backend valida que la venta esté COMPLETED y devuelve únicamente el enlace del QR. El POS nunca conoce
 * credenciales de Meta ni arma el ticket. Acción explícita online: jamás entra a la outbox.
 */
export interface WhatsAppClaimContext {
  deviceId: string;
  operatorProfileId: string;
  operatorToken: string;
}

const NETWORK_ERROR: WhatsAppClaimOutcome = { kind: "error", message: "No se pudo contactar al servidor.", canRetry: true };

export async function requestWhatsAppClaim(context: WhatsAppClaimContext, saleId: string): Promise<WhatsAppClaimOutcome> {
  if (!navigator.onLine) return { kind: "offline" };
  try {
    const result = await supabase.functions.invoke<unknown>("whatsapp-create-claim", {
      body: { deviceId: context.deviceId, saleId, operatorProfileId: context.operatorProfileId, operatorToken: context.operatorToken }
    });
    const data: unknown = result.data;
    const error: unknown = result.error;
    if (error) {
      // FunctionsHttpError: el cuerpo de la respuesta no-2xx trae el sobre { ok:false, code, message }.
      const response = (error as { context?: unknown }).context;
      if (response instanceof Response) {
        try {
          return parseClaimResponse(await response.json());
        } catch {
          return NETWORK_ERROR;
        }
      }
      return NETWORK_ERROR;
    }
    return parseClaimResponse(data);
  } catch {
    return NETWORK_ERROR;
  }
}
