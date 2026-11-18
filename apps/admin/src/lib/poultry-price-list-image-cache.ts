/**
 * Caché en memoria de la función (D-102) para el logo y la foto de fondo de la «Lista de precios» de Pollos: una instancia caliente de la
 * función no vuelve a bajar del bucket privado la misma imagen en cada descarga (es lo único pesado que viaja de Supabase a Vercel).
 *
 * Por qué es seguro:
 *   - la clave es la ruta del objeto, y cada subida crea una ruta nueva (`<organización>/…/<uuid>.<ext>`, `upsert: false`): el contenido de
 *     una ruta nunca cambia, así que no hace falta invalidar; cambiar el logo o el fondo cambia la ruta y la imagen vieja deja de pedirse;
 *   - la ruta sólo se consulta después de que `get_poultry_price_list_settings` la devolvió con la sesión del usuario (permiso y
 *     organización ya validados), y la organización es la primera carpeta de la ruta: no hay forma de leer imágenes de otra organización;
 *   - sólo imágenes: productos y precios NUNCA se guardan acá (se leen de la base en cada descarga);
 *   - tiene tope de bytes y descarta la menos usada; un fallo de lectura no se guarda (se reintenta en la próxima descarga).
 */

export const PRICE_LIST_IMAGE_CACHE_BYTES = 24 * 1024 * 1024;

export interface ImageCache {
  read: (storagePath: string, load: () => Promise<Uint8Array | null>) => Promise<Uint8Array | null>;
  readonly size: number;
  readonly bytes: number;
}

export function createImageCache(maxBytes = PRICE_LIST_IMAGE_CACHE_BYTES): ImageCache {
  const entries = new Map<string, Uint8Array>();
  let bytes = 0;
  return {
    async read(storagePath, load) {
      const hit = entries.get(storagePath);
      if (hit) {
        // Map conserva el orden de inserción: reinsertar = marcarla como la más reciente.
        entries.delete(storagePath);
        entries.set(storagePath, hit);
        return hit;
      }
      const loaded = await load();
      if (!loaded || loaded.byteLength > maxBytes) return loaded;
      entries.set(storagePath, loaded);
      bytes += loaded.byteLength;
      for (const [key, value] of entries) {
        if (bytes <= maxBytes) break;
        entries.delete(key);
        bytes -= value.byteLength;
      }
      return loaded;
    },
    get size() { return entries.size; },
    get bytes() { return bytes; }
  };
}

/** La caché de esta instancia de la función (vive mientras la instancia siga caliente). */
export const priceListImageCache = createImageCache();
