import { describe, expect, it } from "vitest";
import { signSessionToken, signUserToken, verifySessionToken } from "./index.ts";

const KEY = "test-session-key";
const HOUR = 60 * 60 * 1000;

describe("session token (con expiry embebido)", () => {
  it("verifica un token recién firmado, antes del exp", () => {
    const now = 1_000_000;
    const tok = signSessionToken(7, KEY, now + HOUR);
    expect(verifySessionToken(tok, KEY, now)).toBe(7);
  });

  it("rechaza un token vencido", () => {
    const now = 1_000_000;
    const tok = signSessionToken(7, KEY, now + HOUR);
    expect(verifySessionToken(tok, KEY, now + 2 * HOUR)).toBeUndefined();
  });

  it("rechaza un token firmado con otra key", () => {
    const now = 1_000_000;
    const tok = signSessionToken(7, KEY, now + HOUR);
    expect(verifySessionToken(tok, "otra-key", now)).toBeUndefined();
  });

  it("rechaza un token manipulado (userId o exp cambiados)", () => {
    const now = 1_000_000;
    const tok = signSessionToken(7, KEY, now + HOUR);
    const [uid, exp, mac] = tok.split(".");
    expect(verifySessionToken(`9.${exp}.${mac}`, KEY, now)).toBeUndefined(); // otro userId
    expect(verifySessionToken(`${uid}.${now + 10 * HOUR}.${mac}`, KEY, now)).toBeUndefined(); // extender exp
  });

  it("rechaza formatos inválidos", () => {
    const now = 1_000_000;
    expect(verifySessionToken("malformado", KEY, now)).toBeUndefined();
    expect(verifySessionToken("a.b.c.d", KEY, now)).toBeUndefined();
    expect(verifySessionToken("", KEY, now)).toBeUndefined();
  });

  it("no acepta un token de capability como token de sesión (domain separation)", () => {
    // signUserToken firma `cap.<userId>.<exp>`; el de sesión `<userId>.<exp>` (sin prefijo).
    // Mismo wire-format (3 partes) pero el MAC difiere → ni con la misma key son intercambiables.
    const cap = signUserToken(7, KEY, 1_000_000, 60 * 60 * 1000);
    expect(verifySessionToken(cap, KEY, 1_000_000)).toBeUndefined();
  });
});
