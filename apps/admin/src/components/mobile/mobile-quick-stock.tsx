"use client";

import { formatStockQuantity, stockUnitLabel } from "@carnicerias/business-logic";
import { useCallback, useEffect, useRef, useState } from "react";

import { applyQuickStockAction, searchQuickStockAction } from "../../app/admin/actions";
import {
  buildApplyItems, countPreview, describeChange, failureText, getChange, groupPendingByBranch, itemsSignature, newRequestKey, parseChangeQuantity,
  deserializePending, pendingTotal, productsText, reconcilePending, removeChange, removeProblem, RequestKeyBook, savedSummary, serializePending, SingleFlight, upsertChange,
  type PendingChanges, type QuickApplyItem, type QuickChangeMode, type QuickStockOutcome, type QuickStockRow
} from "../../lib/quick-stock";
import { OverlayDialog } from "../overlay-dialog";
import { useInnerSteps, useMobileChrome, useStoredState } from "./mobile-chrome";
import { bigInput, Notice, primaryButton, secondaryButton, StickyFooter, textInput } from "./mobile-ui";

type Step = "pick" | "list";
type EditorKind = QuickChangeMode | "COUNT";
interface BranchOption { id: string; name: string }
type SaveResult = { outcome: QuickStockOutcome } | { error: string };

const actionStyles: Record<EditorKind, string> = {
  ADD: "border-emerald-300 bg-emerald-50 text-emerald-900 active:bg-emerald-100",
  REMOVE: "border-amber-300 bg-amber-50 text-amber-900 active:bg-amber-100",
  COUNT: "border-sky-300 bg-sky-50 text-sky-900 active:bg-sky-100"
};
const actionLabels: Record<EditorKind, string> = { ADD: "+ Agregar", REMOVE: "− Quitar", COUNT: "Conteo" };

/**
 * «Stock rápido» del celular. Elegís la sucursal, buscás el producto y tocás Agregar / Quitar / Conteo: cada cambio queda «pendiente» (podés cambiar de sucursal
 * sin perderlos, y sobreviven a un cierre accidental de la pantalla) y se guardan TODOS juntos con un solo toque, después de ver un resumen. Agregar y quitar son
 * movimientos del ledger (nunca «fijar el stock»); el conteo físico calcula la diferencia y deja el ajuste auditado. Todo pasa por `apply_quick_stock_changes`,
 * que usa `record_stock_operation` y es idempotente: tocar «Confirmar» dos veces no duplica nada.
 */
