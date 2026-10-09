/**
 * «Se vende en»: una casilla por sucursal. Es el MISMO bloque en el alta y en la edición de un producto; lo único que cambia es qué casillas
 * arrancan marcadas (`checkedIds`): en el alta, la sucursal productiva (`defaultNewProductBranchIds`); en la edición, exactamente el
 * surtido guardado (`product.branchIds`), sin tocarlo.
 */
export function ProductBranchChecklist({ branches, checkedIds, hint }: { branches: readonly { id: string; name: string }[]; checkedIds: readonly string[]; hint: string }) {
  return <div className="rounded-lg bg-stone-50 p-3">
    <p className="text-sm font-bold">Se vende en</p>
    <p className="mt-1 text-xs text-stone-500">{hint}</p>
    <div className="mt-2 flex flex-wrap gap-4 text-sm">
      {branches.map((branch) => (
        <label className="flex items-center gap-2" key={branch.id}><input defaultChecked={checkedIds.includes(branch.id)} name="branch_ids" type="checkbox" value={branch.id} /> {branch.name}</label>
      ))}
    </div>
  </div>;
}
