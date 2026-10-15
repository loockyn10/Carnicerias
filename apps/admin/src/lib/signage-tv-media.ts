import sharp from "sharp";

import { ARTWORK_BUCKET } from "./artwork-photo";

export const SIGNAGE_TV_BUCKET = "signage-tv-media";
const SOURCE_PATH = /^([0-9a-f-]{36})\/(?:([0-9a-f-]{36})|branding)\/([0-9a-f-]{36})\.(jpg|png)$/i;

/** La ruta incorpora el UUID inmutable del original: mismo original = misma URL; reemplazo = URL nueva. */
export function signageTvPublicPath(sourcePath: string): string | null {
  const match = SOURCE_PATH.exec(sourcePath);
  if (!match) return null;
  const organizationId = match[1];
  const productOrBranding = match[2];
  const fileId = match[3];
  if (!organizationId || !productOrBranding || !fileId) return null;
  return `${organizationId}/${productOrBranding}/${fileId}-tv-v1.webp`.toLowerCase();
}

interface StorageClient {
  storage: { from(bucket: string): {
    download(path: string): Promise<{ data: Blob | null; error: unknown }>;
    upload(path: string, body: Uint8Array, options: { contentType: string; cacheControl: string; upsert: boolean }): Promise<{ error: { message: string } | null }>;
  } };
  rpc(name: "register_signage_tv_media", args: { p_source_path: string; p_public_path: string }): PromiseLike<{ error: { message: string } | null }>;
}

/** Genera una sola vez el WebP de TV y registra el vínculo atómico con su original privado. */
export async function ensureSignageTvDerivative(supabase: StorageClient, sourcePath: string): Promise<{ publicPath: string; sizeBytes: number }> {
  const publicPath = signageTvPublicPath(sourcePath);
  if (!publicPath) throw new Error("Ruta de imagen inválida");
  const source = await supabase.storage.from(ARTWORK_BUCKET).download(sourcePath);
  if (source.error || !source.data) throw new Error("No se pudo leer la imagen original");
  const webp = await sharp(Buffer.from(await source.data.arrayBuffer()))
    .rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82, effort: 4 }).toBuffer();
  const uploaded = await supabase.storage.from(SIGNAGE_TV_BUCKET).upload(publicPath, webp, {
    contentType: "image/webp", cacheControl: "31536000", upsert: false
  });
  // Un upload simultáneo puede responder conflicto: el objeto es determinista e inmutable, así que se reutiliza.
  if (uploaded.error && !/already exists|duplicate|exists/i.test(uploaded.error.message)) throw new Error(uploaded.error.message);
  const registered = await supabase.rpc("register_signage_tv_media", { p_source_path: sourcePath, p_public_path: publicPath });
  if (registered.error) throw new Error(registered.error.message);
  return { publicPath, sizeBytes: webp.byteLength };
}
