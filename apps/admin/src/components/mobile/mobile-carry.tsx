"use client";

import { formatStockQuantity, stockUnitLabel } from "@carnicerias/business-logic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useTransition, type ReactNode } from "react";

import { calculateCarryPlanAction } from "../../app/admin/actions";
import { buildTransferHref } from "../../lib/carry-transfer";
import { carryKey, carryTotals, groupCarryPlan, initialCarryInputsFixed, resolveCarryQuantity, type CarryPlanReport, type CarryPlanRow } from "../../lib/carry-plan";
import { formatLocalDateTime } from "../../lib/date-range";
import { productsText } from "../../lib/quick-stock";
import { useInnerSteps, useMobileChrome } from "./mobile-chrome";
import { bigInput, Notice, primaryButton, secondaryButton, StickyFooter } from "./mobile-ui";

type Step = "list" | "prepare" | "review";

function totalsText(totals: { grams: number; units: number }) {
  return [totals.grams > 0 ? formatStockQuantity(totals.grams, "WEIGHT") : "", totals.units > 0 ? formatStockQuantity(totals.units, "UNIT") : ""].filter(Boolean).join(" + ") || "Nada";
}

/**
 * «Qué llevar» del celular. Reutiliza EXACTAMENTE el informe de `get_branch_carry_plan` (`calculateCarryPlanAction`): la fórmula vive sólo en SQL, acá no se recalcula
 * nada. Tres pasos sin tablas: 1) cada sucursal con sus primeros productos, 2) «Preparar carga» (cantidad sugerida editable, con la unidad a la vista) y 3) la lista
 * final para revisar. El sugerido es una SUGERENCIA según las ventas recientes: la decisión es de quien carga. «Registrar la carga» abre Distribución (el flujo que
 * ya existe) con todo cargado; esta pantalla no mueve stock por sí sola.
 */
