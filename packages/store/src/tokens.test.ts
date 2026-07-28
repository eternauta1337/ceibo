import { describe, expect, it } from "vitest";
import {
  addUser,
  createEnrollToken,
  createWebLoginToken,
  markEnrollTokenUsed,
  markWebLoginTokenUsed,
  openDb,
  peekEnrollToken,
  peekWebLoginToken,
  signScheduleToken,
  signSessionToken,
  signUserToken,
  verifyScheduleToken,
  verifyUserToken,
} from "./index.ts";

const db = () => openDb(":memory:");

describe("enroll tokens (single-use, TTL)", () => {
  it("peek valida sin consumir; markUsed lo invalida", () => {
    const d = db();
    const u = addUser(d, "demo");
    const tok = createEnrollToken(d, u.id, "gmail", "work");
    const claim = peekEnrollToken(d, tok);
    expect(claim).toEqual({ userId: u.id, service: "gmail", profile: "work" });
    // peek no consume → sigue válido
    expect(peekEnrollToken(d, tok)).toBeDefined();
    markEnrollTokenUsed(d, tok);
    expect(peekEnrollToken(d, tok)).toBeUndefined();
  });

  it("profile default = 'default'", () => {
    const d = db();
    const u = addUser(d, "demo");
    const tok = createEnrollToken(d, u.id, "gmail");
    expect(peekEnrollToken(d, tok)?.profile).toBe("default");
  });

  it("token inexistente → undefined", () => {
    expect(peekEnrollToken(db(), "no-existe")).toBeUndefined();
  });
});

describe("web-login tokens", () => {
  it("peek devuelve userId; markUsed lo invalida", () => {
    const d = db();
    const u = addUser(d, "demo");
    const tok = createWebLoginToken(d, u.id);
    expect(peekWebLoginToken(d, tok)).toBe(u.id);
    markWebLoginTokenUsed(d, tok);
    expect(peekWebLoginToken(d, tok)).toBeUndefined();
  });
});

describe("tokens HMAC de identidad (signUserToken, con exp)", () => {
  const HOUR = 60 * 60 * 1000;

  it("round-trip: verify devuelve el userId", () => {
    expect(verifyUserToken(signUserToken(7, "k"), "k")).toBe(7);
  });
  it("key incorrecta → undefined", () => {
    expect(verifyUserToken(signUserToken(7, "k"), "otra")).toBeUndefined();
  });
  it("token corrupto / formato inválido → undefined", () => {
    expect(verifyUserToken("7.malo", "k")).toBeUndefined(); // 2 partes (formato viejo)
    expect(verifyUserToken("basura", "k")).toBeUndefined();
    expect(verifyUserToken("7.123.mac.extra", "k")).toBeUndefined(); // 4 partes
  });
  it("A2: token vencido → undefined", () => {
    const now = 1_000_000;
    const tok = signUserToken(7, "k", now, HOUR); // exp = now + 1h
    expect(verifyUserToken(tok, "k", now)).toBe(7); // antes del exp
    expect(verifyUserToken(tok, "k", now + 2 * HOUR)).toBeUndefined(); // ya venció
  });
  it("A2: no se puede extender el exp sin la key (MAC cubre userId.exp)", () => {
    const now = 1_000_000;
    const tok = signUserToken(7, "k", now, HOUR);
    const [uid, , mac] = tok.split(".");
    expect(verifyUserToken(`${uid}.${now + 100 * HOUR}.${mac}`, "k", now)).toBeUndefined();
  });
  it("domain separation: un token de sesión (sin prefijo `cap.`) no valida como capability", () => {
    const now = 1_000_000;
    const sess = signSessionToken(7, "k", now + HOUR); // firma `7.<exp>` (sin prefijo)
    expect(verifyUserToken(sess, "k", now)).toBeUndefined();
  });
});

describe("token de schedule (4 partes, lleva el canal de origen — feature crons-delivery)", () => {
  const HOUR = 60 * 60 * 1000;

  it("round-trip: verify devuelve {userId, channel}", () => {
    expect(verifyScheduleToken(signScheduleToken(7, "web", "k"), "k")).toEqual({
      userId: 7,
      channel: "web",
    });
  });
  it("preserva el canal exacto (telegram/whatsapp/web)", () => {
    for (const ch of ["telegram", "whatsapp", "web"]) {
      expect(verifyScheduleToken(signScheduleToken(7, ch, "k"), "k")?.channel).toBe(ch);
    }
  });
  it("key incorrecta → undefined", () => {
    expect(verifyScheduleToken(signScheduleToken(7, "web", "k"), "otra")).toBeUndefined();
  });
  it("token vencido → undefined", () => {
    const now = 1_000_000;
    const tok = signScheduleToken(7, "web", "k", now, HOUR);
    expect(verifyScheduleToken(tok, "k", now)).toEqual({ userId: 7, channel: "web" });
    expect(verifyScheduleToken(tok, "k", now + 2 * HOUR)).toBeUndefined();
  });
  it("no se puede manipular el canal sin la key (el MAC lo cubre)", () => {
    const tok = signScheduleToken(7, "web", "k");
    const [uid, , exp, mac] = tok.split(".");
    // Re-armar con otro canal y el MAC viejo → inválido.
    expect(verifyScheduleToken(`${uid}.telegram.${exp}.${mac}`, "k")).toBeUndefined();
  });
  it("compat: token VIEJO de 3 partes (signUserToken) → {userId} sin canal", () => {
    const legacy = signUserToken(7, "k"); // 3 partes, firma `cap.7.<exp>`
    expect(verifyScheduleToken(legacy, "k")).toEqual({ userId: 7 });
  });
  it("domain separation: un token de schedule no valida como capability genérico", () => {
    // El de schedule firma sobre `sched.…` (4 partes); verifyUserToken espera 3 partes → undefined.
    expect(verifyUserToken(signScheduleToken(7, "web", "k"), "k")).toBeUndefined();
  });
  it("basura / formato inválido → undefined", () => {
    expect(verifyScheduleToken("basura", "k")).toBeUndefined();
    expect(verifyScheduleToken("7.web.malo", "k")).toBeUndefined(); // 3 partes pero no es token cap
  });
});