export function MobileQuickStock({ branches, productionBranchId, userId }: { branches: BranchOption[]; productionBranchId: string | null; userId: string }) {
  // La sucursal productiva (el depósito) primero; después el resto por nombre.
  const ordered = [...branches].sort((a, b) => Number(b.id === productionBranchId) - Number(a.id === productionBranchId) || a.name.localeCompare(b.name, "es"));
  const single = ordered.length === 1 ? ordered[0] : undefined;
  const { step, go, back, atStart } = useInnerSteps<Step>(single ? "list" : "pick");
  const [branchId, setBranchId] = useState<string | null>(single?.id ?? null);
  const branchName = (id: string) => ordered.find((branch) => branch.id === id)?.name ?? "Otra sucursal";

  const [stored, saveStored, storageLoaded] = useStoredState(`quick-stock:v1:${userId}`);
  const [pending, setPendingState] = useState<PendingChanges>({});
  const restored = useRef(false);
  useEffect(() => {
    if (!storageLoaded || restored.current) return;
    restored.current = true;
    setPendingState(deserializePending(stored));
  }, [storageLoaded, stored]);
  const setPending = useCallback((next: PendingChanges) => {
    setPendingState(next);
    saveStored(pendingTotal(next) ? serializePending(next) : null);
  }, [saveStored]);

  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<QuickStockRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const requestRef = useRef(0);

  const [editor, setEditor] = useState<{ productId: string; kind: EditorKind; raw: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [result, setResult] = useState<{ outcome: QuickStockOutcome; failures: { name: string; branch: string; text: string }[] } | null>(null);
  const keys = useRef(new RequestKeyBook());
  const flight = useRef(new SingleFlight());

  useEffect(() => {
    if (step !== "list" || !branchId) return;
    const requestId = ++requestRef.current;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setSearchError(null);
      searchQuickStockAction({ branchId, query, offset: 0 })
        .then((found) => { if (requestRef.current === requestId) { setRows(found.rows); setTotal(found.total); } })
        .catch(() => { if (requestRef.current === requestId) { setRows([]); setTotal(0); setSearchError("No se pudo buscar. Revisá la conexión y probá de nuevo."); } })
        .finally(() => { if (requestRef.current === requestId) setLoading(false); });
    }, query ? 300 : 0);
    return () => { window.clearTimeout(timer); };
  }, [step, branchId, query, refreshTick]);

  function loadMore() {
    if (!branchId) return;
    const requestId = ++requestRef.current;
    setLoading(true);
    searchQuickStockAction({ branchId, query, offset: rows.length })
      .then((found) => { if (requestRef.current === requestId) { setRows((current) => [...current, ...found.rows]); setTotal(found.total); } })
      .catch(() => { if (requestRef.current === requestId) setSearchError("No se pudo cargar más. Probá de nuevo."); })
      .finally(() => { if (requestRef.current === requestId) setLoading(false); });
  }

  /** Un solo envío a la vez: el segundo toque (o un toque en otro botón mientras guarda) no hace nada. */
  async function submit(items: QuickApplyItem[]): Promise<SaveResult | null> {
    const run = await flight.current.run(async (): Promise<SaveResult> => {
      setSaving(true);
      try {
        const requestKey = keys.current.keyFor(itemsSignature(items), newRequestKey);
        const response = await applyQuickStockAction({ requestKey, items });
        keys.current.clear();
        return response.ok ? { outcome: response.outcome } : { error: response.error };
      } catch {
        // Sin respuesta: puede haberse guardado o no. La clave se conserva, así que reintentar el MISMO pedido es seguro (no duplica).
        return { error: "No hay conexión o se cortó. Tus cambios siguen acá: tocá de nuevo para reintentar, no se va a duplicar nada." };
      } finally {
        setSaving(false);
      }
    });
    return run.ran ? run.value : null;
  }

  async function confirmAll() {
    setSaveError(null);
    const snapshot = pending;
    const response = await submit(buildApplyItems(snapshot));
    if (response === null) return;
    if ("error" in response) { setSaveError(response.error); return; }
    const failures = response.outcome.items.flatMap((item) => {
      if (item.ok) return [];
      const change = getChange(snapshot, item.branchId, item.productId);
      return [{ name: change?.productName ?? "Producto", branch: branchName(item.branchId), text: failureText(item, change?.unitType ?? "WEIGHT") }];
    });
    setPending(reconcilePending(snapshot, response.outcome));
    setResult({ outcome: response.outcome, failures });
    setRefreshTick((tick) => tick + 1);
  }

  async function confirmCount(row: QuickStockRow, raw: string) {
    if (!branchId) return;
    setNotice(null);
    const response = await submit([{ branchId, productId: row.productId, mode: "COUNT", raw: raw.trim(), expectedSystemQuantity: row.current }]);
    if (response === null) return;
    if ("error" in response) { setNotice(response.error); return; }
    const item = response.outcome.items[0];
    if (!item) { setNotice("No pudimos confirmar el conteo. Revisá el stock."); return; }
    if (!item.ok) {
      if (item.current !== null) setRows((current) => current.map((candidate) => candidate.productId === row.productId ? { ...candidate, current: item.current ?? candidate.current } : candidate));
      setNotice(failureText(item, row.unitType));
      return;
    }
    setEditor(null);
    setNotice(item.unchanged ? `✓ ${row.name}: el conteo coincide con el sistema, no hubo que ajustar nada.` : `✓ Conteo registrado: ${row.name} quedó en ${formatStockQuantity(item.after, row.unitType)}.`);
    setRows((current) => current.map((candidate) => candidate.productId === row.productId ? { ...candidate, current: item.after } : candidate));
  }

  const totalPending = pendingTotal(pending);
  const branchOrder = ordered.map((branch) => branch.id);
  const groups = groupPendingByBranch(pending, branchOrder);
  const currentName = branchId ? branchName(branchId) : null;

  useMobileChrome(step === "list" && currentName ? `Stock rápido — ${currentName}` : null, !atStart ? back : null);

  const pendingBar = totalPending > 0 ? <StickyFooter>
    <p className="text-center text-base font-bold text-stone-800" data-testid="pending-summary">Cambios pendientes: {totalPending}</p>
    <p className="mt-0.5 text-center text-sm text-stone-600">{groups.map((group) => `${branchName(group.branchId)}: ${productsText(group.changes.length)}`).join(" · ")}</p>
    <button className={`${primaryButton} mt-2`} onClick={() => { setResult(null); setSaveError(null); setReviewOpen(true); }} type="button">Guardar cambios</button>
  </StickyFooter> : null;

  const reviewDialog = reviewOpen ? <OverlayDialog onClose={() => { if (!saving) setReviewOpen(false); }} tall title={result ? "Listo" : "Vas a guardar"}>
    <div className="mobile-screen flex min-h-full flex-col pb-6 pt-4">
      {result ? <ResultView failures={result.failures} outcome={result.outcome} onClose={() => { setReviewOpen(false); setResult(null); }} /> : <>
        <div className="grid gap-4 pb-4">
          {groups.map((group) => <section aria-label={branchName(group.branchId)} key={group.branchId}>
            <h3 className="text-lg font-black uppercase tracking-wide">{branchName(group.branchId)}</h3>
            <ul className="mt-1 divide-y divide-stone-100 rounded-2xl border border-stone-200 bg-white px-4 shadow-sm">
              {group.changes.map((change) => <li className="flex items-center justify-between gap-3 py-3" key={change.productId}>
                <span className="min-w-0 text-base font-bold">{change.productName}</span>
                <span className="flex shrink-0 items-center gap-2"><strong className={`text-lg ${change.mode === "ADD" ? "text-emerald-800" : "text-amber-900"}`}>{describeChange(change)}</strong>
                  <button aria-label={`Sacar ${change.productName} de la lista`} className="grid size-10 place-items-center rounded-lg text-xl text-stone-500 active:bg-stone-100 disabled:opacity-40" disabled={saving} onClick={() => { setPending(removeChange(pending, change.branchId, change.productId)); }} type="button">×</button></span>
              </li>)}
            </ul>
          </section>)}
          {!groups.length ? <Notice tone="info">No hay cambios para guardar.</Notice> : null}
        </div>
        {saveError ? <div className="mt-3"><Notice tone="error">{saveError}</Notice></div> : null}
        <div className="sticky bottom-0 -mx-5 mt-auto grid grid-cols-[1fr_1.6fr] gap-3 border-t border-stone-200 bg-[#f5f4f1] px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
          <button className={secondaryButton} disabled={saving} onClick={() => { setReviewOpen(false); }} type="button">Cancelar</button>
          <button className={primaryButton} disabled={saving || !groups.length} onClick={() => { void confirmAll(); }} type="button">{saving ? "Guardando…" : "Confirmar cambios"}</button>
        </div>
      </>}
    </div>
  </OverlayDialog> : null;

  if (step === "pick" || !branchId) {
    return <div className="mobile-screen mx-auto w-full max-w-md px-4 pb-4 pt-4 lg:hidden" data-testid="mobile-quick-stock">
      <h2 className="text-center text-2xl font-black">¿Dónde querés cargar stock?</h2>
      <div className="mt-5 grid gap-3">
        {ordered.map((branch) => {
          const count = Object.keys(pending[branch.id] ?? {}).length;
          return <button className="flex min-h-20 items-center justify-between gap-3 rounded-2xl border border-stone-200 bg-white px-5 text-left shadow-sm active:bg-stone-50" key={branch.id} onClick={() => { setBranchId(branch.id); setQuery(""); setRows([]); setEditor(null); setNotice(null); go("list"); }} type="button">
            <span className="text-xl font-black uppercase tracking-wide">{branch.name}</span>
            {count ? <span className="shrink-0 rounded-full bg-amber-100 px-3 py-1 text-sm font-black text-amber-900">{productsText(count)} pendiente{count === 1 ? "" : "s"}</span> : <span aria-hidden="true" className="text-2xl text-stone-400">›</span>}
          </button>;
        })}
        {!ordered.length ? <Notice tone="info">No hay sucursales activas.</Notice> : null}
      </div>
      {pendingBar}
      {reviewDialog}
    </div>;
  }

  return <div className="mobile-screen mx-auto w-full max-w-md px-4 pb-4 pt-4 lg:hidden" data-testid="mobile-quick-stock">
    <label className="sticky top-14 z-20 -mx-4 -mt-1 block bg-[#f5f4f1] px-4 pb-2 pt-1"><span className="sr-only">Buscar producto</span>
      <input autoComplete="off" className={textInput} enterKeyHint="search" onChange={(event) => { setQuery(event.target.value); }} placeholder="Buscar producto o código…" type="search" value={query} />
    </label>
    {notice ? <div className="mt-3"><Notice tone={notice.startsWith("✓") ? "ok" : "warn"}>{notice}</Notice></div> : null}
    {searchError ? <div className="mt-3"><Notice tone="error">{searchError}</Notice></div> : null}
    <div className="mt-3 grid gap-3">
      {rows.map((row) => <ProductCard
        branchName={currentName ?? ""}
        change={getChange(pending, branchId, row.productId)}
        editor={editor?.productId === row.productId ? editor : null}
        key={row.productId}
        onCancel={() => { setEditor(null); setNotice(null); }}
        onConfirmCount={(raw) => { void confirmCount(row, raw); }}
        onEditorChange={(raw) => { setEditor((current) => current && { ...current, raw }); }}
        onOpen={(kind) => { setNotice(null); const existing = getChange(pending, branchId, row.productId); setEditor({ productId: row.productId, kind, raw: existing?.mode === kind ? existing.raw : "" }); }}
        onRemovePending={() => { setPending(removeChange(pending, branchId, row.productId)); }}
        onSave={(kind, raw) => { setPending(upsertChange(pending, { branchId, productId: row.productId, productName: row.name, unitType: row.unitType, mode: kind, raw: raw.trim() })); setEditor(null); }}
        row={row}
        saving={saving}
      />)}
      {!rows.length && !loading && !searchError ? <p className="rounded-2xl bg-white p-6 text-center text-base text-stone-500">{query ? `No encontramos productos con “${query}” en ${currentName ?? "esta sucursal"}.` : "Esta sucursal todavía no tiene productos habilitados."}</p> : null}
      {loading ? <p className="py-3 text-center text-base text-stone-500" role="status">Buscando…</p> : null}
      {!loading && rows.length < total ? <button className={secondaryButton} onClick={loadMore} type="button">Ver más ({rows.length} de {total})</button> : null}
    </div>
    {pendingBar}
    {reviewDialog}
  </div>;
}

