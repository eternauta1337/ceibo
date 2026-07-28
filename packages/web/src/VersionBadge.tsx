// Título de la pestaña del navegador según el entorno (`[dev]`/`[staging]` antes de "Ceibo").
//
// Antes el `document.title = pageTitle(env)` vivía dentro del Explorer, que sólo monta al abrir
// el explorer → el prefijo `[dev]`/`[staging]` en el título de la pestaña del navegador aparecía
// recién al abrir el menú. Este componente es top-level y montado SIEMPRE (desde el load), así
// el título refleja el entorno apenas resuelve /api/version.
//
// Es HEADLESS: no renderiza nada en pantalla. El owner no quiere un badge dentro de la web; el
// badge visible del header del explorer (.exp-version) sigue donde estaba. Acá sólo hacemos el
// fetch a /api/version y seteamos document.title.

import { useEffect } from "react";
import { useVersionInfo } from "./useVersionInfo.ts";
import { pageTitle } from "./version.ts";

/**
 * Componente headless: hace el fetch a /api/version y fija el título de la pestaña del navegador
 * según el entorno. No renderiza nada (retorna null).
 *
 * prod → "Ceibo" (sin prefijo); dev/staging → "[dev] Ceibo" / "[staging] Ceibo".
 */
export function VersionBadge() {
  const versionInfo = useVersionInfo();

  // Título de la tab: refleja el entorno cuando /api/version resuelve.
  // Graceful: si el fetch falla, versionInfo queda null y el título no se toca.
  useEffect(() => {
    if (versionInfo) document.title = pageTitle(versionInfo.env);
  }, [versionInfo]);

  return null;
}
