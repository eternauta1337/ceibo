import { describe, expect, it } from "vitest";
import { TAVILY_DEFAULT_PARAMETERS_HEADER, toOpencodeAgentConfig } from "./opencode-mcp.ts";

describe("toOpencodeAgentConfig (MA mcp_servers → opencode mcp)", () => {
  it("traduce cada mcp_server URL a una entrada remote enabled, por nombre", () => {
    const agentCfg = {
      mcp_servers: [
        { type: "url", name: "gmail", url: "https://gmail-mcp.example.com/x" },
        { type: "url", name: "gmail_work", url: "https://gmail-mcp.example.com/x?profile=work" },
      ],
      tools: [{ type: "mcp_toolset", mcp_server_name: "gmail" }],
    };
    expect(toOpencodeAgentConfig(agentCfg)).toEqual({
      mcp: {
        gmail: { type: "remote", url: "https://gmail-mcp.example.com/x", enabled: true, oauth: false },
        gmail_work: {
          type: "remote",
          url: "https://gmail-mcp.example.com/x?profile=work",
          enabled: true,
          oauth: false,
        },
      },
    });
  });

  it("NO mete credenciales (el AV inyecta el Bearer en el egress)", () => {
    const out = toOpencodeAgentConfig({
      mcp_servers: [{ type: "url", name: "drive", url: "https://drive-mcp/x" }],
    });
    expect(JSON.stringify(out)).not.toMatch(/authorization|bearer|token|apikey/i);
  });

  it("no mete headers en servers NO-tavily ni credenciales en ninguno (el AV inyecta el Bearer)", () => {
    const out = toOpencodeAgentConfig({
      mcp_servers: [
        { type: "url", name: "control", url: "https://ceibo.example.com/mcp/control/sek" },
        { type: "url", name: "gmail", url: "https://gmail-mcp/x" },
      ],
    });
    expect(out.mcp.control).not.toHaveProperty("headers");
    expect(out.mcp.gmail).not.toHaveProperty("headers");
    expect(JSON.stringify(out)).not.toMatch(/authorization|bearer/i);
  });

  it("capa el payload de Tavily con el header DEFAULT_PARAMETERS (search_depth basic, max_results 3, sin raw/imgs)", () => {
    const out = toOpencodeAgentConfig({
      mcp_servers: [{ type: "url", name: "tavily", url: "https://mcp.tavily.com/mcp/" }],
    });
    const tavily = out.mcp.tavily;
    expect(tavily).toMatchObject({
      type: "remote",
      url: "https://mcp.tavily.com/mcp/",
      enabled: true,
      oauth: false,
    });
    const raw = tavily?.headers?.[TAVILY_DEFAULT_PARAMETERS_HEADER];
    expect(raw).toBeTruthy();
    // El valor es un JSON con los defaults del cap: acotado y sin los grandes drivers de tamaño.
    expect(JSON.parse(raw as string)).toEqual({
      search_depth: "basic",
      max_results: 3,
      include_raw_content: false,
      include_images: false,
      include_favicon: false,
    });
    // El cap NO es una credencial: el AV sigue siendo quien inyecta el Bearer.
    expect(JSON.stringify(out)).not.toMatch(/authorization|bearer/i);
  });

  it("el cap es un HARD cap independiente del nombre-URL: sólo el server 'tavily' recibe el header", () => {
    const out = toOpencodeAgentConfig({
      mcp_servers: [
        { type: "url", name: "tavily", url: "https://mcp.tavily.com/mcp/" },
        // Otro server hosted en el mismo dominio pero con OTRO nombre: no debe recibir el cap.
        { type: "url", name: "otro", url: "https://mcp.tavily.com/mcp/" },
      ],
    });
    expect(out.mcp.tavily).toHaveProperty("headers");
    expect(out.mcp.otro).not.toHaveProperty("headers");
  });

  it("saltea servers sin name o sin url; sin mcp_servers → mcp vacío", () => {
    expect(
      toOpencodeAgentConfig({
        mcp_servers: [
          { type: "url", name: "ok", url: "https://ok/x" },
          { type: "url", name: "sin-url" },
          { type: "url", url: "https://sin-name/x" },
        ],
      }),
    ).toEqual({ mcp: { ok: { type: "remote", url: "https://ok/x", enabled: true, oauth: false } } });
    expect(toOpencodeAgentConfig({})).toEqual({ mcp: {} });
    expect(toOpencodeAgentConfig(null)).toEqual({ mcp: {} });
  });
});
