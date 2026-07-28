import { describe, expect, it } from "vitest";
import { buildSetCookie, clientIpFrom, isAllowedOrigin, parseCookie, safeEqual } from "./http.ts";

describe("isAllowedOrigin", () => {
  it("mismo host → true", () => {
    expect(isAllowedOrigin("ceibo.example.com", "https://ceibo.example.com/x")).toBe(true);
  });
  it("host distinto → false", () => {
    expect(isAllowedOrigin("ceibo.example.com", "https://evil.com")).toBe(false);
  });
  it("sin host o sin origin/referer → false", () => {
    expect(isAllowedOrigin(undefined, "https://x")).toBe(false);
    expect(isAllowedOrigin("h", undefined)).toBe(false);
  });
  it("origin no parseable → false", () => {
    expect(isAllowedOrigin("h", "no-es-url")).toBe(false);
  });
});

describe("clientIpFrom", () => {
  it("hops múltiples: devuelve el ÚLTIMO (el que apendeó nuestro proxy)", () => {
    // nginx apendea la IP real al final; el cliente controló todo lo anterior.
    expect(clientIpFrom("1.2.3.4, 5.6.7.8, 10.0.0.1", "127.0.0.1")).toBe("10.0.0.1");
  });
  it("hop spoofeado por el cliente + hop real apendeado por nginx", () => {
    // Aunque el cliente mande "evil-ip, evil-ip2", nginx apendea la verdadera al final.
    expect(clientIpFrom("evil-ip, evil-ip2, 203.0.113.5", "127.0.0.1")).toBe("203.0.113.5");
  });
  it("un solo hop en xff", () => {
    expect(clientIpFrom("1.2.3.4", "10.0.0.1")).toBe("1.2.3.4");
  });
  it("sin xff usa el remoteAddress", () => {
    expect(clientIpFrom(undefined, "10.0.0.1")).toBe("10.0.0.1");
  });
  it("sin nada → unknown", () => {
    expect(clientIpFrom(undefined, undefined)).toBe("unknown");
  });
});

describe("parseCookie", () => {
  it("encuentra la cookie por nombre", () => {
    expect(parseCookie("a=1; ceibo_session=tok; b=2", "ceibo_session")).toBe("tok");
  });
  it("ausente o header vacío → undefined", () => {
    expect(parseCookie("a=1", "x")).toBeUndefined();
    expect(parseCookie(undefined, "x")).toBeUndefined();
  });
});

describe("safeEqual", () => {
  it("igual → true; distinto o largo distinto → false", () => {
    expect(safeEqual("secret", "secret")).toBe(true);
    expect(safeEqual("secret", "secreto")).toBe(false);
    expect(safeEqual("a", "b")).toBe(false);
  });
});

describe("buildSetCookie", () => {
  it("setear: flags estándar + path + max-age", () => {
    expect(buildSetCookie("ceibo_session", "tok", { path: "/", maxAge: 2592000 })).toBe(
      "ceibo_session=tok; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000",
    );
  });
  it("borrar: value vacío + Max-Age=0", () => {
    expect(buildSetCookie("ceibo_session", "", { path: "/", maxAge: 0 })).toBe(
      "ceibo_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
    );
  });
});