export function MobileCarry({ productionBranch, initialBranchId, timeZone }: {
  productionBranch: { id: string; name: string } | null;
  /** Abre directo «Preparar carga» de esa sucursal (viene del detalle de la sucursal). */
  initialBranchId: string | null;
  timeZone: string;
}) {
  const router = useRouter();
  const { step, go, back, atStart } = useInnerSteps<Step>(initialBranchId ? "prepare" : "list");
  const [report, setReport] = useState<CarryPlanReport | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [branchId, setBranchId] = useState<string | null>(initialBranchId);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const calculate = useCallback(() => {
    startTransition(async () => {
      try {
        const result = await calculateCarryPlanAction(null);
        if (result.error !== undefined) { setError(result.error); return; }
        setError(null);
        setReport(result.report);
        setInputs(initialCarryInputsFixed(result.report.rows));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "No se pudo calcular. Revisá la conexión y probá de nuevo.");
      }
    });
  }, []);
  useEffect(() => { calculate(); }, [calculate]);

  const groups = useMemo(() => report ? groupCarryPlan(report.rows, { showAll: false }) : [], [report]);
  const allGroups = useMemo(() => report ? groupCarryPlan(report.rows, { showAll: true }) : [], [report]);
  const branchName = report?.rows.find((row) => row.branchId === branchId)?.branchName ?? null;
  const preparing = step !== "list" && branchName !== null;

  useMobileChrome(
    step === "prepare" && branchName ? `Qué llevar a ${branchName}` : step === "review" && branchName ? "Revisar la carga" : null,
    !atStart ? back : initialBranchId ? () => { router.back(); } : null
  );

  if (error && !report) return <Screen><Notice tone="error">{error}</Notice><button className={`${secondaryButton} mt-3`} disabled={pending} onClick={calculate} type="button">{pending ? "Calculando…" : "Probar de nuevo"}</button></Screen>;
  if (!report) return <Screen><p className="py-16 text-center text-lg text-stone-500" role="status">Calculando qué llevar…</p></Screen>;

  if (preparing) {
    const group = (showAll ? allGroups : groups).find((candidate) => candidate.branchId === branchId);
    const rows = group?.rows ?? [];
    const hidden = (allGroups.find((candidate) => candidate.branchId === branchId)?.rows.length ?? 0) - (groups.find((candidate) => candidate.branchId === branchId)?.rows.length ?? 0);
    const totals = carryTotals(rows, inputs);

    if (step === "review") {
      const lines = rows.flatMap((row) => {
        const { quantity } = resolveCarryQuantity(inputs[carryKey(row)] ?? "", row.unitType);
        return quantity !== null && quantity > 0 ? [{ row, quantity }] : [];
      });
      return <Screen>
        <h2 className="text-2xl font-black uppercase tracking-wide">{branchName}</h2>
        <p className="mt-1 text-base text-stone-600">Esto es lo que vas a llevar. Revisalo antes de cargar.</p>
        <ul className="mt-4 divide-y divide-stone-100 rounded-2xl border border-stone-200 bg-white px-4 shadow-sm">
          {lines.map(({ row, quantity }) => <li className="flex items-baseline justify-between gap-3 py-3" key={carryKey(row)}><span className="min-w-0 text-lg font-bold">{row.productName}</span><span className="shrink-0 text-xl font-black">{formatStockQuantity(quantity, row.unitType)}</span></li>)}
          {!lines.length ? <li className="py-4 text-base text-stone-500">No hay nada para llevar: todas las cantidades están en cero.</li> : null}
        </ul>
        <p className="mt-3 text-center text-lg">Total a llevar: <strong>{totalsText(totals)}</strong> · {productsText(lines.length)}</p>
        <Notice tone="info">Todavía no se movió stock. Cuando cargues la mercadería, registrala para que el sistema descuente de {productionBranch?.name ?? "el origen"} y sume en {branchName}.</Notice>
        <StickyFooter>
          {lines.length && branchId
            ? <Link className={primaryButton} href={buildTransferHref({ sourceBranchId: productionBranch?.id ?? null, destinationBranchId: branchId, items: lines.map(({ row, quantity }) => ({ productId: row.productId, quantity })) })} prefetch={false}>Registrar la carga</Link>
            : <button className={primaryButton} disabled type="button">Registrar la carga</button>}
          <button className={`${secondaryButton} mt-2`} onClick={back} type="button">Volver a editar</button>
        </StickyFooter>
      </Screen>;
    }

    return <Screen>
      <h2 className="text-2xl font-black uppercase tracking-wide">Qué llevar a {branchName}</h2>
      <p className="mt-1 text-base text-stone-600">Sugerido según ventas recientes. Cambiá las cantidades como te convenga.</p>
      <div className="mt-4 grid gap-3">
        {rows.map((row) => <CarryRow input={inputs[carryKey(row)] ?? ""} key={carryKey(row)} onInput={(value) => { setInputs((current) => ({ ...current, [carryKey(row)]: value })); }} row={row} />)}
        {!rows.length ? <Notice tone="ok">No hace falta llevar nada a {branchName}: lo vendido en los últimos 7 días está cubierto por el stock.</Notice> : null}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <button className="min-h-12 rounded-xl px-2 text-base font-bold text-stone-600 underline" onClick={() => { setInputs(initialCarryInputsFixed(report.rows)); }} type="button">Volver a lo sugerido</button>
        {hidden > 0 || showAll ? <button className="min-h-12 rounded-xl px-2 text-base font-bold text-stone-600 underline" onClick={() => { setShowAll(!showAll); }} type="button">{showAll ? "Ocultar los que no hacen falta" : `Ver productos sin sugerencia (${String(hidden)})`}</button> : null}
      </div>
      <StickyFooter>
        {totals.invalid > 0 ? <p className="mb-2 text-center text-sm font-bold text-red-700" role="alert">Hay {totals.invalid === 1 ? "una cantidad" : `${String(totals.invalid)} cantidades`} para corregir.</p> : <p className="mb-2 text-center text-base text-stone-600">Total a llevar: <strong>{totalsText(totals)}</strong></p>}
        <button className={primaryButton} disabled={totals.invalid > 0 || !rows.length} onClick={() => { go("review"); }} type="button">Continuar</button>
      </StickyFooter>
    </Screen>;
  }

  return <Screen>
    {initialBranchId && !branchName ? <div className="mb-3"><Notice tone="info">Esa sucursal no tiene nada para llevar (es la productiva o no tiene productos habilitados). Elegí otra.</Notice></div> : null}
    <p className="text-base text-stone-600">Sugerido según ventas recientes (últimos {report.windowDays} días). <span className="text-stone-500">Calculado {formatLocalDateTime(report.calculatedAt, timeZone).slice(11)}.</span></p>
    {error ? <div className="mt-3"><Notice tone="error">{error}</Notice></div> : null}
    <div className="mt-4 grid gap-4">
      {allGroups.map((group) => {
        const needed = group.rows.filter((row) => row.suggestedQuantity > 0);
        return <article aria-label={group.branchName} className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm" key={group.branchId}>
          <h2 className="text-xl font-black uppercase tracking-wide">{group.branchName}</h2>
          {needed.length
            ? <ul className="mt-2 divide-y divide-stone-100">{needed.slice(0, 3).map((row) => <li className="flex items-baseline justify-between gap-3 py-2" key={carryKey(row)}><span className="min-w-0 text-lg">{row.productName}</span><strong className="shrink-0 text-lg text-teal-800">{formatStockQuantity(row.suggestedQuantity, row.unitType)}</strong></li>)}</ul>
            : <p className="mt-2 text-base text-emerald-800">✓ No hace falta llevar nada.</p>}
          {needed.length > 3 ? <p className="mt-1 text-sm text-stone-500">y {productsText(needed.length - 3)} más</p> : null}
          <button className={`${primaryButton} mt-3`} onClick={() => { setBranchId(group.branchId); setShowAll(false); go("prepare"); }} type="button">Preparar carga</button>
        </article>;
      })}
      {!allGroups.length ? <Notice tone="info">No hay sucursales con productos habilitados para calcular.</Notice> : null}
    </div>
    <button className={`${secondaryButton} mt-4`} disabled={pending} onClick={calculate} type="button">{pending ? "Calculando…" : "Volver a calcular"}</button>
  </Screen>;
}

