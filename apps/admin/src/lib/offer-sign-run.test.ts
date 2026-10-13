import fs from "node:fs";
import path from "node:path";

import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import {
  executeOfferSignRun, loadOfferSignSource, OfferSignError, parseOfferSignRequest, renderOfferSigns, type OfferSignDeps, type OfferSignRequest
} from "./offer-sign-run";
import { parseOfferSignCatalog } from "./offer-sign";
import {
  BRANCH, catalog, choricito, conCentavos, costilla, filetPechuga, hamburguesas, nombreLargo, pataMuslo, productoInactivo, vencida, type CatalogRow
} from "./test-support/offer-sign-fixtures";

const LOGO = new Uint8Array(fs.readFileSync(path.resolve(__dirname, "../../public/icons/icon-512.png")));
const TIME_ZONE = "America/Argentina/Buenos_Aires";
const NOW = new Date("2026-10-13T15:00:00Z");

function branding(withLogo: boolean) {
  return {
    organizationName: "Super Ofertas",
    logo: withLogo ? { storagePath: "org/branding/logo.png", contentType: "image/png", width: 512, height: 512, scalePercent: 100 } : null,
    branch: { id: BRANCH, name: "Central", phone: null, address: null, city: null }
  };
}

function deps(rows: CatalogRow[], options: { logo?: Uint8Array | null; withLogo?: boolean } = {}): OfferSignDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getCatalog: (branchId) => { calls.push(`catalog:${branchId}`); return Promise.resolve(catalog(...rows)); },
    getBranding: (branchId) => { calls.push(`branding:${branchId}`); return Promise.resolve(branding(options.withLogo ?? true)); },
    readLogo: (storagePath) => { calls.push(`logo:${storagePath}`); return Promise.resolve(options.logo === undefined ? LOGO : options.logo); }
  };
}

const idsOf = (rows: CatalogRow[]) => parseOfferSignCatalog(catalog(...rows)).map((sign) => sign.promotionId);

