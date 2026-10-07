const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ¿Es un UUID con la forma canónica (8-4-4-4-12)? */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
