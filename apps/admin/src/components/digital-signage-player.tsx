"use client";

import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";

import {
  fetchSignageView, initialPlayerState, nextPollDelay, playerReducer, SIGNAGE_RELOAD_MS, visibleSlideCount, type SignageLoadResult
} from "../lib/signage-player";
import { slideToArtworkModel } from "../lib/artwork";
import { emptyArtworkBranding, type ArtworkBranding } from "../lib/artwork-branding";
import { ARTWORK_COLORS, ARTWORK_FORMATS } from "../lib/artwork-tokens";
import { clampSlideSeconds, type OfferSlideData, type SignageView } from "../lib/signage";
import { FONT_FACE_CSS } from "./artwork/artwork-preview";
import { BrandBand, Canvas, Line } from "./artwork/artwork-parts";
import { OfferArtwork } from "./artwork/offer-artwork";

/** Tamaño de DISEÑO de la diapositiva (16:9): el reproductor la escala a la pantalla real con `transform`, sin recortar. */
const OFFER_SLIDE_WIDTH = ARTWORK_FORMATS.tv.width;
const OFFER_SLIDE_HEIGHT = ARTWORK_FORMATS.tv.height;

/** Duración del fundido entre slides (ms). */
const FADE_MS = 700;

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Escala que mete el escenario de 1920 × 1080 en la ventana real manteniendo 16:9 (sobra negro, nunca se recorta). */
function useStageScale(): number {
  const [scale, setScale] = useState(1);
  useIsomorphicLayoutEffect(() => {
    const update = () => {
      const width = window.innerWidth || OFFER_SLIDE_WIDTH;
      const height = window.innerHeight || OFFER_SLIDE_HEIGHT;
      setScale(Math.min(width / OFFER_SLIDE_WIDTH, height / OFFER_SLIDE_HEIGHT));
    };
    update();
    window.addEventListener("resize", update);
    return () => { window.removeEventListener("resize", update); };
  }, []);
  return scale;
}

/**
 * Pantalla de espera: sin ofertas publicadas, pantalla desactivada o todavía sin datos. Nunca un error técnico. Misma identidad
 * que las diapositivas (fondo blanco, franja verde con el logo, titular rojo).
 */
export function WaitingScreen({ brand, branding }: { brand: string; branding?: ArtworkBranding }) {
  const identity = branding ?? emptyArtworkBranding();
  const left = 206;
  const width = OFFER_SLIDE_WIDTH - left - 40;
  return <div data-testid="signage-waiting" style={{ display: "flex", width: OFFER_SLIDE_WIDTH, height: OFFER_SLIDE_HEIGHT }}>
    <Canvas format="tv" testId="artwork-tv-waiting">
      <BrandBand branding={identity} format="tv" />
      <div style={{ position: "absolute", left, top: 330, width, display: "flex", flexDirection: "column", alignItems: "center" }}>
        <Line color={identity.colors.red} size={150} text={brand || "Despensa"} />
        <div style={{ display: "flex", width: "100%", marginTop: 40 }}><Line color={ARTWORK_COLORS.BLACK} size={72} text="Próximamente nuevas ofertas" weight={700} /></div>
      </div>
    </Canvas>
  </div>;
}

/** El enlace de esta pantalla ya no es válido (fue regenerado o la pantalla ya no existe). Texto neutro, sin detalles técnicos. */
function RevokedScreen() {
  return <div data-testid="signage-revoked" style={{
    width: OFFER_SLIDE_WIDTH, height: OFFER_SLIDE_HEIGHT, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    background: "#1c1917", color: "#e7e5e4", textAlign: "center", fontFamily: "Inter, ui-sans-serif, system-ui, 'Segoe UI', Arial, sans-serif"
  }}>
    <p style={{ margin: 0, fontSize: 84, fontWeight: 800 }}>Pantalla no vinculada</p>
    <p style={{ margin: "32px 0 0", fontSize: 48, color: "#a8a29e" }}>Abrí el enlace actualizado desde el sistema</p>
  </div>;
}

/**
 * Reproductor de cartelería: rota las ofertas en bucle infinito con un fundido, consulta cada 30 s la configuración publicada y se
 * actualiza solo (sin recargar). Si una consulta falla conserva lo que ya tenía en memoria y reintenta. Pantalla completa, sin
 * controles, sin scroll y sin cursor.
 *
 * `loadView` es la fuente de datos: el televisor consulta `/api/tv/<token>`; la vista previa del Admin usa una server action.
 * Los timers y el fundido viven acá; las decisiones (siguiente slide, qué conservar ante un error) están en `lib/signage-player.ts`.
 */
