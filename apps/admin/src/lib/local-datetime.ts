/**
 * «Vigente desde» de un costo o un precio: el operador elige fecha y hora en la zona horaria de la organización (`<input type="datetime-local">`
 * entrega «AAAA-MM-DDTHH:mm» sin zona) y la base necesita un instante. Se convierte acá, con la zona de la organización, nunca con la del
 * servidor de Next ni la del navegador.
 */

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Desfase (ms) de `timeZone` respecto de UTC en el instante `instantMs`. */
function zoneOffsetMs(timeZone: string, instantMs: number): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(new Date(instantMs)).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** «2026-11-05T08:30» en `timeZone` → ISO UTC. null si el texto no es una fecha/hora válida. */
export function localDateTimeToIso(value: string, timeZone: string): string | null {
  const match = LOCAL.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number) as [number, number, number, number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day || hour > 23 || minute > 59) return null;
  const guess = probe.getTime();
  // Dos pasadas: el desfase puede cambiar entre el instante «ingenuo» y el real (cambios horarios).
  const first = guess - zoneOffsetMs(timeZone, guess);
  const second = guess - zoneOffsetMs(timeZone, first);
  return new Date(second).toISOString();
}
