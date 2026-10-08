/**
 * Foto comercial del producto (D-074): constantes y reglas puras compartidas entre el navegador (que sube el archivo a Supabase
 * Storage) y el servidor (que lo registra y lo lee para dibujar la pieza). Los bytes viven en el bucket privado `product-artwork`;
 * en Postgres sólo queda la ruta.
 */

export const ARTWORK_BUCKET = "product-artwork";
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
/** Vigencia de las URLs firmadas con las que el navegador ve la foto (el bucket es privado). */
export const SIGNED_URL_SECONDS = 3_600;
/** Lado mayor (px) al que se reduce una foto demasiado grande antes de subirla: sobra para una pieza de 1080 px. */
export const MAX_PHOTO_SIDE = 2_400;

/** Lo que se acepta al elegir el archivo. Lo que se guarda es siempre JPG o PNG (el WebP se convierte a PNG). */
export const ACCEPTED_INPUT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type StoredPhotoType = "image/jpeg" | "image/png";

export function isAcceptedInputType(type: string): boolean {
  return (ACCEPTED_INPUT_TYPES as readonly string[]).includes(type);
}

export const PHOTO_TYPE_ERROR = "La foto tiene que ser JPG, PNG o WebP.";
export const PHOTO_SIZE_ERROR = "La foto pesa demasiado: el máximo es 5 MB.";

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
  return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
}

export type PhotoPlan =
  | { action: "reject"; error: string }
  /** Se sube tal cual. */
  | { action: "keep"; type: StoredPhotoType }
  /** Se vuelve a codificar en el navegador (WebP → PNG; foto enorme → reducida) antes de subir. */
  | { action: "reencode"; type: StoredPhotoType; width: number; height: number };

/** Lado y proporción de la foto reducida (sin agrandar nunca). */
export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width, height };
  const scale = maxSide / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Qué hacer con el archivo elegido. Rechaza lo que no es JPG/PNG/WebP; deja pasar tal cual lo que ya sirve (JPG/PNG de hasta 5 MB y
 * hasta 2.400 px); convierte WebP a PNG (el renderizador de PNG no lee WebP) y reduce lo muy grande.
 */
export function planPhoto(input: { type: string; size: number; width: number; height: number }): PhotoPlan {
  if (!isAcceptedInputType(input.type)) return { action: "reject", error: PHOTO_TYPE_ERROR };
  if (input.size <= 0) return { action: "reject", error: "El archivo está vacío." };
  const fitted = fitWithin(input.width, input.height, MAX_PHOTO_SIDE);
  const resized = fitted.width !== input.width || fitted.height !== input.height;
  if (input.type === "image/webp") return { action: "reencode", type: "image/png", ...fitted };
  const type = input.type as StoredPhotoType;
  if (!resized && input.size <= MAX_PHOTO_BYTES) return { action: "keep", type };
  return { action: "reencode", type, ...fitted };
}

export function extensionFor(type: StoredPhotoType): "jpg" | "png" {
  return type === "image/jpeg" ? "jpg" : "png";
}

const UUID_PART = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PATH_PATTERN = new RegExp(`^(${UUID_PART})/(${UUID_PART})/${UUID_PART}\\.(jpg|png)$`);

/** `<organización>/<producto>/<uuid>.<ext>`: la organización es la primera carpeta (la política de Storage la usa para aislar). */
export function buildPhotoPath(organizationId: string, productId: string, fileId: string, type: StoredPhotoType): string {
  return `${organizationId}/${productId}/${fileId}.${extensionFor(type)}`.toLowerCase();
}

/** ¿La ruta es de ESTA organización y de ESTE producto? */
export function isValidPhotoPath(path: unknown, organizationId: string, productId: string): path is string {
  if (typeof path !== "string") return false;
  const match = PATH_PATTERN.exec(path);
  return match !== null && match[1] === organizationId.toLowerCase() && match[2] === productId.toLowerCase();
}

const LOGO_PATH_PATTERN = new RegExp(`^(${UUID_PART})/branding/${UUID_PART}\\.(jpg|png)$`);

/** `<organización>/branding/<uuid>.<ext>`: el logo vive en la carpeta `branding` de la organización (mismo bucket y mismas políticas). */
export function buildLogoPath(organizationId: string, fileId: string, type: StoredPhotoType): string {
  return `${organizationId}/branding/${fileId}.${extensionFor(type)}`.toLowerCase();
}

/** ¿La ruta es el logo de ESTA organización? */
export function isValidLogoPath(path: unknown, organizationId: string): path is string {
  if (typeof path !== "string") return false;
  const match = LOGO_PATH_PATTERN.exec(path);
  return match !== null && match[1] === organizationId.toLowerCase();
}
