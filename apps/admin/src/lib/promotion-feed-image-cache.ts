import { createImageCache } from "./poultry-price-list-image-cache";

/**
 * Caché en memoria de la instancia (D-103) para el logo y las fotos de producto que dibuja «Descargar promociones Feed». Misma regla que la
 * de Pollos (D-102): la clave es la ruta del objeto y toda subida de Cartelería crea una ruta nueva (`upsert: false`), así que el contenido de
 * una ruta nunca cambia; la ruta sólo llega acá después de que una RPC con la sesión del usuario la devolvió. Sólo imágenes: precios y
 * promociones se leen de la base en cada pieza. Con 94 piezas el logo se baja UNA vez por instancia en lugar de 94.
 */
export const PROMOTION_FEED_IMAGE_CACHE_BYTES = 48 * 1024 * 1024;

export const promotionFeedImageCache = createImageCache(PROMOTION_FEED_IMAGE_CACHE_BYTES);
