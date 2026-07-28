// MCP `control` — el agente corre los comandos de usuario (`/model`, `/new`, …) por chat o voz,
// en vez de que el usuario los tipee, y gestiona las CONEXIONES de cuentas con tools semánticas.
//
// Vive en el gateway (NO en el launcher de @ceibo/mcps) porque ejecuta `runCommandForUser`,
// que necesita el estado in-process por usuario (ctxByUser: la sesión MA viva, el relay).
// Reusa el transporte MCP de @ceibo/mcps (handleMcpPost) y se monta como ruta
// /mcp/control/<secret> en un listener HTTP propio del gateway (ver index.ts). El Bearer que
// inyecta el vault es un token de identidad firmado (`<userId>.<hmac>`, HMAC con
// CONTROL_MCP_HMAC_KEY) → de ahí sale el userId; el comando se corre para ESE usuario.
// C1 (resuelto): CONTROL_MCP_HMAC_KEY es la clave HMAC dedicada; CONTROL_MCP_SECRET sigue
// siendo el path-secret de la URL (/mcp/control/<secret>) y NO se expone como clave HMAC.
//
// Dos clases de tools:
//   • `ceibo_command` — util TÉCNICA: recibe la línea cruda (ej. "/model opus") y reusa el
//     MISMO dispatch que el canal (runCommand), así cubre todos los comandos de settings
//     actuales y futuros sin un wrapper por comando.
//   • `connect_service` / `list_connections` / `disconnect_service` / `connect_whatsapp` —
//     tools SEMÁNTICAS de conexión. Son la interfaz de primera clase que ve el modelo (un
//     modelo chico invoca mejor una tool dedicada que embeber `/connect …` en un comando-string).
//     Por debajo llaman al MISMO flujo OAuth/pairing que `/connect` (vía runCommandForUser) pero
//     devuelven DATOS ESTRUCTURADOS (auth_url, lista) en vez de texto-de-comando. Así el string
//     `/connect` NUNCA aparece en la conversación con el usuario.
//
// OJO (auto-disrupción): /new, /model y /wiki set recrean la sesión MA del usuario — la misma
// donde el agente corre esta tool. El turno que la invocó queda huérfano (su respuesta se
// pierde); runCommandForUser postea la confirmación al chat out-of-band para que el usuario la
// vea igual. Es la semántica esperada de esos comandos (descartar contexto).

import type { McpServer, Tool, ToolArgs } from "@ceibo/mcps/src/core/transport.ts";
import { verifyUserToken } from "@ceibo/store";

