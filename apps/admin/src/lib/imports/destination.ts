/**
 * Where an import lands. For the SimplyGest migration the destination is ALWAYS Central (the
 * butcher shops Avenida and Janssen are never touched). The destination is decided on the server —
 * the browser never sends a branch id — and a batch created for it enables the new products only in
 * that branch (D-049), so nothing else sees them.
 */

export interface ImportDestinationBranch {
  id: string;
  name: string;
  code: string;
}

export interface BranchCandidate extends ImportDestinationBranch {
  active: boolean;
}

export type ImportDestination =
  | { kind: "ok"; branch: ImportDestinationBranch; via: "production_branch" | "name" }
  | { kind: "missing"; reason: string };

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
}

/**
 * Central = the organization's production branch (the same definition the POS quick-create uses,
 * D-052). If that was never configured, a single active branch literally called "Central" is
 * accepted; anything ambiguous is refused rather than guessed.
 */
export function resolveImportDestination(branches: readonly BranchCandidate[], productionBranchId: string | null): ImportDestination {
  if (productionBranchId) {
    const configured = branches.find((branch) => branch.id === productionBranchId);
    if (configured?.active) return { kind: "ok", branch: { id: configured.id, name: configured.name, code: configured.code }, via: "production_branch" };
    return { kind: "missing", reason: "La sucursal productiva configurada (Central) está inactiva o no existe. Revisala en Desposte." };
  }
  const named = branches.filter((branch) => branch.active && (normalize(branch.name) === "central" || normalize(branch.code) === "central"));
  if (named.length === 1 && named[0]) {
    return { kind: "ok", branch: { id: named[0].id, name: named[0].name, code: named[0].code }, via: "name" };
  }
  return {
    kind: "missing",
    reason: "No hay una sucursal Central configurada. Marcala como sucursal productiva en Desposte antes de importar."
  };
}

/** The default category of products whose row names none: Almacen, accents/case ignored. */
export function pickDefaultCategory<T extends { id: string; name: string; active: boolean }>(categories: readonly T[]): T | null {
  const matches = categories.filter((category) => normalize(category.name) === "almacen");
  if (matches.length === 0) return null;
  // Prefer an active one, and exactly "Almacen" over a spelling variant, so the choice is stable.
  return [...matches].sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    const leftExact = left.name === "Almacen" ? 0 : 1;
    const rightExact = right.name === "Almacen" ? 0 : 1;
    return leftExact - rightExact || left.id.localeCompare(right.id);
  })[0] ?? null;
}
