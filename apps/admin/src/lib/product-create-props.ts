import type { ComponentProps } from "react";

import type { ProductCreateModal } from "../components/product-create-modal";
import { fetchAllRows } from "./fetch-all";
import type { createClient } from "./supabase/server";

export type ProductCreateProps = Pick<ComponentProps<typeof ProductCreateModal>, "categories" | "branches" | "suppliers" | "marginBps" | "excludedCategoryIds" | "productionBranchId">;

/**
 * Datos que necesita el alta de producto general (`ProductCreateModal`) para usarla desde otra pantalla (Pollos → Agregar producto → Crear producto
 * nuevo): mismas lecturas que Productos, así el alta es EXACTAMENTE la misma (mismo formulario, misma acción, mismas reglas de precio).
 */
export async function loadProductCreateProps(supabase: Awaited<ReturnType<typeof createClient>>, organizationId: string): Promise<ProductCreateProps> {
  const [categories, branches, pricing, excluded, organization, suppliers] = await Promise.all([
    supabase.from("categories").select("id, name, active").eq("organization_id", organizationId).order("sort_order"),
    supabase.from("branches").select("id, name").eq("organization_id", organizationId).eq("active", true).order("name"),
    supabase.from("organization_pricing_settings").select("margin_bps").eq("organization_id", organizationId).maybeSingle(),
    supabase.from("organization_pricing_excluded_categories").select("category_id").eq("organization_id", organizationId),
    supabase.from("organizations").select("production_branch_id").eq("id", organizationId).maybeSingle(),
    fetchAllRows((from, to) => supabase.from("suppliers").select("id, name, code, active").eq("organization_id", organizationId).order("name", { ascending: true }).order("id", { ascending: true }).range(from, to))
  ]);
  return {
    categories: (categories.data ?? []).filter((category) => category.active).map((category) => ({ id: category.id, name: category.name })),
    branches: branches.data ?? [],
    suppliers: suppliers.data,
    marginBps: pricing.data?.margin_bps ?? null,
    excludedCategoryIds: (excluded.data ?? []).map((row) => row.category_id),
    productionBranchId: organization.data?.production_branch_id ?? null
  };
}
