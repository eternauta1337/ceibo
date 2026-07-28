// CLI de admin de ceibo. Sin deps: node:util parseArgs.
//
//   ceibo <comando> ...      (en la box; o `pnpm cli <comando>` en local)
//
// Los usuarios se referencian por su HANDLE (slug humano: `owner`, `juana`), no
// por número. La DB es la misma que usa el gateway (CEIBO_DB_PATH, o el default
// del store).

import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { DEFAULT_PROFILE, knownService, SERVICE_NAMES, sanitizeProfile } from "@ceibo/oauth";
import {
  type AuthorizedEmail,
  addAuthorizedEmail,
  addChannel,
  addRepo,
  addUser,
  adminCancelCron,
  approveWaitingEmail,
  backfillOwnedWikiLabels,
  clearUserSession,
  createEnrollToken,
  type Db,
  defaultDbPath,
  firstUserForRepo,
  getRepoByName,
  getUserByHandle,
  grantAccess,
  hasUserPassword,
  isValidHandle,
  listAllRepos,
  listAuthorizedEmails,
  listBroadcasts,
  listChannels,
  listCrons,
  listGrantsForUser,
  listReposForUser,
  listUsers,
  listWaitingList,
  MARKUP,
  modelUsageReport,
  openDb,
  pruneCrons,
  type Repo,
  rejectWaitingEmail,
  removeAuthorizedEmail,
  removeChannel,
  removeRepo,
  renameRepoInStore,
  renameUser,
  repoFullName,
  revokeAccess,
  setAdmin,
  setDefaultProfile,
  setRepoLabel,
  setRepoPersonal,
  setUserBackendMode,
  setUserName,
  setUserPassword,
  setUserStatus,
  spendDaily,
  spendReport,
  type User,
  usersForRepo,
  type WaitingStatus,
  wikiLabel,
} from "@ceibo/store";
import {
  ARCHIVE_MANIFEST,
  ARCHIVE_MANIFEST_LEGACY,
  assertValidLabel,
  type Change,
  seedWelcomeNote,
  userRepoName,
  wikisFromEnv,
} from "@ceibo/wikis";
import { broadcastLine, isYes, label, renderDaily, renderModelUsage, renderSpendReport } from "./format.ts";

// Canales con adapter activo. `channel add` valida contra esto (nada implícito).
// `cli` = canal local de impersonación (ceibo chat <handle>) vía el socket del gateway.
// `whatsapp` = canal del bot (wacli); el external_id es el JID del remitente — OJO: WhatsApp
// suele entregarlo como LID anónimo (`<id>@lid`), no como `<phone>@s.whatsapp.net`. Registrá
// el que loguea el gateway (`ignorado: whatsapp:<id> (no autorizado)`), no el número.
// `google` = identidad de login web por Google Sign-In (Fase 4.5); el external_id es el
// email verificado (lowercased) → el set de identidades `google` ES el allowlist.
// `email` = identidad de login web por email + contraseña; el external_id es el email
// (lowercased). Allowlist igual que `google`; la contraseña se setea con `user passwd`.
const KNOWN_CHANNELS = ["telegram", "whatsapp", "cli", "google", "email"];

// Base pública del servicio OAuth (la URL de la box). Arma el link de
// `oauth enroll`. La fija el deploy (OAUTH_BASE_URL).
function reqOauthBase(): string {
  const base = process.env.OAUTH_BASE_URL;
  if (!base) die("falta OAUTH_BASE_URL en el entorno (la URL pública del servicio oauth)");
  return base.replace(/\/+$/, "");
}

// Org de GitHub donde viven las wikis. La fija el deploy (GITHUB_WIKIS_ORG).
function reqOrg(): string {
  const org = process.env.GITHUB_WIKIS_ORG;
  if (!org) die("falta GITHUB_WIKIS_ORG en el entorno (la org de las wikis)");
  return org;
}

