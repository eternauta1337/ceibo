import { describe, expect, it, vi } from "vitest";
import {
  type BotApiCall,
  collectInboundMedia,
  extractReplyAudio,
  type InboundAttachment,
  makeDebugActivity,
  normVisionMime,
} from "./telegram.ts";
import type { PostTarget } from "./types.ts";

const MAX = 15 * 1024 * 1024;

// PostTarget fake que acumula los posts (los avisos de "muy grande" salen por acá).
function fakeThread() {
  const posts: string[] = [];
  const thread: PostTarget = {
    post: async (t: string) => {
      posts.push(t);
    },
    startTyping: async () => {},
  };
  return { thread, posts };
}

const att = (a: Partial<InboundAttachment> & { data?: Buffer }): InboundAttachment => ({
  fetchData: a.data ? async () => a.data as Buffer : undefined,
  ...a,
});

describe("normVisionMime", () => {
  it("jpg/jpeg (cualquier casing) → image/jpeg", () => {
    expect(normVisionMime("image/jpg")).toBe("image/jpeg");
    expect(normVisionMime("image/jpeg")).toBe("image/jpeg");
    expect(normVisionMime("IMAGE/JPEG")).toBe("image/jpeg");
  });
  it("otras imágenes de visión bajan a minúsculas", () => {
    expect(normVisionMime("image/PNG")).toBe("image/png");
    expect(normVisionMime("image/webp")).toBe("image/webp");
  });
  it("MIME no soportado por visión → default image/jpeg (red de seguridad)", () => {
    expect(normVisionMime("image/heic")).toBe("image/jpeg");
  });
});

