// Gating de la búsqueda web (Tavily) — fija la política: SOLO archima (backend local) y SOLO con
// `TAVILY_MCP_URL` seteado. MA nunca la monta (su egress no pasa por el AV). Ver `webSearchExtraServers`.

import type { User } from "@ceibo/store";
import { describe, expect, it } from "vitest";
import { TAVILY_SERVER_NAME, webSearchExtraServers } from "./engine.ts";

const user = (mode: "ma" | "local"): Pick<User, "backend_mode"> => ({ backend_mode: mode });
const URL = "https://mcp.tavily.com/mcp/";

describe("webSearchExtraServers", () => {
  it("monta Tavily para archima (local) cuando TAVILY_MCP_URL está seteado", () => {
    expect(webSearchExtraServers({ TAVILY_MCP_URL: URL }, user("local"))).toEqual([
      { name: TAVILY_SERVER_NAME, url: URL },
    ]);
  });

  it("NO monta nada en MA aunque TAVILY_MCP_URL esté seteado (su egress no pasa por el AV)", () => {
    expect(webSearchExtraServers({ TAVILY_MCP_URL: URL }, user("ma"))).toEqual([]);
  });

  it("NO monta nada en archima si falta TAVILY_MCP_URL (feature off)", () => {
    expect(webSearchExtraServers({}, user("local"))).toEqual([]);
  });

  it("NO monta nada con TAVILY_MCP_URL vacío (string falsy)", () => {
    expect(webSearchExtraServers({ TAVILY_MCP_URL: "" }, user("local"))).toEqual([]);
  });
});
