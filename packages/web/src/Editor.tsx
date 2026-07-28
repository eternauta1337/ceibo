// Editor de archivo (managed-ui, unificado 2026-05): SIEMPRE editable, sin toggle
// ver/editar. Live preview estilo Obsidian (Atomic Editor sobre CodeMirror 6): el
// markdown sigue siendo la fuente de verdad, pero headings/listas/bold se renderizan
// inline mientras tipeás; al pararte en una línea se ve la sintaxis cruda.
//
// TÍTULO (#10): el título de la nota ES el nombre del archivo, mostrado como un H1
// editable arriba del cuerpo. Editarlo renombra el archivo. El cuerpo NO repite el
// título: si el md arranca con un H1 == al nombre del archivo (notas viejas o las que
// escribe el agente), lo OCULTAMOS de la vista — pero NO lo borramos del md: lo
// guardamos como prefijo y lo re-agregamos en cada save (y lo sincronizamos al renombrar).
//
// AUTOSAVE: debounce ~2.5s tras dejar de tipear → PUT /api/file (commit directo a git,
// optimista por sha). Si el archivo cambió afuera (agente/REM/otra pestaña) → 409.
//
// REBASE TRANSPARENTE EN 409 (Fase B de "rock solid", ver merge3.ts): el 409 ya NO es un
// callejón. El editor trae lo del server (GET), hace un merge a 3 vías por líneas (base =
// lo último que este editor guardó/adoptó, mío = el buffer, de ellos = el server) y:
//   - sin solapamiento (el caso común: REM consolidó OTRA sección) → el merge entra como
//     transacción CM6 (mecanismo de la Fase C: cursor/folds intactos) y se re-guarda con
//     el sha fresco. Silencioso: el usuario ni se entera.
//   - solapamiento REAL (las MISMAS líneas) → panel de conflicto CON OPCIONES: conservar
//     lo mío / traer lo de afuera (en ambos casos los cambios NO conflictivos del otro
//     lado se conservan) / ver las diferencias. Nunca "copiá a mano y recargá".
// Carreras: el merge usa el buffer leído SINCRÓNICAMENTE después del GET y aplica el
// resultado en esa misma tarea (sin awaits en el medio) → ninguna tecla puede colarse
// entre lo medido y lo aplicado; lo tipeado durante el GET ya está en `mine` (onChange es
// síncrono), y lo tipeado durante el re-PUT lo cubre el próximo autosave (el draft lo
// protege igual, Fase A).
//
// DRAFT PERSISTENTE (Fase A de "rock solid", ver draftStore.ts): cada cambio se espeja
// al draft (memoria síncrona + IndexedDB con throttle). Si el editor se remonta (refresh
// externo / conflicto), la pestaña se cierra o el browser crashea, al volver a montar la
// nota se rehidrata el draft VIVO (contenido ≠ último confirmado) con un aviso suave y
// opción de descartar. El draft se borra solo cuando un save 200 confirma EXACTAMENTE su
// contenido (si seguiste tipeando durante el PUT, el draft más nuevo queda protegido).
//
// CAMBIOS EXTERNOS SIN REMONTAR (Fase C de "rock solid", ver externalChange.ts): un
// cambio de afuera (agente/REM, otra pestaña, revalidación SWR) ya NO remonta el editor.
// El canal actualiza `initialContent`/`initialSha` por props y acá decidimos: buffer
// limpio → el cambio entra como transacción CM6 (cursor/scroll/folds intactos); buffer
// dirty → banner no-modal "hay una versión más nueva" y el usuario decide (aplicar
// descarta lo local, con confirmación; postergar no toca nada). El remount quedó SOLO
// para el cambio real de documento (otro doc.id, key en App).

import { AtomicCodeMirrorEditor } from "@atomic-editor/editor";
import "@atomic-editor/editor/styles.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { type BlameRangeWire, blameController } from "./blame.ts";
import {
  clearDraft,
  clearDraftIfUnchanged,
  draftKeyOf,
  flushDraft,
  loadDraft,
  moveDraft,
  saveDraft,
  shouldRestoreDraft,
} from "./draftStore.ts";
import { EmojiPicker } from "./EmojiPicker.tsx";
import { applyExternalToView, decideExternal, editorViewTap } from "./externalChange.ts";
import { replaceOrInsertH1 } from "./h1Title.ts";
import { headingFold } from "./headingFold.ts";
import { IconUsers } from "./icons.tsx";
import { linkClick } from "./linkClick.ts";
import { classifyLink } from "./linkScheme.ts";
import { listDrag } from "./listDrag.ts";
import { listContinuationHang } from "./listHang.ts";
import { listIndent } from "./listIndent.ts";
import { listMove } from "./listMove.ts";
import { collapseDiff, type DiffView, diffLines, merge3 } from "./merge3.ts";
import { withTrailingNewline } from "./noteContent.ts";
import { saveRetryPlan } from "./saveRetry.ts";
import { sanitizeFilename } from "./useChannel.ts";

// Extensiones CM6 que sumamos al editor de atomic. Referencia ESTABLE a nivel módulo: el
// prop `extensions` se captura al montar; pasar un array nuevo en cada render remontaría
// el editor. `listContinuationHang` cuelga las líneas de continuación de items hard-wrapeados
// (atomic solo decora la línea-marker) — ver listHang.ts. `headingFold` pliega secciones por
// título estilo Obsidian (estado de vista, no toca el md) — ver headingFold.ts. `listIndent`
// hace Tab/Shift-Tab list-aware (niveles discretos) y renumera listas ordenadas por nivel
// — ver listIndent.ts / listEdit.ts. `listMove` mueve items con Alt+↑/↓ (+ botones mobile)
// y `listDrag` agrega el handle ⠿ de drag con mouse (desktop) — ver listMove.ts / listDrag.ts.
// Exportada para el harness de browser `listlab.html` (src/listlab.tsx): monta el editor
// real con EXACTAMENTE este stack para verificar keymaps/comandos a mano.
export const EDITOR_EXTENSIONS = [
  listContinuationHang(),
  headingFold(),
  listIndent(),
  listMove(),
  listDrag(),
];

