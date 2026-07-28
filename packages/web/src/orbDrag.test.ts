import { describe, expect, it } from "vitest";
import { clampDragDy, ORB_DRAG_MAX_PX } from "./orbDrag";

describe("clampDragDy", () => {
  it("devuelve 0 si el dedo no se movió", () => {
    expect(clampDragDy(300, 300)).toBe(0);
  });

  it("devuelve 0 si el dedo bajó (swipe-down)", () => {
    expect(clampDragDy(300, 350)).toBe(0);
  });

  it("devuelve el delta negativo si el dedo subió menos que el máximo", () => {
    expect(clampDragDy(300, 250)).toBe(-50);
  });

  it("clampea al máximo si el dedo subió más de lo permitido", () => {
    expect(clampDragDy(300, 0)).toBe(-ORB_DRAG_MAX_PX);
  });

  it("devuelve exactamente -max cuando el delta iguala el máximo", () => {
    expect(clampDragDy(200, 200 - ORB_DRAG_MAX_PX)).toBe(-ORB_DRAG_MAX_PX);
  });

  it("respeta un max personalizado", () => {
    expect(clampDragDy(200, 170, 50)).toBe(-30);
    expect(clampDragDy(200, 100, 50)).toBe(-50);
  });
});
