// MCP server de Google Sheets: traduce MCP → Sheets REST v4.
//
// Tools: list_tabs, read_range, append_values. La escritura es SOLO additiva
// (append agrega filas al final; no sobrescribe ni borra rangos). El access_token
// (scope spreadsheets) lo inyecta el vault del usuario.

import { googleClient } from "../core/google.ts";
import type { McpServer, Tool, ToolArgs } from "../core/transport.ts";

const api = googleClient("https://sheets.googleapis.com/v4/spreadsheets");

interface SheetProps {
  properties?: { title?: string; sheetId?: number };
}
interface Spreadsheet {
  properties?: { title?: string };
  sheets?: SheetProps[];
}
interface ValueRange {
  range?: string;
  values?: unknown[][];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const TOOLS: Tool[] = [
  {
    name: "list_tabs",
    description:
      "Lista las pestañas (hojas) de una planilla por su id. Útil para saber los nombres de rango.",
    inputSchema: {
      type: "object",
      properties: { spreadsheetId: { type: "string", description: "id de la planilla (de la URL)." } },
      required: ["spreadsheetId"],
    },
  },
  {
    name: "read_range",
    description: "Lee un rango A1 (ej. 'Hoja1!A1:D20') y devuelve la matriz de valores.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string" },
        range: { type: "string", description: "Rango en notación A1, ej. 'Hoja1!A1:D20'." },
      },
      required: ["spreadsheetId", "range"],
    },
  },
  {
    name: "append_values",
    description:
      "Agrega filas al final de un rango (additivo, NO sobrescribe). `values` es una " +
      "lista de filas, cada fila una lista de celdas. Confirmá con el usuario antes de escribir.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string" },
        range: { type: "string", description: "Rango/tabla donde appendear, ej. 'Hoja1!A1'." },
        values: {
          type: "array",
          description: "Filas a agregar; cada fila es una lista de celdas.",
          items: { type: "array", items: {} },
        },
      },
      required: ["spreadsheetId", "range", "values"],
    },
  },
];

async function callTool(token: string, name: string, args: ToolArgs): Promise<unknown> {
  const id = encodeURIComponent(str(args.spreadsheetId));

  if (name === "list_tabs") {
    const ss = await api<Spreadsheet>(
      token,
      `/${id}?fields=properties.title,sheets.properties(title,sheetId)`,
    );
    return {
      title: ss.properties?.title,
      tabs: (ss.sheets ?? []).map((s) => ({ title: s.properties?.title, sheetId: s.properties?.sheetId })),
    };
  }

  if (name === "read_range") {
    const range = encodeURIComponent(str(args.range));
    const vr = await api<ValueRange>(token, `/${id}/values/${range}`);
    return { range: vr.range, values: vr.values ?? [] };
  }

  if (name === "append_values") {
    const range = encodeURIComponent(str(args.range));
    const values = Array.isArray(args.values) ? (args.values as unknown[][]) : [];
    const out = await api<{ updates?: { updatedRange?: string; updatedRows?: number } }>(
      token,
      `/${id}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: JSON.stringify({ values }) },
    );
    return { updatedRange: out.updates?.updatedRange, updatedRows: out.updates?.updatedRows };
  }

  throw new Error(`tool desconocida: ${name}`);
}

export const sheets: McpServer = { name: "sheets", tools: TOOLS, callTool };
