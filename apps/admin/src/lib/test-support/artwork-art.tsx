import { ImageResponse } from "next/og";

/**
 * «Fotos» de muestra algo más realistas que los óvalos de color liso, SÓLO para revisar a ojo las composiciones (carne, almacén, producto
 * alto, ancho, recorte transparente, fondo blanco). No son fotos reales: son dibujos vectoriales que Satori convierte en PNG.
 */

export type ProductArtKind = "bife" | "milanesas" | "botella" | "bandeja" | "pack" | "pollo" | "chorizos";

interface Art { width: number; height: number; svg: React.ReactNode }

const SVG_NS = "http://www.w3.org/2000/svg";

function arts(): Record<ProductArtKind, Art> {
  return {
    // Corte de carne con vetas y borde de grasa (apaisado, ~1.45:1).
    bife: {
      width: 900, height: 620,
      svg: <svg height="620" viewBox="0 0 900 620" width="900" xmlns={SVG_NS}>
        <path d="M120 300 C60 150 260 40 470 60 C700 70 850 170 830 330 C815 470 640 580 430 570 C240 560 150 450 120 300 Z" fill="#F4E6D8" />
        <path d="M150 300 C100 170 280 80 470 96 C670 106 800 190 786 330 C772 450 620 540 430 532 C260 526 170 430 150 300 Z" fill="#B3262C" />
        <path d="M250 190 C330 130 470 140 540 190 C470 230 340 250 250 190 Z" fill="#D95B58" />
        <path d="M520 360 C600 320 700 340 730 400 C680 450 580 450 520 360 Z" fill="#CE4A47" />
        <path d="M200 340 C260 330 330 380 330 430 C280 440 220 410 200 340 Z" fill="#E7A9A0" />
        <path d="M360 270 C420 250 500 270 520 310" fill="none" stroke="#F0C8C0" strokeLinecap="round" strokeWidth="10" />
      </svg>
    },
    // Pila de milanesas empanadas (casi cuadrado).
    milanesas: {
      width: 760, height: 640,
      svg: <svg height="640" viewBox="0 0 760 640" width="760" xmlns={SVG_NS}>
        <ellipse cx="400" cy="400" fill="#C98F3E" rx="320" ry="190" />
        <ellipse cx="380" cy="360" fill="#E3AE55" rx="310" ry="180" />
        <ellipse cx="350" cy="300" fill="#C98F3E" rx="300" ry="170" />
        <ellipse cx="340" cy="285" fill="#EDBB63" rx="285" ry="158" />
        <circle cx="260" cy="250" fill="#D79F48" r="22" /><circle cx="420" cy="300" fill="#D79F48" r="26" /><circle cx="520" cy="240" fill="#D79F48" r="18" /><circle cx="330" cy="340" fill="#D79F48" r="20" />
      </svg>
    },
    // Botella alta (aceite / gaseosa): ~1:3.
    botella: {
      width: 300, height: 880,
      svg: <svg height="880" viewBox="0 0 300 880" width="300" xmlns={SVG_NS}>
        <rect fill="#E2B21A" height="70" rx="12" width="110" x="95" y="10" />
        <path d="M100 80 H200 V170 C200 210 270 240 270 320 V820 C270 850 250 870 220 870 H80 C50 870 30 850 30 820 V320 C30 240 100 210 100 170 Z" fill="#F2C94C" />
        <rect fill="#FFFFFF" height="300" rx="14" width="224" x="38" y="360" />
        <rect fill="#0B8A2F" height="80" width="224" x="38" y="400" />
        <rect fill="#D8201B" height="26" rx="6" width="150" x="75" y="520" />
        <rect fill="#4A4A45" height="16" rx="6" width="170" x="65" y="580" />
      </svg>
    },
    // Bandeja ancha con chorizos (≈2.6:1).
    bandeja: {
      width: 1040, height: 400,
      svg: <svg height="400" viewBox="0 0 1040 400" width="1040" xmlns={SVG_NS}>
        <rect fill="#EFEFEA" height="340" rx="40" width="1000" x="20" y="40" />
        <rect fill="#FFFFFF" height="300" rx="30" width="960" x="40" y="60" />
        <path d="M110 150 C300 100 430 190 600 150 C760 112 860 150 930 170" fill="none" stroke="#B5492A" strokeLinecap="round" strokeWidth="64" />
        <path d="M110 240 C300 190 430 280 600 240 C760 200 860 240 930 260" fill="none" stroke="#C25A32" strokeLinecap="round" strokeWidth="64" />
        <path d="M110 330 C300 280 430 370 600 330 C760 290 860 330 930 350" fill="none" stroke="#B5492A" strokeLinecap="round" strokeWidth="56" />
      </svg>
    },
    // Caja de producto envasado (cuadrada).
    pack: {
      width: 640, height: 640,
      svg: <svg height="640" viewBox="0 0 640 640" width="640" xmlns={SVG_NS}>
        <rect fill="#0B8A2F" height="560" rx="26" width="560" x="40" y="40" />
        <rect fill="#FFD400" height="170" width="560" x="40" y="130" />
        <circle cx="320" cy="360" fill="#FFFFFF" r="130" />
        <circle cx="320" cy="360" fill="#D8201B" r="84" />
        <rect fill="#FFFFFF" height="26" rx="10" width="360" x="140" y="530" />
      </svg>
    },
    pollo: {
      width: 820, height: 640,
      svg: <svg height="640" viewBox="0 0 820 640" width="820" xmlns={SVG_NS}>
        <ellipse cx="410" cy="330" fill="#E9B36A" rx="330" ry="250" />
        <ellipse cx="390" cy="300" fill="#F2C887" rx="290" ry="205" />
        <ellipse cx="640" cy="440" fill="#D79B50" rx="110" ry="80" />
        <ellipse cx="200" cy="470" fill="#D79B50" rx="95" ry="70" />
      </svg>
    },
    chorizos: {
      width: 780, height: 520,
      svg: <svg height="520" viewBox="0 0 780 520" width="780" xmlns={SVG_NS}>
        <path d="M100 160 C260 90 460 230 680 140" fill="none" stroke="#A8402A" strokeLinecap="round" strokeWidth="84" />
        <path d="M100 290 C260 220 460 360 680 270" fill="none" stroke="#B9502F" strokeLinecap="round" strokeWidth="84" />
        <path d="M100 420 C260 350 460 490 680 400" fill="none" stroke="#A8402A" strokeLinecap="round" strokeWidth="84" />
      </svg>
    }
  };
}

/** PNG de la «foto» pedida. `background: "white"` simula un JPG con fondo propio (el recorte queda sobre blanco, sin transparencia). */
export async function renderProductArt(kind: ProductArtKind, background: "transparent" | "white" = "transparent"): Promise<Uint8Array> {
  const art = arts()[kind];
  const response = new ImageResponse(
    <div style={{ display: "flex", width: art.width, height: art.height, ...(background === "white" ? { background: "#FFFFFF" } : {}) }}>{art.svg}</div>,
    { width: art.width, height: art.height }
  );
  return new Uint8Array(await response.arrayBuffer());
}
