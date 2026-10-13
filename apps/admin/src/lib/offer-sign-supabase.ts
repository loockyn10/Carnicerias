import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@carnicerias/database";

import { ARTWORK_BUCKET } from "./artwork-photo";
import { OfferSignError, type OfferSignDeps } from "./offer-sign-run";

/** Conecta las lecturas de los carteles de ofertas a Supabase con la sesión del usuario (cada RPC valida organización y permiso). */
export function createOfferSignDeps(supabase: SupabaseClient<Database>): OfferSignDeps {
  const fail = (error: { code?: string; message: string }) => new OfferSignError(error.code === "42501" ? 403 : 500, error.message);
  return {
    getCatalog: async (branchId) => {
      const { data, error } = await supabase.rpc("get_signage_promotion_catalog", { p_branch_id: branchId, p_applicable_only: true });
      if (error) throw fail(error);
      return data;
    },
    getBranding: async (branchId) => {
      const { data, error } = await supabase.rpc("get_artwork_branding", { p_branch_id: branchId });
      if (error) throw fail(error);
      return data;
    },
    getSettings: async () => {
      const { data, error } = await supabase.rpc("get_offer_sign_settings");
      if (error) throw fail(error);
      return data;
    },
    readLogo: async (storagePath) => {
      const { data, error } = await supabase.storage.from(ARTWORK_BUCKET).download(storagePath);
      return error ? null : new Uint8Array(await data.arrayBuffer());
    }
  };
}