function Screen({ children }: { children: ReactNode }) {
  return <div className="mobile-screen mx-auto w-full max-w-md px-4 pb-4 pt-4 lg:hidden" data-testid="mobile-carry">{children}</div>;
}

function CarryRow({ row, input, onInput }: { row: CarryPlanRow; input: string; onInput: (value: string) => void }) {
  const parsed = resolveCarryQuantity(input, row.unitType);
  return <article className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
    <h3 className="text-lg font-black uppercase leading-snug">{row.productName}</h3>
    <p className="mt-1 text-base text-stone-600">Sugerido: <strong className="text-teal-800">{formatStockQuantity(row.suggestedQuantity, row.unitType)}</strong>{row.currentQuantity > 0 ? <span className="text-stone-500"> · hoy hay {formatStockQuantity(row.currentQuantity, row.unitType)}</span> : <span className="text-stone-500"> · sin stock</span>}</p>
    <label className="mt-3 flex items-center gap-3"><span className="w-20 shrink-0 text-base font-bold text-stone-700">A llevar</span>
      <input aria-invalid={parsed.quantity === null} aria-label={`A llevar de ${row.productName}`} autoComplete="off" className={`${bigInput} ${parsed.quantity === null ? "border-red-400 bg-red-50" : ""}`} inputMode={row.unitType === "WEIGHT" ? "decimal" : "numeric"} onChange={(event) => { onInput(event.target.value); }} value={input} />
      <span className="w-8 shrink-0 text-lg font-black text-stone-600">{stockUnitLabel(row.unitType)}</span>
    </label>
    {parsed.error ? <p className="mt-1 text-sm font-bold text-red-700" role="alert">{parsed.error}</p> : null}
  </article>;
}
