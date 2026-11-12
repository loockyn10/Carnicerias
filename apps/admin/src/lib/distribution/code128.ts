/**
 * Code 128 (subconjunto B: ASCII 32–126) para el identificador logístico de los paquetes. Local (sin librería ni servicio web) y de salida idéntica a la que arma
 * cualquier lector: se dibuja como barras, igual que el EAN-13 comercial (`vacuum-ean.ts`). Los módulos son una cadena de «1» (barra) y «0» (espacio).
 *
 * La tabla de anchos es la del estándar (107 símbolos de 6 elementos que suman 11 módulos, y el de parada de 7 que suma 13); la prueba verifica sus propiedades
 * (suma 11, ancho total de barras par, unicidad) y decodifica lo que se arma para confirmar el dígito de control.
 */

const WIDTHS: readonly string[] = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
  "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
  "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313", "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
  "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
  "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
  "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412", "211214", "211232"
];
const STOP_WIDTHS = "2331112";
const START_B = 104;

export const CODE128_PATTERNS = WIDTHS;

function toModules(widths: string): string {
  let bits = "";
  Array.from(widths).forEach((width, index) => { bits += (index % 2 === 0 ? "1" : "0").repeat(Number(width)); });
  return bits;
}

/** Valor del símbolo de un carácter en el subconjunto B. */
export function code128BValue(char: string): number {
  const code = char.charCodeAt(0);
  if (char.length !== 1 || code < 32 || code > 126) throw new RangeError(`Code 128 B no admite el carácter «${char}»`);
  return code - 32;
}

/** Dígito de control (módulo 103) de los valores de datos, con el inicio B de peso 0 y cada dato con su posición. */
export function code128Checksum(values: readonly number[]): number {
  return (START_B + values.reduce((sum, value, index) => sum + value * (index + 1), 0)) % 103;
}

/** Los módulos de un Code 128 B completo: inicio, datos, control y parada (sin zonas de silencio). */
export function code128Modules(text: string): string {
  if (text === "") throw new RangeError("Code 128: el texto no puede estar vacío");
  const values = Array.from(text, code128BValue);
  const symbols = [START_B, ...values, code128Checksum(values)];
  return symbols.map((symbol) => toModules(WIDTHS[symbol] ?? "")).join("") + toModules(STOP_WIDTHS);
}

/** Cantidad de módulos de un Code 128 B de `length` caracteres (sin zonas de silencio). */
export function code128ModuleCount(length: number): number {
  return 11 * (length + 2) + 13;
}

/** Decodifica módulos Code 128 B de vuelta al texto verificando el control (para las pruebas; al imprimir no se usa). */
export function decodeCode128BModules(modules: string): string {
  const stopStart = modules.length - 13;
  if (stopStart < 22 || modules.slice(stopStart) !== toModules(STOP_WIDTHS)) throw new RangeError("Code 128 inválido: falta la parada");
  const body = modules.slice(0, stopStart);
  if (body.length % 11 !== 0) throw new RangeError("Code 128 inválido: largo");
  const symbols: number[] = [];
  for (let index = 0; index < body.length; index += 11) {
    const symbol = WIDTHS.findIndex((widths) => toModules(widths) === body.slice(index, index + 11));
    if (symbol < 0) throw new RangeError("Code 128 inválido: símbolo desconocido");
    symbols.push(symbol);
  }
  if (symbols[0] !== START_B) throw new RangeError("Code 128 inválido: no es el subconjunto B");
  const check = symbols.at(-1) ?? -1;
  const values = symbols.slice(1, -1);
  if (code128Checksum(values) !== check) throw new RangeError("Code 128 inválido: el dígito de control no coincide");
  return values.map((value) => String.fromCharCode(value + 32)).join("");
}
