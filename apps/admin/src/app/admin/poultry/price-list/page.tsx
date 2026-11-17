import Link from "next/link";

import { PoultryPriceListImagesPanel, type PriceListImageView } from "../../../../components/poultry-price-list-images-panel";
import { SectionTabs } from "../../../../components/section-tabs";
import { requireAdminContext } from "../../../../lib/admin";
import { ARTWORK_BUCKET, SIGNED_URL_SECONDS } from "../../../../lib/artwork-photo";
import { createPerfLogger } from "../../../../lib/perf";
import { parsePriceListSettings, PRICE_LIST_LOGO_SOURCES, type PriceListImageRef, type PriceListLogoSource } from "../../../../lib/poultry-price-list-images";
import { POULTRY_TABS } from "../../../../lib/poultry-tabs";
import { createClient } from "../../../../lib/supabase/server";

/**
 * Pollos → Imágenes de la lista (D-100): logo y foto de fondo de la «Lista de precios». Sección propia, separada del botón de descarga: se
 * configura una vez y queda guardada (`poultry_price_list_settings`); el bucket es privado, así que las miniaturas usan URLs firmadas.
 */
export default async function PoultryPriceListImagesPage() {
  const perf = createPerfLogger("/admin/poultry/price-list");
  await requireAdminContext();
  const supabase = await createClient();
  const { data, error } = await perf.measure("settings", supabase.rpc("get_poultry_price_list_settings"));
  const settings = parsePriceListSettings(data);

  const refs: PriceListImageRef[] = [...PRICE_LIST_LOGO_SOURCES.map((source) => settings.options[source]), settings.background].filter((ref): ref is PriceListImageRef => ref !== null);
  const urls = new Map<string, string>();
  if (refs.length) {
    const { data: signed } = await perf.measure("signedUrls", supabase.storage.from(ARTWORK_BUCKET).createSignedUrls(refs.map((ref) => ref.storagePath), SIGNED_URL_SECONDS));
    for (const entry of signed ?? []) if (entry.path && entry.signedUrl) urls.set(entry.path, entry.signedUrl);
  }
  perf.flush();
  const view = (ref: PriceListImageRef | null): PriceListImageView | null => ref ? { url: urls.get(ref.storagePath) ?? null, widthPx: ref.widthPx, heightPx: ref.heightPx } : null;
  const logos: Partial<Record<PriceListLogoSource, PriceListImageView>> = {};
  for (const source of PRICE_LIST_LOGO_SOURCES) { const image = view(settings.options[source]); if (image) logos[source] = image; }

  return <main className="mx-auto max-w-6xl p-5 sm:p-8">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <p className="max-w-2xl text-stone-600">Imágenes que usa la «Lista de precios». Se guardan una vez: el botón de descarga las toma solo, sin preguntar nada.</p>
      <Link className="rounded-lg border border-stone-300 bg-white px-4 py-2.5 text-sm font-bold text-stone-700 hover:bg-stone-50" href="/admin/poultry/prices">← Volver a Precios</Link>
    </div>
    <SectionTabs tabs={POULTRY_TABS} />
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}
    <PoultryPriceListImagesPanel background={view(settings.background)} logoUsed={settings.logoUsed} logos={logos} />
  </main>;
}
