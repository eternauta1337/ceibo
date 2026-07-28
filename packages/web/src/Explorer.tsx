// Explorador de archivos (managed-ui): panel a la izquierda, NO modal — el círculo / la
// vista quedan al lado y siguen interactivos. Lista las wikis del usuario como árbol
// (carpetas colapsables → archivos). Tocar un archivo lo abre por el MISMO camino que el
// agente (ch.open). El archivo abierto se marca y se expande la ruta hasta él.
//
// Estado del árbol (qué wiki/carpeta está expandida) persistido en localStorage bajo
// `ceibo_exp:<handle>` (aislado por usuario para no heredar estado entre sesiones que
// comparten browser). Por default todo arranca colapsado.

import {
  type CSSProperties,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { addExpandKeys, folderKeyOf as folderKey } from "./explorerExpand.ts";
import { isVisibleWikiFile } from "./explorerFiles.ts";
import { reconcileTree, pendKey as remKey } from "./explorerReconcile.ts";
import type { FsOp } from "./fsOps.ts";
import { replaceOrInsertH1 } from "./h1Title.ts";
import {
  IconArchive,
  IconBell,
  IconClock,
  IconFiles,
  IconLanguages,
  IconLauncher,
  IconLogOut,
  IconMessage,
  IconPalette,
  IconPanelLeftClose,
  IconPlug,
  IconSettings,
  IconShare,
  IconTrash,
  IconUser,
  IconUserPlus,
} from "./icons.tsx";
import { readTree, writeTree } from "./localCache.ts";
import "./memberChips.css";
import { avatarSrc, chipMix, initials } from "./memberFace.ts";
import { SYSTEM_PAGES, type SystemPage } from "./systemPages.ts";
import type { InboxItem } from "./useChannel.ts";
import { useVersionInfo } from "./useVersionInfo.ts";
import { versionBadge } from "./version.ts";

/** Long-press para abrir el menú contextual en touch (mobile): mantené ~500ms sobre un
 *  item y se dispara `onLongPress` con las coords. `fired` queda en true para que el
 *  onClick del item se saltee (no abrir/togglear), y en touchend prevenimos los mouse
 *  events sintéticos (que cerrarían el menú recién abierto). En desktop el menú sigue
 *  saliendo por `onContextMenu` (click derecho). */
function useLongPress(onLongPress: (x: number, y: number) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const start = useRef({ x: 0, y: 0 });
  const clear = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  return {
    fired,
    handlers: {
      onTouchStart: (e: TouchEvent) => {
        const t = e.touches[0];
        if (!t) return;
        const x = t.clientX;
        const y = t.clientY;
        start.current = { x, y };
        fired.current = false;
        clear();
        timer.current = setTimeout(() => {
          fired.current = true;
          onLongPress(x, y);
        }, 450);
      },
      // Sólo cancelamos si el dedo se MUEVE de verdad (>10px = scroll/drag). El micro-jitter
      // del dedo no debe abortar el long-press (era por qué "no andaba": cancelaba al toque).
      onTouchMove: (e: TouchEvent) => {
        const t = e.touches[0];
        if (!t) return;
        const dx = t.clientX - start.current.x;
        const dy = t.clientY - start.current.y;
        if (dx * dx + dy * dy > 100) clear();
      },
      onTouchEnd: (e: TouchEvent) => {
        clear();
        if (fired.current) e.preventDefault(); // suprime el click/tap sintético post long-press
      },
      onTouchCancel: () => clear(),
    },
  };
}

interface Member {
  handle: string;
  name: string;
  /** ¿El usuario tiene avatar subido? Si sí, el chip muestra la foto (GET /api/avatar/<handle>)
   *  con fallback a las iniciales. Ausente en cachés viejos → tratado como false. */
  hasAvatar?: boolean;
}
interface Wiki {
  repo: string;
  label: string;
  files: string[];
  /** Emoji por-nota (estilo Notion): mapa `path repo-relativo → emoji`. Ausente en cachés/servers
   *  viejos → se trata como vacío (las notas se ven igual que hoy). */
  emojis?: Record<string, string>;
  /** Usuarios con acceso a la wiki (para "compartida con"). Ausente en cachés viejos. */
  members?: Member[];
  /** Rol del viewer en esta wiki (ej. "owner", "member"). */
  role?: string;
  /** ¿Es la wiki personal del usuario (1:1 con su handle)? No se puede archivar ni borrar. */
  personal?: boolean;
  /** ¿El viewer es el dueño (owner) de esta wiki? */
  isOwner?: boolean;
  /** Invitaciones pendientes (email + fecha). Sólo visible al owner. */
  pendingInvites?: Array<{ email: string; createdAt: string }>;
}
interface Node {
  name: string;
  path?: string; // archivos: path repo-relativo completo
  full?: string; // carpetas: su path repo-relativo
  children?: Node[];
}
export interface Current {
  repo: string;
  path: string;
}

const EXP_KEY_PREFIX = "ceibo_exp:";
const HANDLE_KEY = "ceibo_handle";
// Ancho del explorer elegido por el usuario al arrastrar el handle (px, como string CSS).
// Global (no per-handle): es una preferencia de layout, no de sesión.
const EXP_W_KEY = "ceibo_exp_w";
// `folderKey` (clave de carpeta en el set `expanded`) y la lógica de auto-expansión viven en
// explorerExpand.ts (puro, testeable). Acá lo importamos aliaseado para no tocar las llamadas.
// La clave estable repo+path para los sets de pendientes (remKey) vive en explorerReconcile.ts.

/** Estilo del contenedor de hijos (`.exp-children`): posiciona la línea guía vertical
 *  de indentación (estilo Obsidian) bajo el chevron del padre. `guideX` en rem. */
const childrenStyle = (guideX: number): CSSProperties =>
  ({ "--exp-guide-x": `${guideX}rem` }) as CSSProperties;

// --- API client (operaciones de archivo del explorer) ----------------------
// Pega contra los endpoints del gateway (POST/DELETE/POST move). Todos comparten
// la cookie de sesión + el chequeo de userRepoNames del lado server.
async function apiGetSha(repo: string, path: string): Promise<string> {
  const r = await fetch(`/api/file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error(`get ${r.status}`);
  const j = (await r.json()) as { sha?: string };
  if (!j.sha) throw new Error("respuesta sin sha");
  return j.sha;
}
async function apiGetFile(repo: string, path: string): Promise<{ content: string; sha: string }> {
  const r = await fetch(`/api/file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error(`get ${r.status}`);
  const j = (await r.json()) as { content?: string; sha?: string };
  if (!j.sha || typeof j.content !== "string") throw new Error("respuesta incompleta");
  return { content: j.content, sha: j.sha };
}
// Archivar = borrar la nota + indexarla en el `_archivado.md` de su carpeta, en un commit
// (modelo archivado-por-historia). Reemplaza al borrado directo: la nota sale de la vista pero
// vive en la historia de git, recuperable con el agente (recall / search-archived).
async function apiArchive(repo: string, path: string, baseSha: string): Promise<void> {
  const r = await fetch("/api/file/archive", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, path, baseSha }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `archive ${r.status}`);
  }
}
// Archivar una carpeta ENTERA en un commit server-side: borra todo lo que vive bajo su prefijo
// (notas + índices `_index.md`/`_archivado.md`) e indexa las notas en el `_archivado.md` de la
// carpeta PADRE. Antes se archivaba nota-a-nota y el manifest quedaba ADENTRO de la carpeta →
// la carpeta "borrada" renacía anclada por su índice (zombie) y nunca más se podía borrar.
async function apiArchiveFolder(repo: string, path: string): Promise<void> {
  const r = await fetch("/api/folder/archive", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, path }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `archive-folder ${r.status}`);
  }
}
async function apiCreate(repo: string, path: string, content = ""): Promise<void> {
  const r = await fetch("/api/file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, path, content }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `create ${r.status}`);
  }
}
async function apiMove(
  repo: string,
  fromPath: string,
  toPath: string,
  baseSha: string,
  newContent?: string,
): Promise<void> {
  const r = await fetch("/api/file/move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repo,
      fromPath,
      toPath,
      baseSha,
      ...(newContent !== undefined ? { newContent } : {}),
    }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `move ${r.status}`);
  }
}

/** Mueve un archivo de una wiki a OTRA (cross-wiki). El server compone getFile(A)→createFile(B)→
 *  deleteFile(A) (sin atomicidad: son dos repos git). Devuelve `warning:"source-not-deleted"` si el
 *  destino se creó pero el origen no se pudo borrar (queda duplicado) — el caller lo avisa. */
async function apiMoveCross(
  fromRepo: string,
  fromPath: string,
  toRepo: string,
  toPath: string,
  baseSha: string,
): Promise<{ warning?: string }> {
  const r = await fetch("/api/file/move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fromRepo, toRepo, fromPath, toPath, baseSha }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `move ${r.status}`);
  }
  return (await r.json().catch(() => ({}))) as { warning?: string };
}

/** Renombra el ALIAS (display label) de una wiki. NO toca el repo de GitHub — sólo `repo.label`
 *  en el store (igual que `ceibo repo label` / `/wiki label`). (7.5) */
async function apiSetWikiLabel(repo: string, label: string): Promise<void> {
  const r = await fetch("/api/wiki/label", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, label }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `label ${r.status}`);
  }
}

/** Crea una nueva wiki con el label dado. */
async function apiCreateWiki(label: string): Promise<void> {
  const r = await fetch("/api/wiki", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `create-wiki ${r.status}`);
  }
}

/** Invita a un miembro por handle. */
async function apiInviteMember(repo: string, handle: string): Promise<void> {
  const r = await fetch("/api/wiki/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, handle }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `invite-member ${r.status}`);
  }
}

/** Invita a un usuario por email. */
async function apiInviteByEmail(repo: string, email: string): Promise<void> {
  const r = await fetch("/api/wiki/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, email }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `invite-email ${r.status}`);
  }
}

/** Cancela una invitación pendiente por email. */
async function apiRemoveInvite(repo: string, email: string): Promise<void> {
  const r = await fetch("/api/wiki/invite", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, email }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `remove-invite ${r.status}`);
  }
}

/** Remueve a un miembro de la wiki. */
async function apiRemoveMember(repo: string, handle: string): Promise<void> {
  const r = await fetch("/api/wiki/member", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, handle }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `remove-member ${r.status}`);
  }
}

/** Archiva una wiki (soft-delete del asistente). */
async function apiArchiveWiki(repo: string): Promise<void> {
  const r = await fetch("/api/wiki/archive", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `archive-wiki ${r.status}`);
  }
}

/** El usuario actual deja la wiki (invitado). */
async function apiLeaveWiki(repo: string): Promise<void> {
  const r = await fetch("/api/wiki/leave", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `leave-wiki ${r.status}`);
  }
}

/** Borra una wiki permanentemente (owner, con confirmación del nombre). */
async function apiDeleteWiki(repo: string, confirmName: string): Promise<void> {
  const r = await fetch("/api/wiki", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, confirmName }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `delete-wiki ${r.status}`);
  }
}

/** Devuelve el directorio de usuarios (para el picker del share popup). */
async function apiUsersDirectory(): Promise<Array<{ handle: string; name: string; hasAvatar: boolean }>> {
  const r = await fetch("/api/users/directory", { cache: "no-store" });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `users-directory ${r.status}`);
  }
  const j = (await r.json()) as { users?: Array<{ handle: string; name: string; hasAvatar: boolean }> };
  return j.users ?? [];
}

const DRAG_MIME = "application/x-ceibo-file";

/** Datos del archivo que se arrastra (drag&drop). El mime privado evita que el
 *  drop reciba files arrastrados desde el desktop (que también ponen tipos en
 *  el dataTransfer). */
interface DragPayload {
  repo: string;
  path: string;
  /** true cuando lo arrastrado es una CARPETA (su path es el prefijo, sin barra final). El move
   *  de carpeta es multi-archivo: se reescribe el prefijo de todos los archivos que cuelgan. */
  isFolder?: boolean;
}

/** Resuelve el path final de un nombre escrito en el input "+":
 *  - `nombre/` → carpeta (crea un `.gitkeep` adentro para anclarla — git no trackea
 *    carpetas vacías; `.gitkeep` es la convención estándar y se oculta como nota).
 *  - `nombre` o `nombre.md` → archivo (agrega `.md` si falta).
 *  El dir base es el "" para root de wiki, o `path/de/carpeta` si es subcarpeta.
 *  Devuelve `{ path, isFolder, folderPath }`; o null si el nombre no es válido. */
function resolveNewPath(
  raw: string,
  dir: string,
): { path: string; isFolder: boolean; folderPath: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Caracteres prohibidos para evitar paths raros / segmentos vacíos.
  if (/^[/.]|\/\/|\/$|^_/.test(trimmed.replace(/\/$/, ""))) return null;
  if (trimmed.endsWith("/")) {
    const folder = trimmed.slice(0, -1);
    const folderPath = dir ? `${dir}/${folder}` : folder;
    return { path: `${folderPath}/.gitkeep`, isFolder: true, folderPath };
  }
  const name = trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
  return { path: dir ? `${dir}/${name}` : name, isFolder: false, folderPath: "" };
}

/** Comparación profunda barata de dos listas de wikis: misma cantidad, mismos
 *  repos y mismos paths en cada uno. Si todo coincide, podemos reusar el array
 *  previo (sin setear el state) y evitar el re-render del tree en cada poll —
 *  cuando GitHub no cambió nada, no hay razón de "titilar" la UI. */
