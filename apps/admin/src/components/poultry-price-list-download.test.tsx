import { readFileSync } from "node:fs";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createImageCache } from "../lib/poultry-price-list-image-cache";
import { streamBytes } from "../lib/poultry-price-list-png";
import { MobileHome } from "./mobile/mobile-home";
import { MobilePriceListButton } from "./mobile/mobile-price-list-button";
import { deliverPriceList, deliveryMethod, filenameFrom, isAppleMobile, PRICE_LIST_ENDPOINT, PoultryPriceListButton, requestPriceList, type ShareNavigator } from "./poultry-price-list-button";

vi.mock("../app/admin/actions", () => ({ logout: () => Promise.resolve() }));

const ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const png = () => new File([new Uint8Array([137, 80, 78, 71])], "Carnicerias_Fran_Lista_Pollos_2026-11-18.png", { type: "image/png" });

function nav(userAgent: string, extra: Partial<ShareNavigator> = {}): ShareNavigator {
  return { userAgent, platform: "", maxTouchPoints: 5, ...extra };
}

describe("Descargar lista de precios Pollos (celular)", () => {
  it("el Inicio del celular muestra el botón, sin pedir nada al abrir", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const html = renderToStaticMarkup(<MobileHome organizationName="SUPER OFERTAS" />);
    expect(html).toContain("Descargar lista de precios Pollos");
    expect(html).toContain('data-testid="mobile-price-list-button"');
    // Es un botón, no un link: no hay prefetch ni navegación, y las 4 tareas siguen siendo las únicas tarjetas-link.
    expect([...html.matchAll(/<a [^>]*href=/g)]).toHaveLength(4);
    expect(html).not.toContain("<img");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("es un único botón, sin editor, vista previa ni confirmación", () => {
    const html = renderToStaticMarkup(<MobilePriceListButton />);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<img");
  });

  it("los dos botones usan el MISMO generador y la misma lógica de descarga", () => {
    const button = readFileSync(path.join(__dirname, "mobile", "mobile-price-list-button.tsx"), "utf8");
    expect(button).toContain("usePoultryPriceListDownload");
    expect(button).not.toContain("fetch(");
    expect(button).not.toContain("/api/");
    expect(PRICE_LIST_ENDPOINT).toBe("/api/poultry/price-list");
    expect(renderToStaticMarkup(<PoultryPriceListButton />)).toContain("Lista de precios");
  });
});

describe("pedido del PNG", () => {
  it("cada toque hace UN POST nuevo, sin caché, con la sesión", async () => {
    const calls: [string, RequestInit][] = [];
    const result = await requestPriceList((input, init) => {
      calls.push([input, init]);
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Disposition": 'attachment; filename="Carnicerias_Fran_Lista_Pollos_2026-11-18.png"', "X-Price-List-Missing-Price": "2", "X-Price-List-Omitted-Weight": "0", "X-Price-List-Missing-Logo": "0" }
      }));
    });
    expect(calls).toEqual([["/api/poultry/price-list", { method: "POST", cache: "no-store", credentials: "same-origin" }]]);
    if ("error" in result) throw new Error(result.error);
    expect(result.file.name).toBe("Carnicerias_Fran_Lista_Pollos_2026-11-18.png");
    expect(result.file.type).toBe("image/png");
    expect(result.file.size).toBe(3);
    expect(result.notes).toEqual(["2 productos sin precio General: figuran como «Consultar»."]);
  });

  it("muestra el error del servidor (sesión vencida, sin permiso…)", async () => {
    const result = await requestPriceList(() => Promise.resolve(Response.json({ error: "Tu sesión venció: volvé a iniciar sesión" }, { status: 401 })));
    expect(result).toEqual({ error: "Tu sesión venció: volvé a iniciar sesión" });
    expect(await requestPriceList(() => Promise.resolve(new Response("oops", { status: 500 })))).toEqual({ error: "No se pudo generar la lista de precios." });
  });

  it("toma el nombre del archivo del servidor", () => {
    expect(filenameFrom('attachment; filename="Carnicerias_Fran_Lista_Pollos_2026-11-18.png"')).toBe("Carnicerias_Fran_Lista_Pollos_2026-11-18.png");
    expect(filenameFrom(null)).toBe("Carnicerias_Fran_Lista_Pollos.png");
  });
});

