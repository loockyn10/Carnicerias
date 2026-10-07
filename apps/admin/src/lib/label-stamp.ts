/** Fecha y hora en la zona horaria de la organización, para nombres de archivo e historial («20261007-1542» y «07/10/2026 15:42»). */
export function formatRunStamp(date: Date, timeZone: string): { file: string; display: string } {
  const parts = new Intl.DateTimeFormat("es-AR", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const [day, month, year, hour, minute] = [get("day"), get("month"), get("year"), get("hour"), get("minute")];
  return { file: `${year}${month}${day}-${hour}${minute}`, display: `${day}/${month}/${year} ${hour}:${minute}` };
}

/** ISO de la base → «07/10/2026 15:42»; texto vacío si la fecha no es válida. */
export function formatIsoStamp(iso: string, timeZone: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : formatRunStamp(date, timeZone).display;
}
