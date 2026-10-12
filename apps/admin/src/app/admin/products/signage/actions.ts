"use server";

import { revalidatePath } from "next/cache";

import { requireAdminContext } from "../../../../lib/admin";
import { nullableArg } from "../../../../lib/rpc-args";
import { buildSignageView, clampSlideSeconds } from "../../../../lib/signage";
import { parsePromotionCatalog, type PromotionCatalog } from "../../../../lib/signage-promotions";
import { signageMediaUrls } from "../../../../lib/signage-media";
import type { SignageLoadResult } from "../../../../lib/signage-player";
import { createClient } from "../../../../lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export interface SignageTokenResult { error?: string; displayId?: string; token?: string }

/** Crea una pantalla. El token en claro vuelve UNA sola vez en esta respuesta: la base sólo guarda su hash. */
export async function createSignageDisplayAction(input: { name: string; branchId: string | null }): Promise<SignageTokenResult> {
  try {
    await requireAdminContext();
    if (input.branchId !== null && !UUID.test(input.branchId)) return { error: "Sucursal inválida" };
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("create_signage_display", { p_name: input.name, p_branch_id: input.branchId });
    if (error) return { error: error.message };
    const result = data as { id?: string; token?: string } | null;
    if (!result?.id || !result.token) return { error: "No se pudo crear la pantalla" };
    revalidatePath("/admin/products/signage");
    return { displayId: result.id, token: result.token };
  } catch (error) {
    return { error: message(error, "No se pudo crear la pantalla") };
  }
}

export interface SaveSourceInput {
  displayId: string;
  name: string;
  branchId: string | null;
  slideDurationSeconds: number;
  enabled: boolean;
  /** «Todas las promociones activas» (por defecto) o una carpeta. La lista armada a mano ya no se puede elegir. */
  source: "ALL_PROMOTIONS" | "FOLDER";
  folderId: string | null;
}

/**
 * Configura una pantalla (D-086): nombre, sucursal, duración, activa y FUENTE de contenido. No hay lista que armar: con «todas las
 * promociones activas» la TV reproduce lo que está vigente y le aplica a su sucursal; con una carpeta, lo vigente de esa carpeta. La
 * vigencia, la sucursal y el precio los resuelve la base en cada consulta del televisor. El TV lo toma en su próxima consulta (≤ 30 s).
 */
export async function saveSignageSourceAction(input: SaveSourceInput): Promise<{ error?: string }> {
  try {
    await requireAdminContext();
    const source: string = input.source;
    if (!UUID.test(input.displayId) || (input.branchId !== null && !UUID.test(input.branchId)) || (source !== "ALL_PROMOTIONS" && source !== "FOLDER")
        || (source === "FOLDER") !== (input.folderId !== null) || (input.folderId !== null && !UUID.test(input.folderId))) {
      return { error: "Datos inválidos" };
    }
    const supabase = await createClient();
    const { error } = await supabase.rpc("save_signage_display_source", {
      p_display_id: input.displayId, p_name: input.name, p_branch_id: nullableArg(input.branchId),
      p_slide_duration_seconds: clampSlideSeconds(input.slideDurationSeconds), p_enabled: input.enabled,
      p_content_source: input.source, ...(input.folderId ? { p_folder_id: input.folderId } : {})
    });
    if (error) return { error: error.message };
    revalidatePath("/admin/products/signage");
    return {};
  } catch (error) {
    return { error: message(error, "No se pudo guardar la pantalla") };
  }
}

export type PromotionCatalogResult = { ok: true; catalog: PromotionCatalog } | { ok: false; error: string };

/**
 * Las promociones ya cargadas en Promociones (activas, próximas y vencidas recientes) y los grupos, para elegir qué reproduce una pantalla.
 * `branchId` es la sucursal de la pantalla (sólo se ofrece lo que le aplica; null = pantalla global); `applicableOnly = false` trae todas
 * (administración de grupos). Las reglas de sucursal, vigencia y organización las resuelve la RPC; acá no se filtra nada por nombre.
 */
export async function loadPromotionCatalogAction(branchId: string | null, applicableOnly: boolean): Promise<PromotionCatalogResult> {
  try {
    await requireAdminContext();
    if (branchId !== null && !UUID.test(branchId)) return { ok: false, error: "Sucursal inválida" };
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("get_signage_promotion_catalog", { p_branch_id: branchId, p_applicable_only: applicableOnly });
    if (error) return { ok: false, error: error.message };
    return { ok: true, catalog: parsePromotionCatalog(data) };
  } catch (error) {
    return { ok: false, error: message(error, "No se pudieron cargar las promociones") };
  }
}

/** Invalida el enlace anterior y devuelve el nuevo token (una sola vez). */
export async function regenerateSignageTokenAction(displayId: string): Promise<SignageTokenResult> {
  try {
    await requireAdminContext();
    if (!UUID.test(displayId)) return { error: "Pantalla inválida" };
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("regenerate_signage_token", { p_display_id: displayId });
    if (error) return { error: error.message };
    const result = data as { id?: string; token?: string } | null;
    if (!result?.token) return { error: "No se pudo regenerar el enlace" };
    revalidatePath("/admin/products/signage");
    return { displayId, token: result.token };
  } catch (error) {
    return { error: message(error, "No se pudo regenerar el enlace") };
  }
}

/** Fuente de datos de la vista previa del Admin (mismo reproductor que el TV; se identifica con la sesión, no con el token). */
export async function loadSignagePreviewAction(displayId: string): Promise<SignageLoadResult> {
  try {
    await requireAdminContext();
    if (!UUID.test(displayId)) return { kind: "not_found" };
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("get_signage_display_admin", { p_display_id: displayId });
    if (error) return { kind: "error" };
    const view = data === null ? null : buildSignageView(data, signageMediaUrls(`/api/tv-preview/${displayId}`));
    return view ? { kind: "ok", view } : { kind: "not_found" };
  } catch {
    return { kind: "error" };
  }
}