const USAGE = `ceibo admin CLI — los usuarios se referencian por su handle (slug)

Usuarios
  user add <handle> [--name "Nombre"] [--key <anthropic_key>]   crea un usuario
  user list                                                     lista usuarios + canales
  user rename <handle> <nuevo-handle>                           cambia el handle (canales/repos/vault intactos)
  user set-name <handle> <nombre>                               cambia el nombre de display
  user enable <handle> | user disable <handle>                  habilita / saca del allowlist
  user set-default-profile <handle> <perfil|"">                 perfil default multi-cuenta ("" para borrar)
  user set-backend <handle> <ma|local>                          backend de sesión (ma = Managed Agents, local = infra propia)
  user passwd <handle>                                          setea la contraseña de login web (lee de stdin)
                                                                  printf '%s' 'pw' | ceibo user passwd <handle>
  user admin <handle> [--off]                                   setea (o quita con --off) el flag admin del usuario

Lista de espera (cola de admisión — invitaciones P2)
  waitlist list [--status pending|approved|rejected]            lista la cola (default: todos)
  waitlist approve <email> [--name "Nombre"] [--handle <h>]    aprueba + manda mail de acceso
  waitlist reject <email>                                       rechaza (sin mail)

Canales (identidad de un usuario en un canal = allowlist + ruteo)
  channel add <handle> <canal> <external_id>   asocia una identidad (canal explícito)
  channel remove <handle> <canal> [external_id]  saca una identidad (todas las del canal si se omite el id)
  channel list [handle]                        lista identidades
  canales disponibles: ${KNOWN_CHANNELS.join(", ")}
  (telegram external_id = el id numérico de Telegram de la persona)

Registración (allowlist invite-only: emails que pueden auto-crear cuenta al entrar con Google)
  allow add <email> [--name "Nombre"] [--handle <h>] [--note "..."]  autoriza un email
  allow list                                   lista los emails autorizados (usado / sin usar)
  allow remove <email>                         saca un email (no borra la cuenta ya creada)

Repos (wikis = repos git; acceso N:N, se montan en la sesión del usuario)
  repo create <handle> <label>        crea la wiki "<handle>-<label>" en la org y se la da a <handle>
  repo rename <viejo> <nuevo> --label <l>  renombra en GitHub (deja redirect) + store + active_wiki
  repo label <name> <label|-->        setea (o limpia con --) el alias de display de un repo
  repo backfill-labels <h> --from <h-viejo>  congela el label (del handle viejo) en wikis sin label, tras un user rename
  repo set-personal <name>            marca la wiki como personal del dueño (personal=1: no borrable/archivable)
  repo import <name>                  registra un repo que YA existe en la org (migración)
  repo migrate-archive <name>|--all [--apply]  renombra manifests _archivado.md → .archived.md (dry-run sin --apply)
  repo rm <name>                      saca el repo del store (NO borra de GitHub)
  repo grant <name> <handle>          da acceso de un usuario a un repo (compartir)
  repo revoke <name> <handle>         saca el acceso
  repo list [handle]                  lista repos (todos, o los de un usuario); [label] *=derivado

OAuth (conectar cuentas externas — credencial en el vault del usuario)
  oauth enroll <handle> <service>    genera un link de UN SOLO USO para conectar
                                     una cuenta (servicios: ${SERVICE_NAMES.join(", ")})

Crons (recordatorios/tareas programadas — los CREA el agente vía el MCP schedule)
  cron list [handle]                 lista crons (todos, o de un usuario; todos los estados)
  cron cancel <id>                   cancela un cron por id (override admin)
  cron prune                         borra los crons terminados (done/cancelled)

Broadcast (anuncio de la empresa a todos — requiere el gateway corriendo)
  broadcast send <texto>                       envía un anuncio a todos los usuarios por Telegram (pide confirmación)
  broadcast list                               lista los anuncios enviados (auditoría)

Chat (impersonación local — canal cli, requiere el gateway corriendo)
  chat <handle>                                abre un REPL hablando como ese usuario

Gasto
  usage [handle]                               reporte (todos si se omite)
  usage [handle] --daily [--days N]            consumo por día (sparkline; últimos N días)
  usage [handle] --models [--days N]           consumo agregado por modelo (para comparar rollouts)

  help                                         esta ayuda
`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Resuelve un handle a un usuario o aborta con mensaje claro. */
function reqUser(db: Db, handle: string | undefined): User {
  if (!handle) die("falta <handle>");
  const u = getUserByHandle(db, handle);
  if (!u) die(`no existe el usuario "${handle}" (usá: ceibo user list)`);
  return u;
}

/** Una línea de `allow list`: email, estado (usado/sin usar) y los seeds que cargó el admin. */
function formatAllowEntry(e: AuthorizedEmail): string {
  const used = e.used_at ? `usado ${e.used_at.slice(0, 10)}` : "sin usar";
  const meta = [
    e.handle ? `handle:${e.handle}` : null,
    e.name ? `name:${e.name}` : null,
    e.note ? `note:${e.note}` : null,
  ]
    .filter(Boolean)
    .join("  ");
  return `${e.email}  [${used}]${meta ? `  ${meta}` : ""}`;
}

/** Path del control socket del gateway. Debe coincidir con controlSockPath() del gateway. */
function gatewaySockPath(): string {
  return process.env.GATEWAY_SOCK ?? join(dirname(defaultDbPath()), "gateway.sock");
}

// REPL de impersonación: habla como <handle> por el canal `cli` a través del
// socket del gateway. El gateway corre el MISMO handleIncoming que Telegram, así
// que comandos (/connect, /new, …), ruteo y metering son idénticos.
async function runChat(db: Db, handle: string | undefined): Promise<void> {
  const u = reqUser(db, handle);
  const cli = listChannels(db, u.id).find((c) => c.channel === "cli");
  if (!cli) {
    die(`"${u.handle}" no tiene canal cli. Agregalo:  ceibo channel add ${u.handle} cli ${u.handle}`);
  }
  const sockPath = gatewaySockPath();
  if (!existsSync(sockPath)) {
    die(`no encuentro el socket del gateway (${sockPath}). ¿Está corriendo ceibo-gateway?`);
  }

  await new Promise<void>((resolve) => {
    const conn = createConnection(sockPath);
    let buf = "";
    conn.on("connect", () => {
      conn.write(`${JSON.stringify({ t: "hello", externalId: cli.external_id })}\n`);
      console.log(`Chat como ${label(u)} (canal cli). Escribí; Ctrl-D o Ctrl-C para salir.\n`);
    });
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line.trim()) continue;
        let m: { t?: string; text?: string; e?: string };
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.t === "out") process.stdout.write(`\n🤖 ${m.text}\n> `);
        else if (m.t === "error") process.stdout.write(`\n⚠️  ${m.e}\n> `);
        // m.t === "typing"/"ready" → sin ruido en consola
      }
    });
    conn.on("close", () => {
      console.log("\n(gateway cerró la conexión)");
      resolve();
    });
    conn.on("error", (e) => {
      console.error(`socket: ${e.message}`);
      resolve();
    });

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.setPrompt("> ");
    rl.prompt();
    rl.on("line", (l) => {
      const text = l.trim();
      if (text) conn.write(`${JSON.stringify({ t: "msg", text })}\n`);
    });
    rl.on("close", () => {
      conn.end();
      resolve();
    });
  });
}

