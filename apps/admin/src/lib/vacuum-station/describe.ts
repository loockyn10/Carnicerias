import { STATION_PAUSE_LABELS, STATION_STATUS_LABELS, type StationState } from "./machine";

/** Qué le muestra la estación al operario según el estado de la máquina: título, detalle, color y qué botones de recuperación ofrecer. */

export type StationTone = "ok" | "working" | "warn" | "wait" | "error";
export type StationAction = "RESUME" | "RETRY" | "SKIP_PRINT";

export interface StationView {
  title: string;
  detail: string | null;
  tone: StationTone;
  actions: StationAction[];
}

export interface StationViewContext {
  productName: string | null;
  /** Primer motivo por el que el corte no está listo (null si está listo). */
  readinessProblem: string | null;
}

const REMOVAL_DETAILS: Record<NonNullable<StationState["removalReason"]>, string> = {
  PROCESSED: "Paquete procesado. Retiralo de la balanza para pesar el siguiente.",
  PRODUCT_CHANGED: "Cambiaste de corte con un paquete en la balanza: retiralo para seguir con el corte nuevo.",
  STARTUP: "Dejá la balanza vacía para empezar.",
  RECONNECTED: "Dejá la balanza vacía para seguir: no se sabe qué había sobre ella mientras estuvo desconectada.",
  PAUSED_WITH_WEIGHT: "Retirá el paquete de la balanza para seguir."
};

export function describeStation(state: StationState, context: StationViewContext): StationView {
  switch (state.status) {
    case "PAUSED": {
      const reason = state.pauseReason ?? "MANUAL";
      const title = reason === "MANUAL" ? "Producción pausada" : STATION_PAUSE_LABELS[reason];
      switch (reason) {
        case "MANUAL": return { title, detail: "No se registra ni se imprime nada hasta reanudar.", tone: "wait", actions: ["RESUME"] };
        case "SCALE_DISCONNECTED": return { title, detail: "Conectá la balanza para seguir. Al volver, dejá la balanza vacía antes del próximo paquete.", tone: "error", actions: [] };
        case "OFFLINE": return { title, detail: "No se registran paquetes sin conexión. Se reanuda sola al volver Internet.", tone: "error", actions: ["RESUME"] };
        case "REGISTER_FAILED": return { title, detail: state.error ?? "El servidor no confirmó el paquete.", tone: "error", actions: ["RETRY"] };
        case "PRINT_FAILED": return { title, detail: `${state.error ?? "La impresora no confirmó el envío."} El paquete SÍ quedó registrado: no se generó otro.`, tone: "error", actions: ["RETRY", "SKIP_PRINT"] };
      }
      break;
    }
    case "WAITING_REMOVAL":
      return { title: STATION_STATUS_LABELS.WAITING_REMOVAL, detail: REMOVAL_DETAILS[state.removalReason ?? "PROCESSED"], tone: "wait", actions: [] };
    case "REGISTERING":
      return { title: "Registrando…", detail: "Peso estable capturado. Guardando el paquete.", tone: "working", actions: [] };
    case "PRINTING":
      return { title: "Imprimiendo etiquetas…", detail: "El paquete ya está registrado.", tone: "working", actions: [] };
    case "WAITING_PACKAGE":
      if (context.productName === null) return { title: "Elegí el corte", detail: "Seleccioná qué vas a envasar para empezar.", tone: "warn", actions: [] };
      if (context.readinessProblem !== null) return { title: "El corte no está listo", detail: context.readinessProblem, tone: "warn", actions: [] };
      return { title: STATION_STATUS_LABELS.WAITING_PACKAGE, detail: `Corte: ${context.productName}`, tone: "ok", actions: [] };
    case "DETECTING":
      return { title: STATION_STATUS_LABELS.DETECTING, detail: state.grams !== null && state.anchor === null ? null : "Esperando que el peso se estabilice.", tone: "working", actions: [] };
    case "STABILIZING":
      if (context.readinessProblem !== null) return { title: "Peso estable, pero no se registra", detail: context.readinessProblem, tone: "warn", actions: [] };
      return state.moving
        ? { title: "Peso inestable", detail: "Esperando que el peso deje de cambiar.", tone: "working", actions: [] }
        : { title: STATION_STATUS_LABELS.STABILIZING, detail: "Manteniendo el peso para confirmarlo.", tone: "working", actions: [] };
  }
  return { title: STATION_STATUS_LABELS[state.status], detail: null, tone: "wait", actions: [] };
}
