import { OfferSignWorkspace, type OfferBranchOption, type OfferSignListing } from "../../../../components/offer-sign-workspace";
import { loadOfferSignSource } from "../../../../lib/offer-sign-run";
import { createOfferSignDeps } from "../../../../lib/offer-sign-supabase";
import { createClient } from "../../../../lib/supabase/server";
import { isUuid } from "../../../../lib/uuid";

const dataUrl = (png: Uint8Array | null) => png ? `data:image/png;base64,${Buffer.from(png).toString("base64")}` : null;

/** La sucursal pedida si es válida; si no, «Central» (o la primera). */
export function pickBranch(branches: readonly OfferBranchOption[], requested: string): OfferBranchOption | null {
  const wanted = isUuid(requested) ? requested.toLowerCase() : "";
  return branches.find((branch) => branch.id.toLowerCase() === wanted)
    ?? branches.find((branch) => branch.name.trim().toLowerCase() === "central")
    ?? branches[0] ?? null;
}

/** Productos → Etiquetas → Carteles de ofertas: una sola lectura de las promociones vigentes de la sucursal + la identidad (logo). */
export async function OfferSignsView({ organizationId, requestedBranch }: { organizationId: string; requestedBranch: string }) {
  const supabase = await createClient();
  const branchesResult = await supabase.from("branches").select("id, name").eq("organization_id", organizationId).eq("active", true).order("name");
  const branches: OfferBranchOption[] = (branchesResult.data ?? []).map((branch) => ({ id: branch.id, name: branch.name }));
  const branch = pickBranch(branches, requestedBranch);

  let listing: OfferSignListing | null = null;
  let error = branchesResult.error?.message ?? null;
  if (branch) {
    try {
      const source = await loadOfferSignSource(createOfferSignDeps(supabase), branch.id);
      listing = {
        branchId: branch.id, branchName: source.branchName, businessName: source.businessName, signs: source.signs, logoVariant: source.selected,
        logos: { GENERAL: dataUrl(source.logos.GENERAL), BUTCHER: dataUrl(source.logos.BUTCHER) }
      };
    } catch (failure) {
      error = failure instanceof Error && failure.message ? failure.message : "No se pudieron cargar las promociones";
    }
  } else {
    error ??= "No hay sucursales activas.";
  }
  return <OfferSignWorkspace branches={branches} error={error} key={branch?.id ?? "sin-sucursal"} listing={listing} />;
}
