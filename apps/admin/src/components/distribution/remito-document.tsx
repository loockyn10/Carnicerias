import type { RemitoModel } from "../../lib/distribution/logic";
import { formatLocalDateTime } from "../../lib/date-range";

/**
 * Documento imprimible del remito OPERATIVO de una entrega. Se arma desde el modelo (`buildRemito`), que usa los datos del destinatario congelados al confirmar.
 * Es un documento interno de entrega: no es un remito ni una factura fiscal y lo dice en el encabezado y al pie.
 */
export function RemitoDocument({ remito, timezone }: { remito: RemitoModel; timezone: string }) {
  const { recipient } = remito;
  return <article className="mx-auto max-w-[210mm] bg-white p-8 text-sm text-stone-900 shadow-sm print:p-0 print:shadow-none" data-testid="remito" id="remito">
    <header className="border-b-2 border-stone-900 pb-3">
      <div className="flex items-start justify-between gap-4">
        <div><h1 className="text-2xl font-black tracking-tight">{remito.title}</h1><p className="mt-1 text-xs font-bold text-red-800" data-testid="remito-disclaimer">{remito.disclaimer}</p></div>
        <div className="text-right"><p className="text-3xl font-black tabular-nums" data-testid="remito-number">{remito.numberLabel}</p><p className="text-xs text-stone-600">{remito.statusLabel}</p></div>
      </div>
      {remito.isDraft ? <p className="mt-2 rounded border-2 border-dashed border-amber-600 p-2 text-center text-xs font-black uppercase text-amber-800">Borrador: la mercadería todavía no fue despachada</p> : null}
    </header>

    <section className="mt-4 grid grid-cols-2 gap-6 text-sm">
      <div>
        <h2 className="text-xs font-black uppercase tracking-wider text-stone-500">Destinatario</h2>
        <p className="text-base font-black">{recipient.name}</p>
        {recipient.legalName ? <p>{recipient.legalName}</p> : null}
        {recipient.taxId ? <p>CUIT {recipient.taxId}</p> : null}
        <p>Establecimiento: <strong>{recipient.site}</strong></p>
        {recipient.address || recipient.city ? <p>{[recipient.address, recipient.city].filter(Boolean).join(", ")}</p> : null}
        {recipient.contactName || recipient.phone ? <p>{[recipient.contactName, recipient.phone].filter(Boolean).join(" · ")}</p> : null}
      </div>
      <div>
        <h2 className="text-xs font-black uppercase tracking-wider text-stone-500">Entrega</h2>
        <p>Fecha: <strong>{remito.deliveryDate}</strong></p>
        <p>Origen: {remito.originBranchName}</p>
        <p>Modalidad: {remito.commercialModeLabel}</p>
        <p>Preparó: {remito.preparedBy ?? "—"}</p>
        {remito.confirmedAt ? <p>Despachó: {remito.confirmedBy ?? "—"} · {formatLocalDateTime(remito.confirmedAt, timezone)}</p> : null}
      </div>
    </section>

    <section className="mt-5">
      <h2 className="text-xs font-black uppercase tracking-wider text-stone-500">Resumen por producto</h2>
      <table className="mt-1 w-full border-collapse text-left" data-testid="remito-lines">
        <thead><tr className="border-b border-stone-900 text-xs"><th className="py-1 pr-2">Producto</th><th className="py-1 pr-2 text-right">Paquetes</th><th className="py-1 pr-2 text-right">Kilogramos</th><th className="py-1 pr-2 text-right">Valor comercial</th><th className="py-1">Lotes</th></tr></thead>
        <tbody>{remito.lines.map((line) => <tr className="border-b border-stone-200" key={line.productName}><td className="py-1 pr-2 font-bold">{line.productName}</td><td className="py-1 pr-2 text-right tabular-nums">{line.packages}</td><td className="py-1 pr-2 text-right tabular-nums">{line.kilograms}</td><td className="py-1 pr-2 text-right tabular-nums">{line.value}</td><td className="py-1 text-xs">{line.lots}</td></tr>)}</tbody>
        <tfoot><tr className="border-t-2 border-stone-900 font-black"><td className="py-1 pr-2">TOTAL</td><td className="py-1 pr-2 text-right tabular-nums" data-testid="remito-total-packages">{remito.totals.packages}</td><td className="py-1 pr-2 text-right tabular-nums">{remito.totals.kilograms}</td><td className="py-1 pr-2 text-right tabular-nums">{remito.totals.value}</td><td /></tr></tfoot>
      </table>
    </section>

    <section className="mt-5 break-inside-avoid-page">
      <h2 className="text-xs font-black uppercase tracking-wider text-stone-500">Detalle de paquetes (identificador logístico)</h2>
      <table className="mt-1 w-full border-collapse text-left text-xs" data-testid="remito-packages">
        <thead><tr className="border-b border-stone-900"><th className="py-1 pr-2">Código</th><th className="py-1 pr-2">Producto</th><th className="py-1 pr-2">Lote</th><th className="py-1 pr-2 text-right">Peso</th><th className="py-1 pr-2">Elaboración</th><th className="py-1 pr-2">Vencimiento</th><th className="py-1 text-right">Valor</th></tr></thead>
        <tbody>{remito.packages.map((pkg) => <tr className="border-b border-stone-200" key={`${pkg.code}-${pkg.lot}`}><td className="py-0.5 pr-2 font-mono">{pkg.code}</td><td className="py-0.5 pr-2">{pkg.productName}</td><td className="py-0.5 pr-2">{pkg.lot}</td><td className="py-0.5 pr-2 text-right tabular-nums">{pkg.weight}</td><td className="py-0.5 pr-2">{pkg.packedOn}</td><td className="py-0.5 pr-2">{pkg.expiresOn}</td><td className="py-0.5 text-right tabular-nums">{pkg.value}</td></tr>)}</tbody>
      </table>
    </section>

    {remito.notes ? <p className="mt-4 text-xs"><strong>Observaciones:</strong> {remito.notes}</p> : null}
    <section className="mt-12 grid grid-cols-2 gap-10 text-center text-xs"><div className="border-t border-stone-900 pt-1">Entregó (Carnicerías Fran)</div><div className="border-t border-stone-900 pt-1">Recibió (nombre, firma y aclaración)</div></section>
    <footer className="mt-6 border-t border-stone-300 pt-2 text-center text-[10px] text-stone-500">{remito.disclaimer} Los valores son precios comerciales de los paquetes: no constituyen una factura.</footer>
  </article>;
}
