import { describe, expect, it } from "vitest";

import { sampleLabelData, samplePackage } from "../test-support/vacuum-fixtures";
import { buildInfoLabelLayout, buildLogisticLabelLayout, buildPriceLabelLayout, buildVacuumLabelLayout, packageToLabelData } from "../vacuum-label-layout";
import { VACUUM_LOGISTIC } from "../vacuum-label-spec";
import { buildPackageJobs } from "../vacuum-station/label-print";
import { decodeCode128BModules } from "./code128";

const CODE = "7K3M9QX4S";
const dims = (width: number, height: number) => ({ widthMm: width, infoHeightMm: height, priceHeightMm: height });

/** Reconstruye los módulos del código a partir de las barras dibujadas (lo que vería un lector) y los decodifica. */
function decodeBars(bars: { x: number; width: number }[], moduleMm: number): string {
  const first = bars[0]?.x ?? 0;
  const runs = bars.map((bar) => ({ start: Math.round((bar.x - first) / moduleMm), width: Math.round(bar.width / moduleMm) }));
  const end = Math.max(...runs.map((run) => run.start + run.width));
  const modules = Array.from({ length: end }, () => "0");
  for (const run of runs) for (let index = 0; index < run.width; index += 1) modules[run.start + index] = "1";
  return decodeCode128BModules(modules.join(""));
}

describe("código logístico en la etiqueta informativa (evaluación por medidas)", () => {
  it("55 × 44 mm: para dibujarlo hace falta achicar la tipografía más de lo tolerable (12 %), así que NO se dibuja y la informativa queda como era", () => {
    const withCode = buildInfoLabelLayout(sampleLabelData({ logisticCode: CODE }), dims(55, 44));
    const base = buildInfoLabelLayout(sampleLabelData({ logisticCode: null }), dims(55, 44));
    expect(withCode.logisticOmitted).toBe(true);
    expect(withCode.bars).toHaveLength(0);
    expect(withCode.overflow).toBe(false);
    expect({ ...withCode, logisticOmitted: false }).toEqual(base);
  });

  it("58 × 50 mm: entra sin achicar nada", () => {
    const layout = buildInfoLabelLayout(sampleLabelData({ logisticCode: CODE }), dims(58, 50));
    expect(layout.logisticOmitted).toBe(false);
    expect(layout.fitScale).toBeGreaterThanOrEqual(VACUUM_LOGISTIC.minFit);
    expect(layout.overflow).toBe(false);
    expect(layout.texts.find((text) => text.id === "logistic-code")?.text).toBe("ID LOGÍSTICO 7K3M-9QX4-S");
  });

  it("las barras dibujadas se decodifican de vuelta al código (módulo de 0,25 mm)", () => {
    const layout = buildInfoLabelLayout(sampleLabelData({ logisticCode: CODE }), dims(58, 50));
    expect(layout.bars).toHaveLength(37);
    expect(layout.bars.every((bar) => bar.height === VACUUM_LOGISTIC.barHeightMm)).toBe(true);
    expect(decodeBars(layout.bars, VACUUM_LOGISTIC.moduleMm)).toBe(CODE);
  });

  it("el código queda dentro de los márgenes de la etiqueta", () => {
    const layout = buildInfoLabelLayout(sampleLabelData({ logisticCode: CODE }), dims(58, 50));
    const left = Math.min(...layout.bars.map((bar) => bar.x));
    const right = Math.max(...layout.bars.map((bar) => bar.x + bar.width));
    expect(left).toBeGreaterThanOrEqual(4.5);
    expect(right).toBeLessThanOrEqual(58 - 4.5);
  });

  it("sin código (borrador o paquete viejo) la informativa es la de siempre y no se marca como omitida", () => {
    const layout = buildInfoLabelLayout(sampleLabelData({ logisticCode: null }), dims(58, 50));
    expect(layout.logisticOmitted).toBe(false);
    expect(layout.bars).toHaveLength(0);
  });

  it("un código mal formado nunca se dibuja", () => {
    expect(buildInfoLabelLayout(sampleLabelData({ logisticCode: "7K3M9QX4A" }), dims(58, 50)).bars).toHaveLength(0);
  });

  it("una etiqueta demasiado angosta para el código lo omite en vez de cortarlo", () => {
    const layout = buildInfoLabelLayout(sampleLabelData({ logisticCode: CODE }), dims(40, 60));
    expect(layout.logisticOmitted).toBe(true);
    expect(layout.bars).toHaveLength(0);
  });

  it("el EAN-13 comercial no cambia: la etiqueta de precio es idéntica con o sin código logístico", () => {
    for (const size of [dims(55, 44), dims(58, 40), dims(58, 50)]) {
      expect(buildPriceLabelLayout(sampleLabelData({ logisticCode: CODE }), size)).toEqual(buildPriceLabelLayout(sampleLabelData({ logisticCode: null }), size));
    }
  });
});

