// Substrato MA del wiki-sync: convierte el `wikiSync` NEUTRAL de la SessionConfig
// (`{ token, url }`) en File resources de Managed Agents. Vive ACÁ (abajo de la costura,
// junto a `makeMaBackend`) y no en el gateway, para que la SessionConfig sea backend-neutral:
// el gateway sólo firma el token y pasa la URL; CÓMO se entrega al sustrato es asunto de cada
// backend (MA → Files API + File resources; archima → cp.sh a la VM).
//
// Sube dos archivos a la Files API y los devuelve como mounts:
//   - el script wiki-sync.mjs (estático; URL inyectada al frente; file_id cacheado por URL)
//   - el token firmado del user (lo recibe ya firmado; file_id cacheado por valor de token)
//
// SEGURIDAD: el token que va al sandbox es el FIRMADO (`<userId>.<hmac>`), NO el de GitHub.
// El sandbox lo lee del archivo montado (no del contexto del modelo). La URL del endpoint
// (pública, no secreta) se INYECTA en el script al subirlo (MA no tiene env vars).

import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { toFile } from "@anthropic-ai/sdk";

// MA reparenta los File resources bajo /mnt/session/uploads/ (mount_path relativo a ahí). Los
// paths REALES en el sandbox son /mnt/session/uploads/<mount_path>:
//   - el agente corre `node /mnt/session/uploads/wiki-sync.mjs ...`
//   - el script lee el token de /mnt/session/uploads/wiki-token (se lo inyectamos al subir)
const MNT_BASE = "/mnt/session/uploads";
const SYNC_SCRIPT_MOUNT = "wiki-sync.mjs";
const SYNC_TOKEN_MOUNT = "wiki-token";
/** Path absoluto del script en el sandbox MA — el prompt/adapter referencia esta ruta. */
export const SYNC_SCRIPT_PATH = `${MNT_BASE}/${SYNC_SCRIPT_MOUNT}`;

const scriptSrcUrl = new URL("../wiki-sync.mjs", import.meta.url);

/** Un File resource a montar en la sesión. */
export interface MountFile {
  fileId: string;
  mountPath: string;
}

// Cache de file_ids. El script es el mismo para todos (cacheado por la URL inyectada); el
// token es determinístico por user → cacheado por su valor (se sube una vez por user).
let scriptCache: { url: string; fileId: string } | undefined;
const tokenFileByValue = new Map<string, string>();

// Reintentos de la subida a la Files API. Un blip transitorio (503 overloaded, 429, 5xx, o
// error de red) NO debe dejar la sesión sin sync para toda su vida — el costo de fallar es
// "wikis mudas hasta abrir otra conversación", mucho mayor que ~unos segundos de latencia al
// crear la sesión. El SDK ya reintenta 2x; esto suma un colchón con backoff exponencial.
const UPLOAD_ATTEMPTS = 4;
const UPLOAD_BACKOFF_MS = 500; // 0.5s, 1s, 2s entre intentos

interface RetryOpts {
  attempts: number;
  backoffMs: number;
  sleep: (ms: number) => Promise<void>;
}

const defaultRetry: RetryOpts = {
  attempts: UPLOAD_ATTEMPTS,
  backoffMs: UPLOAD_BACKOFF_MS,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** ¿Vale la pena reintentar este error? Transitorios: 5xx, 429, overloaded, o sin status (red). */
function isTransient(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  if (status === undefined) return true; // error de red / sin respuesta HTTP
  return status === 429 || status >= 500;
}

/** Corre `fn` reintentando errores transitorios con backoff exponencial. El último error se
 *  propaga (lo captura el best-effort de uploadWikiSyncResources). */
async function withRetry<T>(fn: () => Promise<T>, retry: RetryOpts): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retry.attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === retry.attempts - 1 || !isTransient(e)) throw e;
      await retry.sleep(retry.backoffMs * 2 ** attempt);
    }
  }
  throw lastErr; // inalcanzable (el loop siempre retorna o tira), pero satisface el tipo
}

/** Sube el script con la URL del endpoint inyectada (idempotente: una vez por URL). */
async function ensureScriptFile(client: Anthropic, url: string, retry: RetryOpts): Promise<string> {
  if (scriptCache && scriptCache.url === url) return scriptCache.fileId;
  const body = readFileSync(scriptSrcUrl, "utf8");
  // Inyecta al frente la URL del endpoint (pública) y el path del token montado, así el script
  // no depende de defaults ni de env vars (MA no tiene): single source = el config del gateway.
  const prelude = [
    `process.env.WIKI_SYNC_URL ??= ${JSON.stringify(url)};`,
    `process.env.WIKI_SYNC_TOKEN_FILE ??= ${JSON.stringify(`${MNT_BASE}/${SYNC_TOKEN_MOUNT}`)};`,
  ].join("\n");
  // El File se construye dentro del closure: cada reintento necesita un stream fresco (el
  // anterior ya quedó consumido por el upload que falló).
  const up = await withRetry(
    async () =>
      client.beta.files.upload({
        file: await toFile(Buffer.from(`${prelude}\n${body}`, "utf8"), "wiki-sync.mjs"),
      }),
    retry,
  );
  scriptCache = { url, fileId: up.id };
  return up.id;
}

/** Sube el token firmado del user (idempotente por valor de token). */
async function ensureTokenFile(client: Anthropic, token: string, retry: RetryOpts): Promise<string> {
  const cached = tokenFileByValue.get(token);
  if (cached) return cached;
  const up = await withRetry(
    async () => client.beta.files.upload({ file: await toFile(Buffer.from(token, "utf8"), "wiki-token") }),
    retry,
  );
  tokenFileByValue.set(token, up.id);
  return up.id;
}

/** File resources de sync para montar en una sesión MA: el script (con la URL inyectada) + el
 *  token firmado (ya viene firmado en `wikiSync.token`). Best-effort: si la Files API falla, NO
 *  rompe la creación de sesión — devuelve [] (el agente sigue con el resto de sus tools). */
export async function uploadWikiSyncResources(
  client: Anthropic,
  wikiSync: { token: string; url: string } | undefined,
  retryOver?: Partial<RetryOpts>,
): Promise<MountFile[]> {
  if (!wikiSync?.token || !wikiSync?.url) return [];
  const retry: RetryOpts = { ...defaultRetry, ...retryOver };
  try {
    const [scriptFileId, tokenFileId] = await Promise.all([
      ensureScriptFile(client, wikiSync.url.replace(/\/+$/, ""), retry),
      ensureTokenFile(client, wikiSync.token, retry),
    ]);
    return [
      { fileId: scriptFileId, mountPath: SYNC_SCRIPT_MOUNT },
      { fileId: tokenFileId, mountPath: SYNC_TOKEN_MOUNT },
    ];
  } catch (e) {
    console.warn(
      `uploadWikiSyncResources: no pude montar el sync (sigo sin él): ${(e as Error)?.message ?? e}`,
    );
    return [];
  }
}
