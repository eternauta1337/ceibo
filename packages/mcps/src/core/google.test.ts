import { afterEach, describe, expect, it, vi } from "vitest";
import { googleClient, googleText } from "./google.ts";

type FetchArgs = { url: string; init: RequestInit };
function stubFetch(resp: { ok?: boolean; status?: number; text: string }) {
  const calls: FetchArgs[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return {
        ok: resp.ok ?? true,
        status: resp.status ?? 200,
        text: async () => resp.text,
      } as Response;
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("googleClient", () => {
  it("forwardea el Bearer + base+path y parsea el JSON", async () => {
    const calls = stubFetch({ text: JSON.stringify({ id: "abc" }) });
    const api = googleClient("https://gmail.googleapis.com/v1");
    const body = await api<{ id: string }>("tok", "/messages");
    expect(body.id).toBe("abc");
    const call = calls[0];
    expect(call?.url).toBe("https://gmail.googleapis.com/v1/messages");
    expect((call?.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("cuerpo vacío → objeto vacío", async () => {
    stubFetch({ text: "" });
    const api = googleClient("https://x");
    expect(await api("t", "/p")).toEqual({});
  });

  it("HTTP no-ok → tira con error.message de Google", async () => {
    stubFetch({ ok: false, status: 403, text: JSON.stringify({ error: { message: "insufficient" } }) });
    const api = googleClient("https://x");
    await expect(api("t", "/p")).rejects.toThrow("insufficient");
  });

  it("HTTP no-ok sin JSON estructurado → mensaje genérico con status", async () => {
    stubFetch({ ok: false, status: 500, text: "boom" });
    const api = googleClient("https://x");
    await expect(api("t", "/p")).rejects.toThrow("Google API HTTP 500");
  });
});

describe("googleText", () => {
  it("devuelve el texto crudo si entra en maxChars", async () => {
    stubFetch({ text: "hola" });
    const txt = googleText("https://x");
    expect(await txt("t", "/export")).toBe("hola");
  });

  it("trunca con marcador si excede maxChars", async () => {
    stubFetch({ text: "abcdefghij" });
    const txt = googleText("https://x");
    const out = await txt("t", "/export", 4);
    expect(out).toBe("abcd\n…[truncado]");
  });

  it("HTTP no-ok → tira con error.message si lo hay", async () => {
    stubFetch({ ok: false, status: 404, text: JSON.stringify({ error: { message: "not found" } }) });
    const txt = googleText("https://x");
    await expect(txt("t", "/export")).rejects.toThrow("not found");
  });
});
