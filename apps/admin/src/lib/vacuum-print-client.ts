import type { VacuumPrintKind } from "./vacuum";

/**
 * Impresión desde el navegador de la computadora que tiene la impresora térmica conectada (sin impresión remota ni RAW): se pide el PDF al
 * servidor, se carga en un iframe oculto y se abre el diálogo de impresión del sistema. Si el navegador bloquea el diálogo, queda el PDF para abrir
 * a mano. Sólo corre en el navegador.
 */

export type PdfResult = { ok: true; blob: Blob; pages: number; overflow: string[] } | { ok: false; error: string };

export async function requestVacuumPdf(packageId: string, kind: VacuumPrintKind): Promise<PdfResult> {
  try {
    const response = await fetch("/api/vacuum/labels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ packageId, kind }) });
    if (!response.ok || !response.headers.get("Content-Type")?.includes("application/pdf")) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: body?.error ?? "No se pudo generar el PDF de las etiquetas" };
    }
    const overflow = (response.headers.get("X-Label-Overflow") ?? "").split(",").filter(Boolean);
    return { ok: true, blob: await response.blob(), pages: Number(response.headers.get("X-Label-Pages") ?? "1"), overflow };
  } catch {
    return { ok: false, error: "No se pudo generar el PDF. Revisá la conexión y reintentá." };
  }
}

/** Abre el diálogo de impresión con el PDF. Devuelve false si el navegador no lo permitió (usá `openBlob` como alternativa). */
export function printPdfBlob(blob: Blob): Promise<boolean> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    let settled = false;
    const cleanup = () => { window.setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 300_000); };
    const finish = (printed: boolean) => { if (settled) return; settled = true; cleanup(); resolve(printed); };
    frame.onload = () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
        finish(true);
      } catch {
        finish(false);
      }
    };
    frame.src = url;
    document.body.append(frame);
    // Si el visor de PDF nunca dispara `load`, no se deja la pantalla esperando.
    window.setTimeout(() => { finish(false); }, 8_000);
  });
}

/** Abre el PDF en otra pestaña (alternativa cuando el diálogo de impresión no pudo abrirse solo). */
export function openPdfBlob(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener");
  window.setTimeout(() => { URL.revokeObjectURL(url); }, 60_000);
}
