import { describe, expect, it } from "vitest";
import { activityLabel, isSubagentLabel, SUBAGENT_SPAWNED_HINT } from "./activity.ts";

describe("isSubagentLabel", () => {
  it("reconoce los labels del roster y el hint de spawn mecánico (→ kind:subagent)", () => {
    expect(isSubagentLabel("trabajando con un sub-agente")).toBe(true);
    expect(isSubagentLabel("consultando a un especialista")).toBe(true);
    expect(isSubagentLabel(SUBAGENT_SPAWNED_HINT)).toBe(true);
    expect(SUBAGENT_SPAWNED_HINT).toBe("subagente creado");
  });
  it("no marca un tool-call normal", () => {
    expect(isSubagentLabel("actualizando una nota")).toBe(false);
    expect(isSubagentLabel("web search")).toBe(false);
  });
});

describe("activityLabel", () => {
  it("mapea tools conocidas a texto amigable (es), sin detalle", () => {
    expect(activityLabel("schedule_create")).toEqual({ label: "agendando un recordatorio" });
    expect(activityLabel("search")).toEqual({ label: "buscando en la wiki" });
    expect(activityLabel("write")).toEqual({ label: "actualizando una nota" });
    expect(activityLabel("ceibo_command")).toEqual({ label: "ejecutando un comando" });
  });

  it("mapea tools built-in MA del agent_toolset_20260401 a texto amigable sin jerga", () => {
    // glob, grep, ls, find → wording de producto (notas/wiki), sin nombre técnico.
    expect(activityLabel("glob")).toEqual({ label: "buscando archivos en tu wiki" });
    expect(activityLabel("grep")).toEqual({ label: "buscando en tus notas" });
    expect(activityLabel("ls")).toEqual({ label: "explorando tu wiki" });
    expect(activityLabel("find")).toEqual({ label: "buscando en tu wiki" });
    // Con args en el detail.
    expect(activityLabel("glob", { pattern: "**/*.md" })).toEqual({
      label: "buscando archivos en tu wiki",
      detail: "**/*.md",
    });
    expect(activityLabel("grep", { pattern: "viaje" })).toEqual({
      label: "buscando en tus notas",
      detail: "viaje",
    });
    // web_search / web_fetch → amable, sin nombre técnico en el label.
    expect(activityLabel("web_search")).toEqual({ label: "buscando en la web" });
    expect(activityLabel("web_fetch")).toEqual({ label: "leyendo una página web" });
    expect(activityLabel("web_search", { query: "hoteles en kioto" })).toEqual({
      label: "buscando en la web",
      detail: "hoteles en kioto",
    });
    expect(activityLabel("web_fetch", { url: "https://ejemplo.com/noticias" })).toEqual({
      label: "leyendo una página web",
      detail: "https://ejemplo.com/noticias",
    });
    // websearch / fetch: alias también mapeados.
    expect(activityLabel("websearch")).toEqual({ label: "buscando en la web" });
    expect(activityLabel("fetch")).toEqual({ label: "leyendo una página web" });
  });

  it("pela el prefijo mcp__server__ antes de mapear", () => {
    expect(activityLabel("mcp__wiki__write")).toEqual({ label: "actualizando una nota" });
    expect(activityLabel("mcp__schedule__schedule_create")).toEqual({ label: "agendando un recordatorio" });
  });

  it("traduce el marcador de sub-agente a un hint amable; el modelo va sólo al detail (debug)", () => {
    // worker-high = opus → el "especialista"; el modelo va al detail (sólo se ve en debug).
    expect(activityLabel("sub-agente: worker-high")).toEqual({
      label: "consultando a un especialista",
      detail: "opus",
    });
    expect(activityLabel("sub-agente: worker-mid")).toEqual({
      label: "trabajando con un sub-agente",
      detail: "sonnet",
    });
    expect(activityLabel("sub-agente: worker-low")).toEqual({
      label: "trabajando con un sub-agente",
      detail: "haiku",
    });
    // Nombre fuera del roster (o `?`): genérico amable, sin filtrar el nombre crudo ni detail.
    expect(activityLabel("sub-agente: ?")).toEqual({ label: "trabajando con un sub-agente" });
    expect(activityLabel("sub-agente: worker-otro")).toEqual({ label: "trabajando con un sub-agente" });
  });

  it("fallback para tools desconocidas: label genérico amable, nombre técnico al principio del detail", () => {
    // NUNCA muestra jerga en el label always-on → siempre "trabajando".
    expect(activityLabel("alguna_tool_rara")).toEqual({ label: "trabajando", detail: "alguna tool rara" });
    expect(activityLabel("mcp__loquesea__una-tool")).toEqual({ label: "trabajando", detail: "una tool" });
    // Con args: nombre técnico + ": " + args en el detail.
    expect(activityLabel("herramienta_desconocida", { pattern: "**/*.md" })).toEqual({
      label: "trabajando",
      detail: "herramienta desconocida: **/*.md",
    });
  });

  it("label nunca es vacío", () => {
    expect(activityLabel("")).toEqual({ label: "trabajando" });
    expect(activityLabel("   ")).toEqual({ label: "trabajando" });
  });

  it("deduplica el nombre del server cuando la tool ya arranca con él (7.1)", () => {
    // MA aplana las tools del MCP hosted como `<server>_<tool>`; Tavily expone `tavily_search`
    // bajo el server `tavily` → `tavily_tavily_search` daría "tavily tavily search". Colapsamos a
    // `tavily_search`, que mapea al label amable "web search" (no exponemos el proveedor).
    expect(activityLabel("tavily_tavily_search")).toEqual({ label: "web search" });
    // Con la query como detalle (input de una búsqueda Tavily real).
    expect(activityLabel("tavily_tavily_search", { query: "clima en kioto" })).toEqual({
      label: "web search",
      detail: "clima en kioto",
    });
    // Idem si MA lo manda fully-qualified `mcp__server__tool`: bare = `tavily_search` → "web search".
    expect(activityLabel("mcp__tavily__tavily_search")).toEqual({ label: "web search" });
    // Tool == server exacto (sin sufijo) → `tavily_tavily` colapsa a "tavily" (desconocida →
    // label genérico amable, nombre técnico en detail).
    expect(activityLabel("tavily_tavily")).toEqual({ label: "trabajando", detail: "tavily" });
  });

  it("NO deduplica cuando el server aporta contexto (no hay solapamiento de prefijo)", () => {
    // gmail + search → "gmail search" es útil; no se colapsa (server ≠ prefijo de la tool).
    // Son tools desconocidas → label genérico, nombre técnico en detail.
    expect(activityLabel("gmail_search")).toEqual({ label: "trabajando", detail: "gmail search" });
    expect(activityLabel("notion_get_page")).toEqual({ label: "trabajando", detail: "notion get page" });
    // No colapsa una repetición que NO es la palabra-prefijo inicial.
    expect(activityLabel("foo_bar_bar")).toEqual({ label: "trabajando", detail: "foo bar bar" });
  });

  it("separa el verbo (label) del param más útil (detail) de cada tool conocida", () => {
    expect(activityLabel("edit", { file_path: "src/index.ts" })).toEqual({
      label: "editando una nota",
      detail: "src/index.ts",
    });
    expect(activityLabel("mcp__wiki__write", { file_path: "viajes/japón" })).toEqual({
      label: "actualizando una nota",
      detail: "viajes/japón",
    });
    expect(activityLabel("search", { query: "hoteles en kioto" })).toEqual({
      label: "buscando en la wiki",
      detail: "hoteles en kioto",
    });
  });

  it("file-ops usan wording de nota (no 'archivo'), con el path sólo en el detail", () => {
    expect(activityLabel("create", { file_path: "/mnt/session/notas/idea.md" })).toEqual({
      label: "creando una nota",
      detail: "/mnt/session/notas/idea.md",
    });
    expect(activityLabel("view", { file_path: "/mnt/session/notas/idea.md" })).toEqual({
      label: "leyendo una nota",
      detail: "/mnt/session/notas/idea.md",
    });
    expect(activityLabel("str_replace", { file_path: "a.md" })).toEqual({
      label: "editando una nota",
      detail: "a.md",
    });
  });

  it("bash: reconoce wiki-sync pull/push y da un label amable (comando sólo en detail)", () => {
    // El caso real del screenshot: editar la wiki corriendo el script de sync.
    expect(
      activityLabel("bash", { command: "node /mnt/session/uploads/wiki-sync.mjs pull demo-ceibo 2>&1" }),
    ).toEqual({
      label: "actualizando tu wiki",
      detail: "node /mnt/session/uploads/wiki-sync.mjs pull demo-ceibo 2>&1",
    });
    expect(
      activityLabel("bash", { command: "node /mnt/session/uploads/wiki-sync.mjs push demo-ceibo" }),
    ).toEqual({
      label: "guardando en tu wiki",
      detail: "node /mnt/session/uploads/wiki-sync.mjs push demo-ceibo",
    });
    // wiki-sync sin pull/push → sincronizando
    expect(activityLabel("bash", { command: "node wiki-sync.mjs status" })).toEqual({
      label: "sincronizando tu wiki",
      detail: "node wiki-sync.mjs status",
    });
  });

  it("bash: git → 'guardando cambios' (amable), no el comando", () => {
    expect(activityLabel("bash", { command: "git commit -am 'wip'" })).toEqual({
      label: "guardando cambios",
      detail: "git commit -am 'wip'",
    });
    expect(activityLabel("bash", { command: "git status" })).toEqual({
      label: "guardando cambios",
      detail: "git status",
    });
    // git embebido en un compound no dispara falsos: 'legit' no es git
    expect(activityLabel("bash", { command: "echo legitimate" })).toEqual({
      label: "corriendo una tarea",
      detail: "echo legitimate",
    });
  });

  it("bash: comando no reconocido → genérico amable + comando en el detail", () => {
    expect(activityLabel("bash", { command: "node build.mjs --watch" })).toEqual({
      label: "corriendo una tarea",
      detail: "node build.mjs --watch",
    });
    // input string suelto también funciona
    expect(activityLabel("bash", "ls -la /mnt")).toEqual({
      label: "corriendo una tarea",
      detail: "ls -la /mnt",
    });
  });

  it("schedule_create prefiere el título sobre el what", () => {
    expect(
      activityLabel("schedule_create", { title: "Dentista de Alicia", what: "recordale el turno" }),
    ).toEqual({
      label: "agendando un recordatorio",
      detail: "Dentista de Alicia",
    });
    // sin title, cae a what
    expect(activityLabel("schedule_create", { what: "revisá el inbox" })).toEqual({
      label: "agendando un recordatorio",
      detail: "revisá el inbox",
    });
  });

  it("fallback genérico: usa el primer string significativo de una tool desconocida (nombre en detail)", () => {
    // Tool desconocida con args: label="trabajando", detail="<nombre técnico>: <args>".
    expect(activityLabel("herramienta_x", { foo: "valor útil" })).toEqual({
      label: "trabajando",
      detail: "herramienta x: valor útil",
    });
  });

  it("fallback genérico: key=value (hasta 2) cuando no hay strings (nombre en detail)", () => {
    // Sin strings, combina nombre técnico con key=value de los primeros 2 campos primitivos.
    expect(activityLabel("toolnum", { count: 3, total: 9, extra: 7 })).toEqual({
      label: "trabajando",
      detail: "toolnum: count=3, total=9",
    });
  });

  it("acepta un input string suelto (tool desconocida → label genérico, nombre en detail)", () => {
    expect(activityLabel("mcp__x__raratool", "un argumento crudo")).toEqual({
      label: "trabajando",
      detail: "raratool: un argumento crudo",
    });
  });

  it("trunca y colapsa el detalle (una sola línea, con elipsis)", () => {
    const long = `sh -c "${"a".repeat(200)}"`;
    const out = activityLabel("bash", { command: long });
    expect(out.label).toBe("corriendo una tarea");
    expect(out.detail?.length).toBeLessThanOrEqual(70);
    expect(out.detail?.endsWith("…")).toBe(true);
    const multiline = activityLabel("bash", { command: "git status\n\n   &&   git  log" });
    expect(multiline).toEqual({ label: "guardando cambios", detail: "git status && git log" });
  });

  it("omite campos con pinta de secreto", () => {
    // Tool desconocida con sólo secrets → label genérico, detail = solo el nombre técnico (sin args).
    expect(activityLabel("auth_tool", { api_key: "sk-123", token: "abc" })).toEqual({
      label: "trabajando",
      detail: "auth tool",
    });
    // Tool desconocida: sí muestra un campo no-secreto en el detail (tras el nombre técnico).
    expect(activityLabel("login", { token: "abc", user: "ale" })).toEqual({
      label: "trabajando",
      detail: "login: ale",
    });
  });

  it("sin input devuelve sólo el verbo (label), sin detail", () => {
    expect(activityLabel("bash")).toEqual({ label: "corriendo una tarea" });
    expect(activityLabel("schedule_list")).toEqual({ label: "mirando tu agenda" });
  });
});
