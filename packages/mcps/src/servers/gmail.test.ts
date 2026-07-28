import { afterEach, describe, expect, it, vi } from "vitest";
import {
  b64UrlToStd,
  collectAttachments,
  decodeB64Url,
  extractBody,
  gmail,
  header,
  normImageMime,
} from "./gmail.ts";

const b64url = (s: string) => Buffer.from(s).toString("base64url");

describe("normImageMime", () => {
  it("image/jpg → image/jpeg", () => {
    expect(normImageMime("image/jpg")).toBe("image/jpeg");
    expect(normImageMime("IMAGE/JPG")).toBe("image/jpeg");
  });
  it("el resto baja a minúsculas tal cual", () => {
    expect(normImageMime("Image/PNG")).toBe("image/png");
  });
});

describe("b64UrlToStd", () => {
  it("traduce -/_ a +// y agrega padding al múltiplo de 4", () => {
    expect(b64UrlToStd("-_")).toBe("+/=="); // len 2 → +2 padding
    expect(b64UrlToStd("abc")).toBe("abc="); // len 3 → +1 padding
  });
  it("sin necesidad de padding queda igual (salvo -/_)", () => {
    expect(b64UrlToStd("abcd")).toBe("abcd");
  });
  it("undefined → cadena vacía", () => {
    expect(b64UrlToStd(undefined)).toBe("");
  });
});

describe("decodeB64Url", () => {
  it("decodifica base64url a utf8", () => {
    expect(decodeB64Url(b64url("hola ñ"))).toBe("hola ñ");
  });
  it("undefined → vacío", () => {
    expect(decodeB64Url(undefined)).toBe("");
  });
});

describe("header", () => {
  const msg = { payload: { headers: [{ name: "From", value: "a@b.com" }] } };
  it("busca case-insensitive", () => {
    expect(header(msg, "from")).toBe("a@b.com");
    expect(header(msg, "FROM")).toBe("a@b.com");
  });
  it("header ausente → vacío", () => {
    expect(header(msg, "Subject")).toBe("");
  });
});

describe("collectAttachments", () => {
  it("junta los nodos con filename + attachmentId, recursivo", () => {
    const payload = {
      parts: [
        { mimeType: "text/plain" }, // sin adjunto
        { filename: "a.pdf", mimeType: "application/pdf", body: { attachmentId: "att1", size: 100 } },
        { parts: [{ filename: "b.png", body: { attachmentId: "att2" } }] }, // anidado, mime ausente
      ],
    };
    const out = collectAttachments(payload);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ filename: "a.pdf", attachmentId: "att1", size: 100 });
    // mime ausente → default; size ausente → 0
    expect(out[1]).toMatchObject({
      filename: "b.png",
      mimeType: "application/octet-stream",
      attachmentId: "att2",
      size: 0,
    });
  });

  it("sin adjuntos → []", () => {
    expect(collectAttachments({ mimeType: "text/plain", body: { data: "x" } })).toEqual([]);
  });

  it("payload undefined → []", () => {
    expect(collectAttachments(undefined)).toEqual([]);
  });
});

describe("extractBody", () => {
  it("text/plain directo", () => {
    expect(extractBody({ mimeType: "text/plain", body: { data: b64url("cuerpo") } })).toBe("cuerpo");
  });

  it("multipart: prioriza text/plain sobre html", () => {
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: b64url("<b>hi</b>") } },
        { mimeType: "text/plain", body: { data: b64url("plano gana") } },
      ],
    };
    expect(extractBody(payload)).toBe("plano gana");
  });

  it("solo html → fallback a html", () => {
    expect(extractBody({ mimeType: "text/html", body: { data: b64url("<i>x</i>") } })).toBe("<i>x</i>");
  });

  it("sin cuerpo textual → vacío", () => {
    expect(extractBody({ mimeType: "image/png", body: { data: "xx" } })).toBe("");
    expect(extractBody(undefined)).toBe("");
  });
});

