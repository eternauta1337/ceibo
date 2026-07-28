// MCP server de Google Calendar: traduce MCP → Calendar REST v3.
//
// Tools: list_events, get_event, create_event. Borrar/mover eventos NO se expone
// (mutación destructiva); crear sí, pero el system prompt manda confirmar antes.
// El access_token (scope calendar.events) lo inyecta el vault del usuario.

import { googleClient } from "../core/google.ts";
import type { McpServer, Tool, ToolArgs } from "../core/transport.ts";

const api = googleClient("https://www.googleapis.com/calendar/v3");

interface CalEvent {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email?: string; responseStatus?: string }>;
}
interface EventList {
  items?: CalEvent[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function slim(e: CalEvent) {
  return {
    id: e.id,
    summary: e.summary ?? "(sin título)",
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date ?? "",
    location: e.location,
    status: e.status,
  };
}

const TOOLS: Tool[] = [
  {
    name: "list_events",
    description:
      "Lista eventos del calendario del usuario en una ventana de tiempo. " +
      "Devuelve id, título, inicio, fin, lugar de cada uno (ordenados por inicio).",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Calendario. Default 'primary'." },
        timeMin: { type: "string", description: "ISO 8601. Default: ahora." },
        timeMax: { type: "string", description: "ISO 8601. Opcional." },
        query: { type: "string", description: "Texto a buscar en los eventos. Opcional." },
        maxResults: { type: "integer", description: "Máx eventos (1-25). Default 10." },
      },
    },
  },
  {
    name: "get_event",
    description: "Lee un evento completo por id (incluye descripción y asistentes).",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Default 'primary'." },
        eventId: { type: "string", description: "id del evento (de list_events)." },
      },
      required: ["eventId"],
    },
  },
  {
    name: "create_event",
    description:
      "Crea un evento en el calendario del usuario. Confirmá los detalles con el " +
      "usuario antes de llamar. start/end en ISO 8601 (con hora) o YYYY-MM-DD (día entero).",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Default 'primary'." },
        summary: { type: "string", description: "Título del evento." },
        start: { type: "string", description: "ISO 8601 con hora, o YYYY-MM-DD para día entero." },
        end: { type: "string", description: "ISO 8601 con hora, o YYYY-MM-DD para día entero." },
        description: { type: "string" },
        location: { type: "string" },
      },
      required: ["summary", "start", "end"],
    },
  },
];

/** Arma {date} para YYYY-MM-DD o {dateTime} si trae hora. */
function timePoint(v: string): { date: string } | { dateTime: string } {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? { date: v } : { dateTime: v };
}

async function callTool(token: string, name: string, args: ToolArgs): Promise<unknown> {
  const calendarId = encodeURIComponent(str(args.calendarId) || "primary");

  if (name === "list_events") {
    const max = Math.min(Math.max(Number(args.maxResults ?? 10), 1), 25);
    const params = new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(max),
      timeMin: str(args.timeMin) || new Date().toISOString(),
    });
    if (str(args.timeMax)) params.set("timeMax", str(args.timeMax));
    if (str(args.query)) params.set("q", str(args.query));
    const list = await api<EventList>(token, `/calendars/${calendarId}/events?${params}`);
    const items = (list.items ?? []).map(slim);
    return { count: items.length, events: items };
  }

  if (name === "get_event") {
    const e = await api<CalEvent>(
      token,
      `/calendars/${calendarId}/events/${encodeURIComponent(str(args.eventId))}`,
    );
    return {
      ...slim(e),
      description: e.description ?? "",
      htmlLink: e.htmlLink,
      attendees: (e.attendees ?? []).map((a) => ({ email: a.email, status: a.responseStatus })),
    };
  }

  if (name === "create_event") {
    const e = await api<CalEvent>(token, `/calendars/${calendarId}/events`, {
      method: "POST",
      body: JSON.stringify({
        summary: str(args.summary),
        description: str(args.description) || undefined,
        location: str(args.location) || undefined,
        start: timePoint(str(args.start)),
        end: timePoint(str(args.end)),
      }),
    });
    return { id: e.id, htmlLink: e.htmlLink, summary: e.summary };
  }

  throw new Error(`tool desconocida: ${name}`);
}

export const calendar: McpServer = { name: "calendar", tools: TOOLS, callTool };
