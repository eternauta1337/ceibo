// managed-ui — el círculo push-to-talk + el chat popup + la vista de archivo. Le hablás
// al círculo (hold-para-hablar) o abrís el chat (botón abajo-derecha) para conversar por
// texto/voz con historial; el agente responde voz o texto (espejo: como le hablaste te
// responde, salvo que decida otra cosa). Los archivos (creados/abiertos por el agente o
// por el explorador) aparecen en la vista. La vista es SIEMPRE editable inline (live
// preview estilo Obsidian); no hay modo ver vs editar.

import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  lazy,
  type PointerEvent,
  type MouseEvent as ReactMouseEvent,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { chatLinkRender } from "./chatLink.ts";
import { noteUrl, systemUrl } from "./deepLink.ts";
import { apiSetEmoji } from "./EmojiPicker.tsx";
import { Explorer, type SidebarPanel } from "./Explorer.tsx";
import {
  IconArchive,
  IconArrowLeft,
  IconArrowRight,
  IconArrowUp,
  IconBookOpen,
  IconCheck,
  IconClock,
  IconLanguages,
  IconMaximize,
  IconMessage,
  IconMic,
  IconMinimize,
  IconOrb,
  IconPalette,
  IconPanelLeft,
  IconPause,
  IconPlay,
  IconPlug,
  IconPlus,
  IconSettings,
  IconUser,
  IconX,
} from "./icons.tsx";
import { OrbCanvas, type OrbHandle, orbWebGLSupported } from "./OrbCanvas.tsx";
import { OrbHint } from "./OrbHint.tsx";
import { computeOrbHint, subagentCountHint } from "./orbHint.ts";
import { scrollKey } from "./scrollKey.ts";
import { getSystemPageMeta, type SystemPage } from "./systemPages.ts";
import { disambiguateTabTitles } from "./tabTitles.ts";
import { flushScrollCache, readScrollCache, saveScrollDebounced, scrollCacheKey } from "./uiStateCache.ts";
import {
  type ActivityEntry,
  type ChatAttachment,
  type ChatMessage,
  DEBUG_LOG,
  dbg,
  type ModelCfg,
  type OpenDoc,
  type OutboundMedia,
  type Status,
  type TabInfo,
  useChannel,
  type VoiceCfg,
} from "./useChannel.ts";
import { useVersionInfo } from "./useVersionInfo.ts";
import { VersionBadge } from "./VersionBadge.tsx";
import { versionBadge, versionLine } from "./version.ts";
import { fmtVoiceTime, type VoicePlayback } from "./voicePlayback.ts";

// Pinta una foto en `#app-bg-img` con el mismo modelo blur-up que el script inline de
// index.html: setea --orb-bg y togglea data-ph (placeholder borroso) / data-ready. Mantener
// ambos en sync — son la misma capa.
function paintBg(url: string, blurred: boolean): void {
  document.documentElement.style.setProperty("--orb-bg", `url(${url})`);
  const el = document.getElementById("app-bg-img");
  if (!el) return;
  if (blurred) el.setAttribute("data-ph", "");
  else el.removeAttribute("data-ph");
  el.setAttribute("data-ready", "");
}

// Re-aplica el fondo desde /api/bg sin recargar la página. Cache-bust con ?t= para que
// el browser no sirva la respuesta anterior (el server keyea por pool; pool nuevo = imagen nueva).
// Mismo blur-up que el boot: placeholder borroso al instante, full-res nítida al decodear.
// Si falla o no trae URL, deja el fondo actual sin tocarlo (no pantalla en blanco).
async function refreshBg(): Promise<void> {
  try {
    const r = await fetch(`/api/bg?t=${Date.now()}`);
    if (!r.ok) return;
    const d = (await r.json()) as {
      url?: string;
      placeholder?: string;
      author?: string;
      authorLink?: string;
    };
    if (!d?.url) return;
    // Placeholder borroso primero (si vino); en paralelo cargamos la full y, al decodear,
    // la pintamos nítida sacando el blur. Si la full falla, queda el placeholder.
    if (d.placeholder) paintBg(d.placeholder, true);
    const full = d.url;
    const img = new Image();
    const showSharp = (): void => paintBg(full, false);
    img.onload = showSharp;
    img.src = full;
    if (img.decode)
      img
        .decode()
        .then(showSharp)
        .catch(() => {});
    // Atribución Unsplash: reusar el <a id="unsplash-attr"> que creó el inline script,
    // o crear uno nuevo si no existe (primera carga sin Unsplash key).
    const existing = document.getElementById("unsplash-attr") as HTMLAnchorElement | null;
    if (d.author && d.authorLink) {
      const attr: HTMLAnchorElement = existing ?? document.createElement("a");
      attr.id = "unsplash-attr";
      // Posición/estilo por CLASE (.unsplash-attr en index.css): abajo-IZQUIERDA, sobre el badge
      // de versión. Se la reasignamos siempre (el elemento reusado ya la trae del inline script).
      attr.className = "unsplash-attr";
      attr.href = `${d.authorLink}?utm_source=ceibo&utm_medium=referral`;
      attr.target = "_blank";
      attr.rel = "noopener noreferrer";
      attr.textContent = `📷 ${d.author} / Unsplash`;
      if (!existing) {
        document.body.appendChild(attr);
      }
    } else if (existing) {
      // La nueva imagen no es Unsplash (ej. local de fallback): sacamos la atribución anterior.
      existing.remove();
    }
  } catch {
    // En caso de fallo de red: silencioso, el fondo actual queda como está.
  }
}

// Debug mode: ?debug=1 en la URL muestra un overlay con status, estado del SSE y un log de
// eventos (pointer + SSE) para diagnosticar la grabación/canal en mobile.
// Overlay de debug opt-in: ?debug=1 (queda a mano para diagnosticar el orbe en mobile).
const DEBUG = new URLSearchParams(window.location.search).has("debug");

// Orbe WebGL (plasma ember) si hay soporte y el user no pidió menos movimiento; sino, el
// orbe CSS de siempre. Se evalúa una vez al cargar.
const WEBGL_ORB = orbWebGLSupported();

const EXP_OPEN_KEY_PREFIX = "ceibo_expopen:";
const CHAT_OPEN_KEY_PREFIX = "ceibo_chatopen:";
// Chat maximizado (ocupa el área de contenido) vs. popup en el rincón. Global (no por-handle):
// es una preferencia de layout, no de conversación.
const CHAT_MAX_KEY = "ceibo_chatmax";
const HANDLE_KEY = "ceibo_handle";
const THEME_KEY = "ceibo_theme";
// Modo debug de la web (toggle local de UI, NO el flag `/debug` del server que gatea Telegram):
// muestra un log de las herramientas que va usando el agente en el turno. Persistido global.
const DEBUG_MODE_KEY = "ceibo_debugmode";
// Pistas del orbe on/off (las "hints" bajo el orbe). Preferencia de UI global, persistida.
// Default ON (la mayoría las quiere; quien prefiera el orbe "limpio" las apaga en settings).
const HINTS_KEY = "ceibo_hints";
// Blame por línea on/off ("quién escribió qué"). Antes era un toggle por-nota; ahora es una
// preferencia de UI GLOBAL, persistida (se prende/apaga en Configuración → Ediciones).
// Default OFF. Solo se ve en wikis con blame disponible (ver blameAvailable).
const BLAME_KEY = "ceibo_blame";
// Saludo de bienvenida sobre el orbe (estilo Claude): se muestra ANTES de la primera
// interacción y se va elegante apenas le hablás. NO se persiste → cada carga/refresh de la
// página lo vuelve a mostrar (pedido del owner).
// Templates del saludo. `{name}` se reemplaza por " <primer nombre>" (o "" si no hay nombre).
// Refuerzan la idea de que Ceibo te libera tiempo y te hace la vida más fácil.
const GREETINGS = [
  "Hola{name}, ¿qué puedo hacer por vos?",
  "Hola{name}, ¿qué te saco de encima hoy?",
  "Contame{name}, ¿en qué te libero tiempo?",
  "Hola{name}, estoy para hacerte el día más fácil.",
  "¿Arrancamos{name}? Vos decime y yo me encargo.",
  "Hola{name}, delegá tranquilo: ¿por dónde empezamos?",
  "Acá estoy{name}: vine a simplificarte el día. ¿Por dónde?",
];

/** Arma el saludo: reemplaza `{name}` por " <primer nombre>" (o "" si no hay). */
function buildGreeting(tpl: string, name?: string): string {
  const first = name?.trim().split(/\s+/)[0];
  return tpl.replace("{name}", first ? ` ${first}` : "");
}

// Adjuntos del chat: MA acepta como content block sólo imágenes (png/jpeg/gif/webp) y PDF.
// El selector y el drag-drop filtran por esto; lo demás se descarta con un aviso suave.
const ATTACH_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,application/pdf";
const ATTACH_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const ATTACH_MAX = 8; // tope de adjuntos por turno (espeja MAX_MEDIA_PER_TURN del web-server)
const ATTACH_MAX_BYTES = 18 * 1024 * 1024; // por archivo (el body entero topea en 25MB en el server)

/** Adjunto pendiente en el composer (todavía sin mandar). `data` = base64 (sin prefijo);
 *  `url` = data-URL para el preview; `id` para la key/remoción. */
type PendingAttachment = { id: string; name: string; mime: string; data: string; url: string };

/** ¿MA acepta este MIME como adjunto? (imagen soportada o PDF). */
function isAttachable(mime: string): boolean {
  return ATTACH_IMAGE_MIMES.has(mime) || mime === "application/pdf";
}

/** Lee un File a base64 (sin el prefijo data-URL). null si falla la lectura. */
function fileToBase64(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const res = reader.result;
      // readAsDataURL → "data:<mime>;base64,<data>": nos quedamos con la parte de datos.
      const comma = typeof res === "string" ? res.indexOf(",") : -1;
      resolve(comma >= 0 ? (res as string).slice(comma + 1) : null);
    };
    reader.readAsDataURL(file);
  });
}

type Theme = "auto" | "light" | "dark";
/** Lee el tema guardado (default "auto" = sigue al sistema). Síncrono para no flashear. */
function initialTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "auto";
  } catch {
    return "auto";
  }
}

// Constantes del gesto tap-to-toggle de grabación
const MAX_HANDSFREE_MS = 60 * 60 * 1000; // límite hard: 60 min
// Grabación que dura MENOS que esto al frenar con el 2º tap → se descarta (no se envía): cubre el
// doble-tap accidental sin penalizar mensajes cortos reales (≥ ~0.4s ya cuenta como mensaje).
const TAP_DISCARD_MS = 400;

