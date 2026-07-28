// Fix del “desfase al rotar la pantalla” en mobile (iOS Safari sobre todo): fondo Y contenido.
//
// Síntoma: al rotar (portrait↔landscape), iOS deja el LAYOUT VIEWPORT (el ICB) “pegado” al
// ancho de la orientación ANTERIOR. Todo lo que mide en flujo o con `100%`/`100vw` hereda ese
// ancho stale → el fondo no llega al borde derecho (banda) y `.app` (en flujo) queda del ancho
// viejo y centra su contenido en esa franja angosta (corrido a la izquierda).
//
// Lo que NO funciona (probado en device): tocar el `<meta viewport>` para forzar a iOS a
// recomputar el ICB —ni el “renudge” (togglear `device-width`) ni pinearlo a un `width=<px>`
// concreto—. Es inestable: encima, al re-aplicarse cuando Safari reajusta el viewport, ACHICA
// el ICB y corre el contenido a la izquierda SOLO (sin rotar). Por eso acá NO tocamos el meta.
//
// Lo que SÍ funciona: `visualViewport.width` SIEMPRE refleja el ancho visual real (no queda
// stale al rotar). Le damos ese ancho en px a dos elementos `position: fixed` —que NO los
// recorta `body{overflow:hidden}` y NO dependen del ICB—:
//   - `#app-bg`  → el fondo cubre hasta el borde derecho.
//   - `#root`    → el árbol de la app recupera el ancho real y `.app` re-centra su contenido.
// Solo tocamos el ANCHO; la altura la deja el CSS (forzar `visualViewport.height` dejaría hueco
// abajo cuando se oculta la barra dinámica de Safari).

export function installViewportRotateFix(): void {
  if (typeof window === "undefined") return;

  const bg = document.getElementById("app-bg");
  const root = document.getElementById("root");
  const vv = window.visualViewport;

  const apply = () => {
    const w = Math.ceil((vv ? vv.width : window.innerWidth) || 0);
    if (w <= 0) return;
    if (bg) bg.style.width = `${w}px`;
    if (root) root.style.width = `${w}px`;
  };

  // Tras rotar, el ancho real puede tardar algunos frames en asentarse → reintentamos a lo
  // largo de ~½s, además de reaccionar a cada evento de viewport.
  let timer = 0;
  const settle = () => {
    if (timer) clearTimeout(timer);
    let tries = 0;
    const tick = () => {
      apply();
      timer = tries++ < 5 ? window.setTimeout(tick, 100) : 0;
    };
    tick();
  };

  apply(); // ancho inicial correcto en el primer paint

  vv?.addEventListener("resize", apply);
  window.addEventListener("resize", apply);
  window.addEventListener("orientationchange", settle);
}
