"use server";

import { revalidatePath } from "next/cache";

import { requireAdminContext } from "../../../../lib/admin";
import { buildSignageView, clampSlideSeconds } from "../../../../lib/signage";
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

export interface SaveSignageInput {
  displayId: string;
  name: string;
  branchId: string | null;
  slideDurationSeconds: number;
  enabled: boolean;
  productIds: string[];
}

/** «Guardar / Publicar»: configuración + lista ordenada de productos en una sola transacción. El TV lo toma en su próxima consulta. */
export async function saveSignageDisplayAction(input: SaveSignageInput): Promise<{ error?: string }> {
  try {
    await requireAdminContext();
    if (!UUID.test(input.displayId) || input.productIds.some((id) => !UUID.test(id)) || (input.branchId !== null && !UUID.test(input.branchId))) {
      return { error: "Datos inválidos" };
    }
    const supabase = await createClient();
    const { error } = await supabase.rpc("save_signage_display", {
      p_display_id: input.displayId, p_name: input.name, p_branch_id: input.branchId,
      p_slide_duration_seconds: clampSlideSeconds(input.slideDurationSeconds), p_enabled: input.enabled, p_product_ids: input.productIds
    });
    if (error) return { error: error.message };
    revalidatePath("/admin/products/signage");
    return {};
  } catch (error) {
    return { error: message(error, "No se pudo guardar la pantalla") };
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