function ResultView({ outcome, failures, onClose }: { outcome: QuickStockOutcome; failures: { name: string; branch: string; text: string }[]; onClose: () => void }) {
  const saved = outcome.applied + outcome.unchanged;
  return <div>
    {saved > 0 ? <div className="rounded-2xl bg-emerald-50 p-5 text-center"><p className="text-2xl font-black text-emerald-900">✓ Stock actualizado</p><p className="mt-1 text-lg text-emerald-900">{outcome.applied > 0 ? savedSummary(outcome) : "Todo coincidía con el sistema"}</p></div> : null}
    {failures.length ? <div className="mt-4 rounded-2xl bg-amber-50 p-4 text-amber-900" role="alert">
      <p className="text-lg font-black">No pudimos actualizar {productsText(failures.length)}</p>
      <ul className="mt-2 grid gap-2">{failures.map((failure, index) => <li className="text-base" key={`${failure.name}-${String(index)}`}><strong>{failure.name}</strong> · {failure.branch}<span className="block text-sm">{failure.text}</span></li>)}</ul>
      <p className="mt-2 text-sm">Siguen en la lista de pendientes para que los corrijas o los quites.</p>
    </div> : null}
    <button className={`${primaryButton} mt-5`} onClick={onClose} type="button">{failures.length ? "Entendido" : "Listo"}</button>
  </div>;
}

