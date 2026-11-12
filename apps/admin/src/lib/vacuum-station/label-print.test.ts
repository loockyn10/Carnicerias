import { describe, expect, it } from "vitest";

import type { VacuumPackage } from "../vacuum";
import { buildVacuumLabelLayout, packageToLabelData } from "../vacuum-label-layout";
import { VACUUM_LABEL_DEFAULTS } from "../vacuum-label-spec";
import { buildLabelDocument, buildLabelPage, buildPackageJobs, buildTestJobs, buildTestLayout, kindsOf, printJobs, type HtmlPrintOutcome } from "./label-print";

const pkg: VacuumPackage = {
  id: "11111111-1111-4111-8111-111111111111", branchId: "b", branchName: "Central", productId: "p", productName: "Vacío de cerdo & más", productSku: "VAC",
  weightGrams: 750, pricePerKgCents: 1_500_000n, totalCents: 1_125_000n, packedOn: "2026-11-07", expiresOn: "2026-11-21", lot: "CEN-261107-0001", ean13: "2000120112506",
  shelfLifeDays: 14, conservationText: "Conservar entre 0 y 4 °C", businessName: "Carnicerías Fran", address: "Calle 1", establishmentInfo: null, extraText: null,
  dims: { widthMm: 58, infoHeightMm: 40, priceHeightMm: 40 }, createdAt: "2026-11-07T12:00:00Z", createdBy: null, printCount: 0, logisticCode: "7K3M9QX4S"
};

describe("documento de impresión de una etiqueta", () => {
  const layout = buildVacuumLabelLayout("PRICE", packageToLabelData(pkg), VACUUM_LABEL_DEFAULTS);

  it("declara la hoja del tamaño exacto de la etiqueta, sin márgenes", () => {
    const html = buildLabelDocument(buildLabelPage(layout, 0), "x");
    expect(html).toContain("@page{size:58mm 40mm;margin:0}");
    expect(html).toContain("<svg");
    expect(html).toContain('width="58mm" height="40mm" viewBox="0 0 58 40"');
  });

  it("es UNA sola página: no hay saltos de página ni más contenido que el dibujo", () => {
    const html = buildLabelDocument(buildLabelPage(layout, 0), "x");
    expect(html.match(/<svg/g)).toHaveLength(1);
    expect(html).toContain("break-after:avoid");
    expect(html).toContain("overflow:hidden");
    expect(html).not.toContain("page-break-after:always");
  });

  it("dibuja todos los elementos del layout: textos y TODAS las barras del código", () => {
    const { svg } = buildLabelPage(layout, 0);
    expect(svg.match(/shape-rendering="crispEdges"/g)).toHaveLength(layout.bars.length);
    expect(layout.bars.length).toBeGreaterThan(20);
    expect(svg).toContain(">000120<");
    expect(svg).toContain(">112506<");
    expect(svg.match(/<text /g)).toHaveLength(layout.texts.length);
  });

  it("escapa el texto del producto (nunca rompe el documento)", () => {
    const { svg } = buildLabelPage(buildVacuumLabelLayout("INFO", packageToLabelData(pkg), VACUUM_LABEL_DEFAULTS), 0);
    expect(svg).toContain("&amp;");
    expect(svg).not.toContain("& más");
  });

  it("giro de 90° y 270°: la hoja se declara con el ancho y el alto intercambiados", () => {
    const rotated = buildLabelPage(layout, 90);
    expect([rotated.pageWidthMm, rotated.pageHeightMm]).toEqual([40, 58]);
    expect(buildLabelDocument(rotated, "x")).toContain("@page{size:40mm 58mm;margin:0}");
    expect(rotated.svg).toContain('transform="matrix(0 1 -1 0 40 0)"');
    expect(buildLabelPage(layout, 270).svg).toContain('transform="matrix(0 -1 1 0 0 58)"');
  });

  it("giro de 180°: mismo tamaño de hoja, contenido invertido", () => {
    const rotated = buildLabelPage(layout, 180);
    expect([rotated.pageWidthMm, rotated.pageHeightMm]).toEqual([58, 40]);
    expect(rotated.svg).toContain('transform="matrix(-1 0 0 -1 58 40)"');
  });

  it("sin giro no agrega ninguna transformación", () => {
    expect(buildLabelPage(layout, 0).svg).not.toContain("transform=");
  });

  it("el giro mantiene el contenido dentro de la hoja (la esquina del dibujo cae en una esquina de la hoja)", () => {
    // matrix(0 1 -1 0 h 0): (x, y) → (h - y, x). El punto (0, 0) va a (40, 0) y (58, 40) va a (0, 58): ambos dentro de la hoja 40 × 58.
    const apply = (x: number, y: number, h: number) => [h - y, x];
    expect(apply(0, 0, 40)).toEqual([40, 0]);
    expect(apply(58, 40, 40)).toEqual([0, 58]);
  });
});