/** Pregunta sí/no por stdin. Sólo `si`/`sí`/`s`/`y`/`yes` (case-insensitive) confirma. */
function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(isYes(answer));
    });
  });
}

// Envía un anuncio a todos los usuarios vía el control socket (el gateway tiene el bot
// token y hace el envío real). Se queda conectado imprimiendo el progreso hasta `done`.
async function runBroadcast(text: string): Promise<void> {
  const sockPath = gatewaySockPath();
  if (!existsSync(sockPath)) {
    die(`no encuentro el socket del gateway (${sockPath}). ¿Está corriendo ceibo-gateway?`);
  }
  await new Promise<void>((resolve, reject) => {
    const conn = createConnection(sockPath);
    let buf = "";
    conn.on("connect", () => conn.write(`${JSON.stringify({ t: "broadcast", text })}\n`));
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line.trim()) continue;
        let m: { t?: string; text?: string; e?: string };
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.t === "out") console.log(m.text);
        else if (m.t === "error") console.error(`⚠️  ${m.e}`);
        else if (m.t === "done") {
          conn.end();
          resolve();
        }
      }
    });
    conn.on("error", (e) => reject(new Error(`socket: ${e.message}`)));
    conn.on("close", () => resolve());
  });
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      name: { type: "string" },
      key: { type: "string" },
      label: { type: "string" },
      from: { type: "string" },
      handle: { type: "string" },
      note: { type: "string" },
      daily: { type: "boolean" },
      models: { type: "boolean" },
      days: { type: "string" },
      status: { type: "string" }, // waitlist list --status pending|approved|rejected
      off: { type: "boolean" }, // user admin --off
      all: { type: "boolean" }, // repo migrate-archive --all (todas las wikis)
      apply: { type: "boolean" }, // repo migrate-archive --apply (commitea; sin esto, dry-run)
      help: { type: "boolean", short: "h" },
    },
  });

  const [group, sub, ...rest] = positionals;
  if (!group || group === "help" || values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const db = openDb(defaultDbPath());

  // `usage`/`chat` toman un handle posicional (no un subcomando); el resto son group+sub.
  const cmd = group === "usage" || group === "chat" ? group : `${group} ${sub ?? ""}`.trim();
  switch (cmd) {
    case "user add": {
      const handle = rest[0];
      if (!handle) die('uso: user add <handle> --name "Nombre" [--key <anthropic_key>]');
      if (!isValidHandle(handle)) die(`handle inválido "${handle}" (usá minúsculas, dígitos, - o _)`);
      // El nombre de pila es OBLIGATORIO: el agente se dirige a la persona por su nombre y
      // aparece en el saludo de la web. Distinto del handle (slug técnico).
      const name = values.name?.trim();
      if (!name) {
        die('falta el nombre de pila: user add <handle> --name "Nombre" (ej: user add ale --name "Alicia")');
      }
      if (getUserByHandle(db, handle)) die(`ya existe el usuario "${handle}"`);
      const u = addUser(db, handle, { name, anthropicApiKey: values.key });
      console.log(`✓ usuario ${label(u)} [${u.status}]`);
      // Invariante: todo usuario arranca con su wiki personal (one-time en el alta, no lazy).
      // Best-effort: avisa si falla (GitHub caído) pero NO aborta el alta — el usuario quedó
      // creado. Recovery: ceibo repo create <handle> personal.
      try {
        const wk = wikisFromEnv();
        const wikiName = userRepoName(handle, "personal");
        const org = wk.org;
        let repo = getRepoByName(db, org, wikiName);
        if (!repo) {
          try {
            await wk.createRepo(wikiName);
          } catch (e) {
            // 422 = el repo ya existe en GitHub (alta a medias) → seguimos a registrarlo.
            if (!/422|already exists/i.test((e as Error)?.message ?? "")) throw e;
          }
          // Nota de bienvenida (best-effort, idempotente: sólo actúa si el README está pelado).
          await seedWelcomeNote(wk, wikiName, (s) => console.error(s));
          repo = getRepoByName(db, org, wikiName) ?? addRepo(db, org, wikiName, "personal");
        }
        grantAccess(db, repo.id, u.id);
        console.log(`✓ wiki personal ${org}/${wikiName} lista para ${handle}`);
      } catch (e) {
        const errMsg = (e as Error)?.message ?? String(e);
        // Si faltan las vars de wikis en el entorno, no es un error — el despliegue no tiene wikis.
        if (/GITHUB_APP_ID|GITHUB_WIKIS_ORG|GITHUB_APP_PRIVATE_KEY/i.test(errMsg)) {
          console.log(`(wikis no configuradas — saltando provisión de wiki personal)`);
        } else {
          console.error(
            `⚠ wiki personal NO creada para ${handle}: ${errMsg} — recreá con: ceibo repo create ${handle} personal`,
          );
        }
      }
      break;
    }
    case "user list": {
      const users = listUsers(db);
      if (users.length === 0) {
        console.log("(sin usuarios)");
        break;
      }
      for (const u of users) {
        const chs = listChannels(db, u.id)
          .map((c) => `${c.channel}:${c.external_id}`)
          .join(", ");
        const key = u.anthropic_api_key ? " [key propia]" : "";
        // `ma` es el default → sólo se muestra el backend cuando es `local` (lo no-obvio).
        const backend = u.backend_mode === "local" ? " [backend:local]" : "";
        console.log(`${label(u)}  [${u.status}]${key}${backend}  ${chs || "(sin canales)"}`);
      }
      break;
    }
    case "user rename": {
      const u = reqUser(db, rest[0]);
      const next = rest[1];
      if (!next) die("uso: user rename <handle> <nuevo-handle>");
      if (!isValidHandle(next)) die(`handle inválido "${next}" (usá minúsculas, dígitos, - o _)`);
      if (getUserByHandle(db, next)) die(`ya existe el usuario "${next}"`);
      renameUser(db, u.id, next);
      console.log(`✓ ${u.handle} → ${next}`);
      break;
    }
    case "user set-name": {
      const u = reqUser(db, rest[0]);
      const name = rest[1];
      if (!name) die('uso: user set-name <handle> <nombre>  (ej: user set-name demo "Alicia")');
      setUserName(db, u.id, name);
      console.log(`✓ ${u.handle} → nombre "${name}"`);
      break;
    }
    case "user enable":
    case "user disable": {
      const u = reqUser(db, rest[0]);
      const status = sub === "enable" ? "active" : "disabled";
      setUserStatus(db, u.id, status);
      console.log(`✓ usuario ${u.handle} → ${status}`);
      break;
    }
    case "user set-default-profile": {
      const u = reqUser(db, rest[0]);
      const raw = rest[1];
      if (raw === undefined) {
        die('uso: user set-default-profile <handle> <perfil|"">  (vacío para borrar)');
      }
      if (raw === "" || raw === "none" || raw === "clear") {
        setDefaultProfile(db, u.id, null);
        console.log(`✓ ${u.handle} → sin perfil default`);
        break;
      }
      const profile = sanitizeProfile(raw);
      if (profile === DEFAULT_PROFILE) die(`"${raw}" no sirve como perfil default (reservado).`);
      const grants = listGrantsForUser(db, u.id);
      const exists = grants.some((g) => g.profile === profile);
      if (!exists) {
        const available = [...new Set(grants.map((g) => g.profile))].filter((p) => p !== DEFAULT_PROFILE);
        die(
          available.length
            ? `"${profile}" no figura entre los perfiles de ${u.handle} (${available.join(", ")}).`
            : `${u.handle} no tiene perfiles conectados.`,
        );
      }
      setDefaultProfile(db, u.id, profile);
      console.log(`✓ ${u.handle} → perfil default "${profile}"`);
      break;
    }
    case "user set-backend": {
      // Flipea el backend de sesión del usuario (archima): 'ma' = Managed Agents (default),
      // 'local' = infra propia. NO migra estado (vive externalizado): elige a qué infra le
      // habla el gateway en el próximo turno.
      const u = reqUser(db, rest[0]);
      const mode = rest[1];
      if (mode !== "ma" && mode !== "local") {
        die("uso: user set-backend <handle> <ma|local>  (ma = Managed Agents, local = infra propia)");
      }
      setUserBackendMode(db, u.id, mode); // mode quedó angostado a BackendMode ('ma' | 'local')
      // Reseteamos el snapshot de sesión: el `session_id` guardado es del backend viejo (ej. un id
      // de MA) y NO debe reusarse en el nuevo (el backend local lo trataría como nombre de VM →
      // clonaría una VM basura). El próximo turno crea sesión limpia en la infra correcta.
      const reset = clearUserSession(db, u.id);
      console.log(`✓ ${u.handle} → backend "${mode}"${reset ? " (sesión reseteada)" : ""}`);
      break;
    }
    case "user passwd": {
      // Setea la contraseña de login web (email + password). La password se lee por STDIN
      // (no por argv: no queda en el history del shell ni en `ps`). Patrón:
      //   printf '%s' 'la-contraseña' | ceibo user passwd <handle>
      const u = reqUser(db, rest[0]);
      if (process.stdin.isTTY) {
        die(
          "la contraseña se pasa por stdin, no en el comando:\n" +
            `  printf '%s' 'la-contraseña' | ceibo user passwd ${u.handle}`,
        );
      }
      let data = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) data += chunk;
      const password = data.replace(/\r?\n$/, ""); // tolera el newline final de printf/echo
      if (!password) die("contraseña vacía (nada en stdin)");
      const existed = hasUserPassword(db, u.id);
      setUserPassword(db, u.id, password);
      console.log(`✓ contraseña ${existed ? "reemplazada" : "seteada"} para ${u.handle}`);
      if (!listChannels(db, u.id).some((c) => c.channel === "email")) {
        console.log(
          `  ⚠️  todavía sin identidad email — agregala:  ceibo channel add ${u.handle} email <email>`,
        );
      }
      break;
    }
    case "user admin": {
      // Setea o quita el flag admin. El admin puede revisar y aprobar la waitlist (P2–P5).
      //   ceibo user admin <handle>       → setea admin=1
      //   ceibo user admin <handle> --off → setea admin=0
      const u = reqUser(db, rest[0]);
      const on = !values.off;
      setAdmin(db, u.id, on);
      console.log(`✓ ${u.handle} ${on ? "es admin ahora" : "ya no es admin"}`);
      break;
    }
    case "channel add": {
      const u = reqUser(db, rest[0]);
      const channel = rest[1];
      // `google`/`email`: el external_id es un email → normalizamos a lowercase para que
      // matchee el login (el callback de Google y la ruta /api/login/password también lowercasean).
      const ext = channel === "google" || channel === "email" ? rest[2]?.toLowerCase() : rest[2];
      if (!channel || !ext) die("uso: channel add <handle> <canal> <external_id>");
      if (!KNOWN_CHANNELS.includes(channel)) {
        die(`canal desconocido "${channel}" (disponibles: ${KNOWN_CHANNELS.join(", ")})`);
      }
      const ch = addChannel(db, u.id, channel, ext);
      console.log(`✓ ${ch.channel}:${ch.external_id} → ${u.handle}`);
      break;
    }
    case "channel list": {
      const u = rest[0] ? reqUser(db, rest[0]) : undefined;
      const chs = listChannels(db, u?.id);
      if (chs.length === 0) {
        console.log("(sin canales)");
        break;
      }
      const byId = new Map(listUsers(db).map((x) => [x.id, x.handle]));
      for (const c of chs)
        console.log(`${byId.get(c.user_id) ?? `?${c.user_id}`}  ${c.channel}:${c.external_id}`);
      break;
    }
    case "channel remove": {
      const u = reqUser(db, rest[0]);
      const channel = rest[1];
      const ext = rest[2];
      if (!channel) die("uso: channel remove <handle> <canal> [external_id]");
      const removed = removeChannel(db, u.id, channel, ext);
      if (removed.length === 0) {
        die(`${u.handle} no tiene canal ${channel}${ext ? `:${ext}` : ""}`);
      }
      for (const c of removed) console.log(`✓ quitado ${c.channel}:${c.external_id} de ${u.handle}`);
      break;
    }
    case "allow add": {
      // Allowlist de registración: autoriza un email a auto-crear cuenta al entrar con Google.
      // El alta efectiva (user + identidad google + wiki personal) ocurre en el primer login.
      const email = rest[0]?.trim().toLowerCase();
      if (!email || !email.includes("@")) {
        die('uso: allow add <email> [--name "Nombre"] [--handle <handle>] [--note "..."]');
      }
      const handleOpt = values.handle?.trim();
      if (handleOpt && !isValidHandle(handleOpt)) {
        die(`handle inválido "${handleOpt}" (usá minúsculas, dígitos, - o _)`);
      }
      const entry = addAuthorizedEmail(db, email, {
        name: values.name?.trim(),
        handle: handleOpt,
        note: values.note?.trim(),
      });
      console.log(`✓ autorizado ${entry.email}${entry.handle ? ` (handle ${entry.handle})` : ""}`);
      break;
    }
    case "allow list": {
      const entries = listAuthorizedEmails(db);
      if (entries.length === 0) {
        console.log("(allowlist vacía)");
        break;
      }
      for (const e of entries) console.log(formatAllowEntry(e));
      break;
    }
    case "allow remove": {
      const email = rest[0]?.trim().toLowerCase();
      if (!email) die("uso: allow remove <email>");
      if (!removeAuthorizedEmail(db, email)) die(`"${email}" no estaba en la allowlist`);
      console.log(`✓ ${email} quitado de la allowlist (la cuenta ya creada, si existe, no se toca)`);
      break;
    }
    case "waitlist list": {
      // Lista la cola de admisión. Por default muestra todos los estados; --status filtra.
      const rawStatus = values.status?.trim();
      const validStatuses: WaitingStatus[] = ["pending", "approved", "rejected"];
      if (rawStatus && !validStatuses.includes(rawStatus as WaitingStatus)) {
        die(`--status inválido "${rawStatus}" (válidos: ${validStatuses.join(", ")})`);
      }
      const rows = listWaitingList(db, rawStatus ? { status: rawStatus as WaitingStatus } : undefined);
      if (rows.length === 0) {
        console.log(rawStatus ? `(sin entradas con status "${rawStatus}")` : "(lista de espera vacía)");
        break;
      }
      for (const r of rows) {
        const sourceLabel =
          r.source === "invited" ? `invitado por @${r.inviter_handle ?? "?"}` : "self-signup";
        const wikis =
          r.pending_wikis.length > 0
            ? r.pending_wikis.map((w) => w.name).join(", ")
            : "(sin wikis pendientes)";
        const date = r.created_at.slice(0, 10);
        const reviewedAt = r.reviewed_at ? `  revisado ${r.reviewed_at.slice(0, 10)}` : "";
        console.log(`[${r.status}] ${r.email}  ${sourceLabel}  wikis: ${wikis}  ${date}${reviewedAt}`);
      }
      break;
    }
    case "waitlist approve": {
      // Aprueba un email de la waitlist: INSERT en authorized_emails (tx) + mail de aprobación.
      const emailRaw = rest[0]?.trim().toLowerCase();
      if (!emailRaw) die("uso: waitlist approve <email> [--name 'Nombre'] [--handle <h>]");
      // Buscamos el admin sys: usamos el primer admin de la DB (o id=0 como sentinel en tests)
      const adminUser = listUsers(db).find((u) => u.status === "active") ?? { id: 0 };
      const entry = approveWaitingEmail(db, emailRaw, adminUser.id, {
        name: values.name?.trim(),
        handle: values.handle?.trim(),
      });
      console.log(`✓ ${entry.email} aprobado — agregado a authorized_emails`);
      // Mandar mail de aprobación (best-effort: si falta RESEND_API_KEY, sólo logueamos)
      const apiKey = process.env.RESEND_API_KEY;
      if (apiKey) {
        const { Resend } = await import("resend");
        const resend = new Resend(apiKey);
        const from = process.env.MAIL_FROM ?? "Ceibo <hello@example.com>";
        const loginUrl = "https://ceibo.example.com";
        const html = `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1917;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px;border:1px solid #e7e5e4;">
      <h1 style="margin:0 0 16px;font-size:22px;font-weight:600;">Tu acceso a Ceibo está listo</h1>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.5;color:#44403c;">Ya podés entrar con Google o pediendo tu link de acceso.</p>
      <p style="margin:0 0 24px;"><a href="${loginUrl}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:999px;font-size:15px;font-weight:600;">Entrar a Ceibo</a></p>
      <p style="margin:0;font-size:13px;color:#a8a29e;">Si no esperabas este mensaje, ignoralo.</p>
    </div>
  </body>
</html>`;
        const text = `Tu acceso a Ceibo está listo\n\nYa podés entrar:\n${loginUrl}`;
        const { error } = await resend.emails.send({
          from,
          to: entry.email,
          subject: "Tu acceso a Ceibo está listo",
          html,
          text,
        });
        if (error) {
          console.error(
            `⚠️  mail no enviado: ${typeof error === "string" ? error : (error.message ?? "resend error")}`,
          );
        } else {
          console.log(`✓ mail de aprobación enviado a ${entry.email}`);
        }
      } else {
        console.log(`  (RESEND_API_KEY no configurado — mail de aprobación no enviado)`);
      }
      break;
    }
    case "waitlist reject": {
      const emailRaw = rest[0]?.trim().toLowerCase();
      if (!emailRaw) die("uso: waitlist reject <email>");
      const adminUser = listUsers(db).find((u) => u.status === "active") ?? { id: 0 };
      rejectWaitingEmail(db, emailRaw, adminUser.id);
      console.log(`✓ ${emailRaw} rechazado (sin mail; puede re-pendearse por CLI si cambia de opinión)`);
      break;
    }
    case "repo create": {
      // Convención (Fase 16): la wiki de un usuario se llama `<handle>-<label>`. Crea en
      // GitHub con ese nombre, la registra con el label y le da acceso al dueño.
      const handle = rest[0];
      const labelArg = rest[1];
      if (!handle || !labelArg)
        die('uso: repo create <handle> <label>  (ej: repo create demo personal → repo "demo-personal")');
      const u = reqUser(db, handle);
      try {
        assertValidLabel(labelArg);
      } catch (e) {
        die((e as Error).message);
      }
      const name = userRepoName(u.handle, labelArg);
      const wikis = wikisFromEnv();
      const org = wikis.org;
      if (getRepoByName(db, org, name)) die(`ya existe el repo ${org}/${name}`);
      const created = await wikis.createRepo(name); // crea en GitHub
      await seedWelcomeNote(wikis, name, (s) => console.error(s)); // nota Bienvenida.md (best-effort)
      const r = addRepo(db, org, name, labelArg); // registra en el store con label
      grantAccess(db, r.id, u.id); // el dueño accede (y queda firstUserForRepo)
      console.log(
        `✓ repo ${repoFullName(r)} creado para ${u.handle} (label "${labelArg}") — ${created.htmlUrl}`,
      );
      break;
    }
    case "repo rename": {
      // Renombra en GitHub (deja redirect) y actualiza el store (nombre + label + active_wiki).
      const org = reqOrg();
      const oldName = rest[0];
      const newName = rest[1];
      const labelArg = values.label;
      if (!oldName || !newName || !labelArg) {
        die("uso: repo rename <nombre-viejo> <nombre-nuevo> --label <label>");
      }
      try {
        assertValidLabel(labelArg);
      } catch (e) {
        die((e as Error).message);
      }
      const r = getRepoByName(db, org, oldName);
      if (!r) die(`no existe el repo ${org}/${oldName} en el store`);
      if (getRepoByName(db, org, newName)) die(`ya existe ${org}/${newName} en el store`);
      const wikis = wikisFromEnv();
      const renamed = await wikis.renameRepo(oldName, newName); // GitHub primero
      renameRepoInStore(db, r.id, oldName, newName, labelArg); // después el store (atómico)
      console.log(`✓ ${org}/${oldName} → ${renamed.fullName} (label "${labelArg}")`);
      break;
    }
    case "repo label": {
      const org = reqOrg();
      const name = rest[0];
      const labelArg = rest[1];
      if (!name || !labelArg) die("uso: repo label <name> <label>  (o: repo label <name> -- para limpiar)");
      const r = getRepoByName(db, org, name);
      if (!r) die(`no existe el repo ${org}/${name}`);
      if (labelArg === "--") {
        setRepoLabel(db, r.id, null);
        console.log(`✓ label de ${repoFullName(r)} limpiado`);
      } else {
        try {
          assertValidLabel(labelArg);
        } catch (e) {
          die((e as Error).message);
        }
        setRepoLabel(db, r.id, labelArg);
        console.log(`✓ ${repoFullName(r)} → label "${labelArg}"`);
      }
      break;
    }
    case "repo set-personal": {
      // Marca una wiki como la PERSONAL de su dueño (personal=1 → no borrable/no archivable).
      // Para usuarios renombrados, cuya wiki personal quedó con el nombre viejo y la migración F1
      // (que busca `<handle>-personal`) no detecta → el warning "revisar manualmente". Idempotente.
      const org = reqOrg();
      const name = rest[0];
      if (!name) die("uso: repo set-personal <name>  (marca la wiki como personal del dueño)");
      const r = getRepoByName(db, org, name);
      if (!r) die(`no existe el repo ${org}/${name}`);
      setRepoPersonal(db, r.id);
      console.log(`✓ ${repoFullName(r)} marcada como wiki personal (personal=1, no borrable/archivable)`);
      break;
    }
    case "repo backfill-labels": {
      // Migración one-shot para usuarios YA renombrados (el handle viejo quedó horneado en el
      // nombre de la wiki: `demo-personal` con dueño `demo-gpuhost`). Congela el label derivado del
      // handle VIEJO (--from) en repos.label, así el display deja de depender del prefijo viejo.
      // Idempotente y conservador: sólo toca wikis del usuario sin label explícito. No toca GitHub.
      const u = reqUser(db, rest[0]);
      const from = values.from?.trim();
      if (!from) die("uso: repo backfill-labels <handle> --from <handle-viejo>");
      const n = backfillOwnedWikiLabels(db, u.id, from);
      console.log(`✓ ${n} wiki(s) de ${u.handle} con label congelado desde el handle "${from}"`);
      break;
    }
    case "repo migrate-archive": {
      // Migración one-shot de data: renombra los manifests de archivado `_archivado.md` (legacy)
      // a `.archived.md` (convención dotfile nueva) en las wikis. Idempotente (re-correr no hace
      // nada). Dry-run por default; `--apply` commitea. `--all` = todas las wikis del store; si no,
      // `repo migrate-archive <name>`. Mergea si la carpeta ya tiene un `.archived.md` (concatena
      // las entradas del legacy). El código ya LEE ambos nombres, así que correr esto NO es urgente:
      // consolida la data. Ojo: si staging y prod comparten repos, esto afecta a ambos entornos.
      const apply = values.apply === true;
      const wikis = wikisFromEnv();
      const org = wikis.org;
      let names: string[];
      if (values.all) {
        names = listAllRepos(db).map((r) => r.name);
      } else if (rest[0]) {
        const r = getRepoByName(db, org, rest[0]);
        if (!r) die(`no existe el repo ${org}/${rest[0]} en el store`);
        names = [rest[0]];
      } else {
        die("uso: repo migrate-archive <name> [--apply]   |   repo migrate-archive --all [--apply]");
      }
      const baseOf = (p: string) => p.split("/").pop() ?? p;
      const dirOf = (p: string) => {
        const s = p.lastIndexOf("/");
        return s === -1 ? "" : p.slice(0, s);
      };
      const newPathFor = (lp: string) => {
        const d = dirOf(lp);
        return d ? `${d}/${ARCHIVE_MANIFEST}` : ARCHIVE_MANIFEST;
      };
      let totalRepos = 0;
      let totalManifests = 0;
      for (const name of names) {
        let files: string[];
        try {
          files = await wikis.listFiles(name);
        } catch (e) {
          console.error(
            `  ⚠️ ${org}/${name}: no pude listar archivos (${(e as Error)?.message ?? e}) — salteo`,
          );
          continue;
        }
        const legacy = files.filter((f) => baseOf(f) === ARCHIVE_MANIFEST_LEGACY);
        if (legacy.length === 0) continue;
        const existingNew = new Set(files.filter((f) => baseOf(f) === ARCHIVE_MANIFEST));
        const toRead = [...legacy, ...legacy.map(newPathFor).filter((p) => existingNew.has(p))];
        const snap = await wikis.read(name, undefined, toRead);
        const byPath = new Map(snap.files.map((f) => [f.path, f.content]));
        const changes: Change[] = [];
        for (const lp of legacy) {
          const np = newPathFor(lp);
          const legacyContent = byPath.get(lp) ?? "";
          if (existingNew.has(np)) {
            const targetContent = byPath.get(np) ?? "";
            const legacyEntries = legacyContent.split("\n").filter((l) => /^\s*- \[/.test(l));
            const merged = `${targetContent.replace(/\n+$/, "")}\n${legacyEntries.join("\n")}\n`;
            changes.push({ op: "put", path: np, content: merged });
          } else {
            changes.push({ op: "put", path: np, content: legacyContent });
          }
          changes.push({ op: "delete", path: lp });
          console.log(`  ${org}/${name}: ${lp} → ${np}${existingNew.has(np) ? " (merge)" : ""}`);
        }
        totalRepos++;
        totalManifests += legacy.length;
        if (apply) {
          const head = await wikis.headSha(name);
          const r = await wikis.commit(
            name,
            head,
            changes,
            "🗃️ migrar manifests de archivado: _archivado.md → .archived.md",
          );
          if (!r.ok) console.error(`  ⚠️ ${org}/${name}: commit en conflicto (HEAD se movió) — reintentá`);
        }
      }
      const verb = apply ? "migrados" : "a migrar (dry-run, sin --apply)";
      console.log(`\n${totalManifests} manifest(s) ${verb} en ${totalRepos} wiki(s).`);
      if (!apply && totalManifests > 0) console.log("Re-corré con --apply para commitear.");
      break;
    }
    case "repo import": {
      const name = rest[0];
      if (!name) die("uso: repo import <name>");
      const wikis = wikisFromEnv();
      const org = wikis.org;
      if (getRepoByName(db, org, name)) die(`ya está registrado ${org}/${name}`);
      const exists = (await wikis.listRepos()).includes(`${org}/${name}`);
      if (!exists) die(`no existe ${org}/${name} en GitHub (crealo con: repo create)`);
      const r = addRepo(db, org, name);
      console.log(`✓ repo ${repoFullName(r)} importado al store`);
      break;
    }
    case "repo rm": {
      const org = reqOrg();
      const name = rest[0];
      if (!name) die("uso: repo rm <name>");
      const r = getRepoByName(db, org, name);
      if (!r) die(`no existe el repo ${org}/${name} en el store`);
      removeRepo(db, r.id);
      console.log(`✓ ${repoFullName(r)} quitado del store (sigue en GitHub)`);
      break;
    }
    case "repo grant":
    case "repo revoke": {
      const org = reqOrg();
      const name = rest[0];
      const handle = rest[1];
      if (!name || !handle) die(`uso: repo ${sub} <name> <handle>`);
      const r = getRepoByName(db, org, name);
      if (!r) die(`no existe el repo ${org}/${name}`);
      const u = reqUser(db, handle);
      if (sub === "grant") {
        grantAccess(db, r.id, u.id);
        console.log(`✓ ${u.handle} ahora accede a ${repoFullName(r)}`);
      } else {
        revokeAccess(db, r.id, u.id);
        console.log(`✓ ${u.handle} ya no accede a ${repoFullName(r)}`);
      }
      break;
    }
    case "repo list": {
      const list: Repo[] = rest[0] ? listReposForUser(db, reqUser(db, rest[0]).id) : listAllRepos(db);
      if (list.length === 0) {
        console.log("(sin repos)");
        break;
      }
      for (const r of list) {
        const access = usersForRepo(db, r.id).map((x) => x.handle);
        const owner = firstUserForRepo(db, r.id)?.handle ?? r.name;
        const shown = wikiLabel(r, owner);
        const tag = r.label ? `[${shown}]` : `[${shown}*]`; // * = derivado (sin label explícito)
        console.log(`${repoFullName(r)}  ${tag}  →  ${access.join(", ") || "(sin acceso)"}`);
      }
      break;
    }
    case "oauth enroll": {
      const u = reqUser(db, rest[0]);
      const service = rest[1];
      if (!service)
        die(`uso: oauth enroll <handle> <service> [perfil] (disponibles: ${SERVICE_NAMES.join(", ")})`);
      if (!knownService(service)) {
        die(`servicio desconocido "${service}" (disponibles: ${SERVICE_NAMES.join(", ")})`);
      }
      const profile = rest[2] ? sanitizeProfile(rest[2]) : DEFAULT_PROFILE;
      const base = reqOauthBase();
      const token = createEnrollToken(db, u.id, service, profile);
      const label2 = profile === DEFAULT_PROFILE ? service : `${service} (perfil "${profile}")`;
      console.log(`Link de enrollment para ${label(u)} (${label2}) — vence en 30 min, un solo uso:`);
      console.log(`\n  ${base}/oauth/start?t=${token}\n`);
      console.log("Mandáselo a la persona; al aprobarlo queda conectado.");
      break;
    }
    case "cron list": {
      const u = rest[0] ? reqUser(db, rest[0]) : undefined;
      const list = listCrons(db, u?.id);
      if (list.length === 0) {
        console.log("(sin crons)");
        break;
      }
      const byId = new Map(listUsers(db).map((x) => [x.id, x.handle]));
      for (const c of list) {
        const sched = c.kind === "recur" ? `recur "${c.recur_expr}" (${c.tz})` : "once";
        const what = c.what.length > 70 ? `${c.what.slice(0, 70)}…` : c.what;
        console.log(
          `#${c.id} [${c.status}] ${byId.get(c.user_id) ?? `?${c.user_id}`}  ${sched}  ` +
            `→ ${c.next_fire}  report:${c.report}\n   ${what}`,
        );
      }
      break;
    }
    case "cron cancel": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) die("uso: cron cancel <id>");
      console.log(adminCancelCron(db, id) ? `✓ cron #${id} cancelado` : `no hay un cron activo #${id}`);
      break;
    }
    case "cron prune": {
      const n = pruneCrons(db);
      console.log(`✓ borrados ${n} cron(s) terminados (done/cancelled)`);
      break;
    }
    case "chat": {
      await runChat(db, sub);
      break;
    }
    case "broadcast send": {
      const text = rest.join(" ").trim();
      if (!text) die('uso: broadcast send <texto>  (ej: broadcast send "Mantenimiento mañana 02:00 BA")');
      // Destinatarios = usuarios activos con identidad de Telegram.
      const tgUsers = listUsers(db).filter(
        (u) => u.status === "active" && listChannels(db, u.id).some((c) => c.channel === "telegram"),
      );
      if (tgUsers.length === 0) die("no hay usuarios activos con canal telegram a quienes enviar.");
      console.log(`\nAnuncio a ${tgUsers.length} usuario(s) por Telegram:\n`);
      console.log(`  ${text.replace(/\n/g, "\n  ")}\n`);
      const ok = await confirm(`Enviar a ${tgUsers.length} usuario(s)? escribí "si": `);
      if (!ok) {
        console.log("cancelado.");
        break;
      }
      await runBroadcast(text);
      break;
    }
    case "broadcast list": {
      const rows = listBroadcasts(db);
      if (rows.length === 0) {
        console.log("(sin anuncios enviados)");
        break;
      }
      for (const b of rows) console.log(broadcastLine(b));
      break;
    }
    case "usage": {
      // `usage` o `usage <handle>` — el handle viene como `sub` posicional.
      const u = sub ? reqUser(db, sub) : undefined;

      if (values.daily) {
        const days = values.days ? Math.max(1, Number(values.days) || 0) : undefined;
        const rows = spendDaily(db, { userId: u?.id, days });
        console.log(renderDaily(rows, u !== undefined));
        break;
      }

      if (values.models) {
        const days = values.days ? Math.max(1, Number(values.days) || 0) : undefined;
        console.log(renderModelUsage(modelUsageReport(db, { userId: u?.id, days }), days));
        break;
      }

      const rows = spendReport(db, u?.id);
      console.log(renderSpendReport(rows, MARKUP) || "(sin usuarios)");
      break;
    }
    default:
      process.stdout.write(USAGE);
      die(`comando desconocido: ${group} ${sub ?? ""}`);
  }

  db.close();
}

main().catch((e) => {
  console.error(e?.message ?? String(e));
  process.exit(1);
});
