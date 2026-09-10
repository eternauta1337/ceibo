import { describe, expect, it } from "vitest";
import { type ChunkMode, chunkText, WHATSAPP_HARD_LIMIT } from "./wacli-chunking.ts";
import type { WacliWebhookMessage } from "./wacli-webhook-types.ts";
import { isGroupJid, jidToString, stripDeviceSuffix } from "./wacli-webhook-types.ts";
import { normalizeWebhookMessage } from "./whatsapp.ts";

const base = (over: Partial<WacliWebhookMessage>): WacliWebhookMessage => ({
  Chat: "5491100000000@s.whatsapp.net",
  ID: "MSG1",
  SenderJID: "5491100000000@s.whatsapp.net",
  Timestamp: "2026-06-05T12:00:00Z",
  FromMe: false,
  Text: "hola",
  PushName: "Alicia",
  ...over,
});

describe("jid helpers", () => {
  it("jidToString normaliza objeto y string", () => {
    expect(jidToString("x@s.whatsapp.net")).toBe("x@s.whatsapp.net");
    expect(jidToString({ User: "5491100", Server: "s.whatsapp.net" })).toBe("5491100@s.whatsapp.net");
  });
  it("isGroupJid detecta @g.us", () => {
    expect(isGroupJid("123@g.us")).toBe(true);
    expect(isGroupJid("5491100@s.whatsapp.net")).toBe(false);
  });
  it("stripDeviceSuffix saca el :device", () => {
    expect(stripDeviceSuffix("111111111111111:24@lid")).toBe("111111111111111@lid");
    expect(stripDeviceSuffix("5491100@s.whatsapp.net")).toBe("5491100@s.whatsapp.net");
  });
});

describe("normalizeWebhookMessage", () => {
  it("DM de texto → externalId = senderJid, chatId = chat, text", () => {
    const n = normalizeWebhookMessage(base({ Text: "che" }));
    expect(n).not.toBeNull();
    expect(n?.externalId).toBe("5491100000000@s.whatsapp.net");
    expect(n?.chatId).toBe("5491100000000@s.whatsapp.net");
    expect(n?.text).toBe("che");
    expect(n?.mediaType).toBeUndefined();
  });

  it("descarta ecos propios (FromMe)", () => {
    expect(normalizeWebhookMessage(base({ FromMe: true }))).toBeNull();
  });

  it("descarta borrados (Revoked)", () => {
    expect(normalizeWebhookMessage(base({ Revoked: true }))).toBeNull();
  });

  it("descarta reacciones entrantes", () => {
    expect(normalizeWebhookMessage(base({ ReactionEmoji: "👍", ReactionToID: "MSG0" }))).toBeNull();
  });

  it("descarta grupos (v1 sólo DMs)", () => {
    const g = base({ Chat: "123-456@g.us", SenderJID: "5491100000000@s.whatsapp.net" });
    expect(normalizeWebhookMessage(g)).toBeNull();
  });

  it("saca el sufijo de device del sender", () => {
    const n = normalizeWebhookMessage(base({ SenderJID: "5491100000000:7@s.whatsapp.net" }));
    expect(n?.externalId).toBe("5491100000000@s.whatsapp.net");
  });

  it("nota de voz: wacli manda Text/Caption='[Audio]' → text='' para que el core haga STT", () => {
    // wacli rellena Text Y Media.Caption con "[Audio]" (placeholder) y reporta Type:"audio".
    const n = normalizeWebhookMessage(
      base({
        Text: "[Audio]",
        Media: { Type: "audio", MimeType: "audio/ogg; codecs=opus", Caption: "[Audio]" },
      }),
    );
    expect(n?.mediaType).toBe("audio");
    expect(n?.mediaMime).toBe("audio/ogg; codecs=opus");
    expect(n?.text).toBe(""); // el placeholder NO debe pasar como texto (si no, se saltea el STT)
  });

  it("ptt también descarta el placeholder de texto", () => {
    const n = normalizeWebhookMessage(base({ Text: "[Audio]", Media: { Type: "ptt" } }));
    expect(n?.text).toBe("");
  });

  it("imagen con caption → mediaType image, text = caption", () => {
    const n = normalizeWebhookMessage(
      base({ Text: "", Media: { Type: "image", MimeType: "image/jpeg", Caption: "mirá" } }),
    );
    expect(n?.mediaType).toBe("image");
    expect(n?.text).toBe("mirá");
  });

  it("Chat como objeto JID se normaliza a user@server", () => {
    const n = normalizeWebhookMessage(
      base({ Chat: { User: "5491100000000", Server: "s.whatsapp.net" }, SenderJID: "" }),
    );
    expect(n?.chatId).toBe("5491100000000@s.whatsapp.net");
    expect(n?.externalId).toBe("5491100000000@s.whatsapp.net"); // SenderJID vacío → cae a Chat
  });
});

describe("chunkText", () => {
  it("texto corto no se parte", () => {
    expect(chunkText("hola", WHATSAPP_HARD_LIMIT, "length")).toEqual(["hola"]);
  });
  it("parte por longitud y no pierde caracteres", () => {
    const t = "a".repeat(WHATSAPP_HARD_LIMIT + 100);
    const parts = chunkText(t, WHATSAPP_HARD_LIMIT, "length" as ChunkMode);
    expect(parts.length).toBe(2);
    expect(parts.join("").length).toBe(t.length);
  });
  it("modo newline corta en el salto de párrafo", () => {
    const limit = 20;
    const t = "primera parte aca\n\nsegunda parte mucho mas larga que el limite";
    const parts = chunkText(t, limit, "newline");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]).toBe("primera parte aca");
  });
});
