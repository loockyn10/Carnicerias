import { buildArtworkBranding, parseArtworkBrandingFacts } from "./artwork-branding";
import { localDateString } from "./date-range";
import {
  isOfferLogoVariant, MAX_OFFER_SIGNS, offerSignFilename, paginateSigns, parseOfferSignCatalog, signPageCount, type OfferLogoVariant, type OfferSign, type OfferSignFormat
} from "./offer-sign";
import { buildSignPage, type SignBrand } from "./offer-sign-layout";
import { toMonochromeLogo } from "./offer-sign-logo";
import { renderOfferSignPdf } from "./offer-sign-pdf";
import { isUuid } from "./uuid";

/**
 * Generación del PDF de carteles de ofertas (D-087), lado servidor:
 *   1. valida el pedido: sólo `{ branchId, format, promotionIds }` (el navegador NO manda precios, nombres ni condiciones);
 *   2. vuelve a leer las promociones vigentes de la sucursal en la base (una sola consulta para todas, no una por producto) y arma cada
 *      cartel con el motor de precios; una promoción que ya no está vigente rechaza el pedido;
 *   3. lee el logo elegido (el de identidad «Super Ofertas» o el de la carnicería) y lo convierte en memoria a blanco y negro;
 *   4. dibuja un único PDF A4 apaisado con todas las hojas.
 * No guarda nada: es una impresión, no un registro. Las lecturas se inyectan (`OfferSignDeps`): la ruta HTTP las conecta a Supabase.
 */

export class OfferSignError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "OfferSignError";
    this.status = status;
  }
}

export interface OfferSignRequest {
  branchId: string;
  format: OfferSignFormat;
  promotionIds: string[];
  /** Logo elegido en pantalla; null = el que quedó guardado en los ajustes. */
  logoVariant: OfferLogoVariant | null;
}

export function parseOfferSignRequest(body: unknown): { ok: true; value: OfferSignRequest } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Pedido inválido" };
  const record = body as Record<string, unknown>;
  if (!isUuid(record.branchId)) return { ok: false, error: "Sucursal inválida" };
  if (record.format !== "STRIP" && record.format !== "MEDIUM" && record.format !== "POSTER") return { ok: false, error: "Formato inválido" };
  if (record.logoVariant !== undefined && record.logoVariant !== null && !isOfferLogoVariant(record.logoVariant)) return { ok: false, error: "Logo inválido" };
  if (!Array.isArray(record.promotionIds) || record.promotionIds.length === 0) return { ok: false, error: "Elegí al menos una promoción" };
  if (record.promotionIds.length > MAX_OFFER_SIGNS) return { ok: false, error: `Hasta ${String(MAX_OFFER_SIGNS)} carteles por PDF` };
  const promotionIds: string[] = [];
  for (const id of record.promotionIds as unknown[]) {
    if (!isUuid(id)) return { ok: false, error: "Promoción inválida" };
    const key = id.toLowerCase();
    if (!promotionIds.includes(key)) promotionIds.push(key);
  }
  return { ok: true, value: { branchId: record.branchId.toLowerCase(), format: record.format, promotionIds, logoVariant: isOfferLogoVariant(record.logoVariant) ? record.logoVariant : null } };
}

export interface OfferSignDeps {
  /** `get_signage_promotion_catalog(sucursal, sólo aplicables)`: JSON crudo. */
  getCatalog: (branchId: string) => Promise<unknown>;
  /** `get_artwork_branding(sucursal)`: JSON crudo (logo + nombre del negocio y de la sucursal). */
  getBranding: (branchId: string) => Promise<unknown>;
  /** `get_offer_sign_settings()`: JSON crudo con el logo elegido y la referencia al logo de la carnicería. */
  getSettings: () => Promise<unknown>;
  /** Descarga el logo de Storage; null = no existe o no se pudo leer. */
  readLogo: (storagePath: string) => Promise<Uint8Array | null>;
}

/** Ajustes guardados: logo elegido y si existe el de la carnicería. Un dato raro vuelve al logo general. */
export function parseOfferLogoSettings(payload: unknown): { logoVariant: OfferLogoVariant; butcherStoragePath: string | null } {
  const record = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {};
  const butcher = typeof record.butcherLogo === "object" && record.butcherLogo !== null ? (record.butcherLogo as Record<string, unknown>).storagePath : null;
  const butcherStoragePath = typeof butcher === "string" && butcher ? butcher : null;
  return { logoVariant: record.logoVariant === "BUTCHER" && butcherStoragePath ? "BUTCHER" : "GENERAL", butcherStoragePath };
}

