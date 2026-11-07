import { createScaleFrameParser, SCALE_FRAME_ERROR_LABELS, type ScaleFrameParser, type ScaleProtocol, type SerialLineParams } from "@carnicerias/business-logic";

import type { UsbPortId } from "./config";
import type { ScaleLinkStatus, ScaleSource, ScaleSourceEvent, ScaleSourceListener, SerialLike, SerialPortLike, SerialReaderLike } from "./scale-source";

/**
 * Balanza real por Web Serial (RS232/USB). Mismo protocolo y mismo parser que el POS de escritorio (`@carnicerias/business-logic/scale-protocol`).
 *
 * Reglas que respeta:
 *  - el permiso inicial se pide SÓLO desde una acción del operario (`requestAndConnect`); al abrir la pantalla se intenta reencontrar entre los puertos ya
 *    autorizados (`reconnectAuthorized`), y si el navegador no lo permite se avisa — nunca se supone que reconectar sea posible sin intervención;
 *  - las desconexiones (cable USB, balanza apagada) se detectan por el evento `disconnect` y por el fin o el error de la lectura, y se reconecta con
 *    espera creciente mientras el puerto siga autorizado;
 *  - un error de línea (framing, paridad, desborde) no es fatal: se vuelve a tomar la lectura; un error de red o de dispositivo sí;
 *  - al reconectar se descarta cualquier trama a medias de la conexión anterior.
 */

export interface SerialScaleOptions {
  serial: SerialLike;
  protocol: ScaleProtocol;
  params: SerialLineParams;
  autoReconnect: boolean;
  now(): number;
  /** Espera inyectable (las pruebas no esperan de verdad). */
  sleep(ms: number): Promise<void>;
}

export const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 10_000] as const;
/** Errores de línea seguidos tolerados antes de dar la conexión por perdida. */
const MAX_CONSECUTIVE_READ_ERRORS = 5;

/** Traduce los errores del puerto a un mensaje que el operario pueda actuar. */
export function describeSerialError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  switch (name) {
    case "NotFoundError": return "No se eligió ningún puerto.";
    case "SecurityError": return "El navegador no permitió acceder al puerto serie. Revisá los permisos del sitio.";
    case "InvalidStateError": return "El puerto ya está en uso (otro programa, otra pestaña o el POS lo tiene abierto). Cerralo y volvé a conectar.";
    case "NetworkError": return "No se pudo abrir el puerto: revisá el cable, el adaptador USB-RS232 y su driver, y que ningún otro programa lo use.";
    case "BufferOverrunError": return "La balanza envió datos más rápido de lo que se pudieron leer.";
    case "FramingError": case "ParityError": return "Datos corruptos desde la balanza: revisá velocidad, bits de datos, paridad y bits de parada.";
    case "BreakError": return "La balanza interrumpió la transmisión.";
    default: return message !== "" ? `Error del puerto serie: ${message}` : "Error del puerto serie.";
  }
}

const NON_FATAL_READ_ERRORS = new Set(["BufferOverrunError", "FramingError", "ParityError", "BreakError"]);

export class SerialScale implements ScaleSource {
  status: ScaleLinkStatus = "DISCONNECTED";
  private readonly listeners = new Set<ScaleSourceListener>();
  private readonly parser: ScaleFrameParser;
  private port: SerialPortLike | null = null;
  private reader: SerialReaderLike | null = null;
  /** Se incrementa en cada conexión/desconexión: un lazo de lectura viejo se da cuenta de que ya no es el vigente. */
  private generation = 0;
  private userClosed = false;
  private reconnecting = false;
  private readonly onSerialDisconnect = (event: { target: unknown }) => {
    if (event.target === this.port) void this.lost("El cable o la balanza se desconectó.");
  };
  private readonly onSerialConnect = () => {
    if (this.userClosed || this.port !== null || !this.options.autoReconnect) return;
    void this.reconnectAuthorized(this.lastPortId);
  };
  private lastPortId: UsbPortId | null = null;

  constructor(private readonly options: SerialScaleOptions) {
    this.parser = createScaleFrameParser(options.protocol);
    options.serial.addEventListener("disconnect", this.onSerialDisconnect);
    options.serial.addEventListener("connect", this.onSerialConnect);
  }