// gmail.callTool corre contra la REST de Google vía un `api` que usa fetch global → lo
// stubbeamos y ruteamos por URL. Cubre el dispatch + el armado de cada request/response.
describe("gmail.callTool", () => {
  afterEach(() => vi.unstubAllGlobals());

  const drafts: { raw: string }[] = [];
  function routeFetch() {
    drafts.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        let json: unknown = {};
        if (url.includes("/drafts") && init.method === "POST") {
          const raw = JSON.parse(init.body as string).message.raw as string;
          drafts.push({ raw: Buffer.from(raw, "base64url").toString("utf8") });
          json = { id: "d1", message: { id: "msg1" } };
        } else if (url.includes("/attachments/")) {
          json = { data: b64url("hola adjunto"), size: 12 };
        } else if (url.includes("format=full")) {
          json = {
            id: "m1",
            snippet: "snip",
            payload: {
              headers: [
                { name: "From", value: "a@b.com" },
                { name: "Subject", value: "Asunto" },
              ],
              mimeType: "text/plain",
              body: { data: b64url("cuerpo") },
            },
          };
        } else if (url.includes("format=metadata")) {
          json = { id: "m1", snippet: "snip", payload: { headers: [{ name: "From", value: "a@b.com" }] } };
        } else if (url.includes("/messages?")) {
          json = { messages: [{ id: "m1" }] };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify(json) } as Response;
      }),
    );
  }

  it("search_messages: lista + hidrata cada mensaje con sus headers", async () => {
    routeFetch();
    const out = (await gmail.callTool("tok", "search_messages", { query: "is:unread" })) as {
      count: number;
      messages: { id: string; from: string }[];
    };
    expect(out.count).toBe(1);
    expect(out.messages[0]).toMatchObject({ id: "m1", from: "a@b.com" });
  });

  it("read_message: arma from/subject/body/attachments", async () => {
    routeFetch();
    const out = (await gmail.callTool("tok", "read_message", { id: "m1" })) as {
      subject: string;
      body: string;
    };
    expect(out.subject).toBe("Asunto");
    expect(out.body).toBe("cuerpo");
  });

  it("create_draft: arma el RFC822 y sanitiza header injection (sin CR/LF en To/Subject)", async () => {
    routeFetch();
    const out = (await gmail.callTool("tok", "create_draft", {
      to: "x@y.com\r\nBcc: evil@z.com",
      subject: "Hola\nmundo",
      body: "cuerpo del mail",
    })) as { draftId: string };
    expect(out.draftId).toBe("d1");
    const raw = drafts[0]?.raw ?? "";
    // los CRLF inyectados en To/Subject se colapsan a espacio → no hay header Bcc nuevo
    expect(raw).toContain("To: x@y.com Bcc: evil@z.com");
    expect(raw).toContain("Subject: Hola mundo");
    expect(raw).not.toMatch(/\r\nBcc:/);
    expect(raw).toContain("cuerpo del mail");
  });

  it("read_attachment (texto): decodifica y devuelve el contenido", async () => {
    routeFetch();
    const out = (await gmail.callTool("tok", "read_attachment", {
      messageId: "m1",
      attachmentId: "a1",
      mimeType: "text/plain",
      filename: "n.txt",
    })) as { content: string; truncated: boolean };
    expect(out.content).toBe("hola adjunto");
    expect(out.truncated).toBe(false);
  });

  it("read_attachment (imagen): devuelve content block de imagen (rawContent)", async () => {
    routeFetch();
    const out = (await gmail.callTool("tok", "read_attachment", {
      messageId: "m1",
      attachmentId: "a1",
      mimeType: "image/png",
      filename: "p.png",
    })) as { content: { type: string; mimeType?: string }[] };
    expect(out.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  it("read_attachment sin ids → tira", async () => {
    routeFetch();
    await expect(gmail.callTool("tok", "read_attachment", {})).rejects.toThrow(/messageId/);
  });

  it("tool desconocida → tira", async () => {
    routeFetch();
    await expect(gmail.callTool("tok", "nope", {})).rejects.toThrow(/desconocida/);
  });
});
