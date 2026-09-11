"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "../../lib/supabase/server";
import { requireAdminContext } from "../../lib/admin";
import type { Database } from "@carnicerias/database";

function text(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function optionalId(formData: FormData, key: string) {
  return text(formData, key) || null;
}

function decimal(value: string, label: string) {
  const parsed = Number(value.replace(",", "."));
  if (!Number.isFinite(parsed)) throw new Error(`${label} inválido`);
  return parsed;
}

function kilogramsToGrams(value: string) {
  const match = /^(\d+)(?:[,.](\d{1,3}))?$/.exec(value.trim());
  if (!match) throw new Error("Peso inválido");
  const grams = BigInt(match[1] ?? "") * 1_000n + BigInt((match[2] ?? "").padEnd(3, "0"));
  if (grams <= 0n || grams > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Peso inválido");
  return Number(grams);
}

function pesosToCents(value: string) {
  const match = /^(\d+)(?:[,.](\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error("Precio inválido");
  const cents = BigInt(match[1] ?? "") * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (cents <= 0n || cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Precio inválido");
  return Number(cents);
}

function percentageToBasisPoints(value: string) {
  const match = /^(\d+)(?:[,.](\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error("Descuento inválido");
  const basisPoints = BigInt(match[1] ?? "") * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (basisPoints <= 0n || basisPoints > 10_000n) throw new Error("El descuento debe estar entre 0,01% y 100%");
  return Number(basisPoints);
}

function slugify(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function rpcOrThrow<Name extends keyof Database["public"]["Functions"]>(
  name: Name,
  args: Database["public"]["Functions"][Name]["Args"]
) {
  await requireAdminContext();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}

export async function saveCategoryAction(formData: FormData) {
  const name = text(formData, "name");
  await rpcOrThrow("save_category", {
    p_category_id: optionalId(formData, "category_id"), p_name: name,
    p_slug: text(formData, "slug") || slugify(name),
    p_sort_order: Number(text(formData, "sort_order") || 0),
    p_active: formData.get("active") === "on"
  });
  revalidatePath("/admin/catalog");
}

export async function saveProductAction(formData: FormData) {
  const name = text(formData, "name");
  await rpcOrThrow("save_product", {
    p_product_id: optionalId(formData, "product_id"), p_category_id: text(formData, "category_id"),
    p_name: name, p_slug: text(formData, "slug") || slugify(name), p_sku: text(formData, "sku"),
    p_unit_type: text(formData, "unit_type") as "WEIGHT" | "UNIT",
    p_active: formData.get("active") === "on"
  });
  revalidatePath("/admin/catalog");
}

export async function setPriceAction(formData: FormData) {
  const closeOverride = formData.get("close_override") === "on";
  await rpcOrThrow("set_product_price", {
    p_product_id: text(formData, "product_id"), p_branch_id: optionalId(formData, "branch_id"),
    p_price_cents: closeOverride ? null : pesosToCents(text(formData, "price")),
    p_effective_at: text(formData, "effective_at") ? new Date(text(formData, "effective_at")).toISOString() : new Date().toISOString()
  });
  revalidatePath("/admin/catalog");
}

async function commercialRpc(name: string, args: Record<string, unknown>) {
  await requireAdminContext();
  const supabase = await createClient();
  const client = supabase as unknown as { rpc: (rpcName: string, rpcArgs: Record<string, unknown>) => Promise<{ error: { message: string } | null }> };
  const { error } = await client.rpc(name, args);
  if (error) throw new Error(error.message);
}

export async function saveWeightDiscountAction(formData: FormData) {
  try {
    const discountType = text(formData, "discount_type");
    if (discountType !== "PERCENTAGE" && discountType !== "FIXED_PRICE_PER_KG") throw new Error("Tipo de descuento inválido");
    await commercialRpc("save_weight_discount", {
      p_id: optionalId(formData, "discount_id"), p_product_id: text(formData, "product_id"), p_branch_id: optionalId(formData, "branch_id"),
      p_minimum_grams: kilogramsToGrams(text(formData, "minimum_kg")), p_discount_type: discountType,
      p_discount_value: discountType === "PERCENTAGE" ? percentageToBasisPoints(text(formData, "discount_value")) : pesosToCents(text(formData, "discount_value")),
      p_active: formData.get("active") === "on", p_valid_from: text(formData, "valid_from") ? new Date(text(formData, "valid_from")).toISOString() : new Date().toISOString(),
      p_valid_until: text(formData, "valid_until") ? new Date(text(formData, "valid_until")).toISOString() : null
    });
    revalidatePath("/admin/catalog");
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo guardar el descuento";
    redirect(`/admin/catalog?discount_error=${encodeURIComponent(message)}`);
  }
}

export async function saveAnnouncementAction(formData: FormData) {
  await commercialRpc("save_announcement", {
    p_id: optionalId(formData, "announcement_id"), p_branch_id: optionalId(formData, "branch_id"), p_title: text(formData, "title"), p_message: text(formData, "message"),
    p_type: text(formData, "type"), p_priority: Number(text(formData, "priority") || 0), p_active: formData.get("active") === "on",
    p_starts_at: text(formData, "starts_at") ? new Date(text(formData, "starts_at")).toISOString() : new Date().toISOString(), p_ends_at: text(formData, "ends_at") ? new Date(text(formData, "ends_at")).toISOString() : null
  });
  revalidatePath("/admin/catalog");
}

export async function setStockPolicyAction(formData: FormData) {
  await rpcOrThrow("set_stock_policy", {
    p_branch_id: text(formData, "branch_id"), p_product_id: text(formData, "product_id"),
    p_minimum_stock_grams: kilogramsToGrams(text(formData, "minimum_kg")),
    p_target_stock_grams: kilogramsToGrams(text(formData, "target_kg"))
  });
  revalidatePath("/admin/stock");
}

export async function recordPurchaseAction(formData: FormData) {
  const productIds = formData.getAll("product_id").map(String);
  const items = productIds.flatMap((productId) => {
    const raw = text(formData, `quantity_${productId}`);
    return raw && decimal(raw, "Peso") > 0 ? [{ product_id: productId, quantity_grams: kilogramsToGrams(raw) }] : [];
  });
  await rpcOrThrow("record_stock_operation", {
    p_branch_id: text(formData, "branch_id"), p_operation_type: "PURCHASE", p_items: items,
    p_supplier: text(formData, "supplier"), p_note: text(formData, "note") || null
  });
  revalidatePath("/admin/stock");
}

export async function recordWasteAction(formData: FormData) {
  await rpcOrThrow("record_stock_operation", {
    p_branch_id: text(formData, "branch_id"), p_operation_type: "WASTE",
    p_items: [{ product_id: text(formData, "product_id"), quantity_grams: kilogramsToGrams(text(formData, "quantity_kg")) }],
    p_waste_reason: text(formData, "waste_reason"), p_note: text(formData, "note") || null
  });
  revalidatePath("/admin/stock");
}

export async function recordAdjustmentAction(formData: FormData) {
  await rpcOrThrow("record_stock_operation", {
    p_branch_id: text(formData, "branch_id"), p_operation_type: "ADJUSTMENT",
    p_items: [{ product_id: text(formData, "product_id"), physical_quantity_grams: kilogramsToGrams(text(formData, "physical_kg")) }],
    p_note: text(formData, "note") || null
  });
  revalidatePath("/admin/stock");
}

export async function manageMemberAction(formData: FormData) {
  await rpcOrThrow("manage_existing_member", {
    p_email: text(formData, "email"), p_display_name: text(formData, "display_name"),
    p_role_key: text(formData, "role_key"), p_branch_id: optionalId(formData, "branch_id"),
    p_status: text(formData, "status") as "INVITED" | "ACTIVE" | "DISABLED"
  });
  revalidatePath("/admin/employees");
}

export async function setDeviceStatusAction(formData: FormData) {
  await rpcOrThrow("set_pos_device_status", {
    p_device_id: text(formData, "device_id"),
    p_status: text(formData, "status") as "ACTIVE" | "DISABLED"
  });
  revalidatePath("/admin/devices");
}

export async function cancelSaleAction(formData: FormData) {
  await rpcOrThrow("cancel_sale", {
    p_sale_id: text(formData, "sale_id"), p_idempotency_key: text(formData, "idempotency_key"),
    p_reason: text(formData, "reason")
  });
  revalidatePath("/admin/sales");
  revalidatePath("/admin");
}
