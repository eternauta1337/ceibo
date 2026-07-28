import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken } from "./crypto.ts";

// Bajo Vitest, crypto.ts cae a una clave de test fija si OAUTH_ENC_KEY no está seteada.

describe("encryptToken/decryptToken (AES-256-GCM, A3)", () => {
  it("round-trip: descifra el plaintext original", () => {
    expect(decryptToken(encryptToken("ya29.un-access-token"))).toBe("ya29.un-access-token");
    expect(decryptToken(encryptToken(""))).toBe(""); // string vacío
  });

  it("nonce por escritura: dos cifrados del mismo plaintext difieren", () => {
    expect(encryptToken("mismo")).not.toBe(encryptToken("mismo"));
  });

  it("el ciphertext no contiene el plaintext en claro", () => {
    const blob = encryptToken("secreto-visible");
    expect(Buffer.from(blob, "base64").toString("utf8")).not.toContain("secreto-visible");
  });

  it("tag manipulado → tira (AEAD detecta tampering)", () => {
    const buf = Buffer.from(encryptToken("hola"), "base64");
    const last = buf.length - 1;
    buf[last] = (buf[last] ?? 0) ^ 0xff; // corrompe el último byte del tag
    expect(() => decryptToken(buf.toString("base64"))).toThrow();
  });

  it("blob no-cifrado (fila vieja en claro) → tira", () => {
    expect(() => decryptToken("texto-plano-viejo")).toThrow();
  });
});
