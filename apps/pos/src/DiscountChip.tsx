import type { ReactNode } from "react";

import { discountPalette, type DiscountPalette } from "./lib/discount-chips";

/**
 * Chip de un descuento (un escalón por cantidad o el Pack) en la lista, la grilla y el diálogo de cantidad. Una condición = un chip: el texto
 * siempre dice la condición («desde 3 u», «Pack 10 u»), el color sólo ayuda a distinguirlas. Compacto: no hace crecer la fila del producto.
 */
export function DiscountChip({ kind, tierIndex, palette, size = "sm", className = "", children }: {
  kind?: "PACK" | "PROMO";
  tierIndex?: number | undefined;
  /** Paleta ya resuelta (tiene prioridad sobre `kind`/`tierIndex`). */
  palette?: DiscountPalette;
  /** `sm` = fila de la lista (11 px); `md` = diálogo de cantidad (más grande para leerlo desde cierta distancia). */
  size?: "sm" | "md";
  className?: string;
  children: ReactNode;
}) {
  const resolved = palette ?? discountPalette(kind ?? "PROMO", tierIndex);
  const sizing = size === "md" ? "px-2 py-0.5 text-sm" : "px-1.5 py-px text-[11px]";
  return (
    <span className={`shrink-0 whitespace-nowrap rounded font-bold ring-1 ring-inset ${sizing} ${resolved.chip} ${className}`} data-discount-variant={resolved.variant}>
      {children}
    </span>
  );
}
