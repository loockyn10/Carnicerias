"use server";

import { revalidatePath } from "next/cache";

import { requireAdminContext } from "../../../../lib/admin";
import { buildSignageView, clampSlideSeconds, type EntryKind } from "../../../../lib/signage";
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

export interface SignageEntryInput { kind: EntryKind; id: string }

export interface SaveSignageInput {
  displayId: string;
  name: string;
  branchId: string | null;
  slideDurationSeconds: number;
  enabled: boolean;
  /** La lista ordenada de la pantalla: productos, promociones y grupos de promociones (D-084). */
  entries: SignageEntryInput[];
}

const ENTRY_KINDS: readonly EntryKind[] = ["PRODUCT", "PROMOTION", "GROUP"];

/** «Guardar / Publicar»: configuración + lista ordenada de entradas en una sola transacción. El TV lo toma en su próxima consulta. */
export async function saveSignageDisplayAction(input: SaveSignageInput): Promise<{ error?: string }> {
  try {
    await requireAdminContext();
    if (!UUID.test(input.displayId) || (input.branchId !== null && !UUID.test(input.branchId))
        || input.entries.some((entry) => !ENTRY_KINDS.includes(entry.kind) || !UUID.test(entry.id))) {
      return { error: "Datos inválidos" };
    }
    const supabase = await createClient();
    const { error } = await supabase.rpc("save_signage_display_entries", {
      p_display_id: input.displayId, p_name: input.name, p_branch_id: input.branchId,
      p_slide_duration_seconds: clampSlideSeconds(input.slideDurationSeconds), p_enabled: input.enabled,
      p_entries: input.entries.map((entry) => ({ kind: entry.kind, id: entry.id }))
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

export interface SaveGroupInput { groupId: string | null; name: string; promotionIds: string[] }

/** Crea un grupo (`groupId` null) o lo edita: renombra y reemplaza sus promociones, en el orden indicado. Una sola transacción. */
export async function saveSignageGroupAction(input: SaveGroupInput): Promise<{ error?: string; groupId?: string }> {
  try {
    await requireAdminContext();
    if ((input.groupId !== null && !UUID.test(input.groupId)) || input.promotionIds.some((id) => !UUID.test(id))) return { error: "Datos inválidos" };
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("save_signage_group", { p_group_id: input.groupId, p_name: input.name, p_promotion_ids: input.promotionIds });
    if (error) return { error: error.message };
    revalidatePath("/admin/products/signage");
    const result = data as { id?: string } | null;
    return result?.id ? { groupId: result.id } : {};
  } catch (error) {
    return { error: message(error, "No se pudo guardar el grupo") };
  }
}

/** Elimina un grupo sólo si ninguna pantalla lo usa (el servidor explica en cuáles está si no se puede). */
export async function deleteSignageGroupAction(groupId: string): Promise<{ error?: string }> {
  try {
    await requireAdminContext();
    if (!UUID.test(groupId)) return { error: "Grupo inválido" };
    const supabase = await createClient();
    const { error } = await supabase.rpc("delete_signage_group", { p_group_id: groupId });
    if (error) return { error: error.message };
    revalidatePath("/admin/products/signage");
    return {};
  } catch (error) {
    return { error: message(error, "No se pudo eliminar el grupo") };
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
