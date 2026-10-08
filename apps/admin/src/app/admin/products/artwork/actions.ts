"use server";

import { revalidatePath } from "next/cache";

import { requireAdminContext } from "../../../../lib/admin";
import { ARTWORK_UNAVAILABLE_LABELS, parseArtworkFacts, type ArtworkFacts } from "../../../../lib/artwork";
import { ARTWORK_BUCKET, buildPhotoPath, isValidPhotoPath, SIGNED_URL_SECONDS, type StoredPhotoType } from "../../../../lib/artwork-photo";
import { createClient } from "../../../../lib/supabase/server";
import { isUuid } from "../../../../lib/uuid";

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

type Supabase = Awaited<ReturnType<typeof createClient>>;

async function signedUrl(supabase: Supabase, storagePath: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(ARTWORK_BUCKET).createSignedUrl(storagePath, SIGNED_URL_SECONDS);
  return error ? null : data.signedUrl;
}

export type ArtworkLoadResult =
  | { kind: "ok"; facts: ArtworkFacts; photoUrl: string | null; unavailableMessage: string | null }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

/**
 * Hechos de la pieza de un producto para una sucursal (precio vigente + promoción + foto). El navegador pide `product + sucursal`;
 * el precio sale de la base (`get_product_artwork`), nunca del cliente. La foto viaja como URL firmada de corta vida (bucket privado).
 */
export async function loadArtworkAction(productId: string, branchId: string | null): Promise<ArtworkLoadResult> {
  try {
    await requireAdminContext();
    if (!isUuid(productId) || (branchId !== null && !isUuid(branchId))) return { kind: "not_found" };
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("get_product_artwork", { p_product_id: productId, ...(branchId ? { p_branch_id: branchId } : {}) });
    if (error) return { kind: "error", message: error.message };
    const facts = data === null ? null : parseArtworkFacts(data);
    if (!facts) return { kind: "not_found" };
    const photoUrl = facts.photo ? await signedUrl(supabase, facts.photo.storagePath) : null;
    return {
      kind: "ok", facts, photoUrl,
      unavailableMessage: facts.available ? null : ARTWORK_UNAVAILABLE_LABELS[facts.unavailableReason ?? "NO_PRICE"]
    };
  } catch (error) {
    return { kind: "error", message: message(error, "No se pudo cargar la pieza") };
  }
}

export interface ArtworkPhotoState {
  error?: string;
  /** URL firmada de la foto actual (null = el producto no tiene). */
  url?: string | null;
  sizeBytes?: number | null;
  contentType?: string | null;
}

/** Foto comercial actual de un producto (para el editor de producto). */
export async function getArtworkPhotoAction(productId: string): Promise<ArtworkPhotoState> {
  try {
    await requireAdminContext();
    if (!isUuid(productId)) return { error: "Producto inválido" };
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("get_product_artwork_photo", { p_product_id: productId });
    if (error) return { error: error.message };
    const record = data as { storagePath?: string; contentType?: string; sizeBytes?: number } | null;
    if (!record?.storagePath) return { url: null, sizeBytes: null, contentType: null };
    return { url: await signedUrl(supabase, record.storagePath), sizeBytes: record.sizeBytes ?? null, contentType: record.contentType ?? null };
  } catch (error) {
    return { error: message(error, "No se pudo leer la foto") };
  }
}

/** Ruta nueva (generada acá, con la organización de la sesión) donde el navegador sube la foto. */
export async function createArtworkUploadPathAction(productId: string, type: StoredPhotoType): Promise<{ path?: string; error?: string }> {
  try {
    const context = await requireAdminContext();
    // `type` llega del navegador: se valida como texto aunque el tipo diga otra cosa.
    const requested: string = type;
    if (!isUuid(productId) || (requested !== "image/jpeg" && requested !== "image/png")) return { error: "Pedido inválido" };
    return { path: buildPhotoPath(context.organizationId, productId, crypto.randomUUID(), type) };
  } catch (error) {
    return { error: message(error, "No se pudo preparar la subida") };
  }
}

async function removeObject(supabase: Supabase, storagePath: string | null | undefined): Promise<void> {
  if (!storagePath) return;
  // Mejor esfuerzo: si falla queda un objeto huérfano en Storage, sin referencia y sin efecto en ninguna pieza.
  await supabase.storage.from(ARTWORK_BUCKET).remove([storagePath]).catch(() => undefined);
}

/**
 * Registra la foto que el navegador YA subió a Storage (con su sesión y las políticas del bucket) como la foto comercial del producto.
 * Tipo y peso los toma la base de los metadatos del objeto. Si había otra foto, se borra el objeto anterior.
 */
export async function registerArtworkPhotoAction(productId: string, storagePath: string): Promise<ArtworkPhotoState> {
  try {
    const context = await requireAdminContext();
    if (!isUuid(productId) || !isValidPhotoPath(storagePath, context.organizationId, productId)) return { error: "Foto inválida" };
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("set_product_artwork_photo", { p_product_id: productId, p_storage_path: storagePath });
    if (error) {
      await removeObject(supabase, storagePath);
      return { error: error.message };
    }
    await removeObject(supabase, (data as { previousPath?: string | null } | null)?.previousPath);
    revalidatePath("/admin/products/artwork");
    return await getArtworkPhotoAction(productId);
  } catch (error) {
    return { error: message(error, "No se pudo guardar la foto") };
  }
}

/** Quita la foto comercial (referencia + objeto de Storage). */
export async function removeArtworkPhotoAction(productId: string): Promise<ArtworkPhotoState> {
  try {
    await requireAdminContext();
    if (!isUuid(productId)) return { error: "Producto inválido" };
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("remove_product_artwork_photo", { p_product_id: productId });
    if (error) return { error: error.message };
    await removeObject(supabase, (data as { removedPath?: string | null } | null)?.removedPath);
    revalidatePath("/admin/products/artwork");
    return { url: null, sizeBytes: null, contentType: null };
  } catch (error) {
    return { error: message(error, "No se pudo quitar la foto") };
  }
}
