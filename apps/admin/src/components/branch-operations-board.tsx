"use client";

import { formatCurrency, formatStockQuantity } from "@carnicerias/business-logic";
import { useState, type ReactNode } from "react";

import type { BranchBoardData, LowRotationView } from "../lib/branch-board";
import type { AttentionItem } from "../lib/branch-insights";
import { CarryPlanModal } from "./carry-plan-modal";
import { OverlayDialog } from "./overlay-dialog";
import { ProductInsightModal } from "./product-insight-modal";

type ListKind = "attention" | "rotation";
interface ProductRef { id: string; name: string }

const card = "rounded-xl bg-white p-4 shadow-sm";
const rowButton = "flex w-full items-start justify-between gap-3 rounded-lg px-2 py-2 text-left hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-rose-800";

function Block({ title, tag, children, footer }: { title: string; tag: string; children: ReactNode; footer?: ReactNode }) {
  return <section aria-label={title} className={`${card} flex flex-col`}>
    <div className="flex items-baseline justify-between gap-2"><h3 className="text-base font-black">{title}</h3><span className="text-xs font-bold text-stone-500">{tag}</span></div>
    <div className="mt-2 flex-1">{children}</div>
    {footer ? <div className="mt-2 border-t border-stone-100 pt-2">{footer}</div> : null}
  </section>;
}

const linkButton = "text-sm font-bold text-rose-800 hover:underline";

function AttentionRows({ items, onOpen }: { items: AttentionItem[]; onOpen: (product: ProductRef) => void }) {
  return <ul className="divide-y divide-stone-100">{items.map((item) => <li key={item.productId}><button className={rowButton} onClick={() => onOpen({ id: item.productId, name: item.productName })} type="button">
    <span className="min-w-0"><strong className="block truncate">{item.productName}</strong><span className="block text-sm text-stone-600">{item.detail}</span></span>
    <span className={`shrink-0 rounded-full px-2 py-1 text-xs font-black ${item.severity === "critical" ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-800"}`}>{item.headline}</span>
  </button></li>)}</ul>;
}

function RotationRows({ items, onOpen }: { items: LowRotationView[]; onOpen: (product: ProductRef) => void }) {
  return <ul className="divide-y divide-stone-100">{items.map((item) => <li key={item.productId}><button className={rowButton} onClick={() => onOpen({ id: item.productId, name: item.productName })} type="button">
    <span className="min-w-0"><strong className="block truncate">{item.productName}</strong><span className="block text-sm text-stone-600">{item.sold14d > 0 ? `${formatStockQuantity(item.sold14d, item.unitType)} vendidos en 14 días` : "Sin ventas en 14 días"} · {item.lastSaleText}</span><span className="block text-sm text-stone-500">Stock: {formatStockQuantity(item.current, item.unitType)}</span></span>
    {item.reason === "HIGH_COVERAGE" ? <span className="shrink-0 rounded-full bg-stone-200 px-2 py-1 text-xs font-black text-stone-700">{item.label}</span> : null}
  </button></li>)}</ul>;
}

/**
 * «Qué está pasando»: el centro operativo del Resumen de sucursal. Cuatro bloques compactos (Más vendidos, Qué llevar,
 * Baja rotación, Requiere atención) y, para profundizar, modales: producto, «qué llevar» y las listas completas. No hay
 * pantallas ni rutas nuevas: todo vive dentro del Resumen.
 */
