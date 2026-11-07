import { describe, expect, it } from "vitest";

import { createScaleFrameParser, isScaleProtocol, KRETZ_SERIAL_PARAMS, parseAsciiLine, parseKretzFrame } from "./scale-protocol";

const STX = 0x02;
const CR = 0x0d;
const LF = 0x0a;
const bytes = (text: string) => Uint8Array.from(Array.from(text, (char) => char.charCodeAt(0)));
const frame = (text: string) => Uint8Array.from([STX, ...bytes(text), CR]);
const grams = (items: ReturnType<ReturnType<typeof createScaleFrameParser>["feed"]>) => items.map((item) => (item.ok ? item.grams : item.code));

describe("KRETZ_STX_CR (el mismo protocolo que el POS en Rust)", () => {
  it("usa los parámetros documentados: 9600 8N2", () => {
    expect(KRETZ_SERIAL_PARAMS).toEqual({ baudRate: 9600, dataBits: 8, stopBits: 2, parity: "none" });
  });

  it("lee un frame completo y no inventa estabilidad (stable = null)", () => {
    const items = createScaleFrameParser("KRETZ_STX_CR").feed(frame("01.250"));
    expect(items).toEqual([{ ok: true, grams: 1250, stable: null }]);
  });

  it("reensambla un frame partido entre dos lecturas", () => {
    const parser = createScaleFrameParser("KRETZ_STX_CR");
    expect(parser.feed(Uint8Array.from([STX, ...bytes("01")]))).toEqual([]);
    expect(grams(parser.feed(Uint8Array.from([...bytes(".250"), CR])))).toEqual([1250]);
  });

  it("lee dos frames concatenados en una misma lectura", () => {
    expect(grams(createScaleFrameParser("KRETZ_STX_CR").feed(Uint8Array.from([...frame("0.500"), ...frame("01.250")])))).toEqual([500, 1250]);
  });

  it("descarta la basura previa al primer STX", () => {
    expect(grams(createScaleFrameParser("KRETZ_STX_CR").feed(Uint8Array.from([0xff, 0xfe, 0x00, ...frame("0.500")])))).toEqual([500]);
  });

  it("un nuevo STX descarta un frame que nunca cerró", () => {
    const parser = createScaleFrameParser("KRETZ_STX_CR");
    expect(parser.feed(Uint8Array.from([STX, ...bytes("99.9")]))).toEqual([]);
    expect(grams(parser.feed(frame("0.500")))).toEqual([500]);
  });

  it("un frame sin CR todavía no informa nada, y reset() lo descarta", () => {
    const parser = createScaleFrameParser("KRETZ_STX_CR");
    expect(parser.feed(Uint8Array.from([STX, ...bytes("0.500")]))).toEqual([]);
    parser.reset();
    expect(parser.feed(Uint8Array.from([CR]))).toEqual([]);
  });

  it("0 g, 410 g (frame real verificado en hardware) y 12,345 kg", () => {
    expect(parseKretzFrame(bytes("0.000"))).toEqual({ ok: true, grams: 0, stable: null });
    expect(parseKretzFrame(bytes("00.410"))).toEqual({ ok: true, grams: 410, stable: null });
    expect(parseKretzFrame(bytes("12.345"))).toEqual({ ok: true, grams: 12_345, stable: null });
  });

  it("completa los decimales que faltan (1.5 = 1,500 kg) y rechaza lo que no tiene la forma documentada", () => {
    expect(parseKretzFrame(bytes("1.5"))).toMatchObject({ ok: true, grams: 1500 });
    expect(parseKretzFrame(bytes(""))).toEqual({ ok: false, code: "EMPTY" });
    expect(parseKretzFrame(bytes("1250"))).toEqual({ ok: false, code: "MISSING_DECIMAL_POINT" });
    expect(parseKretzFrame(bytes("1.2x0"))).toEqual({ ok: false, code: "INVALID_CHARACTERS" });
    expect(parseKretzFrame(bytes("-1.250"))).toEqual({ ok: false, code: "INVALID_CHARACTERS" });
    expect(parseKretzFrame(bytes("1234.500"))).toEqual({ ok: false, code: "INVALID_CHARACTERS" });
    expect(parseKretzFrame(bytes("1.2345"))).toEqual({ ok: false, code: "INVALID_CHARACTERS" });
    expect(parseKretzFrame(Uint8Array.from([0xff, 0xfe]))).toEqual({ ok: false, code: "INVALID_ENCODING" });
  });

  it("un frame sin terminador que supera el máximo es ruido", () => {
    const parser = createScaleFrameParser("KRETZ_STX_CR");
    const items = parser.feed(Uint8Array.from([STX, ...bytes("1".repeat(40))]));
    expect(items).toEqual([{ ok: false, code: "FRAME_TOO_LONG" }]);
    expect(grams(parser.feed(frame("0.500")))).toEqual([500]);
  });
});

