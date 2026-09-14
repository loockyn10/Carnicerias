"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "../../lib/supabase/server";
import { requireAdminContext } from "../../lib/admin";
import { parsePesosToCents } from "../../lib/settlements";
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

function kilogramsToGrams(value: string, allowZero = false) {
  const match = /^(\d+)(?:[,.](\d{1,3}))?$/.exec(value.trim());
  if (!match) throw new Error("Peso inválido");
  const grams = BigInt(match[1] ?? "") * 1_000n + BigInt((match[2] ?? "").padEnd(3, "0"));
  if (grams < 0n || (!allowZero && grams === 0n) || grams > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Peso inválido");
  return Number(grams);
}

function unitsToInteger(value: string) {
  if (!/^\d+$/.test(value.trim())) throw new Error("Cantidad de unidades inválida");
  const units = BigInt(value.trim());
  if (units <= 0n || units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Cantidad de unidades inválida");
  return Number(units);
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

function percentageToBasisPointsAllowZero(value: string, label: string, maximumBps: bigint) {
  const match = /^(\d+)(?:[,.](\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error(`${label} inválido`);
  const basisPoints = BigInt(match[1] ?? "") * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (basisPoints < 0n || basisPoints > maximumBps) throw new Error(`${label} fuera del rango permitido`);
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
    p_active: formData.get("active") === "on",
    p_color_hex: text(formData, "color_hex") || null
  });
  revalidatePath("/admin/catalog");
  revalidatePath("/admin/products");
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
  revalidatePath("/admin/products");
}

export interface ProductManageState { error?: string; successToken?: string }

export async function manageProductAction(_: ProductManageState, formData: FormData): Promise<ProductManageState> {
  try {
    const name = text(formData, "name");
    const rawCost = text(formData, "cost");
    const rawProfit = text(formData, "profit_markup");
    if (Boolean(rawCost) !== Boolean(rawProfit)) throw new Error("Completá costo y margen de ganancia para activar el precio automático");
    await rpcOrThrow("save_product", {
      p_product_id: text(formData, "product_id"), p_category_id: text(formData, "category_id"),
      p_name: name, p_slug: text(formData, "slug") || slugify(name), p_sku: text(formData, "sku"),
      p_unit_type: text(formData, "unit_type") as "WEIGHT" | "UNIT",
      p_active: formData.get("active") === "on"
    });

    if (rawCost && rawProfit) {
      const costCents = pesosToCents(rawCost);
      const profitMarkupBps = percentageToBasisPointsAllowZero(rawProfit, "Margen de ganancia", 100_000n);
      if (costCents !== Number(text(formData, "current_cost_cents") || 0) || profitMarkupBps !== Number(text(formData, "current_profit_markup_bps") || -1)) {
        await rpcOrThrow("save_product_pricing", {
          p_product_id: text(formData, "product_id"), p_cost_cents: costCents, p_profit_markup_bps: profitMarkupBps
        });
      }
    }

    revalidatePath("/admin/catalog");
    revalidatePath("/admin/products");
    revalidatePath("/admin/promotions");
    return { successToken: crypto.randomUUID() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo guardar el producto" };
  }
}

export interface ProductModalState { error?: string; success?: boolean }

export async function createProductModalAction(_: ProductModalState, formData: FormData): Promise<ProductModalState> {
  try {
    const name = text(formData, "name");
    const rawCost = text(formData, "cost");
    const rawProfit = text(formData, "profit_markup");
    if (!rawCost || !rawProfit) throw new Error("Completá costo y margen de ganancia");
    await rpcOrThrow("create_product_with_pricing", {
      p_category_id: text(formData, "category_id"), p_name: name,
      p_slug: text(formData, "slug") || slugify(name), p_sku: text(formData, "sku"),
      p_unit_type: text(formData, "unit_type") as "WEIGHT" | "UNIT", p_active: formData.get("active") === "on",
      p_cost_cents: pesosToCents(rawCost),
      p_profit_markup_bps: percentageToBasisPointsAllowZero(rawProfit, "Margen de ganancia", 100_000n)
    });
    revalidatePath("/admin/products");
    revalidatePath("/admin/catalog");
    revalidatePath("/admin/promotions");
    return { success: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo crear el producto" };
  }
}

export interface PricingSettingsState { error?: string; successToken?: string }
export async function saveCashDiscountAction(_: PricingSettingsState, formData: FormData): Promise<PricingSettingsState> {
  try {
    await rpcOrThrow("set_cash_discount_and_reprice", {
      p_cash_discount_bps: percentageToBasisPointsAllowZero(text(formData, "cash_discount"), "Descuento en efectivo", 9_999n),
      p_confirm: true
    });
    revalidatePath("/admin/products");
    return { successToken: crypto.randomUUID() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo actualizar la configuración" };
  }
}

export async function setPriceAction(formData: FormData) {
  const closeOverride = formData.get("close_override") === "on";
  await rpcOrThrow("set_product_price", {
    p_product_id: text(formData, "product_id"), p_branch_id: optionalId(formData, "branch_id"),
    p_price_cents: closeOverride ? null : pesosToCents(text(formData, "price")),
    p_effective_at: text(formData, "effective_at") ? new Date(text(formData, "effective_at")).toISOString() : new Date().toISOString()
  });
  revalidatePath("/admin/catalog");
  revalidatePath("/admin/products");
}

async function commercialRpc(name: string, args: Record<string, unknown>) {
  await requireAdminContext();
  const supabase = await createClient();
  const client = supabase as unknown as { rpc: (rpcName: string, rpcArgs: Record<string, unknown>) => Promise<{ error: { message: string } | null }> };
  const { error } = await client.rpc(name, args);
  if (error) throw new Error(error.message);
}

async function saveWeightDiscount(formData: FormData) {
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
  revalidatePath("/admin/promotions");
  revalidatePath("/admin/products");
}

export async function saveWeightDiscountAction(formData: FormData) {
  await saveWeightDiscount(formData);
}

export interface PromotionFormState { error?: string; successToken?: string }

export async function saveWeightDiscountFormAction(_: PromotionFormState, formData: FormData): Promise<PromotionFormState> {
  try {
    await saveWeightDiscount(formData);
    return { successToken: crypto.randomUUID() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo guardar la promoción" };
  }
}

export async function saveAnnouncementAction(formData: FormData) {
  await commercialRpc("save_announcement", {
    p_id: optionalId(formData, "announcement_id"), p_branch_id: optionalId(formData, "branch_id"), p_title: text(formData, "title"), p_message: text(formData, "message"),
    p_type: text(formData, "type"), p_priority: Number(text(formData, "priority") || 0), p_active: formData.get("active") === "on",
    p_starts_at: text(formData, "starts_at") ? new Date(text(formData, "starts_at")).toISOString() : new Date().toISOString(), p_ends_at: text(formData, "ends_at") ? new Date(text(formData, "ends_at")).toISOString() : null
  });
  revalidatePath("/admin/catalog");
  revalidatePath("/admin/announcements");
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

export interface ReplenishmentFormState { error?: string; successToken?: string }

export async function recordReplenishmentFormAction(_: ReplenishmentFormState, formData: FormData): Promise<ReplenishmentFormState> {
  try {
    const context = await requireAdminContext();
    const supabase = await createClient();
    const productId = text(formData, "product_id");
    const { data: product, error: productError } = await supabase.from("products")
      .select("unit_type").eq("organization_id", context.organizationId).eq("id", productId).single();
    if (productError) throw new Error("Producto inválido para esta organización");
    const quantity = product.unit_type === "UNIT"
      ? unitsToInteger(text(formData, "quantity"))
      : kilogramsToGrams(text(formData, "quantity"));
    const { error } = await supabase.rpc("record_stock_operation", {
      p_branch_id: text(formData, "branch_id"), p_operation_type: "PURCHASE",
      p_items: [{ product_id: productId, quantity_grams: quantity }],
      p_supplier: null, p_note: text(formData, "note") || "Ingreso desde reposición"
    });
    if (error) throw new Error(error.message);
    revalidatePath("/admin/replenishment");
    revalidatePath("/admin/stock");
    return { successToken: crypto.randomUUID() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo registrar el ingreso" };
  }
}

export async function setReplenishmentTargetDaysFormAction(_: ReplenishmentFormState, formData: FormData): Promise<ReplenishmentFormState> {
  try {
    const targetDays = decimal(text(formData, "target_days"), "Objetivo de cobertura");
    if (targetDays <= 0 || targetDays > 30) throw new Error("El objetivo debe estar entre 0,01 y 30 días");
    await rpcOrThrow("set_replenishment_target_days", { p_target_days: targetDays });
    revalidatePath("/admin/replenishment");
    return { successToken: crypto.randomUUID() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo guardar el objetivo" };
  }
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
    p_items: [{ product_id: text(formData, "product_id"), physical_quantity_grams: kilogramsToGrams(text(formData, "physical_kg"), true) }],
    p_note: text(formData, "note") || null
  });
  revalidatePath("/admin/stock");
}

export interface StockAdjustmentState { error?: string; successToken?: string }

export async function recordAdjustmentFormAction(_: StockAdjustmentState, formData: FormData): Promise<StockAdjustmentState> {
  try {
    await recordAdjustmentAction(formData);
    return { successToken: crypto.randomUUID() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo registrar el ajuste" };
  }
}

export async function manageMemberAction(formData: FormData) {
  await rpcOrThrow("manage_existing_member", {
    p_email: text(formData, "email"), p_display_name: text(formData, "display_name"),
    p_role_key: text(formData, "role_key"), p_branch_id: optionalId(formData, "branch_id"),
    p_status: text(formData, "status") as "INVITED" | "ACTIVE" | "DISABLED"
  });
  revalidatePath("/admin/employees");
}

export async function setEmployeePinAction(formData: FormData) {
  const pin = text(formData, "pin");
  if (!/^\d{4,6}$/.test(pin)) throw new Error("El PIN debe tener entre 4 y 6 dígitos");
  await rpcOrThrow("set_employee_pos_pin", { p_profile_id: text(formData, "profile_id"), p_pin: pin });
  revalidatePath("/admin/employees");
}

export async function setHourlyRateAction(formData: FormData) {
  await rpcOrThrow("set_employee_hourly_rate", {
    p_employee_id: text(formData, "employee_id"),
    p_rate_cents_per_hour: pesosToCents(text(formData, "rate")),
    p_valid_from_local: text(formData, "valid_from")
  });
  revalidatePath("/admin/timekeeping");
  revalidatePath("/admin/employees");
}

export async function correctShiftAction(formData: FormData) {
  await rpcOrThrow("correct_employee_shift", {
    p_shift_id: text(formData, "shift_id"),
    p_clock_out_local: text(formData, "clock_out_at"),
    p_reason: text(formData, "reason")
  });
  revalidatePath("/admin/timekeeping");
}

export async function setMaxShiftHoursAction(formData: FormData) {
  const hours = Number(text(formData, "hours"));
  if (!Number.isInteger(hours) || hours < 1 || hours > 24) throw new Error("La duración debe estar entre 1 y 24 horas");
  await rpcOrThrow("set_timekeeping_max_shift_hours", { p_hours: hours });
  revalidatePath("/admin/timekeeping");
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

export interface SettlementFormState { error?: string; settlementId?: string }

export async function confirmSettlementFormAction(_: SettlementFormState, formData: FormData): Promise<SettlementFormState> {
  try {
    const settlementId = await rpcOrThrow("confirm_settlement", {
      p_branch_id: text(formData, "branch_id"),
      p_period_start_local: text(formData, "period_start"),
      p_period_end_local: text(formData, "period_end"),
      p_received_cash_cents: parsePesosToCents(text(formData, "received_cash")),
      p_notes: text(formData, "notes") || null
    });
    revalidatePath("/admin/settlements");
    revalidatePath("/admin/audit");
    return { settlementId };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo confirmar la rendición" };
  }
}

export async function voidSettlementFormAction(_: SettlementFormState, formData: FormData): Promise<SettlementFormState> {
  try {
    const settlementId = text(formData, "settlement_id");
    await rpcOrThrow("void_settlement", { p_settlement_id: settlementId, p_reason: text(formData, "reason") });
    revalidatePath("/admin/settlements");
    revalidatePath("/admin/audit");
    return { settlementId };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo anular la rendición" };
  }
}
