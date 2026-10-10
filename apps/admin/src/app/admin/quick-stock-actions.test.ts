import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "d2000000-0000-4000-8000-000000000001";
const AVENIDA = "d3000000-0000-4000-8000-000000000002";
const PATA = "d5000000-0000-4000-8000-000000000001";
const COCA = "d5000000-0000-4000-8000-000000000013";
const KEY = "e0000000-0000-4000-8000-000000000001";

const rpc = vi.fn();
const productRows = vi.fn();
const stockLevelRows = vi.fn();
const fromCalls: string[] = [];

/** Constructor de consultas mínimo: encadena eq/in/select y responde con el resultado configurado para esa tabla. */
function query(table: string) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => Promise.resolve(table === "products" ? productRows() : stockLevelRows())
  };
  return builder;
}

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("../../lib/admin", () => ({ requireAdminContext: () => Promise.resolve({ userId: "u", email: "a@b.c", organizationId: ORG, organizationName: "Org", timezone: "America/Argentina/Buenos_Aires" }) }));
vi.mock("../../lib/supabase/server", () => ({ createClient: () => Promise.resolve({ rpc, from: (table: string) => { fromCalls.push(table); return query(table); } }) }));

const { applyQuickStockAction, searchQuickStockAction } = await import("./actions");

const products = [{ id: PATA, name: "Pata muslo", unit_type: "WEIGHT" }, { id: COCA, name: "Coca 2,25L", unit_type: "UNIT" }];
const okResponse = { requested: 1, applied: 1, unchanged: 0, failed: 0, replayed: false, items: [{ branchId: AVENIDA, productId: PATA, mode: "ADD", ok: true, unchanged: false, before: 16_600, after: 31_600, difference: 15_000 }], operationIds: ["op-1"] };

beforeEach(() => {
  rpc.mockReset();
  productRows.mockReset();
  stockLevelRows.mockReset();
  fromCalls.length = 0;
  productRows.mockReturnValue({ data: products, error: null });
});

