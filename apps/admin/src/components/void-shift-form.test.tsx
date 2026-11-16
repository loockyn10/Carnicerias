import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../app/admin/actions", () => ({ voidShiftAction: vi.fn() }));

import { VoidShiftForm, voidShiftConfirmMessage } from "./void-shift-form";

describe("anular un fichaje (D-099)", () => {
  it("el formulario envía SOLO el fichaje elegido y exige un motivo", () => {
    const html = renderToStaticMarkup(<VoidShiftForm clockInLabel="01/04/26 8:00" employeeName="OTRO" shiftId="c5000000-0000-4000-8000-000000000001" />);
    expect(html).toContain('name="shift_id"');
    expect(html).toContain('value="c5000000-0000-4000-8000-000000000001"');
    expect(html).toMatch(/<input[^>]*name="reason"[^>]*/);
    expect(html).toContain("required");
    expect(html).toContain('minLength="3"');
    expect(html).toContain("Anular fichaje");
  });

  it("la confirmación nombra a la persona y la entrada, y avisa que se conserva pero no suma horas ni costo y que no se deshace", () => {
    const message = voidShiftConfirmMessage("OTRO", "01/04/26 8:00");
    expect(message).toContain("OTRO");
    expect(message).toContain("01/04/26 8:00");
    expect(message).toContain("Se conserva en el historial");
    expect(message).toContain("deja de sumar horas y costo laboral");
    expect(message).toContain("No se puede deshacer");
  });

  it("el formulario compacto (fila del historial) mantiene los mismos campos", () => {
    const html = renderToStaticMarkup(<VoidShiftForm clockInLabel="x" compact employeeName="Mica" shiftId="s1" />);
    expect(html).toContain('name="shift_id"');
    expect(html).toContain('name="reason"');
  });
});
