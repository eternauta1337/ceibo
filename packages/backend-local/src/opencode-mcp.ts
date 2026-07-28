// Traducción de la config de agente de la COSTURA (forma Managed Agents) al formato MCP de
// opencode. El gateway arma la config con `mcp_servers` Anthropic (`[{type:"url", name, url}]`)
// + `tools` (toolsets); MA monta esos servers y, al llamar cada MCP, inyecta el Bearer por-URL
// desde el vault. opencode usa OTRA forma: un objeto `mcp` con entradas `remote` por nombre.
//
// Por eso `setAgentConfig` no puede mandar la forma Anthropic cruda a opencode (la ignora). Acá
// la traducimos. CLAVE: NO mandamos credenciales — igual que MA, el server va sólo con name+url;
// el Bearer lo inyecta el AV MITM proxy en el egress de la vm gpuhost (workstream B, parte AV). El
// `tools` (toolsets always_allow) no se traduce: montar el server remoto ya expone sus tools en
// opencode (la auto-aprobación de permisos para correr headless se cablea en la parte AV/live).

/** Server MCP remoto en el formato de opencode (config `mcp` de opencode.json / POST /mcp).
 *  `oauth: false` = desactiva la auto-detección de OAuth de opencode: el Bearer lo inyecta el
 *  AV MITM-proxy transparentemente en el egress, así que opencode NO debe arrancar su propio
 *  flujo OAuth (si no, el server queda en `needs_auth` en vez de `connected`).
 *  `headers`: headers extra que opencode manda al server remoto en cada request. NO se usa para
 *  credenciales (esas las inyecta el AV por-host) — sólo para config no-secreta como el cap de
 *  Tavily (`DEFAULT_PARAMETERS`, ver `TAVILY_DEFAULT_PARAMETERS_HEADER`). El AV es un proxy de
 *  egress transparente: allowlistea el host e inyecta el Bearer, pero reenvía el resto de headers. */
export interface OpencodeRemoteMcp {
  type: "remote";
  url: string;
  enabled: boolean;
  oauth: false;
  headers?: Record<string, string>;
}

/** Nombre del server MCP de Tavily (búsqueda web hosted). Debe coincidir con `TAVILY_SERVER_NAME`
 *  del gateway (`@ceibo/gateway/engine`), que es quien lo monta; no lo importamos para no invertir
 *  la dependencia entre paquetes (gateway → backend-local, no al revés). */
const TAVILY_SERVER_NAME = "tavily";

/** Cap del payload de Tavily (búsqueda web) — HARD cap del lado de ceibo, request-side.
 *
 *  El modelo chico de archima (`gemma4-31b`) llama `tavily_search`; los resultados de Tavily son
 *  MUY verbosos (raw content de cada página, imágenes, favicons) y con varias búsquedas en un turno
 *  inflaron el contexto a >64k tokens → forzaron una compactación en medio del turno → respuesta
 *  degradada. El fix acota lo que Tavily DEVUELVE aplicando defaults chicos server-side.
 *
 *  El MCP hosted de Tavily acepta defaults por request vía el header `DEFAULT_PARAMETERS` (JSON).
 *  No podemos trimear la RESPONSE del lado de ceibo (viaja vm→AV→Tavily y vuelta, todo dentro de
 *  infra/AV, sin pasar por este código) — así que el lever robusto disponible es capar la REQUEST:
 *   - `search_depth: "basic"`  → menos procesamiento y contenido por resultado.
 *   - `max_results: 3`         → pocos resultados (el driver de cantidad).
 *   - `include_raw_content: false` → apaga el HTML/markdown crudo de cada página (el mayor driver
 *                                    de tamaño; el `content` resumido por resultado alcanza).
 *   - `include_images: false` / `include_favicon: false` → sin URLs de imágenes ni favicons.
 *  Sigue siendo útil (título + url + snippet de los 3 mejores), sólo MUCHO más chico.
 *
 *  Alcance del cap: son los DEFAULTS de Tavily para params que el modelo no manda explícito. En la
 *  práctica gemma casi nunca pasa estos flags, así que el efecto es un cap duro; los apagados de
 *  contenido (raw_content/images/favicon), que son los mayores drivers de tamaño, aplican salvo que
 *  el modelo los pida a propósito (no lo hace). Un hard cap total por-tamaño requeriría trimear la
 *  response en el AV (infra) — fuera de alcance de este cambio. */
const TAVILY_CAP_DEFAULTS = {
  search_depth: "basic",
  max_results: 3,
  include_raw_content: false,
  include_images: false,
  include_favicon: false,
} as const;

/** Header que el MCP hosted de Tavily lee para fijar los defaults de cada request. */
export const TAVILY_DEFAULT_PARAMETERS_HEADER = "DEFAULT_PARAMETERS";

/** Override de agente para opencode: el set de MCP servers remotos por nombre. */
export interface OpencodeAgentConfig {
  mcp: Record<string, OpencodeRemoteMcp>;
}

/** Lo único que nos importa de cada `mcp_server` de la config Anthropic (name + url; la
 *  credencial no viaja inline). El resto de la forma Anthropic se ignora. */
interface UrlMcpServer {
  name?: string;
  url?: string;
}

/** Traduce la config de agente (forma MA: `mcp_servers: [{type:"url", name, url}]`) al `mcp` de
 *  opencode (`{<name>: {type:"remote", url, enabled, oauth:false}}`). Sin credenciales (las
 *  inyecta el AV); `oauth:false` evita que opencode arranque su propio flujo OAuth.
 *  Tolera shapes parciales: saltea servers sin name o sin url. */
export function toOpencodeAgentConfig(agentCfg: unknown): OpencodeAgentConfig {
  const servers = (agentCfg as { mcp_servers?: UrlMcpServer[] } | null)?.mcp_servers ?? [];
  const mcp: Record<string, OpencodeRemoteMcp> = {};
  for (const s of servers) {
    if (!s?.name || !s?.url) continue;
    const entry: OpencodeRemoteMcp = { type: "remote", url: s.url, enabled: true, oauth: false };
    // Cap del payload de Tavily: inyectamos el header `DEFAULT_PARAMETERS` SÓLO en el server de
    // búsqueda web, para que Tavily devuelva un resultado acotado (ver `TAVILY_CAP_DEFAULTS`). No
    // es una credencial (el AV inyecta el Bearer aparte); es config no-secreta que reduce el tamaño.
    if (s.name === TAVILY_SERVER_NAME) {
      entry.headers = { [TAVILY_DEFAULT_PARAMETERS_HEADER]: JSON.stringify(TAVILY_CAP_DEFAULTS) };
    }
    mcp[s.name] = entry;
  }
  return { mcp };
}
