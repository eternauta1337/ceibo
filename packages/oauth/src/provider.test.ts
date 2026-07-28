import { describe, expect, it } from "vitest";
import { buildAgentMcpConfig, buildRemMcpConfig } from "./index.ts";

// Env mínimo: las 5 URLs de los servicios base son obligatorias.
const baseEnv = (): NodeJS.ProcessEnv => ({
  GMAIL_MCP_URL: "https://mcp/gmail",
  CALENDAR_MCP_URL: "https://mcp/calendar",
  DRIVE_MCP_URL: "https://mcp/drive",
  SHEETS_MCP_URL: "https://mcp/sheets",
  NOTION_MCP_URL: "https://mcp/notion",
});

const names = (cfg: ReturnType<typeof buildAgentMcpConfig>) => cfg.mcp_servers.map((s) => s.name);

describe("buildAgentMcpConfig", () => {
  it("config base: exactamente los 5 servicios + el agent_toolset y su mcp_toolset cada uno", () => {
    const cfg = buildAgentMcpConfig({ env: baseEnv() });
    expect(names(cfg)).toEqual(["gmail", "calendar", "drive", "sheets", "notion"]);
    // tools: 1 agent_toolset + 5 mcp_toolset
    expect(cfg.tools[0]).toMatchObject({ type: "agent_toolset_20260401" });
    expect(cfg.tools.filter((t) => t.type === "mcp_toolset")).toHaveLength(5);
  });

  it("falta una env obligatoria → tira nombrando la env", () => {
    const env = baseEnv();
    delete env.GMAIL_MCP_URL;
    expect(() => buildAgentMcpConfig({ env })).toThrow(/GMAIL_MCP_URL/);
  });

  it("monta schedule/wacli/viewer solo si su env está presente", () => {
    const env = { ...baseEnv(), SCHEDULE_MCP_URL: "https://mcp/sched", WACLI_MCP_URL: "https://mcp/wa" };
    const cfg = buildAgentMcpConfig({ env });
    expect(names(cfg)).toContain("schedule");
    expect(names(cfg)).toContain("wacli");
    expect(names(cfg)).not.toContain("viewer"); // sin VIEWER_MCP_URL
  });

  it("extraServers (perfiles) se appendean como server + toolset", () => {
    const cfg = buildAgentMcpConfig({
      env: baseEnv(),
      extraServers: [{ name: "gmail_work", url: "https://mcp/gmail?profile=work" }],
    });
    expect(names(cfg)).toContain("gmail_work");
    const work = cfg.mcp_servers.find((s) => s.name === "gmail_work");
    expect(work?.url).toBe("https://mcp/gmail?profile=work");
    expect(cfg.tools.some((t) => t.type === "mcp_toolset" && t.mcp_server_name === "gmail_work")).toBe(true);
  });

  it("defaultUrlOverrides reemplaza la URL del server base conservando el nombre", () => {
    const cfg = buildAgentMcpConfig({
      env: baseEnv(),
      defaultUrlOverrides: { gmail: "https://mcp/gmail?profile=personal" },
    });
    const gmail = cfg.mcp_servers.find((s) => s.name === "gmail");
    expect(gmail?.url).toBe("https://mcp/gmail?profile=personal");
  });

  it("skipMissing: saltea los servicios base sin URL (server + toolset) en vez de tirar", () => {
    // Dev: solo el control MCP, ningún servicio base self-hosted.
    const cfg = buildAgentMcpConfig({
      env: { CONTROL_MCP_URL: "https://mcp/control" },
      skipMissing: true,
    });
    expect(names(cfg)).toEqual(["control"]);
    // un servicio base salteado NO deja su mcp_toolset colgando (referenciaría un server inexistente)
    expect(cfg.tools.filter((t) => t.type === "mcp_toolset")).toHaveLength(1);
    expect(cfg.tools.some((t) => t.type === "mcp_toolset" && t.mcp_server_name === "control")).toBe(true);
  });

  it("skipMissing solo afecta lo ausente: mantiene los servicios base que SÍ tienen URL", () => {
    const env = baseEnv();
    delete env.GMAIL_MCP_URL;
    const cfg = buildAgentMcpConfig({ env, skipMissing: true });
    expect(names(cfg)).toEqual(["calendar", "drive", "sheets", "notion"]);
    expect(cfg.tools.filter((t) => t.type === "mcp_toolset")).toHaveLength(4);
  });
});

describe("buildRemMcpConfig", () => {
  it("sin mcp_servers y solo el agent_toolset (REM trabaja la working copy local)", () => {
    const cfg = buildRemMcpConfig();
    expect(cfg.mcp_servers).toEqual([]);
    expect(cfg.tools).toHaveLength(1);
    expect(cfg.tools[0]).toMatchObject({ type: "agent_toolset_20260401" });
  });
});