describe("applyQuickStockAction: guardar los cambios de Stock rápido", () => {
  it("convierte kg → gramos y unidades enteras con el tipo REAL del producto y manda UNA llamada con la clave de idempotencia", async () => {
    rpc.mockResolvedValue({ data: { ...okResponse, requested: 3 }, error: null });
    const result = await applyQuickStockAction({ requestKey: KEY, items: [
      { branchId: AVENIDA, productId: PATA, mode: "ADD", raw: "15" },
      { branchId: AVENIDA, productId: COCA, mode: "REMOVE", raw: "3" }
    ] });
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("apply_quick_stock_changes", {
      p_request_key: KEY,
      p_items: [
        { branchId: AVENIDA, productId: PATA, mode: "ADD", quantity: 15_000 },
        { branchId: AVENIDA, productId: COCA, mode: "REMOVE", quantity: 3 }
      ]
    });
  });

  it("el conteo manda lo contado (cero es válido) y el stock que la pantalla mostraba", async () => {
    rpc.mockResolvedValue({ data: okResponse, error: null });
    await applyQuickStockAction({ requestKey: KEY, items: [
      { branchId: AVENIDA, productId: PATA, mode: "COUNT", raw: "4,2", expectedSystemQuantity: 16_600 },
      { branchId: AVENIDA, productId: COCA, mode: "COUNT", raw: "0" }
    ] });
    expect(rpc).toHaveBeenCalledWith("apply_quick_stock_changes", {
      p_request_key: KEY,
      p_items: [
        { branchId: AVENIDA, productId: PATA, mode: "COUNT", physicalQuantity: 4_200, expectedSystemQuantity: 16_600 },
        { branchId: AVENIDA, productId: COCA, mode: "COUNT", physicalQuantity: 0 }
      ]
    });
  });

  it("nunca se fía de lo que diga el navegador sobre la unidad: kg con decimales para un producto UNIT se rechaza sin tocar la base", async () => {
    const result = await applyQuickStockAction({ requestKey: KEY, items: [{ branchId: AVENIDA, productId: COCA, mode: "ADD", raw: "1,5" }] });
    expect(result).toEqual({ ok: false, error: "Coca 2,25L: Ingresá una cantidad entera de unidades" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("agregar / quitar exigen una cantidad mayor a cero", async () => {
    const result = await applyQuickStockAction({ requestKey: KEY, items: [{ branchId: AVENIDA, productId: PATA, mode: "REMOVE", raw: "0" }] });
    expect(result.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rechaza una clave inválida, un pedido vacío o demasiado grande, y datos mal formados", async () => {
    const item = { branchId: AVENIDA, productId: PATA, mode: "ADD" as const, raw: "1" };
    expect((await applyQuickStockAction({ requestKey: "no-es-uuid", items: [item] })).ok).toBe(false);
    expect((await applyQuickStockAction({ requestKey: KEY, items: [] })).ok).toBe(false);
    expect((await applyQuickStockAction({ requestKey: KEY, items: Array.from({ length: 201 }, () => item) })).ok).toBe(false);
    expect((await applyQuickStockAction({ requestKey: KEY, items: [{ ...item, branchId: "x" }] })).ok).toBe(false);
    expect((await applyQuickStockAction({ requestKey: KEY, items: [{ ...item, mode: "SET" as unknown as "ADD" }] })).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("un producto de otra organización (la consulta no lo devuelve) no llega a la base", async () => {
    productRows.mockReturnValue({ data: [], error: null });
    const result = await applyQuickStockAction({ requestKey: KEY, items: [{ branchId: AVENIDA, productId: PATA, mode: "ADD", raw: "1" }] });
    expect(result).toEqual({ ok: false, error: "Uno de los productos no existe en esta organización." });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("un error del servidor se devuelve como mensaje, sin cerrar la pantalla", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "Una de las sucursales no está autorizada para operar stock" } });
    expect(await applyQuickStockAction({ requestKey: KEY, items: [{ branchId: AVENIDA, productId: PATA, mode: "ADD", raw: "1" }] })).toEqual({ ok: false, error: "Una de las sucursales no está autorizada para operar stock" });
  });

  it("devuelve el resultado parcial por producto (lo que falló, con su motivo)", async () => {
    rpc.mockResolvedValue({ data: { requested: 2, applied: 1, unchanged: 0, failed: 1, replayed: false, items: [
      { branchId: AVENIDA, productId: PATA, mode: "ADD", ok: true, unchanged: false, before: 0, after: 15_000, difference: 15_000 },
      { branchId: AVENIDA, productId: COCA, mode: "REMOVE", ok: false, code: "INSUFFICIENT_STOCK", current: 2 }
    ] }, error: null });
    const result = await applyQuickStockAction({ requestKey: KEY, items: [{ branchId: AVENIDA, productId: PATA, mode: "ADD", raw: "15" }, { branchId: AVENIDA, productId: COCA, mode: "REMOVE", raw: "3" }] });
    expect(result.ok && result.outcome).toMatchObject({ applied: 1, failed: 1 });
  });

  it("un reintento con la misma clave devuelve el resultado guardado (replayed) sin pedir nada más", async () => {
    rpc.mockResolvedValue({ data: { ...okResponse, replayed: true }, error: null });
    const result = await applyQuickStockAction({ requestKey: KEY, items: [{ branchId: AVENIDA, productId: PATA, mode: "ADD", raw: "15" }] });
    expect(result.ok && result.outcome.replayed).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("una respuesta ilegible no se toma por éxito", async () => {
    rpc.mockResolvedValue({ data: { algo: "raro" }, error: null });
    const result = await applyQuickStockAction({ requestKey: KEY, items: [{ branchId: AVENIDA, productId: PATA, mode: "ADD", raw: "15" }] });
    expect(result).toEqual({ ok: false, error: "No pudimos confirmar si se guardó. Revisá el stock antes de volver a intentar." });
  });
});

describe("searchQuickStockAction: buscador del servidor, nunca el catálogo entero", () => {
  const row = (over: Record<string, unknown> = {}) => ({ branch_id: AVENIDA, branch_name: "Avenida", product_id: PATA, product_name: "Pata muslo", sku: "PMU", unit_type: "WEIGHT", current_stock_grams: 16_600, minimum_stock_grams: 0, target_stock_grams: 0, suggested_replenishment_grams: 0, stock_status: "AVAILABLE", total_count: 2, ...over });

  it("pide de a 20 a get_branch_stock_status con el texto y el desplazamiento, sólo de esa sucursal", async () => {
    rpc.mockResolvedValue({ data: [row(), row({ product_id: COCA, product_name: "Coca", unit_type: "UNIT", current_stock_grams: 8 })], error: null });
    const result = await searchQuickStockAction({ branchId: AVENIDA, query: "  pata  ", offset: 20 });
    expect(rpc).toHaveBeenCalledWith("get_branch_stock_status", { p_branch_id: AVENIDA, p_limit: 20, p_offset: 20, p_search: "pata" });
    expect(result).toEqual({ total: 2, rows: [
      { productId: PATA, name: "Pata muslo", sku: "PMU", unitType: "WEIGHT", current: 16_600 },
      { productId: COCA, name: "Coca", sku: "PMU", unitType: "UNIT", current: 8 }
    ] });
  });

  it("sin texto no manda p_search y arranca en 0", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await searchQuickStockAction({ branchId: AVENIDA, query: "", offset: -5 });
    expect(rpc).toHaveBeenCalledWith("get_branch_stock_status", { p_branch_id: AVENIDA, p_limit: 20, p_offset: 0 });
  });

  it("no ofrece productos dados de baja", async () => {
    rpc.mockResolvedValue({ data: [row({ stock_status: "DISCONTINUED" }), row({ product_id: COCA, product_name: "Coca" })], error: null });
    expect((await searchQuickStockAction({ branchId: AVENIDA, query: "", offset: 0 })).rows.map((item) => item.name)).toEqual(["Coca"]);
  });

  it("si el nombre no encuentra nada prueba el texto como código de barras (lo que se pega o escribe)", async () => {
    rpc.mockImplementation((name: string) => Promise.resolve(name === "get_branch_stock_status"
      ? { data: [], error: null }
      : { data: [{ product_id: COCA, product_name: "Coca 2,25L", sku: "COC", unit_type: "UNIT", barcodes: ["7790895000782"], active: true }], error: null }));
    stockLevelRows.mockReturnValue({ data: [{ product_id: COCA, quantity_grams: 8 }], error: null });
    const result = await searchQuickStockAction({ branchId: AVENIDA, query: "7790895000782", offset: 0 });
    expect(rpc).toHaveBeenLastCalledWith("search_products", { p_query: "7790895000782", p_limit: 10, p_branch_id: AVENIDA });
    expect(result).toEqual({ total: 1, rows: [{ productId: COCA, name: "Coca 2,25L", sku: "COC", unitType: "UNIT", current: 8 }] });
  });

  it("un código sin stock registrado muestra 0 (no rompe)", async () => {
    rpc.mockImplementation((name: string) => Promise.resolve(name === "get_branch_stock_status" ? { data: [], error: null } : { data: [{ product_id: COCA, product_name: "Coca", sku: null, unit_type: "UNIT", barcodes: [], active: true }], error: null }));
    stockLevelRows.mockReturnValue({ data: [], error: null });
    expect((await searchQuickStockAction({ branchId: AVENIDA, query: "779", offset: 0 })).rows[0]?.current).toBe(0);
  });

  it("rechaza una sucursal que no es un id y no llega a la base", async () => {
    await expect(searchQuickStockAction({ branchId: "x", query: "", offset: 0 })).rejects.toThrow("Sucursal inválida");
    expect(rpc).not.toHaveBeenCalled();
  });
});
