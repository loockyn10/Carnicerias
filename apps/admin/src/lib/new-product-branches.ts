/**
 * Sucursales marcadas por defecto en el alta de un producto NUEVO («Se vende en»): sólo la sucursal productiva
 * (`organizations.production_branch_id`, normalmente Central). Las demás arrancan destildadas. Nunca depende del nombre de la sucursal.
 *
 * Sólo vale para el alta: editar un producto existente muestra exactamente el surtido guardado (`product.branchIds`), sin tocarlo.
 * Sin sucursal productiva configurada no se marca ninguna (no se adivina un destino).
 */
export function defaultNewProductBranchIds(branches: readonly { id: string }[], productionBranchId: string | null): string[] {
  if (productionBranchId === null) return [];
  return branches.filter((branch) => branch.id === productionBranchId).map((branch) => branch.id);
}
