import type { LabelRotation, StationPrintKind } from "./config";
import { MM_PER_PT, type VacuumLabelDims } from "../vacuum-label-spec";
import { buildVacuumLabelLayout, packageToLabelData, type VacuumLabelKind, type VacuumLabelLayout } from "../vacuum-label-layout";
import { vacuumDims, type VacuumPackage } from "../vacuum";

/**
 * IMPRESIÓN DE ETIQUETAS DESDE EL NAVEGADOR con el tamaño exacto del papel.
 *
 * Por qué no se imprime el PDF en un iframe (como hacía el módulo manual): el visor de PDF del navegador decide el tamaño de hoja y el sentido por su
 * cuenta —toma el papel que tenga por defecto el controlador de la impresora y gira o escala la página para que «entre»—, y el único dato que
 * recibe el controlador es esa hoja. Con una impresora térmica de rollo eso se traduce en avances de papel sin imprimir y etiquetas giradas de costado.
 * Acá cada etiqueta es su PROPIO documento HTML con un único SVG en milímetros y `@page { size: ancho alto; margin: 0 }`: el navegador le pasa al
 * controlador exactamente ese tamaño, sin márgenes, sin escalado y sin saltos de página extra. Una etiqueta = un trabajo de impresión (la informativa
 * y la de precio pueden tener alturas distintas y un trabajo no puede mezclar tamaños de hoja).
 *
 * Es el MISMO layout (`vacuum-label-layout.ts`) que usan la vista previa y el PDF: ningún número del diseño se copió.
 */

const FONT_FAMILY = "Helvetica, Arial, 'Liberation Sans', sans-serif";

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const n = (value: number) => String(Math.round(value * 1000) / 1000);

export interface LabelPrintPage {
  /** Tamaño real de la hoja (ya con el giro aplicado), en mm. */
  pageWidthMm: number;
  pageHeightMm: number;
  svg: string;
}

/** Transformación del contenido para girarlo `rotation` grados en sentido horario dentro de una hoja del tamaño girado. */
function rotationTransform(rotation: LabelRotation, widthMm: number, heightMm: number): string {
  switch (rotation) {
    case 90: return `matrix(0 1 -1 0 ${n(heightMm)} 0)`;
    case 180: return `matrix(-1 0 0 -1 ${n(widthMm)} ${n(heightMm)})`;
    case 270: return `matrix(0 -1 1 0 0 ${n(widthMm)})`;
    case 0: return "";
  }
}

/** El SVG de una etiqueta, en milímetros (1 unidad = 1 mm), con el giro de calibración aplicado. */
export function buildLabelPage(layout: VacuumLabelLayout, rotation: LabelRotation): LabelPrintPage {
  const swap = rotation === 90 || rotation === 270;
  const pageWidthMm = swap ? layout.heightMm : layout.widthMm;
  const pageHeightMm = swap ? layout.widthMm : layout.heightMm;
  const parts: string[] = [];
  parts.push(`<rect x="0" y="0" width="${n(layout.widthMm)}" height="${n(layout.heightMm)}" fill="#fff"/>`);
  for (const rect of layout.rects) {
    parts.push(rect.fill
      ? `<rect x="${n(rect.x)}" y="${n(rect.y)}" width="${n(rect.width)}" height="${n(rect.height)}" fill="#000"/>`
      : `<rect x="${n(rect.x)}" y="${n(rect.y)}" width="${n(rect.width)}" height="${n(rect.height)}" fill="none" stroke="#000" stroke-width="${n(rect.strokeMm)}"/>`);
  }
  for (const rule of layout.rules) {
    parts.push(`<line x1="${n(rule.x1)}" y1="${n(rule.y1)}" x2="${n(rule.x2)}" y2="${n(rule.y2)}" stroke="#000" stroke-width="${n(rule.widthMm)}"/>`);
  }
  // Las barras del código van sin suavizado: un borde gris en una barra de 0,3 mm le quita contraste al lector.
  for (const bar of layout.bars) {
    parts.push(`<rect x="${n(bar.x)}" y="${n(bar.y)}" width="${n(bar.width)}" height="${n(bar.height)}" fill="#000" shape-rendering="crispEdges"/>`);
  }
  for (const text of layout.texts) {
    const anchor = text.anchor === "middle" ? "middle" : text.anchor === "end" ? "end" : "start";
    parts.push(
      `<text x="${n(text.x)}" y="${n(text.y)}" font-family="${FONT_FAMILY}" font-size="${n(text.sizePt * MM_PER_PT)}" font-weight="${text.style === "regular" ? "400" : "700"}"` +
      `${text.style === "boldItalic" ? ' font-style="italic"' : ""} text-anchor="${anchor}" fill="${text.inverse ? "#fff" : "#000"}" style="font-kerning:none;white-space:pre">${escapeXml(text.text)}</text>`
    );
  }
  const transform = rotationTransform(rotation, layout.widthMm, layout.heightMm);
  const body = transform === "" ? parts.join("") : `<g transform="${transform}">${parts.join("")}</g>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${n(pageWidthMm)}mm" height="${n(pageHeightMm)}mm" viewBox="0 0 ${n(pageWidthMm)} ${n(pageHeightMm)}" data-label-kind="${layout.kind}">${body}</svg>`;
  return { pageWidthMm, pageHeightMm, svg };
}

