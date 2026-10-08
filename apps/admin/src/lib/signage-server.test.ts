import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const download = vi.fn();
const createClient = vi.fn<(url: string, key: string, options: { auth: Record<string, unknown> }) => object>(() => ({ rpc, storage: { from: () => ({ download }) } }));

vi.mock("@supabase/supabase-js", () => ({ createClient: (url: string, key: string, options: { auth: Record<string, unknown> }) => createClient(url, key, options) }));

const { loadPublicSignage, loadPublicSignageMedia } = await import("./signage-server");

const TOKEN = "a".repeat(64);
const SLIDE = "0b1d6c1e-0000-4000-8000-000000000001";
const payload = {
  status: "ACTIVE", slideDurationSeconds: 8, organizationName: "Super Demo",
  logo: { storagePath: "org/branding/c2.png", contentType: "image/png", width: 480, height: 120 },
  slides: [{
    slideId: SLIDE, name: "Bondiola de cerdo", unitType: "WEIGHT", listPriceCents: "1065000", bulkMinimumUnits: null, bulkDiscountBps: null, weightTiers: [],
    photo: { storagePath: "org/prod/c1.png", contentType: "image/png" }
  }]
};

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "anon-key";
  rpc.mockReset();
  download.mockReset();
  createClient.mockClear();
});

describe("loadPublicSignage — la vista pública (sin sesión) con la identidad nueva", () => {
  it("un token mal formado no llega a la base", async () => {
    expect(await loadPublicSignage("../x")).toEqual({ kind: "not_found" });
    expect(await loadPublicSignage("A".repeat(64))).toEqual({ kind: "not_found" });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("usa la clave pública SIN sesión y llama sólo a get_signage_display(token)", async () => {
    rpc.mockResolvedValue({ data: payload, error: null });
    await loadPublicSignage(TOKEN);
    const [url, key, options] = createClient.mock.calls[0] ?? [];
    expect([url, key]).toEqual(["http://localhost:54321", "anon-key"]);
    expect(options?.auth).toMatchObject({ persistSession: false, autoRefreshToken: false });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("get_signage_display", { p_token: TOKEN });
  });

  it("devuelve la vista con precio del motor, foto y logo servidos por /api/tv/<token>/media (nunca una ruta de Storage)", async () => {
    rpc.mockResolvedValue({ data: payload, error: null });
    const result = await loadPublicSignage(TOKEN);
    if (result.kind !== "ok") throw new Error("sin vista");
    const slide = result.view.slides[0];
    expect(slide).toMatchObject({ name: "Bondiola de cerdo", unitType: "WEIGHT", price: { whole: "10.650", cents: null }, priceSuffix: "/ KG", promo: false });
    expect(slide?.imageUrl).toBe(`/api/tv/${TOKEN}/media/${SLIDE}?v=c1`);
    expect(result.view.branding.logo?.imageUrl).toBe(`/api/tv/${TOKEN}/media/logo?v=c2`);
    expect(JSON.stringify(result.view)).not.toContain("org/prod");
    expect(JSON.stringify(result.view)).not.toContain("product-artwork");
  });

  it("token inexistente → not_found; error de la base → error transitorio", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    expect((await loadPublicSignage(TOKEN)).kind).toBe("not_found");
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect((await loadPublicSignage(TOKEN)).kind).toBe("error");
    rpc.mockRejectedValue(new Error("red"));
    expect((await loadPublicSignage(TOKEN)).kind).toBe("error");
  });
});

describe("loadPublicSignageMedia — imágenes de SU pantalla", () => {
  const blob = (bytes: number[]) => ({ arrayBuffer: () => Promise.resolve(new Uint8Array(bytes).buffer) });

  it("valida el token en la base y descarga la ruta que figura en la presentación", async () => {
    rpc.mockResolvedValue({ data: payload, error: null });
    download.mockResolvedValue({ data: blob([0x89, 0x50, 0x4e, 0x47, 9]), error: null });
    const result = await loadPublicSignageMedia(TOKEN, SLIDE);
    expect(result.kind).toBe("ok");
    expect(rpc).toHaveBeenCalledWith("get_signage_display", { p_token: TOKEN });
    expect(download).toHaveBeenCalledWith("org/prod/c1.png");
  });

  it("token inválido, regenerado o id ajeno: 404 y Storage intacto", async () => {
    expect((await loadPublicSignageMedia("xyz", SLIDE)).kind).toBe("not_found");
    rpc.mockResolvedValue({ data: null, error: null });
    expect((await loadPublicSignageMedia(TOKEN, SLIDE)).kind).toBe("not_found");
    rpc.mockResolvedValue({ data: payload, error: null });
    expect((await loadPublicSignageMedia(TOKEN, "0b1d6c1e-0000-4000-8000-0000000000ff")).kind).toBe("not_found");
    expect(download).not.toHaveBeenCalled();
  });

  it("si Storage falla, error transitorio (no rompe el televisor)", async () => {
    rpc.mockResolvedValue({ data: payload, error: null });
    download.mockResolvedValue({ data: null, error: { message: "x" } });
    expect((await loadPublicSignageMedia(TOKEN, SLIDE)).kind).toBe("error");
  });
});
