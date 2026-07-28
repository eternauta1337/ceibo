// Carga la config tuneada (orb.config.json) — la fuente de verdad que el harness escribe y
// que la app consume directo. Tipada como OrbConfig.
import raw from "../orb.config.json";
import type { OrbConfig } from "./types.ts";

export const orbConfig = raw as unknown as OrbConfig;