/** Documento HTML de UNA etiqueta: hoja del tamaño exacto, sin márgenes y sin nada más que el dibujo. */
export function buildLabelDocument(page: LabelPrintPage, title: string): string {
  const width = `${n(page.pageWidthMm)}mm`;
  const height = `${n(page.pageHeightMm)}mm`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escapeXml(title)}</title><style>` +
    `@page{size:${width} ${height};margin:0}` +
    `html,body{margin:0;padding:0;background:#fff;width:${width};height:${height};overflow:hidden}` +
    `svg{display:block;width:${width};height:${height};break-inside:avoid;break-after:avoid;page-break-after:avoid}` +
    `@media print{html,body{width:${width};height:${height}}}` +
    `</style></head><body>${page.svg}</body></html>`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Etiquetas de un paquete y etiqueta de prueba
// ---------------------------------------------------------------------------------------------------------------------

export function kindsOf(kind: StationPrintKind): VacuumLabelKind[] {
  return kind === "BOTH" ? ["INFO", "PRICE"] : [kind];
}

export interface LabelJob {
  kind: VacuumLabelKind;
  title: string;
  html: string;
  widthMm: number;
  heightMm: number;
}

/** Los trabajos de impresión de un paquete REGISTRADO: las medidas y el contenido salen del snapshot del paquete, nunca de valores actuales. */
export function buildPackageJobs(pkg: VacuumPackage, kind: StationPrintKind, rotation: LabelRotation): LabelJob[] {
  const dims = vacuumDims({ labelWidthMm: pkg.dims.widthMm, infoHeightMm: pkg.dims.infoHeightMm, priceHeightMm: pkg.dims.priceHeightMm });
  const data = packageToLabelData(pkg);
  return kindsOf(kind).map((labelKind) => {
    const layout = buildVacuumLabelLayout(labelKind, data, dims);
    const page = buildLabelPage(layout, rotation);
    const title = `Envasado ${pkg.lot} - ${labelKind === "INFO" ? "informativa" : "precio"}`;
    return { kind: labelKind, title, html: buildLabelDocument(page, title), widthMm: page.pageWidthMm, heightMm: page.pageHeightMm };
  });
}

/**
 * Etiqueta de CALIBRACIÓN: no es un paquete (no se registra nada). Dibuja el borde exacto de la etiqueta, una regla en milímetros y los lados
 * (ARRIBA/ABAJO/IZQ./DER.), así se ve de un vistazo si el papel avanza lo justo, si el contenido sale girado, si se recorta algún margen o si se
 * escaló la página.
 */
export function buildTestLayout(kind: VacuumLabelKind, dims: VacuumLabelDims, rotation: LabelRotation): VacuumLabelLayout {
  const widthMm = dims.widthMm;
  const heightMm = kind === "INFO" ? dims.infoHeightMm : dims.priceHeightMm;
  const rects: VacuumLabelLayout["rects"] = [{ id: "border", x: 0.4, y: 0.4, width: widthMm - 0.8, height: heightMm - 0.8, fill: false, strokeMm: 0.4 }];
  const rules: VacuumLabelLayout["rules"] = [
    { id: "cross-h", x1: widthMm / 2 - 3, y1: heightMm / 2, x2: widthMm / 2 + 3, y2: heightMm / 2, widthMm: 0.2 },
    { id: "cross-v", x1: widthMm / 2, y1: heightMm / 2 - 3, x2: widthMm / 2, y2: heightMm / 2 + 3, widthMm: 0.2 }
  ];
  // Regla en la parte de arriba: una marca cada 5 mm, más larga cada 10 mm. Si la impresión salió escalada, 10 marcas ya no miden 10 mm.
  for (let mm = 5; mm < widthMm - 4; mm += 5) {
    rules.push({ id: `tick-${String(mm)}`, x1: mm, y1: 0.8, x2: mm, y2: mm % 10 === 0 ? 3.6 : 2.4, widthMm: 0.2 });
  }
  // Flecha hacia ARRIBA (tres líneas, sin depender de que la fuente tenga el símbolo).
  const ax = widthMm / 2;
  rules.push({ id: "arrow-stem", x1: ax, y1: 5.2, x2: ax, y2: 9.2, widthMm: 0.3 }, { id: "arrow-l", x1: ax, y1: 5.2, x2: ax - 1.4, y2: 6.8, widthMm: 0.3 }, { id: "arrow-r", x1: ax, y1: 5.2, x2: ax + 1.4, y2: 6.8, widthMm: 0.3 });
  const texts: VacuumLabelLayout["texts"] = [
    { id: "title", text: "PRUEBA DE IMPRESIÓN", x: ax, y: Math.min(heightMm - 12, 13), sizePt: 8, style: "bold", anchor: "middle" },
    { id: "size", text: `${n(widthMm)} × ${n(heightMm)} mm`, x: ax, y: heightMm / 2 + 8, sizePt: 11, style: "bold", anchor: "middle" },
    { id: "sub", text: `${kind === "INFO" ? "Informativa" : "Precio"} · giro ${String(rotation)}° · no es un paquete`, x: ax, y: heightMm - 3.6, sizePt: 5.5, style: "regular", anchor: "middle" },
    { id: "left", text: "IZQ", x: 1.4, y: heightMm / 2 + 1, sizePt: 5, style: "bold", anchor: "start" },
    { id: "right", text: "DER", x: widthMm - 1.4, y: heightMm / 2 + 1, sizePt: 5, style: "bold", anchor: "end" }
  ];
  return { kind, widthMm, heightMm, texts, rules, rects, bars: [], overflow: false };
}

export function buildTestJobs(dims: VacuumLabelDims, kind: StationPrintKind, rotation: LabelRotation): LabelJob[] {
  return kindsOf(kind).map((labelKind) => {
    const page = buildLabelPage(buildTestLayout(labelKind, dims, rotation), rotation);
    const title = `Prueba de impresión - ${labelKind === "INFO" ? "informativa" : "precio"}`;
    return { kind: labelKind, title, html: buildLabelDocument(page, title), widthMm: page.pageWidthMm, heightMm: page.pageHeightMm };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Envío al navegador (sólo en el navegador)
// ---------------------------------------------------------------------------------------------------------------------

export type HtmlPrintOutcome =
  | { ok: true; /** true si el navegador abrió el diálogo de impresión (no es silenciosa: alguien tiene que confirmarla). */ dialogShown: boolean }
  | { ok: false; error: string };

/** Si `print()` tarda más que esto es porque el navegador abrió el diálogo y esperó al operario. */
export const PRINT_DIALOG_THRESHOLD_MS = 1_500;

let queue: Promise<unknown> = Promise.resolve();

/**
 * Manda UN documento HTML a imprimir a través de un iframe oculto y devuelve cuando el navegador terminó de enviarlo. Los trabajos se encolan: nunca hay dos
 * impresiones a la vez. IMPORTANTE: que `window.print()` vuelva sin error significa que el navegador aceptó el trabajo, NO que la etiqueta salió de la
 * impresora: eso sólo lo confirma una persona mirando el papel (por eso existe la prueba de impresión y el botón «Reimprimir»).
 */
export function printHtmlDocument(html: string, timeoutMs = 20_000): Promise<HtmlPrintOutcome> {
  const run = queue.then(() => printOnce(html, timeoutMs), () => printOnce(html, timeoutMs));
  queue = run.catch(() => undefined);
  return run;
}

function printOnce(html: string, timeoutMs: number): Promise<HtmlPrintOutcome> {
  return new Promise<HtmlPrintOutcome>((resolve) => {
    if (typeof document === "undefined") { resolve({ ok: false, error: "La impresión sólo funciona en el navegador." }); return; }
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText = "position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0;visibility:hidden";
    let settled = false;
    const finish = (outcome: HtmlPrintOutcome) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      // El iframe se conserva un rato: algunos controladores leen el documento después de que print() volvió.
      window.setTimeout(() => { frame.remove(); }, 60_000);
      resolve(outcome);
    };
    const timer = window.setTimeout(() => { finish({ ok: false, error: "El navegador no confirmó el envío a la impresora (tiempo agotado)." }); }, timeoutMs);
    frame.onload = () => {
      const target = frame.contentWindow;
      if (!target) { finish({ ok: false, error: "No se pudo preparar la impresión." }); return; }
      // Dos cuadros de animación: asegura que el SVG ya se pintó antes de pedir la impresión.
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          try {
            const startedAt = performance.now();
            target.focus();
            target.print();
            finish({ ok: true, dialogShown: performance.now() - startedAt > PRINT_DIALOG_THRESHOLD_MS });
          } catch (error) {
            finish({ ok: false, error: error instanceof Error ? `No se pudo enviar a imprimir: ${error.message}` : "No se pudo enviar a imprimir." });
          }
        });
      });
    };
    frame.srcdoc = html;
    document.body.append(frame);
  });
}

export interface PrintJobsOutcome {
  ok: boolean;
  error: string | null;
  dialogShown: boolean;
  /** Tipos de etiqueta que se enviaron bien (para reimprimir sólo la que falló). */
  sent: VacuumLabelKind[];
}

/** Imprime los trabajos en orden. Si uno falla se corta y se informa cuáles ya se enviaron (para no repetir la que salió bien). */
export async function printJobs(jobs: LabelJob[], printer: (html: string) => Promise<HtmlPrintOutcome> = printHtmlDocument): Promise<PrintJobsOutcome> {
  const sent: VacuumLabelKind[] = [];
  let dialogShown = false;
  for (const job of jobs) {
    const outcome = await printer(job.html);
    if (!outcome.ok) {
      const sentText = sent.length > 0 ? ` Ya se envió la etiqueta ${sent.includes("INFO") ? "informativa" : "de precio"}.` : "";
      return { ok: false, error: `${outcome.error}${sentText}`, dialogShown, sent };
    }
    dialogShown ||= outcome.dialogShown;
    sent.push(job.kind);
  }
  return { ok: true, error: null, dialogShown, sent };
}
