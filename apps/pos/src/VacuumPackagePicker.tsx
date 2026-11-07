import { formatCurrency } from "@carnicerias/business-logic";

import { describeVacuumCandidate, type VacuumCandidate } from "./lib/vacuum-scan";

/**
 * Selector de paquete de Envasados: aparece SÓLO cuando el código escaneado corresponde a varios paquetes de PESOS distintos (mismo producto y mismo
 * importe pueden pesar distinto). Muestra peso, lote y fecha de elaboración, del más antiguo (el primero, ya enfocado: Enter lo elige) al más nuevo.
 * Con paquetes del mismo peso no se muestra: se toma el más antiguo (FIFO) sin preguntar.
 */
export function VacuumPackagePicker({ candidates, onPick, onCancel }: { candidates: VacuumCandidate[]; onPick: (candidate: VacuumCandidate) => void; onCancel: () => void }) {
  const first = candidates[0];
  return (
    <div
      aria-labelledby="vacuum-picker-title"
      aria-modal="true"
      className="pos-modal-backdrop fixed inset-0 z-[60] grid place-items-center bg-black/80 p-4"
      data-testid="vacuum-package-picker"
      onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}
      onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}
      role="dialog"
    >
      <section className="pos-modal-panel w-full max-w-lg rounded-3xl border border-stone-700 bg-stone-900 p-7 shadow-2xl">
        <p className="text-sm font-bold uppercase tracking-wider text-sky-300">Envasado al vacío</p>
        <h2 className="mt-1 text-3xl font-black" id="vacuum-picker-title">{first?.productName ?? "Paquete"}</h2>
        <p className="mt-2 text-stone-300">Hay paquetes de distinto peso con el mismo código. Elegí el que tenés en la mano (el más antiguo está primero).</p>
        <ul className="mt-5 grid gap-2">
          {candidates.map((candidate, index) => {
            const detail = describeVacuumCandidate(candidate);
            return (
              <li key={candidate.packageId}>
                <button
                  autoFocus={index === 0}
                  className="flex w-full items-center justify-between gap-4 rounded-2xl border border-stone-600 bg-stone-950 px-4 py-3 text-left hover:border-sky-400 focus:border-sky-400 focus:outline-none"
                  data-testid="vacuum-package-option"
                  onClick={() => onPick(candidate)}
                  type="button"
                >
                  <span>
                    <strong className="block text-xl font-black">{detail.weight}</strong>
                    <span className="block text-sm text-stone-400">Lote {detail.lot} · elaborado {detail.packedOn}</span>
                  </span>
                  <strong className="whitespace-nowrap text-xl text-rose-400">{formatCurrency(candidate.chargeCents)}</strong>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="mt-6 flex justify-end">
          <button className="rounded-xl border border-stone-600 px-4 py-3 font-bold hover:bg-stone-800" onClick={onCancel} type="button">Cancelar</button>
        </div>
      </section>
    </div>
  );
}