describe("etiqueta logística adicional", () => {
  it("entra en 55 × 44 mm sin desbordar, con el código grande y decodificable (módulo de 0,3 mm)", () => {
    const layout = buildLogisticLabelLayout(sampleLabelData({ logisticCode: CODE }), dims(55, 44));
    expect(layout.kind).toBe("LOGISTIC");
    expect(layout.overflow).toBe(false);
    expect(layout.logisticOmitted).toBe(false);
    expect(decodeBars(layout.bars, 0.3)).toBe(CODE);
    expect(layout.bars[0]?.height).toBe(11);
    expect(layout.texts.find((text) => text.id === "logistic-code")?.text).toBe("7K3M-9QX4-S");
  });

  it("también en 58 × 40 mm y usa el alto de la etiqueta informativa (es el mismo papel)", () => {
    const layout = buildLogisticLabelLayout(sampleLabelData({ logisticCode: CODE }), dims(58, 40));
    expect(layout.overflow).toBe(false);
    expect([layout.widthMm, layout.heightMm]).toEqual([58, 40]);
  });

  it("identifica el paquete: corte, lote, peso y fechas, y aclara que no es el código de venta", () => {
    const texts = buildLogisticLabelLayout(sampleLabelData({ logisticCode: CODE }), dims(55, 44)).texts.map((text) => text.text).join("|");
    expect(texts).toContain("Vacío");
    expect(texts).toContain("A1-261101-0001");
    expect(texts).toContain("1,245 kg");
    expect(texts).toContain("Elab. 01/11/2026");
    expect(texts).toContain("no es el código de venta");
  });

  it("sin código muestra un aviso, nunca uno inventado", () => {
    const layout = buildLogisticLabelLayout(sampleLabelData({ logisticCode: null }), dims(55, 44));
    expect(layout.bars).toHaveLength(0);
    expect(layout.texts.some((text) => text.text === "SIN CÓDIGO LOGÍSTICO")).toBe(true);
  });

  it("buildVacuumLabelLayout resuelve los tres tipos", () => {
    const data = sampleLabelData({ logisticCode: CODE });
    expect(buildVacuumLabelLayout("LOGISTIC", data, dims(55, 44)).kind).toBe("LOGISTIC");
    expect(buildVacuumLabelLayout("INFO", data, dims(55, 44)).kind).toBe("INFO");
    expect(buildVacuumLabelLayout("PRICE", data, dims(55, 44)).kind).toBe("PRICE");
  });
});

describe("trabajos de impresión del paquete", () => {
  const pkg = samplePackage({ dims: { widthMm: 55, infoHeightMm: 44, priceHeightMm: 44 } });

  it("«Ambas» sigue siendo informativa + precio (sin etiqueta extra por defecto)", () => {
    expect(buildPackageJobs(pkg, "BOTH", 0).map((job) => job.kind)).toEqual(["INFO", "PRICE"]);
  });

  it("con la opción activada, si el código no entró en la informativa se agrega la logística justo después", () => {
    expect(buildPackageJobs(pkg, "BOTH", 0, { logisticLabel: true }).map((job) => job.kind)).toEqual(["INFO", "LOGISTIC", "PRICE"]);
  });

  it("si el código sí entró (etiqueta más alta) no se imprime la logística de más", () => {
    const tall = samplePackage({ dims: { widthMm: 58, infoHeightMm: 50, priceHeightMm: 50 } });
    expect(buildPackageJobs(tall, "BOTH", 0, { logisticLabel: true }).map((job) => job.kind)).toEqual(["INFO", "PRICE"]);
  });

  it("se puede imprimir sólo la logística (reimpresión desde Distribución)", () => {
    const jobs = buildPackageJobs(pkg, "LOGISTIC", 0);
    expect(jobs.map((job) => job.kind)).toEqual(["LOGISTIC"]);
    expect(jobs[0]?.html).toContain("@page{size:55mm 44mm;margin:0}");
  });

  it("un paquete sin código logístico (anterior a la migración) se imprime como siempre", () => {
    const old = samplePackage({ logisticCode: null, dims: pkg.dims });
    expect(buildPackageJobs(old, "BOTH", 0, { logisticLabel: true }).map((job) => job.kind)).toEqual(["INFO", "PRICE"]);
    expect(packageToLabelData(old).logisticCode).toBeNull();
  });
});