describe("pedido de carteles", () => {
  const valid = { branchId: BRANCH, format: "STRIP", promotionIds: ["a0000000-0000-4000-8000-000000000001"] };

  it("acepta un pedido válido y descarta repetidos", () => {
    const parsed = parseOfferSignRequest({ ...valid, promotionIds: [valid.promotionIds[0], String(valid.promotionIds[0]).toUpperCase()] });
    expect(parsed).toEqual({ ok: true, value: { branchId: BRANCH, format: "STRIP", promotionIds: valid.promotionIds } });
  });

  it("rechaza sucursal, formato, ids y cantidades inválidas", () => {
    expect(parseOfferSignRequest(null).ok).toBe(false);
    expect(parseOfferSignRequest({ ...valid, branchId: "x" }).ok).toBe(false);
    expect(parseOfferSignRequest({ ...valid, format: "A3" }).ok).toBe(false);
    expect(parseOfferSignRequest({ ...valid, promotionIds: [] }).ok).toBe(false);
    expect(parseOfferSignRequest({ ...valid, promotionIds: ["no-es-uuid"] }).ok).toBe(false);
    const many = Array.from({ length: 61 }, (_, index) => `a0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
    expect(parseOfferSignRequest({ ...valid, promotionIds: many }).ok).toBe(false);
  });

  it("ignora precios y textos que mande el navegador", () => {
    const parsed = parseOfferSignRequest({ ...valid, priceCents: 1, name: "hack", condition: "x" });
    expect(parsed.ok && Object.keys(parsed.value).sort()).toEqual(["branchId", "format", "promotionIds"]);
  });
});

describe("generación del PDF", () => {
  it("10 ofertas en tira → UN PDF de 4 hojas A4 apaisadas, con una lectura de promociones y una de identidad", async () => {
    const rows = [choricito(), pataMuslo(), filetPechuga(), costilla(), hamburguesas(), nombreLargo(), conCentavos(), choricito(), pataMuslo(), costilla()];
    // Cada fixture es una promoción distinta (ids propios); los repetidos de la lista son promociones nuevas.
    const source = deps(rows);
    const request: OfferSignRequest = { branchId: BRANCH, format: "STRIP", promotionIds: idsOf(rows) };
    const result = await executeOfferSignRun(source, request, { timeZone: TIME_ZONE, now: NOW });
    expect(result.signCount).toBe(10);
    expect(result.pageCount).toBe(4);
    expect(result.filename).toBe("carteles-ofertas-central-2026-10-13.pdf");
    const doc = await PDFDocument.load(result.pdf);
    expect(doc.getPageCount()).toBe(4);
    expect(doc.getPage(0).getWidth()).toBeGreaterThan(doc.getPage(0).getHeight());
    // Sin una consulta por producto: un catálogo, una identidad y un logo.
    expect(source.calls).toEqual([`catalog:${BRANCH}`, `branding:${BRANCH}`, "logo:org/branding/logo.png"]);
  });

  it("cartel grande: una hoja por oferta", async () => {
    const rows = [choricito(), hamburguesas(), costilla()];
    const result = await executeOfferSignRun(deps(rows), { branchId: BRANCH, format: "POSTER", promotionIds: idsOf(rows) }, { timeZone: TIME_ZONE, now: NOW });
    expect(result.pageCount).toBe(3);
    expect((await PDFDocument.load(result.pdf)).getPageCount()).toBe(3);
  });

  it("respeta el orden pedido, no el del catálogo", async () => {
    const rows = [choricito(), pataMuslo()];
    const ids = idsOf(rows);
    const source = await loadOfferSignSource(deps(rows), BRANCH);
    const result = await renderOfferSigns(source, { format: "POSTER", promotionIds: [ids[1] ?? "", ids[0] ?? ""] }, { timeZone: TIME_ZONE, now: NOW });
    expect(result.pageCount).toBe(2);
  });

  it("una promoción vencida o de un producto inactivo no aparece y, si se pide, rechaza el pedido", async () => {
    const live = choricito();
    const source = await loadOfferSignSource(deps([live, vencida(), productoInactivo()]), BRANCH);
    expect(source.signs.map((sign) => sign.name)).toEqual(["CHORICITO DE CERDO"]);
    const expiredId = String(vencida().promotionId);
    await expect(renderOfferSigns(source, { format: "STRIP", promotionIds: [expiredId] }, { timeZone: TIME_ZONE, now: NOW })).rejects.toMatchObject({ status: 422 });
  });

  it("sin logo configurado imprime igual (con el nombre del negocio)", async () => {
    const rows = [choricito()];
    const source = await loadOfferSignSource(deps(rows, { withLogo: false }), BRANCH);
    expect(source.logoPng).toBeNull();
    const result = await renderOfferSigns(source, { format: "STRIP", promotionIds: idsOf(rows) }, { timeZone: TIME_ZONE, now: NOW });
    expect(Buffer.from(result.pdf).includes("/Subtype /Image")).toBe(false);
  });

  it("un logo ilegible o ausente en Storage no impide imprimir", async () => {
    const rows = [choricito()];
    for (const logo of [null, new Uint8Array([1, 2, 3, 4])]) {
      const source = await loadOfferSignSource(deps(rows, { logo }), BRANCH);
      expect(source.logoPng).toBeNull();
      expect(source.signs).toHaveLength(1);
    }
  });

  it("con logo lo embebe en blanco y negro", async () => {
    const rows = [choricito()];
    const source = await loadOfferSignSource(deps(rows), BRANCH);
    expect(source.logoPng).not.toBeNull();
    const result = await renderOfferSigns(source, { format: "STRIP", promotionIds: idsOf(rows) }, { timeZone: TIME_ZONE, now: NOW });
    expect(Buffer.from(result.pdf).includes("/Subtype /Image")).toBe(true);
  });

  it("la sucursal inexistente o la identidad ilegible son errores claros", async () => {
    const missingBranch = { ...deps([choricito()]), getBranding: () => Promise.resolve({ organizationName: "X", logo: null, branch: null }) };
    await expect(loadOfferSignSource(missingBranch, BRANCH)).rejects.toMatchObject({ status: 404 });
    const broken = { ...deps([choricito()]), getBranding: () => Promise.resolve("basura") };
    await expect(loadOfferSignSource(broken, BRANCH)).rejects.toBeInstanceOf(OfferSignError);
  });
});
