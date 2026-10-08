"use server";

import { revalidatePath } from "next/cache";

import { requireAdminContext } from "../../../../lib/admin";
import { ARTWORK_UNAVAILABLE_LABELS, parseArtworkFacts, type ArtworkFacts } from "../../../../lib/artwork";
import { parseArtworkBrandingFacts, type ArtworkBrandingFacts } from "../../../../lib/artwork-branding";
import {
  ARTWORK_BUCKET, buildLogoPath, buildPhotoPath, isValidLogoPath, isValidPhotoPath, SIGNED_URL_SECONDS, type StoredPhotoType
} from "../../../../lib/artwork-photo";
import { COLLAGE_MAX_ITEMS, COLLAGE_MIN_ITEMS } from "../../../../lib/artwork-tokens";
import { readImageInfo } from "../../../../lib/image-size";
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

type LoadedEntry = Extract<ArtworkLoadResult, { kind: "ok" }>;

/** Hechos de UN producto para una sucursal (precio vigente + promoción + foto con URL firmada de corta vida). */
async function loadEntry(supabase: Supabase, productId: string, branchId: string | null): Promise<ArtworkLoadResult> {
  const { data, error } = await supabase.rpc("get_product_artwork", { p_product_id: productId, ...(branchId ? { p_branch_id: branchId } : {}) });
  if (error) return { kind: "error", message: error.message };
  const facts = data === null ? null : parseArtworkFacts(data);
  if (!facts) return { kind: "not_found" };
  const photoUrl = facts.photo ? await signedUrl(supabase, facts.photo.storagePath) : null;
  return {
    kind: "ok", facts, photoUrl,
    unavailableMessage: facts.available ? null : ARTWORK_UNAVAILABLE_LABELS[facts.unavailableReason ?? "NO_PRICE"]
  };
}

/**
 * Hechos de la pieza de un producto para una sucursal (precio vigente + promoción + foto). El navegador pide `product + sucursal`;
 * el precio sale de la base (`get_product_artwork`), nunca del cliente. La foto viaja como URL firmada de corta vida (bucket privado).
 */
export async function loadArtworkAction(productId: string, branchId: string | null): Promise<ArtworkLoadResult> {
  try {
    await requireAdminContext();
    if (!isUuid(productId) || (branchId !== null && !isUuid(branchId))) return { kind: "not_found" };
    return await loadEntry(await createClient(), productId, branchId);
  } catch (error) {
    return { kind: "error", message: message(error, "No se pudo cargar la pieza") };
  }
}

export type CollageLoadResult =
  | { kind: "ok"; entries: LoadedEntry[] }
  | { kind: "error"; message: string };

/**
 * Hechos de los productos de un collage (2 a 5, EN ORDEN) para una sucursal: cada uno se vuelve a resolver contra la base
 * (`get_product_artwork`); el navegador sólo manda ids.
 */
