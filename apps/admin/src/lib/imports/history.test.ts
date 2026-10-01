import { describe, expect, it } from "vitest";

import { pickDefaultCategory, resolveImportDestination, type BranchCandidate } from "./destination";
import { groupImportRuns, type ImportBatchRecord } from "./history";

const RUN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function batch(overrides: Partial<ImportBatchRecord> & { id: string }): ImportBatchRecord {
  return {
    source_system: "simplygest", entity_type: "product", file_name: "catalogo.csv", status: "APPLIED",
    options: { runId: RUN }, preview_summary: { totalRows: 1000, error: 2 }, applied_summary: { created: 600, updated: 100 },
    created_at: "2026-10-01T10:00:00Z", applied_at: "2026-10-01T10:01:00Z", ...overrides
  };
}

describe("groupImportRuns", () => {
  it("shows one line per logical import: product batches added up, stock reported on the side", () => {
    const runs = groupImportRuns([
      batch({ id: "1" }),
      batch({ id: "2", preview_summary: { totalRows: 500, error: 0 }, applied_summary: { created: 400, updated: 0 }, created_at: "2026-10-01T10:00:05Z" }),
      batch({ id: "3", entity_type: "stock_opening_balance", preview_summary: { totalRows: 900 }, applied_summary: { created: 880 }, created_at: "2026-10-01T10:00:09Z" })
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ fileName: "catalogo.csv", sourceLabel: "SimplyGest", rows: 1500, created: 1000, updated: 100, errors: 2, stockLoaded: 880, status: "APPLIED", batches: 2 });
  });

  it("a run with some batches applied is PARTIAL; one never confirmed is PENDING; cancelled is CANCELLED", () => {
    expect(groupImportRuns([batch({ id: "1" }), batch({ id: "2", status: "READY", applied_summary: null, applied_at: null })])[0]?.status).toBe("PARTIAL");
    expect(groupImportRuns([batch({ id: "1", status: "READY", applied_summary: null, applied_at: null })])[0]?.status).toBe("PENDING");
    expect(groupImportRuns([batch({ id: "1", status: "CANCELLED", applied_summary: null, applied_at: null })])[0]?.status).toBe("CANCELLED");
  });

  it("keeps different runs apart, newest first, and shows batches without a runId on their own", () => {
    const runs = groupImportRuns([
      batch({ id: "1", created_at: "2026-09-30T08:00:00Z", options: {} }),
      batch({ id: "2", options: { runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, created_at: "2026-10-02T08:00:00Z" }),
      batch({ id: "3", created_at: "2026-10-01T08:00:00Z" })
    ]);
    expect(runs.map((run) => run.createdAt)).toEqual(["2026-10-02T08:00:00Z", "2026-10-01T08:00:00Z", "2026-09-30T08:00:00Z"]);
  });

  it("tolerates missing or malformed summaries", () => {
    const runs = groupImportRuns([batch({ id: "1", preview_summary: null, applied_summary: "oops", file_name: null })]);
    expect(runs[0]).toMatchObject({ rows: 0, created: 0, errors: 0, fileName: "(sin nombre)" });
  });
});

describe("resolveImportDestination", () => {
  const branches: BranchCandidate[] = [
    { id: "c", name: "Central", code: "CENTRAL", active: true },
    { id: "a", name: "Avenida", code: "AVENIDA", active: true },
    { id: "j", name: "Janssen", code: "JANSSEN", active: true }
  ];

  it("uses the production branch configured in Desposte", () => {
    expect(resolveImportDestination(branches, "c")).toEqual({ kind: "ok", branch: { id: "c", name: "Central", code: "CENTRAL" }, via: "production_branch" });
  });

  it("never lands on another branch: a configured butcher shop is whatever Desposte says, but the client cannot choose", () => {
    const destination = resolveImportDestination(branches, "a");
    expect(destination.kind === "ok" && destination.branch.id).toBe("a");
  });

  it("refuses an inactive or missing production branch", () => {
    expect(resolveImportDestination([{ id: "c", name: "Central", code: "CENTRAL", active: false }], "c").kind).toBe("missing");
    expect(resolveImportDestination(branches, "zzz").kind).toBe("missing");
  });

  it("falls back to a single active branch literally named Central when none is configured", () => {
    expect(resolveImportDestination(branches, null)).toMatchObject({ kind: "ok", via: "name", branch: { id: "c" } });
  });

  it("refuses to guess when nothing (or two things) match", () => {
    expect(resolveImportDestination([{ id: "a", name: "Avenida", code: "AVENIDA", active: true }], null).kind).toBe("missing");
    expect(resolveImportDestination([...branches, { id: "c2", name: "CENTRAL", code: "C2", active: true }], null).kind).toBe("missing");
  });
});

describe("pickDefaultCategory", () => {
  it("finds Almacen ignoring case and accents, preferring an active exact match", () => {
    const picked = pickDefaultCategory([
      { id: "2", name: "Almacén", active: true },
      { id: "1", name: "Almacen", active: true },
      { id: "3", name: "Bebidas", active: true }
    ]);
    expect(picked?.id).toBe("1");
  });

  it("prefers an active category over an inactive one and returns null when there is none", () => {
    expect(pickDefaultCategory([{ id: "1", name: "Almacen", active: false }, { id: "2", name: "ALMACÉN", active: true }])?.id).toBe("2");
    expect(pickDefaultCategory([{ id: "3", name: "Bebidas", active: true }])).toBeNull();
  });
});