/** Formatea milisegundos a "MM:SS" para el timer de manos libres. */
function formatHandsfreeTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** Lee el modo debug guardado (default off). Síncrono para no flashear el panel al cargar. */
function initialDebugMode(): boolean {
  try {
    return localStorage.getItem(DEBUG_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Lee la preferencia de pistas del orbe (default ON: sólo "0" la apaga). Síncrono. */
function initialHintsEnabled(): boolean {
  try {
    return localStorage.getItem(HINTS_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Lee la preferencia global de blame por línea (default off). Síncrono. */
function initialBlameOn(): boolean {
  try {
    return localStorage.getItem(BLAME_KEY) === "1";
  } catch {
    return false;
  }
}

/** Estado inicial del explorer abierto/cerrado: lee SÍNCRONO del handle cacheado
 *  (lo escribe useChannel al login) para evitar el flash de "cerrado → abierto"
 *  que aparecía cuando se hidrataba post-mount. Si no hay handle cacheado (primer
 *  login), arranca cerrado. */
function initialExplorerOpen(): boolean {
  try {
    const h = localStorage.getItem(HANDLE_KEY);
    if (!h) return false;
    return localStorage.getItem(`${EXP_OPEN_KEY_PREFIX}${h}`) === "1";
  } catch {
    return false;
  }
}

/** Igual que initialExplorerOpen pero para el chat popup: lee síncrono del handle
 *  cacheado para no flashear cerrado→abierto en F5. Default cerrado (solo el orbe). */
function initialChatOpen(): boolean {
  try {
    const h = localStorage.getItem(HANDLE_KEY);
    if (!h) return false;
    return localStorage.getItem(`${CHAT_OPEN_KEY_PREFIX}${h}`) === "1";
  } catch {
    return false;
  }
}

// El editor (Atomic Editor + CodeMirror 6) pesa varios cientos de KB. Lazy: el círculo
// de voz (uso primario) no lo baja. Se trae al abrir el primer archivo.
const FileEditor = lazy(() => import("./Editor.tsx").then((m) => ({ default: m.FileEditor })));

// Badge de versión DISCRETO en la pantalla del orbe (home): SHA corto + tag de entorno,
// anclado abajo-izquierda para no competir con el orbe (centrado) ni con la atribución de
// Unsplash (abajo-derecha). Misma regla de visibilidad que el badge del explorer
// (`versionBadge()`): dev/staging siempre; prod sólo con ?debugVersion=1. Reusa el estilo
// `.exp-version` y el hook compartido de /api/version. Headless mientras no haya datos o el
// entorno lo oculte → no renderiza nada.
function HomeVersion() {
  const versionInfo = useVersionInfo();
  if (!versionInfo) return null;
  const badge = versionBadge(versionInfo.env, versionInfo.sha, window.location.search);
  if (!badge.show || !badge.sha) return null;
  return (
    <span className="exp-version home-version">
      <span className="exp-version-sha">{badge.sha}</span>
      <span className="exp-version-tag">{badge.tag}</span>
    </span>
  );
}

export function App() {
  const ch = useChannel();
  // "Página de editor": cualquier contenido montado en el área del editor (nota O página de sistema).
  // `docOpen` murió — ya no es el proxy de "hay algo abierto". Usar `pageOpen` para chrome global
  // (FABs, dock, clase de layout) y `noteOpen` para lógica específica de archivo (blame, scroll…).
  const pageOpen = ch.activeTab !== null; // hay CUALQUIER página de editor activa
  const noteOpen = ch.activeTab?.kind === "note"; // específico de nota (archivo real)
  // Identidad de la página activa (nota=repo|path, sistema=page, nada=""). Cambia ante CUALQUIER
  // apertura/cambio de contenido —incluido reemplazar la nota de la pestaña activa por otra
  // (replace-active), donde `activeTabId` NO cambia—. Lo usa el cierre de chat en mobile.
  const activeContentKey = !ch.activeTab
    ? ""
    : ch.activeTab.kind === "system"
      ? `sys:${ch.activeTab.page}`
      : `note:${ch.activeTab.repo}|${ch.activeTab.path}`;
  // "Home mode": hay tabs abiertas pero ninguna está activa (el orb principal se muestra).
  // La tira de pestañas sigue visible en la parte superior, pero el editor no se muestra.
  const homeMode = ch.tabs.length > 0 && ch.activeTabId === null;
  // Último tab activo antes de entrar a home mode: sirve para volver con un click desde el
  // botón flotante. Se actualiza cada vez que activeTabId pasa a ser no-nulo.
  const lastActiveTabIdRef = useRef<string | null>(null);
  if (ch.activeTabId !== null) lastActiveTabIdRef.current = ch.activeTabId;
  const offline = ch.status === "connecting" || ch.status === "unauth";
  // Manos libres (doble tap): `true` mientras el orbe está grabando en modo continuo.
  // Declarado temprano (antes de orbHint) porque computeOrbHint lo necesita. El permiso de mic
  // no afecta el estado visual del orbe; se pide lazy cuando una interacción intenta grabar.
  const [handsfree, setHandsfree] = useState(false);
  // Ref espejo para evitar stale closure en los pointer handlers.
  const handsfreeRef = useRef(false);
  // Offset vertical del orbe durante el drag (en px, ≤0 → sube). 1:1 con el dedo mientras
  // se hace el swipe-up; se congela al entrar en manos libres; vuelve a 0 al salir (con transición).
  const [orbDragDy, setOrbDragDy] = useState(0);
  // Segundo underhint (bajo el principal): mientras hay ≥1 sub-agente vivo, "Corriendo N subagentes".
  // Usa el conteo que la web ya tiene (frame `subagents`). "" cuando no hay → no se renderiza.
  const subHint = subagentCountHint(ch.subagentCount);
  // Hint always-on bajo el orbe: el estado básico del orbe (idle/grabando/…) y, mientras el agente
  // trabaja, el label AMABLE del tool-call en curso (`ch.activity`, ej. "web search") en vez del
  // genérico "pensando…" — la misma actividad que muestra el indicador del chat. `hasSubHint`: si el
  // segundo underhint está visible, el principal NO dice "subagente creado" (lo cubre el sub).
  const orbHint = computeOrbHint(ch.status, ch.activity, ch.subagentCount, handsfree, !!subHint);
  // Texto que se manda con Enter. Vive acá (no en el hook) porque sólo importa para el
  // input visual; el hook lo recibe ya completo en sendText.
  const [textDraft, setTextDraft] = useState("");
  // Adjuntos pendientes del composer (imágenes/PDF que se mandan con el próximo turno) +
  // un aviso efímero cuando se descarta algo (tipo no soportado / muy grande / tope).
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachNote, setAttachNote] = useState("");
  const attachNoteTimer = useRef<number | undefined>(undefined);
  const flashAttachNote = (msg: string) => {
    setAttachNote(msg);
    window.clearTimeout(attachNoteTimer.current);
    attachNoteTimer.current = window.setTimeout(() => setAttachNote(""), 3500);
  };
  // Suma archivos (del selector o del drag-drop): valida tipo/tamaño/tope, los lee a base64
  // y los agrega al composer. Lo no soportado se descarta con un aviso.
  const addFiles = async (files: File[] | FileList) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    let rejected = 0;
    const accepted: PendingAttachment[] = [];
    for (const f of list) {
      if (attachments.length + accepted.length >= ATTACH_MAX) {
        flashAttachNote(`Máximo ${ATTACH_MAX} adjuntos por mensaje.`);
        break;
      }
      if (!isAttachable(f.type) || f.size > ATTACH_MAX_BYTES) {
        rejected++;
        continue;
      }
      const data = await fileToBase64(f);
      if (!data) {
        rejected++;
        continue;
      }
      accepted.push({
        id: crypto.randomUUID(),
        name: f.name,
        mime: f.type,
        data,
        url: `data:${f.type};base64,${data}`,
      });
    }
    if (accepted.length) setAttachments((prev) => [...prev, ...accepted]);
    if (rejected) flashAttachNote("Solo imágenes (PNG/JPG/GIF/WebP) y PDF, hasta 18 MB.");
  };
  const removeAttachment = (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id));
  // Login: el callback de Google rebota a /?denied=1 (error técnico), /?waitlisted=1
  // (primera vez en la lista de espera) o /?waitlisted=already (ya estaba). Lo leemos
  // una vez para mostrar el aviso; después limpiamos el param de la URL.
  const [denied] = useState(() => new URLSearchParams(window.location.search).has("denied"));
  const [waitlistedParam] = useState(
    () => new URLSearchParams(window.location.search).get("waitlisted") ?? "",
  );
  useEffect(() => {
    if (!denied && !waitlistedParam) return;
    const u = new URL(window.location.href);
    u.searchParams.delete("denied");
    u.searchParams.delete("waitlisted");
    window.history.replaceState(null, "", u.pathname + (u.search === "?" ? "" : u.search));
  }, [denied, waitlistedParam]);
  // Páginas de sistema abiertas actualmente (para marcar las entradas del menú del launcher).
  // Derivado directo de ch.tabs — sin estado local. El launcher usa ch.openSystem(page).
  const openSystemPages = new Set<SystemPage>(ch.tabs.filter((t) => t.kind === "system").map((t) => t.page));
  // Tema (#24): auto sigue al sistema (sin data-theme → la media query del CSS manda);
  // light/dark fuerzan vía data-theme en <html>. Persistido en localStorage.
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* localStorage no disponible */
    }
  }, [theme]);
  // Modo debug de la web (toggle del cog): muestra el log de herramientas del agente. Local
  // de UI; no toca el flag `/debug` del server (ése es de Telegram). Persistido global.
  const [debugMode, setDebugMode] = useState<boolean>(initialDebugMode);
  useEffect(() => {
    try {
      localStorage.setItem(DEBUG_MODE_KEY, debugMode ? "1" : "0");
    } catch {
      /* localStorage no disponible */
    }
  }, [debugMode]);
  // Pistas del orbe on/off (toggle del cog). Persistido global. Default ON.
  const [hintsEnabled, setHintsEnabled] = useState<boolean>(initialHintsEnabled);
  useEffect(() => {
    try {
      localStorage.setItem(HINTS_KEY, hintsEnabled ? "1" : "0");
    } catch {
      /* localStorage no disponible */
    }
  }, [hintsEnabled]);
  // Hint como sub-componente del orbe con animación de aparición/desaparición "hacia el orbe":
  // `hintText` es el texto MONTADO (puede sobrevivir a que orbHint se vacíe, para animar la salida)
  // y `hintPhase` "in" = emerge desde el orbe / "out" = migra de vuelta AL orbe (se encoge hacia
  // arriba) y recién ahí se desmonta. Lo que QUEREMOS mostrar ahora: el hint, si está prendido y
  // online; "" si no. Los cambios de texto durante el turno (pensando→tool→…) NO re-animan: sólo
  // el paso vacío↔no-vacío dispara emerge/migrar. (Toggle off → migra al orbe y desaparece.)
  const wantHint = !offline && hintsEnabled && orbHint ? orbHint : "";
  const [hintText, setHintText] = useState("");
  const [hintPhase, setHintPhase] = useState<"in" | "out">("in");
  const hintHideTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (wantHint) {
      if (hintHideTimer.current) {
        clearTimeout(hintHideTimer.current);
        hintHideTimer.current = undefined;
      }
      setHintText(wantHint);
      setHintPhase("in");
    } else {
      // Migrar al orbe y desmontar. Timer (no onAnimationEnd) para ser robusto con
      // prefers-reduced-motion, donde la animación es `none` y el evento no dispararía.
      setHintPhase("out");
      if (!hintHideTimer.current) {
        hintHideTimer.current = window.setTimeout(() => {
          setHintText("");
          hintHideTimer.current = undefined;
        }, 340);
      }
    }
  }, [wantHint]);
  // Segundo underhint (mini-orbs: "Corriendo N subagentes"): mismo patrón de ciclo de vida que el
  // principal — emerge desde el orbe al aparecer y migra de vuelta al desmontarse. Se muestra
  // mientras haya sub-agentes vivos (subagentCount>0) y estemos online; independiente del toggle de
  // hints del status (es delegación en curso, no microcopy de status). Los cambios de N NO re-animan:
  // sólo el paso vacío↔no-vacío. (count cae a 0 al terminar → migra al orbe y se desmonta.)
  const wantSubHint = !offline && subHint ? subHint : "";
  const [subHintText, setSubHintText] = useState("");
  const [subHintPhase, setSubHintPhase] = useState<"in" | "out">("in");
  const subHintHideTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (wantSubHint) {
      if (subHintHideTimer.current) {
        clearTimeout(subHintHideTimer.current);
        subHintHideTimer.current = undefined;
      }
      setSubHintText(wantSubHint);
      setSubHintPhase("in");
    } else {
      setSubHintPhase("out");
      if (!subHintHideTimer.current) {
        subHintHideTimer.current = window.setTimeout(() => {
          setSubHintText("");
          subHintHideTimer.current = undefined;
        }, 340);
      }
    }
  }, [wantSubHint]);
  // Saludo de bienvenida (ver GREETINGS): "in" mientras se muestra, "leaving" durante el
  // fade-out elegante al primer habla, "gone" una vez ido. SOLO en memoria (sin persistir):
  // cada carga/refresh de la página lo vuelve a mostrar hasta la primera interacción.
  const [greetPhase, setGreetPhase] = useState<"in" | "leaving" | "gone">("in");
  // Template elegido UNA sola vez por carga (no cambia entre renders).
  const [greetTpl] = useState(
    () => GREETINGS[Math.floor(Math.random() * GREETINGS.length)] ?? "Hola{name}, ¿qué puedo hacer por vos?",
  );
  // Se va elegante apenas interactuás (hablás o escribís) por primera vez (vuelve en el próximo refresh).
  const dismissGreeting = () => {
    setGreetPhase((p) => (p === "in" ? "leaving" : p));
  };
  useEffect(() => {
    if (greetPhase !== "leaving") return;
    const t = window.setTimeout(() => setGreetPhase("gone"), 650);
    return () => window.clearTimeout(t);
  }, [greetPhase]);

  // Push-to-talk: el long-press sobre el orbe disparaba el menú del browser sobre el <canvas>
  // (que el browser trata como "imagen") y al hacerlo CANCELABA el pointer del hold-to-talk
  // (pointercancel → talkUp) → se cortaba la grabación. Dos motores, dos defensas, AMBAS en el
  // `document` (no en un ref de la talkzone, que se monta/desmonta al navegar entre nota y home →
  // un listener pegado a una instancia se pierde al re-montar). Scopeado al área del orbe por
  // `closest()`, así no afecta el resto (click-derecho del editor, scroll de notas):
  //  - Blink (Chrome desktop/Android): el long-press dispara `contextmenu` → preventDefault.
  //  - WebKit (Safari/Chrome iOS): NO dispara `contextmenu` y ignora `-webkit-touch-callout:none`
  //    + overlay (escanea el <canvas> por debajo). Se mata con `preventDefault` del `touchstart`
  //    NO-pasivo. Los Pointer Events (pointerdown/move/up) son independientes → push-to-talk OK.
  useEffect(() => {
    // SOLO la superficie de voz (talkzone + canvas del orbe), NO todo el .dock: si tomáramos el
    // .dock entero, el `preventDefault` del touchstart le mataría el tap a los controles que viven
    // ahí adentro (el botón ✕ de cancelar) en mobile.
    const inOrbArea = (e: Event) => {
      const t = e.target as globalThis.Element | null;
      return !!t?.closest?.(".talkzone, .orb-canvas");
    };
    const onCtx = (e: MouseEvent) => {
      if (inOrbArea(e)) e.preventDefault();
    };
    const onTouchStart = (e: TouchEvent) => {
      if (inOrbArea(e)) e.preventDefault();
    };
    document.addEventListener("contextmenu", onCtx, { capture: true });
    document.addEventListener("touchstart", onTouchStart, { capture: true, passive: false });
    return () => {
      document.removeEventListener("contextmenu", onCtx, { capture: true });
      document.removeEventListener("touchstart", onTouchStart, { capture: true });
    };
  }, []);

  // El input queda habilitado salvo offline o grabando. Mientras el agente responde
  // (thinking/speaking) podés escribir y mandar: el envío interrumpe el turno (ver sendText).
  const canSendText = !offline && ch.status !== "recording";
  const onSubmitText = (e: FormEvent) => {
    e.preventDefault();
    const t = textDraft.trim();
    if ((!t && attachments.length === 0) || !canSendText) return;
    dismissGreeting();
    const media: OutboundMedia[] = attachments.map((a) => ({ name: a.name, mime: a.mime, data: a.data }));
    ch.sendText(t, media.length ? media : undefined);
    setTextDraft("");
    setAttachments([]);
  };
  // Estado abierto/cerrado del explorer, persistido por handle. Hidratación SÍNCRONA
  // del handle cacheado (initialExplorerOpen) para evitar flash en F5; si /api/me
  // devuelve un handle distinto, re-hidratamos abajo.
  const [explorerOpen, setExplorerOpen] = useState(initialExplorerOpen);
  useEffect(() => {
    if (!ch.handle) return;
    const v = localStorage.getItem(`${EXP_OPEN_KEY_PREFIX}${ch.handle}`) === "1";
    setExplorerOpen((prev) => (prev === v ? prev : v));
  }, [ch.handle]);
  useEffect(() => {
    if (!ch.handle) return;
    localStorage.setItem(`${EXP_OPEN_KEY_PREFIX}${ch.handle}`, explorerOpen ? "1" : "0");
  }, [ch.handle, explorerOpen]);

  // La atribución de Unsplash (📷 Autor) pertenece a la FOTO DE FONDO → sólo tiene sentido
  // cuando el fondo se ve de verdad. El fondo se ve únicamente en home mode (orbe, sin página
  // abierta) y con el explorador cerrado; cualquier página de editor lo tapa, y el panel del
  // explorador lo cubre (entero en mobile, la esquina inf-izq donde vive la atribución en
  // desktop). Marcamos esa condición con la clase `bg-visible` en <body> y el CSS oculta la
  // atribución cuando no está — así no queda flotando por encima del menú ni de la nota. El
  // elemento #unsplash-attr vive en <body> (lo crea el script inline / App al cambiar de foto),
  // fuera de #root, por eso la clase va en <body> y no en el árbol de React.
  const bgVisible = homeMode && !explorerOpen;
  useEffect(() => {
    document.body.classList.toggle("bg-visible", bgVisible);
  }, [bgVisible]);

  // Panel activo de la activity bar del explorador (columna de íconos a la izq, estilo VS Code):
  // árbol de archivos / páginas del sistema / notificaciones. Antes sistema y notifs eran popups
  // flotantes (launcher-fab / notif-fab); ahora conmutan el cuerpo del explorador. Se resetea a
  // "files" entre sesiones (no se persiste): al reabrir el explorador, arranca en el árbol.
  const [explorerPanel, setExplorerPanel] = useState<SidebarPanel>("files");

  // "Mostrar en explorador" (menú contextual de la tab): pedido de revelar un archivo en el árbol.
  // `seq` se bumpea en cada pedido para que revelar el mismo archivo dos veces re-dispare el efecto
  // del Explorer (expande ancestros + scroll + highlight). Abrir el explorador en el panel de files
  // es responsabilidad de este handler.
  const [revealTarget, setRevealTarget] = useState<{ repo: string; path: string; seq: number } | null>(null);
  const revealInExplorer = useCallback(
    (repo: string, path: string) => {
      setExplorerOpen(true);
      setExplorerPanel("files");
      setRevealTarget((prev) => ({ repo, path, seq: (prev?.seq ?? 0) + 1 }));
    },
    // setExplorerOpen/setExplorerPanel/setRevealTarget son setters estables de useState.
    [],
  );

  // Mapa slug-de-repo → DISPLAY LABEL (alias) de cada wiki del usuario, para que la
  // desambiguación de tabs muestre el alias que el usuario le puso a la wiki (no el slug/nombre
  // real). Lo trae /api/explorer (misma fuente y mismo `label` ya desambiguado que el árbol). Se
  // refresca con el handle y con `treeSeq` (el mismo pulso que recarga el explorer: cubre renames
  // de alias y altas de wiki). Vive acá —no en el Explorer— porque la tira de tabs se renderiza
  // aunque el explorer esté cerrado.
  const [repoLabels, setRepoLabels] = useState<Map<string, string>>(() => new Map());
  // Emoji por-nota (estilo Notion): mapa `"<repo>\n<path>" → emoji`. Vive acá —no en el Explorer—
  // porque la tira de tabs y el header del editor se renderizan aunque el explorer esté cerrado.
  // Se hidrata del mismo fetch de /api/explorer que los labels; el Explorer lo actualiza en vivo
  // (onEmojiChanged) cuando el usuario asigna/limpia un emoji.
  const [noteEmojis, setNoteEmojis] = useState<Map<string, string>>(() => new Map());
  const emojiKey = useCallback((repo: string, path: string) => `${repo}\n${path}`, []);
  const emojiOf = useCallback(
    (repo: string, path: string) => noteEmojis.get(emojiKey(repo, path)) ?? "",
    [noteEmojis, emojiKey],
  );
  const onEmojiChanged = useCallback(
    (repo: string, path: string, emoji: string) =>
      setNoteEmojis((prev) => {
        const next = new Map(prev);
        if (emoji) next.set(emojiKey(repo, path), emoji);
        else next.delete(emojiKey(repo, path));
        return next;
      }),
    [emojiKey],
  );
  // Asigna/limpia el emoji de una nota (lo elige el botón a la izquierda del título — ver
  // Editor.tsx; ya NO el explorer). Optimista: pinta el cambio al instante en tab/editor/árbol
  // (el árbol lee del mismo mapa) y persiste en el sidecar; si el POST falla, revierte.
  const setNoteEmoji = useCallback(
    async (repo: string, path: string, emoji: string) => {
      const trimmed = emoji.trim();
      const prev = noteEmojis.get(emojiKey(repo, path)) ?? "";
      onEmojiChanged(repo, path, trimmed); // optimista
      try {
        await apiSetEmoji(repo, path, trimmed);
      } catch {
        onEmojiChanged(repo, path, prev); // revertir
      }
    },
    [noteEmojis, emojiKey, onEmojiChanged],
  );
  // Wikis del usuario donde el blame TIENE algo que mostrar (flag `blame` de /api/explorer):
  // compartidas (>1 miembro activo) siempre; personales solo si la distinción humano/IA está
  // disponible (hay sources de commits registrados). Gate client-side del toggle — si no,
  // el botón ni aparece (el server además rechaza con 403). Mismo fetch que los labels.
  const [blameRepos, setBlameRepos] = useState<Set<string>>(() => new Set());
  // `ch.treeSeq` está en las deps a propósito aunque no se referencie en el cuerpo: es el pulso que
  // dispara el refetch de labels al cambiar el árbol (rename de alias / alta de wiki), igual que el
  // Explorer lo usa para recargar.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `ch.treeSeq` es señal de refetch, no se usa en el cuerpo
  useEffect(() => {
    if (!ch.handle) return;
    let cancelled = false;
    void fetch("/api/explorer", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { wikis: [] }))
      .then(
        (d: {
          wikis?: {
            repo: string;
            label: string;
            members?: { handle: string }[];
            blame?: boolean;
            emojis?: Record<string, string>;
          }[];
        }) => {
          if (cancelled) return;
          setRepoLabels(new Map((d.wikis ?? []).map((w) => [w.repo, w.label])));
          // Aplanamos el mapa per-wiki a un `"<repo>\n<path>" → emoji` para lookup directo por tab.
          const flat = new Map<string, string>();
          for (const w of d.wikis ?? []) {
            for (const [p, e] of Object.entries(w.emojis ?? {})) flat.set(`${w.repo}\n${p}`, e);
          }
          setNoteEmojis(flat);
          setBlameRepos(
            new Set(
              (d.wikis ?? [])
                // Fallback para un server viejo sin el flag: el criterio previo (compartida).
                .filter((w) => w.blame ?? (w.members ?? []).length > 1)
                .map((w) => w.repo),
            ),
          );
        },
      )
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ch.handle, ch.treeSeq]);

  // F5: repos archivados del usuario — para mostrar el banner "Wiki archivada" en el editor.
  // Se refresca cuando el handle o el treeSeq cambian (igual que los labels).
  const [archivedRepoNames, setArchivedRepoNames] = useState<Set<string>>(() => new Set());
  // biome-ignore lint/correctness/useExhaustiveDependencies: `ch.treeSeq` es señal de refetch
  useEffect(() => {
    if (!ch.handle) return;
    let cancelled = false;
    void fetch("/api/explorer/archived", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { archived: [] }))
      .then((d: { archived?: { repo: string }[] }) => {
        if (cancelled) return;
        setArchivedRepoNames(new Set((d.archived ?? []).map((w) => w.repo)));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ch.handle, ch.treeSeq]);

  // Toggle de blame por línea ("quién escribió qué"). Preferencia de UI GLOBAL y persistida
  // (se prende/apaga en Configuración → Ediciones, no por nota). Cuando está ON, se
  // muestra en cada nota de una wiki con blame disponible (ver blameAvailable / FileEditor).
  const [blameOn, setBlameOn] = useState<boolean>(initialBlameOn);
  useEffect(() => {
    try {
      localStorage.setItem(BLAME_KEY, blameOn ? "1" : "0");
    } catch {
      /* localStorage no disponible */
    }
  }, [blameOn]);
  // El blame solo aplica sobre una nota real, ya cargada, de una wiki con blame disponible
  // (compartida, o personal con distinción humano/IA). El toggle global compone con esto.
  const blameAvailable = !!ch.doc && ch.doc.status === "ready" && blameRepos.has(ch.doc.repo);

  // Chat popup abierto/cerrado, persistido por handle (igual que el explorer). Cerrado =
  // solo el orbe central; abierto = el panel de chat abajo-derecha (con historial + mic).
  const [chatOpen, setChatOpen] = useState(initialChatOpen);
  useEffect(() => {
    if (!ch.handle) return;
    const v = localStorage.getItem(`${CHAT_OPEN_KEY_PREFIX}${ch.handle}`) === "1";
    setChatOpen((prev) => (prev === v ? prev : v));
  }, [ch.handle]);
  useEffect(() => {
    if (!ch.handle) return;
    localStorage.setItem(`${CHAT_OPEN_KEY_PREFIX}${ch.handle}`, chatOpen ? "1" : "0");
  }, [ch.handle, chatOpen]);
  // Con el chat ABIERTO la respuesta de voz NO se auto-reproduce por default (como Telegram):
  // la burbuja trae un `<audio controls>` con play/pausa/seek y el user lo dispara a mano. Con
  // el chat cerrado (modo orbe / push-to-talk) sí autoplay — la voz suena y el orbe pulsa.
  // EXCEPCIÓN (decidida en useChannel, ver shouldAutoplayVoice): si el turno lo inició una NOTA
  // DE VOZ del usuario, la respuesta autoplaya igual y la burbuja espeja la reproducción.
  useEffect(() => {
    ch.setVoiceAutoplay(!chatOpen);
  }, [ch.setVoiceAutoplay, chatOpen]);

  // En mobile (≤32rem), al abrirse o cambiar la nota/página activa, el chat se cierra
  // automáticamente para que la nota quede visible (en mobile el chat es full-screen y
  // tapa la nota). El usuario puede volver al chat con el botón de chat-fab.
  // En desktop no se toca nada: la nota se muestra side-by-side con el chat abierto.
  //
  // Disparamos sobre `activeContentKey` (repo|path / página de sistema), NO sobre
  // `activeTabId`: cuando el agente o el explorer abren una nota REEMPLAZANDO la de la
  // pestaña activa (replace-active, el caso más común una vez que ya hay una nota abierta),
  // `activeTabId` no cambia y la versión anterior (#404) nunca cerraba el chat. La key sí
  // cambia. Guardamos la key previa en un ref y sólo cerramos en una transición REAL a una
  // página distinta (no en el primer render ni al restaurar tabs en el boot, donde la key
  // llega ya seteada sin que el usuario haya abierto nada).
  const prevContentKeyRef = useRef(activeContentKey);
  useEffect(() => {
    const prev = prevContentKeyRef.current;
    prevContentKeyRef.current = activeContentKey;
    if (!activeContentKey) return; // volvimos al orbe (nada abierto) → no tocar el chat
    if (activeContentKey === prev) return; // misma página → no es una apertura nueva
    if (!window.matchMedia("(max-width: 32rem)").matches) return; // solo mobile
    setChatOpen(false);
  }, [activeContentKey]);

  // (Se quitó el auto-abrir del chat ante respuestas del agente: disparaba en momentos no
  // intencionados. Ahora el chat lo abre el usuario; cuando hay un link el agente menciona
  // explícitamente "en el chat" para que sepa dónde verlo — ver prompt/core.md.)
  // Memoria del scroll de las notas abiertas, ACÁ (App no remonta) para sobrevivir al cambio de
  // pestaña (un cambio externo de la nota abierta ya NO remonta el editor — Fase C). Es un MAP
  // keyeado por `scrollKey(tabId, repo, path)` (ver scrollKey.ts): cada nota-en-su-pestaña
  // recuerda su propio scrollTop, así volver a una pestaña ya leída restaura su posición (no
  // vuelve arriba). Un refresh mantiene la key → restaura; abrir una nota nueva no tiene entrada
  // → arranca arriba. La misma nota en dos pestañas tiene scroll independiente (tab id distinto).
  // OJO: NO keyear por doc.id — se regenera en cada selectTab/open (crypto.randomUUID en
  // loadEntry) → el Map nunca matchearía y restauraría 0 siempre (era el bug de #273).
  const wikiScrollMemo = useRef<Map<string, number>>(new Map());

  // Cache cross-refresh del scroll (uiStateCache.ts): persiste la posición de cada nota en
  // localStorage (keyed por `${repo}/${path}`, sin tabId — las tabs regeneran su UUID en cada boot).
  // Al restaurar tabs, sembramos `wikiScrollMemo` con las posiciones guardadas para que el
  // primer render de cada nota parta del scroll correcto (igual que si nunca hubiera hecho F5).
  // Se escribe con debounce en cada onScroll (ver WikiViewBody) y se flushea en pagehide.
  const scrollPositionsRef = useRef<Record<string, number>>({});

  // Sembrado inicial: cuando el handle queda confirmado y hay tabs restauradas, leemos el
  // cache del localStorage y precargamos `wikiScrollMemo` con las posiciones guardadas para
  // TODAS las tabs (no solo la activa), así volver a cualquier pestaña restaura su scroll.
  // Usamos `ch.tabs` en las deps: al restaurarse, las tabs cambian de [] a la lista guardada.
  // `TabInfo` (lo que expone ch.tabs) ya trae repo+path de la entrada actual de cada pestaña.
  useEffect(() => {
    if (!ch.handle || ch.booting) return;
    const saved = readScrollCache(ch.handle);
    scrollPositionsRef.current = saved;
    // Precargamos wikiScrollMemo para cada tab restaurada (antes de que el editor monte).
    // Las pestañas de sistema no tienen repo/path: salteamos (no tienen scroll de nota).
    for (const tab of ch.tabs) {
      if (tab.kind !== "note") continue;
      const top = saved[scrollCacheKey(tab.repo, tab.path)];
      if (top && top > 0) {
        wikiScrollMemo.current.set(scrollKey(tab.id, tab.repo, tab.path), top);
      }
    }
    // ch.tabs en deps: cuando restoreTabs corre, las tabs pasan de [] a la lista; el efecto
    // recarga el cache y siembra wikiScrollMemo para todas las tabs nuevas.
    // wikiScrollMemo y scrollPositionsRef son refs: estables entre renders, no van en deps.
  }, [ch.handle, ch.booting, ch.tabs]);

  // Flush del scroll en pagehide (beforeunload no siempre se dispara en mobile).
  useEffect(() => {
    const onHide = () => flushScrollCache(ch.handle, scrollPositionsRef.current);
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [ch.handle]);

  // Deep-link (#5): la URL refleja el archivo o página de sistema abierto como un PATH REAL.
  // - Nota: `/<repo>/<path…>` (esquema en deepLink.ts).
  // - Página de sistema: `/<slug>` (un segmento, libre porque parseNoteUrl exige ≥2).
  // - Sin nada activo: `/`.
  // La URL solo se actualiza tras autenticar (handle seteado) para no pisar el path que el
  // boot está leyendo. Preservamos location.search (ej. ?debug) — el deep-link vive en pathname.
  // Como `doc=null` cuando la tab activa es de sistema, usamos `ch.activeTab` (no ch.doc).
  // Excepción: /invitacion (P4) — la pantalla pre-auth gestiona su propia URL; no pisar.
  useEffect(() => {
    if (!ch.handle) return;
    if (location.pathname === "/invitacion") return;
    let target = "/";
    if (ch.activeTab?.kind === "system") {
      target = systemUrl(ch.activeTab.page);
    } else if (ch.doc?.repo && ch.doc?.path) {
      target = noteUrl(ch.doc.repo, ch.doc.path);
    }
    if (location.pathname !== target) history.replaceState(null, "", target + location.search);
  }, [ch.handle, ch.activeTab, ch.doc?.repo, ch.doc?.path]);

  // Push-to-talk (sin nota): TODO el fondo es zona de hablar. Mantenés apretado en cualquier lado
  // → graba; tocás de nuevo → para. El orbe NO se mueve (queda centrado): la talkzone dispara/
  // frena la grabación sin trasladar el orbe.
  const talkingRef = useRef(false);

  // Feedback INMEDIATO del orbe al tap: en cuanto tocás (pointerdown en idle) marcamos `armed` de
  // forma SINCRÓNICA y el orbe reacciona YA (estado visual "recording" optimista, ver `orbStatus`),
  // SIN esperar a que el mic adquiera ni a que el turno arranque. El `status="recording"` REAL —y el
  // nivel del mic que dibuja la onda— siguen gateados detrás del unmute (no pintamos onda falsa). Se
  // limpia cuando el status real toma la posta (recording/thinking/speaking) o cuando la grabación se
  // aborta sin llegar a arrancar. Desacopla el FEEDBACK del gesto del estado de mic/turno.
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  // Handle imperativo del orbe (lo rellena OrbCanvas al montar): nos deja cuequear el estado VISUAL
  // del orbe SINCRÓNICO en el pointerdown, en el MISMO frame del toque, sin esperar el re-render de
  // React ni el flush del useEffect([status]) de OrbCanvas. Esa cadena (setArmed→render→effect) era
  // el "tap muerto": el orbe recién reaccionaba un ciclo después. Con el cue directo, el engine ya
  // arranca a morfear apenas tocás; `armed`/`orbStatus` siguen sincronizando el resto (className,
  // hint, A11y) y re-aplican el mismo estado (idempotente, no se duplica).
  const orbHandleRef = useRef<OrbHandle | null>(null);
  const arm = useCallback((on: boolean) => {
    armedRef.current = on;
    setArmed(on);
  }, []);

  // Grabación (tap-to-toggle): refs de timers y estado auxiliar. `handsfreeRef`/`handsfree` es EL
  // estado de grabación (entrado por tap; antes se entraba por slide-up, ya removido).
  const handsfreeT0Ref = useRef<number>(0);
  const [handsfreeElapsed, setHandsfreeElapsed] = useState(0);
  const handsfreeTimerRef = useRef<number | undefined>(undefined);
  const handsfreeDurationTimerRef = useRef<number | undefined>(undefined);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // Cleanup de timers de manos libres al desmontar.
  useEffect(() => {
    return () => {
      if (handsfreeTimerRef.current !== undefined) window.clearInterval(handsfreeTimerRef.current);
      if (handsfreeDurationTimerRef.current !== undefined)
        window.clearTimeout(handsfreeDurationTimerRef.current);
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
    };
  }, []);

  // Entra en modo manos libres: graba indefinidamente hasta que el usuario toque o presione Escape.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs y funciones estables; exitHandsfree se llama desde el timeout del timer (ref-stable via closure), no como dep del hook.
  const enterHandsfree = useCallback(() => {
    const t0 = Date.now();
    handsfreeT0Ref.current = t0;
    handsfreeRef.current = true;
    setHandsfree(true);
    setHandsfreeElapsed(0);
    // Actualiza el timer cada 500ms
    handsfreeTimerRef.current = window.setInterval(() => {
      setHandsfreeElapsed(Date.now() - handsfreeT0Ref.current);
    }, 500);
    // Auto-stop al límite hard (60 min)
    handsfreeDurationTimerRef.current = window.setTimeout(() => {
      exitHandsfree(false);
      ch.stopRecording();
    }, MAX_HANDSFREE_MS);
    // Wake lock (best-effort: evita que la pantalla se apague)
    if ("wakeLock" in navigator) {
      navigator.wakeLock
        .request("screen")
        .then((lock) => {
          wakeLockRef.current = lock;
        })
        .catch(() => {
          /* best-effort */
        });
    }
  }, [ch]);

  // Termina el estado de grabación. cancel=true → descarta; cancel=false → el caller llama
  // stopRecording (envía). Único punto de salida de la grabación: centraliza la limpieza de
  // timers/wakeLock y resetea `talkingRef` (sin esto quedaba colgado y reactivaba la grabación).
  const exitHandsfree = useCallback(
    (cancel: boolean) => {
      handsfreeRef.current = false;
      setHandsfree(false);
      setHandsfreeElapsed(0);
      talkingRef.current = false;
      arm(false); // salida de grabación → soltamos el feedback optimista del orbe
      // Orbe en su posición de reposo (ya no hay slide-up; orbDragDy queda en 0).
      setOrbDragDy(0);
      if (handsfreeTimerRef.current !== undefined) {
        window.clearInterval(handsfreeTimerRef.current);
        handsfreeTimerRef.current = undefined;
      }
      if (handsfreeDurationTimerRef.current !== undefined) {
        window.clearTimeout(handsfreeDurationTimerRef.current);
        handsfreeDurationTimerRef.current = undefined;
      }
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
      if (cancel) ch.cancelRecording();
    },
    [ch, arm],
  );

  // El feedback optimista (`armed`) se suelta en cuanto el status REAL toma la posta (recording al
  // adquirir el mic, o thinking/speaking si el turno avanzó por otro lado): de ahí en más manda el
  // status real. Cubre también el caso de fallo de adquisición, donde startRecording vuelve a "idle"
  // con un caption de error sin pasar por exitHandsfree → si quedó `armed` pero no estamos grabando,
  // lo limpiamos. (No tocamos `armed` mientras seguimos en idle y grabando-por-arrancar.)
  useEffect(() => {
    if (!armedRef.current) return;
    if (ch.status !== "idle" || !handsfreeRef.current) arm(false);
  }, [ch.status, arm]);

  // Escape: cancela manos libres si está activo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && handsfreeRef.current) {
        exitHandsfree(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exitHandsfree]);

  // Gesto ÚNICO de voz: TAP para arrancar a grabar, TAP de nuevo para terminar y enviar. Sin hold
  // ni slide-up. Togglear en el pointerDOWN (no en el up) es clave: aunque un long-press dispare el
  // menú del browser —que emite pointercancel— la grabación NO se corta, porque sólo reaccionamos
  // al down (no hay handler de up/cancel). Y como el gesto es un tap (no un hold), ese menú casi
  // nunca llega a aparecer. La grabación sigue mientras usás el resto de la UI (FABs, chat); sólo
  // un tap en la zona de voz (fondo/orbe) la frena, o la ✕ la aborta.
  //
  // Tap MIENTRAS RESPONDE: el tap INTERRUMPE y PARA AHÍ — no hace barge-in (no arranca a grabar).
  // Pensando → cancela el turno (aborta la generación). Hablando → mutea el audio de ese turno (se
  // calla, pero el turno NO se cancela: el texto que quede sigue escribiéndose). En ambos, el
  // próximo tap (ya en idle) graba normal.
  const talkDown = (e: PointerEvent) => {
    e.preventDefault();
    if (offline) return;
    dismissGreeting();
    dbg(`talkzone tap (status=${ch.status}, grabando=${handsfreeRef.current})`);

    // Ya grabando → este tap FRENA. Si la grabación quedó muy corta (doble-tap accidental) la
    // descartamos en vez de enviar audio casi vacío.
    if (handsfreeRef.current) {
      const elapsed = Date.now() - handsfreeT0Ref.current;
      if (elapsed < TAP_DISCARD_MS) {
        exitHandsfree(true); // muy corta → descartar (no enviar)
      } else {
        exitHandsfree(false);
        ch.stopRecording(); // frena y ENVÍA
      }
      return;
    }

    // Respondiendo → el tap INTERRUMPE y PARA (no arranca a grabar): pensando cancela el turno,
    // hablando mutea el audio. En ambos casos cortamos acá; el próximo tap (ya en idle) graba.
    if (ch.status === "thinking") {
      ch.cancelTurn();
      return;
    }
    if (ch.status === "speaking") {
      ch.muteAudio();
      return;
    }

    // No grabando ni respondiendo (idle) → este tap ARRANCA a grabar.
    // Feedback INMEDIATO: PRIMERO el cue visual del orbe (imperativo, mismo frame del toque), ANTES
    // de cualquier trabajo del gesto. El engine empieza a morfear a "recording" YA, sin esperar el
    // re-render. Recién DESPUÉS hacemos el trabajo del gesto: arm() (sincroniza className/hint/A11y) y
    // startRecording() (setAudioSession play-and-record + getUserMedia) — que DEBEN quedar dentro de
    // la user-activation (ver memoria ios-audio-focus), por eso siguen acá, sincrónicos, pero detrás
    // del cue. Como el browser no pinta hasta que el handler retorna, poner el cue primero garantiza
    // que el estado del orbe ya esté en "recording" cuando llega el primer frame post-toque.
    orbHandleRef.current?.cue("recording");
    arm(true);
    talkingRef.current = true;
    ch.startRecording();
    enterHandsfree();
  };

  // Nota nueva: crea `Nueva nota.md` y la abre. Si hay archivo abierto, en su carpeta
  // (mismo repo). Si no, en la raíz de la wiki default. El nombre default es legible
  // ("Nueva nota") en vez de un timestamp; el user lo renombra editando el H1 y el
  // agente la ordena después. Misma convención que el agente sigue cuando el user dice
  // "hoja en blanco" / "nota nueva".
  const newNoteRepo = ch.doc?.repo ?? ch.defaultWiki;
  // El FAB "+" aparece a la derecha del toggle del explorador, sólo en la pantalla de
  // voz (sin nota abierta). Con una nota abierta, el "+" vive en la tira de pestañas.
  const newNoteAvailable = !offline && !!newNoteRepo;
  const newNote = async () => {
    if (!newNoteRepo) return;
    const dir = ch.doc ? (ch.doc.path.includes("/") ? ch.doc.path.replace(/\/[^/]*$/, "") : "") : "";
    // Como el nombre ya no es único por sí solo, ante colisión (409 "exists") probamos
    // "Nueva nota 2", "Nueva nota 3", … hasta encontrar uno libre.
    for (let n = 1; n <= 99; n++) {
      const basename = n === 1 ? "Nueva nota" : `Nueva nota ${n}`;
      const path = dir ? `${dir}/${basename}.md` : `${basename}.md`;
      try {
        const r = await fetch("/api/file", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // Cuerpo vacío (#10): el título es el nombre del archivo ("Nueva nota"), que el
          // editor muestra como H1 editable arriba; el cuerpo arranca limpio, sin repetir
          // el título. Renombrás editando ese H1.
          body: JSON.stringify({ repo: newNoteRepo, path, content: "" }),
        });
        if (r.status === 409) continue; // ya existe → probá el siguiente sufijo
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error || `create ${r.status}`);
        }
        ch.open(newNoteRepo, path, { newTab: true }); // nota nueva siempre en su propia pestaña
        return;
      } catch (e) {
        alert(`No pude crear: ${(e as Error)?.message ?? e}`);
        return;
      }
    }
  };

  // Pantalla de invitación: /invitacion?i=<token> — pre-auth, no depende del estado de sesión.
  // Se intercepta antes del boot/login para que el invitado la vea siempre (logueado o no).
  if (window.location.pathname === "/invitacion") return <InvitacionScreen />;

  // Boot: hasta saber si hay sesión, splash neutro (solo la marca, mismo layout que el login)
  // — NO el orbe. Sin esto se veía el orbe ~1s y después caía al login (el flash que molestaba).
  // De acá sale a la app (con sesión) o al login (sin sesión), seamless.
  if (ch.booting) {
    // Splash NEUTRO durante el boot (sin la marca ember): estando logueado, al recargar
    // parpadeaba como un "punto rojo" antes de la app. El login real (unauth) sí la muestra.
    return <main className="login-screen" />;
  }
  // Sin sesión → pantalla de login dedicada (NO el shell del orbe).
  if (ch.status === "unauth") return <LoginScreen denied={denied} waitlistedParam={waitlistedParam} />;

  // Estado del orbe para el FEEDBACK visual: si tocaste y todavía estamos adquiriendo el mic
  // (`armed` y el status real sigue en "idle"), mostramos "recording" optimista → el orbe reacciona
  // al instante. En cualquier otro caso manda el status REAL (que ya trae el "recording" de verdad
  // tras el unmute, o thinking/speaking/idle). La onda del mic NO se ve en esta ventana: su nivel
  // (`getMicLevel`) sigue gateado por el status real === "recording", así que no hay onda falsa.
  const orbStatus: typeof ch.status = armed && ch.status === "idle" ? "recording" : ch.status;

  return (
    <main
      className={`app ${pageOpen ? "app-page" : ""} ${explorerOpen ? "app-explorer" : ""} ${
        chatOpen ? "app-chat" : ""
      } ${handsfree ? "app-handsfree" : ""}`}
    >
      {DEBUG && <DebugOverlay status={ch.status} sseState={ch.sseState} lastEventAgo={ch.lastEventAgo} />}
      {/* Readout de debug del pipeline de grabación (detrás del toggle debugMode del cog): el owner
          graba una vez y lee la línea para ver dónde se rompe la captura en su iPhone. Off → null. */}
      {debugMode && <AudioDiag diag={ch.audioDiag} />}
      {/* Headless: fija el título de la pestaña del navegador ([dev]/[staging]) según el
          entorno, desde el load. No renderiza nada. Antes esto vivía en el Explorer y el
          prefijo del título no aparecía hasta abrir el explorer. Ver VersionBadge.tsx. */}
      <VersionBadge />
      {/* Toggle del explorador (abrir panel): arriba-IZQUIERDA. NO es parte de la columna de FABs
          de abajo-derecha (esa es orb/notas + nueva-nota + chat). Cerrado → abre (ícono panel).
          Abierto → en MOBILE el mismo botón se vuelve una ✕ arriba-derecha que lo cierra; en
          desktop el cierre vive DENTRO del header del explorer (acá se oculta: ver
          `.app-explorer .expbtn`). */}
      {!offline && (
        <button
          type="button"
          className="expbtn"
          onClick={() => setExplorerOpen((v) => !v)}
          aria-label={explorerOpen ? "Cerrar explorador" : "Explorar archivos"}
          data-tip={explorerOpen ? "Cerrar explorador" : "Explorar archivos"}
          data-tip-pos="right"
        >
          {explorerOpen ? <IconX /> : <IconPanelLeft />}
        </button>
      )}
      {explorerOpen && (
        <Explorer
          current={ch.doc ? { repo: ch.doc.repo, path: ch.doc.path } : null}
          revealTarget={revealTarget}
          handle={ch.handle}
          reloadSeq={ch.treeSeq}
          onOpen={(repo, path, newTab) => {
            // ⌘/Ctrl-click (o menú "Abrir en nueva pestaña") → pestaña nueva; click normal
            // → reemplaza el contenido de la pestaña activa (y lo empuja a su historial).
            ch.open(repo, path, newTab ? { newTab: true } : undefined);
            // En mobile el drawer (64vw) tapa la nota: al abrir una, cerramos el explorer.
            // En desktop queda abierto al lado (browse + leer). Breakpoint = el de mobile (32rem).
            if (window.matchMedia("(max-width: 32rem)").matches) setExplorerOpen(false);
          }}
          onClose={() => setExplorerOpen(false)}
          onFileGone={(repo, path) => ch.closeByPath(repo, path)}
          emojiForNote={emojiOf}
          onFileMoved={(repo, fromPath, toPath, isFolder) => ch.remapTabs(repo, fromPath, toPath, isFolder)}
          onFileMovedCross={(fromRepo, fromPath, toRepo, toPath) =>
            ch.remapTabsCross(fromRepo, fromPath, toRepo, toPath)
          }
          onFsOpBegin={ch.beginFsOp}
          onFsOpEnd={ch.endFsOp}
          runFsOp={ch.runFsOp}
          panel={explorerPanel}
          onPanelChange={setExplorerPanel}
          openSystemPages={openSystemPages}
          onOpenSystem={(id) => {
            ch.openSystem(id);
            // En mobile (explorer full-screen) abrir una página tapa el explorer → lo cerramos.
            if (window.matchMedia("(max-width: 32rem)").matches) setExplorerOpen(false);
          }}
          inboxItems={ch.inboxItems}
          inboxUnread={ch.inboxUnread}
          onOpenInboxItem={(id) => {
            // Re-inyecta la burbuja en el chat (lectura) y abre el chat; en mobile cierra el explorer.
            void ch.openInboxItem(id);
            setChatOpen(true);
            if (window.matchMedia("(max-width: 32rem)").matches) setExplorerOpen(false);
          }}
          onMarkAllInboxRead={() => void ch.markAllInboxReadLocal()}
        />
      )}

      {/* Vista de notas y páginas de sistema: la barra de arriba (tira de pestañas) y las
          flechas de navegación viven ACÁ — fuera del cuerpo keyed — para que NO se remonten
          al cambiar de archivo/pestaña. El cuerpo (editor) sí se remonta por su `key`. El
          mini-orbe va centrado horizontalmente en la barra (absoluto). */}
      {(pageOpen || ch.tabs.length > 0) && (
        <section className={`view${homeMode ? " view-home" : ""}`}>
          <header className="view-head view-head-tabs">
            <TabStrip
              tabs={ch.tabs}
              repoLabels={repoLabels}
              emojiOf={emojiOf}
              activeId={ch.activeTabId}
              onSelect={ch.selectTab}
              onClose={ch.closeTab}
              onReorder={ch.reorderTab}
              onRevealInExplorer={revealInExplorer}
              // "+" inline al final de la tira (estilo "nueva pestaña" del navegador): misma acción
              // que el FAB redondo. Sólo si se puede crear nota; la tira se oculta en mobile (CSS),
              // así que el inline queda desktop-only sin lógica extra.
              onNewNote={newNoteAvailable ? () => void newNote() : undefined}
            />
            {/* Con una nota abierta NO hay orbe sobre la nota: la entrada de voz/texto es el chat
                (FAB abajo-derecha). El orbe único vive sólo en la pantalla de voz (sin nota). */}
            {/* Cerrar la nota abierta: en mobile la tira de pestañas (con su ✕ por tab) está oculta,
                así que el ✕ de cierre vive ACÁ, dentro del header. Mobile-only (CSS): en desktop se
                cierra desde la ✕ de cada pestaña. */}
            <button
              type="button"
              className="note-close-head"
              onClick={() => ch.closeDoc()}
              aria-label="Cerrar"
            >
              <IconX />
            </button>
          </header>
          {/* Botonera del margen superior IZQUIERDO de la nota (estilo Obsidian): flechas
              back/forward del historial de la pestaña + el toggle de blame ("quién escribió
              qué"). NO aplica en páginas de sistema (sin historial ni blame): se oculta. */}
          {noteOpen && (ch.canBack || ch.canForward || blameAvailable) && (
            <div className="view-nav">
              {(ch.canBack || ch.canForward) && (
                <>
                  <button
                    type="button"
                    className="nav-btn"
                    onClick={(e) => ch.navBack(e.metaKey || e.ctrlKey)}
                    disabled={!ch.canBack}
                    aria-label="Atrás"
                    data-tip="Atrás"
                  >
                    <IconArrowLeft size={18} />
                  </button>
                  <button
                    type="button"
                    className="nav-btn"
                    onClick={(e) => ch.navForward(e.metaKey || e.ctrlKey)}
                    disabled={!ch.canForward}
                    aria-label="Adelante"
                    data-tip="Adelante"
                  >
                    <IconArrowRight size={18} />
                  </button>
                </>
              )}
              {/* El toggle de blame ya NO vive acá: es una preferencia global en Configuración
                  → Ediciones (Explorer → activity bar → Configuración). */}
            </div>
          )}
          {/* Página de sistema activa: renderiza el panel correspondiente como página en el
              área del editor. La ✕ la da la tab (cerrar pestaña). `doc=null` en este caso
              (F1). Los componentes se reusan tal cual; solo cambia dónde se montan. */}
          {ch.activeTab?.kind === "system" && !offline && (
            <SystemPageView
              page={ch.activeTab.page}
              onClose={() => ch.closeDoc()}
              onOpen={ch.open}
              theme={theme}
              setTheme={setTheme}
              debugMode={debugMode}
              setDebugMode={setDebugMode}
              hintsEnabled={hintsEnabled}
              setHintsEnabled={setHintsEnabled}
              blameOn={blameOn}
              setBlameOn={setBlameOn}
              name={ch.name}
              location={ch.location}
              handle={ch.handle}
              email={ch.email}
              hasPassword={ch.hasPassword}
              hasAvatar={ch.hasAvatar}
              avatarVersion={ch.avatarVersion}
              refreshProfile={ch.refreshProfile}
              mics={ch.mics}
              micsAuthorized={ch.micsAuthorized}
              micId={ch.micId}
              setMic={ch.setMic}
              voice={ch.voice}
              setVoice={ch.setVoice}
              setVoiceLang={ch.setVoiceLang}
              setRate={ch.setRate}
              model={ch.model}
              setModel={ch.setModel}
              bgQueries={ch.bgQueries}
              saveBgQueries={ch.saveBgQueries}
            />
          )}
          {noteOpen && ch.doc && (
            <WikiViewBody
              // El `key` es SOLO el id de la entrada: el remount queda para el cambio REAL de
              // documento (abrir otro archivo/pestaña). Un cambio externo de la MISMA nota ya
              // NO remonta (Fase C): el refetch hace setDoc y el editor lo aplica como
              // transacción CM6 (buffer limpio) o lo difiere a un banner (buffer dirty) —
              // cursor/scroll/folds intactos. Ver Editor.tsx / externalChange.ts.
              key={ch.doc.id}
              doc={ch.doc}
              emoji={emojiOf(ch.doc.repo, ch.doc.path)}
              onSetEmoji={setNoteEmoji}
              tabId={ch.activeTabId ?? ""}
              scrollMemo={wikiScrollMemo}
              scrollPositions={scrollPositionsRef}
              handle={ch.handle}
              blameOn={blameAvailable && blameOn}
              blameAvailable={blameAvailable}
              onToggleBlame={() => setBlameOn(!blameOn)}
              selfHandle={ch.handle}
              onSaved={ch.patchDoc}
              onRename={ch.renameDoc}
              onOpen={ch.open}
              isArchivedRepo={archivedRepoNames.has(ch.doc.repo)}
              isPathUnderFsOp={ch.noteHasInflightFsOp}
            />
          )}
        </section>
      )}

      {/* Dock del orbe: SÓLO en pantalla "sólo voz" (sin nota), centrado. La ventana principal
          muestra SOLO el orbe (+ el hint de onboarding): ni la transcripción del usuario ni las
          respuestas del agente van acá — todo eso vive en el pop-up del chat (`messages`). Con
          una nota abierta el orbe NO existe (pedido del owner): el mic del chat es la entrada de
          voz; se abre el chat con el FAB. El dock CONVIVE con el chat abierto (pedido del owner):
          el orbe y la talkzone siguen activos detrás. El panel del chat (z-index 35) queda POR
          ENCIMA del dock (2) y de la talkzone (1), así un tap en el chat va al chat y un tap en el
          FONDO (fuera del chat) dispara el orbe push-to-talk vía la talkzone. */}
      {!pageOpen && (
        <div className="dock">
          {/* Zona de hablar a pantalla completa: mantené apretado en CUALQUIER lado del fondo →
              graba; soltás → para. El orbe NO se mueve (queda centrado). Va detrás del orbe y de los
              botones (z-index bajo + .dock pointer-events:none), así un tap en un botón hace lo del
              botón, no hablar. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: superficie de push-to-talk de fondo; el control accesible alternativo es el mic del chat */}
          {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-label describe la zona de voz para lectores de pantalla; es una superficie de gesto, no un widget con rol */}
          <div
            className="talkzone"
            aria-label="Tocá para hablar — tocá de nuevo para terminar y enviar"
            onPointerDown={talkDown}
            onContextMenu={(e) => e.preventDefault()}
          />
          {/* Saludo de bienvenida (estilo Claude): tipografía grande sobre el orbe, ANTES de la
              primera interacción de la sesión. Se va elegante (clase greeting-leaving) apenas le
              hablás o escribís, y no vuelve a aparecer en la sesión. */}
          {greetPhase !== "gone" && !offline && (
            <p className={`greeting greeting-${greetPhase}`} aria-live="polite">
              <span className="greeting-inner">{buildGreeting(greetTpl, ch.name)}</span>
            </p>
          )}
          {/* El orbe vive en un wrapper estático (.orb-mover): SIEMPRE centrado.
              Durante el swipe-up, se traslada verticalmente 1:1 con el dedo (orbDragDy ≤0).
              Al entrar en manos libres, queda en esa posición. Al salir, vuelve a 0 con
              transición suave (clase orb-mover-returning activa mientras orbDragDy===0
              post-handsfree — el transition se aplica solo al retorno, no al drag).
              El orbe en sí es pointer-events:none → los presses caen en la talkzone de atrás.
              El hint vive DENTRO del wrapper: refleja el estado básico del orbe. */}
          <div
            className={`orb-mover${orbDragDy === 0 ? " orb-mover-returning" : ""}`}
            style={orbDragDy !== 0 ? { transform: `translateY(${orbDragDy}px)` } : undefined}
          >
            <div className={`orb orb-${orbStatus}${armed ? " orb-armed" : ""}`} aria-hidden="true">
              {WEBGL_ORB ? (
                <OrbCanvas
                  status={orbStatus}
                  activity={ch.activity}
                  subAgentActive={ch.subAgent !== null || ch.subagentCount > 0}
                  subagentCount={ch.subagentCount}
                  audioLevel={ch.getAudioLevel}
                  micLevel={ch.getMicLevel}
                  handleRef={orbHandleRef}
                />
              ) : (
                <span className="orb-core" />
              )}
            </div>
            {/* Underhints DEBAJO del orbe (in-flow): el principal pegado al orbe y el sub (sub-agentes)
                debajo. Van acá —no arriba— para no solaparse con la frase de bienvenida (que va sobre
                el orbe). El orbe no se mueve: los hints están siempre, así que su altura no cambia al
                grabar; la onda (absolute) y los controles (fixed) no afectan el layout del orbe. */}
            <OrbHint text={hintText} status={ch.status} phase={hintPhase} />
            <OrbHint text={subHintText} status={ch.status} phase={subHintPhase} variant="sub" />
          </div>
          {/* Cluster de grabación FIJO al borde inferior de la pantalla (independiente del orbe y de
              los hints): la onda (full-width, borde a borde) ARRIBA y los controles (rec dot + tiempo
              + ✕ cancelar) abajo, a X del bottom edge. La onda es pointer-events:none → un tap sobre
              ella atraviesa a la talkzone y frena la grabación; la ✕ recibe el click para abortar. */}
          {handsfree && (
            <div className="handsfree-bottom">
              <div className="handsfree-wave-wrap">
                <MicWave
                  level={ch.getMicLevel}
                  samples={220}
                  className="micwave micwave-handsfree"
                  background={false}
                  levelScale={0.5}
                />
              </div>
              <div className="handsfree-controls">
                <span className="handsfree-dot" aria-hidden="true" />
                <span className="handsfree-timer" aria-hidden="true">
                  {formatHandsfreeTime(handsfreeElapsed)}
                </span>
                <button
                  type="button"
                  className="handsfree-cancel"
                  aria-label="Cancelar grabación"
                  onClick={() => exitHandsfree(true)}
                >
                  <IconX />
                </button>
              </div>
            </div>
          )}
          {/* Sin permiso de mic: NO mostramos botón aparte. El orbe sigue reflejando al agente; el
              primer press que necesite audio dispara el prompt de permiso lazy
              (talkDown → startRecording → getUserMedia). */}
          {/* Modo debug: log de las herramientas que va usando el agente en el turno (lo "mismo"
              que Telegram). Toggle local en el cog; sólo se muestra si hay algo que mostrar. */}
          {debugMode && ch.activityLog.length > 0 && <ActivityLog entries={ch.activityLog} />}
          {/* Versión del deploy (SHA + entorno), discreta abajo-izquierda. Mismo criterio de
              visibilidad que el badge del explorer (prod oculto salvo ?debugVersion=1). */}
          <HomeVersion />
        </div>
      )}

      {/* Columna de FABs abajo-DERECHA (mobile y desktop): "+" nueva-nota y el botón orb/notas
          (minimizar/restaurar) apilados ARRIBA del botón de chat, como una sola columna. El toggle del
          explorador (abrir panel) NO va acá — vive arriba-izquierda (más arriba en el render). En
          DESKTOP, al abrir el chat la columna se corre hacia arriba para no quedar tapada por la
          tarjeta (ver `.fab-column` en index.css). La visibilidad por estado (sin tabs, chat abierto,
          maximized) la maneja el CSS/condición de cada botón. Las páginas del sistema y las
          notificaciones ya NO son FABs: viven en la activity bar del explorador (ver Explorer.tsx). */}
      <div className="fab-column">
        {/* "+" nota nueva: sólo sin página ni chat abiertos (con chat, el composer ya la trae; con
            página, el "+" vive inline en la tira de tabs). Con explorer abierto se oculta (CSS). */}
        {!pageOpen && !chatOpen && newNoteAvailable && (
          <button
            type="button"
            className="newnote-btn"
            onClick={() => void newNote()}
            aria-label="Nota nueva"
            data-tip="Nota nueva"
            data-tip-pos="left"
          >
            <IconPlus />
          </button>
        )}
        {/* orb/notas (minimizar/restaurar): con nota abierta → ícono orb (click minimiza → home);
            en home → ícono cuaderno (restaura la última tab activa). Solo con tabs vivas. */}
        {ch.tabs.length > 0 && (
          <button
            type="button"
            className="minimize-fab"
            onClick={() => {
              if (homeMode) {
                const resumeId = lastActiveTabIdRef.current ?? ch.tabs[0]?.id;
                if (resumeId) ch.selectTab(resumeId);
              } else {
                ch.goHome();
              }
            }}
            aria-label={homeMode ? "Restaurar notas" : "Minimizar notas"}
            data-tip={homeMode ? "Restaurar notas" : "Minimizar notas"}
            data-tip-pos="left"
          >
            {homeMode ? <IconBookOpen /> : <IconOrb />}
          </button>
        )}
        {/* chat: ancla inferior de la columna. Abierto → se reemplaza por la tarjeta (abajo). */}
        {!offline && !chatOpen && (
          <button
            type="button"
            className="chat-fab"
            onClick={() => setChatOpen(true)}
            aria-label="Abrir chat"
            data-tip="Abrir chat"
            data-tip-pos="left"
          >
            <IconMessage />
          </button>
        )}
      </div>
      {chatOpen && (
        <ChatPanel
          messages={ch.messages}
          voicePlayback={ch.voicePlayback}
          onVoiceToggle={ch.toggleVoicePlayback}
          onVoiceSeek={ch.seekVoicePlayback}
          onResend={ch.resend}
          chatStartedAt={ch.chatStartedAt}
          chatTitle={ch.chatTitle}
          status={ch.status}
          activity={ch.activity}
          subagentCount={ch.subagentCount}
          offline={offline}
          debugMode={debugMode}
          activityLog={ch.activityLog}
          canSend={canSendText}
          draft={textDraft}
          setDraft={setTextDraft}
          onSubmit={onSubmitText}
          attachments={attachments}
          addFiles={addFiles}
          removeAttachment={removeAttachment}
          attachNote={attachNote}
          startRec={ch.startRecording}
          stopRec={ch.stopRecording}
          micLevel={ch.getMicLevel}
          onInteract={dismissGreeting}
          onClose={() => setChatOpen(false)}
        />
      )}
    </main>
  );
}

