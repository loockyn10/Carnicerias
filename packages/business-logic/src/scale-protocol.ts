/**
 * Protocolos de balanza por puerto serie, sin I/O: convierten BYTES en lecturas de peso en GRAMOS ENTEROS (el dominio nunca usa floats para peso).
 *
 * `KRETZ_STX_CR` es el MISMO protocolo que ya usa el POS en Rust (`apps/pos/src-tauri/src/scale/parser.rs`, ver `docs/SCALE_INTEGRATION.md`): `STX +
 * peso neto ASCII en kg con punto decimal + CR`. Es un port con las mismas reglas (reensambla frames partidos, soporta varios frames por lectura, descarta
 * basura previa al STX, resincroniza con un nuevo STX y rechaza —nunca clampea— lo que no tiene la forma documentada) y los mismos casos de prueba.
 *
 * Ese frame NO trae una señal de estabilidad documentada: `stable` es `null` (= «el protocolo no lo informa») y NUNCA se asume `true`.
 * `ASCII_LINE` cubre balanzas que sí la informan en una línea de texto terminada en CR/LF (`ST,GS,+001.250 kg`, `US,GS,...`, `S S 1.250 kg`…).
 */

export const SCALE_PROTOCOLS = ["KRETZ_STX_CR", "ASCII_LINE"] as const;
export type ScaleProtocol = (typeof SCALE_PROTOCOLS)[number];

export const SCALE_PROTOCOL_LABELS: Record<ScaleProtocol, string> = {
  KRETZ_STX_CR: "KRETZ Novel Eco 2 (transmisión continua)",
  ASCII_LINE: "Línea ASCII con indicador de estabilidad"
};

export function isScaleProtocol(value: unknown): value is ScaleProtocol {
  return typeof value === "string" && (SCALE_PROTOCOLS as readonly string[]).includes(value);
}

/** Parámetros del puerto serie (los mismos nombres que usa la Web Serial API). */
export interface SerialLineParams {
  baudRate: number;
  dataBits: 7 | 8;
  stopBits: 1 | 2;
  parity: "none" | "even" | "odd";
}

/** Parámetros documentados del KRETZ Novel Eco 2 y los que usa el POS: 9600 baudios, 8 bits, sin paridad, 2 stop bits. */
export const KRETZ_SERIAL_PARAMS: SerialLineParams = { baudRate: 9600, dataBits: 8, stopBits: 2, parity: "none" };

/** Velocidades que ofrece la pantalla de configuración (las habituales de las balanzas comerciales). */
export const SERIAL_BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200] as const;

export type ScaleFrameErrorCode = "EMPTY" | "INVALID_ENCODING" | "MISSING_DECIMAL_POINT" | "INVALID_CHARACTERS" | "FRAME_TOO_LONG" | "NEGATIVE_WEIGHT";

export type ScaleParseItem =
  | { ok: true; grams: number; /** `true`/`false` si el protocolo lo informa; `null` si no. */ stable: boolean | null }
  | { ok: false; code: ScaleFrameErrorCode };

export interface ScaleFrameParser {
  /** Procesa bytes recién leídos y devuelve un resultado por cada frame COMPLETO, en orden. */
  feed(chunk: Uint8Array): ScaleParseItem[];
  /** Descarta lo acumulado (se usa al reconectar: un frame a medias de la conexión anterior no sirve). */
  reset(): void;
}

const STX = 0x02;
const CR = 0x0d;
const LF = 0x0a;
/** Un frame más largo que esto sin terminador es ruido. El real tiene unos pocos bytes. */
const MAX_FRAME_LEN = 32;

/** Un frame ya extraído (entre STX y CR) → gramos. Cota defensiva: hasta 3 dígitos enteros y 3 decimales; nunca redondea ni inventa. */
export function parseKretzFrame(bytes: Uint8Array): ScaleParseItem {
  if (bytes.length === 0) return { ok: false, code: "EMPTY" };
  if (bytes.length > MAX_FRAME_LEN) return { ok: false, code: "FRAME_TOO_LONG" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    return { ok: false, code: "INVALID_ENCODING" };
  }
  const dot = text.indexOf(".");
  if (dot < 0) return { ok: false, code: "MISSING_DECIMAL_POINT" };
  const integerPart = text.slice(0, dot);
  const fractionalPart = text.slice(dot + 1);
  if (!/^\d{1,3}$/.test(integerPart) || !/^\d{1,3}$/.test(fractionalPart)) return { ok: false, code: "INVALID_CHARACTERS" };
  return { ok: true, grams: Number(integerPart) * 1000 + Number(fractionalPart.padEnd(3, "0")), stable: null };
}

class KretzStxCrParser implements ScaleFrameParser {
  private buffer: number[] = [];
  private inFrame = false;

