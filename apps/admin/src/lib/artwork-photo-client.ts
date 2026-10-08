import { createArtworkUploadPathAction, registerArtworkPhotoAction, type ArtworkPhotoState } from "../app/admin/products/artwork/actions";
import {
  ARTWORK_BUCKET, MAX_PHOTO_BYTES, PHOTO_SIZE_ERROR, planPhoto, type StoredPhotoType
} from "./artwork-photo";
import { createClient } from "./supabase/client";

/**
 * Subida de la foto comercial (sólo navegador). Valida, convierte/reduce si hace falta (WebP → PNG; fotos enormes → 2.400 px), sube
 * el archivo a Supabase Storage con la sesión del usuario (las políticas del bucket aíslan por organización) y registra la foto.
 * Nunca pasa por Postgres como base64.
 */

async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new Error("No se pudo leer la imagen: probá con otro archivo.");
  }
}

async function encode(bitmap: ImageBitmap, type: StoredPhotoType, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No se pudo procesar la imagen en este navegador.");
  // Un JPG no tiene transparencia: se apoya sobre blanco (un PNG conserva su fondo transparente).
  if (type === "image/jpeg") { context.fillStyle = "#ffffff"; context.fillRect(0, 0, width, height); }
  context.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, type, type === "image/jpeg" ? 0.92 : undefined); });
  if (!blob) throw new Error("No se pudo procesar la imagen en este navegador.");
  return blob;
}

export interface PreparedPhoto { blob: Blob; type: StoredPhotoType }

/** Archivo elegido → lo que se sube (JPG/PNG de hasta 5 MB). Lanza un Error con el mensaje para el usuario. */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  const bitmap = await decode(file);
  try {
    const plan = planPhoto({ type: file.type, size: file.size, width: bitmap.width, height: bitmap.height });
    if (plan.action === "reject") throw new Error(plan.error);
    if (plan.action === "keep") return { blob: file, type: plan.type };
    let blob = await encode(bitmap, plan.type, plan.width, plan.height);
    // Un PNG recodificado (p. ej. una foto WebP) puede pesar más de lo permitido: se prueba como JPG sobre blanco.
    if (blob.size > MAX_PHOTO_BYTES && plan.type === "image/png") {
      blob = await encode(bitmap, "image/jpeg", plan.width, plan.height);
      if (blob.size > MAX_PHOTO_BYTES) throw new Error(PHOTO_SIZE_ERROR);
      return { blob, type: "image/jpeg" };
    }
    if (blob.size > MAX_PHOTO_BYTES) throw new Error(PHOTO_SIZE_ERROR);
    return { blob, type: plan.type };
  } finally {
    bitmap.close();
  }
}

/** Sube la foto a Storage y la registra como la foto comercial del producto. */
export async function uploadArtworkPhoto(productId: string, file: File): Promise<ArtworkPhotoState> {
  let prepared: PreparedPhoto;
  try {
    prepared = await preparePhoto(file);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo preparar la foto" };
  }
  const target = await createArtworkUploadPathAction(productId, prepared.type);
  if (target.error || !target.path) return { error: target.error ?? "No se pudo preparar la subida" };
  const { error } = await createClient().storage.from(ARTWORK_BUCKET).upload(target.path, prepared.blob, { contentType: prepared.type, upsert: false });
  if (error) return { error: `No se pudo subir la foto: ${error.message}` };
  return registerArtworkPhotoAction(productId, target.path);
}