type SaveState = "idle" | "saving" | "saved" | "conflict" | "error";
// El feedback de guardado rutinario (guardando/guardado) NO se muestra (#21): el autosave
// es silencioso. Sólo surfaceamos lo que el usuario necesita accionar: conflicto (panel
// .editor-conflict con opciones, Fase B) / error.
const SAVE_LABEL: Record<SaveState, string> = {
  idle: "",
  saving: "",
  saved: "",
  conflict: "", // la UI del conflicto es el panel con opciones, no este label
  error: "⚠ no se pudo guardar",
};
const DEBOUNCE_MS = 2500;
// Reintentos del save ante un fallo TRANSITORIO (red caída, 5xx, o read-after-write del CDN de
// GitHub: el GET post-409 devuelve un blob que ya conocemos / el PUT falla por lag). Backoff
// lineal capeado; el draft protege el texto mientras tanto y sólo tras agotar el presupuesto
// caemos a estado "error". Presupuesto holgado (~13.8s) porque el read-after-write de GitHub bajo
// carga puede tardar bastante más que los ~5s de antes (REBASE_STALE_MAX=3 × 800ms). Ver saveRetry.ts.
const SAVE_RETRY_MAX = 6;
const SAVE_RETRY_BASE_MS = 800;
const SAVE_RETRY_CAP_MS = 3000;

/** Nombre base del archivo (sin carpeta ni `.md`) — es el título mostrado. */
function titleFromPath(path: string): string {
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.md$/i, "");
}

/** Resuelve un link interno (relativo a la nota actual) a un path repo-relativo de nota.
 *  Soporta `./`, `../`, paths absolutos de repo (`/x`), %-encoding y anchors (#) que ignora.
 *  Si no trae extensión, asume `.md` (las notas son markdown). null = nada que abrir (anchor
 *  puro al mismo doc, o link vacío). */
