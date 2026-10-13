import { describe, expect, it } from "vitest";

import { buildOfferSign, moneyText, offerSignFilename, paginateSigns, parseOfferSignCatalog, perUnitText, signPageCount } from "./offer-sign";
import {
  catalog, choricito, conCentavos, costilla, filetPechuga, hamburguesas, nombreLargo, packCaro, pataMuslo, productoInactivo, proxima, vencida
} from "./test-support/offer-sign-fixtures";
import { must } from "./test-support/must";

describe("promoción → cartel", () => {
  it("desde X kg: condición humana, precio por kilo y precio normal", () => {
    const sign = must(buildOfferSign(choricito()));
    expect(sign.name).toBe("CHORICITO DE CERDO");
    expect(sign.condition).toBe("DESDE 2 KG");
    expect(sign.price).toEqual({ whole: "6.500", cents: null });
    expect(sign.unitLabel).toBe("/ KG");
    expect(sign.normalPrice).toBe("PRECIO NORMAL $7.000/KG");
    expect(sign.summary).toBe("Desde 2 kg · $6.500/kg");
  });

  it("desde X kg con porcentaje: el precio sale del motor, no de una cuenta propia", () => {
    const sign = must(buildOfferSign(filetPechuga()));
    expect(sign.condition).toBe("DESDE 3 KG");
    expect(sign.price.whole).toBe("10.800");
    expect(sign.normalPrice).toBe("PRECIO NORMAL $12.000/KG");
  });

  it("pack por peso: total fijo contra el precio normal de esa cantidad", () => {
    const sign = must(buildOfferSign(costilla()));
    expect(sign.condition).toBe("LLEVANDO 2 KG");
    expect(sign.price).toEqual({ whole: "15.000", cents: null });
    expect(sign.unitLabel).toBe("POR LOS 2 KG");
    expect(sign.normalPrice).toBe("PRECIO NORMAL $17.000");
  });

  it("pack de unidades: condición PACK, total y precio por unidad secundario", () => {
    const sign = must(buildOfferSign(hamburguesas()));
    expect(sign.condition).toBe("PACK 12 UNIDADES");
    expect(sign.price.whole).toBe("8.900");
    expect(sign.unitLabel).toBe("POR EL PACK");
    expect(sign.secondary).toBe("$741,67 C/U");
    expect(sign.normalPrice).toBe("PRECIO NORMAL $10.200");
  });

  it("muestra los centavos sólo si son reales", () => {
    expect(must(buildOfferSign(conCentavos())).price).toEqual({ whole: "5.189", cents: "75" });
    expect(moneyText({ whole: "5.189", cents: "75" })).toBe("$5.189,75");
    expect(moneyText({ whole: "6.500", cents: null })).toBe("$6.500");
    expect(perUnitText(890000n, 12)).toBe("$741,67");
    expect(perUnitText(1000000n, 10)).toBe("$1.000");
    expect(perUnitText(890000n, 1)).toBeNull();
  });

  it("no expone nombres técnicos de la promoción", () => {
    for (const row of [choricito(), costilla(), hamburguesas(), filetPechuga()]) {
      const sign = must(buildOfferSign(row));
      const text = [sign.condition, sign.unitLabel, sign.secondary ?? "", sign.normalPrice ?? "", sign.summary].join(" ");
      expect(text).not.toMatch(/PACK_FIXED_TOTAL|THRESHOLD|FROM_MINIMUM|FIXED_PRICE|PERCENTAGE/);
    }
  });

  it("sólo ofrece promociones vigentes, de productos activos y que de verdad bajan el precio", () => {
    expect(buildOfferSign(vencida())).toBeNull();
    expect(buildOfferSign(proxima())).toBeNull();
    expect(buildOfferSign(productoInactivo())).toBeNull();
    expect(buildOfferSign(packCaro())).toBeNull();
    expect(buildOfferSign({ ...choricito(), listPriceCents: null })).toBeNull();
    expect(buildOfferSign(null)).toBeNull();
  });

  it("un catálogo con filas rotas o repetidas no rompe la lista", () => {
    const repeated = choricito();
    const signs = parseOfferSignCatalog(catalog(repeated, repeated, vencida(), pataMuslo(), { basura: true }));
    expect(signs.map((sign) => sign.name)).toEqual(["CHORICITO DE CERDO", "PATA MUSLO"]);
    expect(parseOfferSignCatalog(null)).toEqual([]);
  });

  it("un nombre largo se conserva entero (el layout lo reparte en renglones)", () => {
    expect(must(buildOfferSign(nombreLargo())).name).toBe("MILANESA DE POLLO REBOZADA CON JAMÓN Y QUESO");
  });
});

describe("hojas y archivo", () => {
  it("3 por hoja en tira y 1 por hoja en cartel grande", () => {
    expect(signPageCount("STRIP", 1)).toBe(1);
    expect(signPageCount("STRIP", 3)).toBe(1);
    expect(signPageCount("STRIP", 4)).toBe(2);
    expect(signPageCount("STRIP", 10)).toBe(4);
    expect(signPageCount("POSTER", 10)).toBe(10);
    expect(signPageCount("STRIP", 0)).toBe(0);
    expect(paginateSigns([1, 2, 3, 4], "STRIP")).toEqual([[1, 2, 3], [4]]);
    expect(paginateSigns([1, 2], "POSTER")).toEqual([[1], [2]]);
  });

  it("nombre de archivo sanitizado", () => {
    expect(offerSignFilename("Central", "2026-10-13")).toBe("carteles-ofertas-central-2026-10-13.pdf");
    expect(offerSignFilename("Sucursal Ñandú / Norte", "2026-10-13")).toBe("carteles-ofertas-sucursal-nandu-norte-2026-10-13.pdf");
    expect(offerSignFilename("///", "2026-10-13")).toBe("carteles-ofertas-sucursal-2026-10-13.pdf");
  });
});
