"use server";

import { revalidatePath } from "next/cache";

import { requireAdminContext } from "../../../../lib/admin";
import { ARTWORK_BUCKET, buildLogoPath, isValidLogoPath, type StoredPhotoType } from "../../../../lib/artwork-photo";
import { readImageInfo } from "../../../../lib/image-size";
import { isOfferLogoVariant } from "../../../../lib/offer-sign";
import { createClient } from "../../../../lib/supabase/server";

interface Result { error?: string }

const message = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

async function removeObject(supabase: Awaited<ReturnType<typeof createClient>>, path: string | null | undefined) {
  if (path) await supabase.storage.from(ARTWORK_BUCKET).remove([path]);
}

/** Guarda qué logo usan los carteles de ofertas (sólo esos carteles: el logo de identidad, Instagram, TV y las etiquetas no cambian). */
export async function saveOfferLogoVariantAction(variant: string): Promise<Result> {
  try {
    await requireAdminContext();
    if (!isOfferLogoVariant(variant)) return { error: "Logo inválido" };
    const { error } = await (await createClient()).rpc("set_offer_sign_logo_variant", { p_variant: variant });
    if (error) return { error: error.message };
    revalidatePath("/admin/products/labels");
    return {};
  } catch (error) {
    return { error: message(error, "No se pudo guardar el logo elegido") };
  }
}

/** Ruta nueva (con la organización de la sesión) donde el navegador sube el logo de la carnicería. */
export async function createButcherLogoUploadPathAction(type: StoredPhotoType): Promise<{ path?: string; error?: string }> {
  try {
    const context = await requireAdminContext();
    const requested: string = type;
    if (requested !== "image/jpeg" && requested !== "image/png") return { error: "Pedido inválido" };
    return { path: buildLogoPath(context.organizationId, crypto.randomUUID(), type) };
  } catch (error) {
    return { error: message(error, "No se pudo preparar la subida") };
  }
}

/**
 * Registra el logo de la carnicería que el navegador YA subió a Storage: el servidor lo descarga, comprueba que sea un PNG/JPG real, lee sus
 * medidas de la cabecera y lo deja elegido para los carteles. Si había otro logo de carnicería se borra su objeto. El logo de identidad no se toca.
 */
export async function registerButcherLogoAction(storagePath: string): Promise<Result> {
  try {
    const context = await requireAdminContext();
    if (!isValidLogoPath(storagePath, context.organizationId)) return { error: "Logo inválido" };
    const supabase = await createClient();
    const { data: file, error: downloadError } = await supabase.storage.from(ARTWORK_BUCKET).download(storagePath);
    if (downloadError) return { error: "No se pudo leer el logo que se subió. Probá de nuevo." };
    const info = readImageInfo(new Uint8Array(await file.arrayBuffer()));
    if (!info) {
      await removeObject(supabase, storagePath);
      return { error: "El logo tiene que ser un PNG o JPG válido." };
    }
    const { data, error } = await supabase.rpc("set_offer_sign_butcher_logo", { p_storage_path: storagePath, p_width_px: info.width, p_height_px: info.height });
    if (error) {
      await removeObject(supabase, storagePath);
      return { error: error.message };
    }
    await removeObject(supabase, (data as { previousPath?: string | null } | null)?.previousPath);
    const selected = await supabase.rpc("set_offer_sign_logo_variant", { p_variant: "BUTCHER" });
    if (selected.error) return { error: selected.error.message };
    revalidatePath("/admin/products/labels");
    return {};
  } catch (error) {
    return { error: message(error, "No se pudo guardar el logo de la carnicería") };
  }
}

/** Quita el logo de la carnicería (los carteles vuelven al logo general). */
export async function removeButcherLogoAction(): Promise<Result> {
  try {
    await requireAdminContext();
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("remove_offer_sign_butcher_logo");
    if (error) return { error: error.message };
    await removeObject(supabase, (data as { removedPath?: string | null } | null)?.removedPath);
    revalidatePath("/admin/products/labels");
    return {};
  } catch (error) {
    return { error: message(error, "No se pudo quitar el logo de la carnicería") };
  }
}
