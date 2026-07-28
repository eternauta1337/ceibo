// Drafts persistentes del editor (Fase A de "notas rock solid"): el buffer del editor se
// espeja acá EN CADA CAMBIO, para que lo tipeado sobreviva al remount del editor (refresh
// externo / conflicto) y al cierre/crash de la pestaña. Es la red de seguridad del tramo
// buffer→commit, que hoy vive solo en memoria de CodeMirror.
//
// Diseño en dos capas, y el ORDEN importa:
//  - **Memoria** (`mem`): write-through SÍNCRONO en cada saveDraft. Es la fuente de verdad
//    de la sesión y da read-your-writes inmediato: un remount del editor (key de React)
//    corre el cleanup del viejo y el mount del nuevo en el MISMO hilo, así que el
//    `loadDraft` del mount nuevo SIEMPRE ve la última tecla — sin esperar a IndexedDB.
//    Esto garantiza "el draft está escrito antes de cualquier remount".
//  - **IndexedDB** (no localStorage: las notas pueden ser grandes, ~5MB de límite y API
//    síncrona que bloquearía el tipeo): persistencia real entre sesiones/crashes. Se
//    flushea con throttle (trailing: el flush escribe el estado ACTUAL de mem, así la
//    última tecla de una ráfaga siempre llega) + flush inmediato en pagehide/unmount.
//
// Key del draft = (handle, repo, path) — el handle aísla cuentas que comparten browser.
// Limitación conocida: dos pestañas sobre la MISMA nota comparten key → last-writer-wins
// del draft (la Fase B / fix del feed atacan ese escenario).
//
// Si IndexedDB no está disponible (Safari private mode viejo, storage corrupto), TODO sigue
// andando contra `mem`: se pierde la persistencia entre sesiones, nunca el editor.

import { withTrailingNewline } from "./noteContent.ts";

export interface DraftRecord {
  k: string; // draftKeyOf(handle, repo, path)
  content: string; // archivo COMPLETO (con el H1 oculto), comparable 1:1 con el server
  baseSha?: string; // sha del que partió el buffer (el baseSha del próximo autosave)
  ts: number; // última escritura (epoch ms) — para el prune de drafts viejos
}

const DB_NAME = "ceibo-drafts";
const STORE = "drafts";
const FLUSH_MS = 400; // throttle de escritura a IDB (trailing): 1 write máx. cada 400ms por key
const PRUNE_AGE_MS = 30 * 24 * 3600_000; // drafts sin tocar hace 30 días se podan al abrir la DB

// `\u001f` (unit separator) no aparece en handles/repos/paths → key compuesta sin ambigüedad.
export function draftKeyOf(handle: string, repo: string, path: string): string {
  return `${handle}\u001f${repo}\u001f${path}`;
}

/** ¿El draft está VIVO? = existe y su contenido difiere del último confirmado (server/save).
 *  Un draft cuyo contenido == lo confirmado es residuo de un save exitoso → no se rehidrata.
 *  La comparación es TOLERANTE al `\n` terminal: el save commitea con `withTrailingNewline`
 *  (y el server devuelve esa forma), pero el buffer del editor que onChange espeja al draft
 *  NO lo tiene → sin normalizar, un draft recién guardado se leía como "vivo" por ese único
 *  `\n` de diferencia y se rehidrataba en cada remount (falso positivo crónico del cartel). */
export function isDraftLive(d: DraftRecord | null, confirmed: string): d is DraftRecord {
  return !!d && withTrailingNewline(d.content) !== withTrailingNewline(confirmed);
}

/** ¿Rehidratar el draft en silencio al montar? Sí SOLO si es trabajo tuyo sin guardar que
 *  continúa EXACTAMENTE la versión que el server tiene ahora (`baseSha === serverSha`). Si el
 *  server avanzó a una versión de la que este draft NO partió (editaste la misma nota desde
 *  otro lado — otra pestaña, un editor local que sincroniza por git — y eso ya está en el
 *  server), el draft quedó VIEJO: rehidratarlo taparía el contenido nuevo del server y, como se
 *  marca dirty, lo mandaría a pisar por el autosave. En ese caso preferimos lo del server (el
 *  caller descarta el draft viejo). Un draft cuyo contenido == lo del server (residuo de un save)
 *  tampoco se rehidrata. */
export function shouldRestoreDraft(
  d: DraftRecord | null,
  serverContent: string,
  serverSha: string | undefined,
): d is DraftRecord {
  if (!isDraftLive(d, serverContent)) return false;
  return d.baseSha !== undefined && d.baseSha === serverSha;
}

// --- Estado de sesión ---------------------------------------------------------------

// `null` = tombstone: el draft se borró en esta sesión (que un loadDraft posterior no
// resucite el registro de IDB cuyo delete todavía está en vuelo).
const mem = new Map<string, DraftRecord | null>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const idb = globalThis.indexedDB;
      if (!idb) {
        resolve(null);
        return;
      }
      const req = idb.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: "k" });
        }
      };
      req.onsuccess = () => {
        prune(req.result);
        resolve(req.result);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null); // IDB roto/deshabilitado → modo solo-memoria
    }
  });
  return dbPromise;
}