function ProductCard({ row, branchName, change, editor, saving, onOpen, onCancel, onEditorChange, onSave, onConfirmCount, onRemovePending }: {
  row: QuickStockRow;
  branchName: string;
  change: ReturnType<typeof getChange>;
  editor: { kind: EditorKind; raw: string } | null;
  saving: boolean;
  onOpen: (kind: EditorKind) => void;
  onCancel: () => void;
  onEditorChange: (raw: string) => void;
  onSave: (kind: QuickChangeMode, raw: string) => void;
  onConfirmCount: (raw: string) => void;
  onRemovePending: () => void;
}) {
  const unit = stockUnitLabel(row.unitType);
  return <article aria-label={row.name} className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
    <h3 className="text-lg font-black uppercase leading-snug">{row.name}</h3>
    <p className="mt-2 text-sm text-stone-500">Stock actual</p>
    <p className={`text-3xl font-black ${row.current <= 0 ? "text-amber-800" : "text-stone-900"}`}>{formatStockQuantity(row.current, row.unitType)}</p>
    {change ? <div className="mt-3 flex items-center justify-between gap-2 rounded-xl bg-amber-50 p-3 text-amber-900">
      <span className="text-base">Pendiente: <strong>{describeChange(change)}</strong></span>
      <button className="min-h-10 rounded-lg px-3 text-sm font-bold underline" onClick={onRemovePending} type="button">Quitar</button>
    </div> : null}
    <div className="mt-3 grid grid-cols-3 gap-2">
      {(["ADD", "REMOVE", "COUNT"] as const).map((kind) => <button aria-pressed={editor?.kind === kind} className={`min-h-12 rounded-xl border px-1 text-base font-black ${actionStyles[kind]} ${editor?.kind === kind ? "ring-2 ring-stone-400" : ""}`} disabled={saving} key={kind} onClick={() => { onOpen(kind); }} type="button">{actionLabels[kind]}</button>)}
    </div>
    {editor ? editor.kind === "COUNT"
      ? <CountEditor branchName={branchName} hasPending={change !== undefined} onCancel={onCancel} onConfirm={onConfirmCount} onRaw={onEditorChange} onRemovePending={onRemovePending} raw={editor.raw} row={row} saving={saving} unit={unit} />
      : <ChangeEditor kind={editor.kind} onCancel={onCancel} onRaw={onEditorChange} onSave={onSave} raw={editor.raw} row={row} unit={unit} /> : null}
  </article>;
}