const TOOLS: Tool[] = [
  {
    name: "ceibo_command",
    description:
      "Corré un comando de ajustes de ceibo EN NOMBRE del usuario (lo mismo que si lo tipeara), " +
      "cuando te lo pide por chat o voz. Pasá la línea cruda en `command` (con o sin la barra " +
      "inicial). Devuelve el resultado del comando como texto: parafraseálo natural al usuario. " +
      "Para CONECTAR/DESCONECTAR cuentas NO uses esta tool: usá `connect_service`, " +
      "`list_connections`, `disconnect_service` y `connect_whatsapp`. Comandos disponibles acá:\n" +
      "• /new — sesión nueva (DESCARTA el contexto actual de esta conversación).\n" +
      "• /model list | <id> — ver/cambiar el modelo (haiku/sonnet/opus). Cambiarlo DESCARTA el contexto.\n" +
      "• /voice list | <id> | rate|pitch|volume <val> | reset — voz y prosodia del TTS.\n" +
      "• /language list | <id> — idioma (es/en).\n" +
      "• /wiki list | set <nombre|all> | label <wiki> <alias> — wikis. `set` recrea la sesión.\n" +
      "• /rem <wiki> | all — consolidar (REM) una wiki o todas.\n" +
      "• /profile default [<nombre>|none] — ver/fijar el perfil de cuenta por default.\n" +
      "• /stop — interrumpir el turno en curso.\n" +
      "• /session — id de la sesión actual.\n" +
      "• /web — link para entrar a la UI web.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: 'La línea del comando, ej. "/model opus" o "voice list".',
        },
      },
      required: ["command"],
    },
  },
  {
    name: "subagent_spawn",
    description:
      "Despachá un SUB-AGENTE ASÍNCRONO que ejecuta una tarea compleja/larga en paralelo, SIN " +
      "bloquear tu turno. Úsala (en vez de la tool `task` bloqueante) cuando el trabajo no es " +
      "instantáneo: reorganizar/armar notas, análisis grandes, cualquier cosa multi-paso que " +
      "toca varias notas o corre scripts. Devuelve INMEDIATO una confirmación de despacho. Si el " +
      "pedido necesita VARIOS sub-agentes, despachalos TODOS seguidos en este mismo turno (una " +
      "llamada por tarea, sin texto entre medio). Despachado el último, avisale al usuario en UNA " +
      "sola frase natural —cuántos lanzaste y para qué, en tu voz— y cerrá tu turno (quedás libre " +
      "para seguir charlando). Cuando cada sub-agente termine te va a llegar su resultado como un " +
      "turno nuevo (`[resultado del sub-agente …]`): ahí lo verificás e informás. En `goal` redactá " +
      "el ENCARGO COMPLETO y autocontenido (todo el contexto que el sub-agente necesita para " +
      "ejecutar de punta a punta, incluido subir los cambios a la wiki); en `title` una etiqueta " +
      "corta para mostrar. Sólo disponible en archima.",
    inputSchema: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description:
            "El encargo COMPLETO y autocontenido para el sub-agente: qué tiene que lograr, sobre " +
            "qué wiki/notas, y cualquier dato necesario. Redactalo como una orden ejecutable, no como un resumen.",
        },
        title: {
          type: "string",
          description:
            "Etiqueta corta de la tarea para mostrar al usuario, ej. 'reorganizar wiki de viajes'.",
        },
      },
      required: ["goal"],
    },
  },
  {
    name: "subagent_kill",
    description:
      "Cancelá un SUB-AGENTE ASÍNCRONO vivo: uno que quedó trabado, que ya no hace falta, o que " +
      "el usuario te pidió frenar. En `subagent` pasá su id (ej. '2') o su título (o un pedazo " +
      "inequívoco). El sub-agente se aborta y NO te va a llegar ningún resultado suyo. Después " +
      "confirmale al usuario en UNA frase, en tu voz, que lo cancelaste. Si no estás seguro de " +
      "cuál es, la propia tool te lista los vivos cuando no encuentra el que pediste.",
    inputSchema: {
      type: "object",
      properties: {
        subagent: {
          type: "string",
          description: "El id del sub-agente (ej. '2') o su título (o un fragmento único de él).",
        },
      },
      required: ["subagent"],
    },
  },
  {
    name: "connect_service",
    description:
      "Conectá una cuenta OAuth del usuario (gmail, calendar, drive, sheets, notion). Devuelve " +
      "`{ auth_url }`: un link de autorización que SÓLO el usuario puede abrir y aprobar (vos no " +
      "completás el OAuth). Pasale el link al usuario y pedile que lo abra. El perfil es " +
      "OBLIGATORIO: nombra la cuenta (ej. 'personal', 'work'); si el usuario no lo dijo y sólo va " +
      "a tener una cuenta de ese servicio, usá 'personal'. Para WhatsApp NO uses esta tool: usá " +
      "`connect_whatsapp`.",
    inputSchema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "El servicio a conectar: gmail, calendar, drive, sheets o notion.",
        },
        profile: {
          type: "string",
          description: "Nombre de la cuenta/perfil, ej. 'personal' o 'work'. Obligatorio.",
        },
      },
      required: ["service", "profile"],
    },
  },
  {
    name: "list_connections",
    description:
      "Listá qué cuentas tiene conectadas el usuario y qué es conectable. Devuelve el detalle " +
      "como texto para que lo parafrasees natural.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "disconnect_service",
    description:
      "Desconectá una cuenta del usuario (gmail, calendar, drive, sheets, notion o whatsapp). " +
      "Si el servicio tiene varios perfiles y el usuario no aclaró cuál, pasá `profile`; sin " +
      "`profile` se desconecta el perfil por default.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "El servicio a desconectar." },
        profile: { type: "string", description: "Perfil opcional, ej. 'work'." },
      },
      required: ["service"],
    },
  },
  {
    name: "connect_whatsapp",
    description:
      "Conectá WhatsApp del usuario (es solo-lectura: vas a poder leer sus chats y contactos, " +
      "NO enviar mensajes). No es OAuth: genera un código de vinculación que le llega al usuario " +
      "en este chat en unos segundos. Pasá el número CON código de país (ej. +54 9 11 1234-5678). " +
      "Decile además la ruta exacta en WhatsApp para meter el código: Ajustes → Dispositivos " +
      'vinculados → Vincular un dispositivo → "Vincular con número de teléfono".',
    inputSchema: {
      type: "object",
      properties: {
        phone: {
          type: "string",
          description: "Número del usuario con código de país, ej. '+54 9 11 1234-5678'.",
        },
      },
      required: ["phone"],
    },
  },
];

