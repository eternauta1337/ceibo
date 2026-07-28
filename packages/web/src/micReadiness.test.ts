import { describe, expect, it } from "vitest";
import { isTrackCapturing, streamCapturing, streamHasLiveTrack, type TrackState } from "./micReadiness";

const live = (muted: boolean): TrackState => ({ readyState: "live", muted });
const ended: TrackState = { readyState: "ended", muted: false };

describe("isTrackCapturing (vivo NO alcanza: hay que estar des-muteado)", () => {
  it("vivo y des-muteado → captura de verdad", () => {
    expect(isTrackCapturing(live(false))).toBe(true);
  });

  it("vivo pero MUTEADO → NO captura (entra silencio hasta el unmute) → la ilusión de grabar", () => {
    expect(isTrackCapturing(live(true))).toBe(false);
  });

  it("track terminado → no captura", () => {
    expect(isTrackCapturing(ended)).toBe(false);
  });

  it("sin track (null/undefined) → no captura", () => {
    expect(isTrackCapturing(null)).toBe(false);
    expect(isTrackCapturing(undefined)).toBe(false);
  });
});

describe("streamCapturing (¿algún track listo para grabar?)", () => {
  it("vacío → false", () => {
    expect(streamCapturing([])).toBe(false);
  });

  it("solo tracks muteados → false (no marcar grabando: sería la ilusión)", () => {
    expect(streamCapturing([live(true), live(true)])).toBe(false);
  });

  it("al menos uno des-muteado → true", () => {
    expect(streamCapturing([live(true), live(false)])).toBe(true);
  });
});

describe("streamHasLiveTrack (reusable: vivo aunque muteado)", () => {
  it("track vivo muteado → reusable (esperás su unmute, no re-adquirís)", () => {
    expect(streamHasLiveTrack([live(true)])).toBe(true);
  });

  it("solo tracks terminados → hay que re-adquirir", () => {
    expect(streamHasLiveTrack([ended])).toBe(false);
  });

  it("vacío → false", () => {
    expect(streamHasLiveTrack([])).toBe(false);
  });
});