function ChangeEditor({ kind, raw, row, unit, onRaw, onCancel, onSave }: { kind: QuickChangeMode; raw: string; row: QuickStockRow; unit: string; onRaw: (raw: string) => void; onCancel: () => void; onSave: (kind: QuickChangeMode, raw: string) => void }) {
  const parsed = raw.trim() ? parseChangeQuantity(raw, row.unitType) : null;
  const problem = parsed?.ok ? (kind === "REMOVE" ? removeProblem(row.current, parsed.quantity, row.unitType) : null) : parsed ? parsed.message : null;
  const valid = parsed?.ok === true && problem === null;
  return <div className="mt-3 rounded-xl bg-stone-50 p-3">
    <p className="text-lg font-black">{kind === "ADD" ? "Agregar" : "Quitar"}</p>
    <div className="mt-2 flex items-center gap-3">
      <input aria-label={kind === "ADD" ? "Cantidad a agregar" : "Cantidad a quitar"} autoComplete="off" autoFocus className={bigInput} enterKeyHint="done" inputMode={row.unitType === "WEIGHT" ? "decimal" : "numeric"} onChange={(event) => { onRaw(event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter" && valid) onSave(kind, raw); }} placeholder={row.unitType === "WEIGHT" ? "0,000" : "0"} value={raw} />
      <span className="w-8 shrink-0 text-lg font-black text-stone-600">{unit}</span>
    </div>
    {problem ? <p className="mt-2 text-sm font-bold text-red-700" role="alert">{problem}</p> : null}
    <div className="mt-3 grid grid-cols-[1fr_1.6fr] gap-2"><button className={secondaryButton} onClick={onCancel} type="button">Cancelar</button><button className={primaryButton} disabled={!valid} onClick={() => { onSave(kind, raw); }} type="button">Listo</button></div>
  </div>;
}

function CountEditor({ raw, row, unit, branchName, hasPending, saving, onRaw, onCancel, onConfirm, onRemovePending }: { raw: string; row: QuickStockRow; unit: string; branchName: string; hasPending: boolean; saving: boolean; onRaw: (raw: string) => void; onCancel: () => void; onConfirm: (raw: string) => void; onRemovePending: () => void }) {
  const preview = countPreview(raw, row.unitType, row.current);
  return <div className="mt-3 rounded-xl bg-sky-50 p-3">
    <p className="text-sm font-bold uppercase tracking-wide text-sky-900">{row.name} — {branchName}</p>
    <p className="mt-2 text-sm text-stone-600">Stock según sistema</p>
    <p className="text-2xl font-black">{formatStockQuantity(row.current, row.unitType)}</p>
    <p className="mt-3 text-lg font-black">¿Cuánto hay realmente?</p>
    <div className="mt-2 flex items-center gap-3">
      <input aria-label="Cantidad contada" autoComplete="off" autoFocus className={bigInput} enterKeyHint="done" inputMode={row.unitType === "WEIGHT" ? "decimal" : "numeric"} onChange={(event) => { onRaw(event.target.value); }} placeholder={row.unitType === "WEIGHT" ? "0,000" : "0"} value={raw} />
      <span className="w-8 shrink-0 text-lg font-black text-stone-600">{unit}</span>
    </div>
    {preview.state === "invalid" ? <p className="mt-2 text-sm font-bold text-red-700" role="alert">{preview.message}</p> : null}
    {preview.state === "ok" ? <div className="mt-3 rounded-xl bg-white p-3" data-testid="count-preview">
      <p className="text-sm text-stone-600">Diferencia</p>
      <p className={`text-2xl font-black ${preview.matches ? "text-emerald-800" : preview.difference < 0 ? "text-amber-900" : "text-sky-900"}`}>{preview.matches ? "Coincide" : `${preview.difference > 0 ? "+" : ""}${formatStockQuantity(preview.difference, row.unitType)}`}</p>
      <p className="mt-1 text-base text-stone-700">{preview.message}</p>
    </div> : null}
    {hasPending ? <div className="mt-3"><Notice tone="warn">Este producto tiene un cambio pendiente. Guardalo o quitalo antes de hacer un conteo.</Notice><button className={`${secondaryButton} mt-2`} onClick={onRemovePending} type="button">Quitar el cambio pendiente</button></div> : null}
    <div className="mt-3 grid gap-2">
      <button className={primaryButton} disabled={saving || hasPending || preview.state !== "ok" || preview.matches} onClick={() => { onConfirm(raw); }} type="button">{saving ? "Guardando…" : "Confirmar conteo"}</button>
      <button className={secondaryButton} disabled={saving} onClick={onCancel} type="button">Cancelar</button>
    </div>
  </div>;
}