/** Primer URL http(s) que aparezca en un texto (el link de auth que arma `/connect`). */
function extractUrl(text: string): string | undefined {
  return text.match(/https?:\/\/\S+/)?.[0];
}

const asStr = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Server MCP `control`. `runCommandForUser` lo inyecta el gateway (engine) — es quien tiene
 *  el estado por usuario. `hmacKey` es la HMAC key del Bearer firmado (CONTROL_MCP_HMAC_KEY,
 *  C1: desacoplada del path-secret CONTROL_MCP_SECRET que gatea la URL). */
export function makeControlServer(
  hmacKey: string,
  runCommandForUser: (userId: number, command: string) => Promise<string>,
  spawnSubagent?: (userId: number, goal: string, title?: string) => Promise<string>,
  killSubagent?: (userId: number, ref: string) => Promise<string>,
  // Postea fuera de banda al chat real del usuario. `connect_service` lo usa para entregar el
  // auth_url EXACTO directo al chat, sin depender de que el modelo lo transcriba (devuelve true
  // si había un thread vivo).
  postToUser?: (userId: number, text: string) => Promise<boolean>,
): McpServer {
  async function callTool(token: string, name: string, args: ToolArgs): Promise<unknown> {
    const userId = verifyUserToken(token, hmacKey);
    if (userId === undefined) throw new Error("token de control inválido");

    if (name === "subagent_spawn") {
      if (!spawnSubagent) throw new Error("los sub-agentes asíncronos no están habilitados en este gateway");
      const goal = asStr(args.goal);
      if (!goal) throw new Error("falta `goal`");
      const title = asStr(args.title) || undefined;
      // Devuelve un texto de confirmación de despacho (o el motivo si no se pudo, ej. backend MA o
      // límite de workers vivos alcanzado): el agente lo parafrasea al usuario. NO bloquea — el
      // resultado del sub-agente le llega después como un turno sintético (ver engine.ts).
      const message = await spawnSubagent(userId, goal, title);
      return { message };
    }

    if (name === "subagent_kill") {
      if (!killSubagent) throw new Error("los sub-agentes asíncronos no están habilitados en este gateway");
      const ref = asStr(args.subagent);
      if (!ref) throw new Error("falta `subagent`");
      // Devuelve la confirmación de cancelación (o el motivo/lista de vivos si no encontró el
      // worker): el agente se lo confirma al usuario en su voz.
      const message = await killSubagent(userId, ref);
      return { message };
    }

    if (name === "ceibo_command") {
      const command = asStr(args.command);
      if (!command) throw new Error("falta `command`");
      const result = await runCommandForUser(userId, command);
      return { ran: command, result };
    }

    if (name === "connect_service") {
      const service = asStr(args.service);
      const profile = asStr(args.profile);
      if (!service) throw new Error("falta `service`");
      if (!profile) throw new Error("falta `profile`");
      const result = await runCommandForUser(userId, `/connect ${service} ${profile}`);
      const auth_url = extractUrl(result);
      // Sin auth_url → el flujo devolvió un mensaje (servicio desconocido, falta config, etc.).
      // Observabilidad (#484): logueamos service/profile (como los pasó el modelo) + el mensaje, que
      // es la causa exacta del fallback (ej. "No conozco Gmail" por case). El /connect ya normaliza
      // el service a minúscula, así que esto debería dejar de pasar; el log confirma si reaparece.
      if (!auth_url) {
        console.warn(
          `[connect_service] user=${userId} service="${service}" profile="${profile}" SIN URL → ${result}`,
        );
        return { service, profile, auth_url: null, message: result };
      }
      // Con auth_url: lo posteamos NOSOTROS al chat del usuario fuera de banda (no vía el modelo),
      // porque el modelo chico a veces no transcribe el link (escribe `[auth_url]`) o inventa uno.
      // Si el post sale, le decimos al agente que NO repita ni invente la URL (ni se la devolvemos).
      // Sin thread (no se pudo postear) → fallback al viejo comportamiento: el agente la relaya.
      const suffix = profile && profile !== "default" ? ` (${profile})` : "";
      const delivered = postToUser
        ? await postToUser(
            userId,
            `Para conectar tu cuenta de ${service}${suffix}, abrí este link y autorizá el acceso:\n${auth_url}\n\nAvisame cuando esté listo.`,
          ).catch(() => false)
        : false;
      // Observabilidad (#484): si delivered=false, el link se lo relaya el MODELO (gemma a veces lo
      // arruina → placeholder). Sin la URL (es un token de un solo uso) para no leakearla al log.
      console.log(
        `[connect_service] user=${userId} ${service}/${profile} auth_url=${auth_url ? "ok" : "no"} delivered=${delivered}${postToUser ? "" : " (sin postToUser)"}`,
      );
      return delivered
        ? {
            service,
            profile,
            delivered: true,
            instructions:
              "El link de autorización YA se le envió al usuario directo al chat. Confirmáselo en UNA " +
              'frase natural (ej. "te pasé el link, abrilo y avisame cuando autorices") y NO repitas ni ' +
              "inventes ninguna URL.",
          }
        : {
            service,
            profile,
            auth_url,
            instructions:
              "Pasale este link al usuario TAL CUAL para que lo abra y autorice; sólo él puede aprobarlo. " +
              "Copiá la URL exacta, NO la inventes.",
          };
    }

    if (name === "list_connections") {
      const connections = await runCommandForUser(userId, "/connections");
      return { connections };
    }

    if (name === "disconnect_service") {
      const service = asStr(args.service);
      if (!service) throw new Error("falta `service`");
      const profile = asStr(args.profile);
      const result = await runCommandForUser(
        userId,
        profile ? `/disconnect ${service} ${profile}` : `/disconnect ${service}`,
      );
      return { message: result };
    }

    if (name === "connect_whatsapp") {
      const phone = asStr(args.phone);
      if (!phone) throw new Error("falta `phone`");
      const result = await runCommandForUser(userId, `/connect whatsapp ${phone}`);
      // El pairing code llega async al chat del usuario (out-of-band). Devolvemos el mensaje del
      // flujo + la ruta del menú para que el agente la dicte mientras el código viaja.
      return {
        message: result,
        pairing_steps:
          "En WhatsApp: Ajustes → Dispositivos vinculados → Vincular un dispositivo → " +
          '"Vincular con número de teléfono", e ingresá el código que te llega acá en unos segundos.',
        note: "WhatsApp es solo-lectura (v1): podés leer chats y contactos, no enviar mensajes.",
      };
    }

    throw new Error(`tool desconocida: ${name}`);
  }
  return { name: "control", tools: TOOLS, callTool };
}
