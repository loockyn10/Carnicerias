import { ImageResponse } from "next/og";
import { vi } from "vitest";

import type { ArtworkExportDeps } from "../artwork-export";
import { ARTWORK_FONT_900_BASE64, ARTWORK_FONT_FAMILY } from "../artwork-font-data";
import { brandingPayload, factsById, samplePhotoBytes, type BrandingBranch } from "./artwork-fixtures";

/**
 * Dobles de las lecturas del export para las pruebas: `get_product_artwork` y `get_artwork_branding` salen de los fixtures y Storage
 * devuelve los bytes sintéticos. Cada lectura es un `vi.fn` para poder comprobar qué pidió el servidor.
 */
export interface FixtureDepsOptions {
  /** Sucursal cuyo contacto devuelve `get_artwork_branding` (null = precio general). Por defecto, Central. */
  branch?: BrandingBranch;
  /** false = la organización no tiene logo. */
  logo?: boolean;
  /** Reemplaza los bytes del logo (p. ej. el logo de muestra renderizado). */
  logoBytes?: Uint8Array;
  /** Reemplazo/extensión de los hechos de un producto (por id). */
  factsOverrides?: Record<string, Record<string, unknown>>;
}

export function fixtureDeps(options: FixtureDepsOptions = {}) {
  const branch = options.branch === undefined ? "central" : options.branch;
  const getFacts = vi.fn<ArtworkExportDeps["getFacts"]>((productId) => {
    const facts = factsById(productId);
    return Promise.resolve(facts ? { ...facts, ...(options.factsOverrides?.[productId] ?? {}) } : null);
  });
  const getBranding = vi.fn<ArtworkExportDeps["getBranding"]>(() => Promise.resolve(brandingPayload(branch, options.logo === undefined ? {} : { logo: options.logo })));
  const readPhoto = vi.fn((path: string) => {
    const bytes = path.includes("/branding/") && options.logoBytes ? options.logoBytes : samplePhotoBytes(path);
    return Promise.resolve(bytes ? { bytes } : null);
  });
  const deps = { getFacts, getBranding, readPhoto } satisfies ArtworkExportDeps;
  return { deps, getFacts, getBranding, readPhoto };
}

function fontBuffer(base64: string): ArrayBuffer {
  const buffer = Buffer.from(base64, "base64");
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

/**
 * Logo de MUESTRA para revisar a ojo la franja (apaisado, PNG transparente): «SuperOfertas» en blanco y amarillo con un bloque rojo.
 * NO es el logo real del negocio (ese lo sube el usuario desde «Configurar identidad»).
 */
export async function renderSampleLogo(): Promise<Uint8Array> {
  const response = new ImageResponse(
    <div style={{ display: "flex", flexDirection: "row", alignItems: "center", width: 1260, height: 200, fontFamily: ARTWORK_FONT_FAMILY }}>
      <div style={{ display: "flex", width: 120, height: 120, background: "#D8201B", borderRadius: 20, marginRight: 30 }} />
      <div style={{ display: "flex", fontSize: 130, fontWeight: 900, color: "#FFFFFF" }}>Super</div>
      <div style={{ display: "flex", fontSize: 130, fontWeight: 900, color: "#FFD400", marginLeft: 16 }}>Ofertas</div>
    </div>,
    { width: 1260, height: 200, fonts: [{ name: ARTWORK_FONT_FAMILY, data: fontBuffer(ARTWORK_FONT_900_BASE64), weight: 900, style: "normal" }] }
  );
  return new Uint8Array(await response.arrayBuffer());
}
