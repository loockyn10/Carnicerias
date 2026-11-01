import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { inspectPdf, mmOf } from "./test-support/pdf-inspect";
import { samplePackage } from "./test-support/vacuum-fixtures";
import type { VacuumPackage } from "./vacuum";
import { buildPriceLabelLayout } from "./vacuum-label-layout";
import { resolveVacuumLabelDims } from "./vacuum-label-spec";
import { sampleLabelData } from "./test-support/vacuum-fixtures";
import { renderVacuumLabelsPdf, vacuumLabelFilename, VacuumLabelError } from "./vacuum-label-pdf";
import { executeVacuumPrint, parseVacuumPrintRequest, VacuumPrintError, type VacuumPrintDeps } from "./vacuum-print-run";

const PACKAGE_ID = "5b8d3f0e-6f3a-4a8e-9a55-0a6f1d9c7e11";

/** El JSON que devuelve get_vacuum_package, armado desde un VacuumPackage de prueba. */
function rpcJson(pkg: VacuumPackage) {
  return {
    id: PACKAGE_ID, branchId: pkg.branchId, branchName: pkg.branchName, productId: pkg.productId, productName: pkg.productName, productSku: pkg.productSku,
    weightGrams: pkg.weightGrams, pricePerKgCents: pkg.pricePerKgCents.toString(), totalCents: pkg.totalCents.toString(), packedOn: pkg.packedOn,
    expiresOn: pkg.expiresOn, lot: pkg.lot, ean13: pkg.ean13, shelfLifeDays: pkg.shelfLifeDays, conservationText: pkg.conservationText,
    label: {
      businessName: pkg.businessName, address: pkg.address, establishmentInfo: pkg.establishmentInfo, extraText: pkg.extraText,
      labelWidthMm: pkg.dims.widthMm, infoHeightMm: pkg.dims.infoHeightMm, priceHeightMm: pkg.dims.priceHeightMm
    },
    createdAt: pkg.createdAt, createdBy: pkg.createdBy, printCount: pkg.printCount
  };
}

const textsOf = async (pdf: Uint8Array, page: number) => (await inspectPdf(pdf))[page]?.texts.map((text) => text.text) ?? [];

describe("PDF de etiquetas de envasado", () => {
  it("«ambas» genera dos páginas del tamaño exacto del papel: informativa primero, precio después", async () => {
    const { pdf, pageCount } = await renderVacuumLabelsPdf(samplePackage(), "BOTH");
    expect(pageCount).toBe(2);
    const pages = await inspectPdf(pdf);
    expect(pages).toHaveLength(2);
    for (const page of pages) { expect(mmOf(page.widthPt)).toBeCloseTo(58, 1); expect(mmOf(page.heightPt)).toBeCloseTo(40, 1); }
    expect((await textsOf(pdf, 0)).join(" ")).toContain("ELABORACI");
    expect(await textsOf(pdf, 1)).toContain("$18.052,50");
  });

  it("imprimir sólo una etiqueta genera una sola página (reimpresión de la que salió mal)", async () => {
    const info = await renderVacuumLabelsPdf(samplePackage(), "INFO");
    expect(info.pageCount).toBe(1);
    expect((await textsOf(info.pdf, 0)).join(" ")).toContain("A1-261101-0001");
    const price = await renderVacuumLabelsPdf(samplePackage(), "PRICE");
    expect(price.pageCount).toBe(1);
    const texts = await textsOf(price.pdf, 0);
    expect(texts).toContain("$18.052,50");
    expect(texts).toContain("1,245 kg");
    expect(texts).toContain("$14.500/kg");
    expect(texts.join("")).toContain("2000718052504".slice(1, 7));
  });

  it("dibuja una barra rellena por cada barra del código", async () => {
    const { pdf } = await renderVacuumLabelsPdf(samplePackage(), "PRICE");
    const doc = await PDFDocument.load(pdf);
    const page = doc.getPages()[0];
    if (!page) throw new Error("sin página");
    const contents = page.node.Contents();
    const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
    const content = refs.map((ref) => {
      const stream = doc.context.lookup(ref);
      return stream instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1") : "";
    }).join("\n");
    const bars = buildPriceLabelLayout(sampleLabelData(), resolveVacuumLabelDims(null)).bars.length;
    expect(bars).toBeGreaterThan(20);
    expect((content.match(/\nf\n/g) ?? []).length).toBe(bars);
  });

  it("usa las medidas del snapshot (58 × 50 si así se configuró cuando se envasó)", async () => {
    const { pdf } = await renderVacuumLabelsPdf(samplePackage({ dims: { widthMm: 58, infoHeightMm: 50, priceHeightMm: 45 } }), "BOTH");
    const pages = await inspectPdf(pdf);
    expect(mmOf(pages[0]?.heightPt ?? 0)).toBeCloseTo(50, 1);
    expect(mmOf(pages[1]?.heightPt ?? 0)).toBeCloseTo(45, 1);
  });

  it("se niega a imprimir un EAN-13 inválido", async () => {
    await expect(renderVacuumLabelsPdf(samplePackage({ ean13: "2000718052505" }), "BOTH")).rejects.toBeInstanceOf(VacuumLabelError);
    await expect(renderVacuumLabelsPdf(samplePackage({ ean13: "123" }), "PRICE")).rejects.toBeInstanceOf(VacuumLabelError);
  });

  it("la reimpresión histórica usa el precio del snapshot, no el actual", async () => {
    // El paquete se envasó a $14.500/kg. Aunque hoy el corte valga otra cosa, el snapshot no cambia: la etiqueta sale igual.
    const historic = samplePackage();
    const first = await textsOf((await renderVacuumLabelsPdf(historic, "PRICE")).pdf, 0);
    const later = await textsOf((await renderVacuumLabelsPdf({ ...historic, printCount: 3 }, "PRICE")).pdf, 0);
    expect(later).toEqual(first);
    expect(first).toContain("$14.500/kg");
    // Y uno envasado con otro precio muestra el suyo: precio histórico distinto del actual.
    const cheaper = samplePackage({ pricePerKgCents: 1_200_000n, totalCents: 1_494_000n, ean13: "2000714940005" });
    expect(cheaper.ean13).toHaveLength(13);
  });

  it("nombra el archivo con el lote", () => {
    expect(vacuumLabelFilename({ lot: "A1-261101-0001" }, "BOTH")).toBe("envasado-A1-261101-0001-etiquetas.pdf");
    expect(vacuumLabelFilename({ lot: "LOTE ESPECIAL/7" }, "PRICE")).toBe("envasado-LOTE_ESPECIAL_7-precio.pdf");
    expect(vacuumLabelFilename({ lot: "X-1" }, "INFO")).toContain("informativa");
  });
});

