"use server";

import { revalidatePath } from "next/cache";

import { requireAdminContext } from "../../../../lib/admin";
import { parseFolderFacts, parseFolders, type FolderItemKind, type FolderSummary } from "../../../../lib/artwork-folders";
import { ARTWORK_BUCKET, isValidPhotoPath, SIGNED_URL_SECONDS } from "../../../../lib/artwork-photo";
import { recordPhotoAlpha } from "../../../../lib/artwork-photo-alpha";
import { nullableArg } from "../../../../lib/rpc-args";
import { createClient } from "../../../../lib/supabase/server";
import { isUuid } from "../../../../lib/uuid";

/**
 * Carpetas de gráficas (D-086): crear, editar, eliminar y leer lo VIGENTE de una carpeta. La carpeta guarda sólo referencias (ids); el
 * precio, la promoción y la foto se resuelven acá, en la base, en cada lectura. Los permisos y el aislamiento por organización los
 * valida cada RPC (`catalog.write` / `products.read`): el navegador nunca decide a qué organización pertenece algo.
 */

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export type FoldersResult = { ok: true; folders: FolderSummary[] } | { ok: false; error: string };

export async function loadFoldersAction(): Promise<FoldersResult> {
  try {
    await requireAdminContext();
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("get_signage_folders");
    if (error) return { ok: false, error: error.message };
    return { ok: true, folders: parseFolders(data) };
  } catch (error) {
    return { ok: false, error: message(error, "No se pudieron cargar las carpetas") };
  }
}

export interface SaveFolderInput {
  folderId: string | null;
  name: string;
  /** Los elementos EN ORDEN: promociones o productos sin promoción (sólo ids). */
  items: { kind: FolderItemKind; id: string }[];
  generateFeed: boolean;
  generateStory: boolean;
}

/** Crea una carpeta (`folderId` null) o la edita: renombra, cambia formatos y reemplaza sus elementos en el orden indicado. Una transacción. */
export async function saveFolderAction(input: SaveFolderInput): Promise<{ error?: string; folderId?: string }> {
  try {
    await requireAdminContext();
    // Los datos vienen del navegador: se validan como texto aunque los tipos digan otra cosa.
    const kinds: readonly string[] = ["PROMOTION", "PRODUCT"];
    if ((input.folderId !== null && !isUuid(input.folderId)) || !Array.isArray(input.items)
        || input.items.some((item) => !kinds.includes(item.kind) || !isUuid(item.id))) {
      return { error: "Datos inválidos" };
    }
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("save_signage_folder", {
      p_folder_id: nullableArg(input.folderId), p_name: input.name,
      p_items: input.items.map((item) => ({ kind: item.kind, id: item.id })),
      p_generate_feed: input.generateFeed, p_generate_story: input.generateStory
    });
    if (error) return { error: error.message };
    revalidatePath("/admin/products/artwork");
    revalidatePath("/admin/products/signage");
    const result = data as { id?: string } | null;
    return result?.id ? { folderId: result.id } : {};
  } catch (error) {
    return { error: message(error, "No se pudo guardar la carpeta") };
  }
}

/** Elimina una carpeta sólo si ninguna pantalla la usa (el servidor explica en cuáles está si no se puede). Nunca borra promociones ni productos. */
export async function deleteFolderAction(folderId: string): Promise<{ error?: string }> {
  try {
    await requireAdminContext();
    if (!isUuid(folderId)) return { error: "Carpeta inválida" };
    const supabase = await createClient();
    const { error } = await supabase.rpc("delete_signage_folder", { p_folder_id: folderId });
    if (error) return { error: error.message };
    revalidatePath("/admin/products/artwork");
    revalidatePath("/admin/products/signage");
    return {};
  } catch (error) {
    return { error: message(error, "No se pudo eliminar la carpeta") };
  }
}

export type FolderFactsResult =
  | { kind: "ok"; /** Hechos tal como los devuelve la base: el navegador los pasa por el MISMO motor de pricing que el servidor. */ raw: unknown; thumbnails: Record<string, string>; loadedAt: string }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

/**
 * Lo VIGENTE de una carpeta para una sucursal: precio, promoción, estado de cada elemento y foto (en UNA consulta; las miniaturas con
 * URLs firmadas de corta vida, en una sola llamada a Storage). Nada se cachea: cada apertura trae el estado de hoy.
 */
export async function loadFolderFactsAction(folderId: string, branchId: string | null): Promise<FolderFactsResult> {
  try {
    await requireAdminContext();
    if (!isUuid(folderId) || (branchId !== null && !isUuid(branchId))) return { kind: "not_found" };
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("get_signage_folder_facts", { p_folder_id: folderId, ...(branchId ? { p_branch_id: branchId } : {}) });
    if (error) return { kind: "error", message: error.message };
    if (data === null) return { kind: "not_found" };
    const facts = parseFolderFacts(data);
    if (!facts) return { kind: "not_found" };
    const paths = [...new Set(facts.items.flatMap((item) => item.photo ? [item.photo.storagePath] : []))];
    const thumbnails: Record<string, string> = {};
    if (paths.length) {
      const { data: signed } = await supabase.storage.from(ARTWORK_BUCKET).createSignedUrls(paths, SIGNED_URL_SECONDS);
      for (const entry of signed ?? []) if (entry.path && entry.signedUrl) thumbnails[entry.path] = entry.signedUrl;
    }
    return { kind: "ok", raw: data, thumbnails, loadedAt: new Date().toISOString() };
  } catch (error) {
    return { kind: "error", message: message(error, "No se pudo leer la carpeta") };
  }
}

/**
 * Registra si cada foto PNG tiene fondo transparente (un recorte) para que las piezas la aprovechen con una mancha detrás. Se calcula
 * una sola vez por foto, leyendo sus bytes reales, y queda guardado; las fotos subidas antes de este dato se completan la primera vez
 * que se necesitan. Devuelve `{ ruta: true|false }` de las que pudo analizar.
 */
export async function ensurePhotoAlphaAction(photos: { productId: string; storagePath: string }[]): Promise<{ result: Record<string, boolean>; error?: string }> {
  try {
    const context = await requireAdminContext();
    const list = Array.isArray(photos) ? photos.slice(0, 40) : [];
    const supabase = await createClient();
    const result: Record<string, boolean> = {};
    for (const photo of list) {
      if (!isUuid(photo.productId) || !isValidPhotoPath(photo.storagePath, context.organizationId, photo.productId) || !photo.storagePath.endsWith(".png")) continue;
      const alpha = await recordPhotoAlpha(supabase, photo.productId, photo.storagePath);
      if (alpha !== null) result[photo.storagePath] = alpha;
    }
    return { result };
  } catch (error) {
    return { result: {}, error: message(error, "No se pudo analizar la foto") };
  }
}
