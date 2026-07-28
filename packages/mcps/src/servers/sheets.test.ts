import { afterEach, describe, expect, it, vi } from "vitest";
import { sheets } from "./sheets.ts";

afterEach(() => vi.unstubAllGlobals());

function route(handler: (url: string, init: RequestInit) => unknown) {
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (init.method === "POST") posts.push({ url, body: JSON.parse(init.body as string) });
      return { ok: true, status: 200, text: async () => JSON.stringify(handler(url, init)) } as Response;
    }),
  );
  return posts;
}

describe("sheets.callTool", () => {
  it("list_tabs: título + pestañas", async () => {
    route(() => ({
      properties: { title: "Mi Planilla" },
      sheets: [{ properties: { title: "Hoja1", sheetId: 0 } }],
    }));
    const out = (await sheets.callTool("tok", "list_tabs", { spreadsheetId: "ss1" })) as {
      title: string;
      tabs: { title: string; sheetId: number }[];
    };
    expect(out.title).toBe("Mi Planilla");
    expect(out.tabs[0]).toEqual({ title: "Hoja1", sheetId: 0 });
  });

  it("read_range: devuelve range + matriz de valores", async () => {
    route(() => ({
      range: "Hoja1!A1:B2",
      values: [
        ["a", "b"],
        ["c", "d"],
      ],
    }));
    const out = (await sheets.callTool("tok", "read_range", {
      spreadsheetId: "ss1",
      range: "Hoja1!A1:B2",
    })) as { values: unknown[][] };
    expect(out.values).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("append_values: manda values en el body y devuelve el resumen", async () => {
    const posts = route(() => ({ updates: { updatedRange: "Hoja1!A3", updatedRows: 1 } }));
    const out = (await sheets.callTool("tok", "append_values", {
      spreadsheetId: "ss1",
      range: "Hoja1!A1",
      values: [["x", "y"]],
    })) as { updatedRows: number };
    expect((posts[0]?.body as { values: unknown }).values).toEqual([["x", "y"]]);
    expect(out.updatedRows).toBe(1);
  });

  it("tool desconocida → tira", async () => {
    route(() => ({}));
    await expect(sheets.callTool("tok", "nope", {})).rejects.toThrow(/desconocida/);
  });
});