export function DigitalSignagePlayer({ initialView, loadView, brandFallback = "" }: {
  initialView: SignageView | null;
  loadView: () => Promise<SignageLoadResult>;
  brandFallback?: string;
}) {
  const [state, dispatch] = useReducer(playerReducer, initialView, initialPlayerState);
  const scale = useStageScale();
  const loadRef = useRef(loadView);
  loadRef.current = loadView;
  const lastOkAt = useRef(Date.now());

  const slides = state.revoked ? [] : state.view?.slides ?? [];
  const count = visibleSlideCount(state);
  const current = slides[state.index] ?? null;
  const durationMs = clampSlideSeconds(state.view?.slideDurationSeconds ?? 0) * 1000;

  // Rotación: un temporizador por slide visible. Con una sola oferta (o ninguna) no hay nada que rotar.
  useEffect(() => {
    if (count < 2) return;
    const timer = window.setTimeout(() => { dispatch({ type: "ADVANCE" }); }, durationMs);
    return () => { window.clearTimeout(timer); };
  }, [state.index, count, durationMs, current?.key]);

  // Actualización automática: consulta periódica; tras un fallo reintenta antes (se recupera pronto de un corte breve).
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      const result = await loadRef.current().catch((): SignageLoadResult => ({ kind: "error" }));
      if (cancelled) return;
      if (result.kind === "ok") lastOkAt.current = Date.now();
      dispatch({ type: "REFRESHED", result });
      timer = window.setTimeout(() => { void tick(); }, nextPollDelay(result.kind));
    };
    timer = window.setTimeout(() => { void tick(); }, nextPollDelay("ok"));
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, []);

  // Recarga completa cada tanto para tomar versiones nuevas del código; sólo si la última consulta fue bien (nunca deja una página de error).
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (Date.now() - lastOkAt.current < 2 * 60 * 1000) window.location.reload();
    }, SIGNAGE_RELOAD_MS);
    return () => { window.clearInterval(timer); };
  }, []);

  // Fundido: se mantiene montada la oferta anterior un instante mientras entra la nueva.
  const [leaving, setLeaving] = useState<{ slide: OfferSlideData; index: number } | null>(null);
  const shown = useRef<{ slide: OfferSlideData; index: number } | null>(current ? { slide: current, index: state.index } : null);
  useIsomorphicLayoutEffect(() => {
    const previous = shown.current;
    shown.current = current ? { slide: current, index: state.index } : null;
    if (!previous || !current || previous.slide.key === current.key) return;
    setLeaving(previous);
    const timer = window.setTimeout(() => { setLeaving(null); }, FADE_MS);
    return () => { window.clearTimeout(timer); };
  }, [current]);

  const viewBrand = state.view?.organizationName ?? "";
  const brand = viewBrand === "" ? brandFallback : viewBrand;
  const branding = state.view?.branding ?? emptyArtworkBranding();
  const artwork = (slide: OfferSlideData, index: number) => <OfferArtwork format="tv" model={slideToArtworkModel({ branding }, slide)} slideIndex={index} />;

  return <div data-testid="signage-viewport" style={{ position: "fixed", inset: 0, overflow: "hidden", background: "#000", cursor: "none" }}>
    <style>{`@keyframes signage-fade-in{from{opacity:0}to{opacity:1}}@keyframes signage-fade-out{from{opacity:1}to{opacity:0}}`}</style>
    <style dangerouslySetInnerHTML={{ __html: FONT_FACE_CSS }} />
    <div data-testid="signage-stage" style={{
      position: "absolute", left: "50%", top: "50%", width: OFFER_SLIDE_WIDTH, height: OFFER_SLIDE_HEIGHT,
      transform: `translate(-50%, -50%) scale(${String(scale)})`, transformOrigin: "center center"
    }}>
      {state.revoked ? <RevokedScreen /> : current ? <>
        {leaving ? <div key={`out-${leaving.slide.key}`} style={{ position: "absolute", inset: 0, animation: `signage-fade-out ${String(FADE_MS)}ms ease forwards` }}>{artwork(leaving.slide, leaving.index)}</div> : null}
        <div data-testid="signage-current" data-slide-key={current.key} key={current.key} style={{ position: "absolute", inset: 0, animation: leaving ? `signage-fade-in ${String(FADE_MS)}ms ease both` : "none" }}>
          {artwork(current, state.index)}
        </div>
      </> : <WaitingScreen brand={brand} branding={branding} />}
    </div>
  </div>;
}

/** Fuente de datos del televisor: consulta el endpoint público de SU token. */
export function DigitalSignageTv({ token, initialView, brandFallback }: { token: string; initialView: SignageView | null; brandFallback?: string }) {
  const url = `/api/tv/${token}`;
  const loadView = () => fetchSignageView(url, (input, init) => fetch(input, init));
  return <DigitalSignagePlayer brandFallback={brandFallback ?? ""} initialView={initialView} loadView={loadView} />;
}
