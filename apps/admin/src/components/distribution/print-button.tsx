"use client";

import { primaryButton } from "./ui";

/** Abre el diálogo de impresión del navegador (el remito se imprime en hoja A4 con los estilos de impresión de la página). */
export function PrintButton({ label = "Imprimir" }: { label?: string }) {
  return <button className={primaryButton} onClick={() => { window.print(); }} type="button">{label}</button>;
}
