"use server";

import { revalidatePath } from "next/cache";

import { requireAdminContext } from "../../../../lib/admin";
import { isUuid } from "../../../../lib/uuid";
import { createClient } from "../../../../lib/supabase/server";

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export interface SaveLabelGroupInput {
  /** null = crear un grupo nuevo. */
  groupId: string | null;
  name: string;
  /** null = sin sucursal (precio global de la organización). */
  branchId: string | null;
  active: boolean;
}

/** Crea o edita un grupo de etiquetas. La organización, el permiso y la sucursal los valida la RPC. */
export async function saveLabelGroupAction(input: SaveLabelGroupInput): Promise<{ error?: string; groupId?: string }> {
  try {
    await requireAdminContext();
    if ((input.groupId !== null && !isUuid(input.groupId)) || (input.branchId !== null && !isUuid(input.branchId))) return { error: "Datos inválidos" };
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("save_label_group", {
      p_group_id: input.groupId, p_name: input.name, p_branch_id: input.branchId, p_active: input.active
    });
    if (error) return { error: error.message };
    const id = (data as { id?: string } | null)?.id;
    revalidatePath("/admin/products/labels");
    return id ? { groupId: id } : { error: "No se pudo guardar el grupo" };
  } catch (error) {
    return { error: message(error, "No se pudo guardar el grupo") };
  }
}

/** Agrega y/o quita productos del grupo EN LOTE (una sola llamada, una sola transacción). */
export async function setLabelGroupProductsAction(input: { groupId: string; add: string[]; remove: string[] }): Promise<{ error?: string; added?: number; removed?: number }> {
  try {
    await requireAdminContext();
    if (!isUuid(input.groupId) || input.add.some((id) => !isUuid(id)) || input.remove.some((id) => !isUuid(id))) return { error: "Datos inválidos" };
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("set_label_group_products", {
      p_group_id: input.groupId, p_add: input.add, p_remove: input.remove
    });
    if (error) return { error: error.message };
    const result = data as { added?: number; removed?: number } | null;
    revalidatePath("/admin/products/labels");
    return { added: result?.added ?? 0, removed: result?.removed ?? 0 };
  } catch (error) {
    return { error: message(error, "No se pudieron actualizar los productos del grupo") };
  }
}

export interface LabelProductOption {
  productId: string;
  name: string;
  sku: string | null;
  unitType: "UNIT" | "WEIGHT";
  /** true = ya es parte activa del grupo. */
  inGroup: boolean;
}

/** Busca productos por nombre/SKU/código de barras para agregar al grupo (si el grupo tiene sucursal, sólo los que esa sucursal vende). */
export async function searchLabelProductsAction(input: { groupId: string; query: string }): Promise<{ error?: string; options?: LabelProductOption[] }> {
  try {
    const context = await requireAdminContext();
    if (!isUuid(input.groupId)) return { error: "Grupo inválido" };
    const supabase = await createClient();
    const [groupResult, itemsResult] = await Promise.all([
      supabase.from("product_label_groups").select("branch_id").eq("organization_id", context.organizationId).eq("id", input.groupId).maybeSingle(),
      supabase.from("product_label_group_items").select("product_id").eq("organization_id", context.organizationId).eq("group_id", input.groupId).eq("active", true)
    ]);
    if (groupResult.error) return { error: groupResult.error.message };
    if (itemsResult.error) return { error: itemsResult.error.message };
    if (!groupResult.data) return { error: "El grupo no existe" };
    const branchId = groupResult.data.branch_id;
    const { data, error } = await supabase.rpc("search_products", {
      p_query: input.query.trim().slice(0, 80), p_limit: 50, p_active_only: true, ...(branchId ? { p_branch_id: branchId } : {})
    });
    if (error) return { error: error.message };
    const inGroup = new Set(itemsResult.data.map((row) => row.product_id));
    return { options: data.map((row) => ({ productId: row.product_id, name: row.product_name, sku: row.sku, unitType: row.unit_type, inGroup: inGroup.has(row.product_id) })) };
  } catch (error) {
    return { error: message(error, "No se pudo buscar") };
  }
}
