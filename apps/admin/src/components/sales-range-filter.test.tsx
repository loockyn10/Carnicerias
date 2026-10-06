import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SalesRangeFilter } from "./sales-range-filter";

describe("SalesRangeFilter", () => {
  const html = renderToStaticMarkup(<SalesRangeFilter preserve={{ q: "ave", sort: "revenue", filter: "" }} range={{ from: "2026-09-30", to: "2026-10-06", preset: "7d" }} />);

  it("offers the four presets and marks the active one", () => {
    for (const label of ["Hoy", "Ayer", "7 días", "30 días"]) expect(html).toContain(`>${label}</a>`);
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toMatch(/<a aria-current="true"[^>]*>7 días<\/a>/);
  });

  it("presets are links that keep the other filters but never a stale date", () => {
    expect(html).toContain('href="?q=ave&amp;sort=revenue&amp;preset=yesterday"');
    expect(html).not.toContain("filter=");
  });

  it("has Desde and Hasta date inputs prefilled with the active range", () => {
    expect(html).toMatch(/name="from"[^>]*/);
    expect(html).toContain('value="2026-09-30"');
    expect(html).toContain('value="2026-10-06"');
    expect(html.match(/type="date"/g)).toHaveLength(2);
  });

  it("the date form has a single submit button, so Enter applies the dates (not a preset)", () => {
    expect(html.match(/type="submit"/g)).toHaveLength(1);
    expect(html).toContain('<input type="hidden" name="q" value="ave"/>');
  });

  it("shows why the requested range was replaced", () => {
    const withError = renderToStaticMarkup(<SalesRangeFilter error="La fecha Desde no puede ser posterior a Hasta." range={{ from: "2026-10-06", to: "2026-10-06", preset: "today" }} />);
    expect(withError).toContain("La fecha Desde no puede ser posterior a Hasta.");
    expect(withError).toContain("Se muestra el día de hoy.");
  });
});
