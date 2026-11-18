import { describe, expect, it, vi } from "vitest";

import { ArtworkExportError } from "./artwork-export";
import { executeFolderGeneration, type FolderGenerationDeps } from "./artwork-folder-export";
import { HERO_VARIANTS, pickHeroVariant } from "./artwork-hero-layouts";
import { readImageInfo } from "./image-size";
import { parsePromotionFeedState, type PromotionFeedItem } from "./promotion-feed";
import { renderPromotionFeed } from "./promotion-feed-render";
import { renderSampleLogo } from "./test-support/artwork-deps";
import { brandingPayload, makeMeatPhoto } from "./test-support/artwork-fixtures";
import { FOLDER_BRANCH, FOLDER_ID, itemId, packPromotion, photoOf, rawFolderFacts, rawItem } from "./test-support/folder-fixtures";
import { must } from "./test-support/must";

const NOW = new Date("2026-11-18T15:00:00Z");

async function deps() {
  const logo = await renderSampleLogo();
  const photo = makeMeatPhoto("transparent");
  const getBranding = vi.fn(() => Promise.resolve(brandingPayload("central")));
  const readPhoto = vi.fn((path: string) => Promise.resolve({ bytes: path.includes("/branding/") ? logo : photo }));
  return { getBranding, readPhoto };
}

function feedItem(raw: Record<string, unknown>): PromotionFeedItem {
  const state = must(parsePromotionFeedState({ branchId: FOLDER_BRANCH, branchName: "Central", items: [{ ...raw, downloaded: null }], lastBatch: null }, NOW));
  return must(state.items[0]);
}

const pataMuslo = (extra?: Parameters<typeof rawItem>[0]["photo"]) =>
  rawItem({ n: 1, name: "Pata muslo", listPriceCents: 1_000_000, promotion: packPromotion(1), ...(extra === undefined ? {} : { photo: extra }) });

describe("pieza Feed de una promoción: el generador de Cartelería, sin diseño nuevo", () => {
  it("es un PNG Feed 1080 × 1350 y es IDÉNTICO byte a byte a la pieza Feed que genera una carpeta con esa misma composición", async () => {
    const d = await deps();
    const item = feedItem(pataMuslo());
    const ours = await renderPromotionFeed(d, item, { id: FOLDER_BRANCH, name: "Central" });
    expect(readImageInfo(ours.png)).toMatchObject({ width: 1080, height: 1350 });

    // La composición estable del producto (la de «Crear una pieza individual»): en una carpeta, la posición que cae en esa composición.
    const variant = pickHeroVariant({ seed: item.productId });
    const position = HERO_VARIANTS.indexOf(variant) + 1;
    const folderDeps: FolderGenerationDeps = { ...d, getFolderFacts: () => Promise.resolve(rawFolderFacts([{ ...pataMuslo(), position }])) };
    const { pieces } = await executeFolderGeneration(folderDeps, { folderId: FOLDER_ID, branchId: FOLDER_BRANCH, itemIds: [itemId(1)], formats: ["feed"], headline: "OFERTA" }, () => NOW);
    expect(Buffer.from(ours.png).equals(Buffer.from(must(must(pieces[0]).png)))).toBe(true);
  }, 60_000);

  it("devuelve la firma y el resumen de lo dibujado; logo y foto se leen una vez; el precio nuevo da otra imagen", async () => {
    const d = await deps();
    const item = feedItem(pataMuslo());
    const first = await renderPromotionFeed(d, item, { id: FOLDER_BRANCH, name: "Central" });
    expect(first.signature).toBe(item.signature);
    expect(first.summary).toBe(item.summary);
    expect(d.readPhoto).toHaveBeenCalledTimes(2);
    expect(d.getBranding).toHaveBeenCalledWith(FOLDER_BRANCH);
    const cheaper = feedItem(rawItem({ n: 1, name: "Pata muslo", listPriceCents: 1_000_000, promotion: packPromotion(1, { packPriceCents: "1300000" }) }));
    const second = await renderPromotionFeed(d, cheaper, { id: FOLDER_BRANCH, name: "Central" });
    expect(second.signature).not.toBe(first.signature);
    expect(Buffer.from(second.png).equals(Buffer.from(first.png))).toBe(false);
  }, 60_000);

  it("una foto PNG sin el dato de transparencia se analiza con sus bytes: misma imagen que con el dato registrado", async () => {
    const d = await deps();
    const known = await renderPromotionFeed(d, feedItem(pataMuslo(photoOf(1, true))), { id: FOLDER_BRANCH, name: "Central" });
    const unknown = await renderPromotionFeed(d, feedItem(pataMuslo(photoOf(1, null))), { id: FOLDER_BRANCH, name: "Central" });
    expect(Buffer.from(unknown.png).equals(Buffer.from(known.png))).toBe(true);
  }, 60_000);

  it("errores: lo que no está vigente no se dibuja (409) y una foto ilegible falla con mensaje (502)", async () => {
    const d = await deps();
    const expired = feedItem(rawItem({ n: 1, name: "Pata muslo", reason: "PROMO_EXPIRED", promotion: packPromotion(1, { status: "EXPIRED" }) }));
    await expect(renderPromotionFeed(d, expired, { id: FOLDER_BRANCH, name: "Central" })).rejects.toMatchObject({ status: 409 });
    const broken = { ...d, readPhoto: vi.fn((path: string) => path.includes("/branding/") ? d.readPhoto(path) : Promise.resolve(null)) };
    const error: unknown = await renderPromotionFeed(broken, feedItem(pataMuslo()), { id: FOLDER_BRANCH, name: "Central" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ArtworkExportError);
    expect(error).toMatchObject({ status: 502 });
  }, 60_000);
});
