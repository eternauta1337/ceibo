// MCP `viewer` (managed-ui Fase B) — el agente maneja la VISTA WEB del usuario.
//
// Vive en el web-server (NO en el launcher de @ceibo/mcps) porque necesita el mapa de
// sesiones WS vivas, que es in-process. Reusa el transporte MCP de @ceibo/mcps
// (handleMcpPost) y se monta como ruta /mcp/viewer/<secret> en el web server. El Bearer
// que inyecta el vault es un token de identidad firmado (`<userId>.<hmac>`, HMAC con
// VIEWER_MCP_HMAC_KEY) → de ahí sale el userId; el efecto se empuja a las pestañas de ESE
// usuario por el WS. Sin vista abierta, la tool lo dice y el agente cae a describir.
// C1 (resuelto): VIEWER_MCP_HMAC_KEY es la clave HMAC dedicada; VIEWER_MCP_SECRET sigue
// siendo el path-secret de la URL (/mcp/viewer/<secret>) y NO se expone como clave HMAC.
//
// No devuelve el contenido del archivo: sólo enfoca la vista. El front lo baja por
// GET /api/file. Tools: viewer_open, viewer_create (atómico: crea en wiki + abre).

import type { McpServer, Tool, ToolArgs } from "@ceibo/mcps/src/core/transport.ts";
import { verifyUserToken } from "@ceibo/store";
import type { Wikis } from "@ceibo/wikis";
import { type RepoFiles, resolveNote } from "./note-resolve.ts";
import { isSafeRelPath } from "./path-safety.ts";

/** Empuja un mensaje a todas las pestañas vivas de un usuario; devuelve a cuántas llegó. */
export type ViewerPush = (userId: number, msg: unknown) => number;

const TOOLS: Tool[] = [
  {
    name: "viewer_open",
    description:
      "Abre una nota EXISTENTE de una wiki en la VISTA WEB del usuario (si la tiene abierta). " +
      "Pasá el `path` tal como lo ves en el sandbox: /workspace/<wiki>/<ruta> (o <wiki>/<ruta>). " +
      "Resuelvo el nombre contra las notas REALES del usuario: si tu path no existe pero se " +
      "parece a una sola nota, abro ESA; si matchea varias o ninguna, te devuelvo la lista para " +
      "que elijas (NO creo una nota nueva — para eso está viewer_create). NO devuelve el " +
      "contenido — lo muestra en la pantalla del usuario. Si el usuario no tiene la web abierta, " +
      "te lo aviso y describís el archivo por chat.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Ruta del archivo, ej. /workspace/demo-personal/projects/compras.md",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "viewer_create",
    description:
      "ATÓMICO: crea una nota nueva vacía en la wiki Y la abre en la vista web del usuario. " +
      "Una sola llamada hace ambas cosas — NO encadenes con create_or_update_file ni push_files. " +
      "Falla si el path ya existe (no sobreescribe). Pasá `path` como /workspace/<wiki>/<ruta> " +
      "o <wiki>/<ruta>. Si el usuario no tiene la web abierta, igual se crea el archivo (te lo " +
      "informo) y describís por chat.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Ruta de la nota nueva, ej. <wiki>/notas/idea.md" },
      },
      required: ["path"],
    },
  },
];

