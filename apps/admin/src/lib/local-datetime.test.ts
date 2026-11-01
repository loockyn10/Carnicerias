import { describe, expect, it } from "vitest";

import { localDateTimeToIso } from "./local-datetime";

describe("localDateTimeToIso", () => {
  it("interpreta la hora en la zona de la organización (Buenos Aires = UTC-3)", () => {
    expect(localDateTimeToIso("2026-11-05T08:30", "America/Argentina/Buenos_Aires")).toBe("2026-11-05T11:30:00.000Z");
    expect(localDateTimeToIso("2026-11-05T23:30", "America/Argentina/Buenos_Aires")).toBe("2026-11-06T02:30:00.000Z");
  });

  it("UTC no cambia la hora", () => {
    expect(localDateTimeToIso("2026-11-05T08:30", "UTC")).toBe("2026-11-05T08:30:00.000Z");
  });

  it("respeta zonas con horario de verano", () => {
    expect(localDateTimeToIso("2026-07-01T12:00", "America/New_York")).toBe("2026-07-01T16:00:00.000Z");
    expect(localDateTimeToIso("2026-01-01T12:00", "America/New_York")).toBe("2026-01-01T17:00:00.000Z");
  });

  it("rechaza texto inválido o fechas imposibles", () => {
    expect(localDateTimeToIso("", "UTC")).toBeNull();
    expect(localDateTimeToIso("2026-11-05", "UTC")).toBeNull();
    expect(localDateTimeToIso("2026-02-30T10:00", "UTC")).toBeNull();
    expect(localDateTimeToIso("2026-11-05T25:00", "UTC")).toBeNull();
  });
});
