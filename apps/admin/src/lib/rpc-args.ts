/**
 * Los parámetros uuid de una función de Postgres aceptan NULL («sin carpeta», «sin sucursal») aunque los tipos generados los declaren
 * como `string` (sólo marcan opcionales los que tienen valor por defecto). Este puente deja el NULL explícito y en un único lugar.
 */
export function nullableArg(value: string | null): string {
  return value as unknown as string;
}
