/**
 * Formas orgánicas de las piezas (mancha detrás del producto, mancha del precio, sello de ahorro). Puras y determinísticas: la misma
 * semilla da siempre la misma forma (regenerar una pieza nunca la cambia) y las usan el preview y el PNG (Satori) por igual. Todo en un
 * lienzo de 100 × 100 que cada renderer estira al rectángulo que corresponda.
 */

export interface Point { x: number; y: number }

/** Número pseudoaleatorio estable en [0, 1) a partir de un entero (mismo valor para la misma semilla y posición). */
function unit(seed: number, index: number): number {
  let h = Math.imul(seed | 0, 374761393) + Math.imul(index + 1, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Mancha orgánica cerrada: `points` anclas repartidas alrededor del centro con radios algo distintos (según `wobble`, 0 = óvalo), unidas con
 * curvas suaves (Catmull-Rom → Bézier). Devuelve el atributo `d` de un `<path>` dentro de 0..100 (nunca se sale del lienzo).
 */
export function organicBlobPath(seed: number, options: { points?: number; wobble?: number } = {}): string {
  const count = Math.max(5, Math.min(12, Math.trunc(options.points ?? 8)));
  const wobble = Math.max(0, Math.min(0.35, options.wobble ?? 0.16));
  const anchors: Point[] = [];
  const offset = unit(seed, 99) * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const angle = offset + (i / count) * Math.PI * 2;
    const radius = 0.5 * (1 - wobble * unit(seed, i));
    anchors.push({ x: 50 + Math.cos(angle) * radius * 100, y: 50 + Math.sin(angle) * radius * 100 });
  }
  const at = (i: number): Point => anchors[((i % count) + count) % count] ?? { x: 50, y: 50 };
  let d = `M${String(round(at(0).x))} ${String(round(at(0).y))}`;
  for (let i = 0; i < count; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C${String(round(c1.x))} ${String(round(c1.y))} ${String(round(c2.x))} ${String(round(c2.y))} ${String(round(p2.x))} ${String(round(p2.y))}`;
  }
  return `${d} Z`;
}

/** Vértices de un sello de `spikes` puntas (estrella de punta redondeada por el radio interior) dentro de 0..100: atributo `points` de `<polygon>`. */
export function burstPoints(spikes: number, innerRatio = 0.86): string {
  const count = Math.max(8, Math.min(40, Math.trunc(spikes)));
  const points: string[] = [];
  for (let i = 0; i < count * 2; i++) {
    const radius = (i % 2 === 0 ? 50 : 50 * innerRatio);
    const angle = (i / (count * 2)) * Math.PI * 2 - Math.PI / 2;
    points.push(`${String(round(50 + Math.cos(angle) * radius))},${String(round(50 + Math.sin(angle) * radius))}`);
  }
  return points.join(" ");
}

/** Semilla estable de un texto (para elegir forma/variante de una pieza a partir de su id, sin azar). */
export function seedFromText(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Contorno de la mancha del precio: una «squircle» (rectángulo de esquinas muy suaves) con un leve temblor de pulso en cada punto, como un
 * recorte hecho a mano. Cubre bien un texto ancho (a diferencia de una mancha libre estirada) y nunca se sale de 0..100.
 * `points` vértices (a más puntos, más lisa), `squareness` 2 = elipse … 6 = casi rectángulo, `jitter` = fracción de temblor (≈ 0,02).
 */
export function organicPillPath(seed: number, options: { points?: number; squareness?: number; jitter?: number } = {}): string {
  const count = Math.max(24, Math.min(120, Math.trunc(options.points ?? 72)));
  const power = 2 / Math.max(2, Math.min(8, options.squareness ?? 4.2));
  const jitter = Math.max(0, Math.min(0.06, options.jitter ?? 0.022));
  const coords: string[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const radius = 1 - jitter * unit(seed, Math.floor(i / 3));
    const x = 50 + 50 * radius * Math.sign(cos) * Math.abs(cos) ** power;
    const y = 50 + 50 * radius * Math.sign(sin) * Math.abs(sin) ** power;
    coords.push(`${String(round(x))} ${String(round(y))}`);
  }
  return `M${coords.join(" L")} Z`;
}
