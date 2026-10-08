"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { OfferArtworkModel } from "../../lib/artwork";
import { ARTWORK_FONT_700_BASE64, ARTWORK_FONT_900_BASE64, ARTWORK_FONT_FAMILY } from "../../lib/artwork-font-data";
import { ARTWORK_FORMATS, type ArtworkFormat } from "../../lib/artwork-tokens";
import { OfferArtwork } from "./offer-artwork";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** La misma fuente embebida que usa el PNG: el preview y la imagen exportada miden y dibujan el texto igual. */
const FONT_FACE_CSS = `@font-face{font-family:"${ARTWORK_FONT_FAMILY}";font-weight:900;font-style:normal;src:url(data:font/woff;base64,${ARTWORK_FONT_900_BASE64}) format("woff")}`
  + `@font-face{font-family:"${ARTWORK_FONT_FAMILY}";font-weight:700;font-style:normal;src:url(data:font/woff;base64,${ARTWORK_FONT_700_BASE64}) format("woff")}`;

/**
 * Preview de la pieza: dibuja el MISMO renderer que el PNG (`OfferArtwork`) a su tamaño de diseño (1920 × 1080, 1080 × 1350 o
 * 1080 × 1920) y lo escala con `transform` al ancho disponible, sin scroll interno ni recortes. Cambiar de formato no crea otro
 * contenido: es la misma pieza (`model`) con otra composición.
 */
export function ArtworkPreview({ model, format, maxHeightVh = 72 }: { model: OfferArtworkModel; format: ArtworkFormat; maxHeightVh?: number }) {
  const spec = ARTWORK_FORMATS[format];
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.3);

  useIsomorphicLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const update = () => { setScale(frame.clientWidth / spec.width); };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => { observer.disconnect(); };
  }, [spec.width, spec.height, maxHeightVh]);

  const ratio = spec.width / spec.height;
  return <div
    aria-label={`Vista previa ${spec.label}`}
    className="mx-auto overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm"
    data-testid="artwork-preview"
    ref={frameRef}
    role="group"
    style={{ position: "relative", width: `min(100%, ${String(Math.round(maxHeightVh * ratio * 100) / 100)}vh)`, aspectRatio: `${String(spec.width)} / ${String(spec.height)}` }}
  >
    <style dangerouslySetInnerHTML={{ __html: FONT_FACE_CSS }} />
    <div style={{ position: "absolute", left: 0, top: 0, width: spec.width, height: spec.height, transform: `scale(${String(scale)})`, transformOrigin: "top left" }}>
      <OfferArtwork format={format} model={model} />
    </div>
  </div>;
}