/** /workspace/<wiki>/<rest> | <wiki>/<rest> → { repo, path }. */
function parsePath(raw: string): { repo: string; path: string } {
  const clean = raw.replace(/^\/+/, "").replace(/^workspace\//, "");
  const i = clean.indexOf("/");
  return i < 0 ? { repo: clean, path: "" } : { repo: clean.slice(0, i), path: clean.slice(i + 1) };
}

export function makeViewerServer(
  /** HMAC key del Bearer firmado (VIEWER_MCP_HMAC_KEY, C1: desacoplada del path-secret
   *  VIEWER_MCP_SECRET que gatea la URL /mcp/viewer/<secret>). */
  hmacKey: string,
  push: ViewerPush,
  /** Para viewer_create: el archivo se crea en la wiki real (atómico) además de abrirse. */
  wikis: Wikis,
  /** Gate: el repo del path tiene que estar en los del user (mismo modelo que /api/file). */
  userRepoNames: (userId: number) => string[],
): McpServer {
  const noView = "El usuario no tiene la vista web abierta. Describílo por chat o pedile que entre con /web.";

  /** Lista los archivos de TODAS las wikis del usuario (para resolver nombre→path en
   *  viewer_open). `listFiles` cachea por HEAD sha (304 conditional) → barato. Una wiki que
   *  falle no rompe la resolución del resto. Filtra `CLAUDE.md` (convención del repo, no nota). */
  async function listUserRepoFiles(userId: number): Promise<RepoFiles[]> {
    const names = userRepoNames(userId);
    return Promise.all(
      names.map(async (repo) => {
        try {
          const files = (await wikis.listFiles(repo)).filter((f) => f.split("/").pop() !== "CLAUDE.md");
          return { repo, files };
        } catch {
          return { repo, files: [] };
        }
      }),
    );
  }

  async function callTool(token: string, name: string, args: ToolArgs): Promise<unknown> {
    const userId = verifyUserToken(token, hmacKey);
    if (userId === undefined) throw new Error("token de viewer inválido");

    // viewer_open / viewer_create: un archivo de wiki (la vista SOLO muestra archivos reales).
    const raw = typeof args.path === "string" ? args.path.trim() : "";
    if (!raw) throw new Error("falta `path`");
    const { repo, path } = parsePath(raw);

    if (name === "viewer_create") {
      if (!repo || !path) throw new Error(`path incompleto: ${raw} (esperaba <wiki>/<ruta>)`);
      // Gate: el agente no puede crear en repos del user que no son.
      if (!userRepoNames(userId).includes(repo)) {
        throw new Error(`el usuario no tiene acceso a la wiki "${repo}"`);
      }
      // Mismo filtro de path que /api/file POST/DELETE/move (defensa en profundidad —
      // hoy el repo gate y la normalización de GitHub cubren la mayoría de los abusos,
      // pero acoplar las dos puertas evita drift si una cambia).
      if (!isSafeRelPath(path)) {
        throw new Error(`path inválido: ${path}`);
      }
      let sha: string;
      try {
        // El H1 inicial es el basename del path (sin .md): el cliente lo muestra como
        // título grande de una. Si el user lo reemplaza, patchDoc dispara rename.
        // Misma convención que el botón "+" del UI.
        const filename = path.split("/").pop() ?? "";
        const base = filename.replace(/\.md$/, "");
        const initial = `# ${base}\n\n`;
        const out = await wikis.createFile(repo, path, initial, `➕ ${path} — viewer_create (agente)`);
        sha = out.sha;
      } catch (e) {
        if ((e as { exists?: boolean }).exists) {
          throw new Error(`"${repo}/${path}" ya existe — usá viewer_open o un path distinto`);
        }
        throw e;
      }
      // Pasamos el sha en el evento para que el cliente NO tenga que GET el archivo
      // (sortea el read-after-write de la Contents API en el primer paint).
      const reached = push(userId, { t: "created", repo, path, sha });
      return {
        created: `${repo}/${path}`,
        delivered: reached > 0,
        ...(reached === 0 ? { note: noView } : {}),
      };
    }

    // viewer_open: RESOLVEMOS el nombre→path real antes de empujar la vista. El agente a
    // veces inventa un path que no existe (pide "backlog" cuando la nota es "backlog-ceibo.md").
    // Si abriéramos crudo: la vista mostraría "no encontré el archivo" y, como el path no
    // coincide con ninguna solapa, tampoco enfocaría la que ya está abierta. Resolviendo,
    // abrimos el path REAL (que sí coincide con la solapa → enfoca) o devolvemos un error claro.
    const repoFiles = await listUserRepoFiles(userId);
    const res = resolveNote(repo, path, repoFiles);
    if (res.kind === "ambiguous") {
      const list = res.candidates.map((c) => `${c.repo}/${c.path}`).join(", ");
      throw new Error(
        `"${raw}" matchea varias notas: ${list}. Reintentá viewer_open con el path exacto de la que querés abrir.`,
      );
    }
    if (res.kind === "none") {
      const avail = repoFiles.flatMap((r) =>
        r.files.filter((f) => f.endsWith(".md")).map((f) => `${r.repo}/${f}`),
      );
      const shown = avail.slice(0, 20).join(", ");
      const more = avail.length > 20 ? ", …" : "";
      throw new Error(
        `no encontré ninguna nota que matchee "${raw}". ` +
          `Notas disponibles: ${shown || "(ninguna)"}${more}. ` +
          "Si querés crear una nota nueva usá viewer_create.",
      );
    }
    const reached = push(userId, { t: "open", repo: res.repo, path: res.path });
    return reached === 0
      ? { delivered: false, note: noView }
      : { delivered: true, opened: `${res.repo}/${res.path}` };
  }
  return { name: "viewer", tools: TOOLS, callTool };
}