// El panel de notificaciones (inbox del agente) se movió a Explorer.tsx (NotifPanel): ahora es
// un panel de la activity bar, no un popup flotante. La lógica de datos sigue en useChannel.

// Log de actividad del modo debug (toggle del cog): la lista de herramientas que el agente
// fue usando en el turno (frames `activity`, ya humanizados server-side). Es lo "mismo" que
// muestra Telegram con /debug on, pero acá vive en la web y se gobierna con un toggle local.
// Readout de debug del pipeline de grabación (detrás de debugMode): overlay chico, fixed, monospace,
// semi-transparente y pointer-events:none — el owner graba una vez y lee esta línea para ver dónde se
// rompe la captura en el dispositivo (no reproducible en desktop). Vacío → no renderiza nada.
function AudioDiag({ diag }: { diag: string }) {
  if (!diag) return null;
  return (
    <div
      role="status"
      aria-label="Diagnóstico de grabación (debug)"
      // Readout de debug del pipeline de grabación. Vive en el BORDE IZQUIERDO, centrado
      // verticalmente (mid-left) — la única zona libre en todos los estados: antes iba
      // abajo-izquierda y pisaba el badge de versión + la atribución de Unsplash (que ahora
      // viven ahí). El resto de los readouts de debug: FPS arriba-der, DebugOverlay arriba
      // full-width. Cap de ancho para no cruzar el centro donde está el orbe.
      style={{
        position: "fixed",
        left: "max(0.5rem, env(safe-area-inset-left))",
        top: "50%",
        transform: "translateY(-50%)",
        zIndex: 9999,
        maxWidth: "min(20rem, calc(50vw - 5rem))",
        padding: "4px 6px",
        background: "rgba(0,0,0,0.62)",
        color: "#9effa0",
        font: "11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        borderRadius: 4,
        pointerEvents: "none",
      }}
    >
      {diag}
    </div>
  );
}

