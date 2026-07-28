// MCP server `schedule` (Fase 8, lado SET) — el agente agenda recordatorios/crons.
//
// A diferencia de gmail/notion/etc., este server NO llama a una API externa: escribe
// a NUESTRA DB (la misma del gateway, vía @ceibo/store) en la box. El Bearer que
// inyecta el vault NO es un token de un tercero sino un token de identidad firmado por
// el gateway (`<userId>.<expMs>.<hmac>`, HMAC con SCHEDULE_MCP_HMAC_KEY) → de ahí sale el
// userId. El path-secret del launcher (SCHEDULE_MCP_PATH_SECRET) gatea el acceso; el Bearer
// identifica al usuario. C1: la clave HMAC está desacoplada del path-secret (no se filtra en logs).
//
// El lado FIRE (al vencer: inyectar el `what` como prompt sintético en la sesión del
// usuario y empujar el output a su canal) vive en el gateway, no acá.
//
// Tools: schedule_create, schedule_list, schedule_cancel.

import {
  type CronReport,
  cancelCron,
  createCron,
  type Db,
  defaultDbPath,
  isValidCron,
  listCronsForUser,
  nextFireFrom,
  openDb,
  verifyScheduleToken,
} from "@ceibo/store";
import type { McpServer, Tool, ToolArgs } from "../core/transport.ts";

// tz por default para la recurrencia (los disparos one-shot llevan su offset en el ISO).
// v1: todos los usuarios son de Argentina; el agente puede pasar otra IANA tz.
const DEFAULT_TZ = process.env.DEFAULT_TZ ?? "America/Argentina/Buenos_Aires";

// DB compartida con el gateway (mismo archivo; SQLite WAL tolera multi-proceso). Lazy.
let _db: Db | undefined;
function db(): Db {
  if (!_db) _db = openDb(defaultDbPath());
  return _db;
}

/** Saca el userId + canal de origen del Bearer firmado, o throw. La key HMAC es
 *  SCHEDULE_MCP_HMAC_KEY (C1). El `channel` (feature crons-delivery) es el canal de la sesión
 *  donde se mintea el token → el cron se entrega ahí. `undefined` con tokens viejos de 3 partes. */
function identityFromToken(token: string): { userId: number; channel?: string } {
  const key = process.env.SCHEDULE_MCP_HMAC_KEY ?? "";
  const id = key ? verifyScheduleToken(token, key) : undefined;
  if (id === undefined) throw new Error("token de schedule inválido");
  return id;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const TOOLS: Tool[] = [
  {
    name: "schedule_create",
    description:
      "Agenda un recordatorio o tarea programada. Al vencer, el texto `what` se te " +
      "reinyecta como prompt y actuás sobre él (es una nota a tu yo futuro: redactala " +
      "en imperativo, ej. 'recordale a Alicia el dentista' o 'revisá el inbox y resumí'). " +
      "Pasá EXACTAMENTE UNO de `when` (one-shot) o `recur` (recurrente). " +
      "El `report` decide qué pasa con tu respuesta al disparar: 'always' la manda al " +
      "chat del usuario (recordatorios), 'never' la descarta (tareas de fondo; sólo se " +
      "avisa si hay error).",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "Título corto (≤60 chars), imperativo, para el listado de la agenda. POBLALO " +
            "SIEMPRE. No repitas el `what`: resumilo a una etiqueta escaneable (ej. what='revisá " +
            "el inbox de Alicia y resumí lo importante' → title='Resumen del inbox'; what='recordale " +
            "a Alicia el turno del dentista' → title='Dentista de Alicia').",
        },
        what: {
          type: "string",
          description: "Qué hacer al vencer, en imperativo (se te reinyecta como prompt).",
        },
        when: {
          type: "string",
          description:
            "Disparo one-shot: timestamp ISO 8601 con offset (ej. 2026-05-27T09:00:00-03:00). " +
            "Calculalo vos a partir del pedido y la hora/fecha actual. Debe ser futuro.",
        },
        recur: {
          type: "string",
          description:
            "Recurrente: expresión cron de 5 campos (min hora dom mes dow). " +
            "Ej: '0 9 * * *' = todos los días 9am; '0 9 * * 1' = lunes 9am.",
        },
        tz: {
          type: "string",
          description: `IANA timezone para 'recur' (ej. America/Argentina/Buenos_Aires). Default ${DEFAULT_TZ}.`,
        },
        report: {
          type: "string",
          enum: ["always", "never"],
          description: "always = avisa al chat al disparar; never = silencioso. Default always.",
        },
      },
      required: ["what"],
    },
  },
  {
    name: "schedule_list",
    description: "Lista los recordatorios/crons activos del usuario (id, qué, próximo disparo).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "schedule_cancel",
    description: "Cancela un recordatorio/cron por id (de schedule_list).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer", description: "id del cron a cancelar." } },
      required: ["id"],
    },
  },
];

