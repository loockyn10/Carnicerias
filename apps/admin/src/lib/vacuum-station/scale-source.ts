/**
 * Frontera entre la estación y «de dónde sale el peso». La estación sólo conoce `ScaleSource`: puede ser la balanza real por Web Serial
 * (`serial-scale.ts`) o el simulador de desarrollo/pruebas (`simulator.ts`). Ninguna de las dos decide nada de negocio: sólo entregan lecturas y
 * el estado de la conexión.
 */

export type ScaleLinkStatus = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "ERROR";

export type ScaleSourceEvent =
  | { type: "sample"; grams: number; /** null = el protocolo no informa estabilidad. */ stable: boolean | null; atMs: number }
  | { type: "status"; status: ScaleLinkStatus; message: string | null; atMs: number }
  /** Una trama que no se pudo interpretar (se descarta; sólo informa para diagnóstico). */
  | { type: "frame-error"; message: string; atMs: number };

export type ScaleSourceListener = (event: ScaleSourceEvent) => void;

export interface ScaleSource {
  /** Se suscribe a las lecturas y al estado de la conexión. Devuelve la función para cancelar. */
  subscribe(listener: ScaleSourceListener): () => void;
  /** Cierra la conexión a pedido del operario (no se reconecta sola). */
  disconnect(): Promise<void>;
  readonly status: ScaleLinkStatus;
}

// ---------------------------------------------------------------------------------------------------------------------
// Web Serial: tipos mínimos. TypeScript todavía no trae los tipos de la API y no se agrega una dependencia sólo por eso.
// ---------------------------------------------------------------------------------------------------------------------

export interface SerialOpenOptions {
  baudRate: number;
  dataBits: 7 | 8;
  stopBits: 1 | 2;
  parity: "none" | "even" | "odd";
  bufferSize?: number;
  flowControl?: "none" | "hardware";
}

export interface SerialPortInfoLike {
  usbVendorId?: number | undefined;
  usbProductId?: number | undefined;
}

export interface SerialReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
  cancel(): Promise<void>;
  releaseLock(): void;
}

export interface SerialPortLike {
  readonly readable: { getReader(): SerialReaderLike } | null;
  open(options: SerialOpenOptions): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfoLike;
}

export interface SerialLike {
  requestPort(options?: { filters?: { usbVendorId?: number; usbProductId?: number }[] }): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
  addEventListener(type: "connect" | "disconnect", listener: (event: { target: unknown }) => void): void;
  removeEventListener(type: "connect" | "disconnect", listener: (event: { target: unknown }) => void): void;
}

/** ¿Este navegador tiene Web Serial? (Chrome y Edge de escritorio, en un contexto seguro: https o localhost.) */
export function webSerialSupport(): { supported: true; serial: SerialLike } | { supported: false; reason: string } {
  if (typeof navigator === "undefined") return { supported: false, reason: "Esta pantalla sólo funciona en el navegador." };
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return { supported: false, reason: "La conexión con la balanza requiere una página segura (https). Abrí el panel por https o desde localhost." };
  }
  const serial = (navigator as Navigator & { serial?: SerialLike }).serial;
  if (!serial) {
    return { supported: false, reason: "Este navegador no puede conectarse a la balanza (no tiene Web Serial). Usá Google Chrome o Microsoft Edge de escritorio, en Windows." };
  }
  return { supported: true, serial };
}