function wikisEqual(a: Wiki[], b: Wiki[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as Wiki;
    const y = b[i] as Wiki;
    if (x.repo !== y.repo || x.label !== y.label) return false;
    if (x.files.length !== y.files.length) return false;
    for (let j = 0; j < x.files.length; j++) {
      if (x.files[j] !== y.files[j]) return false;
    }
    // Miembros: si cambia con quién está compartida, hay que re-renderizar los chips.
    const xm = x.members ?? [];
    const ym = y.members ?? [];
    if (xm.length !== ym.length) return false;
    for (let j = 0; j < xm.length; j++) {
      if (
        xm[j]?.handle !== ym[j]?.handle ||
        xm[j]?.name !== ym[j]?.name ||
        !!xm[j]?.hasAvatar !== !!ym[j]?.hasAvatar
      )
        return false;
    }
    // Campos de F4: si cambian el rol/ownership/invites, hay que re-renderizar.
    if (x.role !== y.role || x.personal !== y.personal || x.isOwner !== y.isOwner) return false;
    const xi = x.pendingInvites ?? [];
    const yi = y.pendingInvites ?? [];
    if (xi.length !== yi.length) return false;
    for (let j = 0; j < xi.length; j++) {
      if (xi[j]?.email !== yi[j]?.email) return false;
    }
  }
  return true;
}

/** Lee el set de paths expandidos de localStorage para un handle dado.
 *  Defensivo: si la key no existe / no parsea / no es un array de strings,
 *  devuelve set vacío sin tirar. */
function loadExpanded(handle: string | undefined): Set<string> {
  if (!handle) return new Set();
  try {
    const saved = localStorage.getItem(`${EXP_KEY_PREFIX}${handle}`);
    if (!saved) return new Set();
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

/** Árbol desde los paths planos; carpetas primero, alfabético. */
function buildTree(files: string[]): Node[] {
  const root: Node = { name: "", full: "", children: [] };
  for (const file of files) {
    const parts = file.split("/");
    let cur = root;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) {
        cur.children?.push({ name: part, path: file });
        return;
      }
      let next = cur.children?.find((c) => c.name === part && c.children);
      if (!next) {
        next = { name: part, full: cur.full ? `${cur.full}/${part}` : part, children: [] };
        cur.children?.push(next);
      }
      cur = next;
    });
  }
  const sortRec = (n: Node) => {
    n.children?.sort((a, b) =>
      !!a.children === !!b.children ? a.name.localeCompare(b.name) : a.children ? -1 : 1,
    );
    n.children?.forEach(sortRec);
  };
  sortRec(root);
  return root.children ?? [];
}

// Polling del tree: cada cuánto re-fetcheamos mientras el explorer está abierto y
// la pestaña visible. 5s da un compromiso razonable entre reactividad y carga sobre
// la GitHub API (el `/api/explorer` llama `git/trees` por cada wiki del user).
const POLL_INTERVAL_MS = 5000;

/** Chevron de disclosure estilo Obsidian: triángulo fino que apunta a la derecha
 *  cuando está colapsado y rota 90° (apunta abajo) al abrir. Reemplaza los emojis
 *  de carpeta/wiki. Los archivos renderizan un `.exp-chevron-box` vacío (mismo ancho)
 *  para que su texto alinee con el de las carpetas del mismo nivel. */
function Chevron({ open }: { open: boolean }) {
  return (
    <span className="exp-chevron-box" aria-hidden="true">
      <svg className={`exp-chevron${open ? " exp-chevron-open" : ""}`} viewBox="0 0 24 24" role="img">
        <title>{open ? "abierto" : "cerrado"}</title>
        <path d="M9 6l6 6-6 6" />
      </svg>
    </span>
  );
}

/** Cara de un miembro en el cluster: si tiene avatar, un `<img>` circular con la foto; si no
 *  (o si la imagen falla / da 404), cae a las iniciales en gris (`chipMix`). El mismo tamaño
 *  en ambos casos para que el cluster no salte. Las piezas (URL, mix, iniciales) viven en
 *  memberFace.ts, COMPARTIDAS con el avatar del blame por línea (mismo mecanismo). */