async function callTool(token: string, name: string, args: ToolArgs): Promise<unknown> {
  const { userId, channel } = identityFromToken(token);

  if (name === "schedule_create") {
    const what = str(args.what).trim();
    if (!what) throw new Error("falta `what` (qué hacer al vencer)");
    const title = str(args.title).trim(); // opcional; el store lo deriva del `what` si falta
    const when = str(args.when).trim();
    const recur = str(args.recur).trim();
    if (!!when === !!recur)
      throw new Error("pasá EXACTAMENTE uno de `when` (one-shot) o `recur` (recurrente)");
    const report: CronReport = args.report === "never" ? "never" : "always";
    const tz = str(args.tz).trim() || DEFAULT_TZ;

    let kind: "once" | "recur";
    let nextFire: string;
    let recurExpr: string | null = null;
    if (when) {
      const ts = new Date(when);
      if (Number.isNaN(ts.getTime())) throw new Error(`\`when\` no es un timestamp ISO válido: ${when}`);
      if (ts.getTime() <= Date.now()) throw new Error("ese momento ya pasó; elegí uno futuro");
      kind = "once";
      nextFire = ts.toISOString();
    } else {
      if (!isValidCron(recur, tz))
        throw new Error(`\`recur\` no es un cron-expr válido (o tz inválida): ${recur} / ${tz}`);
      kind = "recur";
      recurExpr = recur;
      nextFire = nextFireFrom(recur, tz, new Date().toISOString());
    }

    const row = createCron(db(), {
      userId,
      // Canal de origen de la sesión (feature crons-delivery): el cron se entrega DONDE fue
      // creado. Fallback telegram si el token no lo trae (tokens viejos de 3 partes / canal vacío).
      channel: channel || "telegram",
      ...(title ? { title } : {}),
      what,
      report,
      kind,
      recurExpr,
      tz,
      nextFire,
    });
    return {
      id: row.id,
      title: row.title,
      kind: row.kind,
      next_fire: row.next_fire,
      report: row.report,
      ...(recurExpr ? { recur: recurExpr, tz } : {}),
    };
  }

  if (name === "schedule_list") {
    const rows = listCronsForUser(db(), userId).map((c) => ({
      id: c.id,
      title: c.title,
      what: c.what,
      kind: c.kind,
      next_fire: c.next_fire,
      report: c.report,
      ...(c.recur_expr ? { recur: c.recur_expr, tz: c.tz } : {}),
    }));
    return { count: rows.length, crons: rows };
  }

  if (name === "schedule_cancel") {
    const id = Number(args.id);
    if (!Number.isInteger(id)) throw new Error("`id` inválido");
    const ok = cancelCron(db(), id, userId);
    return ok ? { cancelled: id } : { error: `no encontré un cron activo #${id} tuyo` };
  }

  throw new Error(`tool desconocida: ${name}`);
}

export const schedule: McpServer = { name: "schedule", tools: TOOLS, callTool };
