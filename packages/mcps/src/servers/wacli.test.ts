import { createCipheriv, createHmac, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptMedia, flag, leanMessages, normImageMime, parseEnvelope, projectMessage } from "./wacli.ts";

describe("parseEnvelope", () => {
  it("success → devuelve data", () => {
    expect(parseEnvelope(JSON.stringify({ success: true, data: { x: 1 }, error: null }))).toEqual({ x: 1 });
  });
  it("success:false → tira con el error", () => {
    expect(() => parseEnvelope(JSON.stringify({ success: false, data: null, error: "boom" }))).toThrow(
      /boom/,
    );
  });
  it("no-JSON → tira", () => {
    expect(() => parseEnvelope("no soy json")).toThrow(/no es JSON/);
  });
});

describe("flag", () => {
  it("agrega --name valor si está presente", () => {
    expect(flag("limit", 10)).toEqual(["--limit", "10"]);
  });
  it("omite si undefined o vacío", () => {
    expect(flag("q", undefined)).toEqual([]);
    expect(flag("q", "")).toEqual([]);
  });
});

describe("projectMessage", () => {
  it("recorta a lo esencial; sin media no agrega id/chat_jid", () => {
    const out = projectMessage({
      Timestamp: 123,
      SenderName: "Alicia",
      FromMe: false,
      ChatName: "Familia",
      Text: "hola",
      Reactions: "ignorar",
    }) as Record<string, unknown>;
    expect(out).toEqual({ ts: 123, from: "Alicia", from_me: false, chat: "Familia", text: "hola" });
  });

  it("con media agrega media/id/chat_jid y usa MediaCaption como text fallback", () => {
    const out = projectMessage({
      Timestamp: 1,
      SenderJID: "j@s",
      ChatJID: "c@g",
      MsgID: "M1",
      MediaType: "image",
      MediaCaption: "mirá",
    }) as Record<string, unknown>;
    expect(out).toMatchObject({ media: "image", id: "M1", chat_jid: "c@g", text: "mirá", from: "j@s" });
  });

  it("no-objeto pasa tal cual", () => {
    expect(projectMessage("x")).toBe("x");
  });
});

describe("leanMessages", () => {
  it("proyecta data.messages preservando el resto del envelope", () => {
    const out = leanMessages({ fts: true, messages: [{ Timestamp: 1, Text: "a" }] }) as {
      fts: boolean;
      messages: Record<string, unknown>[];
    };
    expect(out.fts).toBe(true);
    expect(out.messages[0]).toMatchObject({ text: "a" });
  });
  it("array pelado → mapea", () => {
    const out = leanMessages([{ Text: "a" }]) as Record<string, unknown>[];
    expect(out[0]).toMatchObject({ text: "a" });
  });
});

describe("normImageMime", () => {
  it("normaliza jpg→jpeg y respeta los válidos", () => {
    expect(normImageMime("image/jpg", "x.bin")).toBe("image/jpeg");
    expect(normImageMime("image/png", "x.bin")).toBe("image/png");
  });
  it("mime no-imagen → cae a la extensión del path", () => {
    expect(normImageMime("application/octet-stream", "foto.webp")).toBe("image/webp");
  });
  it("sin pista útil → default jpeg", () => {
    expect(normImageMime("application/octet-stream", "blob.dat")).toBe("image/jpeg");
  });
});

describe("decryptMedia (esquema whatsmeow)", () => {
  // Cifra como WhatsApp para verificar el round-trip del descifrado.
  function encrypt(plain: Buffer, mediaKey: Buffer, info: string): Buffer {
    const exp = Buffer.from(hkdfSync("sha256", mediaKey, Buffer.alloc(32), Buffer.from(info), 112));
    const iv = exp.subarray(0, 16);
    const cipherKey = exp.subarray(16, 48);
    const macKey = exp.subarray(48, 80);
    const c = createCipheriv("aes-256-cbc", cipherKey, iv);
    const ciphertext = Buffer.concat([c.update(plain), c.final()]);
    const mac = createHmac("sha256", macKey).update(iv).update(ciphertext).digest().subarray(0, 10);
    return Buffer.concat([ciphertext, mac]);
  }

  it("round-trip audio: descifra el plaintext", () => {
    const key = Buffer.alloc(32, 7);
    const plain = Buffer.from("nota de voz OGG");
    const enc = encrypt(plain, key, "WhatsApp Audio Keys");
    expect(decryptMedia(enc, key, "audio").toString()).toBe("nota de voz OGG");
  });

  it("MAC corrupto → tira", () => {
    const key = Buffer.alloc(32, 7);
    const enc = encrypt(Buffer.from("x"), key, "WhatsApp Audio Keys");
    const last = enc.length - 1;
    enc[last] = (enc[last] ?? 0) ^ 0xff; // rompe el último byte del MAC
    expect(() => decryptMedia(enc, key, "audio")).toThrow(/HMAC/);
  });

  it("tipo desconocido → tira", () => {
    expect(() => decryptMedia(Buffer.alloc(20), Buffer.alloc(32), "raro")).toThrow(/tipo/);
  });

  it("blob demasiado corto → tira", () => {
    expect(() => decryptMedia(Buffer.alloc(5), Buffer.alloc(32), "audio")).toThrow(/corto/);
  });
});
