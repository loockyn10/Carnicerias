import { isUuid } from "./uuid";

/**
 * «Qué llevar» → «Registrar la carga». «Qué llevar» es sólo un informe (no mueve stock). Cuando Fran ya decidió las cantidades, el paso siguiente es registrar el
 * traslado con la pantalla de Distribución que YA existe (`create_stock_transfer`): se abre con origen, destino y cantidades cargados para que lo confirme. No hay
 * un segundo flujo de traslados; esto sólo arma y lee el link. Las cantidades viajan crudas (gramos para WEIGHT, unidades enteras para UNIT) y el servidor
 * vuelve a leer el tipo real de cada producto antes de mostrarlas.
 */

export interface TransferPrefillItem { productId: string; quantity: number }

export interface TransferPrefill {
  sourceBranchId: string | null;
  destinationBranchId: string | null;
  items: TransferPrefillItem[];
}

const MAX_PREFILL_ITEMS = 100;

export function buildTransferHref(input: { sourceBranchId: string | null; destinationBranchId: string; items: readonly TransferPrefillItem[] }): string {
  const query = new URLSearchParams();
  if (input.sourceBranchId) query.set("from", input.sourceBranchId);
  query.set("to", input.destinationBranchId);
  query.set("items", input.items.map((item) => `${item.productId}:${String(item.quantity)}`).join(","));
  return `/admin/transfers?${query.toString()}`;
}

/** Lee `from`, `to` e `items` descartando todo lo que no sea un id válido o una cantidad entera positiva (nunca lanza). */
export function parseTransferPrefill(params: { from?: string | undefined; to?: string | undefined; items?: string | undefined }): TransferPrefill {
  const items: TransferPrefillItem[] = [];
  const seen = new Set<string>();
  for (const part of (params.items ?? "").split(",").slice(0, MAX_PREFILL_ITEMS)) {
    const [productId, quantityText] = part.split(":");
    if (!isUuid(productId) || seen.has(productId) || !/^\d{1,15}$/.test(quantityText ?? "")) continue;
    const quantity = Number(quantityText);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) continue;
    seen.add(productId);
    items.push({ productId, quantity });
  }
  return { sourceBranchId: isUuid(params.from) ? params.from : null, destinationBranchId: isUuid(params.to) ? params.to : null, items };
}