  subscribe(listener: ScaleSourceListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(event: ScaleSourceEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private setStatus(status: ScaleLinkStatus, message: string | null = null): void {
    this.status = status;
    this.emit({ type: "status", status, message, atMs: this.options.now() });
  }

  /** Identificación USB del puerto actual, para guardarla en la configuración. */
  currentPortId(): UsbPortId | null {
    return this.port === null ? this.lastPortId : toUsbId(this.port);
  }

  /** Pide el permiso (diálogo del navegador) y conecta. DEBE llamarse desde un clic del operario. */
  async requestAndConnect(): Promise<boolean> {
    this.userClosed = false;
    let port: SerialPortLike;
    try {
      port = await this.options.serial.requestPort();
    } catch (error) {
      // Cancelar el diálogo no es un error de la balanza.
      if (error instanceof DOMException && error.name === "NotFoundError") return false;
      this.setStatus("ERROR", describeSerialError(error));
      return false;
    }
    return this.openPort(port);
  }

  /**
   * Reconecta SIN diálogo con un puerto que el navegador ya autorizó antes. Si hay uno guardado lo busca; si no, sólo se conecta cuando hay exactamente un
   * puerto autorizado (con varios no adivina cuál es la balanza). Devuelve false si no pudo.
   */
  async reconnectAuthorized(saved: UsbPortId | null): Promise<boolean> {
    this.userClosed = false;
    this.lastPortId = saved ?? this.lastPortId;
    let ports: SerialPortLike[];
    try {
      ports = await this.options.serial.getPorts();
    } catch (error) {
      this.setStatus("ERROR", describeSerialError(error));
      return false;
    }
    const wanted = saved ?? this.lastPortId;
    const match = wanted === null ? (ports.length === 1 ? ports[0] : undefined) : ports.find((port) => sameUsbId(toUsbId(port), wanted));
    if (match === undefined) {
      this.setStatus("DISCONNECTED", ports.length === 0 ? "No hay un puerto autorizado: usá «Conectar balanza» para elegirlo." : "No se pudo elegir el puerto automáticamente: usá «Conectar balanza».");
      return false;
    }
    return this.openPort(match);
  }

  private async openPort(port: SerialPortLike): Promise<boolean> {
    const generation = ++this.generation;
    this.setStatus("CONNECTING");
    try {
      await port.open({ ...this.options.params, bufferSize: 1024, flowControl: "none" });
    } catch (error) {
      if (generation === this.generation) this.setStatus("ERROR", describeSerialError(error));
      return false;
    }
    if (generation !== this.generation) {
      await port.close().catch(() => undefined);
      return false;
    }
    this.port = port;
    this.lastPortId = toUsbId(port);
    this.parser.reset();
    this.setStatus("CONNECTED");
    void this.readLoop(port, generation);
    return true;
  }

  private async readLoop(port: SerialPortLike, generation: number): Promise<void> {
    let consecutiveErrors = 0;
    while (generation === this.generation && port.readable !== null) {
      const reader = port.readable.getReader();
      this.reader = reader;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (generation !== this.generation) return;
          if (done) { void this.lost("La balanza dejó de enviar datos."); return; }
          consecutiveErrors = 0;
          if (value) this.handleBytes(value);
        }
      } catch (error) {
        if (generation !== this.generation) return;
        const name = error instanceof Error ? error.name : "";
        consecutiveErrors += 1;
        if (!NON_FATAL_READ_ERRORS.has(name) || consecutiveErrors > MAX_CONSECUTIVE_READ_ERRORS) {
          void this.lost(describeSerialError(error));
          return;
        }
        this.emit({ type: "frame-error", message: describeSerialError(error), atMs: this.options.now() });
      } finally {
        try { reader.releaseLock(); } catch { /* el lector ya estaba liberado */ }
        if (this.reader === reader) this.reader = null;
      }
    }
    if (generation === this.generation) void this.lost("El puerto se cerró.");
  }

  private handleBytes(bytes: Uint8Array): void {
    const atMs = this.options.now();
    for (const item of this.parser.feed(bytes)) {
      if (item.ok) this.emit({ type: "sample", grams: item.grams, stable: item.stable, atMs });
      else this.emit({ type: "frame-error", message: SCALE_FRAME_ERROR_LABELS[item.code], atMs });
    }
  }

  /** Se perdió la conexión (cable, balanza apagada, error fatal): se cierra todo y, si corresponde, se intenta reconectar. */
  private async lost(message: string): Promise<void> {
    if (this.userClosed || this.port === null) return;
    const port = this.port;
    this.generation += 1;
    this.port = null;
    await this.release(port);
    this.setStatus("ERROR", message);
    if (this.options.autoReconnect) void this.reconnectLoop();
  }

  /** ¿Hay un puerto abierto? (un método aparte: el estado cambia entre los `await` y el análisis de tipos no lo sigue). */
  private isOpen(): boolean {
    return this.port !== null;
  }

  private shouldStopReconnecting(): boolean {
    return this.userClosed || this.isOpen();
  }

  private async reconnectLoop(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      for (let attempt = 0; !this.shouldStopReconnecting(); attempt += 1) {
        await this.options.sleep(RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 10_000);
        if (this.shouldStopReconnecting()) return;
        let ports: SerialPortLike[] = [];
        try { ports = await this.options.serial.getPorts(); } catch { /* se reintenta */ }
        const wanted = this.lastPortId;
        const match = wanted === null ? (ports.length === 1 ? ports[0] : undefined) : ports.find((port) => sameUsbId(toUsbId(port), wanted));
        if (match !== undefined && (await this.openPort(match))) return;
      }
    } finally {
      this.reconnecting = false;
    }
  }

  private async release(port: SerialPortLike): Promise<void> {
    const reader = this.reader;
    this.reader = null;
    if (reader) {
      await reader.cancel().catch(() => undefined);
      try { reader.releaseLock(); } catch { /* ya liberado */ }
    }
    await port.close().catch(() => undefined);
  }

  /** Desconexión pedida por el operario: no se reconecta sola. */
  async disconnect(): Promise<void> {
    this.userClosed = true;
    this.generation += 1;
    const port = this.port;
    this.port = null;
    if (port) await this.release(port);
    this.parser.reset();
    this.setStatus("DISCONNECTED");
  }

  /** Libera los oyentes globales (al cerrar la pantalla). */
  async dispose(): Promise<void> {
    await this.disconnect();
    this.options.serial.removeEventListener("disconnect", this.onSerialDisconnect);
    this.options.serial.removeEventListener("connect", this.onSerialConnect);
    this.listeners.clear();
  }
}

function toUsbId(port: SerialPortLike): UsbPortId | null {
  const info = port.getInfo();
  return typeof info.usbVendorId === "number" && typeof info.usbProductId === "number" ? { usbVendorId: info.usbVendorId, usbProductId: info.usbProductId } : null;
}

function sameUsbId(a: UsbPortId | null, b: UsbPortId): boolean {
  return a !== null && a.usbVendorId === b.usbVendorId && a.usbProductId === b.usbProductId;
}
