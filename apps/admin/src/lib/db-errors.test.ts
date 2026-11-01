import { describe, expect, it } from "vitest";

import { friendlyDbError } from "./db-errors";

describe("friendlyDbError", () => {
  it("traduce las violaciones de unicidad por nombre de índice", () => {
    expect(friendlyDbError('duplicate key value violates unique constraint "poultry_customers_org_name_uq"')).toBe("Ya existe un cliente con ese nombre");
    expect(friendlyDbError('duplicate key value violates unique constraint "product_vacuum_settings_org_plu_uq"')).toBe("Ese PLU ya está asignado a otro producto");
    expect(friendlyDbError('duplicate key value violates unique constraint "vacuum_packages_organization_id_lot_key"')).toBe("Ese lote ya existe");
  });

  it("traduce permisos, sesión y vigencias solapadas", () => {
    expect(friendlyDbError("Permission poultry.write is required")).toBe("No tenés permiso para esta operación");
    expect(friendlyDbError("Authentication required")).toBe("Tu sesión venció: volvé a iniciar sesión");
    expect(friendlyDbError('conflicting key value violates exclusion constraint "poultry_product_costs_product_id_tstzrange_excl"')).toContain("fecha de vigencia");
  });

  it("deja pasar los mensajes de negocio que ya están en castellano", () => {
    expect(friendlyDbError("Falta registrar el peso real de Pata muslo")).toBe("Falta registrar el peso real de Pata muslo");
  });
});
