import { ARTWORK_BUCKET, MAX_PHOTO_BYTES } from "./artwork-photo";
import { findSignageMedia, type MediaRef, type SignageMedia } from "./signage";
import { isUuid } from "./uuid";

/**
 * Imágenes de la cartelería de TV (D-076): la foto comercial de cada diapositiva y el logo viven en el bucket PRIVADO
 * `product-artwork`. El navegador del televisor nunca habla con Storage: pide `/api/tv/<token>/media/<id>` (o, en la vista previa
 * del Admin, `/api/tv-preview/<pantalla>/media/<id>`) y el servidor
 *   1. relee la presentación publicada (la RPC valida el token / la sesión),
 *   2. busca en ELLA la ruta de ese `id` (el id de una diapositiva o `logo`): nunca se lee una ruta que venga del navegador,
 *   3. descarga el objeto y comprueba que los bytes REALES sean PNG/JPEG del tipo registrado.
 * Puro salvo `download`, que se inyecta (Storage con la clave pública para el televisor, con la sesión para el Admin).
 */

export const SIGNAGE_LOGO_ID = "logo";

export type SignageMediaResult =
  | { kind: "ok"; bytes: Uint8Array; contentType: "image/jpeg" | "image/png" }
  | { kind: "not_found" }
  | { kind: "error" };

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

const startsWith = (bytes: Uint8Array, magic: number[]) => magic.every((value, index) => bytes[index] === value);

/** Los bytes son una imagen del tipo declarado (lo que dice la base o el navegador no alcanza) y no pasan el tope de tamaño. */
export function isValidImage(bytes: Uint8Array, contentType: MediaRef["contentType"]): boolean {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHOTO_BYTES) return false;
  return contentType === "image/png" ? startsWith(bytes, PNG_MAGIC) : startsWith(bytes, JPEG_MAGIC);
}

/** Identificador válido de una imagen: el id de una diapositiva (uuid) o `logo`. */
export function isMediaId(value: string): boolean {
  return value === SIGNAGE_LOGO_ID || isUuid(value);
}

/** Versión de la imagen en la URL: el nombre del archivo (un uuid nuevo en cada subida), así el navegador la cachea sin quedar vieja. */
export function mediaVersion(storagePath: string): string {
  const name = storagePath.slice(storagePath.lastIndexOf("/") + 1);
  return name.replace(/\.[a-z]+$/, "").replace(/[^0-9a-f-]/gi, "").slice(0, 36);
}

/** Resolvedor de imágenes para una superficie: `base` es la ruta del endpoint de esa superficie (sin barra final). */
export function signageMediaUrls(base: string): SignageMedia {
  return {
    photoUrl: (slideKey, photo) => `${base}/media/${encodeURIComponent(slideKey)}?v=${mediaVersion(photo.storagePath)}`,
    logoUrl: (logo) => `${base}/media/${SIGNAGE_LOGO_ID}?v=${mediaVersion(logo.storagePath)}`
  };
}

/** Lee la imagen `id` de la presentación `payload` (JSON de la RPC). `download` devuelve los bytes o null si no se pudieron leer. */
export async function readSignageMedia(
  payload: unknown,
  id: string,
  download: (bucket: string, storagePath: string) => Promise<Uint8Array | null>
): Promise<SignageMediaResult> {
  if (!isMediaId(id)) return { kind: "not_found" };
  const ref = findSignageMedia(payload, id);
  if (!ref) return { kind: "not_found" };
  try {
    const bytes = await download(ARTWORK_BUCKET, ref.storagePath);
    if (!bytes) return { kind: "error" };
    if (!isValidImage(bytes, ref.contentType)) return { kind: "not_found" };
    return { kind: "ok", bytes, contentType: ref.contentType };
  } catch {
    return { kind: "error" };
  }
}
