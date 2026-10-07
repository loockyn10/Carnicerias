/** Para pruebas: el valor tiene que existir (un `!` dispara la regla no-non-null-assertion y un `as` la de estilo). */
export function must<T>(value: T | null | undefined, what = "valor"): T {
  if (value === null || value === undefined) throw new Error(`Falta ${what}`);
  return value;
}