function resolveInternalPath(currentPath: string, url: string): string | null {
  const noHash = (url.split("#")[0] ?? "").split("?")[0] ?? "";
  if (!noHash) return null; // ej. "#seccion" → misma nota, no navegamos
  let raw: string;
  try {
    raw = decodeURIComponent(noHash);
  } catch {
    raw = noHash;
  }
  const dir = currentPath.includes("/") ? currentPath.replace(/\/[^/]*$/, "") : "";
  const base = raw.startsWith("/") ? [] : dir ? dir.split("/") : [];
  const out = [...base];
  for (const seg of raw.replace(/^\//, "").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  let p = out.join("/");
  if (!p) return null;
  if (!/\.[a-z0-9]+$/i.test(p)) p += ".md"; // sin extensión → nota .md
  return p;
}

/** Separa un H1 inicial redundante (cuyo texto == nombre del archivo) del resto del
 *  cuerpo. `prefix` se oculta en la vista pero se preserva en el md (se re-agrega al
 *  guardar). Si la 1ª línea no-vacía no es un H1 que matchee el filename, no hay prefijo
 *  y el cuerpo es el contenido tal cual. */
function splitTitle(content: string, base: string): { prefix: string; body: string } {
  const m = content.match(/^(\s*)#[ \t]+([^\n]+?)[ \t]*(\n+|$)/);
  if (m?.[2] && sanitizeFilename(m[2]) === base) {
    return { prefix: content.slice(0, m[0].length), body: content.slice(m[0].length) };
  }
  return { prefix: "", body: content };
}

export function FileEditor({
  repo,
  path,
  emoji,
  onSetEmoji,
  initialContent,
  initialSha,
  blameOn,
  blameAvailable,
  onToggleBlame,
  selfHandle,
  onSaved,
  onRename,
  onOpen,
  isPathUnderFsOp,
}: {
  repo: string;
  path: string;
  /** Emoji de la nota (estilo Notion): se pinta a la izquierda del título editable. "" / ausente
   *  = sin emoji (el botón se ve como una hendidura sutil). */
  emoji?: string;
  /** Asigna/limpia el emoji de la nota desde el botón a la izquierda del título ("" = limpiar).
   *  Ausente (ej. wiki read-only) → el botón no se muestra. */
  onSetEmoji?: (emoji: string) => void;
  initialContent: string;
  initialSha?: string;
  /** Blame por línea activo (toggle dentro de la nota): al prender, se fetchea
   *  GET /api/file/blame y se pintan franjas + avatares por autor; al apagar, se limpian. */
  blameOn?: boolean;
  /** ¿Esta wiki tiene blame disponible? Decide si el botón del sub-header de la nota se muestra
   *  (no aparece en wikis sin autoría que mostrar). */
  blameAvailable?: boolean;
  /** Prende/apaga el blame desde el botón del sub-header (antes del título, right-aligned).
   *  Ausente → no se renderiza el botón. */
  onToggleBlame?: () => void;
  /** Handle del viewer: el tooltip del blame marca sus propias líneas con "(vos)". */
  selfHandle?: string;
  // Avisa lo guardado → el state global se actualiza. Pasa repo+path de ESTA nota para que el
  // handler descarte el eco si el usuario ya cambió de pestaña mientras el PUT estaba en vuelo
  // (sin eso, el contenido/sha de esta nota se escribiría sobre la nota activa → corrupción).
  onSaved?: (content: string, sha: string, repo: string, path: string) => void;
  // Editar el título renombra el archivo. `fullContent` es el contenido vivo del editor (prefijo
  // H1 + cuerpo): renameDoc le reescribe el H1 y lo persiste atómicamente con el cambio de path.
  onRename?: (newTitle: string, fullContent?: string) => Promise<string | undefined>;
  /** Abre otra nota (click en un link interno). Reemplaza la nota abierta (ceibo no tiene tabs). */
  onOpen?: (repo: string, path: string) => void;
  /** ¿(repo,path) está bajo una op de FS (move/rename) en vuelo? Si lo está, el autosave y el
   *  flush-on-unmount NO persisten este archivo: la op es la dueña de su ciclo de vida. Sin esto,
   *  un save concurrente cambiaba el blob que el move estaba leyendo → 409 "conflict" (caso 4). */
  isPathUnderFsOp?: (repo: string, path: string) => boolean;
}) {
  // Split inicial UNA sola vez (al montar). El cuerpo va al CodeMirror; el prefijo (H1
  // oculto) vive en un ref, se preserva entre saves y se actualiza si renombrás.
  const [initialSplit] = useState(() => splitTitle(initialContent, titleFromPath(path)));
  const prefixRef = useRef(initialSplit.prefix);
  // Identidad ESTABLE del documento para el editor. AtomicCodeMirrorEditor reconstruye el
  // EditorView cuando `documentId ?? markdownSource` cambia; sin un id estable usaría el
  // markdownSource y se reconstruía en cada save (cursor saltando, texto perdido). La
  // fijamos al montar: un rename (cambia `path`, NO remonta el componente) NO la altera;
  // abrir otro archivo sí remonta el componente (React key) y genera un id nuevo.
  // `resetSeq` es la única excepción deliberada: descartar un draft recuperado necesita
  // reconstruir el view con el contenido del server (ver discardDraft).
  const [editorDocId] = useState(() => `${repo}/${path}`);
  const [resetSeq, setResetSeq] = useState(0);

  // Key del draft persistente: (handle, repo, path). Vive en un ref porque los callbacks
  // capturados al montar (pagehide, cleanup) tienen que ver siempre la key vigente; un
  // rename cambia `path` SIN remontar → el effect re-keyea el draft vivo al path nuevo.
  const draftKeyRef = useRef(draftKeyOf(selfHandle ?? "", repo, path));
  useEffect(() => {
    const next = draftKeyOf(selfHandle ?? "", repo, path);
    if (next !== draftKeyRef.current) {
      moveDraft(draftKeyRef.current, next);
      draftKeyRef.current = next;
    }
  }, [selfHandle, repo, path]);

  // Qué muestra el editor: null = chequeo de draft en vuelo (un microtask en remounts: el
  // draftStore resuelve de memoria; IDB solo se consulta en un arranque frío). El editor
  // NO se monta hasta resolver — así un draft vivo entra como contenido inicial del view
  // y nunca "pisa" ni parpadea contra el server.
  const [view, setView] = useState<{ body: string; recovered: boolean } | null>(null);
  // Aviso suave "recuperé lo que estabas escribiendo" (no modal, descartable).
  const [recoveredNotice, setRecoveredNotice] = useState(false);

  // Título mostrado/editable (= nombre del archivo). Se sincroniza si el path cambia
  // (p.ej. después de un rename, que NO remonta el editor).
  const [titleDraft, setTitleDraft] = useState(() => titleFromPath(path));
  // Picker de emoji anclado al botón sutil a la izquierda del título. `null` = cerrado.
  const [emojiAnchor, setEmojiAnchor] = useState<{ x: number; y: number } | null>(null);
  const emojiBtnRef = useRef<HTMLButtonElement | null>(null);
  const openEmojiPicker = useCallback(() => {
    const r = emojiBtnRef.current?.getBoundingClientRect();
    // Anclamos el popup justo debajo del botón (clamp del borde derecho lo hace el popup `fixed`).
    setEmojiAnchor(r ? { x: r.left, y: r.bottom + 4 } : { x: 16, y: 80 });
  }, []);
  useEffect(() => {
    setTitleDraft(titleFromPath(path));
  }, [path]);

  const [save, setSave] = useState<SaveState>("idle");
  // Espejo de `save` accesible desde el cleanup (que no puede tener `save` en sus
  // deps sin re-correr en cada cambio). Lo usamos para no re-disparar el save al
  // desmontar si el último intento ya falló por conflict/error — re-mandar lo
  // pisaría sobre lo que vino afuera.
  const saveStateRef = useRef<SaveState>("idle");
  useEffect(() => {
    saveStateRef.current = save;
  }, [save]);
  const shaRef = useRef(initialSha);
  // Shas que ESTE editor produjo o adoptó (el de montaje, cada save 200, renames, applies
  // de cambios externos). Es la memoria para reconocer ecos: si el canal re-empuja uno de
  // estos (el feed re-emitiendo nuestro commit, o un edge stale del CDN sirviendo un save
  // nuestro viejo) lo ignoramos — ni aplicamos el contenido ni adoptamos el sha (un sha
  // viejo como baseSha = 409 fantasma). Ver decideExternal.
  const knownShas = useRef<Set<string>>(new Set(initialSha ? [initialSha] : []));
  const adoptSha = useCallback((sha: string | undefined) => {
    if (!sha) return;
    shaRef.current = sha;
    knownShas.current.add(sha);
  }, []);
  // Contenido COMPLETO (con el H1 oculto) que corresponde a `shaRef`: la BASE del merge a
  // 3 vías del rebase en 409 (Fase B). Se actualiza en cada save 200, en cada apply/adopt
  // de cambio externo y al resolver un conflicto. Nota: si la rehidratación adopta el
  // baseSha de un draft viejo, la base queda en `initialContent` (lo del server al abrir)
  // — aproximación correcta para el caso típico (el server avanzó: base == theirs → el
  // merge devuelve lo mío) y conservadora en el resto (peor caso: conflicto de más).
  const baseContentRef = useRef(initialContent);
  const contentRef = useRef(initialSplit.body); // último cuerpo (sin prefijo), para el flush al desmontar
  const timer = useRef<ReturnType<typeof setTimeout>>(null);
  const dirty = useRef(false);
  const savingRef = useRef(false); // un save en vuelo → no lanzar otro en paralelo (evita carrera de sha)
  // Intentos consecutivos de save que fallaron por algo TRANSITORIO (red / 5xx / read-after-write
  // del CDN de GitHub): tope de reintentos antes de caer a estado error. Se resetea en cada save
  // 200 / GET fresco (divergencia real). Ver saveRetry.ts / scheduleSaveRetry.
  const saveRetryRef = useRef(0);
  // Conflicto REAL (solapamiento de líneas detectado por el merge del rebase): alimenta
  // el panel con opciones. `theirs` = el contenido del server al momento del 409.
  const [conflict, setConflict] = useState<{ theirs: string; theirsSha: string } | null>(null);
  // Diff mío↔de-ellos ya colapsado, calculado al apretar "ver diferencias" (null = oculto).
  const [conflictDiff, setConflictDiff] = useState<DiffView | null>(null);
  // Cambio externo DIFERIDO (buffer dirty cuando llegó): alimenta el banner no-modal.
  const [pendingExternal, setPendingExternal] = useState<{ content: string; sha?: string } | null>(null);
  // true mientras un apply externo despacha su transacción: el onChange que dispara ese
  // dispatch NO es tipeo del usuario (no marca dirty, no agenda autosave, no toca el draft).
  const applyingExternalRef = useRef(false);
  // Tap al EditorView del atomic (su handle no lo expone): para despachar la transacción
  // del cambio externo. Mismo patrón que blameController.
  const [viewTap] = useState(() => editorViewTap());

  // REHIDRATACIÓN al montar: rehidratamos el draft en silencio SOLO si es trabajo tuyo sin
  // guardar que continúa la versión que el server tiene AHORA (`shouldRestoreDraft`: vivo +
  // `baseSha === initialSha`). En ese caso el editor abre con el draft, adopta su baseSha (== el
  // de montaje, así la base del merge queda correcta) y lo confirma el autosave — sin cartel.
  //
  // Si el draft quedó VIEJO (su baseSha ≠ el sha de montaje: el server avanzó por una edición
  // externa — otra pestaña, o un editor local que sincroniza por git — que ya está commiteada),
  // NO lo rehidratamos: taparía el contenido nuevo del server y, marcado dirty, lo mandaría a
  // pisar por el autosave (el síntoma que reportó el owner: "hago refresh y no llegan los cambios"
  // + el cartel azul de "traer cambios" forzado por ese dirty fantasma). Mostramos lo del server
  // y descartamos el draft viejo. Un draft cuyo contenido == initialContent (residuo de un save)
  // tampoco se rehidrata. El orden lo garantiza el draftStore: el saveDraft de onChange es síncrono
  // en memoria, así que el remount (cleanup viejo → mount nuevo, mismo hilo) ve la última tecla.
  // biome-ignore lint/correctness/useExhaustiveDependencies: corre SOLO al montar — initialContent/initialSha/path se capturan una vez, igual que initialSplit (el remount por key trae los frescos).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const d = await loadDraft(draftKeyRef.current);
      if (cancelled) return;
      if (shouldRestoreDraft(d, initialContent, initialSha)) {
        const split = splitTitle(d.content, titleFromPath(path));
        prefixRef.current = split.prefix;
        contentRef.current = split.body;
        if (d.baseSha) adoptSha(d.baseSha);
        dirty.current = true; // contenido sin confirmar: el flush de desmontaje intenta guardarlo
        setView({ body: split.body, recovered: true });
      } else {
        // Sin draft, residuo de un save, o draft VIEJO respecto de un server que avanzó afuera:
        // en los tres casos abrimos con lo del server y descartamos el draft (si había).
        if (d) void clearDraft(draftKeyRef.current);
        setView({ body: initialSplit.body, recovered: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Descartar el draft recuperado: volver a la versión del server (la capturada al montar)
  // y reconstruir el view (resetSeq cambia el documentId → AtomicCodeMirrorEditor rearma).
  const discardDraft = useCallback(() => {
    void clearDraft(draftKeyRef.current);
    if (timer.current) clearTimeout(timer.current);
    prefixRef.current = initialSplit.prefix;
    contentRef.current = initialSplit.body;
    shaRef.current = initialSha;
    adoptSha(initialSha);
    baseContentRef.current = initialSplit.prefix + initialSplit.body; // == initialContent del montaje
    dirty.current = false;
    setSave("idle");
    setConflict(null);
    setConflictDiff(null);
    setRecoveredNotice(false);
    setResetSeq((s) => s + 1);
    setView({ body: initialSplit.body, recovered: false });
  }, [initialSplit, initialSha, adoptSha]);

  // Cinturón extra para cierre de pestaña / app al background (mobile/Safari): si hay
  // tipeo sin confirmar, flusheá el draft a IDB YA. `pagehide` + visibilitychange→hidden
  // son más confiables que beforeunload. El draft en memoria ya está al día (onChange es
  // síncrono); esto solo adelanta el write throttled pendiente (≤400ms de ventana).
  useEffect(() => {
    const flush = () => {
      if (dirty.current) void flushDraft(draftKeyRef.current);
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // Reemplaza el contenido del buffer SIN remontar: el diff entre el doc actual y el nuevo
  // entra como UNA transacción CM6 (cursor/selección/folds se remapean solos; el scroll no
  // se toca — mecanismo de la Fase C). Deja prefixRef/contentRef consistentes. Es la pieza
  // compartida entre "aplicar cambio externo" (applyIncoming) y "aplicar el resultado del
  // merge del rebase en 409" — NO toca dirty/sha/draft: eso lo decide cada caller.
  const applyBuffer = useCallback(
    (fullContent: string) => {
      const split = splitTitle(fullContent, titleFromPath(path));
      const v = viewTap.get();
      if (v) {
        applyingExternalRef.current = true;
        try {
          applyExternalToView(v, split.body);
        } finally {
          applyingExternalRef.current = false;
        }
      } else {
        // Sin vista montada (carrera rara con el mount lazy): reconstrucción dura del view
        // con el contenido nuevo — el camino degradado, no el normal.
        setResetSeq((s) => s + 1);
        setView({ body: split.body, recovered: false });
      }
      prefixRef.current = split.prefix;
      contentRef.current = split.body;
      return split;
    },
    [path, viewTap],
  );

  // Aplica un cambio externo: buffer == server → baseSha fresco, sin dirty, sin draft que
  // proteger. También es el destino del botón "traer lo nuevo" del banner (ahí sí descarta
  // lo local, con confirmación previa en applyPending).
  const applyIncoming = useCallback(
    (incoming: { content: string; sha?: string }) => {
      applyBuffer(incoming.content);
      adoptSha(incoming.sha);
      baseContentRef.current = incoming.content;
      dirty.current = false;
      if (timer.current) clearTimeout(timer.current);
      setSave("idle"); // si había conflicto, el baseSha fresco lo destraba
      setConflict(null);
      setConflictDiff(null);
      setPendingExternal(null);
      setRecoveredNotice(false);
      void clearDraft(draftKeyRef.current); // buffer == server → nada que proteger
    },
    [applyBuffer, adoptSha],
  );

  // Guarda el ARCHIVO completo: prefijo (H1 oculto) + cuerpo. `body` es lo que tipeás.
  // Ante un 409, rebase transparente (Fase B): GET de lo del server → merge a 3 vías →
  // re-PUT silencioso si no hay solapamiento, panel con opciones si lo hay.
  const doSave = useCallback(
    async (body: string) => {
      if (!shaRef.current) return; // sin baseSha no podemos escribir optimista
      // ⚠️ Caso 4: si este archivo está bajo un move/rename EN VUELO, NO lo persistimos: la op es
      // la dueña de su ciclo de vida (lee el blob del origen para escribirlo en el destino). Un PUT
      // concurrente cambiaría ese blob entre el read del cliente y el del server → 409 "conflict" y
      // el move se revierte. Dejamos `dirty`/draft intactos: el contenido sobrevive en el draft
      // (keyed por repo+path, que el rename re-keyea al path nuevo) y se re-guarda al re-abrir.
      if (isPathUnderFsOpRef.current?.(repo, path)) return;
      if (savingRef.current) {
        // ya hay un save en vuelo: reintento en breve (con el sha ya actualizado) en vez
        // de mandar otro PUT con el sha viejo → eso causaba 409 espurios.
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void doSave(body), 700);
        return;
      }

      // Rebase ante 409. Corre DENTRO del ciclo del save (savingRef sigue true): el GET es
      // async, pero del merge al dispatch no hay awaits — el buffer que se mergea es el
      // vigente al aplicar (ninguna tecla se cuela en el medio). El re-PUT va por timer
      // (tarea aparte, después de que `finally` libere savingRef) con contentRef.current:
      // si tipeaste durante el rebase, ese tipeo viaja en el re-PUT.
      // Reintento ante fallo TRANSITORIO (red / 5xx / read-after-write): reprograma el save con
      // backoff en vez de alarmar con "no se pudo guardar". El texto está a salvo (draft + buffer);
      // sólo tras agotar el presupuesto caemos a estado error. Se resetea el contador en cada save
      // 200 / GET fresco. NO se usa para el conflicto REAL (ese va al panel).
      const scheduleSaveRetry = (): void => {
        saveRetryRef.current++;
        const plan = saveRetryPlan(
          saveRetryRef.current,
          SAVE_RETRY_MAX,
          SAVE_RETRY_BASE_MS,
          SAVE_RETRY_CAP_MS,
        );
        if (!plan.retry) {
          setSave("error");
          return;
        }
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void doSave(contentRef.current), plan.delayMs);
      };

      const rebaseOn409 = async (): Promise<void> => {
        let theirs: { content: string; sha: string } | null = null;
        try {
          const rr = await fetch(
            `/api/file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`,
          );
          if (rr.ok) {
            const f = (await rr.json()) as { content?: string; sha?: string };
            if (f.sha) theirs = { content: f.content ?? "", sha: f.sha };
          }
        } catch {
          /* red caída → error abajo; el draft protege el texto */
        }
        if (!theirs) {
          // El GET post-409 falló (red/5xx): transitorio → reintentar con backoff, sin alarmar.
          scheduleSaveRetry();
          return;
        }
        if (theirs.sha === shaRef.current || knownShas.current.has(theirs.sha)) {
          // El PUT dijo "hay algo más nuevo" pero el GET devolvió un blob NUESTRO (edge stale del
          // CDN de GitHub, read-after-write). Reintentar el save entero con backoff; tras agotar
          // el presupuesto, estado error (la próxima tecla lo vuelve a intentar).
          scheduleSaveRetry();
          return;
        }
        saveRetryRef.current = 0; // llegó una versión de AFUERA (divergencia real): no es transitorio
        // ── Sección síncrona: medir, mergear y aplicar en la MISMA tarea ──
        // Normalizamos el `\n` terminal igual que en el PUT: base y theirs ya vienen newline-
        // terminados (es lo que el server guarda), así que "mine" tiene que estarlo también o
        // merge3 vería un cambio espurio en la última línea (ver noteContent.ts).
        const mineFull = withTrailingNewline(prefixRef.current + contentRef.current);
        const res = merge3(baseContentRef.current, mineFull, theirs.content);
        if (!res.ok) {
          // Solapamiento REAL: ambos tocamos las mismas líneas. Panel con opciones; el
          // texto del usuario queda intacto en el buffer (y respaldado en el draft).
          setConflict({ theirs: theirs.content, theirsSha: theirs.sha });
          setConflictDiff(null);
          setSave("conflict");
          return;
        }
        if (res.merged === theirs.content) {
          // Lo mío ya estaba incorporado afuera (o se anuló): buffer == server, nada que
          // re-guardar. applyIncoming deja todo consistente (sha, base, draft, banners).
          applyIncoming({ content: theirs.content, sha: theirs.sha });
          return;
        }
        // Merge limpio con material mío: entra como transacción CM6 (cursor intacto),
        // base/sha avanzan a lo del server y el re-PUT sale ya, con el sha fresco.
        applyBuffer(res.merged);
        adoptSha(theirs.sha);
        baseContentRef.current = theirs.content;
        setConflict(null);
        setConflictDiff(null);
        // El banner de cambio diferido (si estaba) quedó saldado si era ESTE contenido.
        setPendingExternal((p) => (p && (p.sha === theirs.sha || p.content === theirs.content) ? null : p));
        dirty.current = true;
        saveDraft(draftKeyRef.current, { content: res.merged, baseSha: theirs.sha });
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void doSave(contentRef.current), 0);
      };

      savingRef.current = true;
      setSave("saving");
      // `\n` terminal: la nota se commitea newline-terminada para que un append posterior de OTRO
      // usuario no reescriba los bytes de la última línea y el blame no le robe la autoría (ver
      // noteContent.ts). Normalizamos el contenido COMPLETO una vez y lo usamos como base del merge
      // a 3 vías: la base tiene que ser idéntica byte-a-byte a lo que quedó en el server.
      const full = withTrailingNewline(prefixRef.current + body);
      try {
        const r = await fetch("/api/file", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repo, path, content: full, baseSha: shaRef.current }),
        });
        if (r.status === 409) {
          await rebaseOn409(); // el sha ya no sirve: mergear contra lo de afuera y re-guardar
          return;
        }
        if (!r.ok) {
          // 5xx / error no-409 del server (ej. hiccup de la GitHub API, 429): transitorio →
          // reintentar con backoff en vez de saltar directo a "no se pudo guardar".
          scheduleSaveRetry();
          return;
        }
        const { sha } = (await r.json()) as { sha: string };
        adoptSha(sha); // el próximo autosave parte de este sha; y si el feed nos lo re-emite, es un eco
        baseContentRef.current = full; // lo guardado es la nueva base del merge a 3 vías
        saveRetryRef.current = 0; // save OK → reseteamos el contador de reintentos transitorios
        dirty.current = false;
        setSave("saved");
        setConflict(null); // un save que entró == no hay conflicto pendiente
        setConflictDiff(null);
        onSaved?.(full, sha, repo, path); // sync con el state global (con la identidad de ESTA nota)
        // Save confirmado → el draft ya no protege nada... SALVO que hayas seguido tipeando
        // durante el PUT: ahí el draft (más nuevo que `full`) se queda. Comparación síncrona
        // contra la memoria del store → sin carrera.
        void clearDraftIfUnchanged(draftKeyRef.current, full);
        setRecoveredNotice(false); // lo recuperado quedó guardado → el aviso ya no aplica
      } catch {
        // Red caída / fetch abortado: transitorio → reintentar con backoff (el draft protege).
        scheduleSaveRetry();
      } finally {
        savingRef.current = false;
      }
    },
    [repo, path, onSaved, adoptSha, applyBuffer, applyIncoming],
  );

  // "Traer lo nuevo" del banner: con tipeo sin guardar pide confirmación (lo local se
  // descarta — si querés el merge fino, dejá que el autosave caiga en el 409 y rebasee);
  // limpio aplica directo.
  const applyPending = useCallback(() => {
    const p = pendingExternal;
    if (!p) return;
    if (
      dirty.current &&
      !window.confirm(
        "Traer la versión nueva reemplaza lo que escribiste acá y no llegó a guardarse. ¿Continuar?",
      )
    ) {
      return;
    }
    applyIncoming(p);
  }, [pendingExternal, applyIncoming]);

  // Resolución del conflicto REAL (los botones del panel). En ambos casos los cambios NO
  // conflictivos de los dos lados se conservan (merge3 con `resolve`): solo las líneas
  // pisadas se deciden. El resultado entra como transacción (cursor intacto) y se guarda
  // con el sha fresco — nunca "copiá a mano y recargá".
  const resolveConflict = useCallback(
    (winner: "mine" | "theirs") => {
      const c = conflict;
      if (!c) return;
      if (
        winner === "theirs" &&
        !window.confirm(
          "En las líneas en conflicto gana la versión de afuera (lo tuyo se reemplaza ahí; el resto de tus cambios se conserva). ¿Continuar?",
        )
      ) {
        return;
      }
      const mineFull = withTrailingNewline(prefixRef.current + contentRef.current);
      const res = merge3(baseContentRef.current, mineFull, c.theirs, winner);
      const merged = res.ok ? res.merged : winner === "mine" ? mineFull : c.theirs; // con resolve siempre ok
      if (merged === c.theirs) {
        applyIncoming({ content: c.theirs, sha: c.theirsSha });
        return;
      }
      applyBuffer(merged);
      adoptSha(c.theirsSha);
      baseContentRef.current = c.theirs;
      setConflict(null);
      setConflictDiff(null);
      dirty.current = true;
      saveDraft(draftKeyRef.current, { content: merged, baseSha: c.theirsSha });
      setSave("idle");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void doSave(contentRef.current), 0);
    },
    [conflict, applyBuffer, applyIncoming, adoptSha, doSave],
  );

  // "Ver diferencias" del panel de conflicto: diff por líneas mío↔de-ellos, calculado al
  // apretar (no en cada render) y colapsando las corridas largas de líneas iguales.
  const toggleConflictDiff = useCallback(() => {
    setConflictDiff((d) => {
      if (d) return null;
      if (!conflict) return null;
      return collapseDiff(diffLines(prefixRef.current + contentRef.current, conflict.theirs));
    });
  }, [conflict]);

  // Reacción a cambios de `initialContent`/`initialSha` DESPUÉS del montaje (Fase C): el
  // canal hace setDoc (refetch del feed, revalidación SWR, rename/move) y la prop nueva
  // llega acá — el componente ya NO se remonta por refresh (el key de App es solo doc.id).
  // decideExternal (pura, testeada) elige: ignorar ecos propios, adoptar el sha cuando el
  // contenido no es novedad, aplicar como transacción (limpio) o diferir al banner (dirty).
  const prevIncomingRef = useRef({ content: initialContent, sha: initialSha });
  useEffect(() => {
    const prev = prevIncomingRef.current;
    if (initialContent === prev.content && initialSha === prev.sha) return;
    // El chequeo de draft del montaje sigue en vuelo (view null): no consumimos el cambio
    // — `view` está en deps, así que al resolver el mount este effect re-corre y lo procesa
    // contra el buffer ya hidratado (draft incluido).
    if (!view) return;
    prevIncomingRef.current = { content: initialContent, sha: initialSha };
    const decision = decideExternal({
      incomingContent: initialContent,
      incomingSha: initialSha,
      prevIncomingContent: prev.content,
      bufferContent: prefixRef.current + contentRef.current,
      dirty: dirty.current,
      knownShas: knownShas.current,
    });
    if (decision === "ignore") return;
    if (decision === "adopt") {
      adoptSha(initialSha);
      baseContentRef.current = initialContent; // el contenido que corresponde al sha adoptado
      if (dirty.current && initialContent === prefixRef.current + contentRef.current) {
        // El buffer ya ES el contenido del server → no queda nada por guardar.
        dirty.current = false;
        if (timer.current) clearTimeout(timer.current);
        setSave("idle");
        void clearDraftIfUnchanged(draftKeyRef.current, initialContent);
      }
      setPendingExternal(null);
      return;
    }
    if (decision === "apply") {
      applyIncoming({ content: initialContent, sha: initialSha });
      return;
    }
    // defer: NO tocamos el texto del usuario NI adoptamos el sha. El autosave seguirá
    // contra el baseSha viejo y caerá en el 409, cuyo rebase (Fase B) mergea esto solo
    // en el caso común — el banner es la vía manual mientras tanto.
    setPendingExternal({ content: initialContent, sha: initialSha });
  }, [initialContent, initialSha, view, adoptSha, applyIncoming]);

  // Click en un link renderizado (live preview). Externo → otra pestaña del browser; interno
  // → abre esa nota de la misma wiki, reemplazando la actual (ceibo no tiene tabs todavía).
  const onLinkClick = useCallback(
    (url: string) => {
      const kind = classifyLink(url);
      if (kind === "blocked") {
        // Esquema NO permitido (javascript:/data:/…). No ejecutamos NI abrimos NI resolvemos como
        // path interno: si cayera en resolveInternalPath abriría un "tab fantasma". No-op + aviso.
        console.warn(`[ceibo] link con esquema no permitido, ignorado: ${url}`);
        return;
      }
      if (kind === "external") {
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      const target = resolveInternalPath(path, url);
      if (target) onOpen?.(repo, target);
    },
    [repo, path, onOpen],
  );
  // Ref vivo al handler para la extensión de click (que se arma UNA vez al montar): así el
  // click sobre el link usa siempre la versión actual sin recapturar/remontar el editor.
  const onLinkClickRef = useRef(onLinkClick);
  useEffect(() => {
    onLinkClickRef.current = onLinkClick;
  }, [onLinkClick]);
  // Ref vivo al predicado "¿este archivo está bajo una op de FS en vuelo?": lo consulta doSave
  // (incl. el flush-on-unmount, que se arma al montar) para no persistir un archivo que un
  // move/rename está moviendo — sin esto el PUT cambia el blob que el move lee → 409 (caso 4).
  const isPathUnderFsOpRef = useRef(isPathUnderFsOp);
  useEffect(() => {
    isPathUnderFsOpRef.current = isPathUnderFsOp;
  }, [isPathUnderFsOp]);
  // Blame por línea: el controller acopla la extensión (capturada al montar, como las demás)
  // con el setter que inyecta los datos cuando llegan del server (el wrapper de atomic no
  // expone el EditorView). Una instancia por editor montado.
  const [blameCtl] = useState(() => blameController());
  // Extensiones del editor armadas UNA vez (el atomic las captura al montar). Sumamos
  // `linkClick` para que TODO el link sea clickeable (no solo el iconito ↗ del atomic).
  const [editorExtensions] = useState(() => [
    ...EDITOR_EXTENSIONS,
    linkClick(() => onLinkClickRef.current),
    blameCtl.extension,
    viewTap.extension,
  ]);

  // Fetch del blame al activar el toggle (y limpieza al apagarlo / cambiar de nota). El
  // offset descuenta las líneas del prefijo oculto (H1 redundante): el server blamea el
  // ARCHIVO completo, el editor muestra solo el cuerpo. Si el fetch falla (403 carrera de
  // "dejó de ser compartida", red), simplemente no se pinta nada.
  useEffect(() => {
    if (!blameOn) {
      blameCtl.set(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(
          `/api/file/blame?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`,
        );
        if (!r.ok) throw new Error(`blame ${r.status}`);
        const j = (await r.json()) as { shared?: boolean; ranges?: BlameRangeWire[] };
        if (cancelled) return;
        const offset = (prefixRef.current.match(/\n/g) ?? []).length;
        // `shared` default true (server viejo sin el campo): el modo compartido es el
        // conservador — nunca pinta "ceibo (IA)" de más.
        blameCtl.set({ ranges: j.ranges ?? [], offset, shared: j.shared ?? true, selfHandle });
      } catch {
        if (!cancelled) blameCtl.set(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blameOn, repo, path, blameCtl, selfHandle]);

  const onChange = useCallback(
    (value: string) => {
      if (applyingExternalRef.current) {
        // Eco del dispatch de un cambio externo (applyIncoming): no es tipeo del usuario.
        // applyIncoming deja contentRef/dirty/draft consistentes; acá no agendamos nada.
        contentRef.current = value;
        return;
      }
      contentRef.current = value;
      dirty.current = true;
      // Espejo al draft ANTES de agendar nada: la escritura en memoria es síncrona, así
      // cualquier remount/refetch que dispare después de esta tecla ya la encuentra. Va el
      // archivo COMPLETO (prefijo + cuerpo) para comparar 1:1 contra el server al rehidratar.
      saveDraft(draftKeyRef.current, {
        content: prefixRef.current + value,
        baseSha: shaRef.current,
      });
      setSave("idle");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void doSave(value), DEBOUNCE_MS);
    },
    [doSave],
  );

  // Commit del título: renombra el archivo. El rename reescribe el H1 oculto al título nuevo
  // ATÓMICAMENTE (lo hace renameDoc pasándole el contenido vivo como `fullContent`): el move
  // commitea el archivo en el path nuevo CON el H1 ya corregido. El editor NO hace un re-save del
  // H1 posterior — ese re-save tardío corría fuera de la ventana del guard y, si cambiabas de
  // solapa mid-op, recreaba el archivo viejo y duplicaba el H1 (caso 6 / QA 2026-06-11).
  const commitTitle = useCallback(async () => {
    const curBase = titleFromPath(path);
    const cleanBase = sanitizeFilename(titleDraft);
    if (!cleanBase || cleanBase === curBase) {
      setTitleDraft(curBase); // vacío o sin cambios → revertir a lo actual
      return;
    }
    if (!onRename) return;
    // El título crudo (con mayúsculas/tildes/espacios) va al H1; el filename lo sanea renameDoc.
    const titleRaw = titleDraft.replace(/\.md$/i, "").trim();
    // Contenido vivo del editor (prefijo H1 oculto + cuerpo) ANTES del rename: es la fuente de
    // verdad. renameDoc le reescribe el H1 y lo persiste en el destino en un solo commit.
    const liveFull = prefixRef.current + contentRef.current;
    try {
      const newSha = await onRename(titleDraft, liveFull);
      // El rename persistió el contenido con el H1 ya corregido. Sincronizamos el estado en memoria
      // del editor (que sigue montado, mismo doc.id) con lo que quedó en el server, SIN emitir otra
      // escritura: nuevo H1 en el prefijo, nueva base/sha = lo recién guardado, y dirty=false → el
      // flush-on-unmount no re-PUTea (ni el path viejo ni el nuevo). Si renameDoc no devolvió sha
      // (caso "sin cambio"), no tocamos nada.
      if (newSha) {
        // Lo que el move dejó persistido = el H1 reescrito sobre el contenido que mandamos (liveFull),
        // con el cuerpo de ENTONCES. Reflejamos eso como la nueva base/sha del merge.
        const persisted = replaceOrInsertH1(liveFull, titleRaw);
        if (prefixRef.current) {
          prefixRef.current = replaceOrInsertH1(prefixRef.current, titleRaw);
        }
        adoptSha(newSha);
        baseContentRef.current = persisted;
        // Cancelamos cualquier autosave agendado por un onChange durante el await: dispararía un doSave
        // contra el path VIEJO (el prop `path` todavía no se actualizó) → recrearía el archivo viejo.
        if (timer.current) clearTimeout(timer.current);
        // ⚠️ dirty SIEMPRE a false: el flush-on-unmount NO debe disparar un doSave acá. Tras el rename
        // el prop `path` del editor sigue siendo el VIEJO hasta el próximo render (el move ya cerró su
        // ventana de guard), así que un doSave del flush escribiría al path VIEJO y lo recrearía — el
        // bug exacto del caso 6. El contenido NO se pierde: lo persistido ya tiene el cuerpo de entonces,
        // y si el usuario siguió tipeando el cuerpo DURANTE el await, el draft (re-keyeado al path nuevo
        // por el effect de draftKey) conserva ese tipeo y lo rehidrata al reabrir.
        dirty.current = false;
        setSave("saved");
        const liveNow = prefixRef.current + contentRef.current;
        if (liveNow === persisted) {
          // Nada cambió durante el rename → el draft ya no protege nada, se limpia.
          void clearDraftIfUnchanged(draftKeyRef.current, persisted);
        } else {
          // Hubo tipeo de cuerpo durante el rename: dejamos el draft (con baseSha nuevo) como red de
          // seguridad; al reabrir la nota en el path nuevo se rehidrata ese contenido.
          saveDraft(draftKeyRef.current, { content: liveNow, baseSha: newSha });
        }
      }
    } catch (e) {
      setTitleDraft(curBase); // revertir el input si el rename falló
      alert(`No pude renombrar: ${(e as Error)?.message ?? e}`);
    }
  }, [titleDraft, path, onRename, adoptSha]);

  // Flush SOLO al desmontar (cerrar/cambiar de archivo, o refresh externo via key change)
  // si quedó algo sin guardar. `initialContent` NO va en las deps: si entrara, el cleanup
  // correría en cada tecla → un save inmediato por keystroke, que se pisaban → 409 espurios.
  // Tampoco re-disparamos si el último save quedó en conflict/error: el sha ya no sirve
  // (lo pisaríamos por encima de lo que vino afuera); el draft conserva el texto y al
  // reabrir la nota se rehidrata (Fase A) — el conflicto se resuelve ahí.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      // Primero el draft (la red de seguridad): empuja a IDB el estado actual sin esperar
      // el throttle. En conflict/error es la ÚNICA copia de lo tipeado que sobrevive.
      void flushDraft(draftKeyRef.current);
      const last = saveStateRef.current;
      if (dirty.current && last !== "conflict" && last !== "error") {
        void doSave(contentRef.current);
      }
    };
  }, [doSave]);

  return (
    // `editor-blame` abre el gutter izquierdo (padding del .cm-content) donde viven la
    // franja de color y el avatar por tramo — solo mientras el blame está prendido.
    <div className={`editor${blameOn ? " editor-blame" : ""}`}>
      {/* Conflicto REAL (Fase B): el rebase del 409 encontró solapamiento de líneas. Panel
          CON OPCIONES — ambas conservan los cambios no conflictivos de los dos lados; solo
          las líneas pisadas se deciden. El texto del usuario sigue en el buffer (y en el
          draft) hasta que él elija. Nunca "copiá a mano y recargá". */}
      {conflict && (
        <div className="editor-conflict" role="alert">
          <span>Conflicto: vos y alguien más (el agente u otra pestaña) editaron las mismas líneas.</span>
          <span className="editor-conflict-actions">
            <button type="button" onClick={() => resolveConflict("mine")}>
              Conservar lo mío
            </button>
            <button type="button" onClick={() => resolveConflict("theirs")}>
              Traer lo de afuera
            </button>
            <button type="button" onClick={toggleConflictDiff}>
              {conflictDiff ? "Ocultar diferencias" : "Ver diferencias"}
            </button>
          </span>
          {conflictDiff && (
            <pre className="editor-conflict-diff">
              {conflictDiff.map((l, i) =>
                l.t === "skip" ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: lista derivada inmutable, solo render
                  <div key={i} className="diff-skip">
                    ⋯ {l.count} líneas iguales
                  </div>
                ) : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: lista derivada inmutable, solo render
                  <div key={i} className={`diff-${l.t}`}>
                    {l.t === "mine" ? "− " : l.t === "theirs" ? "+ " : "  "}
                    {l.line}
                  </div>
                ),
              )}
            </pre>
          )}
        </div>
      )}
      {/* Cambio externo DIFERIDO (llegó con tipeo sin guardar): banner no-modal. El texto
          del usuario NO se toca; aplicar pide confirmación (descarta lo local) y postergar
          lo deja seguir — si llega una versión más nueva, el banner se re-arma solo. */}
      {pendingExternal && (
        <div className="editor-external" role="status">
          <span>Hay una versión más nueva de esta nota (cambió afuera).</span>
          <span className="editor-external-actions">
            <button type="button" onClick={applyPending}>
              Traer lo nuevo
            </button>
            <button type="button" onClick={() => setPendingExternal(null)}>
              Ahora no
            </button>
          </span>
        </div>
      )}
      {/* Banner de recuperación: hoy INACTIVO a propósito. La rehidratación del draft es
          SILENCIOSA (ver el efecto de montaje): `recoveredNotice` ya no se setea en true, así
          que este bloque no se renderiza. Se deja el markup (y `discardDraft`) por si alguna vez
          se quiere reintroducir un aviso acotado a divergencia real cross-dispositivo. */}
      {recoveredNotice && (
        <div className="editor-recovered" role="status">
          <span>Recuperé lo que estabas escribiendo (no llegó a guardarse).</span>
          <span className="editor-recovered-actions">
            <button type="button" onClick={() => setRecoveredNotice(false)}>
              Seguir con esto
            </button>
            <button type="button" onClick={discardDraft}>
              Descartar y volver a lo guardado
            </button>
          </span>
        </div>
      )}
      {/* Sub-header del contenido: una fila ANTES del título, dentro del margen de la página y
          right-aligned, donde viven las acciones a nivel-nota. Hoy: el botón de blame ("quién
          escribió qué") — sólo en wikis con autoría que mostrar Y con la preferencia global de
          autoría PRENDIDA (Configuración → Ediciones). Con la autoría apagada no aparece ningún
          botón en la nota: la vista de blame se controla desde Configuración. Prende/apaga la
          vista de blame (preferencia global, ver App). */}
      {blameAvailable && blameOn && onToggleBlame && (
        <div className="editor-subheader">
          <button
            type="button"
            className={`editor-blame-btn${blameOn ? " is-on" : ""}`}
            onClick={onToggleBlame}
            aria-pressed={blameOn ? true : false}
            aria-label={blameOn ? "Ocultar quién escribió cada línea" : "Ver quién escribió cada línea"}
            data-tip={blameOn ? "Ocultar autoría" : "Quién escribió qué"}
          >
            <IconUsers size={16} />
            <span>Autoría</span>
          </button>
        </div>
      )}
      {/* Título = nombre del archivo, editable. Enter o salir del foco confirma → rename.
          El emoji (estilo Notion) se elige desde un botón SUTIL (una hendidura, casi
          imperceptible) a la izquierda del título; con emoji puesto, muestra el emoji. */}
      <div className="editor-title-row">
        {onSetEmoji && (
          <button
            ref={emojiBtnRef}
            type="button"
            className={`editor-title-emoji-btn${emoji ? " has-emoji" : ""}`}
            onClick={openEmojiPicker}
            aria-label={emoji ? "Cambiar emoji de la nota" : "Agregar emoji a la nota"}
            title={emoji ? "Cambiar emoji" : "Agregar emoji"}
          >
            {emoji ? (
              <span aria-hidden="true">{emoji}</span>
            ) : (
              // Hendidura: una ranura mínima, casi imperceptible, que se revela en hover.
              <span className="editor-title-emoji-slot" aria-hidden="true" />
            )}
          </button>
        )}
        <input
          className="editor-title"
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              setTitleDraft(titleFromPath(path));
              (e.target as HTMLInputElement).blur();
            }
          }}
          onBlur={() => void commitTitle()}
          aria-label="Título de la nota (nombre del archivo)"
          spellCheck={false}
        />
      </div>
      {emojiAnchor && onSetEmoji && (
        <EmojiPicker
          x={emojiAnchor.x}
          y={emojiAnchor.y}
          current={emoji ?? ""}
          onPick={(e) => {
            onSetEmoji(e);
            setEmojiAnchor(null);
          }}
          onClose={() => setEmojiAnchor(null)}
        />
      )}
      {/* El editor recién monta cuando el chequeo de draft resolvió (`view`): así un draft
          vivo entra como contenido inicial y nunca compite con el server en pantalla. El
          documentId suma resetSeq: descartar el draft reconstruye el view con lo guardado. */}
      {view && (
        <AtomicCodeMirrorEditor
          documentId={`${editorDocId}#r${resetSeq}`}
          markdownSource={view.body}
          onMarkdownChange={onChange}
          onLinkClick={onLinkClick}
          extensions={editorExtensions}
        />
      )}
      <span className="editor-status" data-state={save}>
        {SAVE_LABEL[save]}
      </span>
    </div>
  );
}
