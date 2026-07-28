import { describe, expect, it } from "vitest";
import { classifyLink, isExternalUrl } from "./linkScheme.ts";

// `classifyLink` es el predicado de seguridad detrás del click en links del editor: decide si un
// href se abre en otra pestaña (external), se ignora (blocked: esquema no permitido) o se resuelve
// como nota interna (internal). El bug (QA #9): los esquemas no-seguros (`javascript:`/`data:`)
// caían en la rama interna → "tab fantasma". Acá fijamos que ahora son `blocked` (no-op).

describe("classifyLink", () => {
  it("javascript: → blocked (NO se ejecuta, NO se abre, NO se resuelve como nota)", () => {
    expect(classifyLink("javascript:alert(1)")).toBe("blocked");
    expect(classifyLink("JavaScript:alert(1)")).toBe("blocked"); // case-insensitive
  });

  it("data:text/html → blocked (no renderiza ni ejecuta)", () => {
    expect(classifyLink("data:text/html,<script>alert(1)</script>")).toBe("blocked");
    expect(classifyLink("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==")).toBe("blocked");
  });

  it("otros esquemas peligrosos → blocked", () => {
    expect(classifyLink("vbscript:msgbox(1)")).toBe("blocked");
    expect(classifyLink("file:///etc/passwd")).toBe("blocked");
  });

  it("https/http/mailto/tel → external (se abre en otra pestaña)", () => {
    expect(classifyLink("https://example.com/x")).toBe("external");
    expect(classifyLink("http://example.com")).toBe("external");
    expect(classifyLink("mailto:a@b.com")).toBe("external");
    expect(classifyLink("tel:+5491100000000")).toBe("external");
    expect(classifyLink("//cdn.example.com/x")).toBe("external"); // protocol-relative
  });

  it("path interno (sin esquema) → internal (lo resuelve resolveInternalPath)", () => {
    expect(classifyLink("otra-nota")).toBe("internal");
    expect(classifyLink("./carpeta/nota")).toBe("internal");
    expect(classifyLink("../arriba")).toBe("internal");
    expect(classifyLink("/abs/nota.md")).toBe("internal");
    expect(classifyLink("#seccion")).toBe("internal"); // anchor: internal, resolve devuelve null
    expect(classifyLink("nota con espacios")).toBe("internal");
  });
});

describe("isExternalUrl", () => {
  it("solo los esquemas seguros + protocol-relative son externos", () => {
    expect(isExternalUrl("https://x")).toBe(true);
    expect(isExternalUrl("mailto:a@b.com")).toBe(true);
    expect(isExternalUrl("//host/x")).toBe(true);
    expect(isExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isExternalUrl("data:text/html,x")).toBe(false);
    expect(isExternalUrl("otra-nota")).toBe(false);
  });
});
