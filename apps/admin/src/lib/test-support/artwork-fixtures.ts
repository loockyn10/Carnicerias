import { deflateSync } from "node:zlib";

/**
 * Datos de prueba de la cartelería (D-074): hechos tal como los devuelve `get_product_artwork` y «fotos» sintéticas (PNG con fondo
 * transparente / PNG con fondo blanco generados en memoria). No son fotos reales: sirven para verificar composición, recorte y
 * dimensiones sin depender de archivos binarios del repositorio.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export type Rgba = readonly [number, number, number, number];

/** PNG RGBA de `width × height` con el color de cada píxel dado por `pixel(x, y)`. */
export function makePng(width: number, height: number, pixel: (x: number, y: number) => Rgba): Uint8Array {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const offset = row + 1 + x * 4;
      raw[offset] = r; raw[offset + 1] = g; raw[offset + 2] = b; raw[offset + 3] = a;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))
  ]));
}

const TRANSPARENT: Rgba = [0, 0, 0, 0];
const WHITE: Rgba = [255, 255, 255, 255];

function inEllipse(x: number, y: number, cx: number, cy: number, rx: number, ry: number): boolean {
  return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
}

/** «Corte de carne» recortado (sobre transparente o sobre blanco, para simular un JPG con fondo blanco). */
export function makeMeatPhoto(background: "transparent" | "white" = "transparent"): Uint8Array {
  const none = background === "white" ? WHITE : TRANSPARENT;
  return makePng(800, 560, (x, y) => {
    if (inEllipse(x, y, 400, 290, 360, 210)) {
      if (inEllipse(x, y, 330, 230, 150, 70)) return [214, 96, 92, 255];
      if (inEllipse(x, y, 520, 330, 120, 60)) return [236, 196, 170, 255];
      return [168, 38, 40, 255];
    }
    return none;
  });
}

