export type StockPriority = "CRÍTICO" | "ALTO" | "DISPONIBLE" | "INACTIVO";

export function stockPriority(status: string | null, current: number, minimum: number): { label: StockPriority; className: string; rank: number } {
  if (status === "DISCONTINUED") return { label: "INACTIVO", className: "bg-stone-200 text-stone-700", rank: 3 };
  if (status === "OUT_OF_STOCK" || status === "CRITICAL" || current <= 0) return { label: "CRÍTICO", className: "bg-red-100 text-red-800", rank: 0 };
  if (status === "LOW_STOCK" || status === "LOW" || current < minimum) return { label: "ALTO", className: "bg-amber-100 text-amber-800", rank: 1 };
  return { label: "DISPONIBLE", className: "bg-emerald-100 text-emerald-800", rank: 2 };
}

export function localDayStart(timeZone: string, daysAgo = 0) {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const day = Object.fromEntries(formatter.formatToParts(new Date()).map((part) => [part.type, part.value]));
  const midnightGuess = Date.UTC(Number(day.year), Number(day.month) - 1, Number(day.day) - daysAgo);
  const rendered = Object.fromEntries(formatter.formatToParts(new Date(midnightGuess)).map((part) => [part.type, part.value]));
  const renderedAsUtc = Date.UTC(Number(rendered.year), Number(rendered.month) - 1, Number(rendered.day), Number(rendered.hour), Number(rendered.minute), Number(rendered.second));
  return new Date(midnightGuess + midnightGuess - renderedAsUtc).toISOString();
}