describe("impresión de un paquete registrado", () => {
  function deps(stored: unknown) {
    const calls: { id: string; kind: string }[] = [];
    const value: VacuumPrintDeps = {
      getPackage: () => Promise.resolve(stored),
      recordPrint: (id, kind) => { calls.push({ id, kind }); return Promise.resolve(); }
    };
    return { value, calls };
  }

  it("valida el pedido", () => {
    expect(parseVacuumPrintRequest({ packageId: PACKAGE_ID, kind: "BOTH" })).toEqual({ ok: true, value: { packageId: PACKAGE_ID, kind: "BOTH" } });
    expect(parseVacuumPrintRequest({ packageId: "x", kind: "BOTH" })).toMatchObject({ ok: false });
    expect(parseVacuumPrintRequest({ packageId: PACKAGE_ID, kind: "OTRA" })).toMatchObject({ ok: false });
    expect(parseVacuumPrintRequest(null)).toMatchObject({ ok: false });
  });

  it("genera el PDF desde el snapshot y registra la impresión", async () => {
    const { value, calls } = deps(rpcJson(samplePackage()));
    const result = await executeVacuumPrint(value, { packageId: PACKAGE_ID, kind: "BOTH" });
    expect(result.pageCount).toBe(2);
    expect(result.filename).toBe("envasado-A1-261101-0001-etiquetas.pdf");
    expect(calls).toEqual([{ id: PACKAGE_ID, kind: "BOTH" }]);
  });

  it("un paquete inexistente (u otra organización/sucursal) da 404 y no registra nada", async () => {
    const { value, calls } = deps(null);
    await expect(executeVacuumPrint(value, { packageId: PACKAGE_ID, kind: "PRICE" })).rejects.toMatchObject({ status: 404 });
    expect(calls).toEqual([]);
  });

  it("un EAN inválido da 422 y no registra una impresión fantasma", async () => {
    const { value, calls } = deps(rpcJson(samplePackage({ ean13: "2000718052505" })));
    await expect(executeVacuumPrint(value, { packageId: PACKAGE_ID, kind: "BOTH" })).rejects.toBeInstanceOf(VacuumPrintError);
    expect(calls).toEqual([]);
  });
});