describe("ASCII_LINE (balanzas que informan estabilidad)", () => {
  it("ST = estable y US = inestable", () => {
    expect(parseAsciiLine("ST,GS,+001.250 kg")).toEqual({ ok: true, grams: 1250, stable: true });
    expect(parseAsciiLine("US,GS,+001.250 kg")).toEqual({ ok: true, grams: 1250, stable: false });
  });

  it("sin indicador la estabilidad es null", () => {
    expect(parseAsciiLine("  1.250 kg ")).toEqual({ ok: true, grams: 1250, stable: null });
  });

  it("unidad en gramos", () => {
    expect(parseAsciiLine("S S 750 g")).toEqual({ ok: true, grams: 750, stable: true });
    expect(parseAsciiLine("ST,GS,750g")).toEqual({ ok: true, grams: 750, stable: true });
  });

  it("coma decimal", () => {
    expect(parseAsciiLine("ST 0,825 kg")).toEqual({ ok: true, grams: 825, stable: true });
  });

  it("rechaza pesos negativos pero acepta -0.000", () => {
    expect(parseAsciiLine("ST,GS,-000.250 kg")).toEqual({ ok: false, code: "NEGATIVE_WEIGHT" });
    expect(parseAsciiLine("ST,GS,-000.000 kg")).toEqual({ ok: true, grams: 0, stable: true });
  });

  it("rechaza líneas vacías o sin número", () => {
    expect(parseAsciiLine("   ")).toEqual({ ok: false, code: "EMPTY" });
    expect(parseAsciiLine("ST,GS,OL")).toEqual({ ok: false, code: "MISSING_DECIMAL_POINT" });
  });

  it("separa por CR, LF o CRLF sin generar líneas vacías", () => {
    const parser = createScaleFrameParser("ASCII_LINE");
    const items = parser.feed(Uint8Array.from([...bytes("ST,GS,  0.500 kg"), CR, LF, ...bytes("US,GS,  0.510 kg"), LF]));
    expect(items).toEqual([{ ok: true, grams: 500, stable: true }, { ok: true, grams: 510, stable: false }]);
  });

  it("junta una línea partida entre dos lecturas", () => {
    const parser = createScaleFrameParser("ASCII_LINE");
    expect(parser.feed(bytes("ST,GS,  0.5"))).toEqual([]);
    expect(parser.feed(Uint8Array.from([...bytes("00 kg"), CR]))).toEqual([{ ok: true, grams: 500, stable: true }]);
  });
});

describe("isScaleProtocol", () => {
  it("acepta sólo los protocolos conocidos", () => {
    expect(isScaleProtocol("KRETZ_STX_CR")).toBe(true);
    expect(isScaleProtocol("ASCII_LINE")).toBe(true);
    expect(isScaleProtocol("OTRO")).toBe(false);
    expect(isScaleProtocol(null)).toBe(false);
  });
});
