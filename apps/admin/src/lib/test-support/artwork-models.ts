import { buildCollageArtworkModel, buildOfferArtworkModel, parseArtworkFacts, type OfferArtworkModel } from "../artwork";
import { buildArtworkBranding, parseArtworkBrandingFacts, type ArtworkBranding } from "../artwork-branding";
import { COLLAGE_FACTS, SAMPLE_FACTS, brandingPayload, type BrandingBranch } from "./artwork-fixtures";

/** Modelos de pieza armados desde los fixtures (sin red ni Storage): los comparten las pruebas de los renderers y de la interfaz. */
export const LOGO_URL = "data:image/png;base64,AAAA";
export const PHOTO_URL = "data:image/png;base64,BBBB";

export function brandingFor(branch: BrandingBranch, options: { logo?: boolean } = {}): ArtworkBranding {
  const facts = parseArtworkBrandingFacts(brandingPayload(branch, options));
  if (!facts) throw new Error("identidad inválida");
  return buildArtworkBranding(facts, options.logo === false ? null : LOGO_URL);
}

/** Identidad con el contacto que se indique (para probar datos parciales o vacíos). */
export function brandingWithContact(contact: { phone: string | null; address: string | null; city: string | null }): ArtworkBranding {
  const facts = parseArtworkBrandingFacts({ ...brandingPayload("central"), branch: { id: "b", name: "Nueva", ...contact } });
  if (!facts) throw new Error("identidad inválida");
  return buildArtworkBranding(facts, LOGO_URL);
}

type AnyFacts = Record<string, unknown>;

export function heroModel(
  key: keyof typeof SAMPLE_FACTS,
  extras: { headline?: string; imageUrl?: string | null; overrides?: AnyFacts; branding?: ArtworkBranding } = {}
): OfferArtworkModel {
  const facts = parseArtworkFacts({ ...SAMPLE_FACTS[key], ...extras.overrides });
  if (!facts) throw new Error("hechos inválidos");
  const model = buildOfferArtworkModel(facts, { headline: extras.headline ?? "OFERTA", imageUrl: extras.imageUrl ?? null, branding: extras.branding ?? brandingFor("central") });
  if (!model) throw new Error("sin modelo");
  return model;
}

export type CollageKey = keyof typeof COLLAGE_FACTS | keyof typeof SAMPLE_FACTS;

export function collageModel(
  keys: readonly CollageKey[],
  extras: { headline?: string; branding?: ArtworkBranding; noPhoto?: readonly CollageKey[]; overrides?: Partial<Record<CollageKey, AnyFacts>> } = {}
): OfferArtworkModel {
  const entries = keys.map((key) => {
    const raw: AnyFacts = key in COLLAGE_FACTS ? COLLAGE_FACTS[key as keyof typeof COLLAGE_FACTS] : SAMPLE_FACTS[key as keyof typeof SAMPLE_FACTS];
    const facts = parseArtworkFacts({ ...raw, ...extras.overrides?.[key] });
    if (!facts) throw new Error("hechos inválidos");
    return { facts, imageUrl: extras.noPhoto?.includes(key) ? null : `${PHOTO_URL}#${key}` };
  });
  const result = buildCollageArtworkModel(entries, { headline: extras.headline ?? "OFERTAS", branding: extras.branding ?? brandingFor("central") });
  if (!result.ok) throw new Error(result.message);
  return result.model;
}
