import { describe, expect, it } from "vitest";

import { describeCaughtValue, formatDiagnostics, resolveErrorMessage } from "./error-messages";

describe("resolveErrorMessage", () => {
  it("uses the Error message when the caught value is an Error instance", () => {
    expect(resolveErrorMessage(new Error("PIN incorrecto"), "fallback")).toBe("PIN incorrecto");
  });

  it("uses the raw string when Tauri invoke() rejects with a plain string (Result<T, String> commands)", () => {
    expect(resolveErrorMessage("Este empleado debe validar su PIN online nuevamente", "fallback")).toBe(
      "Este empleado debe validar su PIN online nuevamente"
    );
  });

  it("falls back for an empty string", () => {
    expect(resolveErrorMessage("", "No se pudo validar el PIN")).toBe("No se pudo validar el PIN");
  });

  it("reads .message from a plain object (e.g. a PostgrestError-shaped rejection)", () => {
    expect(resolveErrorMessage({ message: "permission denied for table profiles", code: "42501" }, "fallback")).toBe(
      "permission denied for table profiles"
    );
  });

  it("reads .error when .message is absent", () => {
    expect(resolveErrorMessage({ error: "grant expired" }, "fallback")).toBe("grant expired");
  });

  it("reads .details when neither .message nor .error is present", () => {
    expect(resolveErrorMessage({ details: "Key (profile_id)=(...) is not present" }, "fallback")).toBe(
      "Key (profile_id)=(...) is not present"
    );
  });

  it("falls back for non-Error, non-string, field-less objects", () => {
    expect(resolveErrorMessage({ some: "object" }, "No se pudo validar el PIN")).toBe("No se pudo validar el PIN");
    expect(resolveErrorMessage(undefined, "No se pudo validar el PIN")).toBe("No se pudo validar el PIN");
    expect(resolveErrorMessage(null, "No se pudo validar el PIN")).toBe("No se pudo validar el PIN");
  });
});

describe("describeCaughtValue", () => {
  it("extracts message/code/details/hint from an object shape without dumping unrelated fields", () => {
    const diagnostics = describeCaughtValue({
      message: "permission denied",
      code: "42501",
      details: "Failing row contains (...)",
      hint: "Grant SELECT to authenticated",
      operatorToken: "should-not-appear",
      pin: "should-not-appear-either"
    });
    expect(diagnostics).toEqual({
      type: "object",
      message: "permission denied",
      code: "42501",
      details: "Failing row contains (...)",
      hint: "Grant SELECT to authenticated"
    });
  });

  it("reports the type for primitives and Tauri string rejections", () => {
    expect(describeCaughtValue("PIN incorrecto")).toEqual({ type: "string", message: "PIN incorrecto" });
    expect(describeCaughtValue(undefined)).toEqual({ type: "undefined" });
    expect(describeCaughtValue(null)).toEqual({ type: "null" });
  });

  it("redacts JWT-looking substrings even if present inside a message", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const diagnostics = describeCaughtValue({ message: `token invalid: ${jwt}` });
    expect(diagnostics.message).not.toContain(jwt);
    expect(diagnostics.message).toContain("[REDACTED]");
  });
});

describe("formatDiagnostics", () => {
  it("joins only the fields that are present", () => {
    expect(formatDiagnostics({ type: "object", code: "42501", message: "permission denied" })).toBe(
      'tipo=object code=42501 message="permission denied"'
    );
    expect(formatDiagnostics({ type: "string" })).toBe("tipo=string");
  });
});
