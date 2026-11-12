import type { VacuumPackage, VacuumProductOption, VacuumSettings } from "../vacuum";
import type { VacuumLabelData } from "../vacuum-label-layout";

/** Paquete de ejemplo (1,245 kg de Vacío a $14.500/kg = $18.052,50; EAN con el esquema «precio embebido», prefijo 2, PLU de 4 dígitos). */
export function samplePackage(overrides: Partial<VacuumPackage> = {}): VacuumPackage {
  return {
    id: "pkg-1", branchId: "branch-1", branchName: "Central", productId: "prod-1", productName: "Vacío", productSku: "VAC",
    weightGrams: 1245, pricePerKgCents: 1_450_000n, totalCents: 1_805_250n, packedOn: "2026-11-01", expiresOn: "2026-11-08",
    lot: "A1-261101-0001", ean13: "2000718052504", shelfLifeDays: 7, conservationText: "Conservar entre 0 y 4 °C",
    businessName: "Carnicería Fran", address: "Av. Siempreviva 742", establishmentInfo: "Establecimiento Nº 1", extraText: null,
    dims: { widthMm: null, infoHeightMm: null, priceHeightMm: null }, createdAt: "2026-11-01T12:00:00.000Z", createdBy: "Fran", printCount: 0, logisticCode: "7K3M9QX4S",
    ...overrides
  };
}

export function sampleLabelData(overrides: Partial<VacuumLabelData> = {}): VacuumLabelData {
  return {
    productName: "Vacío", weightGrams: 1245, pricePerKgCents: 1_450_000n, totalCents: 1_805_250n, packedOn: "2026-11-01", expiresOn: "2026-11-08",
    lot: "A1-261101-0001", ean13: "2000718052504", logisticCode: null, conservationText: "Conservar entre 0 y 4 °C", businessName: "Carnicería Fran",
    address: "Av. Siempreviva 742", establishmentInfo: "Establecimiento Nº 1", extraText: null, ...overrides
  };
}

export function sampleProduct(overrides: Partial<VacuumProductOption> = {}): VacuumProductOption {
  return { productId: "prod-1", name: "Vacío", sku: "VAC", shelfLifeDays: 7, plu: "7", conservationText: "Conservar entre 0 y 4 °C", pricePerKgCents: 1_450_000n, ...overrides };
}

export function sampleSettings(overrides: Partial<VacuumSettings> = {}): VacuumSettings {
  return {
    businessName: "Carnicería Fran", address: "Av. Siempreviva 742", establishmentInfo: "Establecimiento Nº 1", defaultConservationText: null, extraText: null,
    labelWidthMm: null, infoHeightMm: null, priceHeightMm: null,
    ean: { scheme: "PRICE_EMBEDDED", prefix: "2", pluDigits: 4, valueDigits: 7, valueStep: 1 }, ...overrides
  };
}