export function BranchOperationsBoard({ branchId, branchName, timeZone, isProduction, board, stockCounts, unavailable }: {
  branchId: string;
  branchName: string;
  timeZone: string;
  isProduction: boolean;
  board: BranchBoardData | null;
  stockCounts: { out: number; low: number; normal: number };
  /** Motivo por el que no se pudo calcular el resumen operativo (el resto del Resumen sigue funcionando). */
  unavailable?: string | null;
}) {
  const [product, setProduct] = useState<ProductRef | null>(null);
  const [carryOpen, setCarryOpen] = useState(false);
  const [list, setList] = useState<ListKind | null>(null);

  if (!board) return <section aria-label="Qué está pasando" className="mt-6"><h2 className="text-xl font-black">Qué está pasando</h2><p className="mt-2 rounded-xl bg-amber-50 p-4 text-sm text-amber-900" role="status">No se pudo calcular el resumen operativo{unavailable ? `: ${unavailable}` : "."} Las métricas de arriba siguen siendo válidas.</p></section>;

  const carry = board.carry;
  return <section aria-label="Qué está pasando" className="mt-6">
    <h2 className="text-xl font-black">Qué está pasando</h2>
    <div className="mt-3 grid gap-4 lg:grid-cols-2">
      <Block tag={board.periodTag} title="Más vendidos" footer={board.topSellersTotal > board.topSellers.length ? <span className="text-xs text-stone-500">Top {String(board.topSellers.length)} de {String(board.topSellersTotal)} productos vendidos</span> : undefined}>
        {board.topSellers.length ? <ul className="divide-y divide-stone-100">{board.topSellers.map((seller) => <li key={seller.productId}><button className={rowButton} onClick={() => setProduct({ id: seller.productId, name: seller.productName })} type="button">
          <span className="min-w-0"><strong className="block truncate">{seller.productName}</strong><span className="block text-sm text-stone-600">{formatCurrency(BigInt(seller.revenueCents))}</span></span>
          <span className="shrink-0 text-right"><strong className="block">{formatStockQuantity(seller.quantity, seller.unitType)}</strong>{seller.trendPercent === null ? null : <span className={`block text-xs font-bold ${seller.trendPercent < 0 ? "text-red-700" : seller.trendPercent > 0 ? "text-emerald-700" : "text-stone-500"}`}>{seller.trendPercent < 0 ? "↓" : seller.trendPercent > 0 ? "↑" : "="} {String(Math.abs(seller.trendPercent))}% vs período anterior</span>}</span>
        </button></li>)}</ul> : <p className="py-3 text-sm text-stone-500">Sin ventas en este período.</p>}
      </Block>

      {carry === null ? <Block tag="Sucursal productiva" title="Qué llevar"><p className="py-3 text-sm text-stone-500">Esta es la sucursal productiva: es el origen de la carga, no un destino.</p></Block> : "error" in carry
        ? <Block tag="Últimos 7 días" title="Qué llevar"><p className="py-3 text-sm text-stone-600">{carry.error}</p></Block>
        : <Block tag="Últimos 7 días" title="Qué llevar" footer={<button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white hover:bg-rose-900" onClick={() => setCarryOpen(true)} type="button">{carry.needing > carry.preview.length ? `Ver carga (${String(carry.needing)} productos)` : "Ver carga"}</button>}>
          {carry.preview.length ? <ul className="divide-y divide-stone-100">{carry.preview.map((row) => <li key={row.productId}><button className={rowButton} onClick={() => setProduct({ id: row.productId, name: row.productName })} type="button">
            <span className="min-w-0"><strong className="block truncate">{row.productName}</strong><span className="block text-sm text-stone-500">Vendió {formatStockQuantity(row.soldQuantity, row.unitType)} · stock {row.currentQuantity <= 0 ? "sin stock" : formatStockQuantity(row.currentQuantity, row.unitType)}</span></span>
            <strong className="shrink-0 text-teal-700">{formatStockQuantity(row.suggestedQuantity, row.unitType)}</strong>
          </button></li>)}</ul> : <p className="py-3 text-sm text-emerald-700">No hace falta llevar nada: lo vendido en 7 días está cubierto por el stock.</p>}
        </Block>}

      {board.lowRotation ? <Block tag="Últimos 14 días" title="Baja rotación" footer={board.lowRotation.all.length > board.lowRotation.items.length ? <button className={linkButton} onClick={() => setList("rotation")} type="button">Ver todos ({String(board.lowRotation.all.length)})</button> : undefined}>
        {board.lowRotation.items.length ? <RotationRows items={board.lowRotation.items} onOpen={setProduct} /> : <p className="py-3 text-sm text-emerald-700">Ningún producto con stock parado.</p>}
      </Block> : null}

      <Block tag="Ventas y cobertura de 7 días" title="Requiere atención" footer={<div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-stone-500">Agotados {String(stockCounts.out)} · Bajo mínimo {String(stockCounts.low)} · Normal {String(stockCounts.normal)}</span>{board.attention.all.length > board.attention.items.length ? <button className={linkButton} onClick={() => setList("attention")} type="button">Ver todas ({String(board.attention.all.length)})</button> : null}</div>}>
        {board.attention.items.length ? <AttentionRows items={board.attention.items} onOpen={setProduct} /> : <p className="py-3 text-sm text-emerald-700">Sin alertas de stock.</p>}
      </Block>
    </div>

    {list === "attention" ? <OverlayDialog onClose={() => setList(null)} subtitle={`${String(board.attention.all.length)} productos · la más urgente primero`} title={`Requiere atención — ${branchName}`}><div className="mt-3 rounded-lg bg-white p-2 shadow-sm"><AttentionRows items={board.attention.all} onOpen={setProduct} /></div></OverlayDialog> : null}
    {list === "rotation" && board.lowRotation ? <OverlayDialog onClose={() => setList(null)} subtitle={`${String(board.lowRotation.all.length)} productos · últimos 14 días`} title={`Baja rotación — ${branchName}`}><div className="mt-3 rounded-lg bg-white p-2 shadow-sm"><RotationRows items={board.lowRotation.all} onOpen={setProduct} /></div></OverlayDialog> : null}
    {carryOpen ? <CarryPlanModal branchId={branchId} branchName={branchName} onClose={() => setCarryOpen(false)} timeZone={timeZone} /> : null}
    {product ? <ProductInsightModal branchId={branchId} branchName={branchName} isProduction={isProduction} onClose={() => setProduct(null)} productId={product.id} productName={product.name} timeZone={timeZone} /> : null}
  </section>;
}