  feed(chunk: Uint8Array): ScaleParseItem[] {
    const results: ScaleParseItem[] = [];
    for (const byte of chunk) {
      if (byte === STX) {
        // Un STX siempre abre un frame nuevo: lo que hubiera sin CR estaba corrupto.
        this.buffer = [];
        this.inFrame = true;
        continue;
      }
      if (!this.inFrame) continue;
      if (byte === CR) {
        const frame = Uint8Array.from(this.buffer);
        this.buffer = [];
        this.inFrame = false;
        results.push(parseKretzFrame(frame));
        continue;
      }
      this.buffer.push(byte);
      if (this.buffer.length > MAX_FRAME_LEN) {
        results.push({ ok: false, code: "FRAME_TOO_LONG" });
        this.buffer = [];
        this.inFrame = false;
      }
    }
    return results;
  }

  reset(): void {
    this.buffer = [];
    this.inFrame = false;
  }
}

const STABLE_FLAGS = new Set(["ST", "S"]);
const UNSTABLE_FLAGS = new Set(["US", "UN", "D", "M", "?"]);

/**
 * Una línea de texto → peso + estabilidad. Se parte en campos separados por espacio, coma o punto y coma: un campo `ST`/`S` = estable, `US`/`UN`/`D`/`M`/`?`
 * = inestable (sin campo = null), y el primer campo numérico es el peso (kg; con unidad `g` pegada o en el campo siguiente se toma como gramos). Un peso
 * negativo se rechaza (NEGATIVE_WEIGHT): una tara mal puesta no puede convertirse en un paquete.
 */
export function parseAsciiLine(line: string): ScaleParseItem {
  const text = line.trim();
  if (text === "") return { ok: false, code: "EMPTY" };
  if (text.length > 64) return { ok: false, code: "FRAME_TOO_LONG" };
  // La coma entre dos dígitos es coma decimal («0,825»); cualquier otra coma separa campos («ST,GS,+001.250»).
  const fields = text.replace(/(\d),(\d)/g, "$1.$2").split(/[\s,;]+/).filter((field) => field !== "");
  let stable: boolean | null = null;
  for (const field of fields) {
    const upper = field.toUpperCase();
    if (STABLE_FLAGS.has(upper)) { stable = true; break; }
    if (UNSTABLE_FLAGS.has(upper)) { stable = false; break; }
  }
  for (const [index, field] of fields.entries()) {
    const match = /^([+-]?)(\d{1,6})(?:[.,](\d{1,4}))?(kg|g)?$/i.exec(field);
    if (!match) continue;
    const [, sign, integerPart, fractionalPart, glued] = match;
    if (integerPart === undefined) continue;
    const unit = (glued ?? fields[index + 1] ?? "").toLowerCase();
    const value = Number(`${integerPart}.${fractionalPart ?? "0"}`);
    if (sign === "-" && value !== 0) return { ok: false, code: "NEGATIVE_WEIGHT" };
    const grams = unit === "g" ? Math.round(value) : Number(integerPart) * 1000 + Number((fractionalPart ?? "").padEnd(3, "0").slice(0, 3));
    if (!Number.isFinite(grams) || grams > 999_999) return { ok: false, code: "INVALID_CHARACTERS" };
    return { ok: true, grams, stable };
  }
  return { ok: false, code: "MISSING_DECIMAL_POINT" };
}

class AsciiLineParser implements ScaleFrameParser {
  private buffer: number[] = [];

  feed(chunk: Uint8Array): ScaleParseItem[] {
    const results: ScaleParseItem[] = [];
    for (const byte of chunk) {
      if (byte === CR || byte === LF) {
        if (this.buffer.length === 0) continue; // CR+LF = un solo terminador
        const line = this.buffer;
        this.buffer = [];
        try {
          results.push(parseAsciiLine(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(line))));
        } catch {
          results.push({ ok: false, code: "INVALID_ENCODING" });
        }
        continue;
      }
      this.buffer.push(byte);
      if (this.buffer.length > 64) {
        results.push({ ok: false, code: "FRAME_TOO_LONG" });
        this.buffer = [];
      }
    }
    return results;
  }

  reset(): void {
    this.buffer = [];
  }
}

export function createScaleFrameParser(protocol: ScaleProtocol): ScaleFrameParser {
  return protocol === "ASCII_LINE" ? new AsciiLineParser() : new KretzStxCrParser();
}

/** Texto de cada error de trama para la pantalla. */
export const SCALE_FRAME_ERROR_LABELS: Record<ScaleFrameErrorCode, string> = {
  EMPTY: "Trama vacía",
  INVALID_ENCODING: "Trama con caracteres no válidos",
  MISSING_DECIMAL_POINT: "Trama sin punto decimal",
  INVALID_CHARACTERS: "Trama con formato inesperado",
  FRAME_TOO_LONG: "Trama demasiado larga",
  NEGATIVE_WEIGHT: "Peso negativo"
};
