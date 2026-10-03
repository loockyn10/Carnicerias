import { parseSendResponse, type WhatsAppSendOutcome } from "./whatsapp-ticket-state";
import { supabase } from "./supabase";

/**
 * Cliente de la Edge Function `whatsapp-send-ticket`. El POS sólo manda ids de dispositivo/operador/venta
 * y el teléfono; NUNCA lleva credenciales de Meta ni el contenido del ticket (total, líneas, texto): el
 * servidor lo reconstruye desde la venta real. Es una acción explícita online: jamás entra a la outbox.
 */
export interface WhatsAppTicketContext {
  deviceId: string;
  operatorProfileId: string;
  operatorToken: string;
}

const NETWORK_ERROR: WhatsAppSendOutcome = { kind: "error", message: "No se pudo contactar al servidor.", canRetry: true };

export async function sendWhatsAppTicket(context: WhatsAppTicketContext, saleId: string, phone: string, resend: boolean): Promise<WhatsAppSendOutcome> {
  if (!navigator.onLine) return { kind: "offline" };
  try {
    const result = await supabase.functions.invoke<unknown>("whatsapp-send-ticket", {
      body: {
        deviceId: context.deviceId, saleId, phone, resend,
        operatorProfileId: context.operatorProfileId, operatorToken: context.operatorToken
      }
    });
    const data: unknown = result.data;
    const error: unknown = result.error;
    if (error) {
      // FunctionsHttpError: el cuerpo de la respuesta no-2xx trae el sobre { ok:false, code, message }.
      const response = (error as { context?: unknown }).context;
      if (response instanceof Response) {
        try {
          return parseSendResponse(await response.json());
        } catch {
          return NETWORK_ERROR;
        }
      }
      return NETWORK_ERROR;
    }
    return parseSendResponse(data);
  } catch {
    return NETWORK_ERROR;
  }
}