function MemberFace({ member }: { member: Member }) {
  const [failed, setFailed] = useState(false);
  if (member.hasAvatar && !failed) {
    return (
      <img
        className="exp-member-chip exp-member-photo"
        src={avatarSrc.of(member.handle)}
        alt={member.name}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className="exp-member-chip" style={{ "--chip-mix": chipMix(member.handle) } as CSSProperties}>
      {initials(member.name)}
    </span>
  );
}

/** Punto/foto de un miembro en el popover de la lista completa: avatar si lo tiene (chiquito),
 *  o el punto de color de fallback. */
function MemberDot({ member }: { member: Member }) {
  const [failed, setFailed] = useState(false);
  if (member.hasAvatar && !failed) {
    return (
      <img
        className="exp-members-pop-dot exp-member-photo"
        src={avatarSrc.of(member.handle)}
        alt=""
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className="exp-members-pop-dot" style={{ "--chip-mix": chipMix(member.handle) } as CSSProperties} />
  );
}

/** Cluster de chips de los miembros con acceso a una wiki (los OTROS, ya filtrado el viewer).
 *  Muestra hasta 3 iniciales coloreadas + "+k"; hover = tooltip nativo con los nombres; click =
 *  popover con la lista completa. El cluster es su propio botón (hermano de la fila de wiki,
 *  no anidado) → no togglea la wiki. */
function MemberChips({ members }: { members: Member[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const MAX = 3;
  const shown = members.slice(0, MAX);
  const extra = members.length - shown.length;
  const names = members.map((m) => m.name).join(", ");

  // Cerrar el popover con click/tap afuera o ESC.
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const t = e.target as Element | null;
      if (t?.closest?.(".exp-members-pop") || t?.closest?.(".exp-members-btn")) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close, { passive: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span className="exp-members">
      <button
        type="button"
        className="exp-members-btn"
        title={`Compartida con ${names}`}
        aria-label={`Compartida con ${names}`}
        onClick={(e) => {
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setPos({ x: Math.min(r.left, window.innerWidth - 230), y: r.bottom + 4 });
          setOpen((v) => !v);
        }}
      >
        {shown.map((m) => (
          <MemberFace key={m.handle} member={m} />
        ))}
        {extra > 0 && <span className="exp-members-more">+{extra}</span>}
      </button>
      {open && (
        <div className="exp-members-pop" role="menu" style={{ top: pos.y, left: pos.x }}>
          <div className="exp-members-pop-title">Compartida con</div>
          {members.map((m) => (
            <div className="exp-members-pop-item" key={m.handle}>
              <MemberDot member={m} />
              {m.name}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

/** Los tres modos de la activity bar (columna de íconos a la izquierda del explorador, estilo
 *  VS Code): el árbol de archivos, la lista de páginas del sistema, y el inbox de notificaciones.
 *  Antes `system` y `notifs` eran popups flotantes (launcher-fab / notif-fab); ahora son paneles. */
export type SidebarPanel = "files" | "system" | "notifs";

/** Mapea el nombre de ícono de una página de sistema (systemPages.ts) a su componente. */
function systemPageIcon(icon: string) {
  switch (icon) {
    case "clock":
      return <IconClock size={16} />;
    case "plug":
      return <IconPlug size={16} />;
    case "archive":
      return <IconArchive size={16} />;
    case "message":
      return <IconMessage size={16} />;
    case "user":
      return <IconUser size={16} />;
    case "palette":
      return <IconPalette size={16} />;
    case "languages":
      return <IconLanguages size={16} />;
    default:
      return <IconSettings size={16} />;
  }
}

/** Panel "sistema" de la activity bar: la lista de páginas del sistema. Reemplaza el menú del
 *  viejo launcher-fab; un click abre la página como tab en la vista principal. Las páginas ya
 *  abiertas se marcan con un punto. Separador en cada cambio de grupo (content/setup). */
function SystemPanel({
  openPages,
  onOpen,
}: {
  openPages: Set<SystemPage>;
  onOpen: (id: SystemPage) => void;
}) {
  return (
    <div className="sys-panel">
      {SYSTEM_PAGES.map((p, i) => {
        const isOpen = openPages.has(p.id);
        // Separador cada vez que cambia el grupo respecto del ítem anterior.
        const showSep = i > 0 && p.group !== SYSTEM_PAGES[i - 1]?.group;
        return (
          <div key={p.id}>
            {showSep && <div className="sys-sep" aria-hidden="true" />}
            <button
              type="button"
              className={`sys-item${isOpen ? " sys-item-on" : ""}`}
              onClick={() => onOpen(p.id)}
            >
              {systemPageIcon(p.icon)}
              <span>{p.title}</span>
              {isOpen && <span className="sys-dot" aria-hidden="true" />}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Panel "notificaciones" de la activity bar: el inbox del agente (feature crons-delivery).
 *  Reemplaza el popup del notif-fab. Cada item: título, hora y punto leído/no-leído. Click →
 *  re-inyecta la burbuja en el chat (lo maneja el caller). "Marcar todo" baja el badge. */
function NotifPanel({
  items,
  unread,
  onOpenItem,
  onMarkAll,
}: {
  items: InboxItem[];
  unread: number;
  onOpenItem: (id: number) => void;
  onMarkAll: () => void;
}) {
  const fmtWhen = (iso: string): string => {
    // El store guarda created_at como UTC sin tz ("YYYY-MM-DD HH:MM:SS"); lo normalizamos a ISO Z.
    const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("es-AR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  };
  return (
    <div className="notif-panel-inline">
      {unread > 0 && (
        <div className="notif-actions">
          <button type="button" className="notif-markall" onClick={onMarkAll}>
            Marcar todo como leído
          </button>
        </div>
      )}
      {items.length === 0 ? (
        <p className="notif-empty">No tenés notificaciones.</p>
      ) : (
        <ul className="notif-list">
          {items.map((it) => (
            <li key={it.id}>
              <button
                type="button"
                className={`notif-item${it.read_at === null ? " notif-item-unread" : ""}`}
                onClick={() => onOpenItem(it.id)}
              >
                <span className="notif-dot" aria-hidden="true" />
                <span className="notif-item-body">
                  <span className="notif-item-title">{it.title}</span>
                  <span className="notif-item-when">{fmtWhen(it.created_at)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Explorer({
  current,
  revealTarget,
  handle,
  reloadSeq,
  onOpen,
  onClose,
  onFileGone,
  emojiForNote,
  onFileMoved,
  onFileMovedCross,
  onFsOpBegin,
  onFsOpEnd,
  runFsOp,
  panel,
  onPanelChange,
  openSystemPages,
  onOpenSystem,
  inboxItems,
  inboxUnread,
  onOpenInboxItem,
  onMarkAllInboxRead,
}: {
  current: Current | null;
  /** "Mostrar en explorador" (menú contextual de la tab): revela un archivo expandiendo sus
   *  carpetas ancestro y scrolleándolo a la vista. `seq` se bumpea en cada pedido para que
   *  revelar el MISMO archivo dos veces vuelva a disparar el efecto. */
  revealTarget?: { repo: string; path: string; seq: number } | null;
  handle?: string;
  /** Panel activo de la activity bar (columna de íconos a la izq): árbol / páginas de sistema /
   *  notificaciones. Lo maneja App (un click en la barra conmuta el cuerpo del explorador). */
  panel: SidebarPanel;
  onPanelChange: (p: SidebarPanel) => void;
  /** Páginas de sistema YA abiertas (como tabs en la vista): se marcan con un punto en la lista. */
  openSystemPages: Set<SystemPage>;
  /** Abrir una página de sistema (la abre como tab en la vista principal, igual que el ex-launcher). */
  onOpenSystem: (id: SystemPage) => void;
  /** Inbox del agente (feature crons-delivery): items + no-leídos para el panel de notificaciones. */
  inboxItems: InboxItem[];
  inboxUnread: number;
  /** Abrir un item del inbox (re-inyecta la burbuja en el chat; el caller abre el chat). */
  onOpenInboxItem: (id: number) => void;
  /** Marcar todo el inbox como leído (baja el badge sin abrir nada). */
  onMarkAllInboxRead: () => void;
  /** Bumpea cuando el feed avisa que una wiki del user cambió → recarga el árbol al
   *  instante, sin esperar el poll de 5s (Fase 3a). */
  reloadSeq?: number;
  onOpen: (repo: string, path: string, newTab?: boolean) => void;
  onClose: () => void;
  /** Llamado cuando el explorer BORRA un archivo (archive). El App cierra toda pestaña
   *  que apunte a ese path. NO se usa para mover/renombrar (eso es onFileMoved). */
  onFileGone?: (repo: string, path: string) => void;
  /** Emoji por-nota a MOSTRAR en el árbol (estilo Notion). El App es la fuente única (se
   *  asigna desde el botón a la izquierda del título de la página, no desde el explorer);
   *  acá sólo lo pintamos. "" / ausente = sin emoji. */
  emojiForNote?: (repo: string, path: string) => string;
  /** Llamado cuando el explorer RENOMBRA o MUEVE un archivo/carpeta (fromPath→toPath). El
   *  App remapea las pestañas que apuntaban al path viejo para que SIGAN al archivo, en vez
   *  de cerrarlas (evita la pestaña huérfana que tira 404 al re-seleccionarla). `isFolder`
   *  distingue match exacto (archivo) de match por prefijo (carpeta, multi-archivo). */
  onFileMoved?: (repo: string, fromPath: string, toPath: string, isFolder: boolean) => void;
  /** Como `onFileMoved` pero CROSS-WIKI: la nota sale de `fromRepo` y aparece en `toRepo`. El App
   *  remapea las pestañas de `(fromRepo, fromPath)` a `(toRepo, toPath)` para que SIGAN al archivo a
   *  su nueva wiki. Sólo archivos por ahora (no carpetas), de ahí que no haya `isFolder`. */
  onFileMovedCross?: (fromRepo: string, fromPath: string, toRepo: string, toPath: string) => void;
  /** Registra una op de FS (move/rename) EN VUELO → el editor no persiste los archivos cubiertos
   *  mientras dura (evita el 409 "conflict" del caso 4). Llamar begin al disparar, end en finally. */
  onFsOpBegin?: (op: FsOp) => void;
  onFsOpEnd?: (id: string) => void;
  /** Corre una MUTACIÓN de FS en la cola serial por-repo (commits del mismo repo no se solapan →
   *  evita el 422 non-fast-forward → 409 espurio). Si no se provee, corre directo (fallback). */
  runFsOp?: <T>(repo: string, fn: () => Promise<T>) => Promise<T>;
}) {
  // Hidratación SÍNCRONA del árbol desde el cache local (por el handle cacheado en
  // `ceibo_handle`, igual que `expanded`): mostramos el árbol de la última visita AL
  // INSTANTE en el F5, sin el flash de "cargando…". `null` sólo en la primera visita
  // (sin cache) → ahí sí va "cargando…". El poll de abajo revalida contra el server.
  const [wikis, setWikis] = useState<Wiki[] | null>(() => {
    try {
      return readTree(localStorage.getItem(HANDLE_KEY) ?? undefined);
    } catch {
      return null;
    }
  });
  // Menú contextual (click derecho): un archivo/carpeta, o la wiki misma + posición de pantalla.
  // `kind` distingue el menú de archivo (abrir/renombrar/archivar) del de wiki (renombrar alias;
  // extensible a sharing/edit más adelante). Para `kind:"wiki"`, `path`/`isFolder` no se usan.
  const [menu, setMenu] = useState<{
    repo: string;
    path: string;
    x: number;
    y: number;
    isFolder: boolean;
    kind: "file" | "wiki";
  } | null>(null);
  // Rename inline del ALIAS de una wiki (7.5): cuál wiki está en edición (sólo una a la vez).
  const [renamingWiki, setRenamingWiki] = useState<{ repo: string } | null>(null);
  // Input "+": una sola ubicación a la vez (repo + dir; dir="" para root de wiki).
  const [creating, setCreating] = useState<{ repo: string; dir: string } | null>(null);
  // Rename inline: un archivo o carpeta a la vez. Lo dispara el menú contextual; el row
  // se reemplaza por un input con el nombre actual seleccionable.
  const [renaming, setRenaming] = useState<{ repo: string; path: string; isFolder: boolean } | null>(null);
  // Drag&drop: drop target sobre el que está pasando un drag (para highlight).
  // Key = `${repo}:${dir}` para distinguir wiki raíz vs subcarpeta.
  const [dragOver, setDragOver] = useState<string | null>(null);
  // Toast: mensaje efímero (auto-dismissal a los 3s). Sólo uno a la vez.
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // F4: creación de nueva wiki (inline input debajo del listado).
  const [creatingWiki, setCreatingWiki] = useState(false);
  // F4: popup de compartir.
  const [sharingWiki, setSharingWiki] = useState<{ repo: string; wiki: Wiki } | null>(null);
  // F4: modal de borrar wiki.
  const [deletingWiki, setDeletingWiki] = useState<{ repo: string; label: string } | null>(null);

  // Badge de versión: SHA del deploy + entorno, leído de GET /api/version al montar (hook
  // compartido con el home y Configuración). null hasta que resuelva; graceful si el endpoint
  // no existe (prod viejo).
  // (El TÍTULO de la pestaña del navegador ya NO se setea acá — eso lo hace <VersionBadge/>
  //  top-level, montado siempre, para que el prefijo [dev]/[staging] no dependa de abrir el
  //  explorer. Acá sólo queda el badge visible del header del explorer.)
  const versionInfo = useVersionInfo();

  // Ancho del explorer: al montar, hidratar el ancho que el usuario haya guardado (lo
  // setea el handle de resize en `--exp-w-user` sobre <html>; el CSS lo clampa). El default
  // (sin var) lo resuelve el clamp del CSS, así que no tocamos nada si no hay valor.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(EXP_W_KEY);
      if (saved) document.documentElement.style.setProperty("--exp-w-user", saved);
    } catch {
      /* localStorage no disponible */
    }
  }, []);

  // Arrastre del borde derecho para ensanchar/angostar el explorer. Como el explorer está
  // anclado a la izquierda (left:0), el ancho deseado = clientX del puntero. Escribimos
  // directo a la CSS var (sin state de React) para que el resize sea fluido; el CSS clampa
  // el rango y todos los consumidores de --exp-w (vista, textbar, orbe) reflowean en vivo.
  // Persistimos al soltar.
  const startResize = useCallback((e: ReactPointerEvent) => {
    e.preventDefault();
    const root = document.documentElement;
    const onMove = (ev: PointerEvent) => {
      root.style.setProperty("--exp-w-user", `${Math.max(180, ev.clientX)}px`);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("exp-resizing");
      const v = root.style.getPropertyValue("--exp-w-user");
      try {
        if (v) localStorage.setItem(EXP_W_KEY, v);
      } catch {
        /* localStorage no disponible */
      }
    };
    document.body.classList.add("exp-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  // RECONCILIACIÓN del optimistic-remove (7.3): set de `${repo}\0${path}` que el usuario acaba
  // de archivar/mover localmente pero que el server PUEDE seguir devolviendo un rato (respuesta de
  // /api/explorer en vuelo o el change-feed con el árbol viejo). Sin esto la nota "parpadea"
  // (desaparece → reaparece con el árbol stale → desaparece definitiva). Lo mantenemos en un ref
  // (no necesita re-render) y filtramos TODA respuesta del server contra él hasta que el server deje
  // de devolver el path (= el delete quedó confirmado → lo sacamos del set, deja de filtrarse).
  const pendingRemovedRef = useRef<Set<string>>(new Set());
  // ⚠️ El lado ADD también necesita protección, y ÉSTE era el bug del "parpadeo" (move/rename/crear):
  // /api/explorer lee `wk.listFiles`, que cachea por HEAD sha resuelto con conditional-request — tras
  // un write, GitHub puede devolver brevemente el árbol VIEJO (read-after-write lag / etag stale). El
  // refresh inmediato post-op traía entonces un árbol SIN el path nuevo y borraba el add optimista
  // → la nota DESAPARECÍA; el siguiente poll ya traía el árbol fresco y la RE-AGREGABA → reaparecía.
  // Espejo del set de removidos: re-inyectamos los paths recién agregados en TODO árbol del server
  // que aún no los traiga, y los auto-purgamos cuando el server YA los devuelve (add confirmado).
  const pendingAddedRef = useRef<Set<string>>(new Set());
  const clearPending = useCallback((repo: string, path: string) => {
    pendingRemovedRef.current.delete(remKey(repo, path));
    pendingAddedRef.current.delete(remKey(repo, path));
  }, []);

  // Reconcilia un árbol recién traído contra los cambios optimistas pendientes (lógica pura en
  // explorerReconcile.reconcileTree): esconde los removidos pendientes e inyecta los agregados
  // pendientes hasta que el server confirma cada uno. Aplicar a TODO seteo desde el server
  // (refreshTree, poll, feed) — es lo que mata el "parpadeo" del move/rename/crear.
  const reconcilePending = useCallback(
    (next: Wiki[]): Wiki[] => reconcileTree(next, pendingRemovedRef.current, pendingAddedRef.current),
    [],
  );

  // Corre la(s) escritura(s) de una op de FS dentro de la cola serial por-repo (si el padre la
  // proveyó): dos ops de mutación del mismo repo nunca se solapan → sin el 422 non-fast-forward
  // (commits concurrentes) que daba el 409 "conflict" espurio. Fallback a directo si no hay cola.
  const enqueueFsOp = useCallback(
    <T,>(repo: string, fn: () => Promise<T>): Promise<T> => (runFsOp ? runFsOp(repo, fn) : fn()),
    [runFsOp],
  );

  const refreshTree = useCallback(() => {
    void fetch("/api/explorer", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { wikis: [] }))
      .then((d: { wikis?: Wiki[] }) => setWikis(reconcilePending(d.wikis ?? [])))
      .catch(() => {});
  }, [reconcilePending]);

  // Versión liviana del modelo local-first: aplicamos cambios al tree LOCAL ANTES
  // de esperar la API (UI responde sin latencia). Si la API falla, revertimos al
  // snapshot pre-cambio. El polling cada 5s reconcilia con el server. (Diseño del
  // modelo completo: explorer-sync-local-first.md en la wiki del owner.)
  const optimisticAdd = useCallback((repo: string, newPath: string) => {
    // Marcamos el path como "agregado-pendiente" para que reconcilePending lo siga MOSTRANDO aunque
    // una respuesta stale del server todavía no lo traiga (causa del parpadeo). Se auto-purga cuando
    // el server confirma. Además limpiamos el lado removido por si el mismo path se borró y recreó.
    pendingRemovedRef.current.delete(remKey(repo, newPath));
    pendingAddedRef.current.add(remKey(repo, newPath));
    setWikis((prev) => {
      if (!prev) return prev;
      return prev.map((w) =>
        w.repo === repo && !w.files.includes(newPath) ? { ...w, files: [...w.files, newPath].sort() } : w,
      );
    });
  }, []);
  const optimisticRemove = useCallback((repo: string, path: string) => {
    // Marcamos el path como "borrado-pendiente" para que reconcilePending lo siga escondiendo aunque
    // una respuesta stale del server lo vuelva a traer (7.3). Se auto-purga cuando el server confirma.
    // Limpiamos el lado agregado por si el mismo path se agregó y luego se quitó (origen de un move).
    pendingAddedRef.current.delete(remKey(repo, path));
    pendingRemovedRef.current.add(remKey(repo, path));
    setWikis((prev) => {
      if (!prev) return prev;
      return prev.map((w) => (w.repo === repo ? { ...w, files: w.files.filter((f) => f !== path) } : w));
    });
  }, []);

  // Archivos REALES afectados por una acción sobre un item del tree. Para un archivo es
  // él mismo; para una carpeta, todos los .md bajo su prefijo (las carpetas son implícitas
  // — sólo existen por los paths de archivo). Lo usan las acciones de carpeta (borrar /
  // renombrar / archivar), que son multi-archivo porque el server sólo opera por archivo.
  const filesUnder = useCallback(
    (repo: string, path: string, isFolder: boolean): string[] => {
      const w = wikis?.find((x) => x.repo === repo);
      if (!w) return [];
      if (!isFolder) return w.files.includes(path) ? [path] : [];
      const prefix = `${path}/`;
      return w.files.filter((f) => f.startsWith(prefix));
    },
    [wikis],
  );

  // Cerrar el menú con un tap/click afuera o ESC. Dos cuidados para touch:
  //  - VENTANA DE GRACIA (~500ms): ignoramos cierres del propio gesto que lo abrió — el
  //    long-press dispara, a los ~50ms el OS mete su selección nativa (el "highlight raro")
  //    y eso generaba un evento que cerraba el menú apenas aparecía.
  //  - Taps DENTRO del menú no cierran (los maneja el onClick del item).
  useEffect(() => {
    if (!menu) return;
    const openedAt = performance.now();
    const close = (e: Event) => {
      if (performance.now() - openedAt < 500) return; // gracia: gesto de apertura
      const target = e.target as Element | null;
      if (target?.closest?.(".exp-menu")) return; // tap dentro del menú
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close, { passive: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // Archivar (única acción destructiva del explorer): BORRA la nota y la indexa en el
  // `_archivado.md` de su carpeta (modelo archivado-por-historia — el contenido vive en la
  // historia de git, recuperable con el agente: recall / search-archived). Reemplaza al viejo
  // "mover a carpeta archivado/" Y al borrado directo (ya no hay "Borrar": el usuario no tiene
  // que distinguir). Para una carpeta, archiva cada nota adentro; saltea los índices.
  const doArchive = useCallback(
    async (repo: string, path: string, isFolder: boolean) => {
      setMenu(null);
      // Para una carpeta el server archiva TODO bajo el prefijo en un commit (incl. el ancla
      // `.gitkeep` y los índices `_archivado.md`/`_index.md` legacy, que el archivado por-nota
      // dejaba vivos anclando la carpeta zombie). Acá `targets` = lo que sale del tree optimista;
      // `notes` = lo que se reporta (solo notas reales del usuario).
      const targets = filesUnder(repo, path, isFolder);
      const notes = targets.filter((p) => {
        const base = p.split("/").pop() ?? "";
        return (
          base.endsWith(".md") && base !== "_index.md" && base !== "_archivado.md" && base !== ".archived.md"
        );
      });
      if (targets.length === 0) return;
      if (!isFolder && notes.length === 0) return;
      if (
        isFolder &&
        !confirm(
          notes.length > 0
            ? `¿Archivar la carpeta "${path}" y sus ${notes.length} nota(s)?`
            : `¿Borrar la carpeta "${path}"? (no tiene notas)`,
        )
      ) {
        return;
      }
      // Optimista: la nota sale de la vista (queda en la historia). Si la API falla, refreshTree restaura.
      for (const p of targets) {
        optimisticRemove(repo, p);
        onFileGone?.(repo, p);
      }
      try {
        // En la cola serial del repo: el archive (delete + index commit) no se solapa con otra
        // mutación del mismo repo (evita el 422 non-fast-forward → 409 espurio).
        await enqueueFsOp(repo, async () => {
          if (isFolder) {
            await apiArchiveFolder(repo, path);
          } else {
            for (const p of notes) {
              const sha = await apiGetSha(repo, p);
              await apiArchive(repo, p, sha);
            }
          }
        });
        refreshTree();
      } catch (e) {
        // Falló: dejamos de esconder los targets (los que SÍ se archivaron ya no vuelven —
        // el server no los devuelve; el que falló reaparece) y refrescamos contra el server.
        for (const p of targets) clearPending(repo, p);
        refreshTree();
        alert(`No pude archivar: ${(e as Error)?.message ?? e}`);
      }
    },
    [clearPending, enqueueFsOp, filesUnder, onFileGone, optimisticRemove, refreshTree],
  );

  // Resuelve el nombre escrito en el input "+" y crea archivo o carpeta. Si es
  // archivo, lo abre en la vista. Si es carpeta, la expande en el tree.
  // Mover archivo (drag&drop). `targetDir` es "" para raíz de wiki, o path de la
  // carpeta destino. Si el archivo ya está en ese dir, no-op. Si está abierto en alguna
  // pestaña, ésta SIGUE al archivo (remap de path), no se cierra — así no queda huérfana.
  const doMove = useCallback(
    async (repo: string, fromPath: string, targetDir: string) => {
      const slash = fromPath.lastIndexOf("/");
      const filename = slash >= 0 ? fromPath.slice(slash + 1) : fromPath;
      const fromDir = slash >= 0 ? fromPath.slice(0, slash) : "";
      if (fromDir === targetDir) return; // no se mueve a sí mismo
      const toPath = targetDir ? `${targetDir}/${filename}` : filename;
      // Optimista: quitamos fromPath, sumamos toPath y remapeamos las pestañas ANTES del await.
      // El remap se hace por identidad de path (no "la pestaña activa"), así que es inmune a que
      // el user cambie de pestaña mientras la op está in-flight (no le robamos el foco al final).
      optimisticRemove(repo, fromPath);
      optimisticAdd(repo, toPath);
      onFileMoved?.(repo, fromPath, toPath, false);
      // Op de FS en vuelo: mientras el move corre, el editor NO persiste fromPath/toPath (su flush
      // cambiaría el blob que el move lee → 409 "conflict", el bug del caso 4 con el click rápido).
      const opId = crypto.randomUUID();
      onFsOpBegin?.({ id: opId, repo, fromPath, toPath, isFolder: false });
      try {
        // En la cola serial del repo: el read-sha + el commit no se solapan con otra mutación del
        // mismo repo (evita el 422 non-fast-forward → 409 espurio).
        await enqueueFsOp(repo, async () => {
          const sha = await apiGetSha(repo, fromPath);
          await apiMove(repo, fromPath, toPath, sha);
        });
        refreshTree();
      } catch (e) {
        clearPending(repo, fromPath); // falló el move → el origen vuelve a mostrarse
        clearPending(repo, toPath); // …y el destino optimista se retira
        onFileMoved?.(repo, toPath, fromPath, false); // revertimos el remap de las pestañas
        refreshTree();
        alert(`No pude mover: ${(e as Error)?.message ?? e}`);
      } finally {
        onFsOpEnd?.(opId);
      }
    },
    [
      clearPending,
      enqueueFsOp,
      onFileMoved,
      onFsOpBegin,
      onFsOpEnd,
      optimisticAdd,
      optimisticRemove,
      refreshTree,
    ],
  );

  // Mover un archivo de una wiki a OTRA (drag&drop cross-wiki). A diferencia del intra-wiki, NO hay
  // commit atómico (son dos repos git): el server compone getFile(A)→createFile(B)→deleteFile(A). La
  // pestaña abierta SIGUE al archivo a su nueva wiki (remap cross). Si el destino se crea pero el
  // origen no se borra, el server responde 200 con `warning:"source-not-deleted"` (queda duplicado,
  // mejor que perdido) → avisamos suave y refrescamos contra el server (que muestra ambas copias).
  const doMoveCross = useCallback(
    async (fromRepo: string, fromPath: string, toRepo: string, targetDir: string) => {
      const slash = fromPath.lastIndexOf("/");
      const filename = slash >= 0 ? fromPath.slice(slash + 1) : fromPath;
      const toPath = targetDir ? `${targetDir}/${filename}` : filename;
      // Optimista: sacamos el archivo del repo origen y lo sumamos al destino, y remapeamos las
      // pestañas de (fromRepo,fromPath) a (toRepo,toPath) ANTES del await (por identidad de path).
      optimisticRemove(fromRepo, fromPath);
      optimisticAdd(toRepo, toPath);
      onFileMovedCross?.(fromRepo, fromPath, toRepo, toPath);
      // Op de FS en vuelo en AMBOS repos: el editor no persiste ni el origen ni el destino mientras
      // el move corre (un FsOp por repo, ya que el registro es per-repo, ver opCoversPath).
      const opIdFrom = crypto.randomUUID();
      const opIdTo = crypto.randomUUID();
      onFsOpBegin?.({ id: opIdFrom, repo: fromRepo, fromPath, toPath: fromPath, isFolder: false });
      onFsOpBegin?.({ id: opIdTo, repo: toRepo, fromPath: toPath, toPath, isFolder: false });
      try {
        // Serializamos contra otras mutaciones de AMBOS repos: encolamos en la cola del origen y,
        // adentro, en la del destino. Así ni el origen ni el destino solapan su read/commit con otra
        // op del mismo repo (la defensa de raíz contra el 422 non-fast-forward → 409 espurio).
        const out = await enqueueFsOp(fromRepo, () =>
          enqueueFsOp(toRepo, async () => {
            const sha = await apiGetSha(fromRepo, fromPath);
            return apiMoveCross(fromRepo, fromPath, toRepo, toPath, sha);
          }),
        );
        refreshTree();
        if (out.warning === "source-not-deleted") {
          alert(
            `Copié la nota a la otra wiki, pero no pude borrar la original — quedó en las dos. ` +
              `Revisá "${fromPath}" en la wiki de origen.`,
          );
        }
      } catch (e) {
        clearPending(fromRepo, fromPath); // falló → el origen vuelve a mostrarse
        clearPending(toRepo, toPath); // …y el destino optimista se retira
        onFileMovedCross?.(toRepo, toPath, fromRepo, fromPath); // revertimos el remap de pestañas
        refreshTree();
        alert(`No pude mover a la otra wiki: ${(e as Error)?.message ?? e}`);
      } finally {
        onFsOpEnd?.(opIdFrom);
        onFsOpEnd?.(opIdTo);
      }
    },
    [
      clearPending,
      enqueueFsOp,
      onFileMovedCross,
      onFsOpBegin,
      onFsOpEnd,
      optimisticAdd,
      optimisticRemove,
      refreshTree,
    ],
  );

  // Mover una CARPETA (drag&drop). Caso 7: las carpetas son implícitas (sólo existen por los
  // paths de archivo), así que mover una = reescribir el prefijo de TODOS sus archivos del dir
  // viejo al nuevo, en multi-move (igual que el rename de carpeta). `targetDir` es "" para raíz
  // o el path de la carpeta destino. Guardas: no mover a su propio dir actual, ni DENTRO de sí
  // misma (un descendiente) — eso crearía paths recursivos imposibles.
  const doMoveFolder = useCallback(
    async (repo: string, fromPath: string, targetDir: string) => {
      const slash = fromPath.lastIndexOf("/");
      const folderName = slash >= 0 ? fromPath.slice(slash + 1) : fromPath;
      const fromDir = slash >= 0 ? fromPath.slice(0, slash) : "";
      if (fromDir === targetDir) return; // ya está ahí
      const toDir = targetDir ? `${targetDir}/${folderName}` : folderName;
      if (toDir === fromPath) return; // sin cambio
      // No soltar una carpeta dentro de sí misma o de un descendiente (targetDir bajo fromPath/).
      if (targetDir === fromPath || targetDir.startsWith(`${fromPath}/`)) return;
      const targets = filesUnder(repo, fromPath, true);
      if (targets.length === 0) return;
      const moves = targets.map((from) => ({ from, to: `${toDir}${from.slice(fromPath.length)}` }));
      for (const m of moves) {
        optimisticRemove(repo, m.from);
        optimisticAdd(repo, m.to);
      }
      // Remap por PREFIJO: las pestañas bajo `fromPath/` siguen a `toDir/` (por identidad, inmune
      // a cambios de pestaña mid-op). Mismo mecanismo que el rename de carpeta.
      onFileMoved?.(repo, fromPath, toDir, true);
      const opId = crypto.randomUUID();
      onFsOpBegin?.({ id: opId, repo, fromPath, toPath: toDir, isFolder: true });
      try {
        // Toda la secuencia multi-archivo en UN turno de la cola serial del repo: ningún otro
        // commit del repo se cuela entre medio (cada move ve el HEAD que dejó el anterior).
        await enqueueFsOp(repo, async () => {
          for (const m of moves) {
            const sha = await apiGetSha(repo, m.from);
            await apiMove(repo, m.from, m.to, sha);
          }
        });
        refreshTree();
      } catch (e) {
        for (const m of moves) {
          clearPending(repo, m.from);
          clearPending(repo, m.to);
        }
        onFileMoved?.(repo, toDir, fromPath, true); // revertimos el remap de pestañas
        refreshTree();
        alert(`No pude mover la carpeta: ${(e as Error)?.message ?? e}`);
      } finally {
        onFsOpEnd?.(opId);
      }
    },
    [
      clearPending,
      enqueueFsOp,
      filesUnder,
      onFileMoved,
      onFsOpBegin,
      onFsOpEnd,
      optimisticAdd,
      optimisticRemove,
      refreshTree,
    ],
  );

  // Mover una CARPETA de una wiki a OTRA (drag&drop cross-wiki). Como las carpetas son implícitas,
  // es el multi-archivo de doMoveFolder pero con la semántica cross-wiki de doMoveCross por archivo:
  // cada nota se mueve con getFile(A)→createFile(B)→deleteFile(A) (sin atomicidad — son dos repos).
  // No hay guarda de "dentro de sí misma": origen y destino son repos distintos. El remap de pestañas
  // se hace POR archivo (onFileMovedCross no maneja prefijos de carpeta). Si alguna nota se copia pero
  // no se puede borrar del origen (`source-not-deleted`), la contamos y avisamos al final (quedan en
  // ambas wikis). Ante un fallo a mitad, refrescamos contra el server: la UI refleja qué se movió.
  const doMoveFolderCross = useCallback(
    async (fromRepo: string, fromPath: string, toRepo: string, targetDir: string) => {
      const slash = fromPath.lastIndexOf("/");
      const folderName = slash >= 0 ? fromPath.slice(slash + 1) : fromPath;
      const toDir = targetDir ? `${targetDir}/${folderName}` : folderName;
      const targets = filesUnder(fromRepo, fromPath, true);
      if (targets.length === 0) return;
      const moves = targets.map((from) => ({ from, to: `${toDir}${from.slice(fromPath.length)}` }));
      // Optimista en AMBOS repos + remap por archivo (cross), ANTES del await (por identidad de path).
      for (const m of moves) {
        optimisticRemove(fromRepo, m.from);
        optimisticAdd(toRepo, m.to);
        onFileMovedCross?.(fromRepo, m.from, toRepo, m.to);
      }
      const opIdFrom = crypto.randomUUID();
      const opIdTo = crypto.randomUUID();
      onFsOpBegin?.({ id: opIdFrom, repo: fromRepo, fromPath, toPath: fromPath, isFolder: true });
      onFsOpBegin?.({ id: opIdTo, repo: toRepo, fromPath: toDir, toPath: toDir, isFolder: true });
      let duplicated = 0;
      try {
        // Toda la secuencia multi-archivo serializada contra otras mutaciones de AMBOS repos (cola del
        // origen y, adentro, la del destino) — igual que doMoveCross, extendido a N archivos.
        await enqueueFsOp(fromRepo, () =>
          enqueueFsOp(toRepo, async () => {
            for (const m of moves) {
              const sha = await apiGetSha(fromRepo, m.from);
              const out = await apiMoveCross(fromRepo, m.from, toRepo, m.to, sha);
              if (out.warning === "source-not-deleted") duplicated++;
            }
          }),
        );
        refreshTree();
        if (duplicated > 0) {
          alert(
            `Moví la carpeta a la otra wiki, pero ${duplicated} nota(s) no se pudieron borrar del ` +
              `origen — quedaron en las dos. Revisá "${fromPath}" en la wiki de origen.`,
          );
        }
      } catch (e) {
        for (const m of moves) {
          clearPending(fromRepo, m.from);
          clearPending(toRepo, m.to);
          onFileMovedCross?.(toRepo, m.to, fromRepo, m.from); // revertimos el remap de pestañas
        }
        refreshTree();
        alert(`No pude mover la carpeta a la otra wiki: ${(e as Error)?.message ?? e}`);
      } finally {
        onFsOpEnd?.(opIdFrom);
        onFsOpEnd?.(opIdTo);
      }
    },
    [
      clearPending,
      enqueueFsOp,
      filesUnder,
      onFileMovedCross,
      onFsOpBegin,
      onFsOpEnd,
      optimisticAdd,
      optimisticRemove,
      refreshTree,
    ],
  );

  // Renombrar una nota: misma carpeta, nombre nuevo. `newBase` es lo que tipeó el
  // user (con o sin .md). Además del cambio de path, sincronizamos el H1 dentro
  // del contenido — el rename del explorer y el filename arrancan acoplados, así
  // que vivimos al revés del flujo Obsidian (H1→filename en useChannel.patchDoc).
  // Si el archivo (o algo bajo la carpeta) está abierto en una pestaña, ésta SIGUE al path
  // nuevo (remap) en vez de cerrarse y re-abrirse: el editor no remontea (cursor preservado) y
  // las pestañas de fondo no quedan huérfanas apuntando a un path 404.
  const doRename = useCallback(
    async (repo: string, fromPath: string, newBase: string, isFolder: boolean) => {
      setRenaming(null);
      const trimmed = newBase.trim();
      if (!trimmed) return;
      // Renombrar una CARPETA = mover todos sus archivos del prefijo viejo al nuevo
      // (las carpetas son implícitas). Sin reescribir H1 (cada archivo conserva el suyo).
      if (isFolder) {
        const sanitized = trimmed
          .replace(/[/\\:*?"<>|]/g, "")
          .replace(/\s+/g, " ")
          .trim();
        if (!sanitized) return;
        const slash = fromPath.lastIndexOf("/");
        const dir = slash >= 0 ? fromPath.slice(0, slash) : "";
        const toDir = dir ? `${dir}/${sanitized}` : sanitized;
        if (toDir === fromPath) return;
        const targets = filesUnder(repo, fromPath, true);
        if (targets.length === 0) return;
        const moves = targets.map((from) => ({ from, to: `${toDir}${from.slice(fromPath.length)}` }));
        for (const m of moves) {
          optimisticRemove(repo, m.from);
          optimisticAdd(repo, m.to);
        }
        // Remap por PREFIJO: toda pestaña bajo `fromPath/` pasa a `toDir/` (incl. la activa y las
        // de fondo, y las entradas de su historial). Antes del await → inmune a cambios de pestaña.
        onFileMoved?.(repo, fromPath, toDir, true);
        // Op de FS de carpeta (multi-archivo) en vuelo: registramos el prefijo (origen y destino)
        // → el editor no persiste ningún archivo bajo la carpeta mientras el rename corre (caso 4).
        const opId = crypto.randomUUID();
        onFsOpBegin?.({ id: opId, repo, fromPath, toPath: toDir, isFolder: true });
        try {
          await enqueueFsOp(repo, async () => {
            for (const m of moves) {
              const sha = await apiGetSha(repo, m.from);
              await apiMove(repo, m.from, m.to, sha);
            }
          });
          refreshTree();
        } catch (e) {
          for (const m of moves) {
            clearPending(repo, m.from); // falló → los orígenes reaparecen
            clearPending(repo, m.to); // …y los destinos optimistas se retiran
          }
          onFileMoved?.(repo, toDir, fromPath, true); // revertimos el remap de las pestañas
          refreshTree();
          alert(`No pude renombrar: ${(e as Error)?.message ?? e}`);
        } finally {
          onFsOpEnd?.(opId);
        }
        return;
      }
      // titleRaw va al H1 — conservamos mayúsculas/tildes/espacios. El filename va
      // saneado (sin caracteres que rompen filesystems).
      const titleRaw = trimmed.replace(/\.md$/, "");
      const sanitized = titleRaw
        .replace(/[/\\:*?"<>|]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!sanitized) return;
      const filename = `${sanitized}.md`;
      const slash = fromPath.lastIndexOf("/");
      const dir = slash >= 0 ? fromPath.slice(0, slash) : "";
      const toPath = dir ? `${dir}/${filename}` : filename;
      if (toPath === fromPath) return;
      optimisticRemove(repo, fromPath);
      optimisticAdd(repo, toPath);
      // La pestaña abierta (y las de fondo) que apunten a fromPath siguen al toPath. Por identidad,
      // no por "la activa ahora" → cambiar de pestaña durante el await no lo afecta.
      onFileMoved?.(repo, fromPath, toPath, false);
      // Op de FS en vuelo (rename de archivo): el editor no persiste fromPath/toPath mientras corre
      // → sin el 409 "conflict" del save concurrente (caso 4). El newContent ya carga el H1 nuevo.
      const opId = crypto.randomUUID();
      onFsOpBegin?.({ id: opId, repo, fromPath, toPath, isFolder: false });
      try {
        await enqueueFsOp(repo, async () => {
          const { content, sha } = await apiGetFile(repo, fromPath);
          const newContent = replaceOrInsertH1(content, titleRaw);
          await apiMove(repo, fromPath, toPath, sha, newContent);
        });
        refreshTree();
      } catch (e) {
        clearPending(repo, fromPath); // falló el rename → el origen vuelve a mostrarse
        clearPending(repo, toPath); // …y el destino optimista se retira
        onFileMoved?.(repo, toPath, fromPath, false); // revertimos el remap de las pestañas
        refreshTree();
        alert(`No pude renombrar: ${(e as Error)?.message ?? e}`);
      } finally {
        onFsOpEnd?.(opId);
      }
    },
    [
      clearPending,
      enqueueFsOp,
      filesUnder,
      onFileMoved,
      onFsOpBegin,
      onFsOpEnd,
      optimisticAdd,
      optimisticRemove,
      refreshTree,
    ],
  );

  const doCreate = useCallback(
    async (raw: string) => {
      if (!creating) return;
      const resolved = resolveNewPath(raw, creating.dir);
      if (!resolved) {
        // Input vacío o inválido → cancelo silenciosamente (ESC también cae acá).
        setCreating(null);
        return;
      }
      const repo = creating.repo;
      // Optimista: sumamos el path al tree y abrimos/expandimos según corresponda
      // ANTES de la API. Si la API falla, refreshTree restaura desde el server.
      optimisticAdd(repo, resolved.path);
      setCreating(null);
      if (resolved.isFolder) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.add(folderKey(repo, resolved.folderPath));
          return next;
        });
      } else {
        // Nota recién creada → pestaña NUEVA (no clobberea la nota que estabas viendo).
        // Abrir una nota EXISTENTE sigue siendo replace-active (estilo Obsidian).
        onOpen(repo, resolved.path, true);
      }
      try {
        // Arranca con `# <basename>` como H1 (estilo Obsidian): el editor muestra el
        // título grande de entrada. Cuando el user lo reemplaza, patchDoc dispara
        // rename automático. Para carpetas (`.gitkeep` interno), arranca vacío.
        let initialContent = "";
        if (!resolved.isFolder) {
          const filename = resolved.path.split("/").pop() ?? "";
          const base = filename.replace(/\.md$/, "");
          initialContent = `# ${base}\n\n`;
        }
        // En la cola serial del repo: el create no se solapa con un move/rename del mismo repo.
        await enqueueFsOp(repo, () => apiCreate(repo, resolved.path, initialContent));
        refreshTree();
      } catch (e) {
        refreshTree();
        alert(`No pude crear: ${(e as Error)?.message ?? e}`);
      }
    },
    [creating, enqueueFsOp, onOpen, optimisticAdd, refreshTree],
  );
  // Renombrar el ALIAS de una wiki (7.5): cambio optimista del label local + POST al server.
  // Sólo display (no toca GitHub). Si falla, refreshTree revierte al label real.
  const doRenameWikiLabel = useCallback(
    async (repo: string, raw: string) => {
      setRenamingWiki(null);
      const label = raw.trim();
      if (!label) return; // vacío = cancelar (no permitimos limpiar el alias desde acá)
      setWikis((prev) => (prev ? prev.map((w) => (w.repo === repo ? { ...w, label } : w)) : prev));
      try {
        await apiSetWikiLabel(repo, label);
        refreshTree();
      } catch (e) {
        refreshTree();
        alert(`No pude renombrar la wiki: ${(e as Error)?.message ?? e}`);
      }
    },
    [refreshTree],
  );

  // Toast helper: muestra un mensaje 3s y lo limpia.
  const showToast = useCallback((msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => setToast(null), 3000);
  }, []);

  // F4: crear nueva wiki.
  const doCreateWiki = useCallback(
    async (label: string) => {
      setCreatingWiki(false);
      const trimmed = label.trim();
      if (!trimmed) return;
      try {
        await apiCreateWiki(trimmed);
        refreshTree();
        showToast("Wiki creada");
      } catch (e) {
        refreshTree();
        alert(`No pude crear la wiki: ${(e as Error)?.message ?? e}`);
      }
    },
    [refreshTree, showToast],
  );

  // F4: archivar wiki.
  const doArchiveWiki = useCallback(
    async (repo: string) => {
      setMenu(null);
      try {
        await apiArchiveWiki(repo);
        refreshTree();
        showToast("Wiki archivada — el asistente reinicia su contexto");
      } catch (e) {
        refreshTree();
        alert(`No pude archivar la wiki: ${(e as Error)?.message ?? e}`);
      }
    },
    [refreshTree, showToast],
  );

  // F4: salir de wiki (invitado).
  const doLeaveWiki = useCallback(
    async (repo: string) => {
      setMenu(null);
      if (!confirm("¿Salir de esta wiki? Perderás el acceso hasta que el owner te vuelva a invitar.")) return;
      try {
        await apiLeaveWiki(repo);
        refreshTree();
        showToast("Saliste de la wiki");
      } catch (e) {
        refreshTree();
        alert(`No pude salir de la wiki: ${(e as Error)?.message ?? e}`);
      }
    },
    [refreshTree, showToast],
  );

  // F4: borrar wiki (owner, con modal de confirmación).
  const doDeleteWiki = useCallback(
    async (repo: string, confirmName: string) => {
      setDeletingWiki(null);
      try {
        await apiDeleteWiki(repo, confirmName);
        refreshTree();
        showToast("Wiki borrada — el asistente reinicia su contexto");
      } catch (e) {
        refreshTree();
        alert(`No pude borrar la wiki: ${(e as Error)?.message ?? e}`);
      }
    },
    [refreshTree, showToast],
  );

  // Hidratación SÍNCRONA del tree expandido: leemos el handle cacheado en
  // `ceibo_handle` (lo escribe useChannel al login) para resolver la key
  // ANTES del primer paint y evitar el flash de "todo colapsado" que se veía
  // antes (cuando hidratábamos en un useEffect post-mount). Si el handle de
  // la sesión actual (prop `handle`, de /api/me) difiere del cacheado, el
  // effect de abajo re-hidrata.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      return loadExpanded(localStorage.getItem(HANDLE_KEY) ?? undefined);
    } catch {
      return new Set();
    }
  });

  // Si /api/me devuelve un handle distinto del cacheado (ej. cambio de usuario),
  // re-hidratar con el correcto.
  useEffect(() => {
    if (!handle) return;
    setExpanded((prev) => {
      const fresh = loadExpanded(handle);
      // Si ya está hidratado con lo mismo, no rompemos la referencia (evita re-render).
      if (prev.size === fresh.size && [...prev].every((k) => fresh.has(k))) return prev;
      return fresh;
    });
  }, [handle]);

  // Persistir cada cambio. Set chico (decenas de paths como máximo), no hace falta
  // debouncing.
  useEffect(() => {
    if (!handle) return;
    localStorage.setItem(`${EXP_KEY_PREFIX}${handle}`, JSON.stringify([...expanded]));
  }, [handle, expanded]);

  // Cache del árbol: persistir cada versión real del árbol bajo el handle confirmado, para
  // que el próximo F5 lo hidrate síncrono (sin "cargando…"). Sólo cuando hay datos (no el
  // null inicial) → nunca pisamos el cache con vacío.
  useEffect(() => {
    if (!handle || !wikis) return;
    writeTree(handle, wikis);
  }, [handle, wikis]);

  // Si /api/me confirma un handle distinto del cacheado (browser compartido), re-hidratar el
  // árbol con el cache de ESE usuario para no mostrar el del anterior mientras el poll trae lo
  // suyo. Si no tiene cache, dejamos lo que haya (el poll lo corrige) — no flasheamos a vacío.
  useEffect(() => {
    if (!handle) return;
    const cached = readTree(handle);
    if (cached) setWikis((prev) => (prev && wikisEqual(prev, cached) ? prev : cached));
  }, [handle]);

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Auto-expandir al cambiar el archivo abierto fue removido (2026-06-12): el owner no quiere
  // que seleccionar una pestaña expanda el árbol para revelar ese archivo. El estado `expanded`
  // queda intacto al cambiar de tab. Al crear una carpeta nueva sí se expande (ver el handler
  // de `created` más abajo), que es un caso donde revelar la carpeta recién creada sí tiene sentido.

  // "Mostrar en explorador" (menú contextual de la tab): la versión OPT-IN del auto-expand de
  // arriba. A pedido EXPLÍCITO del usuario expandimos las carpetas ancestro del archivo (aditivo,
  // como addExpandKeys → nunca colapsa lo que dejó abierto) y lo scrolleamos a la vista con un
  // highlight transitorio. Re-corre por `seq` para que pedir el mismo archivo dos veces re-dispare.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a propósito sólo el seq del pedido.
  useEffect(() => {
    if (!revealTarget) return;
    const { repo, path } = revealTarget;
    setExpanded((prev) => addExpandKeys(prev, repo, path));
    // Tras expandir (y que el árbol monte las filas reveladas) scrolleamos a la fila y la
    // resaltamos. Reintentamos por unos frames: la fila puede no existir en el primer rAF
    // porque la expansión recién montó sus hijos.
    let raf = 0;
    let tries = 0;
    const tick = () => {
      let el: HTMLElement | null = null;
      for (const r of document.querySelectorAll<HTMLElement>(".exp-file")) {
        if (r.dataset.expRepo === repo && r.dataset.expPath === path) {
          el = r;
          break;
        }
      }
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.classList.add("exp-file-revealed");
        window.setTimeout(() => el?.classList.remove("exp-file-revealed"), 1600);
        return;
      }
      if (tries++ >= 40) return; // ~0.6s; nos rendimos si la wiki/archivo no está en el árbol
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [revealTarget?.seq]);

  // El explorer es STANDALONE: no escucha al agente ni al bridge. Polea el filesystem
  // por sí mismo. Mount → fetch + arranca un timer cada POLL_INTERVAL_MS. Tab oculta
  // → pause (no hace ruido a GitHub mientras nadie mira). Tab vuelve / window focus
  // → fetch inmediato y re-arranca el timer. `cache: 'no-store'` para que ni el
  // browser ni un proxy intermedio sirvan una versión vieja del tree.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const load = async () => {
      try {
        const r = await fetch("/api/explorer", { cache: "no-store" });
        if (cancelled) return;
        const d = r.ok ? ((await r.json()) as { wikis?: Wiki[] }) : { wikis: [] };
        if (cancelled) return;
        // Reconciliamos contra los borrados pendientes (7.3) ANTES de comparar/setear, para que un
        // árbol stale del server no reintroduzca una nota recién archivada.
        const next = reconcilePending(d.wikis ?? []);
        // Solo setear si cambió de verdad (evita re-render del tree en cada poll
        // cuando GitHub no devolvió novedad). Comparación profunda sobre repos + files.
        setWikis((prev) => (prev && wikisEqual(prev, next) ? prev : next));
      } catch {
        if (!cancelled) setWikis((prev) => (prev && prev.length === 0 ? prev : []));
      }
    };

    const startPolling = () => {
      if (timer !== undefined) return;
      timer = setInterval(load, POLL_INTERVAL_MS);
    };
    const stopPolling = () => {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    };

    const onFocus = () => {
      void load();
      startPolling();
    };
    const onVisibility = () => {
      if (document.hidden) stopPolling();
      else onFocus();
    };

    void load();
    if (!document.hidden) startPolling();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      stopPolling();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reconcilePending]);

  // Recarga inmediata cuando el feed avisa que una wiki del user cambió (Fase 3a), sin
  // esperar el poll de 5s. En el mount inicial (reloadSeq 0/undefined) no hace nada: ya
  // carga el effect de arriba. `wikisEqual` evita re-render si el tree no cambió de verdad.
  useEffect(() => {
    if (!reloadSeq) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/explorer", { cache: "no-store" });
        if (cancelled || !r.ok) return;
        const next = reconcilePending(((await r.json()) as { wikis?: Wiki[] }).wikis ?? []);
        setWikis((prev) => (prev && wikisEqual(prev, next) ? prev : next));
      } catch {
        /* transitorio: el poll reintenta */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadSeq, reconcilePending]);

  return (
    <aside className="explorer">
      <div className="exp-resize" onPointerDown={startResize} aria-hidden="true" />
      {/* Activity bar (estilo VS Code): columna de íconos a la izquierda que conmuta el cuerpo del
          explorador entre el árbol de archivos, las páginas del sistema y las notificaciones. */}
      <nav className="activity-bar" aria-label="Paneles del explorador">
        <button
          type="button"
          className={`actbtn${panel === "files" ? " actbtn-on" : ""}`}
          onClick={() => onPanelChange("files")}
          aria-label="Explorador"
          aria-pressed={panel === "files"}
          data-tip="Explorador"
          data-tip-pos="right"
        >
          <IconFiles />
        </button>
        <button
          type="button"
          className={`actbtn${panel === "system" ? " actbtn-on" : ""}`}
          onClick={() => onPanelChange("system")}
          aria-label="Páginas del sistema"
          aria-pressed={panel === "system"}
          data-tip="Páginas del sistema"
          data-tip-pos="right"
        >
          <IconLauncher />
        </button>
        <button
          type="button"
          className={`actbtn${panel === "notifs" ? " actbtn-on" : ""}`}
          onClick={() => onPanelChange("notifs")}
          aria-label={inboxUnread > 0 ? `Notificaciones (${inboxUnread} sin leer)` : "Notificaciones"}
          aria-pressed={panel === "notifs"}
          data-tip="Notificaciones"
          data-tip-pos="right"
        >
          <IconBell />
          {inboxUnread > 0 && (
            <span className="notif-badge" aria-hidden="true">
              {inboxUnread > 9 ? "9+" : inboxUnread}
            </span>
          )}
        </button>
      </nav>
      <div className="explorer-main">
        <div className="explorer-head">
          <div className="exp-brand">
            {/* Wordmark de la marca: "Ceibo" en verde ceibo + el punto en ember (igual que la web
              pública example.com). */}
            <span className="exp-brand-name">
              Ceibo<span className="exp-brand-dot">.</span>
            </span>
            {/* Badge de versión: SHA corto + tag de entorno. Solo se muestra si el
              endpoint devolvió datos y el entorno lo permite (staging/dev siempre,
              prod solo con ?debugVersion=1). */}
            {versionInfo &&
              (() => {
                const badge = versionBadge(versionInfo.env, versionInfo.sha, window.location.search);
                return badge.show && badge.sha ? (
                  <span className="exp-version">
                    <span className="exp-version-sha">{badge.sha}</span>
                    <span className="exp-version-tag">{badge.tag}</span>
                  </span>
                ) : null;
              })()}
          </div>
          <div className="explorer-head-actions">
            {/* Cerrar el explorador: mismo botón redondo que el de abrir, pero con el ícono de
              panel con la sección lateral más fina (sugiere ocultar/colapsar el panel). */}
            <button
              type="button"
              className="view-close"
              onClick={onClose}
              aria-label="Ocultar explorador"
              data-tip="Ocultar explorador"
              data-tip-pos="left"
            >
              <IconPanelLeftClose />
            </button>
          </div>
        </div>
        {panel === "files" && (
          <div className="explorer-body">
            {wikis === null && <p className="view-msg">cargando…</p>}
            {wikis?.length === 0 && <p className="view-msg">no tenés wikis.</p>}
            {wikis?.map((w) => (
              <WikiTree
                key={w.repo}
                wiki={w}
                viewerHandle={handle}
                current={current}
                emojiForNote={emojiForNote}
                onOpen={onOpen}
                expanded={expanded}
                toggleExpanded={toggleExpanded}
                onContextMenuFile={(repo, path, x, y, isFolder) =>
                  setMenu({ repo, path, x, y, isFolder, kind: "file" })
                }
                onContextMenuWiki={(repo, x, y) =>
                  setMenu({ repo, path: "", x, y, isFolder: false, kind: "wiki" })
                }
                renamingWikiRepo={renamingWiki?.repo ?? null}
                onCommitWikiRename={(name) => {
                  if (renamingWiki) void doRenameWikiLabel(renamingWiki.repo, name);
                }}
                onCancelWikiRename={() => setRenamingWiki(null)}
                creating={creating}
                onStartCreate={(repo, dir) => {
                  setCreating({ repo, dir });
                  // Asegurar que el contenedor esté expandido para que el input se vea.
                  setExpanded((prev) => {
                    const key = dir ? folderKey(repo, dir) : repo;
                    if (prev.has(key)) return prev;
                    const next = new Set(prev);
                    next.add(key);
                    return next;
                  });
                }}
                onCommitCreate={(name) => void doCreate(name)}
                onCancelCreate={() => setCreating(null)}
                dragOver={dragOver}
                setDragOver={setDragOver}
                onDropOnTarget={(repo, dir, payload) => {
                  setDragOver(null);
                  // Cross-wiki: la nota soltada viene de OTRA wiki (payload.repo ≠ repo destino).
                  if (payload.repo !== repo) {
                    // Cross-wiki: una carpeta se mueve multi-archivo (doMoveFolderCross); una nota, directo.
                    if (payload.isFolder) void doMoveFolderCross(payload.repo, payload.path, repo, dir);
                    else void doMoveCross(payload.repo, payload.path, repo, dir);
                    return;
                  }
                  // Intra-wiki. Caso 7: una carpeta se mueve por prefijo (multi-archivo); un archivo, directo.
                  if (payload.isFolder) void doMoveFolder(repo, payload.path, dir);
                  else void doMove(repo, payload.path, dir);
                }}
                renaming={renaming}
                onCommitRename={(name) => {
                  if (!renaming) return;
                  void doRename(renaming.repo, renaming.path, name, renaming.isFolder);
                }}
                onCancelRename={() => setRenaming(null)}
              />
            ))}
            {/* F4: botón para crear una nueva wiki */}
            <div className="exp-wiki-add-wrap">
              {creatingWiki ? (
                <CreateWikiInput
                  onCommit={(label) => void doCreateWiki(label)}
                  onCancel={() => setCreatingWiki(false)}
                />
              ) : (
                <button type="button" className="exp-new-wiki-btn" onClick={() => setCreatingWiki(true)}>
                  <span className="exp-new-wiki-plus">+</span>
                  <span className="exp-new-wiki-label">Nueva wiki</span>
                </button>
              )}
            </div>
          </div>
        )}
        {/* Panel "sistema": la lista de páginas del sistema (antes era el menú del launcher-fab).
          Click → abre la página como tab en la vista principal (igual que antes). */}
        {panel === "system" && <SystemPanel openPages={openSystemPages} onOpen={onOpenSystem} />}
        {/* Panel "notificaciones": el inbox del agente (antes era el popup del notif-fab). */}
        {panel === "notifs" && (
          <NotifPanel
            items={inboxItems}
            unread={inboxUnread}
            onOpenItem={onOpenInboxItem}
            onMarkAll={onMarkAllInboxRead}
          />
        )}
        {/* Pie del explorer: vacío — sistema/notifs ahora viven en la activity bar, no como FAB. */}
        <div className="explorer-foot" />
      </div>
      {menu?.kind === "wiki" &&
        (() => {
          const wikiData = wikis?.find((w) => w.repo === menu.repo);
          return (
            <div className="exp-menu" role="menu" style={{ position: "fixed", top: menu.y, left: menu.x }}>
              {/* Renombrar alias (siempre visible) */}
              <button
                type="button"
                className="exp-menu-item"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => {
                  setRenamingWiki({ repo: menu.repo });
                  setMenu(null);
                }}
              >
                Renombrar
              </button>
              {/* Compartir (siempre visible) */}
              <button
                type="button"
                className="exp-menu-item"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => {
                  if (wikiData) setSharingWiki({ repo: menu.repo, wiki: wikiData });
                  setMenu(null);
                }}
              >
                <IconShare size={14} />
                <span>Compartir…</span>
              </button>
              {/* Archivar: solo si NO es wiki personal */}
              {!wikiData?.personal && (
                <button
                  type="button"
                  className="exp-menu-item"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => void doArchiveWiki(menu.repo)}
                >
                  <IconArchive size={14} />
                  <span>Archivar</span>
                </button>
              )}
              {/* Borrar wiki: solo owner de una wiki no-personal */}
              {wikiData?.isOwner && !wikiData?.personal && (
                <button
                  type="button"
                  className="exp-menu-item exp-menu-item-danger"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    setDeletingWiki({ repo: menu.repo, label: wikiData.label });
                    setMenu(null);
                  }}
                >
                  <IconTrash size={14} />
                  <span>Borrar wiki…</span>
                </button>
              )}
              {/* Salir de wiki: solo invitados (no owner) */}
              {wikiData && !wikiData.isOwner && (
                <button
                  type="button"
                  className="exp-menu-item"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => void doLeaveWiki(menu.repo)}
                >
                  <IconLogOut size={14} />
                  <span>Salir de esta wiki…</span>
                </button>
              )}
            </div>
          );
        })()}
      {menu?.kind === "file" && (
        <div className="exp-menu" role="menu" style={{ position: "fixed", top: menu.y, left: menu.x }}>
          {/* Sólo para archivos (las carpetas no se abren en pestaña). Equivale al ⌘-click. */}
          {!menu.isFolder && (
            <button
              type="button"
              className="exp-menu-item"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => {
                onOpen(menu.repo, menu.path, true);
                setMenu(null);
              }}
            >
              Abrir en nueva pestaña
            </button>
          )}
          <button
            type="button"
            className="exp-menu-item"
            // Evita que el mousedown propague al document (que cerraría el menú).
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              setRenaming({ repo: menu.repo, path: menu.path, isFolder: menu.isFolder });
              setMenu(null);
            }}
          >
            Renombrar
          </button>
          <button
            type="button"
            className="exp-menu-item"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => doArchive(menu.repo, menu.path, menu.isFolder)}
          >
            Archivar
          </button>
        </div>
      )}
      {/* F4: toast de notificación efímera */}
      {toast && (
        <div className="exp-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
      {/* F4: popup de compartir wiki */}
      {sharingWiki && (
        <WikiSharePopup
          wiki={sharingWiki.wiki}
          viewerHandle={handle}
          onClose={() => setSharingWiki(null)}
          onRefresh={refreshTree}
          showToast={showToast}
        />
      )}
      {/* F4: modal de confirmación para borrar wiki */}
      {deletingWiki && (
        <WikiDeleteModal
          repo={deletingWiki.repo}
          label={deletingWiki.label}
          onConfirm={(confirmName) => void doDeleteWiki(deletingWiki.repo, confirmName)}
          onCancel={() => setDeletingWiki(null)}
        />
      )}
    </aside>
  );
}

interface CreateProps {
  creating: { repo: string; dir: string } | null;
  onStartCreate: (repo: string, dir: string) => void;
  onCommitCreate: (name: string) => void;
  onCancelCreate: () => void;
}

interface RenameProps {
  renaming: { repo: string; path: string; isFolder: boolean } | null;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
}

interface DragProps {
  /** key del drop target sobre el que está pasando un drag — `${repo}:${dir}`. */
  dragOver: string | null;
  /** Drop sobre un target de la wiki: mover el archivo arrastrado a ese dir. */
  onDropOnTarget: (repo: string, targetDir: string, dragData: DragPayload) => void;
  /** Hover sobre un target válido → highlight. Null cuando sale. */
  setDragOver: (key: string | null) => void;
}

function WikiTree({
  wiki,
  viewerHandle,
  current,
  emojiForNote,
  onOpen,
  expanded,
  toggleExpanded,
  onContextMenuFile,
  creating,
  onStartCreate,
  onCommitCreate,
  onCancelCreate,
  dragOver,
  setDragOver,
  onDropOnTarget,
  renaming,
  onCommitRename,
  onCancelRename,
  onContextMenuWiki,
  renamingWikiRepo,
  onCommitWikiRename,
  onCancelWikiRename,
}: {
  wiki: Wiki;
  /** Handle del viewer: se filtra de los chips (sólo mostramos con QUIÉN se comparte). */
  viewerHandle?: string;
  current: Current | null;
  /** Emoji por-nota a mostrar (fuente única en App). "" / ausente = sin emoji. */
  emojiForNote?: (repo: string, path: string) => string;
  onOpen: (repo: string, path: string, newTab?: boolean) => void;
  expanded: Set<string>;
  toggleExpanded: (key: string) => void;
  onContextMenuFile: (repo: string, path: string, x: number, y: number, isFolder: boolean) => void;
  /** Click derecho / long-press sobre el título de la wiki → menú de wiki (7.5). */
  onContextMenuWiki: (repo: string, x: number, y: number) => void;
  /** Repo cuyo alias se está editando inline (o null). Si == esta wiki, el título es un input. */
  renamingWikiRepo: string | null;
  onCommitWikiRename: (name: string) => void;
  onCancelWikiRename: () => void;
} & CreateProps &
  DragProps &
  RenameProps) {
  const isOpen = expanded.has(wiki.repo);
  const isRenamingWiki = renamingWikiRepo === wiki.repo;
  // Long-press (mobile) sobre el título de la wiki → menú de wiki, igual que archivos/carpetas.
  const wikiLp = useLongPress((x, y) => onContextMenuWiki(wiki.repo, x, y));
  // Miembros con acceso menos el propio viewer → los chips dicen "compartida CON". Si queda
  // vacío (wiki sólo tuya), no mostramos nada.
  const others = (wiki.members ?? []).filter((m) => m.handle !== viewerHandle);
  // Solo .md y solo lo que es nota del usuario (predicado puro en explorerFiles.ts).
  //  Excluye CLAUDE.md (convenciones internas) y el README.md de la RAÍZ (autogenerado
  //  por auto_init → una wiki vacía se ve limpia). Lo archivado NO está en el listado:
  //  archivar = borrar la nota (vive en la historia de git), así que no hay carpeta
  //  `archivado/` ni notas frías que filtrar acá. El `.gitkeep` (ancla de carpeta vacía) y el
  //  `_archivado.md` SÍ pasan (no se renderizan como nota — se filtran en TreeNodes), pero
  //  anclan la EXISTENCIA de la carpeta. Sin esto, una carpeta cuyo único hijo es el ancla
  //  queda invisible: buildTree infiere las carpetas desde los archivos, y sin archivos
  //  visibles no hay nodo. (`_index.md` legacy recibe el mismo trato por compatibilidad.)
  const tree = useMemo(() => {
    return buildTree(wiki.files.filter(isVisibleWikiFile));
  }, [wiki.files]);
  const cur = current?.repo === wiki.repo ? current : null;
  const isCreatingHere = creating?.repo === wiki.repo && creating.dir === "";
  const dropKey = `${wiki.repo}:`;
  const isDragOver = dragOver === dropKey;
  const allowDrop = (e: DragEvent) => {
    if (e.dataTransfer.types.includes(DRAG_MIME)) {
      e.preventDefault();
      setDragOver(dropKey);
    }
  };
  return (
    <div className="exp-wiki">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drop target de drag&drop nativo, no hay role aria estándar */}
      <div
        className={`exp-row-wrap${isDragOver ? " exp-drop-over" : ""}`}
        onDragOver={allowDrop}
        onDragEnter={allowDrop}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node)) setDragOver(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          const raw = e.dataTransfer.getData(DRAG_MIME);
          if (!raw) return;
          try {
            onDropOnTarget(wiki.repo, "", JSON.parse(raw) as DragPayload);
          } catch {
            /* drop con payload inválido */
          }
        }}
      >
        {isRenamingWiki ? (
          <RenameInput
            initialValue={wiki.label}
            depth={0}
            onCommit={onCommitWikiRename}
            onCancel={onCancelWikiRename}
            commitOnBlur
          />
        ) : (
          <button
            type="button"
            className="exp-row exp-wiki-row"
            onClick={() => {
              if (wikiLp.fired.current) {
                wikiLp.fired.current = false;
                return;
              }
              toggleExpanded(wiki.repo);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              onContextMenuWiki(wiki.repo, e.clientX, e.clientY);
            }}
            {...wikiLp.handlers}
          >
            <Chevron open={isOpen} />
            <span className="exp-label">{wiki.label}</span>
          </button>
        )}
        {others.length > 0 && <MemberChips members={others} />}
        <button
          type="button"
          className="exp-add"
          title="Crear archivo o carpeta en esta wiki"
          onClick={(e) => {
            e.stopPropagation();
            onStartCreate(wiki.repo, "");
          }}
        >
          +
        </button>
      </div>
      {isOpen && (
        <div className="exp-children" style={childrenStyle(1.3)}>
          {isCreatingHere && <CreateInput depth={1} onCommit={onCommitCreate} onCancel={onCancelCreate} />}
          <TreeNodes
            nodes={tree}
            repo={wiki.repo}
            depth={1}
            current={cur}
            emojis={
              emojiForNote
                ? Object.fromEntries(
                    (wiki.files ?? [])
                      .map((p) => [p, emojiForNote(wiki.repo, p)] as const)
                      .filter(([, e]) => e),
                  )
                : wiki.emojis
            }
            onOpen={onOpen}
            expanded={expanded}
            toggleExpanded={toggleExpanded}
            onContextMenuFile={onContextMenuFile}
            creating={creating}
            onStartCreate={onStartCreate}
            onCommitCreate={onCommitCreate}
            onCancelCreate={onCancelCreate}
            dragOver={dragOver}
            setDragOver={setDragOver}
            onDropOnTarget={onDropOnTarget}
            renaming={renaming}
            onCommitRename={onCommitRename}
            onCancelRename={onCancelRename}
          />
        </div>
      )}
    </div>
  );
}

/** Input inline para crear nueva wiki (a nivel 0, debajo del listado de wikis). */
function CreateWikiInput({
  onCommit,
  onCancel,
}: {
  onCommit: (label: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <input
      ref={ref}
      className="exp-create-input exp-create-wiki-input"
      placeholder="Nombre de la nueva wiki"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(value);
        else if (e.key === "Escape") onCancel();
      }}
      onBlur={() => onCancel()}
    />
  );
}

/** Popup flotante para compartir una wiki: lista miembros actuales, invitaciones
 *  pendientes, picker de usuarios del directorio, e invitación por email. */
function WikiSharePopup({
  wiki,
  viewerHandle,
  onClose,
  onRefresh,
  showToast,
}: {
  wiki: Wiki;
  viewerHandle?: string;
  onClose: () => void;
  onRefresh: () => void;
  showToast: (msg: string) => void;
}) {
  const [directory, setDirectory] = useState<Array<{
    handle: string;
    name: string;
    hasAvatar: boolean;
  }> | null>(null);
  const [dirFilter, setDirFilter] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [loading, setLoading] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);

  // Cargar el directorio al abrir el popup.
  useEffect(() => {
    let cancelled = false;
    void apiUsersDirectory()
      .then((users) => {
        if (!cancelled) setDirectory(users);
      })
      .catch(() => {
        if (!cancelled) setDirectory([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Cerrar con ESC o click afuera.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as globalThis.Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown as EventListener, { passive: true });
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown as EventListener);
    };
  }, [onClose]);

  const memberHandles = new Set((wiki.members ?? []).map((m) => m.handle));
  const filteredDir = (directory ?? []).filter(
    (u) =>
      !memberHandles.has(u.handle) &&
      (dirFilter === "" ||
        u.handle.toLowerCase().includes(dirFilter.toLowerCase()) ||
        u.name.toLowerCase().includes(dirFilter.toLowerCase())),
  );

  const handleInviteByHandle = async (handle: string) => {
    setLoading(true);
    try {
      await apiInviteMember(wiki.repo, handle);
      onRefresh();
      showToast(`Invitación enviada a @${handle}`);
    } catch (e) {
      alert(`No pude invitar: ${(e as Error)?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  };

  const handleInviteByEmail = async () => {
    const email = emailInput.trim();
    if (!email) return;
    setLoading(true);
    try {
      await apiInviteByEmail(wiki.repo, email);
      setEmailInput("");
      onRefresh();
      showToast(`Invitación enviada a ${email}`);
    } catch (e) {
      alert(`No pude invitar: ${(e as Error)?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveMember = async (memberHandle: string) => {
    setLoading(true);
    try {
      await apiRemoveMember(wiki.repo, memberHandle);
      onRefresh();
      showToast("Miembro removido");
    } catch (e) {
      alert(`No pude remover: ${(e as Error)?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveInvite = async (email: string) => {
    setLoading(true);
    try {
      await apiRemoveInvite(wiki.repo, email);
      onRefresh();
      showToast("Invitación cancelada");
    } catch (e) {
      alert(`No pude cancelar la invitación: ${(e as Error)?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="wiki-share-popup" ref={popupRef} role="dialog" aria-label="Compartir wiki">
      <div className="wiki-share-header">
        <span className="wiki-share-title">Compartir wiki</span>
        <button type="button" className="wiki-share-close" onClick={onClose} aria-label="Cerrar">
          ×
        </button>
      </div>

      {/* Miembros actuales */}
      {(wiki.members ?? []).length > 0 && (
        <div className="wiki-share-section">
          <div className="wiki-share-section-title">Miembros</div>
          {(wiki.members ?? []).map((m) => (
            <div className="wiki-share-member-row" key={m.handle}>
              <MemberFace member={m} />
              <span className="wiki-share-member-name">
                {m.name}
                {m.handle === viewerHandle && <span className="wiki-share-you"> (tú)</span>}
              </span>
              {wiki.isOwner && m.handle !== viewerHandle && (
                <button
                  type="button"
                  className="wiki-share-remove-btn"
                  disabled={loading}
                  onClick={() => void handleRemoveMember(m.handle)}
                  aria-label={`Remover a ${m.name}`}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Invitaciones pendientes (solo owner) */}
      {wiki.isOwner && (wiki.pendingInvites ?? []).length > 0 && (
        <div className="wiki-share-section">
          <div className="wiki-share-section-title">Invitaciones pendientes</div>
          {(wiki.pendingInvites ?? []).map((inv) => (
            <div className="wiki-share-pending-row" key={inv.email}>
              <span className="wiki-share-pending-email">{inv.email}</span>
              <button
                type="button"
                className="wiki-share-remove-btn"
                disabled={loading}
                onClick={() => void handleRemoveInvite(inv.email)}
                aria-label={`Cancelar invitación a ${inv.email}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Picker del directorio de usuarios */}
      {wiki.isOwner && (
        <div className="wiki-share-section">
          <div className="wiki-share-section-title">
            <IconUserPlus size={12} />
            <span> Agregar miembro</span>
          </div>
          {directory === null ? (
            <div className="wiki-share-loading">cargando…</div>
          ) : (
            <>
              <input
                className="wiki-share-invite-input"
                placeholder="Buscar usuario…"
                value={dirFilter}
                onChange={(e) => setDirFilter(e.target.value)}
              />
              {filteredDir.length > 0 && (
                <div className="wiki-share-dir-list">
                  {filteredDir.slice(0, 8).map((u) => (
                    <button
                      key={u.handle}
                      type="button"
                      className="wiki-share-dir-item"
                      disabled={loading}
                      onClick={() => void handleInviteByHandle(u.handle)}
                    >
                      <MemberFace member={u} />
                      <span>{u.name}</span>
                      <span className="wiki-share-dir-handle">@{u.handle}</span>
                    </button>
                  ))}
                </div>
              )}
              {filteredDir.length === 0 && dirFilter && (
                <div className="wiki-share-empty">Sin coincidencias</div>
              )}
            </>
          )}
        </div>
      )}

      {/* Invitación por email */}
      {wiki.isOwner && (
        <div className="wiki-share-section wiki-share-email-section">
          <div className="wiki-share-section-title">Invitar por email</div>
          <div className="wiki-share-email-row">
            <input
              className="wiki-share-invite-input"
              type="email"
              placeholder="correo@ejemplo.com"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleInviteByEmail();
              }}
            />
            <button
              type="button"
              className="wiki-share-invite-btn"
              disabled={loading || !emailInput.trim()}
              onClick={() => void handleInviteByEmail()}
            >
              Invitar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Modal de confirmación para borrar una wiki. Requiere escribir el nombre exacto. */
function WikiDeleteModal({
  repo: _repo,
  label,
  onConfirm,
  onCancel,
}: {
  repo: string;
  label: string;
  onConfirm: (confirmName: string) => void;
  onCancel: () => void;
}) {
  const [confirmValue, setConfirmValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const canConfirm = confirmValue === label;

  // Renderizamos el modal en un portal a document.body para que escape del <aside
  // class="explorer">, cuyo backdrop-filter crea un containing block para los
  // descendientes position:fixed. Sin el portal, el overlay queda confinado al panel
  // izquierdo en lugar de cubrir todo el viewport.
  return createPortal(
    <div className="wiki-delete-modal-overlay" role="dialog" aria-modal="true" aria-label="Borrar wiki">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: click outside to cancel */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click-outside dismiss, ESC handled on document */}
      <div className="wiki-delete-modal-backdrop" onClick={onCancel} />
      <div className="wiki-delete-modal">
        <h2 className="wiki-delete-modal-title">Borrar wiki</h2>
        <p className="wiki-delete-modal-warning">
          Esta acción borra la wiki <strong>{label}</strong> para TODOS los miembros. Recuperable solo por un
          admin durante un tiempo limitado.
        </p>
        <label className="wiki-delete-modal-label" htmlFor="wiki-delete-confirm">
          Para confirmar, escribí el nombre de la wiki:
        </label>
        <input
          id="wiki-delete-confirm"
          ref={inputRef}
          className="wiki-delete-modal-input"
          value={confirmValue}
          onChange={(e) => setConfirmValue(e.target.value)}
          placeholder={label}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canConfirm) onConfirm(confirmValue);
          }}
        />
        <div className="wiki-delete-modal-actions">
          <button type="button" className="wiki-delete-modal-cancel" onClick={onCancel}>
            Cancelar
          </button>
          <button
            type="button"
            className="wiki-delete-modal-confirm"
            disabled={!canConfirm}
            onClick={() => onConfirm(confirmValue)}
          >
            Borrar wiki
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Input inline para el "+" del explorer. Auto-focus al montar; commit con Enter,
 *  cancel con ESC o blur. */
function CreateInput({
  depth,
  onCommit,
  onCancel,
}: {
  depth: number;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <input
      ref={ref}
      className="exp-create-input"
      placeholder="nombre  o  nombre/  (carpeta)"
      value={value}
      style={{ marginLeft: `${depth * 0.9 + 0.6}rem` }}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(value);
        else if (e.key === "Escape") onCancel();
      }}
      onBlur={() => onCancel()}
    />
  );
}

function TreeNodes({
  nodes,
  repo,
  depth,
  current,
  emojis,
  onOpen,
  expanded,
  toggleExpanded,
  onContextMenuFile,
  creating,
  onStartCreate,
  onCommitCreate,
  onCancelCreate,
  dragOver,
  setDragOver,
  onDropOnTarget,
  renaming,
  onCommitRename,
  onCancelRename,
}: {
  nodes: Node[];
  repo: string;
  depth: number;
  current: Current | null;
  /** Mapa path→emoji de la wiki (estilo Notion): se pinta antes del nombre en cada nota. */
  emojis?: Record<string, string>;
  onOpen: (repo: string, path: string, newTab?: boolean) => void;
  expanded: Set<string>;
  toggleExpanded: (key: string) => void;
  onContextMenuFile: (repo: string, path: string, x: number, y: number, isFolder: boolean) => void;
} & CreateProps &
  DragProps &
  RenameProps) {
  return (
    <>
      {nodes.map((n) =>
        n.children ? (
          <Folder
            key={`d:${n.full}`}
            node={n}
            repo={repo}
            depth={depth}
            current={current}
            emojis={emojis}
            onOpen={onOpen}
            expanded={expanded}
            toggleExpanded={toggleExpanded}
            onContextMenuFile={onContextMenuFile}
            creating={creating}
            onStartCreate={onStartCreate}
            onCommitCreate={onCommitCreate}
            onCancelCreate={onCancelCreate}
            dragOver={dragOver}
            setDragOver={setDragOver}
            onDropOnTarget={onDropOnTarget}
            renaming={renaming}
            onCommitRename={onCommitRename}
            onCancelRename={onCancelRename}
          />
        ) : n.name === ".gitkeep" ||
          n.name === "_index.md" ||
          n.name === "_archivado.md" ||
          n.name === ".archived.md" ? null : renaming?.repo === repo && renaming.path === n.path ? (
          <RenameInput
            key={`r:${n.path}`}
            initialValue={(n.name ?? "").replace(/\.md$/, "")}
            depth={depth}
            onCommit={onCommitRename}
            onCancel={onCancelRename}
          />
        ) : (
          <FileRow
            key={`f:${n.path}`}
            repo={repo}
            node={n}
            depth={depth}
            current={current}
            emoji={emojis?.[n.path ?? ""]}
            onOpen={onOpen}
            onContextMenuFile={onContextMenuFile}
          />
        ),
      )}
    </>
  );
}

/** Fila de archivo. Click abre; click derecho (desktop) o long-press (mobile) abre el
 *  menú contextual. Es un componente propio para poder usar el hook de long-press por fila. */
function FileRow({
  repo,
  node,
  depth,
  current,
  emoji,
  onOpen,
  onContextMenuFile,
}: {
  repo: string;
  node: Node;
  depth: number;
  current: Current | null;
  /** Emoji asignado a esta nota (sidecar `.ceibo/emojis.json`). Vacío/ausente = sin emoji. */
  emoji?: string;
  onOpen: (repo: string, path: string, newTab?: boolean) => void;
  onContextMenuFile: (repo: string, path: string, x: number, y: number, isFolder: boolean) => void;
}) {
  const path = node.path as string;
  const lp = useLongPress((x, y) => {
    onContextMenuFile(repo, path, x, y, false);
  });
  return (
    <button
      type="button"
      className={`exp-row exp-file${current && current.path === path ? " exp-file-active" : ""}`}
      style={{ paddingLeft: `${depth * 0.9 + 0.6}rem` }}
      data-exp-repo={repo}
      data-exp-path={path}
      draggable
      onDragStart={(e) => {
        const payload: DragPayload = { repo, path };
        e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={(e) => {
        // Si venimos de un long-press (que ya abrió el menú), no abrir el archivo.
        if (lp.fired.current) {
          lp.fired.current = false;
          return;
        }
        // ⌘-click (Mac) / Ctrl-click (Win/Linux) → abrir en una pestaña NUEVA, como en el
        // navegador. Click normal → reemplaza el contenido de la pestaña activa.
        onOpen(repo, path, e.metaKey || e.ctrlKey);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenuFile(repo, path, e.clientX, e.clientY, false);
      }}
      {...lp.handlers}
    >
      <span className="exp-chevron-box" aria-hidden="true" />
      {emoji && (
        <span className="exp-emoji" aria-hidden="true">
          {emoji}
        </span>
      )}
      <span className="exp-label">{node.name.replace(/\.md$/, "")}</span>
    </button>
  );
}

/** Input inline para renombrar una nota. Mismo skin que CreateInput pero arranca
 *  con el nombre actual seleccionado (sin la extensión .md) para que tipear lo
 *  reemplace de una. */
function RenameInput({
  initialValue,
  depth,
  onCommit,
  onCancel,
  commitOnBlur = false,
}: {
  initialValue: string;
  depth: number;
  onCommit: (name: string) => void;
  onCancel: () => void;
  /** Si true, perder el foco (click afuera) CONFIRMA el valor en vez de descartarlo. Lo usa el
   *  rename del alias de wiki: el usuario suele terminar la edición clickeando afuera, no con Enter
   *  — sin esto el cambio se perdía y el título "flasheaba" al nombre viejo (no persistía). El
   *  rename de archivos/carpetas deja el default (blur = cancelar) para no crear nada sin querer. */
  commitOnBlur?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLInputElement>(null);
  // Una sola resolución: Enter/Escape resuelven y desmontan el input → el blur que dispara el
  // desmontaje no debe re-commitear (doble POST) ni re-cancelar. `done` lo evita.
  const done = useRef(false);
  const finish = useCallback(
    (commit: boolean) => {
      if (done.current) return;
      done.current = true;
      if (commit) onCommit(value);
      else onCancel();
    },
    [value, onCommit, onCancel],
  );
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  return (
    <input
      ref={ref}
      className="exp-create-input"
      value={value}
      style={{ marginLeft: `${depth * 0.9 + 0.6}rem` }}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(commitOnBlur)}
    />
  );
}

function Folder({
  node,
  repo,
  depth,
  current,
  emojis,
  onOpen,
  expanded,
  toggleExpanded,
  onContextMenuFile,
  creating,
  onStartCreate,
  onCommitCreate,
  onCancelCreate,
  dragOver,
  setDragOver,
  onDropOnTarget,
  renaming,
  onCommitRename,
  onCancelRename,
}: {
  node: Node;
  repo: string;
  depth: number;
  current: Current | null;
  /** Mapa path→emoji de la wiki: se propaga a las notas anidadas bajo esta carpeta. */
  emojis?: Record<string, string>;
  onOpen: (repo: string, path: string, newTab?: boolean) => void;
  expanded: Set<string>;
  toggleExpanded: (key: string) => void;
  onContextMenuFile: (repo: string, path: string, x: number, y: number, isFolder: boolean) => void;
} & CreateProps &
  DragProps &
  RenameProps) {
  const fkey = folderKey(repo, node.full ?? "");
  const isOpen = expanded.has(fkey);
  const isCreatingHere = creating?.repo === repo && creating.dir === (node.full ?? "");
  const dropKey = `${repo}:${node.full ?? ""}`;
  const isDragOver = dragOver === dropKey;
  // Drop target de la carpeta. `stopPropagation` para que, al estar anidada, esta carpeta
  // RECLAME el drop y no se lo robe (ni lo duplique en) el `.exp-children` de un ancestro.
  const allowDrop = (e: DragEvent) => {
    if (e.dataTransfer.types.includes(DRAG_MIME)) {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(dropKey);
    }
  };
  const onDropHere = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    try {
      onDropOnTarget(repo, node.full ?? "", JSON.parse(raw) as DragPayload);
    } catch {
      /* drop con payload inválido */
    }
  };
  const onDropLeave = (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node)) setDragOver(null);
  };
  const isRenamingThis = renaming?.repo === repo && renaming.path === (node.full ?? "") && renaming.isFolder;
  const lp = useLongPress((x, y) => onContextMenuFile(repo, node.full ?? "", x, y, true));
  return (
    <>
      {isRenamingThis ? (
        <RenameInput
          initialValue={node.name}
          depth={depth}
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: drop target de drag&drop nativo, no hay role aria estándar
        <div
          className={`exp-row-wrap${isDragOver ? " exp-drop-over" : ""}`}
          onDragOver={allowDrop}
          onDragEnter={allowDrop}
          onDragLeave={onDropLeave}
          onDrop={onDropHere}
        >
          <button
            type="button"
            className="exp-row exp-folder"
            style={{ paddingLeft: `${depth * 0.9 + 0.6}rem` }}
            // Caso 7: la carpeta es drag-SOURCE (antes sólo era drop target → no se podía mover).
            // El payload lleva isFolder:true → el drop la mueve por prefijo (multi-archivo).
            draggable
            onDragStart={(e) => {
              const payload: DragPayload = { repo, path: node.full ?? "", isFolder: true };
              e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
              e.dataTransfer.effectAllowed = "move";
              // Sin esto, el drag del botón sobre su PROPIO wrapper marcaría dragOver y dejaría el
              // highlight pegado; el drop sobre sí misma igual lo descarta doMoveFolder.
              e.stopPropagation();
            }}
            onClick={() => {
              // Si venimos de un long-press (que abrió el menú), no togglear la carpeta.
              if (lp.fired.current) {
                lp.fired.current = false;
                return;
              }
              toggleExpanded(fkey);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              onContextMenuFile(repo, node.full ?? "", e.clientX, e.clientY, true);
            }}
            {...lp.handlers}
          >
            <Chevron open={isOpen} />
            <span className="exp-label">{node.name}</span>
          </button>
          <button
            type="button"
            className="exp-add"
            title="Crear archivo o carpeta acá"
            onClick={(e) => {
              e.stopPropagation();
              onStartCreate(repo, node.full ?? "");
            }}
          >
            +
          </button>
        </div>
      )}
      {isOpen && (
        // El ÁREA de archivos de una carpeta abierta es también drop target: dropear en cualquier
        // lugar del área (no sólo EN la fila de la carpeta) mueve a esta carpeta. Las subcarpetas
        // hacen stopPropagation en su propio drop, así un drop sobre ellas NO cae acá. Resaltamos el
        // área entera (`exp-children-drop-over`) además de la fila (`exp-drop-over`).
        // biome-ignore lint/a11y/noStaticElementInteractions: drop target de drag&drop nativo, no hay role aria estándar
        <div
          className={`exp-children${isDragOver ? " exp-children-drop-over" : ""}`}
          style={childrenStyle(depth * 0.9 + 1.15)}
          onDragOver={allowDrop}
          onDragEnter={allowDrop}
          onDragLeave={onDropLeave}
          onDrop={onDropHere}
        >
          {isCreatingHere && (
            <CreateInput depth={depth + 1} onCommit={onCommitCreate} onCancel={onCancelCreate} />
          )}
          <TreeNodes
            nodes={node.children ?? []}
            repo={repo}
            depth={depth + 1}
            current={current}
            emojis={emojis}
            onOpen={onOpen}
            expanded={expanded}
            toggleExpanded={toggleExpanded}
            onContextMenuFile={onContextMenuFile}
            creating={creating}
            onStartCreate={onStartCreate}
            onCommitCreate={onCommitCreate}
            onCancelCreate={onCancelCreate}
            dragOver={dragOver}
            setDragOver={setDragOver}
            onDropOnTarget={onDropOnTarget}
            renaming={renaming}
            onCommitRename={onCommitRename}
            onCancelRename={onCancelRename}
          />
        </div>
      )}
    </>
  );
}