function ActivityLog({ entries }: { entries: ActivityEntry[] }) {
  return (
    <div className="activity-log" role="log" aria-label="Actividad del agente (debug)">
      <span className="activity-log-head">Herramientas</span>
      <ul className="activity-log-list">
        {entries.map((e) => (
          <li key={e.id} className="activity-log-item">
            {e.detail ? `${e.label}: ${e.detail}` : e.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Overlay de debug (?debug=1): pinta status + estado del SSE + un log de eventos (pointer y
// SSE) para ver EN MOBILE qué pasa con la grabación y el canal. Re-renderea cada 500ms.
function DebugOverlay({
  status,
  sseState,
  lastEventAgo,
}: {
  status: ReturnType<typeof useChannel>["status"];
  sseState: () => number;
  lastEventAgo: () => number;
}) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);
  const SSE = ["CONNECTING", "OPEN", "CLOSED"];
  const rs = sseState();
  const ago = lastEventAgo();
  return (
    <div className="debug-overlay">
      <div className="debug-head">
        status=<b>{status}</b> · sse=<b>{rs < 0 ? "—" : (SSE[rs] ?? String(rs))}</b> · últ.evt=
        <b>{ago < 0 ? "—" : `${Math.round(ago / 1000)}s`}</b>
      </div>
      <div className="debug-log">
        {DEBUG_LOG.slice(-16).map((e) => (
          <div key={e.id}>
            {new Date(e.t).toLocaleTimeString()} {e.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

// Indicador EFÍMERO de actividad en el chat: mientras el agente trabaja (status "thinking"),
// muestra "···" (tres puntos animados) + la actividad live (`activity`, ej. "actualizando nota —
// viajes/japón"; sin actividad, sólo los puntos). Se actualiza en vivo desde `ch.status`+`ch.activity`
// y DESAPARECE al cerrar el turno. NO se inserta en el historial (no es un mensaje permanente): se
// renderiza al final de la lista de mensajes como el assistant "pendiente".
// Indicador PERSISTENTE de sub-agente en el chat: mientras el agente tiene ≥1 sub-agente del
// roster trabajando (`count` = frame `subagents` del backend), una línea fija con un orbe ⦿ y
// "N sub-agente(s) trabajando…". A diferencia del indicador EFÍMERO (ChatActivityIndicator), NO
// se pisa con cada tool-call: dura todo el turno y sólo desaparece cuando el conteo vuelve a 0
// (fin del turno). Es la contraparte en el chat de los mini-orbs del orb (que no existen con una
// nota abierta) — la única señal de "estoy delegando" cuando no se ve el orb.
function ChatSubagentBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  const label = count === 1 ? "1 sub-agente trabajando…" : `${count} sub-agentes trabajando…`;
  return (
    <div className="chat-subagent" role="status" aria-live="polite">
      <span className="chat-subagent-orb" aria-hidden="true" />
      <span className="chat-subagent-label">{label}</span>
    </div>
  );
}

function ChatActivityIndicator({ status, activity }: { status: Status; activity: string | null }) {
  if (status !== "thinking") return null;
  return (
    <div className="chat-msg chat-msg-agent">
      <div className="chat-bubble chat-bubble-agent chat-activity">
        <span className="chat-thinking" role="status" aria-label="pensando">
          <span />
          <span />
          <span />
        </span>
        {activity && <span className="chat-activity-label">{activity}</span>}
      </div>
    </div>
  );
}

// Chat popup (panel abajo-derecha): historial de la conversación + composer. Reemplaza la
// vieja barra de texto fija. El historial vive en `useChannel` (messages, solo-sesión); este
// componente sólo lo pinta y maneja el input. El mic es hold-para-grabar (mismo push-to-talk
// que el orbe): mientras grabás, el input se reemplaza por los palitos reactivos (MicWave).
function ChatPanel({
  messages,
  voicePlayback,
  onVoiceToggle,
  onVoiceSeek,
  onResend,
  chatStartedAt,
  chatTitle: chatTitleProp,
  status,
  activity,
  subagentCount,
  offline,
  debugMode,
  activityLog,
  canSend,
  draft,
  setDraft,
  onSubmit,
  attachments,
  addFiles,
  removeAttachment,
  attachNote,
  startRec,
  stopRec,
  micLevel,
  onInteract,
  onClose,
}: {
  messages: ChatMessage[];
  /** Reproducción de voz EN CURSO atada a una burbuja (autoplay del turno por voz): la burbuja
   *  con ese msgId pinta el player espejo en vez del `<audio controls>` muerto. */
  voicePlayback: VoicePlayback | null;
  onVoiceToggle: () => void;
  onVoiceSeek: (t: number) => void;
  /** Reintenta un envío fallido (burbuja del usuario marcada `failed`, Fase B.2). */
  onResend: (msgId: string) => void;
  chatStartedAt?: number;
  chatTitle?: string;
  status: ReturnType<typeof useChannel>["status"];
  activity: string | null;
  subagentCount: number;
  offline: boolean;
  debugMode: boolean;
  activityLog: ActivityEntry[];
  canSend: boolean;
  draft: string;
  setDraft: (v: string) => void;
  onSubmit: (e: FormEvent) => void;
  attachments: PendingAttachment[];
  addFiles: (files: File[] | FileList) => void;
  removeAttachment: (id: string) => void;
  attachNote: string;
  startRec: () => void;
  stopRec: () => void;
  micLevel: () => number;
  onInteract: () => void;
  onClose: () => void;
}) {
  const recording = status === "recording";
  // Maximizar: el panel pasa de popup-en-el-rincón a ocupar el área de contenido (el espacio
  // de las notas). Preferencia de layout persistida en localStorage (global). En mobile el
  // panel YA es full-screen, así que el botón se esconde por CSS y esto queda inocuo.
  const [maximized, setMaximized] = useState(() => {
    try {
      return localStorage.getItem(CHAT_MAX_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleMaximized = () => {
    setMaximized((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(CHAT_MAX_KEY, next ? "1" : "0");
      } catch {
        /* localStorage no disponible */
      }
      return next;
    });
  };
  // Selector de archivos oculto: el botón "+" lo dispara. Se resetea tras elegir para poder
  // re-elegir el MISMO archivo (onChange no dispara si el value no cambia).
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Auto-grow del textarea del composer: crece con el contenido (alto = scrollHeight) hasta el
  // tope que fija el CSS (max-height) y de ahí scrollea interno. Reseteamos a "auto" antes de
  // medir para que también ACHIQUE al borrar/mandar. Corre en cada cambio de `draft` (incluido
  // el reset a "" tras enviar).
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-medimos al cambiar `draft` (el valor vive en el DOM, no se referencia acá)
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);
  // Drag-drop sobre el panel: contador de enter/leave (los hijos disparan dragleave) para
  // saber si el cursor sigue adentro y pintar el overlay "soltá acá".
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const onDragEnter = (e: DragEvent<HTMLElement>) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOver = (e: DragEvent<HTMLElement>) => {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
  };
  const onDragLeave = (e: DragEvent<HTMLElement>) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (e: DragEvent<HTMLElement>) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (canSend) addFiles(e.dataTransfer.files);
  };
  // Título del chat: el resumen semántico del tema actual (lo genera el gateway con haiku y
  // llega por SSE). Mientras no haya uno, caemos al "Chat: <fecha de inicio del caché>" (o sólo
  // "Chat" si todavía no chateaste). Fecha legible en es-AR (ej. "5 jun 2026").
  const dateTitle = chatStartedAt
    ? `Chat: ${new Date(chatStartedAt).toLocaleDateString("es-AR", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })}`
    : "Chat";
  const chatTitle = chatTitleProp?.trim() || dateTitle;
  // Auto-scroll al fondo cuando entra un turno nuevo o cambia el último (streaming/thinking).
  // Sólo el largo + el id/texto del último mensaje como señal (no el array entero).
  const bodyRef = useRef<HTMLDivElement>(null);
  const last = messages[messages.length - 1];
  // biome-ignore lint/correctness/useExhaustiveDependencies: las señales del último turno alcanzan
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, last?.text, last?.thinking]);

  // Mic = hold para grabar (sólo desde idle; al SOLTAR manda). NO corta thinking/speaking
  // como el orbe — acá es puramente "mandar un audio". Capturamos el pointer en el down
  // Mic TAP-TOGGLE (estilo la app de Claude): un toque empieza a grabar; el botón pasa a un
  // ✓ y otro toque termina y manda. NADA de mantener apretado (mejor en mobile). Es onClick,
  // no pointer hold.
  const micToggle = () => {
    if (offline) return;
    if (recording) stopRec();
    else if (status === "idle") {
      onInteract(); // primera interacción → el saludo se va
      startRec();
    }
  };

  return (
    <section
      className={`chatpanel ${maximized ? "maximized" : ""}`}
      aria-label="Chat con el asistente"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Overlay de drop: aparece mientras arrastrás archivos sobre el panel. */}
      {dragging && (
        <div className="chatpanel-drop" aria-hidden="true">
          <IconPlus />
          <span>Soltá tus imágenes o PDF acá</span>
        </div>
      )}
      {/* Header: título "Chat: <fecha>" a la izquierda y el MISMO botón de cerrar que la nota
          (la ✕ redonda) a la derecha, por consistencia con el resto del chrome. */}
      <header className="chatpanel-head">
        <span className="chatpanel-title">{chatTitle}</span>
        <div className="chatpanel-head-actions">
          {/* Maximizar ⇄ restaurar: el mismo botón cambia de ícono/label. Escondido en mobile
              (ahí el chat ya es full-screen) vía .chatpanel-maximize-btn en el media query. */}
          <button
            type="button"
            className="view-close chatpanel-maximize-btn"
            onClick={toggleMaximized}
            aria-label={maximized ? "Restaurar chat" : "Maximizar chat"}
            aria-pressed={maximized}
            data-tip={maximized ? "Restaurar" : "Maximizar"}
            data-tip-pos="left"
          >
            {maximized ? <IconMinimize /> : <IconMaximize />}
          </button>
          <button
            type="button"
            className="view-close"
            onClick={onClose}
            aria-label="Cerrar chat"
            data-tip="Cerrar"
            data-tip-pos="left"
          >
            <IconX />
          </button>
        </div>
      </header>
      <div className="chatpanel-body" ref={bodyRef}>
        {messages.length === 0 ? (
          <p className="chatpanel-empty">Escribile o mandale un audio para empezar.</p>
        ) : (
          messages.map((m) => (
            <ChatBubble
              key={m.id}
              msg={m}
              playback={voicePlayback?.msgId === m.id ? voicePlayback : null}
              onVoiceToggle={onVoiceToggle}
              onVoiceSeek={onVoiceSeek}
              onResend={onResend}
            />
          ))
        )}
        {/* Indicador PERSISTENTE de sub-agente: mientras hay ≥1 sub-agente vivo (subagentCount > 0)
            una línea fija "⦿ N sub-agente(s) trabajando…" que NO se pisa entre tool-calls (a
            diferencia del indicador efímero de abajo). Se apaga sólo cuando el conteo vuelve a 0
            (fin del turno). Con una nota abierta no hay orb, así que el chat es la única indicación
            de que el agente está delegando. */}
        <ChatSubagentBadge count={subagentCount} />
        {/* Indicador EFÍMERO de actividad: mientras el agente trabaja, "···" + el tool-call en
            curso (`activity`) al lado. NO es un mensaje del array (no se persiste en el historial);
            se actualiza en vivo y desaparece al cerrar el turno. */}
        <ChatActivityIndicator status={status} activity={activity} />
        {/* Modo debug: el log de herramientas del turno, inline en la conversación (lo "mismo"
            que Telegram). Sólo si el toggle del cog está prendido y hay algo que mostrar. */}
        {debugMode && activityLog.length > 0 && <ActivityLog entries={activityLog} />}
      </div>
      {/* Bandeja de adjuntos pendientes (arriba del composer): miniatura por imagen, chip por
          PDF, cada uno con su ✕ para sacarlo. Sólo se monta si hay algo adjunto. */}
      {(attachments.length > 0 || attachNote) && (
        <div className="composer-tray">
          {attachNote && <p className="composer-tray-note">{attachNote}</p>}
          {attachments.length > 0 && (
            <div className="composer-chips">
              {attachments.map((a) => (
                <div key={a.id} className="composer-chip" title={a.name}>
                  {ATTACH_IMAGE_MIMES.has(a.mime) ? (
                    <img className="composer-chip-thumb" src={a.url} alt={a.name} />
                  ) : (
                    <span className="composer-chip-doc">PDF</span>
                  )}
                  <span className="composer-chip-name">{a.name}</span>
                  <button
                    type="button"
                    className="composer-chip-x"
                    onClick={() => removeAttachment(a.id)}
                    aria-label={`Quitar ${a.name}`}
                    title="Quitar"
                  >
                    <IconX />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {/* Composer: el campo (input/onda) tiene caja ESTÁTICA — la onda se superpone al input
          (absolute) mientras grabás, así el mic NO se corre. El "+", el mic y el enviar quedan
          siempre montados (el `up` del mic corta la grabación). */}
      <form className="chatpanel-composer" onSubmit={onSubmit}>
        {/* Selector de archivos oculto + botón "+" a la izquierda (imágenes / PDF). */}
        <input
          ref={fileInputRef}
          type="file"
          className="composer-file"
          accept={ATTACH_ACCEPT}
          multiple
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files);
            e.target.value = ""; // permite re-elegir el mismo archivo
          }}
          tabIndex={-1}
          aria-hidden="true"
        />
        <button
          type="button"
          className="composer-icon composer-attach"
          disabled={!canSend}
          aria-label="Adjuntar imágenes o PDF"
          data-tip="Adjuntar imágenes o PDF"
          data-tip-pos="top"
          onClick={() => fileInputRef.current?.click()}
        >
          <IconPlus />
        </button>
        <div className="composer-field">
          <textarea
            ref={inputRef}
            rows={1}
            className="composer-input"
            placeholder={canSend ? "escribí…" : ""}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter manda; Shift+Enter inserta salto de línea. El guard de isComposing
              // evita mandar a mitad de una composición de IME (acentos/CJK).
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            disabled={!canSend}
            aria-label="Mandale un mensaje de texto"
            autoComplete="off"
          />
          {recording && <MicWave level={micLevel} />}
        </div>
        {/* Mic TAP-TOGGLE: un toque graba (pasa a ✓), otro toque termina y manda. */}
        <button
          type="button"
          className={`composer-icon composer-mic${recording ? " composer-mic-on" : ""}`}
          aria-disabled={offline || (status !== "idle" && !recording)}
          aria-label={recording ? "Terminar y enviar el audio" : "Grabar un audio"}
          data-tip={recording ? "Terminar y enviar" : "Grabar un audio"}
          data-tip-pos="top"
          onClick={micToggle}
        >
          {recording ? <IconCheck /> : <IconMic />}
        </button>
        {/* Enviar texto/adjuntos. Mientras grabás NO desaparece: queda visible pero
            deshabilitado y grayed (la acción para mandar el audio es el ✓ del mic). Habilitado
            si hay texto O adjuntos. */}
        <button
          type="submit"
          className="composer-send"
          disabled={!canSend || (!draft.trim() && attachments.length === 0)}
          aria-label="Enviar"
          data-tip="Enviar"
          data-tip-pos="top"
        >
          <IconArrowUp />
        </button>
      </form>
    </section>
  );
}

// Overrides de render para el markdown del chat. Los links del agente abren SIEMPRE en otra
// pestaña del browser (`target=_blank` + `rel=noopener noreferrer`): pedido del owner — un click
// nunca debe navegar el SPA y sacar la sesión ("no se va ceibo"). El texto del agente es
// prompt-injectable: `chatLinkRender` (reusa classifyLink) baja un esquema peligroso
// (`javascript:`/`data:`/…) a texto plano, sin href clickeable. Ver chatLink.ts.
const CHAT_MD_COMPONENTS: Components = {
  a({ href, children }) {
    const link = chatLinkRender(href);
    return link.render === "link" ? (
      <a href={link.href} target={link.target} rel={link.rel}>
        {children}
      </a>
    ) : (
      children
    );
  },
};

// Una burbuja del chat. Usuario = texto plano alineado a la derecha (con un glifo de mic si
// fue por voz). Agente = markdown (react-markdown + gfm) a la izquierda; si está "pensando"
// y todavía sin texto, muestra los puntitos. `playback` ≠ null = el audio de ESTA burbuja se
// está auto-reproduciendo por el <audio> compartido del canal → se pinta el player espejo.
function ChatBubble({
  msg,
  playback,
  onVoiceToggle,
  onVoiceSeek,
  onResend,
}: {
  msg: ChatMessage;
  playback: VoicePlayback | null;
  onVoiceToggle: () => void;
  onVoiceSeek: (t: number) => void;
  onResend: (msgId: string) => void;
}) {
  if (msg.role === "system") {
    // Aviso de sistema (conversación compactada / reiniciada): línea centrada y atenuada, estilo
    // divisor, distinta de una burbuja de usuario/agente. No tiene voz ni adjuntos ni reintentos.
    return (
      <div className="chat-msg chat-msg-system">
        <span className="chat-system-line" role="status">
          {msg.text}
        </span>
      </div>
    );
  }
  if (msg.role === "user") {
    return (
      <div className={`chat-msg chat-msg-user${msg.failed ? " chat-msg-failed" : ""}`}>
        <div className={`chat-bubble chat-bubble-user${msg.failed ? " chat-bubble-failed" : ""}`}>
          {msg.attachments?.length ? <ChatAttachments items={msg.attachments} /> : null}
          {msg.text && (
            <span className="chat-bubble-text">
              {msg.mode === "voice" && <span className="chat-voice-tag">🎤 </span>}
              {msg.text}
            </span>
          )}
        </div>
        {/* Envío FALLIDO (Fase B.2): el POST agotó los reintentos. El texto queda visible
            arriba (no se pierde) y, si el fallo es transitorio, el botón re-postea el mismo
            payload. Un fallo terminal (ej. audio demasiado grande) muestra solo el motivo. */}
        {msg.failed && (
          <div className="chat-send-failed" role="alert">
            <span className="chat-send-failed-reason">⚠ {msg.failed.reason}</span>
            {msg.failed.retryable && (
              <button type="button" className="chat-send-retry" onClick={() => onResend(msg.id)}>
                Reintentar
              </button>
            )}
          </div>
        )}
      </div>
    );
  }
  const empty = msg.thinking && !msg.text && !msg.audioUrl;
  return (
    <div className="chat-msg chat-msg-agent">
      <div className="chat-bubble chat-bubble-agent">
        {empty ? (
          <span className="chat-thinking" role="status" aria-label="pensando">
            <span />
            <span />
            <span />
          </span>
        ) : (
          <>
            {/* Respuesta de voz. Si su audio se está AUTO-reproduciendo (turno iniciado por nota
                de voz, o modo orbe con el chat recién abierto), pintamos el player ESPEJO de esa
                reproducción — progreso avanzando, botón en pausa — para que no haya un player
                muerto en 0:00 mientras la voz suena por el <audio> compartido (y tampoco una
                segunda reproducción). Si no, el <audio controls> nativo de siempre (play manual,
                como Telegram). El texto (transcripción) va debajo si vino. */}
            {msg.audioUrl &&
              (playback ? (
                <ChatAudioLive playback={playback} onToggle={onVoiceToggle} onSeek={onVoiceSeek} />
              ) : (
                // biome-ignore lint/a11y/useMediaCaption: nota de voz del agente, sin subtítulos
                <audio className="chat-audio" controls src={msg.audioUrl} />
              ))}
            {msg.text && (
              <Markdown remarkPlugins={[remarkGfm]} components={CHAT_MD_COMPONENTS}>
                {msg.text}
              </Markdown>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Player ESPEJO de la respuesta de voz en curso: refleja (y comanda) la reproducción del
// <audio> compartido del canal — botón pausa/play, barra de progreso seekeable y tiempo. NO
// tiene un elemento de audio propio (la reproducción es UNA sola); cuando el clip termina,
// `playback` vuelve a null y la burbuja cae al <audio controls> nativo para re-escuchar.
function ChatAudioLive({
  playback,
  onToggle,
  onSeek,
}: {
  playback: VoicePlayback;
  onToggle: () => void;
  onSeek: (t: number) => void;
}) {
  const { playing, t, dur } = playback;
  return (
    <div className="chat-audio chat-audio-live">
      <button
        type="button"
        className="chat-audio-btn"
        onClick={onToggle}
        aria-label={playing ? "Pausar la nota de voz" : "Reanudar la nota de voz"}
      >
        {playing ? <IconPause size={16} /> : <IconPlay size={16} />}
      </button>
      <input
        type="range"
        className="chat-audio-seek"
        min={0}
        // Sin metadata todavía (dur 0) la barra igual progresa contra lo reproducido hasta ahora.
        max={Math.max(dur, t, 0.1)}
        step={0.1}
        value={t}
        onChange={(e) => onSeek(Number(e.target.value))}
        aria-label="Posición de la nota de voz"
      />
      <span className="chat-audio-time">
        {fmtVoiceTime(t)}
        {dur > 0 ? ` / ${fmtVoiceTime(dur)}` : ""}
      </span>
    </div>
  );
}

// Adjuntos de un turno del usuario: miniatura por imagen (si el data-URL sobrevive en la
// sesión), chip por PDF o por adjunto restaurado de un reload (sin miniatura). Render en la
// burbuja del usuario, arriba del texto.
function ChatAttachments({ items }: { items: ChatAttachment[] }) {
  return (
    <div className="chat-attachments">
      {items.map((a, i) => {
        const isImage = a.kind === "image";
        return isImage && a.url ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: lista estática del turno, sin reorder
          <img key={i} className="chat-attach-img" src={a.url} alt={a.name ?? "imagen"} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: lista estática del turno, sin reorder
          <span key={i} className="chat-attach-chip" title={a.name}>
            <span className="chat-attach-kind">{isImage ? "IMG" : "PDF"}</span>
            {a.name && <span className="chat-attach-name">{a.name}</span>}
          </span>
        );
      })}
    </div>
  );
}

// Pantalla de login dedicada: card centrada con la marca + acceso por MAGIC LINK de mail
// (método primario: registra Y loguea, sin contraseña), contraseña como alternativa secundaria
// (toggle) y "Entrar con Google". Reemplaza TODO el shell (orbe/explorer/textbar) cuando no hay
// sesión — el login no es un estado de la app principal, es su antesala. `denied` = volvió del
// callback de Google sin autorización.
// Intención-primero: la bienvenida ("choose") separa "entrar" de "registrarse". Cada
// intención abre su propia vista; la mecánica de auth (endpoints) es la misma.
type LoginMode = "choose" | "login" | "register";

// Traduce un reason de la API o un param de Google callback a un mensaje claro para el usuario.
// Claridad sobre anti-enumeración (ver memoria auth-clarity-over-enumeration).
function loginErrorMsg(reason: string): string {
  if (reason === "waitlisted" || reason === "1")
    return "Ceibo es por invitación. Te anotamos en la lista de espera — te avisamos por mail cuando tu acceso esté listo.";
  if (reason === "already-waitlisted" || reason === "already")
    return "Ya estás en la lista de espera. Te avisamos por mail cuando tu acceso esté listo.";
  if (reason === "denied") return "Tu cuenta no está autorizada todavía.";
  return "";
}

function LoginScreen({ denied, waitlistedParam }: { denied: boolean; waitlistedParam: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Mensaje inicial: desde el callback de Google (denied / waitlisted) o vacío.
  const initialError = denied
    ? loginErrorMsg("denied")
    : waitlistedParam
      ? loginErrorMsg(waitlistedParam)
      : "";
  // `denied`/`waitlisted` (rebote de Google) y los errores del form comparten el mismo renglón de aviso.
  const [error, setError] = useState<string>(initialError);
  const [busy, setBusy] = useState(false);
  // Tras pedir el link (y SÓLO si el email estaba autorizado → `ok:true`), mostramos la
  // confirmación en vez del form. Si no está autorizado, el server responde `ok:false` y mostramos
  // el aviso en el renglón de error (ver requestLink).
  const [linkSent, setLinkSent] = useState(false);
  // Vista activa. Arrancamos en la bienvenida; el caso típico de `denied`/`waitlisted` es alguien sin
  // invitación, así que igual arranca en "choose" con el aviso arriba.
  const [mode, setMode] = useState<LoginMode>("choose");

  // Navegación entre vistas: limpia el estado transitorio (error del form, confirmación).
  function goTo(next: LoginMode) {
    setMode(next);
    setError("");
    setLinkSent(false);
  }

  // Pide el magic link de acceso por mail (registra o loguea, gated por allowlist). Se dispara
  // desde el form de "register" (submit) o como acción secundaria en "login" (botón) → el event
  // es opcional.
  async function requestLink(e?: FormEvent<HTMLFormElement>) {
    e?.preventDefault();
    if (busy || !email.trim()) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/email/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (res.ok) {
        // 200, pero el cuerpo dice si el email estaba autorizado: `ok:true` → link enviado, mostramos
        // la confirmación; `ok:false,reason` → no autorizado/waitlisted, avisamos sin confirmar.
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
        if (data.ok) {
          setLinkSent(true);
        } else {
          setError(
            loginErrorMsg(data.reason ?? "") ||
              "Tu cuenta no está autorizada todavía. Pedile a quien te invitó que te habilite.",
          );
        }
        return;
      }
      setError(
        res.status === 429
          ? "Demasiados intentos. Esperá unos minutos."
          : res.status === 503
            ? "El acceso por mail no está disponible. Probá con Google."
            : "No se pudo enviar el link. Probá de nuevo.",
      );
    } catch {
      setError("No se pudo conectar. Probá de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  // Método secundario: login por email + contraseña (verificador seteado por el admin).
  async function submitPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || !email.trim() || !password) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/login/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (res.ok) {
        // La cookie de sesión ya quedó seteada → recargamos a la app (igual que el flujo Google).
        window.location.assign("/");
        return;
      }
      setError(
        res.status === 429 ? "Demasiados intentos. Esperá unos minutos." : "Email o contraseña incorrectos.",
      );
    } catch {
      setError("No se pudo conectar. Probá de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  const isChoose = mode === "choose";

  return (
    <main className="login-screen">
      <div className="login-card">
        {!isChoose && (
          <button className="login-back" type="button" onClick={() => goTo("choose")} disabled={busy}>
            ‹ Volver
          </button>
        )}
        <span className="login-mark" aria-hidden="true" />
        <h1 className="login-title">
          Ceibo
          <span className="login-brand-dot" aria-hidden="true">
            .
          </span>
        </h1>
        <p className="login-sub">
          {mode === "login"
            ? "Iniciar sesión"
            : mode === "register"
              ? "Crear cuenta"
              : "Organiza y enriquece el día a día familiar"}
        </p>

        {isChoose ? (
          // Bienvenida: separar la intención antes de pedir nada.
          <>
            {error && <p className="login-denied">{error}</p>}
            <button className="login-choice" type="button" onClick={() => goTo("login")}>
              Ya tengo cuenta
            </button>
            <button className="login-choice" type="button" onClick={() => goTo("register")}>
              Quiero crear una cuenta
            </button>
          </>
        ) : linkSent ? (
          // Confirmación: el email estaba autorizado y se mandó el link. El "‹ Volver" lo provee el
          // header de la card (.login-back, visible en login/register) → acá NO repetimos otro
          // botón (antes había dos). El del header limpia el estado vía goTo("choose").
          <p className="login-sent">
            Te mandamos un link de acceso a <strong>{email.trim()}</strong>. Revisá tu casilla (y el spam).
          </p>
        ) : mode === "login" ? (
          // Iniciar sesión: contraseña (primario) + Google + magic link (secundario).
          <>
            {error && <p className="login-denied">{error}</p>}
            <form className="login-form" onSubmit={submitPassword}>
              <input
                className="login-input"
                type="email"
                name="email"
                autoComplete="username"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
                required
              />
              <input
                className="login-input"
                type="password"
                name="password"
                autoComplete="current-password"
                placeholder="Contraseña"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
                required
              />
              <button className="login-submit" type="submit" disabled={busy || !email.trim() || !password}>
                {busy ? "Entrando…" : "Iniciar sesión"}
              </button>
            </form>
            <div className="login-divider" aria-hidden="true">
              o
            </div>
            {/* Navegación normal (no fetch): el server 302ea a Google y vuelve con la cookie seteada. */}
            <a className="login-google" href="/api/auth/google/start">
              <span className="login-google-g" aria-hidden="true">
                G
              </span>
              Entrar con Google
            </a>
            {/* Magic link reusando el email tipeado; deshabilitado si está vacío. */}
            <button
              className="login-alt"
              type="button"
              onClick={() => requestLink()}
              disabled={busy || !email.trim()}
            >
              {busy ? "Enviando…" : "Enviarme un link de acceso"}
            </button>
          </>
        ) : (
          // Crear cuenta: invite-only, alta al instante sin contraseña (magic link o Google).
          <>
            {error && <p className="login-denied">{error}</p>}
            <p className="login-hint">
              Ceibo es por invitación. Si tu mail está autorizado, creás tu cuenta al instante (sin
              contraseña).
            </p>
            <form className="login-form" onSubmit={requestLink}>
              <input
                className="login-input"
                type="email"
                name="email"
                autoComplete="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
                required
              />
              <button className="login-submit" type="submit" disabled={busy || !email.trim()}>
                {busy ? "Enviando…" : "Enviarme un link de acceso"}
              </button>
            </form>
            <div className="login-divider" aria-hidden="true">
              o
            </div>
            {/* Mismo endpoint que en login: si el email está autorizado, el callback crea la cuenta. */}
            <a className="login-google" href="/api/auth/google/start">
              <span className="login-google-g" aria-hidden="true">
                G
              </span>
              Registrarme con Google
            </a>
          </>
        )}
      </div>
    </main>
  );
}

// Pantalla /invitacion?i=<token>: la primera impresión del invitado. Pre-auth, sin sesión.
// - Carga: GET /api/invite?i=<token> → renderiza según el estado.
// - Aceptar: POST /api/invite/accept {token} → muestra el resultado.
// Estados de la API: valid | invalid | ready (pre-accept). Post-accept: waitlisted | already-waitlisted | ready | invalid.
function InvitacionScreen() {
  const token = new URLSearchParams(window.location.search).get("i") ?? "";

  // Estado de carga inicial (GET /api/invite).
  type InviteState =
    | { phase: "loading" }
    | { phase: "error"; msg: string }
    | { phase: "invalid" }
    | { phase: "ready" }
    | { phase: "valid"; inviter: string; wikiLabel: string }
    | { phase: "waitlisted" }
    | { phase: "already-waitlisted" }
    | { phase: "accepting" }
    | { phase: "accept-error"; msg: string };

  const [state, setState] = useState<InviteState>({ phase: "loading" });

  useEffect(() => {
    if (!token) {
      setState({ phase: "invalid" });
      return;
    }
    let cancelled = false;
    fetch(`/api/invite?i=${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setState({ phase: "error", msg: "No se pudo verificar la invitación. Probá de nuevo." });
          return;
        }
        const d = (await res.json()) as { state?: string; inviter?: string; wikiLabel?: string };
        if (cancelled) return;
        if (d.state === "valid") {
          setState({ phase: "valid", inviter: d.inviter ?? "", wikiLabel: d.wikiLabel ?? "" });
        } else if (d.state === "ready") {
          setState({ phase: "ready" });
        } else {
          setState({ phase: "invalid" });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ phase: "error", msg: "No se pudo conectar. Probá de nuevo." });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function accept() {
    setState({ phase: "accepting" });
    try {
      const res = await fetch("/api/invite/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        setState({ phase: "accept-error", msg: "No se pudo procesar la aceptación. Probá de nuevo." });
        return;
      }
      const d = (await res.json()) as { state?: string };
      if (d.state === "waitlisted") {
        setState({ phase: "waitlisted" });
      } else if (d.state === "already-waitlisted") {
        setState({ phase: "already-waitlisted" });
      } else if (d.state === "ready") {
        setState({ phase: "ready" });
      } else {
        // invalid o token revocado entre el GET y el POST
        setState({ phase: "invalid" });
      }
    } catch {
      setState({ phase: "accept-error", msg: "No se pudo conectar. Probá de nuevo." });
    }
  }

  function body() {
    switch (state.phase) {
      case "loading":
        return <p className="invite-body invite-muted">Verificando invitación…</p>;

      case "error":
        return <p className="invite-body invite-error">{state.msg}</p>;

      case "invalid":
        return (
          <>
            <p className="invite-body invite-error">Este link de invitación no es válido o ya expiró.</p>
            <p className="invite-hint">
              Si crees que es un error, pedile al invitante que te reenvíe el link.
            </p>
          </>
        );

      case "ready":
        return (
          <>
            <p className="invite-body">Ya tenés acceso a Ceibo.</p>
            <a className="login-google invite-cta" href="/">
              Entrar a la app
            </a>
          </>
        );

      case "valid": {
        const { inviter, wikiLabel } = state;
        return (
          <>
            <p className="invite-body">
              <strong>{inviter}</strong> te invitó a la wiki <strong>{wikiLabel}</strong> en Ceibo.
            </p>
            <button className="login-submit invite-accept" type="button" onClick={accept}>
              Aceptar invitación
            </button>
          </>
        );
      }

      case "accepting":
        return <p className="invite-body invite-muted">Procesando…</p>;

      case "waitlisted":
        return (
          <>
            <p className="invite-body invite-ok">Listo, te anotamos.</p>
            <p className="invite-hint">Te avisamos por mail cuando aprueben tu acceso.</p>
          </>
        );

      case "already-waitlisted":
        return (
          <>
            <p className="invite-body invite-ok">Ya estabas en la lista de espera.</p>
            <p className="invite-hint">Te avisamos por mail cuando aprueben tu acceso.</p>
          </>
        );

      case "accept-error":
        return (
          <>
            <p className="invite-body invite-error">{state.msg}</p>
            <button className="login-alt" type="button" onClick={accept}>
              Reintentar
            </button>
          </>
        );
    }
  }

  return (
    <main className="login-screen">
      <div className="login-card">
        <span className="login-mark" aria-hidden="true" />
        <h1 className="login-title">
          Ceibo
          <span className="login-brand-dot" aria-hidden="true">
            .
          </span>
        </h1>
        <p className="login-sub invite-subtitle">Invitación</p>
        {body()}
      </div>
    </main>
  );
}

// Tira de pestañas (la "sección de arriba"). Cada tab = título + ✕ de cerrar. Cuando no
// entran todas, encogen parejo y el título se trunca; al llegar al mínimo queda SÓLO la ✕
// (el nombre completo sigue en el `title`/hover). La pestaña activa no colapsa. Middle-click
// sobre una tab la cierra. (La nota nueva se crea con el botón "+" full-size de arriba-derecha.)
// Los títulos colisionantes (mismo basename) se desambiguan con su path mínimo (ver helper arriba).
// El botón de minimizar/restaurar ya NO vive aquí: es el FAB flotante abajo-derecha (.minimize-fab).
function TabStrip({
  tabs,
  repoLabels,
  emojiOf,
  activeId,
  onSelect,
  onClose,
  onReorder,
  onRevealInExplorer,
  onNewNote,
}: {
  tabs: TabInfo[];
  // slug de repo → alias (display label) de la wiki, para desambiguar tabs por alias, no por slug.
  repoLabels: Map<string, string>;
  // Emoji por-nota (estilo Notion): se pinta antes del título del tab. "" = sin emoji.
  emojiOf: (repo: string, path: string) => string;
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (id: string, beforeId: string | null) => void;
  // Click derecho sobre una pestaña de NOTA → "Mostrar en explorador": revela el archivo en el
  // árbol (lo abre, expande sus carpetas y scrollea hasta él). Las tabs de sistema no tienen
  // archivo, así que no ofrecen la acción. (La tira de pestañas no existe en mobile — CSS.)
  onRevealInExplorer: (repo: string, path: string) => void;
  // Si está, se pinta un "+" al final de la tira que crea una nota nueva (desktop). En mobile la
  // tira está oculta por CSS, así que el "+" no aparece (el flujo de nota nueva pasa por cerrar).
  onNewNote?: () => void;
}) {
  // Drag-para-reordenar (HTML5 DnD). `draggingId` = la pestaña que se está arrastrando (la
  // atenuamos). El reordenamiento es EN VIVO: al pasar sobre otra pestaña calculamos si el
  // cursor está en su mitad izquierda (insertar antes) o derecha (insertar después) y movemos
  // la arrastrada ahí mismo, así la tira se acomoda mientras arrastrás (estilo navegador).
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Menú contextual de la pestaña (click derecho / long-press). Posición fija al cursor; se
  // portalea a <body> para escapar el `overflow-x:auto` de la tira. Sólo notas (tienen archivo).
  const [menu, setMenu] = useState<{ repo: string; path: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    // Cualquier click, scroll o Escape cierra el menú. El right-click sobre una pestaña hace
    // stopPropagation (abajo), así que NO llega acá → reabre limpio sobre otra pestaña.
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);
  const openMenu = (e: ReactMouseEvent, t: TabInfo) => {
    if (t.kind !== "note") return; // las páginas de sistema no tienen archivo que revelar
    e.preventDefault();
    e.stopPropagation(); // no dispares el listener global de contextmenu que cierra el menú
    setMenu({ repo: t.repo, path: t.path, x: e.clientX, y: e.clientY });
  };
  // Títulos a mostrar: pelados salvo colisión de basename, donde se anteponen carpetas (ver helper).
  // Las tabs de sistema tienen título fijo (no colisionan con notas); se pasan directamente.
  // El ancestro más alto del prefijo es el ALIAS de la wiki (display label), no el slug del repo.
  const noteTabs = tabs.filter((t): t is TabInfo & { kind: "note" } => t.kind === "note");
  const displayTitles = disambiguateTabTitles(noteTabs, (repo) => repoLabels.get(repo) ?? repo);
  const titleOf = (t: { id: string; title: string }) => displayTitles.get(t.id) ?? t.title;
  const onTabDragOver = (e: DragEvent<HTMLDivElement>, overId: string) => {
    if (!draggingId || draggingId === overId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    if (after) {
      // Insertar DESPUÉS de overId = antes de su vecina derecha (o al final).
      const idx = tabs.findIndex((t) => t.id === overId);
      onReorder(draggingId, tabs[idx + 1]?.id ?? null);
    } else {
      onReorder(draggingId, overId);
    }
  };
  // En home mode (activeId=null): la tira se oculta (las tabs no se ven), el botón de
  // minimizar/restaurar vive en el FAB flotante abajo-derecha. La tira no renderiza nada visible.
  if (activeId === null) {
    return null;
  }
  return (
    <div className="tabstrip" role="tablist">
      {tabs.map((t) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: drag&drop nativo para reordenar; el control accesible es el botón .tab-label de adentro
        <div
          key={t.id}
          className={`tab${t.id === activeId ? " tab-active" : ""}${
            t.id === draggingId ? " tab-dragging" : ""
          }`}
          title={titleOf(t)}
          draggable
          onContextMenu={(e) => openMenu(e, t)}
          onDragStart={(e) => {
            setDraggingId(t.id);
            e.dataTransfer.effectAllowed = "move";
            // Firefox exige setData para arrancar el drag; el valor en sí no lo usamos.
            try {
              e.dataTransfer.setData("text/plain", t.id);
            } catch {
              /* algunos navegadores lo restringen; el estado local alcanza */
            }
          }}
          onDragOver={(e) => onTabDragOver(e, t.id)}
          onDragEnd={() => setDraggingId(null)}
          onDrop={(e) => {
            e.preventDefault();
            setDraggingId(null);
          }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={t.id === activeId}
            className={`tab-label${t.kind === "system" ? " tab-label-system" : ""}`}
            onClick={() => onSelect(t.id)}
            // Middle-click sobre la pestaña la cierra (como en el navegador).
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(t.id);
              }
            }}
          >
            {t.kind === "note" && emojiOf(t.repo, t.path) && (
              <span className="tab-emoji" aria-hidden="true">
                {emojiOf(t.repo, t.path)}
              </span>
            )}
            {t.kind === "system" && (
              <span className="tab-icon" aria-hidden="true">
                {(() => {
                  const iconName = getSystemPageMeta(t.page).icon;
                  if (iconName === "clock") return <IconClock size={14} />;
                  if (iconName === "plug") return <IconPlug size={14} />;
                  if (iconName === "archive") return <IconArchive size={14} />;
                  if (iconName === "message") return <IconMessage size={14} />;
                  if (iconName === "user") return <IconUser size={14} />;
                  if (iconName === "palette") return <IconPalette size={14} />;
                  if (iconName === "languages") return <IconLanguages size={14} />;
                  return <IconSettings size={14} />;
                })()}
              </span>
            )}
            {titleOf(t) || "nota"}
          </button>
          <button
            type="button"
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation();
              onClose(t.id);
            }}
            aria-label={`Cerrar ${titleOf(t)}`}
            title="Cerrar pestaña"
          >
            <IconX size={16} />
          </button>
        </div>
      ))}
      {/* "+" nueva pestaña/nota al final de la tira (estilo navegador). No es draggable ni
          reordenable: vive fuera del map de tabs, siempre al final. */}
      {onNewNote && (
        <button
          type="button"
          className="tab-new"
          onClick={onNewNote}
          aria-label="Nota nueva"
          data-tip="Nota nueva"
          title="Nota nueva"
        >
          <IconPlus size={18} />
        </button>
      )}
      {menu &&
        createPortal(
          // Menú contextual de la pestaña, anclado al cursor (fixed). `left` se clampa para no
          // desbordar el borde derecho. Portaleado a <body> → escapa el overflow de la tira.
          <div
            className="tab-ctxmenu"
            style={{ top: menu.y, left: Math.min(menu.x, window.innerWidth - 220) }}
            role="menu"
          >
            <button
              type="button"
              role="menuitem"
              className="tab-ctxmenu-item"
              onClick={() => {
                onRevealInExplorer(menu.repo, menu.path);
                setMenu(null);
              }}
            >
              Mostrar en explorador
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}

// Cuerpo de la vista de notas: SOLO el scroller + el editor (la barra de arriba con las
// pestañas y el orbe vive en App, fuera del `key`, para no remontarse). Se remonta por su
// `key` (id de la entrada) SOLO al cambiar de pestaña/archivo — un cambio externo de la
// misma nota entra por props al editor montado (Fase C), así el rAF de restauración de
// scroll de abajo no corre (no pelea con el scroll del usuario mientras lee/tipea).
function WikiViewBody({
  doc,
  emoji,
  onSetEmoji,
  tabId,
  scrollMemo,
  scrollPositions,
  handle,
  blameOn,
  blameAvailable,
  onToggleBlame,
  selfHandle,
  onSaved,
  onRename,
  onOpen,
  isArchivedRepo,
  isPathUnderFsOp,
}: {
  doc: OpenDoc;
  /** Emoji de la nota (estilo Notion): se pinta junto al título en el header del editor. */
  emoji?: string;
  /** Asigna/limpia el emoji de la nota desde el botón a la izquierda del título. */
  onSetEmoji?: (repo: string, path: string, emoji: string) => void;
  tabId: string;
  scrollMemo: { current: Map<string, number> };
  /** Ref al mapa de posiciones cross-refresh (repo/path → scrollTop) para persistir en localStorage. */
  scrollPositions: { current: Record<string, number> };
  /** Handle del usuario logueado (para aislar el cache de scroll entre cuentas). */
  handle: string | undefined;
  /** Blame por línea activo (toggle de la botonera; solo llega true si está disponible). */
  blameOn?: boolean;
  /** ¿Esta wiki tiene blame disponible? Decide si el botón del sub-header de la nota se muestra. */
  blameAvailable?: boolean;
  /** Prende/apaga el blame por línea desde el botón del sub-header de la nota (flip de la
   *  preferencia global). Ausente → el botón no se renderiza (wiki sin blame). */
  onToggleBlame?: () => void;
  /** Handle del viewer (el tooltip del blame marca "(vos)"). */
  selfHandle?: string;
  onSaved: (content: string, sha: string, repo: string, path: string) => void;
  onRename: (newName: string, fullContent?: string) => Promise<string | undefined>;
  onOpen: (repo: string, path: string) => void;
  /** F5: true cuando la wiki está archivada — muestra el banner y la vista solo-lectura. */
  isArchivedRepo?: boolean;
  /** ¿(repo,path) está bajo una op de FS (move/rename) en vuelo? El editor lo usa para no
   *  persistir un archivo que un move está moviendo (evita el 409 "conflict" del caso 4). */
  isPathUnderFsOp?: (repo: string, path: string) => boolean;
}) {
  // Editable cuando el archivo está listo y con sha — y cuando la wiki NO está archivada.
  // F5: wikis archivadas son solo-lectura: mostramos el contenido como markdown + banner.
  const canEdit = doc.status === "ready" && !!doc.sha && !isArchivedRepo;

  // Preservar el scroll al volver de otra pestaña / reabrir una nota (no querés que la página
  // salte arriba mientras leés). `.view-body` es el scroller, pero vive
  // DENTRO de este componente que remonta → la memoria persiste en `scrollMemo` (App), un Map
  // keyeado por `scrollKey(tabId, repo, path)` (NO por doc.id: ese id se regenera en cada
  // selectTab/open → el Map nunca matcheaba y siempre restauraba 0; bug de #273). El onScroll lo
  // mantiene al día; al montar restauramos el top guardado para esta nota+pestaña (default 0 si
  // nunca se scrolleó / nota nueva). El editor (CodeMirror, lazy) monta async → el contenido
  // todavía no tiene altura cuando corre el efecto, así que reintentamos por unos frames hasta
  // que el scrollTop "pegue".
  const key = scrollKey(tabId, doc.repo, doc.path);
  const viewBodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = viewBodyRef.current;
    if (!el) return;
    const target = scrollMemo.current.get(key) ?? 0;
    if (target <= 0) return;
    let raf = 0;
    let tries = 0;
    const tick = () => {
      const node = viewBodyRef.current;
      if (!node) return;
      node.scrollTop = target;
      if (Math.abs(node.scrollTop - target) < 2 || tries >= 40) return; // pegó, o nos rendimos (~0.6s)
      tries++;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [key, scrollMemo]);

  return (
    <div
      className="view-body"
      ref={viewBodyRef}
      onScroll={() => {
        const el = viewBodyRef.current;
        if (!el) return;
        const top = el.scrollTop;
        // Sesión: actualiza el memo in-session (para volver a la pestaña sin perder posición).
        scrollMemo.current.set(key, top);
        // Cross-refresh: actualiza el cache persistente con debounce (uiStateCache.ts).
        saveScrollDebounced(handle, scrollPositions.current, doc.repo, doc.path, top);
      }}
    >
      {doc.status === "loading" && <p className="view-msg">abriendo…</p>}
      {doc.status === "new" && <p className="view-msg">nota nueva — todavía sin contenido.</p>}
      {doc.status === "error" && <p className="view-msg">{doc.error}</p>}
      {/* F5: wiki archivada → solo-lectura con banner. Reusar el mecanismo de la Bienvenida. */}
      {isArchivedRepo && doc.status === "ready" && (
        <article className="welcome">
          <div className="archived-wiki-banner" role="note">
            🗃 Wiki archivada — solo lectura
          </div>
          <Markdown remarkPlugins={[remarkGfm]}>{doc.content ?? ""}</Markdown>
        </article>
      )}
      {canEdit && (
        <Suspense fallback={<p className="view-msg">cargando editor…</p>}>
          <FileEditor
            repo={doc.repo}
            path={doc.path}
            emoji={emoji}
            onSetEmoji={onSetEmoji ? (e) => onSetEmoji(doc.repo, doc.path, e) : undefined}
            initialContent={doc.content ?? ""}
            initialSha={doc.sha}
            blameOn={blameOn}
            blameAvailable={blameAvailable}
            onToggleBlame={onToggleBlame}
            selfHandle={selfHandle}
            onSaved={onSaved}
            onRename={onRename}
            onOpen={onOpen}
            isPathUnderFsOp={isPathUnderFsOp}
          />
        </Suspense>
      )}
    </div>
  );
}

// Envuelve un panel de sistema para montarlo como PÁGINA en el área del editor.
// La ✕ la da la tab (botón cerrar en la tira de pestañas, o el botón mobile del header).
// Los componentes internos se reusan sin cambios: solo cambia el contenedor.
function SystemPageView({
  page,
  onClose,
  onOpen,
  theme,
  setTheme,
  debugMode,
  setDebugMode,
  hintsEnabled,
  setHintsEnabled,
  blameOn,
  setBlameOn,
  name,
  location,
  handle,
  email,
  hasPassword,
  hasAvatar,
  avatarVersion,
  refreshProfile,
  mics,
  micsAuthorized,
  micId,
  setMic,
  voice,
  setVoice,
  setVoiceLang,
  setRate,
  model,
  setModel,
  bgQueries,
  saveBgQueries,
}: {
  page: SystemPage;
  onClose: () => void;
  onOpen: (repo: string, path: string) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  debugMode: boolean;
  setDebugMode: (v: boolean) => void;
  hintsEnabled: boolean;
  setHintsEnabled: (v: boolean) => void;
  blameOn: boolean;
  setBlameOn: (v: boolean) => void;
  name?: string;
  location?: string;
  handle?: string;
  email?: string;
  hasPassword?: boolean;
  hasAvatar: boolean;
  avatarVersion: number;
  refreshProfile: () => Promise<void>;
  mics: { deviceId: string; label: string }[];
  micsAuthorized: boolean;
  micId: string;
  setMic: (id: string) => void;
  voice?: VoiceCfg;
  setVoice: (nick: string) => void;
  setVoiceLang: (id: string) => void;
  setRate: (rate: string) => void;
  model?: ModelCfg;
  setModel: (id: string) => void;
  bgQueries?: string[];
  saveBgQueries: (queries: string[]) => Promise<boolean>;
}) {
  const meta = getSystemPageMeta(page);
  return (
    <section className="view-body system-page" aria-label={meta.title}>
      {page === "config" && (
        <SettingsPanel
          model={model}
          setModel={setModel}
          debugMode={debugMode}
          setDebugMode={setDebugMode}
          hintsEnabled={hintsEnabled}
          setHintsEnabled={setHintsEnabled}
          blameOn={blameOn}
          setBlameOn={setBlameOn}
          onClose={onClose}
        />
      )}
      {page === "idioma" && (
        <IdiomaVozPanel
          mics={mics}
          micsAuthorized={micsAuthorized}
          micId={micId}
          setMic={setMic}
          voice={voice}
          setVoice={setVoice}
          setVoiceLang={setVoiceLang}
          setRate={setRate}
        />
      )}
      {page === "perfil" && (
        <ProfilePanel
          name={name}
          location={location}
          handle={handle}
          email={email}
          hasPassword={hasPassword}
          hasAvatar={hasAvatar}
          avatarVersion={avatarVersion}
          refreshProfile={refreshProfile}
          onLogout={async () => {
            try {
              await fetch("/api/logout", { method: "POST" });
            } catch {
              /* igual recargamos: sin cookie válida cae en el login */
            }
            window.location.href = "/";
          }}
        />
      )}
      {page === "apariencia" && (
        <AppearancePanel
          theme={theme}
          setTheme={setTheme}
          bgQueries={bgQueries}
          saveBgQueries={saveBgQueries}
        />
      )}
      {page === "agenda" && <AgendaPanel onClose={onClose} />}
      {page === "canales" && <ChannelsPanel />}
      {page === "conexiones" && <ConnectionsPanel onClose={onClose} />}
      {page === "archivo" && <ArchivePanel handle={handle} onOpen={onOpen} />}
    </section>
  );
}

/** F5: Panel de la vista "archivo" como system-page. */
function ArchivePanel({ handle, onOpen }: { handle?: string; onOpen: (repo: string, path: string) => void }) {
  interface ArchivedWiki {
    repo: string;
    label: string;
    files: string[];
    members?: { handle: string; name: string; hasAvatar: boolean }[];
    role?: string;
    personal?: boolean;
    isOwner?: boolean;
  }

  const [wikis, setWikis] = useState<ArchivedWiki[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // biome-ignore lint/correctness/useExhaustiveDependencies: `handle` es señal de refetch (usuario cambió)
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/explorer/archived", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { archived: [] }))
      .then((d: { archived?: ArchivedWiki[] }) => {
        if (!cancelled) setWikis(d.archived ?? []);
      })
      .catch(() => {
        if (!cancelled) setWikis([]);
      });
    return () => {
      cancelled = true;
    };
  }, [handle]);

  const doUnarchive = useCallback(async (repo: string) => {
    try {
      const r = await fetch("/api/wiki/unarchive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `unarchive ${r.status}`);
      }
      // Reload
      const r2 = await fetch("/api/explorer/archived", { cache: "no-store" });
      const d = r2.ok ? ((await r2.json()) as { archived?: ArchivedWiki[] }) : { archived: [] };
      setWikis(d.archived ?? []);
    } catch (e) {
      alert(`No pude desarchivar: ${(e as Error)?.message ?? e}`);
    }
  }, []);

  if (wikis === null) return <p className="view-msg">cargando…</p>;
  if (wikis.length === 0) return <p className="view-msg exp-archive-empty">No tenés wikis archivadas.</p>;

  return (
    <div className="archive-panel">
      {wikis.map((w) => {
        const isOpen = expanded.has(w.repo);
        return (
          <div key={w.repo} className="archive-wiki-entry">
            <div className="archive-wiki-header">
              <button
                type="button"
                className="archive-wiki-title-btn"
                onClick={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(w.repo)) next.delete(w.repo);
                    else next.add(w.repo);
                    return next;
                  })
                }
              >
                <span className={`exp-chevron${isOpen ? " exp-chevron-open" : ""}`}>›</span>
                <span className="archive-wiki-title">{w.label}</span>
              </button>
              <button
                type="button"
                className="archive-unarchive-btn"
                onClick={() => void doUnarchive(w.repo)}
                title="Desarchivar"
              >
                <IconArchive size={14} />
                <span>Desarchivar</span>
              </button>
            </div>
            {isOpen && (
              <ul className="archive-file-list">
                {w.files
                  .filter((f) => !f.startsWith("."))
                  .map((f) => (
                    <li key={f}>
                      <button type="button" className="archive-file-btn" onClick={() => onOpen(w.repo, f)}>
                        {f.replace(/\.md$/, "")}
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Velocidad de la voz: presets que mapean al `rate` (formato edge-tts con signo, que el
// gateway también mapea a speakingRate en Inworld). "" = velocidad normal de la voz.
const RATE_PRESETS: { value: string; label: string }[] = [
  { value: "-30%", label: "Muy lenta" },
  { value: "-15%", label: "Lenta" },
  { value: "", label: "Normal" },
  { value: "+15%", label: "Rápida" },
  { value: "+30%", label: "Muy rápida" },
];

// Tope del avatar (espeja al server): validación client-side antes de subir.
const MAX_AVATAR_BYTES = 512 * 1024;

// Panel de Perfil (cuenta + alias + avatar): página de sistema propia (v2).
function ProfilePanel({
  name,
  location,
  handle,
  email,
  hasPassword,
  hasAvatar,
  avatarVersion,
  refreshProfile,
  onLogout,
}: {
  name?: string;
  location?: string;
  handle?: string;
  email?: string;
  /** true = cuenta con contraseña propia → mostrar la sección de cambiar contraseña. */
  hasPassword?: boolean;
  hasAvatar: boolean;
  avatarVersion: number;
  refreshProfile: () => Promise<void>;
  onLogout: () => void;
}) {
  const [alias, setAlias] = useState(name ?? "");
  const [loc, setLoc] = useState(location ?? "");
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileErr, setProfileErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const aliasDirty = alias.trim() !== (name ?? "").trim();
  const locDirty = loc.trim() !== (location ?? "").trim();
  const profileDirty = aliasDirty || locDirty;
  const avatarInitial = (name ?? handle ?? "?").trim().charAt(0).toUpperCase() || "?";

  // --- Contraseña (cambio autenticado) --------------------------------------
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [pwOk, setPwOk] = useState(false);
  const pwReady = pwCurrent.length > 0 && pwNew.length >= 8 && pwConfirm.length > 0;

  const pwErrText = (code: string): string => {
    switch (code) {
      case "wrong-password":
        return "La contraseña actual no es correcta.";
      case "too-short":
        return "La nueva contraseña debe tener al menos 8 caracteres.";
      case "no-password":
        return "Tu cuenta todavía no tiene contraseña. Pedile al admin que te asigne una.";
      case "too-many-requests":
        return "Demasiados intentos. Esperá un momento y probá de nuevo.";
      case "unauth":
        return "Tu sesión expiró. Recargá la página e ingresá de nuevo.";
      default:
        return "No se pudo cambiar la contraseña.";
    }
  };

  const changePassword = async () => {
    setPwErr(null);
    setPwOk(false);
    if (pwNew.length < 8) {
      setPwErr("La nueva contraseña debe tener al menos 8 caracteres.");
      return;
    }
    if (pwNew !== pwConfirm) {
      setPwErr("Las contraseñas no coinciden.");
      return;
    }
    setPwBusy(true);
    try {
      const r = await fetch("/api/me/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ current: pwCurrent, new: pwNew }),
      });
      if (!r.ok) {
        let code = "";
        try {
          code = ((await r.json()) as { error?: string }).error ?? "";
        } catch {
          /* sin body JSON */
        }
        throw new Error(code);
      }
      setPwOk(true);
      setPwCurrent("");
      setPwNew("");
      setPwConfirm("");
    } catch (e) {
      setPwErr(pwErrText(e instanceof Error ? e.message : ""));
    } finally {
      setPwBusy(false);
    }
  };

  // Guarda alias y/o ubicación: sólo manda los campos tocados (el endpoint trata los ausentes
  // como "no cambiar"), así guardar uno no pisa el otro ni los prompts del fondo.
  const saveProfile = async () => {
    setProfileBusy(true);
    setProfileErr(null);
    try {
      const body: { name?: string; location?: string } = {};
      if (aliasDirty) body.name = alias.trim();
      if (locDirty) body.location = loc.trim();
      const r = await fetch("/api/me", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error("save");
      await refreshProfile();
    } catch {
      setProfileErr("No se pudo guardar el perfil.");
    } finally {
      setProfileBusy(false);
    }
  };

  const onPickAvatar = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_AVATAR_BYTES) {
      setProfileErr("La imagen supera los 512KB. Probá una más liviana.");
      return;
    }
    setProfileBusy(true);
    setProfileErr(null);
    try {
      const data = await fileToBase64(file);
      if (!data) throw new Error("read");
      const r = await fetch("/api/me/avatar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data, mime: file.type }),
      });
      if (!r.ok) throw new Error("upload");
      await refreshProfile();
    } catch {
      setProfileErr("No se pudo subir la foto (probá PNG, JPG o WebP).");
    } finally {
      setProfileBusy(false);
    }
  };

  const removeAvatar = async () => {
    setProfileBusy(true);
    setProfileErr(null);
    try {
      const r = await fetch("/api/me/avatar", { method: "DELETE" });
      if (!r.ok) throw new Error("del");
      await refreshProfile();
    } catch {
      setProfileErr("No se pudo quitar la foto.");
    } finally {
      setProfileBusy(false);
    }
  };

  return (
    <div className="settings-popup-body">
      <section className="settings-profile" aria-label="Perfil">
        <h3 className="settings-section-title">Perfil</h3>
        <div className="settings-profile-top">
          <div className="settings-avatar">
            {hasAvatar ? (
              <img src={`/api/me/avatar?v=${avatarVersion}`} alt="Tu avatar" />
            ) : (
              <span className="settings-avatar-ph">{avatarInitial}</span>
            )}
          </div>
          <div className="settings-avatar-actions">
            <button type="button" onClick={() => fileRef.current?.click()} disabled={profileBusy}>
              Cambiar foto
            </button>
            {hasAvatar && (
              <button
                type="button"
                className="settings-avatar-remove"
                onClick={removeAvatar}
                disabled={profileBusy}
              >
                Quitar
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={onPickAvatar}
            />
          </div>
        </div>
        <label className="settings-row">
          <span>Alias</span>
          <input
            type="text"
            className="settings-alias-input"
            value={alias}
            maxLength={60}
            placeholder={handle ?? ""}
            onChange={(e) => setAlias(e.target.value)}
          />
        </label>
        {/* Ubicación: texto libre (ciudad/región). El agente la usa de contexto (clima, husos,
            "cerca mío") si está seteada; vacía → no se le pasa nada. */}
        <label className="settings-row">
          <span>Ubicación</span>
          <input
            type="text"
            className="settings-alias-input"
            value={loc}
            maxLength={120}
            placeholder="Ej. Buenos Aires, Argentina"
            onChange={(e) => setLoc(e.target.value)}
          />
        </label>
        <div className="settings-profile-save">
          {profileErr && <span className="settings-profile-err">{profileErr}</span>}
          <button type="button" onClick={saveProfile} disabled={profileBusy || !profileDirty}>
            Guardar
          </button>
        </div>
      </section>
      <section className="settings-profile" aria-label="Cuenta">
        <h3 className="settings-section-title">Cuenta</h3>
        {/* Identidad read-only: el username (handle) y el mail con el que entrás. Acá no se
              editan — el handle es identidad y el mail viene de cómo te diste de alta. */}
        <div className="settings-account">
          <span className="settings-account-handle">@{handle ?? "—"}</span>
          <span className="settings-account-email">{email ?? "Sin email asociado"}</span>
        </div>
      </section>
      {/* Sin contraseña en web_passwords → se oculta la sección entera (Google puro, magic-link). */}
      {hasPassword === true && (
        <section className="settings-profile" aria-label="Contraseña">
          <h3 className="settings-section-title">Cambiar contraseña</h3>
          <label className="settings-row">
            <span>Actual</span>
            <input
              type="password"
              className="settings-alias-input"
              value={pwCurrent}
              autoComplete="current-password"
              onChange={(e) => {
                setPwCurrent(e.target.value);
                setPwErr(null);
                setPwOk(false);
              }}
            />
          </label>
          <label className="settings-row">
            <span>Nueva</span>
            <input
              type="password"
              className="settings-alias-input"
              value={pwNew}
              autoComplete="new-password"
              placeholder="Mínimo 8 caracteres"
              onChange={(e) => {
                setPwNew(e.target.value);
                setPwErr(null);
                setPwOk(false);
              }}
            />
          </label>
          <label className="settings-row">
            <span>Confirmar</span>
            <input
              type="password"
              className="settings-alias-input"
              value={pwConfirm}
              autoComplete="new-password"
              onChange={(e) => {
                setPwConfirm(e.target.value);
                setPwErr(null);
                setPwOk(false);
              }}
            />
          </label>
          <div className="settings-profile-save">
            {pwErr && <span className="settings-profile-err">{pwErr}</span>}
            {pwOk && <span className="settings-profile-ok">Contraseña actualizada.</span>}
            <button type="button" onClick={changePassword} disabled={pwBusy || !pwReady}>
              Cambiar
            </button>
          </div>
        </section>
      )}
      {/* La salida es de cuenta, no un huérfano al fondo: queda junto a los datos de cuenta. */}
      <button type="button" className="settings-logout" onClick={onLogout}>
        Cerrar sesión
      </button>
    </div>
  );
}

// Panel de Apariencia (tema + fondo Unsplash): página de sistema propia (v2).
function AppearancePanel({
  theme,
  setTheme,
  bgQueries,
  saveBgQueries,
}: {
  theme: Theme;
  setTheme: (t: Theme) => void;
  bgQueries?: string[];
  saveBgQueries: (queries: string[]) => Promise<boolean>;
}) {
  const bgJoined = (bgQueries ?? []).join("\n");
  const [bgText, setBgText] = useState(bgJoined);
  const [bgBusy, setBgBusy] = useState(false);
  const [bgErr, setBgErr] = useState<string | null>(null);
  const bgDirty = bgText !== bgJoined;
  useEffect(() => {
    setBgText(bgJoined);
  }, [bgJoined]);
  const saveBg = async () => {
    setBgBusy(true);
    setBgErr(null);
    try {
      const lines = bgText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const ok = await saveBgQueries(lines);
      if (!ok) {
        setBgErr("No se pudieron guardar los prompts del fondo.");
        return;
      }
      void refreshBg();
    } finally {
      setBgBusy(false);
    }
  };

  return (
    <div className="settings-popup-body">
      <section className="settings-section" aria-label="Apariencia">
        <h3 className="settings-section-title">Apariencia</h3>
        <label className="settings-row">
          <span>Tema</span>
          <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
            <option value="auto">Auto (sigue al sistema)</option>
            <option value="light">Claro</option>
            <option value="dark">Oscuro</option>
          </select>
        </label>
        <label className="settings-row">
          <span>
            Fondo — prompts de imagen
            <small className="settings-row-sub">Una por línea; se eligen al azar.</small>
          </span>
          <textarea
            className="settings-bg-input"
            value={bgText}
            rows={3}
            spellCheck={false}
            onChange={(e) => {
              setBgText(e.target.value);
              setBgErr(null);
            }}
          />
        </label>
        <div className="settings-profile-save">
          {bgErr && <span className="settings-profile-err">{bgErr}</span>}
          <button type="button" onClick={() => void saveBg()} disabled={bgBusy || !bgDirty}>
            Guardar
          </button>
        </div>
      </section>
    </div>
  );
}

// Página de sistema "Idioma y voz": opciones de voz (micrófono / voz / velocidad) e idioma del
// asistente. Se pueblan de /api/me y se cambian mandando los slash-commands por el canal. Antes
// vivían dentro de Configuración; ahora tienen su propia página, arriba de Configuración.
function IdiomaVozPanel({
  mics,
  micsAuthorized,
  micId,
  setMic,
  voice,
  setVoice,
  setVoiceLang,
  setRate,
}: {
  mics: { deviceId: string; label: string }[];
  micsAuthorized: boolean;
  micId: string;
  setMic: (id: string) => void;
  voice?: VoiceCfg;
  setVoice: (nick: string) => void;
  setVoiceLang: (id: string) => void;
  setRate: (rate: string) => void;
}) {
  const voiceOn = !!voice?.enabled;
  return (
    <div className="settings-popup-body">
      <section className="settings-section" aria-label="Idioma">
        <h3 className="settings-section-title">Idioma</h3>
        <label className="settings-row">
          <span>Idioma</span>
          <select
            value={voice?.lang ?? "es"}
            onChange={(e) => setVoiceLang(e.target.value)}
            disabled={!voiceOn || !voice?.langs?.length}
          >
            {voiceOn && voice?.langs?.length ? (
              voice.langs.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))
            ) : (
              <option>no disponible</option>
            )}
          </select>
        </label>
      </section>
      <section className="settings-section" aria-label="Voz y audio">
        <h3 className="settings-section-title">Voz y audio</h3>
        <label className="settings-row">
          <span>Micrófono</span>
          {/* Grayed-out hasta que autorices el mic (sin permiso no hay labels reales). */}
          <select value={micId} onChange={(e) => setMic(e.target.value)} disabled={!micsAuthorized}>
            {micsAuthorized ? (
              <>
                <option value="">Default del sistema</option>
                {mics.map((m) => (
                  <option key={m.deviceId} value={m.deviceId}>
                    {m.label}
                  </option>
                ))}
              </>
            ) : (
              <option>mantené el círculo para autorizar el mic</option>
            )}
          </select>
        </label>
        <label className="settings-row">
          <span>Voz</span>
          <select
            value={voice?.current ?? ""}
            onChange={(e) => setVoice(e.target.value)}
            disabled={!voiceOn || !voice?.voices?.length}
          >
            {voiceOn && voice?.voices?.length ? (
              voice.voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))
            ) : (
              <option>no disponible</option>
            )}
          </select>
        </label>
        <label className="settings-row">
          <span>Velocidad</span>
          <select
            value={voice?.rate ?? ""}
            onChange={(e) => setRate(e.target.value)}
            disabled={!voiceOn || voice?.rateSupported === false}
          >
            {RATE_PRESETS.map((r) => (
              <option key={r.value || "normal"} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      </section>
    </div>
  );
}

// Configuración del asistente: modelo (manda /model, recrea la sesión), pistas del orbe, modo
// debug y la autoría por línea (blame). El idioma y la voz viven ahora en su propia página
// ("Idioma y voz", arriba de Configuración).
function SettingsPanel({
  model,
  setModel,
  debugMode,
  setDebugMode,
  hintsEnabled,
  setHintsEnabled,
  blameOn,
  setBlameOn,
  onClose: _onClose,
}: {
  model?: ModelCfg;
  setModel: (id: string) => void;
  debugMode: boolean;
  setDebugMode: (v: boolean) => void;
  hintsEnabled: boolean;
  setHintsEnabled: (v: boolean) => void;
  blameOn: boolean;
  setBlameOn: (v: boolean) => void;
  onClose: () => void;
}) {
  // Hay modelo para mostrar (≥1 opción). Con una sola se muestra read-only; cambiable sólo con ≥2.
  const modelOn = !!model?.options?.length;
  const modelSelectable = (model?.options?.length ?? 0) > 1;

  // Versión del deploy para la sección de soporte: acá la mostramos SIEMPRE (también en prod) —
  // no aplica la regla de visibilidad del badge (?debugVersion=1), porque en Configuración la
  // versión es info de soporte útil para diagnosticar ("¿qué tenés instalado?"). Graceful:
  // "no disponible" si /api/version todavía no resolvió o el endpoint no existe.
  const versionInfo = useVersionInfo();

  return (
    <div className="settings-popup-body">
      <section className="settings-section" aria-label="Asistente">
        <h3 className="settings-section-title">Asistente</h3>
        <label className="settings-row">
          <span>Modelo</span>
          {/* Cambiar el modelo recrea la sesión (reinicia el contexto). Read-only (grayed-out) si
              la box ofrece un solo modelo: igual se VE cuál es. Sólo cambiable con ≥2 opciones.
              "no disponible" sólo con 0 opciones (→ /api/me no manda `model`). */}
          <select
            value={model?.current ?? ""}
            onChange={(e) => setModel(e.target.value)}
            disabled={!modelSelectable}
          >
            {modelOn ? (
              model?.options.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))
            ) : (
              <option>no disponible</option>
            )}
          </select>
        </label>
        <label className="settings-row settings-row-check">
          <span>
            Pistas del orbe
            <small className="settings-row-sub">Mostrá qué está haciendo ceibo bajo el orbe</small>
          </span>
          <input type="checkbox" checked={hintsEnabled} onChange={(e) => setHintsEnabled(e.target.checked)} />
        </label>
        <label className="settings-row settings-row-check">
          <span>
            Modo debug
            <small className="settings-row-sub">Mostrá las herramientas que usa ceibo</small>
          </span>
          <input type="checkbox" checked={debugMode} onChange={(e) => setDebugMode(e.target.checked)} />
        </label>
      </section>
      {/* Ediciones: el toggle GLOBAL de blame por línea ("quién escribió qué"), que antes vivía
          como botón por-nota en la barra de la nota y luego en su propia página. Prendido → cada
          nota de una wiki con blame disponible (compartida, o personal con distinción humano/IA)
          muestra la autoría por línea. El estado lo persiste App en localStorage (BLAME_KEY). */}
      <section className="settings-section" aria-label="Ediciones">
        <h3 className="settings-section-title">Ediciones</h3>
        <label className="settings-row settings-row-check">
          <span>
            Autoría por línea
            <small className="settings-row-sub">
              Mostrá quién escribió cada línea (git blame) en las notas. Solo aplica a wikis con autoría
              disponible (compartidas).
            </small>
          </span>
          <input type="checkbox" checked={blameOn} onChange={(e) => setBlameOn(e.target.checked)} />
        </label>
      </section>
      {/* Versión: info de soporte. A diferencia del badge del header/home (oculto en prod salvo
          ?debugVersion=1), acá la mostramos SIEMPRE y en todo entorno — quien abre Configuración
          quiere poder decir qué versión está corriendo. Read-only: SHA del deploy + entorno, o
          "no disponible" si /api/version no resolvió. */}
      <section className="settings-section" aria-label="Versión">
        <h3 className="settings-section-title">Versión</h3>
        {/* Fila read-only (sin control): div, no label — no hay input que asociar. */}
        <div className="settings-row">
          <span>
            Build
            <small className="settings-row-sub">SHA del deploy y entorno que estás corriendo.</small>
          </span>
          <span className="settings-version-value">{versionLine(versionInfo)}</span>
        </div>
      </section>
    </div>
  );
}

// Vista de cron tal como la sirve /api/crons (ya formateada por viewCron en el store).
type CronView = {
  id: number;
  title: string;
  what: string;
  kind: "once" | "recur";
  report: "always" | "never" | "conditional";
  nextFireIso: string;
  nextHuman: string;
  recurHuman: string | null;
  channel: string;
  tz: string;
  lastFiredIso: string | null;
};

// Panel de agenda (popup abajo-izquierda, junto al cog): lista los recordatorios (crons)
// activos del usuario. Click en una fila → abre el modal central de edición/detalle; la ✕
// de la fila cancela en el acto. Crear NO se hace acá — sigue conversacional (el agente
// parsea "todos los martes 9am" en el chat). Misma caja que el SettingsPanel.
function AgendaPanel({ onClose: _onClose }: { onClose: () => void }) {
  // null = cargando; [] = sin crons; array = lista. `err` para fallo de red.
  const [crons, setCrons] = useState<CronView[] | null>(null);
  const [err, setErr] = useState(false);
  // Canales persistentes del user (telegram/whatsapp) para el selector del modal.
  const [channels, setChannels] = useState<string[]>([]);
  // Cron abierto en el modal de edición (null = sin modal).
  const [editing, setEditing] = useState<CronView | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/crons");
      if (!r.ok) throw new Error(String(r.status));
      const data = (await r.json()) as { crons: CronView[]; channels?: string[] };
      setCrons(data.crons);
      setChannels(data.channels ?? []);
      setErr(false);
    } catch {
      setErr(true);
      setCrons([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const cancel = useCallback(
    async (id: number) => {
      // Optimista: lo sacamos ya y, si el DELETE falla, recargamos para revertir.
      setCrons((prev) => prev?.filter((c) => c.id !== id) ?? prev);
      try {
        const r = await fetch(`/api/crons/${id}`, { method: "DELETE" });
        if (!r.ok) throw new Error(String(r.status));
      } catch {
        void load();
      }
    },
    [load],
  );

  const once = crons?.filter((c) => c.kind === "once") ?? [];
  const recur = crons?.filter((c) => c.kind === "recur") ?? [];

  // Agrupar únicos por día (derivado client-side de nextFireIso + tz).
  // Devuelve un array de [dayKey, label, crons[]] ordenado por fecha.
  const dayGroups = groupCronsByDay(once);

  return (
    <>
      <div className="settings-popup-body">
        <div className="syspage-head">
          <h1 className="syspage-title">Agenda</h1>
          <p className="syspage-sub">Lo que ceibo tiene agendado para vos.</p>
        </div>
        {crons === null ? (
          <p className="agenda-empty">Cargando…</p>
        ) : err ? (
          <p className="agenda-empty">No pude cargar tu agenda. Probá de nuevo.</p>
        ) : crons.length === 0 ? (
          <div className="agenda-empty-state">
            <p className="agenda-empty-hint">
              <em>
                Todavía no tenés nada agendado. Pedímelo en el chat: «recordame mañana 9am llamar al
                pediatra».
              </em>
            </p>
          </div>
        ) : (
          <>
            {dayGroups.length > 0 && (
              <div className="agenda-timeline">
                <h3 className="settings-section-title agenda-section-eyebrow">Próximos</h3>
                {dayGroups.map(({ dayKey, label, isToday, crons: dayCrons }) => (
                  <div key={dayKey} className="agenda-day-group">
                    <h4 className={`agenda-day-header${isToday ? " agenda-day-today" : ""}`}>{label}</h4>
                    {dayCrons.map((c) => (
                      <AgendaTimelineRow
                        key={c.id}
                        c={c}
                        onOpen={() => setEditing(c)}
                        onCancel={() => void cancel(c.id)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            )}
            {recur.length > 0 && (
              <div className="agenda-timeline agenda-timeline-ritmos">
                <h3 className="settings-section-title agenda-section-eyebrow">Ritmos</h3>
                {recur.map((c) => (
                  <AgendaRecurRow
                    key={c.id}
                    c={c}
                    onOpen={() => setEditing(c)}
                    onCancel={() => void cancel(c.id)}
                  />
                ))}
              </div>
            )}
            <p className="agenda-brand-hint">
              <em>Para agendar algo, pedímelo por chat: «recordame mañana 9am llamar al pediatra».</em>
            </p>
          </>
        )}
      </div>
      {editing && (
        <CronModal
          c={editing}
          channels={channels}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </>
  );
}

// Agrupación de crons únicos por día (client-side). Devuelve grupos ordenados cronológicamente.
type DayGroup = { dayKey: string; label: string; isToday: boolean; crons: CronView[] };

function groupCronsByDay(once: CronView[]): DayGroup[] {
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;

  const DAYS_ES = ["DOM", "LUN", "MAR", "MIÉ", "JUE", "VIE", "SÁB"];
  const MONTHS_ES = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];

  const grouped = new Map<string, CronView[]>();
  for (const c of once) {
    // nextFireIso puede ser "2026-06-11T18:30:00Z" o similar
    const dateKey = c.nextFireIso.slice(0, 10); // "YYYY-MM-DD"
    const existing = grouped.get(dateKey);
    if (existing) {
      existing.push(c);
    } else {
      grouped.set(dateKey, [c]);
    }
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dateKey, crons]) => {
      const [year, month, day] = dateKey.split("-").map(Number) as [number, number, number];
      const date = new Date(year, (month ?? 1) - 1, day ?? 1);
      const weekday = DAYS_ES[date.getDay()] ?? "";
      const monthName = MONTHS_ES[(month ?? 1) - 1] ?? "";

      let label: string;
      const isToday = dateKey === todayStr;
      if (isToday) {
        label = `HOY · ${weekday} ${day ?? ""}`;
      } else if (dateKey === tomorrowStr) {
        label = `MAÑANA · ${weekday} ${day ?? ""}`;
      } else {
        label = `${weekday} ${day ?? ""} ${monthName}`;
      }

      return { dayKey: dateKey, label, isToday, crons };
    });
}

// Fila de timeline para crons únicos: riel izquierdo (│ ember) + hora + título + chip canal + ✕
function AgendaTimelineRow({
  c,
  onOpen,
  onCancel,
}: {
  c: CronView;
  onOpen: () => void;
  onCancel: () => void;
}) {
  // Extraer la hora local del nextFireIso. nextHuman puede ser "hoy a las 18:30"; usamos nextFireIso.
  const timeStr = formatLocalTime(c.nextFireIso, c.tz);
  return (
    <div className="agenda-tl-row">
      <div className="agenda-tl-rail" aria-hidden="true" />
      <button type="button" className="agenda-tl-main" onClick={onOpen} title="Editar / ver detalle">
        <span className="agenda-tl-time">{timeStr}</span>
        <span className="agenda-tl-title">{c.title || c.what}</span>
      </button>
      {c.channel && c.channel !== "all" && (
        <span className="agenda-channel-chip">{channelChipLabel(c.channel)}</span>
      )}
      <button
        type="button"
        className="agenda-cancel"
        onClick={onCancel}
        aria-label="Cancelar recordatorio"
        title="Cancelar"
      >
        <IconX size={14} />
      </button>
    </div>
  );
}

// Fila de ritmos (recurrentes): badge ↻ + título + descripción recurrencia + chip canal + ✕
function AgendaRecurRow({ c, onOpen, onCancel }: { c: CronView; onOpen: () => void; onCancel: () => void }) {
  return (
    <div className="agenda-recur-row">
      <span className="agenda-recur-badge" aria-hidden="true">
        ↻
      </span>
      <button type="button" className="agenda-tl-main" onClick={onOpen} title="Editar / ver detalle">
        <span className="agenda-tl-title">{c.title || c.what}</span>
        {c.recurHuman && <span className="agenda-when">{c.recurHuman}</span>}
      </button>
      {c.channel && c.channel !== "all" && (
        <span className="agenda-channel-chip">{channelChipLabel(c.channel)}</span>
      )}
      <button
        type="button"
        className="agenda-cancel"
        onClick={onCancel}
        aria-label="Cancelar recordatorio"
        title="Cancelar"
      >
        <IconX size={14} />
      </button>
    </div>
  );
}

function channelChipLabel(channel: string): string {
  if (channel === "telegram") return "Telegram";
  if (channel === "whatsapp") return "WhatsApp";
  if (channel === "web") return "Web";
  return channel;
}

// Formatea la hora local de un ISO timestamp usando el tz del cron.
// Si la zona no es reconocible, cae a la hora UTC del string.
function formatLocalTime(isoStr: string, tz: string): string {
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", timeZone: tz, hour12: false });
  } catch {
    // fallback: leer la hora directamente del string ISO (UTC)
    const timePart = isoStr.slice(11, 16);
    return timePart || "—";
  }
}

// --- Panel de conexiones (popup abajo-izquierda, el "enchufe" junto al cog) -------
// Conexiones (v2): dos pestañas — Canales (por dónde hablás con ceibo) y Conexiones (cuentas
// externas que conectás vía OAuth/pairing). El endpoint devuelve el CATÁLOGO completo de
// conectables marcando cuáles están activos, así se ve qué POSIBILIDADES hay además de lo
// conectado. Todo es sólo-lectura: conectar/desconectar sigue siendo por el chat — al entrar a
// un item disponible se explica el comando (/connect …). Misma caja que Agenda/Settings.
type ConnChannel = { type: string; connected: boolean; identities: string[] };
// Un perfil conectado + la cuenta externa real (ej. user@example.com), o null si no se pudo obtener,
// + los permisos legibles otorgados (derivados del scope del grant / catálogo del servicio).
type ConnProfile = { profile: string; account: string | null; permissions: string[]; broken?: boolean };
type ConnService = {
  service: string;
  displayName: string;
  connected: boolean;
  broken?: boolean;
  profiles: ConnProfile[];
};
type ConnData = { channels: ConnChannel[]; connections: ConnService[] };

function channelTypeLabel(t: string): string {
  if (t === "whatsapp") return "WhatsApp";
  if (t === "telegram") return "Telegram";
  if (t === "web") return "Web";
  return t;
}

// Cómo se conecta cada canal (texto del drill-down). Telegram es la raíz de identidad; web es
// este dispositivo; whatsapp se vincula por chat.
function channelHowto(type: string): string {
  if (type === "telegram") return "Telegram es tu identidad raíz en ceibo: ya hablás conmigo por acá.";
  if (type === "web") return "La web es este mismo dispositivo. Tu sesión queda abierta mientras la uses.";
  if (type === "whatsapp")
    return "Vinculado por chat. Para revincular o cambiar de número: «/connect whatsapp +<número con código de país>».";
  return "";
}

// Comando para conectar un servicio por chat (drill-down de un conectable no conectado).
function connectCommand(service: string): string {
  if (service === "whatsapp") return "/connect whatsapp +<número con código de país>";
  return `/connect ${service} <perfil>`;
}

// v2: Canales (página propia) — cards con todo a la vista, sin drill-down.
function ChannelsPanel() {
  const [data, setData] = useState<ConnData | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch("/api/connections");
        if (!r.ok) throw new Error(String(r.status));
        const d = (await r.json()) as ConnData;
        if (alive) {
          setData(d);
          setErr(false);
        }
      } catch {
        if (alive) {
          setErr(true);
          setData({ channels: [], connections: [] });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const channels = data?.channels ?? [];

  return (
    <section aria-label="Canales">
      <div className="settings-popup-body">
        <div className="syspage-head">
          <h1 className="syspage-title">Canales</h1>
          <p className="syspage-sub">Por dónde hablás con ceibo.</p>
        </div>
        {data === null ? (
          <p className="agenda-empty">Cargando…</p>
        ) : err ? (
          <p className="agenda-empty">No pude cargar los canales. Probá de nuevo.</p>
        ) : (
          <div className="channels-cards">
            {channels.map((c) => (
              <ChannelCard key={c.type} c={c} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// Card de canal con todo a la vista (sin drill-down).
function ChannelCard({ c }: { c: ConnChannel }) {
  const label = channelTypeLabel(c.type);
  const howto = channelHowto(c.type);
  // Para whatsapp, el howto incluye el comando /connect; se muestra en <code>.
  const isWhatsApp = c.type === "whatsapp";
  const connectCmd = isWhatsApp ? "/connect whatsapp +<número con código de país>" : null;

  return (
    <div className="channel-card">
      <div className="channel-card-head">
        <span className="channel-card-name">{label}</span>
        <span className={`channel-card-dot${c.connected ? " channel-card-dot-on" : ""}`} aria-hidden="true" />
      </div>
      <span className={`channel-card-status${c.connected ? " channel-card-status-on" : ""}`}>
        {c.type === "web"
          ? c.connected
            ? "Sesión activa"
            : "Sin sesión"
          : c.connected
            ? "Vinculado"
            : "No vinculado"}
      </span>
      {c.identities.length > 0 && (
        <div className="channel-card-ids">
          {c.identities.map((id) => (
            <span key={id} className="channel-card-id">
              {id}
            </span>
          ))}
        </div>
      )}
      <p className="channel-card-howto">
        {isWhatsApp && connectCmd ? (
          <>
            {c.connected ? "Para revincular: " : "Vinculá por chat: "}
            <code className="conn-cmd channel-card-cmd">{connectCmd}</code>
          </>
        ) : (
          howto
        )}
      </p>
    </div>
  );
}

// v2: Conexiones (página propia) — grupos CONECTADAS/DISPONIBLES con eyebrow caps + drill-down.
function ConnectionsPanel({ onClose: _onClose }: { onClose: () => void }) {
  // null = cargando; objeto = datos; `err` para fallo de red.
  const [data, setData] = useState<ConnData | null>(null);
  const [err, setErr] = useState(false);
  const [sel, setSel] = useState<ConnService | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch("/api/connections");
        if (!r.ok) throw new Error(String(r.status));
        const d = (await r.json()) as ConnData;
        if (alive) {
          setData(d);
          setErr(false);
        }
      } catch {
        if (alive) {
          setErr(true);
          setData({ channels: [], connections: [] });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const connections = data?.connections ?? [];
  const connected = connections.filter((c) => c.connected);
  const available = connections.filter((c) => !c.connected);

  return (
    <section aria-label="Conexiones">
      {sel && (
        <div className="conn-drill-head">
          <button
            type="button"
            className="conn-back"
            onClick={() => setSel(null)}
            aria-label="Volver"
            title="Volver"
          >
            <IconArrowLeft size={18} />
          </button>
          <span className="chatpanel-title">{sel.displayName}</span>
        </div>
      )}
      <div className="settings-popup-body">
        {!sel && (
          <div className="syspage-head">
            <h1 className="syspage-title">Conexiones</h1>
            <p className="syspage-sub">Cuentas externas que ceibo puede usar por vos.</p>
          </div>
        )}
        {data === null ? (
          <p className="agenda-empty">Cargando…</p>
        ) : err ? (
          <p className="agenda-empty">No pude cargar tus conexiones. Probá de nuevo.</p>
        ) : sel ? (
          <ServiceDetail c={sel} />
        ) : (
          <div className="conn-groups">
            {connected.length > 0 && (
              <div className="conn-group">
                <h3 className="settings-section-title conn-group-eyebrow">
                  Conectadas
                  <span className="conn-group-count">{connected.length}</span>
                </h3>
                <ConnList
                  items={connected}
                  getKey={(c) => c.service}
                  getLabel={(c) => c.displayName}
                  getSub={(c) =>
                    c.broken
                      ? "venció el permiso · reconectar"
                      : c.profiles
                          .map((p) => (p.account ? `${p.profile} · ${p.account}` : p.profile))
                          .join(", ") || "conectado"
                  }
                  isConnected={(c) => c.connected}
                  isBroken={(c) => !!c.broken}
                  onPick={(c) => setSel(c)}
                  emptyMsg=""
                />
              </div>
            )}
            {available.length > 0 && (
              <div className="conn-group">
                <h3 className="settings-section-title conn-group-eyebrow">
                  Disponibles
                  <span className="conn-group-count">{available.length}</span>
                </h3>
                <ConnList
                  items={available}
                  getKey={(c) => c.service}
                  getLabel={(c) => c.displayName}
                  getSub={() => "conectá por chat"}
                  isConnected={(c) => c.connected}
                  onPick={(c) => setSel(c)}
                  emptyMsg=""
                />
              </div>
            )}
            {connections.length === 0 && <p className="agenda-empty">No hay conexiones para mostrar.</p>}
          </div>
        )}
      </div>
    </section>
  );
}

// Lista genérica de items (canales o conexiones): fila clickeable con estado y chevron.
function ConnList<T>({
  items,
  getKey,
  getLabel,
  getSub,
  isConnected,
  isBroken,
  onPick,
  emptyMsg,
}: {
  items: T[];
  getKey: (t: T) => string;
  getLabel: (t: T) => string;
  getSub: (t: T) => string;
  isConnected: (t: T) => boolean;
  // Tri-estado: conectado PERO roto (venció el permiso) → el punto va en warning y el sub avisa.
  isBroken?: (t: T) => boolean;
  onPick: (t: T) => void;
  emptyMsg: string;
}) {
  if (items.length === 0) return <p className="agenda-empty">{emptyMsg}</p>;
  return (
    <div className="agenda-group">
      {items.map((c) => {
        const on = isConnected(c);
        const broken = isBroken?.(c) ?? false;
        // Roto gana sobre conectado en el color del punto (warning), para que salte a la vista.
        const dotCls = broken ? " conn-dot-broken" : on ? " conn-dot-on" : "";
        return (
          <button key={getKey(c)} type="button" className="conn-row" onClick={() => onPick(c)}>
            <span className={`conn-dot${dotCls}`} aria-hidden="true" />
            <span className="conn-rowtext">
              <span className="agenda-what">{getLabel(c)}</span>
              <span className="agenda-when">{getSub(c)}</span>
            </span>
            <IconArrowRight size={16} />
          </button>
        );
      })}
    </div>
  );
}

// Detalle read-only de un canal.
function ChannelDetail({ c }: { c: ConnChannel }) {
  return (
    <div className="conn-detail">
      <span className={`conn-status${c.connected ? " conn-status-on" : ""}`}>
        {c.connected ? "Vinculado" : "No vinculado"}
      </span>
      {c.identities.length > 0 && (
        <div className="conn-field">
          <span className="conn-field-k">{c.identities.length > 1 ? "Identidades" : "Identidad"}</span>
          {c.identities.map((id) => (
            <span key={id} className="conn-field-v">
              {id}
            </span>
          ))}
        </div>
      )}
      <p className="conn-note">{channelHowto(c.type)}</p>
    </div>
  );
}

// Detalle read-only de una conexión (servicio OAuth / pairing). Por cada perfil mostramos la
// cuenta externa real (ej. user@example.com; "—" si no se pudo obtener) + los permisos legibles.
// v2: labels eyebrow (CUENTA / PERMISOS) + conn-status-on usa --success tokenizado.
function ServiceDetail({ c }: { c: ConnService }) {
  // Tri-estado: desconectado / conectado / conectado-pero-roto (venció el permiso → reconectar).
  const broken = c.connected && !!c.broken;
  const statusCls = broken ? " conn-status-broken" : c.connected ? " conn-status-on" : "";
  const statusText = broken ? "Reconectá" : c.connected ? "Conectado" : "Disponible";
  return (
    <div className="conn-detail">
      <span className={`conn-status${statusCls}`}>{statusText}</span>
      {broken && (
        <p className="conn-note conn-note-broken">
          Venció el permiso de acceso (Google los renueva cada tanto) y dejé de poder usar esta cuenta.
          Reconectala para que vuelva a andar — te dejé el link en las notificaciones (🔔), o pedímelo por
          chat con «reconectá {c.service} {c.profiles.find((p) => p.broken)?.profile ?? "personal"}».
        </p>
      )}
      {c.connected ? (
        <>
          <div className="conn-field">
            <span className="settings-section-title conn-field-eyebrow">
              {c.profiles.length > 1 ? "Cuentas" : "Cuenta"}
            </span>
            {c.profiles.map((p) => (
              <div key={p.profile} className={`conn-acct${p.broken ? " conn-acct-broken" : ""}`}>
                <div className="conn-acct-head">
                  <span className="conn-acct-profile">{p.profile}</span>
                  <span className="conn-acct-sep"> · </span>
                  {p.account ? (
                    <span className="conn-acct-id">{p.account}</span>
                  ) : (
                    <span
                      className="conn-acct-unknown"
                      title="No se pudo obtener la cuenta con los permisos actuales"
                    >
                      —
                    </span>
                  )}
                  {p.broken && (
                    <span className="conn-acct-badge" title="Venció el permiso — hay que reconectar">
                      reconectar
                    </span>
                  )}
                </div>
                {p.permissions.length > 0 && (
                  <>
                    <span className="settings-section-title conn-field-eyebrow">Permisos</span>
                    <ul className="conn-perms">
                      {p.permissions.map((perm) => (
                        <li key={perm} className="conn-perm">
                          {perm}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            ))}
          </div>
          <p className="conn-note">
            Si querés cambiar algo, decíselo al agente por chat — por ejemplo «desconectá {c.service}{" "}
            {c.profiles[0]?.profile ?? "personal"}» o «conectá {c.service} trabajo». Conectar y desconectar
            siempre se hace desde el chat, no desde acá.
          </p>
        </>
      ) : (
        <>
          <p className="conn-note">Conectá {c.displayName} por chat con el comando:</p>
          <code className="conn-cmd">{connectCommand(c.service)}</code>
          <p className="conn-note">Conectar y desconectar siempre se hace por el chat, no desde acá.</p>
        </>
      )}
    </div>
  );
}

function CronRowView({ c, onOpen, onCancel }: { c: CronView; onOpen: () => void; onCancel: () => void }) {
  return (
    <div className="agenda-row">
      <button type="button" className="agenda-row-main" onClick={onOpen} title="Editar / ver detalle">
        <span className="agenda-what">{c.title || c.what}</span>
        <span className="agenda-when">{c.recurHuman ?? c.nextHuman}</span>
      </button>
      <button
        type="button"
        className="agenda-cancel"
        onClick={onCancel}
        aria-label="Cancelar recordatorio"
        title="Cancelar"
      >
        <IconX size={16} />
      </button>
    </div>
  );
}

// --- Modal de edición/detalle de un recordatorio ------------------------------
// v1: el modal edita el texto y el canal de entrega del recordatorio. El cuándo
// (fecha/recurrencia) se muestra en lectura y para cambiarlo se le pide al agente por
// el chat (ahí vive el parseo NL). El selector de canal sólo aparece si el usuario
// tiene ≥2 canales persistentes (Telegram/WhatsApp); web no es opción de delivery.
function channelLabel(v: string): string {
  if (v === "whatsapp") return "WhatsApp";
  if (v === "all") return "Todos";
  return "Telegram";
}

function CronModal({
  c,
  channels,
  onClose,
  onSaved,
}: {
  c: CronView;
  channels: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(c.title);
  const [what, setWhat] = useState(c.what);
  const initChannel = c.channel === "whatsapp" || c.channel === "all" ? c.channel : "telegram";
  const [channel, setChannel] = useState<string>(initChannel);
  // 'conditional' no se expone (no implementado) → cae a 'always' en el selector.
  const [report, setReport] = useState<"always" | "never">(c.report === "never" ? "never" : "always");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // El selector sólo tiene sentido si hay ≥2 canales persistentes para elegir.
  const hasSelector = channels.length >= 2;

  // Escape cierra el modal (el codebase no usa click-afuera; se cierra por la ✕/Cerrar).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    const text = what.trim();
    if (!text) {
      setErr("El recordatorio no puede quedar vacío.");
      return;
    }
    setSaving(true);
    setErr(null);
    const body: { title?: string; what: string; channel?: string; report: "always" | "never" } = {
      what: text,
      report,
    };
    const t = title.trim();
    if (t) body.title = t;
    if (hasSelector) body.channel = channel;
    try {
      const r = await fetch(`/api/crons/${c.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(String(r.status));
      onSaved();
    } catch {
      setErr("No pude guardar. Probá de nuevo.");
      setSaving(false);
    }
  };

  // "Cuándo" en lectura: la recurrencia humana, o el próximo disparo si es one-shot.
  const cuando = c.recurHuman ?? c.nextHuman;
  // Línea de entrega cuando NO hay selector: el único canal persistente, o web (fallback).
  const soloCanal = channels[0] ? channelLabel(channels[0]) : "la web (cuando la tengas abierta)";

  return (
    <div className="cron-modal-backdrop">
      <section className="cron-modal" aria-label="Recordatorio">
        <header className="chatpanel-head">
          <span className="chatpanel-title">Recordatorio</span>
          <button type="button" className="view-close" onClick={onClose} aria-label="Cerrar" title="Cerrar">
            <IconX />
          </button>
        </header>
        <div className="cron-modal-body">
          <input
            className="cron-modal-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Título corto"
            maxLength={80}
            aria-label="Título del recordatorio"
          />
          <textarea
            className="cron-modal-text"
            value={what}
            onChange={(e) => setWhat(e.target.value)}
            placeholder="¿Qué te recuerdo?"
            rows={3}
          />

          <div className="cron-modal-when">
            <p className="cron-modal-detail">Por ahora se ejecuta: {cuando}</p>
            <label className="cron-modal-channel">
              <span>Aviso</span>
              <select value={report} onChange={(e) => setReport(e.target.value as "always" | "never")}>
                <option value="always">Con reporte al chat</option>
                <option value="never">Silencioso</option>
              </select>
            </label>
            {hasSelector ? (
              <label className="cron-modal-channel">
                <span>Te llega por</span>
                <select value={channel} onChange={(e) => setChannel(e.target.value)}>
                  <option value="telegram">Telegram</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="all">Todos</option>
                </select>
              </label>
            ) : (
              <p className="cron-modal-detail">Te llega por {soloCanal}</p>
            )}
            <p className="cron-modal-hint">
              Para cambiar la fecha, la hora o la repetición, pedíselo al agente por el chat.
            </p>
          </div>

          {err && <p className="cron-modal-err">{err}</p>}

          <div className="cron-modal-actions">
            <button type="button" className="cron-btn-primary" onClick={() => void save()} disabled={saving}>
              {saving ? "Guardando…" : "Guardar"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

// Forma de onda HISTÓRICA del micrófono mientras grabás (feedback "te estoy escuchando",
// estilo la app Claude). Reemplaza al input. Arranca como una línea plana; el volumen entra
// por la DERECHA y scrollea a la IZQUIERDA. Dibujado en CANVAS 2D (redibujo barato a 60fps,
// scroll fluido) — la versión DOM previa actualizaba a pasos y se veía a tirones.
const MIC_SAMPLES = 150; // ~2.5s de historial a 60fps (una muestra por frame)
function MicWave({
  level,
  samples = MIC_SAMPLES,
  className = "micwave",
  background = true,
  levelScale = 1,
}: {
  level: () => number;
  samples?: number;
  className?: string;
  /** Dibuja la píldora oscura de fondo (default true). Pasá false para la variante
   *  de manos libres, donde el canvas flota sobre el dock sin fondo propio. */
  background?: boolean;
  /** Escala VISUAL de la influencia del volumen en la altura de las barras (default 1). NO toca
   *  el `level()` real (que también drivea el orbe): solo atenúa lo que dibuja esta onda. */
  levelScale?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const hist = new Array<number>(samples).fill(0); // [0]=viejo (izq) … [N-1]=nuevo (der)
    // Mide con getBoundingClientRect (no clientWidth: para un canvas absolute con inset:0 puede
    // leer 0 en el primer frame, antes de que asiente el layout → el canvas quedaba 1×1 y la onda
    // "no aparecía"). Devuelve si el tamaño quedó usable (>1px) para que el draw se auto-cure.
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      return rect.width > 1 && rect.height > 1;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    let sized = resize();
    let raf = 0;
    const draw = () => {
      // Hasta tener un tamaño real, reintentá medir cada frame (sin esto, si el 1er resize cayó
      // con el canvas a 0px, la onda quedaba congelada en 1×1 aunque el audio entrara).
      if (!sized) sized = resize();
      hist.shift();
      hist.push(level());
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      if (background) {
        // Fondo oscuro translúcido (la píldora de "escuchando") para que las barras BLANCAS
        // contrasten en cualquier tema; el border-radius del canvas (CSS) lo recorta a píldora.
        ctx.fillStyle = "rgba(20, 20, 22, 0.55)";
        ctx.fillRect(0, 0, w, h);
      }
      // Barras BLANCAS (pedido del owner: la onda va en blanco, no en ember).
      ctx.fillStyle = "#ffffff";
      const slot = w / samples;
      const bw = Math.max(1, slot * 0.6);
      const cy = h / 2;
      const maxH = h * 0.92;
      // Línea de cero (sin audio): altura mínima fina para que se vea como una línea sutil.
      const minH = Math.max(1, h * 0.02);
      for (let i = 0; i < samples; i++) {
        const bh = Math.max(minH, Math.min(1, (hist[i] ?? 0) * levelScale) * maxH);
        const x = i * slot + (slot - bw) / 2;
        const y = cy - bh / 2;
        const r = bw / 2;
        ctx.beginPath();
        ctx.roundRect(x, y, bw, bh, r);
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [level, samples, background, levelScale]);
  return <canvas ref={ref} className={className} role="img" aria-label="Escuchando…" />;
}
