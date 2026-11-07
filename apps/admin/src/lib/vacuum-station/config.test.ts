import { describe, expect, it } from "vitest";

import {
  approvePrintTest, DEFAULT_STATION_CONFIG, isAutoPrintEnabled, isPrintTestCurrent, loadStationConfig, normalizeStationConfig, normalizeTuning, printSignature, saveStationConfig,
  setAutoPrint, setRotation, STATION_CONFIG_KEY, type StationStorage
} from "./config";
import { DEFAULT_STATION_TUNING } from "./machine";
import { isSimulatorAllowed, SimulatedScale } from "./simulator";

const dims = { widthMm: 58, infoHeightMm: 40, priceHeightMm: 40 };

class MemoryStorage implements StationStorage {
  data = new Map<string, string>();
  throwOnSet = false;
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.throwOnSet) throw new Error("quota"); this.data.set(key, value); }
}

describe("configuración de la estación", () => {
  it("sin nada guardado usa los valores por defecto: 800 ms, KRETZ 9600 8N2, impresión automática apagada", () => {
    const config = loadStationConfig(new MemoryStorage());
    expect(config).toEqual(DEFAULT_STATION_CONFIG);
    expect(config.tuning.stableMs).toBe(800);
    expect(config.scale.params).toEqual({ baudRate: 9600, dataBits: 8, stopBits: 2, parity: "none" });
    expect(config.print.auto).toBe(false);
  });

  it("guarda y vuelve a leer lo mismo", () => {
    const storage = new MemoryStorage();
    const config = { ...DEFAULT_STATION_CONFIG, branchId: "b1", favorites: ["a", "b"], scale: { ...DEFAULT_STATION_CONFIG.scale, port: { usbVendorId: 6790, usbProductId: 29987 } } };
    expect(saveStationConfig(storage, config)).toBe(true);
    expect(loadStationConfig(storage)).toEqual(config);
  });

  it("un valor corrupto o un JSON roto nunca rompe la estación", () => {
    const storage = new MemoryStorage();
    storage.data.set(STATION_CONFIG_KEY, "{no es json");
    expect(loadStationConfig(storage)).toEqual(DEFAULT_STATION_CONFIG);
    storage.data.set(STATION_CONFIG_KEY, JSON.stringify({ tuning: { stableMs: "abc", toleranceGrams: -50, minWeightGrams: 1e9 }, scale: { params: { baudRate: 12345, dataBits: 3, parity: "x" }, protocol: "OTRO" }, print: { rotation: 45 }, favorites: [1, "a", "a"] }));
    const config = loadStationConfig(storage);
    expect(config.tuning.stableMs).toBe(800);
    expect(config.tuning.toleranceGrams).toBe(1);
    expect(config.tuning.minWeightGrams).toBe(2_000);
    expect(config.scale.params).toEqual({ baudRate: 9600, dataBits: 8, stopBits: 2, parity: "none" });
    expect(config.scale.protocol).toBe("KRETZ_STX_CR");
    expect(config.print.rotation).toBe(0);
    expect(config.favorites).toEqual(["a"]);
  });

  it("sin almacenamiento disponible (navegador bloqueado) sigue funcionando y avisa que no guardó", () => {
    expect(loadStationConfig(null)).toEqual(DEFAULT_STATION_CONFIG);
    expect(saveStationConfig(null, DEFAULT_STATION_CONFIG)).toBe(false);
    const storage = new MemoryStorage();
    storage.throwOnSet = true;
    expect(saveStationConfig(storage, DEFAULT_STATION_CONFIG)).toBe(false);
  });

  it("el peso mínimo siempre queda por encima de la tolerancia de cero", () => {
    expect(normalizeTuning({ minWeightGrams: 5, zeroToleranceGrams: 30 }).minWeightGrams).toBe(31);
  });

  it("acepta números en texto y los redondea", () => {
    expect(normalizeTuning({ stableMs: "1200", tareGrams: 12.6 })).toMatchObject({ stableMs: 1200, tareGrams: 13 });
    expect(normalizeTuning({})).toEqual(DEFAULT_STATION_TUNING);
  });

  it("no puede quedar con la impresión automática activa sin una prueba aprobada", () => {
    expect(normalizeStationConfig({ print: { auto: true } }).print.auto).toBe(false);
  });
});

