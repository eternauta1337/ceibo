import { describe, expect, it } from "vitest";
import { chatLinkRender } from "./chatLink.ts";

// `chatLinkRender` decide cómo se pinta un link del markdown del chat (texto del agente). El
// invariante del owner: un click NUNCA navega el SPA ("no se va ceibo") → todo link clickeable
// abre en otra pestaña. La defensa de seguridad: un esquema peligroso (prompt-injectable) no
// llega a ser un `<a href>` clickeable, cae a texto plano.

describe("chatLinkRender", () => {
  it("http(s) externo → link que abre en otra pestaña (no se va ceibo)", () => {
    expect(chatLinkRender("https://example.com/x")).toEqual({
      render: "link",
      href: "https://example.com/x",
      target: "_blank",
      rel: "noopener noreferrer",
    });
    expect(chatLinkRender("http://example.com")).toMatchObject({ render: "link", target: "_blank" });
  });

  it("mailto/tel/protocol-relative → link en otra pestaña", () => {
    expect(chatLinkRender("mailto:a@b.com")).toMatchObject({ render: "link", target: "_blank" });
    expect(chatLinkRender("tel:+5491100000000")).toMatchObject({ render: "link", target: "_blank" });
    expect(chatLinkRender("//cdn.example.com/x")).toMatchObject({ render: "link", target: "_blank" });
  });

  it("link interno (path a nota, sin esquema) → también abre en otra pestaña (no se va ceibo)", () => {
    expect(chatLinkRender("otra-nota")).toMatchObject({ render: "link", target: "_blank" });
    expect(chatLinkRender("./carpeta/nota")).toMatchObject({ render: "link", target: "_blank" });
    expect(chatLinkRender("#seccion")).toMatchObject({ render: "link", target: "_blank" });
  });

  it("esquema peligroso (prompt-injectable) → texto plano, NO clickeable", () => {
    expect(chatLinkRender("javascript:alert(1)")).toEqual({ render: "text" });
    expect(chatLinkRender("JavaScript:alert(1)")).toEqual({ render: "text" });
    expect(chatLinkRender("data:text/html,<script>alert(1)</script>")).toEqual({ render: "text" });
    expect(chatLinkRender("vbscript:msgbox(1)")).toEqual({ render: "text" });
    expect(chatLinkRender("file:///etc/passwd")).toEqual({ render: "text" });
  });

  it("href ausente/vacío → texto plano", () => {
    expect(chatLinkRender(undefined)).toEqual({ render: "text" });
    expect(chatLinkRender(null)).toEqual({ render: "text" });
    expect(chatLinkRender("")).toEqual({ render: "text" });
  });
});
