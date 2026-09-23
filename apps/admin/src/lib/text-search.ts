/** Case- and accent-insensitive normalization ("vacio" must match "Vacío"). Reused by every
 * client-side free-text search in Admin (Stock por sucursal, Precios, Promociones) so they all
 * behave the same way instead of each screen re-implementing its own normalization. */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("es").trim();
}