/** Poda drafts viejos (>30 días sin tocar) al abrir la DB. Fire-and-forget y defensivo:
 *  un fallo acá nunca afecta al editor. */
function prune(db: IDBDatabase): void {
  try {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    const req = store.getAll();
    req.onsuccess = () => {
      const cutoff = Date.now() - PRUNE_AGE_MS;
      for (const rec of req.result as DraftRecord[]) {
        if (typeof rec.ts === "number" && rec.ts < cutoff) {
          try {
            store.delete(rec.k);
          } catch {
            /* best effort */
          }
        }
      }
    };
  } catch {
    /* best effort */
  }
}

async function idbPut(rec: DraftRecord): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function idbGet(key: string): Promise<DraftRecord | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => {
        const r = req.result as DraftRecord | undefined;
        resolve(r && typeof r.content === "string" ? r : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbGetAll(): Promise<DraftRecord[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      req.onsuccess = () =>
        resolve((req.result as DraftRecord[]).filter((r) => r && typeof r.content === "string"));
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/** Persiste a IDB el estado ACTUAL de mem para la key (trailing del throttle). */
function persist(key: string): Promise<void> {
  const rec = mem.get(key);
  if (!rec) return Promise.resolve(); // tombstone/ausente: el delete ya lo emitió clearDraft
  return idbPut(rec);
}

// --- API ------------------------------------------------------------------------------

/** Espeja el buffer al draft. SÍNCRONO en memoria (la garantía anti-remount); el write a
 *  IDB va con throttle trailing (≤400ms de atraso, que cubren flushDraft/pagehide). */
export function saveDraft(key: string, d: { content: string; baseSha?: string }): void {
  mem.set(key, { k: key, content: d.content, baseSha: d.baseSha, ts: Date.now() });
  if (!timers.has(key)) {
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        void persist(key);
      }, FLUSH_MS),
    );
  }
}

/** Flush inmediato a IDB del estado actual (cancela el throttle pendiente). Para
 *  pagehide/unmount. La promesa resuelve cuando la transacción terminó (útil en tests). */
export function flushDraft(key: string): Promise<void> {
  const t = timers.get(key);
  if (t) {
    clearTimeout(t);
    timers.delete(key);
  }
  return persist(key);
}

/** Lee el draft: memoria primero (refleja la última tecla y los borrados de esta sesión),
 *  IDB después (recuperación tras cierre/crash). */
export async function loadDraft(key: string): Promise<DraftRecord | null> {
  if (mem.has(key)) return mem.get(key) ?? null;
  const rec = await idbGet(key);
  // No pisar mem si alguien escribió durante el await (carrera load vs onChange).
  if (!mem.has(key)) mem.set(key, rec);
  return mem.get(key) ?? null;
}

/** Borra el draft (memoria + IDB). Deja tombstone en mem para que un load posterior no
 *  resucite el registro de IDB mientras el delete está en vuelo. */
export function clearDraft(key: string): Promise<void> {
  const t = timers.get(key);
  if (t) {
    clearTimeout(t);
    timers.delete(key);
  }
  mem.set(key, null);
  return idbDelete(key);
}

/** Borra el draft SOLO si su contenido sigue siendo exactamente `content` (lo que el save
 *  acaba de confirmar). Si el usuario tipeó después del PUT, mem ya tiene el contenido más
 *  nuevo (saveDraft es síncrono) → no borra: el draft nuevo sigue protegido. La comparación
 *  es síncrona en el main thread → sin carrera posible con onChange. */
export function clearDraftIfUnchanged(key: string, content: string): Promise<void> {
  const cur = mem.get(key);
  // Tolerante al `\n` terminal, igual que isDraftLive: el draft (buffer crudo del editor, sin
  // `\n` final) tiene que reconocerse como "== lo guardado" contra el contenido newline-terminado
  // que se commiteó, o el residuo nunca se limpiaba y quedaba "vivo" para el próximo remount.
  if (!cur || withTrailingNewline(cur.content) !== withTrailingNewline(content)) {
    return Promise.resolve();
  }
  return clearDraft(key);
}

/** Re-keyea un draft vivo (rename de la nota: cambia el path → cambia la key). */
export function moveDraft(oldKey: string, newKey: string): void {
  if (oldKey === newKey) return;
  const cur = mem.get(oldKey);
  if (!cur) return;
  saveDraft(newKey, { content: cur.content, baseSha: cur.baseSha });
  void clearDraft(oldKey);
}

/** Todos los drafts conocidos (IDB ∪ memoria; memoria gana, tombstones excluidos). */
export async function listDrafts(): Promise<DraftRecord[]> {
  const out = new Map<string, DraftRecord>();
  for (const r of await idbGetAll()) out.set(r.k, r);
  for (const [k, r] of mem) {
    if (r) out.set(k, r);
    else out.delete(k);
  }
  return [...out.values()];
}

/** Solo para tests: limpia el estado de sesión y suelta la conexión a la DB. */
export function _resetDraftStoreForTests(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  mem.clear();
  if (dbPromise) {
    void dbPromise.then((db) => db?.close());
    dbPromise = null;
  }
}
