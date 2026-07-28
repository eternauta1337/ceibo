import { afterEach, describe, expect, it, vi } from "vitest";
import { drive } from "./drive.ts";

afterEach(() => vi.unstubAllGlobals());

// googleClient → JSON (lee text + parse); googleText → texto crudo. El router decide
// por URL: export/alt=media devuelven texto plano, el resto JSON.
function route(meta: Record<string, unknown>, text = "contenido crudo") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const isRaw = url.includes("export?") || url.includes("alt=media");
      const body = isRaw ? text : JSON.stringify(meta);
      return { ok: true, status: 200, text: async () => body } as Response;
    }),
  );
}

describe("drive.callTool", () => {
  it("search_files: count + files", async () => {
    route({ files: [{ id: "f1", name: "doc", mimeType: "text/plain", modifiedTime: "t" }] });
    const out = (await drive.callTool("tok", "search_files", { query: "name contains 'doc'" })) as {
      count: number;
      files: { id: string }[];
    };
    expect(out.count).toBe(1);
    expect(out.files[0]?.id).toBe("f1");
  });

  it("read_file: Google Doc nativo → exporta a texto", async () => {
    route({ id: "f1", name: "Doc", mimeType: "application/vnd.google-apps.document" }, "texto exportado");
    const out = (await drive.callTool("tok", "read_file", { fileId: "f1" })) as { content: string };
    expect(out.content).toBe("texto exportado");
  });

  it("read_file: text/* → baja el contenido", async () => {
    route({ id: "f1", name: "n.txt", mimeType: "text/plain" }, "plano");
    const out = (await drive.callTool("tok", "read_file", { fileId: "f1" })) as { content: string };
    expect(out.content).toBe("plano");
  });

  it("read_file: binario → no legible (content null + note)", async () => {
    route({ id: "f1", name: "img.png", mimeType: "image/png" });
    const out = (await drive.callTool("tok", "read_file", { fileId: "f1" })) as {
      content: null;
      note: string;
    };
    expect(out.content).toBeNull();
    expect(out.note).toMatch(/binario/);
  });

  it("tool desconocida → tira", async () => {
    route({});
    await expect(drive.callTool("tok", "nope", {})).rejects.toThrow(/desconocida/);
  });
});