export interface OfferSignSource {
  signs: OfferSign[];
  branchName: string;
  businessName: string;
  /** Logo elegido (el pedido o, si no se pidió ninguno, el guardado). */
  selected: OfferLogoVariant;
  /** PNG monocromo de cada logo cargado; null = no hay (o no se pudo convertir: se imprime el nombre del negocio). Sólo trae los que se pidieron. */
  logos: Record<OfferLogoVariant, Uint8Array | null>;
  /** Existe el logo de la carnicería (para habilitar la opción en pantalla). */
  hasButcherLogo: boolean;
}

async function monochrome(read: () => Promise<Uint8Array | null>): Promise<Uint8Array | null> {
  try {
    const file = await read();
    return file ? (await toMonochromeLogo(file)).png : null;
  } catch {
    // Un logo ilegible no impide imprimir las ofertas: se usa el nombre del negocio.
    return null;
  }
}

/**
 * Promociones imprimibles de la sucursal + identidad + logos. Una sola lectura de promociones, una de identidad y una de ajustes.
 * `which`: `ALL` convierte los dos logos (la pantalla cambia de logo sin ir al servidor); `SAVED` sólo el guardado y `GENERAL`/`BUTCHER` sólo ése (el PDF).
 */
export async function loadOfferSignSource(deps: OfferSignDeps, branchId: string, which: OfferLogoVariant | "ALL" | "SAVED" = "ALL"): Promise<OfferSignSource> {
  const [catalog, brandingRaw, settingsRaw] = await Promise.all([deps.getCatalog(branchId), deps.getBranding(branchId), deps.getSettings()]);
  const facts = parseArtworkBrandingFacts(brandingRaw);
  if (!facts) throw new OfferSignError(500, "No se pudo leer la identidad del negocio");
  if (!facts.branch) throw new OfferSignError(404, "La sucursal no existe");
  const settings = parseOfferLogoSettings(settingsRaw);
  // Un BUTCHER pedido sin logo de carnicería cargado cae al general (nunca se imprime un logo que no existe).
  const requested = which === "GENERAL" || which === "BUTCHER" ? which : settings.logoVariant;
  const selected: OfferLogoVariant = requested === "BUTCHER" && !settings.butcherStoragePath ? "GENERAL" : requested;
  const wanted = (variant: OfferLogoVariant) => which === "ALL" || selected === variant;
  const generalPath = facts.logo?.storagePath ?? null;
  const butcherPath = settings.butcherStoragePath;
  const [general, butcher] = await Promise.all([
    generalPath && wanted("GENERAL") ? monochrome(() => deps.readLogo(generalPath)) : Promise.resolve(null),
    butcherPath && wanted("BUTCHER") ? monochrome(() => deps.readLogo(butcherPath)) : Promise.resolve(null)
  ]);
  return {
    signs: parseOfferSignCatalog(catalog), branchName: facts.branch.name, businessName: buildArtworkBranding(facts, null).businessName,
    selected, logos: { GENERAL: general, BUTCHER: butcher }, hasButcherLogo: butcherPath !== null
  };
}

export interface OfferSignResult {
  pdf: Uint8Array;
  filename: string;
  signCount: number;
  pageCount: number;
}

/** Arma el PDF con los carteles pedidos (en el orden pedido). */
export async function renderOfferSigns(source: OfferSignSource, request: Pick<OfferSignRequest, "format" | "promotionIds"> & { logoVariant?: OfferLogoVariant | null }, context: { timeZone: string; now?: Date }): Promise<OfferSignResult> {
  const byId = new Map(source.signs.map((sign) => [sign.promotionId.toLowerCase(), sign]));
  const missing = request.promotionIds.filter((id) => !byId.has(id));
  if (missing.length) throw new OfferSignError(422, `${String(missing.length)} ${missing.length === 1 ? "promoción ya no está vigente" : "promociones ya no están vigentes"} en esta sucursal: actualizá la lista`);
  const signs = request.promotionIds.map((id) => byId.get(id)).filter((sign): sign is OfferSign => sign !== undefined);

  const now = context.now ?? new Date();
  const logoPng = source.logos[request.logoVariant ?? source.selected];
  const brand: SignBrand = { hasLogo: logoPng !== null, name: source.businessName };
  const pages = paginateSigns(signs, request.format).map((group) => buildSignPage(group, request.format, brand));
  const pdf = await renderOfferSignPdf(pages, { title: `Carteles de ofertas - ${source.branchName}`, logoPng, createdAt: now });
  return {
    pdf, filename: offerSignFilename(source.branchName, localDateString(context.timeZone, now)), signCount: signs.length, pageCount: signPageCount(request.format, signs.length)
  };
}

export async function executeOfferSignRun(deps: OfferSignDeps, request: OfferSignRequest, context: { timeZone: string; now?: Date }): Promise<OfferSignResult> {
  return renderOfferSigns(await loadOfferSignSource(deps, request.branchId, request.logoVariant ?? "SAVED"), request, context);
}