describe("etiquetas de un paquete registrado", () => {
  it("«Ambas» son dos trabajos, la informativa primero, cada uno con su hoja", () => {
    const jobs = buildPackageJobs(pkg, "BOTH", 0);
    expect(jobs.map((job) => job.kind)).toEqual(["INFO", "PRICE"]);
    expect(jobs.every((job) => job.html.includes("@page{size:58mm 40mm;margin:0}"))).toBe(true);
  });

  it("respeta alturas distintas entre etiquetas (cada trabajo declara la suya)", () => {
    const jobs = buildPackageJobs({ ...pkg, dims: { widthMm: 58, infoHeightMm: 50, priceHeightMm: 30 } }, "BOTH", 0);
    expect(jobs.map((job) => [job.widthMm, job.heightMm])).toEqual([[58, 50], [58, 30]]);
    expect(jobs[0]?.html).toContain("size:58mm 50mm");
    expect(jobs[1]?.html).toContain("size:58mm 30mm");
  });

  it("imprime desde el SNAPSHOT: las medidas son las guardadas en el paquete, no las de hoy", () => {
    const jobs = buildPackageJobs({ ...pkg, dims: { widthMm: 80, infoHeightMm: 60, priceHeightMm: 60 } }, "PRICE", 0);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.html).toContain("size:80mm 60mm");
  });

  it("kindsOf resuelve cada tipo", () => {
    expect(kindsOf("BOTH")).toEqual(["INFO", "PRICE"]);
    expect(kindsOf("INFO")).toEqual(["INFO"]);
    expect(kindsOf("PRICE")).toEqual(["PRICE"]);
  });
});

describe("etiqueta de prueba", () => {
  it("tiene el tamaño de la etiqueta real y todo su contenido cabe dentro", () => {
    const layout = buildTestLayout("PRICE", VACUUM_LABEL_DEFAULTS, 0);
    expect([layout.widthMm, layout.heightMm]).toEqual([58, 40]);
    for (const rule of layout.rules) {
      for (const value of [rule.x1, rule.x2]) expect(value).toBeGreaterThanOrEqual(0);
      for (const value of [rule.x1, rule.x2]) expect(value).toBeLessThanOrEqual(58);
      for (const value of [rule.y1, rule.y2]) expect(value).toBeLessThanOrEqual(40);
    }
    expect(layout.texts.find((text) => text.id === "size")?.text).toBe("58 × 40 mm");
  });

  it("indica que no es un paquete y el giro configurado", () => {
    const page = buildLabelPage(buildTestLayout("INFO", VACUUM_LABEL_DEFAULTS, 90), 90);
    expect(page.svg).toContain("no es un paquete");
    expect(page.svg).toContain("giro 90°");
  });

  it("sigue las alturas configuradas de cada etiqueta", () => {
    const jobs = buildTestJobs({ widthMm: 60, infoHeightMm: 45, priceHeightMm: 35 }, "BOTH", 0);
    expect(jobs.map((job) => [job.widthMm, job.heightMm])).toEqual([[60, 45], [60, 35]]);
  });

  it("no contiene datos de un paquete real (no hay EAN ni lote)", () => {
    const html = buildTestJobs(VACUUM_LABEL_DEFAULTS, "BOTH", 0).map((job) => job.html).join("");
    expect(html).not.toMatch(/\d{13}/);
    expect(html).not.toContain("CEN-");
  });
});

describe("envío de los trabajos", () => {
  const jobs = buildPackageJobs(pkg, "BOTH", 0);

  it("imprime en orden y cada etiqueta es un envío aparte", async () => {
    const sent: string[] = [];
    const outcome = await printJobs(jobs, (html) => { sent.push(html); return Promise.resolve<HtmlPrintOutcome>({ ok: true, dialogShown: false }); });
    expect(outcome).toEqual({ ok: true, error: null, dialogShown: false, sent: ["INFO", "PRICE"] });
    expect(sent).toHaveLength(2);
  });

  it("si falla la segunda informa cuál ya salió, para no repetirla", async () => {
    let calls = 0;
    const outcome = await printJobs(jobs, () => { calls += 1; return Promise.resolve<HtmlPrintOutcome>(calls === 1 ? { ok: true, dialogShown: false } : { ok: false, error: "tiempo agotado" }); });
    expect(outcome.ok).toBe(false);
    expect(outcome.sent).toEqual(["INFO"]);
    expect(outcome.error).toContain("informativa");
  });

  it("avisa cuando el navegador abrió el diálogo (la impresión no es silenciosa)", async () => {
    const outcome = await printJobs(jobs, () => Promise.resolve<HtmlPrintOutcome>({ ok: true, dialogShown: true }));
    expect(outcome.dialogShown).toBe(true);
  });

  it("no manda a imprimir nada más después de un fallo", async () => {
    let calls = 0;
    await printJobs(jobs, () => { calls += 1; return Promise.resolve<HtmlPrintOutcome>({ ok: false, error: "x" }); });
    expect(calls).toBe(1);
  });
});
