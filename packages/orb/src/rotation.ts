// Helpers PUROS de rotación (sin WebGL/DOM) → testeables en node. `core.ts` les inyecta
// `Math.random`; los tests inyectan un rng determinista. La idea (pedido del owner): en cada
// cambio de estado/forma el orbe gira RÁPIDO hacia una posición angular random, y entre cambios
// deriva LENTO; ambos pueden ir en sentido horario o anti-horario, elegido al azar por transición.

/** Sentido de giro: anti-horario (+1) u horario (-1), al azar. Consume UN draw del rng. */
export function pickDirection(rng: () => number): 1 | -1 {
  return rng() < 0.5 ? -1 : 1;
}

/** Paso de rotación rápido hacia una posición random, disparado en un cambio de estado/forma.
 *  Magnitud = `base` + random·`spread` (ambos ≥0, en rad); signo random (horario/anti-horario).
 *  Devuelve un DELTA CON SIGNO que se SUMA al ángulo acumulado: así el camino tomado respeta el
 *  signo elegido (gira por donde dice el signo, no por "el lado más corto"; el ángulo no se
 *  envuelve). `base`/`spread` salen de la config por estado (`rot` / `rotRand`). Consume 2 draws.
 *
 *  base/spread negativos se clampean a 0 (un step nunca debe invertir su propio signo). */
export function pickRotationStep(rng: () => number, base: number, spread: number): number {
  const dir = pickDirection(rng);
  const mag = Math.max(0, base) + rng() * Math.max(0, spread);
  return dir * mag;
}