describe("makeDebugActivity (render de debug en Telegram)", () => {
  // call fake: registra (method, body) y devuelve un message_id fijo en el sendMessage.
  function fakeCall(messageId = 42) {
    const calls: { method: string; body: unknown }[] = [];
    const call: BotApiCall = async (method, body) => {
      calls.push({ method, body });
      return { json: async () => ({ result: { message_id: messageId } }) };
    };
    return { call, calls };
  }

  it("debug off (o sin opts) → no toca la Bot API", async () => {
    const { call, calls } = fakeCall();
    const activity = makeDebugActivity("123", call);
    await activity("buscando en la wiki", { debug: false });
    await activity("buscando en la wiki"); // sin opts
    expect(calls).toEqual([]);
  });

  it("debug on: primer tool-call → sendMessage con 🔧; los siguientes → editMessageText in-place", async () => {
    const { call, calls } = fakeCall(7);
    const activity = makeDebugActivity("123", call);
    await activity("buscando en la wiki", { debug: true });
    await activity("actualizando una nota", { debug: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      method: "sendMessage",
      body: { chat_id: "123", text: "🔧 buscando en la wiki" },
    });
    expect(calls[1]).toEqual({
      method: "editMessageText",
      body: { chat_id: "123", message_id: 7, text: "🔧 actualizando una nota" },
    });
  });

  it("debug on con detail → muestra 'label: detail' (Telegram es superficie de debug)", async () => {
    const { call, calls } = fakeCall(5);
    const activity = makeDebugActivity("123", call);
    await activity("corriendo un comando", { debug: true, detail: "node /mnt/foo.mjs" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      method: "sendMessage",
      body: { chat_id: "123", text: "🔧 corriendo un comando: node /mnt/foo.mjs" },
    });
  });

  it("debug on sin detail → muestra sólo el label", async () => {
    const { call, calls } = fakeCall(6);
    const activity = makeDebugActivity("123", call);
    await activity("buscando en la wiki", { debug: true });
    expect(calls[0]?.body).toEqual({ chat_id: "123", text: "🔧 buscando en la wiki" });
  });

  it("mismo label consecutivo → no re-emite (evita 'message is not modified')", async () => {
    const { call, calls } = fakeCall();
    const activity = makeDebugActivity("123", call);
    await activity("buscando en la wiki", { debug: true });
    await activity("buscando en la wiki", { debug: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("sendMessage");
  });

  it("si la Bot API tira, se traga (no rompe el turno) y reintenta como sendMessage", async () => {
    const calls: string[] = [];
    let first = true;
    const call: BotApiCall = vi.fn(async (method: string) => {
      calls.push(method);
      if (first) {
        first = false;
        throw new Error("network");
      }
      return { json: async () => ({ result: { message_id: 9 } }) };
    });
    const activity = makeDebugActivity("123", call);
    await expect(activity("buscando", { debug: true })).resolves.toBeUndefined(); // no lanza
    // el primer sendMessage falló → msgId quedó undefined → el siguiente vuelve a sendMessage
    await activity("otra cosa", { debug: true });
    expect(calls).toEqual(["sendMessage", "sendMessage"]);
  });

  it("si sendMessage no devuelve message_id → el siguiente vuelve a sendMessage (no editMessageText)", async () => {
    const calls: string[] = [];
    const call: BotApiCall = async (method) => {
      calls.push(method);
      return { json: async () => ({}) }; // sin result.message_id
    };
    const activity = makeDebugActivity("123", call);
    await activity("a", { debug: true });
    await activity("b", { debug: true });
    expect(calls).toEqual(["sendMessage", "sendMessage"]);
  });
});

describe("extractReplyAudio (reply-to-transcribe)", () => {
  // download fake: registra los file_id pedidos y devuelve bytes fijos.
  function fakeDownload(bytes = Buffer.from("OGG")) {
    const calls: string[] = [];
    const download = async (fileId: string): Promise<Buffer> => {
      calls.push(fileId);
      return bytes;
    };
    return { download, calls };
  }

  it("reply a una nota de voz → InboundAudio lazy (no baja nada hasta fetchData)", async () => {
    const { download, calls } = fakeDownload();
    const audio = extractReplyAudio(
      { reply_to_message: { voice: { file_id: "VOICE1", mime_type: "audio/ogg" } } },
      download,
    );
    expect(audio?.mime).toBe("audio/ogg");
    expect(calls).toEqual([]); // lazy: el STT decide si baja
    const buf = await audio?.fetchData();
    expect(buf?.toString()).toBe("OGG");
    expect(calls).toEqual(["VOICE1"]);
  });

  it("reply a un archivo de audio (no voice) → también lo extrae", async () => {
    const { download, calls } = fakeDownload(Buffer.from("MP3"));
    const audio = extractReplyAudio(
      { reply_to_message: { audio: { file_id: "AUD1", mime_type: "audio/mpeg" } } },
      download,
    );
    expect(audio?.mime).toBe("audio/mpeg");
    await audio?.fetchData();
    expect(calls).toEqual(["AUD1"]);
  });

  it("citado con voice Y audio → gana el voice", async () => {
    const { download, calls } = fakeDownload();
    const audio = extractReplyAudio(
      {
        reply_to_message: {
          voice: { file_id: "VOICE1", mime_type: "audio/ogg" },
          audio: { file_id: "AUD1", mime_type: "audio/mpeg" },
        },
      },
      download,
    );
    await audio?.fetchData();
    expect(calls).toEqual(["VOICE1"]);
  });

  it("mensaje sin reply → undefined (raw cualquiera, incluso undefined)", () => {
    const { download } = fakeDownload();
    expect(extractReplyAudio({ text: "hola" }, download)).toBeUndefined();
    expect(extractReplyAudio(undefined, download)).toBeUndefined();
    expect(extractReplyAudio(null, download)).toBeUndefined();
  });

  it("reply sin audio (texto / foto) → undefined", () => {
    const { download } = fakeDownload();
    expect(extractReplyAudio({ reply_to_message: { text: "mensaje viejo" } }, download)).toBeUndefined();
    expect(
      extractReplyAudio({ reply_to_message: { photo: [{ file_id: "PIC" }] } }, download),
    ).toBeUndefined();
  });

  it("voice citado sin file_id → undefined (no hay qué bajar)", () => {
    const { download } = fakeDownload();
    expect(
      extractReplyAudio({ reply_to_message: { voice: { mime_type: "audio/ogg" } } }, download),
    ).toBeUndefined();
  });

  it("mime ausente en el citado → audio sin mime (el STT autodetecta)", () => {
    const { download } = fakeDownload();
    const audio = extractReplyAudio({ reply_to_message: { voice: { file_id: "V" } } }, download);
    expect(audio).toBeDefined();
    expect(audio?.mime).toBeUndefined();
  });
});

describe("collectInboundMedia", () => {
  it("imagen → InboundMedia kind image con base64 y MIME normalizado", async () => {
    const { thread } = fakeThread();
    const out = await collectInboundMedia(
      [att({ type: "image", mimeType: "image/jpg", data: Buffer.from("PIC") })],
      thread,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      kind: "image",
      data: Buffer.from("PIC").toString("base64"),
      mediaType: "image/jpeg",
    });
  });

  it("PDF → kind document con filename", async () => {
    const { thread } = fakeThread();
    const out = await collectInboundMedia(
      [att({ mimeType: "application/pdf", name: "f.pdf", data: Buffer.from("%PDF") })],
      thread,
    );
    expect(out[0]).toMatchObject({ kind: "document", mediaType: "application/pdf", filename: "f.pdf" });
  });

  it("detecta imagen por MIME aunque falte type", async () => {
    const { thread } = fakeThread();
    const out = await collectInboundMedia([att({ mimeType: "image/png", data: Buffer.from("x") })], thread);
    expect(out[0]?.kind).toBe("image");
  });

  it("descarta lo que no es imagen ni PDF", async () => {
    const { thread } = fakeThread();
    const out = await collectInboundMedia(
      [att({ type: "video", mimeType: "video/mp4", data: Buffer.from("v") })],
      thread,
    );
    expect(out).toEqual([]);
  });

  it("descarta adjunto sin fetchData", async () => {
    const { thread } = fakeThread();
    const out = await collectInboundMedia([att({ type: "image", mimeType: "image/png" })], thread);
    expect(out).toEqual([]);
  });

  it("size declarado > tope → avisa y descarta sin bajar bytes", async () => {
    const { thread, posts } = fakeThread();
    let fetched = false;
    const out = await collectInboundMedia(
      [
        {
          type: "image",
          mimeType: "image/png",
          name: "big.png",
          size: MAX + 1,
          fetchData: async () => {
            fetched = true;
            return Buffer.from("x");
          },
        },
      ],
      thread,
    );
    expect(out).toEqual([]);
    expect(fetched).toBe(false);
    expect(posts[0]).toMatch(/big\.png.*grande/);
  });

  it("bytes reales > tope → avisa y descarta", async () => {
    const { thread, posts } = fakeThread();
    const out = await collectInboundMedia(
      [att({ type: "image", mimeType: "image/png", name: "huge.png", data: Buffer.alloc(MAX + 1) })],
      thread,
    );
    expect(out).toEqual([]);
    expect(posts[0]).toMatch(/grande/);
  });
});
