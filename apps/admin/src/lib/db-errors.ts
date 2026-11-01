/**
 * Mensajes de error de la base en castellano para los módulos Pollos y Envasados. Las RPC ya levantan casi todos los errores de negocio en
 * castellano; lo que llega crudo de Postgres (violaciones de unicidad por nombre) se traduce acá por el nombre del índice.
 */

const UNIQUE_MESSAGES: readonly [string, string][] = [
  ["poultry_products_org_name_uq", "Ya existe un producto de pollos con ese nombre"],
  ["poultry_price_lists_org_name_uq", "Ya existe una lista de precios con ese nombre"],
  ["poultry_customers_org_name_uq", "Ya existe un cliente con ese nombre"],
  ["product_vacuum_settings_org_plu_uq", "Ese PLU ya está asignado a otro producto"],
  ["vacuum_packages_organization_id_lot_key", "Ese lote ya existe"],
  ["poultry_orders_request_key_uq", "Ese pedido ya se había enviado"]
];

export function friendlyDbError(message: string): string {
  const match = UNIQUE_MESSAGES.find(([constraint]) => message.includes(constraint));
  if (match) return match[1];
  if (/permission denied|Permission .* is required/i.test(message)) return "No tenés permiso para esta operación";
  if (/Authentication required/i.test(message)) return "Tu sesión venció: volvé a iniciar sesión";
  if (/overlap|conflicting key value violates exclusion constraint/i.test(message)) return "Ya hay un valor vigente en esas fechas: elegí otra fecha de vigencia";
  return message;
}