export async function loadCollageAction(productIds: string[], branchId: string | null): Promise<CollageLoadResult> {
  try {
    await requireAdminContext();
    const validCount = Array.isArray(productIds) && productIds.length >= COLLAGE_MIN_ITEMS && productIds.length <= COLLAGE_MAX_ITEMS;
    if (!validCount || !productIds.every((id) => isUuid(id)) || new Set(productIds).size !== productIds.length) {
      return { kind: "error", message: "El collage lleva de 2 a 5 productos distintos." };
    }
    if (branchId !== null && !isUuid(branchId)) return { kind: "error", message: "Sucursal inválida" };
    const supabase = await createClient();
    const results = await Promise.all(productIds.map((id) => loadEntry(supabase, id, branchId)));
    const entries: LoadedEntry[] = [];
    for (const result of results) {
      if (result.kind === "error") return result;
      if (result.kind === "not_found") return { kind: "error", message: "Algún producto del collage ya no existe." };
      entries.push(result);
    }
    return { kind: "ok", entries };
  } catch (error) {
    return { kind: "error", message: message(error, "No se pudo cargar el collage") };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Identidad: logo de la organización + contacto de la sucursal (D-075)
// ---------------------------------------------------------------------------------------------------------------------

export type BrandingLoadResult =
  | { kind: "ok"; facts: ArtworkBrandingFacts; logoUrl: string | null }
  | { kind: "error"; message: string };

async function readBranding(supabase: Supabase, branchId: string | null): Promise<BrandingLoadResult> {
  const { data, error } = await supabase.rpc("get_artwork_branding", branchId ? { p_branch_id: branchId } : {});
  if (error) return { kind: "error", message: error.message };
  const facts = parseArtworkBrandingFacts(data);
  if (!facts) return { kind: "error", message: "No se pudo leer la identidad de la cartelería" };
  return { kind: "ok", facts, logoUrl: facts.logo ? await signedUrl(supabase, facts.logo.storagePath) : null };
}

/** Logo (URL firmada) y contacto de la sucursal elegida. Lo usan el preview y el modal «Configurar identidad». */
export async function loadBrandingAction(branchId: string | null): Promise<BrandingLoadResult> {
  try {
    await requireAdminContext();
    if (branchId !== null && !isUuid(branchId)) return { kind: "error", message: "Sucursal inválida" };
    return await readBranding(await createClient(), branchId);
  } catch (error) {
    return { kind: "error", message: message(error, "No se pudo leer la identidad") };
  }
}

/** Ruta nueva (generada acá, con la organización de la sesión) donde el navegador sube el logo. */
export async function createArtworkLogoUploadPathAction(type: StoredPhotoType): Promise<{ path?: string; error?: string }> {
  try {
    const context = await requireAdminContext();
    // `type` llega del navegador: se valida como texto aunque el tipo diga otra cosa.
    const requested: string = type;
    if (requested !== "image/jpeg" && requested !== "image/png") return { error: "Pedido inválido" };
    return { path: buildLogoPath(context.organizationId, crypto.randomUUID(), type) };
  } catch (error) {
    return { error: message(error, "No se pudo preparar la subida") };
  }
}

/**
 * Registra el logo que el navegador YA subió a Storage. El servidor lo descarga, comprueba que sea un PNG/JPG real y lee sus medidas
 * de la cabecera del archivo (no confía en lo que informe el navegador). Si había otro logo, se borra el objeto anterior.
 */
export async function registerArtworkLogoAction(storagePath: string, branchId: string | null): Promise<BrandingLoadResult> {
  try {
    const context = await requireAdminContext();
    if (!isValidLogoPath(storagePath, context.organizationId)) return { kind: "error", message: "Logo inválido" };
    const supabase = await createClient();
    const { data: file, error: downloadError } = await supabase.storage.from(ARTWORK_BUCKET).download(storagePath);
    if (downloadError) return { kind: "error", message: "No se pudo leer el logo que se subió. Probá de nuevo." };
    const info = readImageInfo(new Uint8Array(await file.arrayBuffer()));
    if (!info) {
      await removeObject(supabase, storagePath);
      return { kind: "error", message: "El logo tiene que ser un PNG o JPG válido." };
    }
    const { data, error } = await supabase.rpc("set_organization_artwork_logo", { p_storage_path: storagePath, p_width_px: info.width, p_height_px: info.height });
    if (error) {
      await removeObject(supabase, storagePath);
      return { kind: "error", message: error.message };
    }
    await removeObject(supabase, (data as { previousPath?: string | null } | null)?.previousPath);
    revalidatePath("/admin/products/artwork");
    return await readBranding(supabase, branchId);
  } catch (error) {
    return { kind: "error", message: message(error, "No se pudo guardar el logo") };
  }
}

/** Quita el logo de la organización (referencia + objeto de Storage). */
export async function removeArtworkLogoAction(branchId: string | null): Promise<BrandingLoadResult> {
  try {
    await requireAdminContext();
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("remove_organization_artwork_logo");
    if (error) return { kind: "error", message: error.message };
    await removeObject(supabase, (data as { removedPath?: string | null } | null)?.removedPath);
    revalidatePath("/admin/products/artwork");
    return await readBranding(supabase, branchId);
  } catch (error) {
    return { kind: "error", message: message(error, "No se pudo quitar el logo") };
  }
}

export interface ContactFormInput { phone: string; address: string; city: string }

/** Texto del navegador acotado (la base valida el contenido; esto sólo evita mandar textos enormes). */
function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** Teléfono, dirección y ciudad de UNA sucursal (la dirección es la misma columna que edita «Sucursales»: una sola fuente de verdad). */
export async function saveBranchContactAction(branchId: string, input: ContactFormInput): Promise<BrandingLoadResult> {
  try {
    await requireAdminContext();
    if (!isUuid(branchId)) return { kind: "error", message: "Sucursal inválida" };
    const supabase = await createClient();
    const { error } = await supabase.rpc("set_branch_artwork_contact", {
      p_branch_id: branchId, p_phone: clip(input.phone, 80), p_address: clip(input.address, 300), p_city: clip(input.city, 120)
    });
    if (error) return { kind: "error", message: error.message };
    revalidatePath(`/admin/branches/${branchId}`);
    return await readBranding(supabase, branchId);
  } catch (error) {
    return { kind: "error", message: message(error, "No se pudo guardar el contacto") };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Foto comercial de un producto (D-074)
// ---------------------------------------------------------------------------------------------------------------------

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