/** «Frasco» (producto envasado) sobre blanco. */
export function makeJarPhoto(): Uint8Array {
  return makePng(520, 620, (x, y) => {
    if (x > 140 && x < 380 && y > 40 && y < 110) return [236, 190, 40, 255];
    if (x > 90 && x < 430 && y > 110 && y < 580) {
      if (x > 120 && x < 400 && y > 230 && y < 450) return [250, 244, 226, 255];
      return [232, 232, 226, 255];
    }
    return WHITE;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Hechos (forma de `get_product_artwork`)
// ---------------------------------------------------------------------------------------------------------------------

export const PRODUCT_IDS = {
  nalga: "c5000000-0000-4000-8000-000000000003",
  pollo: "c5000000-0000-4000-8000-000000000009",
  mayo: "c5000000-0000-4000-8000-000000000001",
  sinFoto: "c5000000-0000-4000-8000-00000000000a",
  largo: "c5000000-0000-4000-8000-00000000000b"
} as const;

export const BRANCH_ID = "c3000000-0000-4000-8000-000000000001";
const ORG = "c2000000-0000-4000-8000-000000000001";

type Facts = Record<string, unknown>;

function base(productId: string, name: string, unitType: "UNIT" | "WEIGHT", listPriceCents: number, extra: Facts = {}): Facts {
  return {
    slideId: productId, productId, name, unitType, available: true, unavailableReason: null, listPriceCents: String(listPriceCents),
    bulkMinimumUnits: null, bulkDiscountBps: null, weightTiers: [], organizationName: "AW Org",
    branchId: BRANCH_ID, branchName: "Central", branchAddress: "Av. Siempre Viva 742", photo: null, ...extra
  };
}

const photo = (productId: string, type: "png" | "jpg" = "png") => ({
  storagePath: `${ORG}/${productId}/c6000000-0000-4000-8000-000000000001.${type}`,
  contentType: type === "png" ? "image/png" : "image/jpeg", sizeBytes: 100_000
});

/** Los cinco casos de la validación visual del sprint. */
export const SAMPLE_FACTS: Record<keyof typeof PRODUCT_IDS, Facts> = {
  // 1. Nalga vacuna a $17.900 / kg (producto por peso, PNG transparente)
  nalga: base(PRODUCT_IDS.nalga, "Nalga vacuna", "WEIGHT", 1_790_000, { photo: photo(PRODUCT_IDS.nalga) }),
  // 2. Pata muslo de pollo (por peso, otra categoría de precio, JPG/PNG con fondo blanco)
  pollo: base(PRODUCT_IDS.pollo, "Pata muslo de pollo", "WEIGHT", 399_000, { photo: photo(PRODUCT_IDS.pollo) }),
  // 3. Mayonesa con promoción «llevando 3» (15 %): $2.050 → precio efectivo del motor
  mayo: base(PRODUCT_IDS.mayo, "Mayonesa Hellmanns 250gr", "UNIT", 205_000, { bulkMinimumUnits: 3, bulkDiscountBps: 1_500, photo: photo(PRODUCT_IDS.mayo) }),
  // 4. Producto sin foto
  sinFoto: base(PRODUCT_IDS.sinFoto, "Aceite Cañuelas 900ml", "UNIT", 245_000),
  // 5. Nombre largo
  largo: base(PRODUCT_IDS.largo, "Hamburguesa de carne vacuna congelada premium x 12 unidades caja 1,2 kg", "UNIT", 1_149_900, { photo: photo(PRODUCT_IDS.largo) })
};

/** «Corte» de color liso (sobre transparente) para los collages de prueba: distingue un producto de otro a simple vista. */
export function makeBlobPhoto(color: readonly [number, number, number]): Uint8Array {
  const [r, g, b] = color;
  return makePng(800, 560, (x, y) => {
    if (inEllipse(x, y, 400, 290, 360, 210)) {
      if (inEllipse(x, y, 330, 230, 150, 70)) return [Math.min(255, r + 40), Math.min(255, g + 40), Math.min(255, b + 40), 255];
      return [r, g, b, 255];
    }
    return TRANSPARENT;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Collage: productos de pollo y cajas de milanesa (productos por unidad, por peso y con promoción)
// ---------------------------------------------------------------------------------------------------------------------

export const COLLAGE_IDS = {
  pataMuslo: "c5000000-0000-4000-8000-000000000011",
  pechuga: "c5000000-0000-4000-8000-000000000012",
  filet: "c5000000-0000-4000-8000-000000000013",
  alitas: "c5000000-0000-4000-8000-000000000014",
  polloEntero: "c5000000-0000-4000-8000-000000000015",
  milaCerdo: "c5000000-0000-4000-8000-000000000016",
  milaVacuna: "c5000000-0000-4000-8000-000000000017",
  milaPollo: "c5000000-0000-4000-8000-000000000018"
} as const;

const COLLAGE_COLORS: Record<keyof typeof COLLAGE_IDS, readonly [number, number, number]> = {
  pataMuslo: [232, 178, 120], pechuga: [244, 196, 176], filet: [238, 170, 160], alitas: [226, 160, 96], polloEntero: [240, 200, 150],
  milaCerdo: [214, 170, 110], milaVacuna: [200, 140, 80], milaPollo: [230, 190, 120]
};

export const COLLAGE_FACTS: Record<keyof typeof COLLAGE_IDS, Facts> = {
  pataMuslo: base(COLLAGE_IDS.pataMuslo, "Pata muslo de pollo premium x 3 kg", "UNIT", 1_199_900, { photo: photo(COLLAGE_IDS.pataMuslo) }),
  pechuga: base(COLLAGE_IDS.pechuga, "Pechuga entera x 3 kg", "UNIT", 1_799_900, { photo: photo(COLLAGE_IDS.pechuga) }),
  filet: base(COLLAGE_IDS.filet, "Filet de pechuga x 2 kg", "UNIT", 1_799_900, { photo: photo(COLLAGE_IDS.filet) }),
  alitas: base(COLLAGE_IDS.alitas, "Alitas de pollo premium x 2 kg", "UNIT", 549_900, { photo: photo(COLLAGE_IDS.alitas) }),
  polloEntero: base(COLLAGE_IDS.polloEntero, "2 pollos grandes", "UNIT", 1_999_900, { photo: photo(COLLAGE_IDS.polloEntero) }),
  milaCerdo: base(COLLAGE_IDS.milaCerdo, "Milanesas de cerdo", "UNIT", 3_149_900, { photo: photo(COLLAGE_IDS.milaCerdo) }),
  milaVacuna: base(COLLAGE_IDS.milaVacuna, "Milanesas vacunas", "UNIT", 5_399_900, { photo: photo(COLLAGE_IDS.milaVacuna) }),
  milaPollo: base(COLLAGE_IDS.milaPollo, "Milanesas de pollo", "UNIT", 3_149_900, { bulkMinimumUnits: 3, bulkDiscountBps: 1_000, photo: photo(COLLAGE_IDS.milaPollo) })
};

/** Los productos de los collages de la validación visual (en el orden de la pieza). */
export const POLLO_SET = ["pataMuslo", "pechuga", "filet", "alitas", "polloEntero"] as const;
export const MILANESA_SET = ["milaCerdo", "milaVacuna", "milaPollo"] as const;

/** Hechos de cualquier producto de prueba (protagonista o collage) por id. */
export function factsById(productId: string): Facts | null {
  for (const facts of [...Object.values(SAMPLE_FACTS), ...Object.values(COLLAGE_FACTS)]) if (facts.productId === productId) return facts;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Identidad: logo de la organización + contacto por sucursal (forma de `get_artwork_branding`)
// ---------------------------------------------------------------------------------------------------------------------

export const BRANCH_AVENIDA_ID = "c3000000-0000-4000-8000-000000000002";
export const LOGO_PATH = `${ORG}/branding/c7000000-0000-4000-8000-000000000001.png`;
export const LOGO_SIZE = { width: 480, height: 120 } as const;

export type BrandingBranch = "central" | "avenida" | null;

const BRANCH_CONTACTS = {
  central: { id: BRANCH_ID, name: "Central", phone: "3496-448808", address: "Güemes 2180", city: "Esperanza, Santa Fe" },
  avenida: { id: BRANCH_AVENIDA_ID, name: "Avenida", phone: "0342 455-5555", address: "Av. Libertad 100", city: "Santa Fe, Santa Fe" }
} as const;

/** Respuesta de `get_artwork_branding` para una sucursal (null = precio general: sin contacto). `logo: false` = organización sin logo. */
export function brandingPayload(branch: BrandingBranch, options: { logo?: boolean } = {}): Facts {
  return {
    organizationName: "AW Org",
    logo: options.logo === false ? null : { storagePath: LOGO_PATH, contentType: "image/png", sizeBytes: 9_000, ...LOGO_SIZE },
    branch: branch ? { ...BRANCH_CONTACTS[branch] } : null
  };
}

/** Logo sintético apaisado (480 × 120, PNG transparente): barras blancas y un bloque rojo. No es el logo real del negocio. */
export function makeLogoPng(): Uint8Array {
  return makePng(LOGO_SIZE.width, LOGO_SIZE.height, (x, y) => {
    if (x > 20 && x < 100 && y > 24 && y < 96) return [216, 32, 27, 255];
    if (x > 120 && x < 460 && y > 30 && y < 56) return WHITE;
    if (x > 120 && x < 360 && y > 70 && y < 94) return [255, 212, 0, 255];
    return TRANSPARENT;
  });
}

/** Bytes de la foto de cada caso (lo que devolvería Storage). */
export function samplePhotoBytes(path: string): Uint8Array | null {
  if (path === LOGO_PATH) return makeLogoPng();
  for (const key of Object.keys(COLLAGE_IDS) as (keyof typeof COLLAGE_IDS)[]) {
    if (path.includes(COLLAGE_IDS[key])) return makeBlobPhoto(COLLAGE_COLORS[key]);
  }
  if (path.includes(PRODUCT_IDS.mayo)) return makeJarPhoto();
  if (path.includes(PRODUCT_IDS.largo)) return makeJarPhoto();
  if (path.includes(PRODUCT_IDS.pollo)) return makeMeatPhoto("white");
  if (path.includes(PRODUCT_IDS.nalga)) return makeMeatPhoto("transparent");
  return null;
}

/** JPG real de 320 × 200 (elipse roja sobre fondo blanco, generado con sharp): prueba el camino JPEG de punta a punta. */
export const JPEG_SAMPLE_BASE64 =
  "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";

export function sampleJpegBytes(): Uint8Array {
  return new Uint8Array(Buffer.from(JPEG_SAMPLE_BASE64, "base64"));
}
