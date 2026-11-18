import { readFileSync } from "node:fs";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MobileHome } from "./mobile/mobile-home";
import { feedButtonTitle, feedResultLines, MobilePromotionFeedButton } from "./mobile/mobile-promotion-feed-button";

vi.mock("../app/admin/actions", () => ({ logout: () => Promise.resolve() }));
vi.mock("next/headers", () => ({ headers: () => Promise.resolve(new Headers()) }));

const read = (...parts: string[]) => readFileSync(path.join(__dirname, ...parts), "utf8");

describe("Descargar promociones Feed (Inicio del celular)", () => {
  it("el Inicio muestra el botón con N y no pide nada al abrir", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const html = renderToStaticMarkup(<MobileHome organizationName="SUPER OFERTAS" promotionFeed={<MobilePromotionFeedButton lastBatch={10} pending={94} />} />);
    expect(html).toContain("Descargar promociones Feed (94)");
    expect(html).toContain('data-testid="mobile-promotion-feed-button"');
    expect(html).toContain("Repetir la última tanda (10)");
    // Sigue habiendo sólo las 4 tareas como links (botones, no navegación ni prefetch).
    expect([...html.matchAll(/<a [^>]*href=/g)]).toHaveLength(4);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("sin pendientes dice «Promociones actualizadas»; sin dato (computadora o error) no inventa un número", () => {
    expect(feedButtonTitle(0)).toBe("Promociones actualizadas");
    expect(feedButtonTitle(7)).toBe("Descargar promociones Feed (7)");
    expect(feedButtonTitle(null)).toBe("Descargar promociones Feed");
    const html = renderToStaticMarkup(<MobilePromotionFeedButton lastBatch={null} pending={0} />);
    expect(html).toContain("Promociones actualizadas");
    expect(html).not.toContain("Repetir la última tanda");
  });

  it("es UN botón (más «Repetir la última tanda»): sin selección, editor, vista previa ni confirmación", () => {
    const html = renderToStaticMarkup(<MobilePromotionFeedButton lastBatch={3} pending={5} />);
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<select");
  });

  it("resultado honesto: enviadas a Descargas, errores, sin registrar y cómo repetir", () => {
    const lines = feedResultLines({ total: 12, saved: 10, failed: [{ name: "Pata muslo", error: "x" }, { name: "Coca", error: "y" }], recorded: 7, unrecorded: 3, stopped: null }, 1);
    expect(lines).toEqual([
      { tone: "ok", text: "10 imágenes enviadas a Descargas (galería)." },
      { tone: "warn", text: "2 no se pudieron generar: Pata muslo, Coca. Siguen pendientes." },
      { tone: "warn", text: "3 imágenes bajaron pero no se pudo registrar: van a volver a aparecer como pendientes." },
      { tone: "warn", text: "1 promoción no se genera hoy (sin precio, inactiva o no se vende en la sucursal)." },
      { tone: "warn", text: "¿Falta alguna en la galería? Tocá «Repetir la última tanda»." }
    ]);
    expect(lines.some((line) => /guardad|en la galería ✓|100 %/i.test(line.text))).toBe(false);
  });

  it("sin ZIP, sin polling y con el mecanismo de descarga de la lista de Pollos", () => {
    const sources = [
      read("mobile", "mobile-promotion-feed-button.tsx"), read("mobile", "mobile-promotion-feed-entry.tsx"), read("..", "lib", "promotion-feed-queue.ts"),
      read("..", "app", "api", "promotions", "feed", "route.ts")
    ].join("\n");
    // Ni el módulo de ZIP de Cartelería, ni archivos .zip ni application/zip (los comentarios pueden decir «sin ZIP»).
    expect(sources).not.toMatch(/lib\/zip|\.zip\b|application\/zip|createZip|buildZip/i);
    expect(sources).not.toMatch(/setInterval|AutoRefresh|router\.refresh/);
    expect(read("mobile", "mobile-promotion-feed-button.tsx")).toContain('import { saveWithLink } from "../poultry-price-list-button";');
    // El PNG sale del generador de Cartelería (sin diseño nuevo) y no se guarda en Storage.
    const render = read("..", "lib", "promotion-feed-render.tsx");
    expect(render).toContain("folderItemModel");
    expect(render).toContain("renderArtworkPng(model, \"feed\")");
    expect(sources + render).not.toMatch(/\.upload\(|storage\.from\([^)]*\)\.(upload|update)/);
  });

  it("N se calcula sólo para celulares", async () => {
    const { isPhoneUserAgent } = await import("./mobile/mobile-promotion-feed-entry");
    expect(isPhoneUserAgent("Mozilla/5.0 (Linux; Android 14; 23049PCD8G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36")).toBe(true);
    expect(isPhoneUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36")).toBe(false);
  });
});