describe("prueba de impresión y activación de la impresión automática", () => {
  it("no se puede activar sin una prueba aprobada", () => {
    const config = setAutoPrint(DEFAULT_STATION_CONFIG, dims, true);
    expect(config.print.auto).toBe(false);
    expect(isAutoPrintEnabled(config, dims)).toBe(false);
  });

  it("aprobada la prueba se puede activar", () => {
    const approved = approvePrintTest(DEFAULT_STATION_CONFIG, dims, "2026-11-07T12:00:00Z");
    expect(isPrintTestCurrent(approved, dims)).toBe(true);
    const enabled = setAutoPrint(approved, dims, true);
    expect(isAutoPrintEnabled(enabled, dims)).toBe(true);
  });

  it("si cambian las medidas de la etiqueta la prueba deja de valer y la impresión automática se apaga sola", () => {
    const enabled = setAutoPrint(approvePrintTest(DEFAULT_STATION_CONFIG, dims, "x"), dims, true);
    const resized = { ...dims, infoHeightMm: 50 };
    expect(isPrintTestCurrent(enabled, resized)).toBe(false);
    expect(isAutoPrintEnabled(enabled, resized)).toBe(false);
  });

  it("cambiar el giro invalida la prueba y apaga la impresión automática", () => {
    const enabled = setAutoPrint(approvePrintTest(DEFAULT_STATION_CONFIG, dims, "x"), dims, true);
    const rotated = setRotation(enabled, 90);
    expect(rotated.print).toMatchObject({ rotation: 90, auto: false, testPassedSignature: null });
    expect(isAutoPrintEnabled(rotated, dims)).toBe(false);
  });

  it("elegir el mismo giro no invalida nada", () => {
    const enabled = setAutoPrint(approvePrintTest(DEFAULT_STATION_CONFIG, dims, "x"), dims, true);
    expect(setRotation(enabled, 0)).toEqual(enabled);
  });

  it("la firma depende de ancho, alturas y giro", () => {
    expect(printSignature(dims, 0)).toBe("58x40x40@0");
    expect(printSignature(dims, 90)).not.toBe(printSignature(dims, 0));
  });
});

describe("simulador de balanza", () => {
  it("sólo emite lecturas mientras está conectado", () => {
    let now = 0;
    const scale = new SimulatedScale({ now: () => now });
    const events: unknown[] = [];
    scale.subscribe((event) => events.push(event));
    scale.place(825);
    scale.tick();
    expect(events).toEqual([]);
    scale.connect();
    now = 500;
    scale.tick();
    expect(events).toEqual([
      { type: "status", status: "CONNECTED", message: null, atMs: 0 },
      { type: "sample", grams: 825, stable: null, atMs: 500 }
    ]);
  });

  it("reproduce lecturas inestables, estabilización y retiro (con señal de estabilidad)", () => {
    const scale = new SimulatedScale({ now: () => 0 }, { reportsStability: true });
    const samples: { grams: number; stable: boolean | null }[] = [];
    scale.subscribe((event) => { if (event.type === "sample") samples.push({ grams: event.grams, stable: event.stable }); });
    scale.connect();
    scale.wobble(450); scale.tick();
    scale.wobble(780); scale.tick();
    scale.place(825); scale.tick();
    scale.remove(); scale.tick();
    expect(samples).toEqual([{ grams: 450, stable: false }, { grams: 780, stable: false }, { grams: 825, stable: true }, { grams: 0, stable: true }]);
  });

  it("simula una desconexión y se puede reconectar", async () => {
    const scale = new SimulatedScale({ now: () => 0 });
    const statuses: string[] = [];
    scale.subscribe((event) => { if (event.type === "status") statuses.push(event.status); });
    scale.connect();
    scale.dropConnection();
    expect(scale.status).toBe("ERROR");
    scale.connect();
    await scale.disconnect();
    expect(statuses).toEqual(["CONNECTED", "ERROR", "CONNECTED", "DISCONNECTED"]);
  });

  it("no está disponible en producción salvo que se habilite a propósito", () => {
    expect(isSimulatorAllowed({ nodeEnv: "production", flag: undefined })).toBe(false);
    expect(isSimulatorAllowed({ nodeEnv: "production", flag: "0" })).toBe(false);
    expect(isSimulatorAllowed({ nodeEnv: "production", flag: "1" })).toBe(true);
    expect(isSimulatorAllowed({ nodeEnv: "development", flag: undefined })).toBe(true);
    expect(isSimulatorAllowed({ nodeEnv: "test", flag: undefined })).toBe(true);
  });
});
