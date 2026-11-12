import { describe, expect, it } from "vitest";

import { formatLogisticCode, isValidLogisticCode, logisticCheckChar, normalizeLogisticCode, parseScannedIdentifier } from "./logistic-code";

describe("código logístico", () => {
  it("el control del vector de la base: 7K3M9QX4 → S (el mismo que en el pgTAP)", () => {
    expect(logisticCheckChar("7K3M9QX4")).toBe("S");
    expect(isValidLogisticCode("7K3M9QX4S")).toBe(true);
  });

  it("detecta un carácter cambiado y dos caracteres intercambiados", () => {
    expect(isValidLogisticCode("8K3M9QX4S")).toBe(false);
    expect(isValidLogisticCode("K73M9QX4S")).toBe(false);
    expect(isValidLogisticCode("7K3M9QX4A")).toBe(false);
  });

  it("normaliza mayúsculas, espacios, guiones y caracteres parecidos", () => {
    expect(normalizeLogisticCode(" 7k3m-9qx4 s")).toBe("7K3M9QX4S");
    expect(normalizeLogisticCode("OIL0")).toBe("0110");
  });

  it("se muestra con guiones y se lee con o sin ellos", () => {
    expect(formatLogisticCode("7K3M9QX4S")).toBe("7K3M-9QX4-S");
    expect(parseScannedIdentifier("7k3m-9qx4-s")).toEqual({ kind: "LOGISTIC", code: "7K3M9QX4S" });
  });

  it("rechaza largos y alfabetos incorrectos", () => {
    expect(isValidLogisticCode("7K3M9QX4")).toBe(false);
    expect(isValidLogisticCode("7K3M9QX4SS")).toBe(false);
    expect(() => logisticCheckChar("7K3M9QXU")).toThrow(RangeError);
  });
});

describe("qué se escaneó", () => {
  it("un EAN-13 es el código COMERCIAL: nunca identifica un paquete", () => {
    expect(parseScannedIdentifier("2000120112506")).toEqual({ kind: "COMMERCIAL_EAN", ean13: "2000120112506" });
  });

  it("acepta el UUID del paquete", () => {
    expect(parseScannedIdentifier("A1B2C3D4-0000-4000-8000-000000000001")).toEqual({ kind: "UUID", id: "a1b2c3d4-0000-4000-8000-000000000001" });
  });

  it("avisa cuando el código no es válido o está vacío", () => {
    expect(parseScannedIdentifier("ABC").kind).toBe("INVALID");
    expect(parseScannedIdentifier("   ").kind).toBe("INVALID");
    expect(parseScannedIdentifier("7K3M9QX4A").kind).toBe("INVALID");
  });
});
