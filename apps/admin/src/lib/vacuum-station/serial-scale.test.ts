import { afterEach, describe, expect, it, vi } from "vitest";

import { describeSerialError, SerialScale } from "./serial-scale";
import { webSerialSupport, type ScaleSourceEvent, type SerialLike, type SerialOpenOptions, type SerialPortLike, type SerialReaderLike } from "./scale-source";

const STX = 0x02;
const CR = 0x0d;
const frame = (text: string) => Uint8Array.from([STX, ...Array.from(text, (char) => char.charCodeAt(0)), CR]);

async function flush() {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

function domError(name: string, message = name): DOMException {
  return new DOMException(message, name);
}

/** Puerto de mentira: una cola de lecturas que el test llena con `push`, `fail` y `end`. */
class FakePort implements SerialPortLike {
  opened: SerialOpenOptions | null = null;
  openError: Error | null = null;
  closed = 0;
  open = vi.fn((options: SerialOpenOptions) => {
    if (this.openError) return Promise.reject(this.openError);
    this.opened = options;
    return Promise.resolve();
  });
  private pending: { resolve: (value: { done: boolean; value?: Uint8Array | undefined }) => void; reject: (error: Error) => void } | null = null;
  private queue: ({ kind: "data"; value: Uint8Array } | { kind: "end" } | { kind: "error"; error: Error })[] = [];
  private lock = false;
  isReadable = true;

  constructor(readonly info: { usbVendorId?: number; usbProductId?: number } = { usbVendorId: 0x1a86, usbProductId: 0x7523 }) {}

  get readable(): SerialPortLike["readable"] {
    if (!this.isReadable) return null;
    return { getReader: () => this.reader() };
  }

  getInfo() { return this.info; }

  close = vi.fn(() => { this.closed += 1; return Promise.resolve(); });

  private reader(): SerialReaderLike {
    this.lock = true;
    return {
      read: () => new Promise((resolve, reject) => {
        const next = this.queue.shift();
        if (next === undefined) { this.pending = { resolve, reject }; return; }
        if (next.kind === "data") resolve({ done: false, value: next.value });
        else if (next.kind === "end") resolve({ done: true });
        else reject(next.error);
      }),
      cancel: () => { this.pending?.resolve({ done: true }); this.pending = null; return Promise.resolve(); },
      releaseLock: () => { this.lock = false; }
    };
  }

  get locked() { return this.lock; }

  private deliver(item: FakePort["queue"][number]) {
    if (this.pending) {
      const { resolve, reject } = this.pending;
      this.pending = null;
      if (item.kind === "data") resolve({ done: false, value: item.value });
      else if (item.kind === "end") resolve({ done: true });
      else reject(item.error);
    } else this.queue.push(item);
  }

  push(bytes: Uint8Array) { this.deliver({ kind: "data", value: bytes }); }
  end() { this.deliver({ kind: "end" }); }
  fail(error: Error) { this.deliver({ kind: "error", error }); }
}

class FakeSerial implements SerialLike {
  ports: FakePort[] = [];
  requestResult: FakePort | Error | null = null;
  private readonly handlers = { connect: new Set<(event: { target: unknown }) => void>(), disconnect: new Set<(event: { target: unknown }) => void>() };
  requestPort = vi.fn(() => {
    if (this.requestResult instanceof Error) return Promise.reject(this.requestResult);
    if (this.requestResult === null) return Promise.reject(domError("NotFoundError"));
    return Promise.resolve(this.requestResult);
  });
  getPorts = vi.fn(() => Promise.resolve(this.ports));
  addEventListener(type: "connect" | "disconnect", listener: (event: { target: unknown }) => void) { this.handlers[type].add(listener); }
  removeEventListener(type: "connect" | "disconnect", listener: (event: { target: unknown }) => void) { this.handlers[type].delete(listener); }
  fire(type: "connect" | "disconnect", target: unknown) { for (const handler of this.handlers[type]) handler({ target }); }
  listenerCount() { return this.handlers.connect.size + this.handlers.disconnect.size; }
}

function setup(options: { autoReconnect?: boolean; protocol?: "KRETZ_STX_CR" | "ASCII_LINE" } = {}) {
  const serial = new FakeSerial();
  const events: ScaleSourceEvent[] = [];
  let clock = 0;
  const sleeps: (() => void)[] = [];
  const scale = new SerialScale({
    serial, protocol: options.protocol ?? "KRETZ_STX_CR", params: { baudRate: 9600, dataBits: 8, stopBits: 2, parity: "none" }, autoReconnect: options.autoReconnect ?? true,
    now: () => { clock += 10; return clock; },
    sleep: () => new Promise<void>((resolve) => { sleeps.push(resolve); })
  });
  scale.subscribe((event) => events.push(event));
  const statuses = () => events.filter((event) => event.type === "status").map((event) => event.status);
  const samples = () => events.filter((event) => event.type === "sample");
  return { serial, scale, events, statuses, samples, wake: async () => { sleeps.shift()?.(); await flush(); }, pendingSleeps: () => sleeps.length };
}

describe("conexión con la balanza (Web Serial)", () => {
  it("pide el puerto por una acción del operario y abre con los parámetros del KRETZ: 9600 8N2", async () => {
    const t = setup();
    const port = new FakePort();
    t.serial.requestResult = port;
    expect(await t.scale.requestAndConnect()).toBe(true);
    expect(port.opened).toMatchObject({ baudRate: 9600, dataBits: 8, stopBits: 2, parity: "none" });
    expect(t.statuses()).toEqual(["CONNECTING", "CONNECTED"]);
    expect(t.scale.currentPortId()).toEqual({ usbVendorId: 0x1a86, usbProductId: 0x7523 });
  });

  it("lee frames, también los partidos entre lecturas, y entrega gramos enteros sin inventar estabilidad", async () => {
    const t = setup();
    const port = new FakePort();
    t.serial.requestResult = port;
    await t.scale.requestAndConnect();
    port.push(frame("00.410"));
    port.push(Uint8Array.from([STX, 0x30, 0x31]));
    port.push(Uint8Array.from([0x2e, 0x32, 0x35, 0x30, CR]));
    await flush();
    expect(t.samples().map((event) => [event.grams, event.stable])).toEqual([[410, null], [1250, null]]);
  });

  it("una trama inválida se descarta y se informa, sin cortar la lectura", async () => {
    const t = setup();
    const port = new FakePort();
    t.serial.requestResult = port;
    await t.scale.requestAndConnect();
    port.push(frame("ABC"));
    port.push(frame("01.000"));
    await flush();
    expect(t.events.filter((event) => event.type === "frame-error")).toHaveLength(1);
    expect(t.samples()).toHaveLength(1);
  });

  it("cancelar el diálogo del navegador no es un error de la balanza", async () => {
    const t = setup();
    expect(await t.scale.requestAndConnect()).toBe(false);
    expect(t.statuses()).toEqual([]);
  });

  it("un puerto ocupado muestra un mensaje que el operario puede actuar", async () => {
    const t = setup();
    const port = new FakePort();
    port.openError = domError("InvalidStateError");
    t.serial.requestResult = port;
    expect(await t.scale.requestAndConnect()).toBe(false);
    const last = t.events.at(-1);
    expect(last).toMatchObject({ type: "status", status: "ERROR" });
    expect(last?.type === "status" && last.message).toContain("en uso");
  });

  it("describe los errores del puerto en castellano", () => {
    expect(describeSerialError(domError("NetworkError"))).toContain("cable");
    expect(describeSerialError(domError("SecurityError"))).toContain("permisos");
    expect(describeSerialError(domError("FramingError"))).toContain("paridad");
    expect(describeSerialError(new Error("boom"))).toContain("boom");
  });
});

describe("reconexión", () => {
  it("reencuentra el puerto ya autorizado sin diálogo", async () => {
    const t = setup();
    const port = new FakePort();
    t.serial.ports = [new FakePort({ usbVendorId: 1, usbProductId: 1 }), port];
    expect(await t.scale.reconnectAuthorized({ usbVendorId: 0x1a86, usbProductId: 0x7523 })).toBe(true);
    expect(port.open).toHaveBeenCalled();
    expect(t.serial.requestPort).not.toHaveBeenCalled();
  });

  it("sin puertos autorizados avisa que hay que elegir uno (no supone que se pueda reconectar)", async () => {
    const t = setup();
    expect(await t.scale.reconnectAuthorized(null)).toBe(false);
    expect(t.events.at(-1)).toMatchObject({ type: "status", status: "DISCONNECTED" });
    expect(JSON.stringify(t.events.at(-1))).toContain("Conectar balanza");
  });

  it("con varios puertos autorizados y ninguno guardado no adivina cuál es la balanza", async () => {
    const t = setup();
    t.serial.ports = [new FakePort({ usbVendorId: 1, usbProductId: 1 }), new FakePort({ usbVendorId: 2, usbProductId: 2 })];
    expect(await t.scale.reconnectAuthorized(null)).toBe(false);
  });

  it("con un único puerto autorizado y ninguno guardado lo usa", async () => {
    const t = setup();
    t.serial.ports = [new FakePort()];
    expect(await t.scale.reconnectAuthorized(null)).toBe(true);
  });

  it("si se desconecta el cable lo detecta y reconecta solo, descartando la trama a medias", async () => {
    const t = setup();
    const port = new FakePort();
    t.serial.requestResult = port;
    t.serial.ports = [port];
    await t.scale.requestAndConnect();
    port.push(Uint8Array.from([STX, 0x39, 0x39, 0x2e]));
    await flush();
    t.serial.fire("disconnect", port);
    await flush();
    expect(t.statuses().at(-1)).toBe("ERROR");
    expect(t.pendingSleeps()).toBe(1);
    await t.wake();
    expect(t.statuses().at(-1)).toBe("CONNECTED");
    port.push(frame("00.500"));
    await flush();
    expect(t.samples().map((event) => event.grams)).toEqual([500]);
  });

  it("sin reconexión automática queda en error hasta que el operario conecte", async () => {
    const t = setup({ autoReconnect: false });
    const port = new FakePort();
    t.serial.requestResult = port;
    t.serial.ports = [port];
    await t.scale.requestAndConnect();
    t.serial.fire("disconnect", port);
    await flush();
    expect(t.statuses().at(-1)).toBe("ERROR");
    expect(t.pendingSleeps()).toBe(0);
  });

  it("si el puerto no vuelve sigue reintentando con espera, sin colgarse", async () => {
    const t = setup();
    const port = new FakePort();
    t.serial.requestResult = port;
    await t.scale.requestAndConnect();
    t.serial.fire("disconnect", port);
    await flush();
    await t.wake();
    expect(t.statuses().at(-1)).toBe("ERROR");
    expect(t.pendingSleeps()).toBe(1);
    t.serial.ports = [port];
    await t.wake();
    expect(t.statuses().at(-1)).toBe("CONNECTED");
  });

  it("cuando la balanza deja de enviar (fin de la lectura) lo trata como pérdida de conexión", async () => {
    const t = setup({ autoReconnect: false });
    const port = new FakePort();
    t.serial.requestResult = port;
    await t.scale.requestAndConnect();
    port.end();
    await flush();
    expect(t.statuses().at(-1)).toBe("ERROR");
    expect(port.closed).toBe(1);
  });

  it("un error de línea no es fatal: sigue leyendo; un error de dispositivo sí lo es", async () => {
    const t = setup({ autoReconnect: false });
    const port = new FakePort();
    t.serial.requestResult = port;
    await t.scale.requestAndConnect();
    port.fail(domError("FramingError"));
    await flush();
    expect(t.statuses().at(-1)).toBe("CONNECTED");
    port.push(frame("00.300"));
    await flush();
    expect(t.samples()).toHaveLength(1);
    port.fail(domError("NetworkError"));
    await flush();
    expect(t.statuses().at(-1)).toBe("ERROR");
  });

  it("desconectar a pedido no reconecta y libera el puerto", async () => {
    const t = setup();
    const port = new FakePort();
    t.serial.requestResult = port;
    t.serial.ports = [port];
    await t.scale.requestAndConnect();
    await t.scale.disconnect();
    await flush();
    expect(t.statuses().at(-1)).toBe("DISCONNECTED");
    expect(port.closed).toBe(1);
    expect(port.locked).toBe(false);
    expect(t.pendingSleeps()).toBe(0);
  });

  it("dispose() libera los oyentes globales del navegador", async () => {
    const t = setup();
    expect(t.serial.listenerCount()).toBe(2);
    await t.scale.dispose();
    expect(t.serial.listenerCount()).toBe(0);
  });
});

describe("protocolo con indicador de estabilidad", () => {
  it("entrega la señal ST/US de la balanza", async () => {
    const t = setup({ protocol: "ASCII_LINE" });
    const port = new FakePort();
    t.serial.requestResult = port;
    await t.scale.requestAndConnect();
    port.push(Uint8Array.from(Array.from("US,GS,  0.500 kg\r\nST,GS,  0.500 kg\r\n", (char) => char.charCodeAt(0))));
    await flush();
    expect(t.samples().map((event) => event.stable)).toEqual([false, true]);
  });
});

describe("compatibilidad del navegador", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("sin Web Serial muestra un mensaje claro de incompatibilidad", () => {
    vi.stubGlobal("navigator", {});
    const result = webSerialSupport();
    expect(result.supported).toBe(false);
    expect(!result.supported && result.reason).toContain("Chrome");
  });

  it("con Web Serial en un contexto seguro es compatible", () => {
    vi.stubGlobal("navigator", { serial: new FakeSerial() });
    expect(webSerialSupport().supported).toBe(true);
  });

  it("fuera de un contexto seguro avisa que hace falta https", () => {
    vi.stubGlobal("window", { isSecureContext: false });
    vi.stubGlobal("navigator", { serial: new FakeSerial() });
    const result = webSerialSupport();
    expect(!result.supported && result.reason).toContain("https");
  });
});
