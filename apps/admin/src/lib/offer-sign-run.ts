import { buildArtworkBranding, parseArtworkBrandingFacts } from "./artwork-branding";
import { localDateString } from "./date-range";
import { MAX_OFFER_SIGNS, offerSignFilename, paginateSigns, parseOfferSignCatalog, signPageCount, type OfferSign, type OfferSignFormat } from "./offer-sign";
import { buildSignPage, type SignBrand } from "./offer-sign-layout";
import { toMonochromeLogo } from "./offer-sign-logo";
import { renderOfferSignPdf } from "./offer-sign-pdf";
import { isUuid } from "./uuid";

/**
 * Generación del PDF de carteles de ofertas (D-087), lado servidor:
 *   1. valida el pedido: sólo `{ branchId, format, promotionIds }` (el navegador NO manda precios, nombres ni condiciones);
 *   2. vuelve a leer las promociones vigentes de la sucursal en la base (una sola consulta para todas, no una por producto) y arma cada
 *      cartel con el motor de precios; una promoción que ya no está vigente rechaza el pedido;
 *   3. lee la identidad (el logo de «Configurar identidad») y la convierte en memoria a blanco y negro;
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
}

export function parseOfferSignRequest(body: unknown): { ok: true; value: OfferSignRequest } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Pedido inválido" };
  const record = body as Record<string, unknown>;
  if (!isUuid(record.branchId)) return { ok: false, error: "Sucursal inválida" };
  if (record.format !== "STRIP" && record.format !== "POSTER") return { ok: false, error: "Formato inválido" };
  if (!Array.isArray(record.promotionIds) || record.promotionIds.length === 0) return { ok: false, error: "Elegí al menos una promoción" };
  if (record.promotionIds.length > MAX_OFFER_SIGNS) return { ok: false, error: `Hasta ${String(MAX_OFFER_SIGNS)} carteles por PDF` };
  const promotionIds: string[] = [];
  for (const id of record.promotionIds as unknown[]) {
    if (!isUuid(id)) return { ok: false, error: "Promoción inválida" };
    const key = id.toLowerCase();
    if (!promotionIds.includes(key)) promotionIds.push(key);
  }
  return { ok: true, value: { branchId: record.branchId.toLowerCase(), format: record.format, promotionIds } };
}

export interface OfferSignDeps {
  /** `get_signage_promotion_catalog(sucursal, sólo aplicables)`: JSON crudo. */
  getCatalog: (branchId: string) => Promise<unknown>;
  /** `get_artwork_branding(sucursal)`: JSON crudo (logo + nombre del negocio y de la sucursal). */
  getBranding: (branchId: string) => Promise<unknown>;
  /** Descarga el logo de Storage; null = no existe o no se pudo leer. */
  readLogo: (storagePath: string) => Promise<Uint8Array | null>;
}

export interface OfferSignSource {
  signs: OfferSign[];
  branchName: string;
  businessName: string;
  /** PNG monocromo del logo; null = sin logo (o no se pudo convertir: se imprime el nombre del negocio). */
  logoPng: Uint8Array | null;
}

/** Promociones imprimibles de la sucursal + identidad. Una sola lectura de promociones y una de identidad. */
export async function loadOfferSignSource(deps: OfferSignDeps, branchId: string): Promise<OfferSignSource> {
  const [catalog, brandingRaw] = await Promise.all([deps.getCatalog(branchId), deps.getBranding(branchId)]);
  const facts = parseArtworkBrandingFacts(brandingRaw);
  if (!facts) throw new OfferSignError(500, "No se pudo leer la identidad del negocio");
  if (!facts.branch) throw new OfferSignError(404, "La sucursal no existe");
  let logoPng: Uint8Array | null = null;
  if (facts.logo) {
    try {
      const file = await deps.readLogo(facts.logo.storagePath);
      if (file) logoPng = (await toMonochromeLogo(file)).png;
    } catch {
      // Un logo ilegible no impide imprimir las ofertas: se usa el nombre del negocio.
      logoPng = null;
    }
  }
  return {
    signs: parseOfferSignCatalog(catalog), branchName: facts.branch.name, businessName: buildArtworkBranding(facts, null).businessName, logoPng
  };
}

export interface OfferSignResult {
  pdf: Uint8Array;
  filename: string;
  signCount: number;
  pageCount: number;
}

/** Arma el PDF con los carteles pedidos (en el orden pedido). */
export async function renderOfferSigns(source: OfferSignSource, request: Pick<OfferSignRequest, "format" | "promotionIds">, context: { timeZone: string; now?: Date }): Promise<OfferSignResult> {
  const byId = new Map(source.signs.map((sign) => [sign.promotionId.toLowerCase(), sign]));
  const missing = request.promotionIds.filter((id) => !byId.has(id));
  if (missing.length) throw new OfferSignError(422, `${String(missing.length)} ${missing.length === 1 ? "promoción ya no está vigente" : "promociones ya no están vigentes"} en esta sucursal: actualizá la lista`);
  const signs = request.promotionIds.map((id) => byId.get(id)).filter((sign): sign is OfferSign => sign !== undefined);

  const now = context.now ?? new Date();
  const brand: SignBrand = { hasLogo: source.logoPng !== null, name: source.businessName };
  const pages = paginateSigns(signs, request.format).map((group) => buildSignPage(group, request.format, brand));
  const pdf = await renderOfferSignPdf(pages, { title: `Carteles de ofertas - ${source.branchName}`, logoPng: source.logoPng, createdAt: now });
  return {
    pdf, filename: offerSignFilename(source.branchName, localDateString(context.timeZone, now)), signCount: signs.length, pageCount: signPageCount(request.format, signs.length)
  };
}

export async function executeOfferSignRun(deps: OfferSignDeps, request: OfferSignRequest, context: { timeZone: string; now?: Date }): Promise<OfferSignResult> {
  return renderOfferSigns(await loadOfferSignSource(deps, request.branchId), request, context);
}
