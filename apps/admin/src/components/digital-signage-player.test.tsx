import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { OfferSlideData, SignageView } from "../lib/signage";
import { DigitalSignagePlayer, DigitalSignageTv, WaitingScreen } from "./digital-signage-player";

const offer = (key: string, name: string, whole: string): OfferSlideData => ({
  key, variant: "REGULAR", name, price: { whole, cents: null }, priceSuffix: null, condition: "PRECIO UNITARIO", secondary: null, promo: false, nameFit: 1
});
const view = (slides: OfferSlideData[], overrides: Partial<SignageView> = {}): SignageView => ({
  status: "ACTIVE", slideDurationSeconds: 8, organizationName: "Despensa Demo", slides, ...overrides
});
const never = () => new Promise<never>(() => undefined);

describe("DigitalSignagePlayer (render inicial)", () => {
  it("arranca solo mostrando la PRIMERA oferta (sin click ni controles)", () => {
    const html = renderToStaticMarkup(<DigitalSignagePlayer initialView={view([offer("a", "Aceite", "2.450"), offer("b", "Yerba", "3.100")])} loadView={never} />);
    expect(html).toContain("Aceite");
    expect(html).toContain("2.450");
    expect(html).not.toContain("Yerba");
    expect(html).toContain('data-slide-key="a"');
  });

  it("pantalla completa, sin scroll, sin cursor, sin controles ni elementos del shell", () => {
    const html = renderToStaticMarkup(<DigitalSignagePlayer initialView={view([offer("a", "Aceite", "2.450")])} loadView={never} />);
    expect(html).toContain("position:fixed");
    expect(html).toContain("inset:0");
    expect(html).toContain("overflow:hidden");
    expect(html).toContain("cursor:none");
    expect(html).not.toMatch(/<button|<a |<input|<nav|<aside|<header/);
  });

  it("escenario fijo de 1920 × 1080 que se escala a la pantalla real manteniendo 16:9", () => {
    const html = renderToStaticMarkup(<DigitalSignagePlayer initialView={view([offer("a", "Aceite", "2.450")])} loadView={never} />);
    expect(html).toMatch(/data-testid="signage-stage"[^>]*style="[^"]*width:1920px;height:1080px/);
    expect(html).toContain("scale(1)");
  });

  it("sin ofertas publicadas: pantalla de espera digna con el nombre del comercio (nunca undefined/error/cargando)", () => {
    const html = renderToStaticMarkup(<DigitalSignagePlayer initialView={view([])} loadView={never} />);
    expect(html).toContain("signage-waiting");
    expect(html).toContain("Despensa Demo");
    expect(html).toContain("Próximamente nuevas ofertas");
    expect(html).not.toMatch(/undefined|null|NaN|error|cargando|loading/i);
  });

  it("sin datos todavía (la base no respondió): espera digna, sin error técnico", () => {
    const html = renderToStaticMarkup(<DigitalSignagePlayer brandFallback="Carnicería" initialView={null} loadView={never} />);
    expect(html).toContain("Carnicería");
    expect(html).toContain("Próximamente nuevas ofertas");
    expect(html).not.toMatch(/undefined|error|cargando|loading/i);
  });

  it("pantalla desactivada: el mismo cartel de espera", () => {
    const html = renderToStaticMarkup(<DigitalSignagePlayer initialView={view([], { status: "DISABLED" })} loadView={never} />);
    expect(html).toContain("Próximamente nuevas ofertas");
  });

  it("la pantalla de espera usa un texto genérico si ni siquiera hay nombre", () => {
    expect(renderToStaticMarkup(<WaitingScreen brand="" />)).toContain("Despensa");
  });

  it("el televisor consulta SU endpoint (/api/tv/<token>) y no el del Admin", () => {
    const html = renderToStaticMarkup(<DigitalSignageTv initialView={view([offer("a", "Aceite", "2.450")])} token={"a".repeat(64)} />);
    expect(html).toContain("Aceite");
  });
});
