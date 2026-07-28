import { describe, expect, it } from "vitest";
import { SWIPE_UP_PX, shouldEnterHandsfree } from "./gestureSwipeUp";

describe("shouldEnterHandsfree", () => {
  it("devuelve false si no hubo movimiento", () => {
    expect(shouldEnterHandsfree(300, 300)).toBe(false);
  });

  it("devuelve false si el dedo bajó (swipe-down)", () => {
    expect(shouldEnterHandsfree(300, 400)).toBe(false);
  });

  it("devuelve false si sube pero menos que el umbral", () => {
    expect(shouldEnterHandsfree(300, 300 - SWIPE_UP_PX + 1)).toBe(false);
  });

  it("devuelve true exactamente al umbral", () => {
    expect(shouldEnterHandsfree(300, 300 - SWIPE_UP_PX)).toBe(true);
  });

  it("devuelve true si supera el umbral", () => {
    expect(shouldEnterHandsfree(300, 300 - SWIPE_UP_PX - 20)).toBe(true);
  });

  it("respeta un umbral personalizado", () => {
    expect(shouldEnterHandsfree(200, 170, 30)).toBe(true);
    expect(shouldEnterHandsfree(200, 171, 30)).toBe(false);
  });
});
