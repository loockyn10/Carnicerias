import { folderItemModel } from "./artwork-folder-export";
import { FOLDER_STATE_LABELS } from "./artwork-folders";
import { ArtworkExportError, photoToDataUrl, renderArtworkPng, resolveBranding, type ArtworkExportDeps } from "./artwork-export";
import { DEFAULT_HEADLINE } from "./artwork-tokens";
import { analyzePngAlpha } from "./png-alpha";
import type { PromotionFeedItem } from "./promotion-feed";

/**
 * Pieza Feed (1080 × 1350) de UNA promoción para «Descargar promociones Feed» (D-103). No hay un diseño nuevo: es la pieza «Producto
 * protagonista» de las carpetas de Cartelería (`folderItemModel` + `renderArtworkPng`, titular «OFERTA», identidad y contacto de la
 * sucursal), con la composición estable del producto (la misma que «Crear una pieza individual»): volver a descargar una promoción con
 * otro precio la deja con la misma composición.
 *
 * Una foto PNG sin el dato de transparencia se analiza en memoria con sus bytes (lo mismo que Cartelería registra al abrir una carpeta).
 */

export type PromotionFeedRenderDeps = Pick<ArtworkExportDeps, "getBranding" | "readPhoto">;

export interface RenderedPromotionFeed {
  png: Uint8Array;
  /** Firma de lo dibujado (la que se registra si la descarga empieza). */
  signature: string;
  summary: string | null;
}

export async function renderPromotionFeed(deps: PromotionFeedRenderDeps, item: PromotionFeedItem, branch: { id: string | null; name: string | null }): Promise<RenderedPromotionFeed> {
  if (item.signature === null || !item.offer) throw new ArtworkExportError(409, `${item.name}: ${FOLDER_STATE_LABELS[item.state]}`);
  const photo = item.photo;
  const [branding, image] = await Promise.all([
    resolveBranding(deps, branch.id),
    photo ? deps.readPhoto(photo.storagePath).then((file) => {
      if (!file) throw new ArtworkExportError(502, "No se pudo leer la foto del producto. Probá de nuevo.");
      const hasAlpha = photo.hasAlpha ?? (photo.contentType === "image/png" ? analyzePngAlpha(file.bytes) : null);
      return { url: photoToDataUrl(photo, file.bytes), hasAlpha };
    }) : Promise.resolve(null)
  ]);
  const drawnItem = photo && image ? { ...item, photo: { ...photo, hasAlpha: image.hasAlpha } } : item;
  const model = folderItemModel(branch.name, drawnItem, DEFAULT_HEADLINE, branding, image?.url ?? null);
  const png = await renderArtworkPng(model, "feed");
  return { png, signature: item.signature, summary: item.summary };
}