describe("entrega en cada plataforma", () => {
  it("Android, la app instalada en Android y las computadoras descargan directo", async () => {
    const share = vi.fn(() => Promise.resolve());
    expect(deliveryMethod(nav(ANDROID, { canShare: () => true, share }), png())).toBe("download");
    expect(deliveryMethod(nav("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", { maxTouchPoints: 0 }), png())).toBe("download");
    const save = vi.fn();
    expect(await deliverPriceList(png(), nav(ANDROID, { canShare: () => true, share }), save)).toBe("delivered");
    expect(save).toHaveBeenCalledTimes(1);
    expect(share).not.toHaveBeenCalled();
  });

  it("iPhone / iPad abren la hoja de compartir con el PNG (Guardar imagen, WhatsApp…)", async () => {
    expect(isAppleMobile(nav(IPHONE))).toBe(true);
    expect(isAppleMobile({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 5 })).toBe(true);
    expect(isAppleMobile({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 0 })).toBe(false);
    const share = vi.fn((data: { files: File[] }) => { expect(data.files[0]?.name).toContain("Lista_Pollos"); return Promise.resolve(); });
    const save = vi.fn();
    expect(await deliverPriceList(png(), nav(IPHONE, { canShare: () => true, share }), save)).toBe("delivered");
    expect(share).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it("en iPhone sin compartir archivos, descarga común", async () => {
    const save = vi.fn();
    expect(await deliverPriceList(png(), nav(IPHONE, { canShare: () => false, share: () => Promise.resolve() }), save)).toBe("delivered");
    expect(await deliverPriceList(png(), nav(IPHONE), save)).toBe("delivered");
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("si el sistema pide otro toque, el PNG ya generado queda listo (no se vuelve a pedir); cancelar no es un error", async () => {
    const fail = (name: string) => () => Promise.reject(Object.assign(new Error(name), { name }));
    const save = vi.fn();
    expect(await deliverPriceList(png(), nav(IPHONE, { canShare: () => true, share: fail("NotAllowedError") }), save)).toBe("blocked");
    expect(await deliverPriceList(png(), nav(IPHONE, { canShare: () => true, share: fail("AbortError") }), save)).toBe("delivered");
    expect(save).not.toHaveBeenCalled();
    expect(await deliverPriceList(png(), nav(IPHONE, { canShare: () => true, share: fail("DataError") }), save)).toBe("delivered");
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("consumo del generador", () => {
  it("la caché de imágenes baja cada imagen UNA vez por instancia y no guarda fallos", async () => {
    const cache = createImageCache(1000);
    const load = vi.fn(() => Promise.resolve(new Uint8Array(100)));
    await cache.read("org/poultry-price-list/a.jpg", load);
    await cache.read("org/poultry-price-list/a.jpg", load);
    expect(load).toHaveBeenCalledTimes(1);
    const missing = vi.fn(() => Promise.resolve(null));
    expect(await cache.read("org/poultry-price-list/b.jpg", missing)).toBeNull();
    expect(await cache.read("org/poultry-price-list/b.jpg", missing)).toBeNull();
    expect(missing).toHaveBeenCalledTimes(2);
  });

  it("una imagen nueva (ruta nueva) se baja; la caché respeta su tope descartando la menos usada", async () => {
    const cache = createImageCache(250);
    const bytes = (n: number) => () => Promise.resolve(new Uint8Array(n));
    await cache.read("a", bytes(100));
    await cache.read("b", bytes(100));
    await cache.read("a", bytes(100)); // «a» pasa a ser la más reciente
    await cache.read("c", bytes(100)); // se descarta «b»
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(200);
    const reloadB = vi.fn(bytes(100));
    await cache.read("b", reloadB);
    expect(reloadB).toHaveBeenCalledTimes(1);
    const big = vi.fn(bytes(400));
    await cache.read("huge", big);
    await cache.read("huge", big);
    expect(big).toHaveBeenCalledTimes(2); // más grande que el tope: no se guarda
    expect(cache.bytes).toBeLessThanOrEqual(250);
  });

  it("la respuesta sale en streaming y llega completa", async () => {
    const bytes = new Uint8Array(700_000).map((_, index) => index % 251);
    const received = new Uint8Array(await new Response(streamBytes(bytes, 256 * 1024)).arrayBuffer());
    expect(received).toEqual(bytes);
  });
});
