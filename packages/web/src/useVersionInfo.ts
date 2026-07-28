// Hook compartido para leer GET /api/version (SHA del deploy + entorno) una vez al montar.
//
// Antes cada consumidor (VersionBadge top-level, header del Explorer) duplicaba este mismo fetch.
// Lo centralizamos acá para que el badge del home (orbe), el del explorer, la línea de
// Configuración y el seteo del título compartan una única implementación. La respuesta NO cambia
// dentro de una sesión (el SHA del deploy es fijo), así que cada montaje hace su fetch sin
// coordinación extra; el endpoint es barato y sin auth.
//
// Graceful: queda null hasta que resuelva, y null para siempre si el endpoint no existe (prod
// viejo sin /api/version) o la red está caída → los consumidores no muestran nada / "no disponible".

import { useEffect, useState } from "react";
import type { VersionApiResponse } from "./version.ts";

/** Lee GET /api/version una vez al montar. null hasta que resuelva; graceful si el endpoint no existe. */
export function useVersionInfo(): VersionApiResponse | null {
  const [versionInfo, setVersionInfo] = useState<VersionApiResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/version")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: VersionApiResponse | null) => {
        if (!cancelled && data) setVersionInfo(data);
      })
      .catch(() => {
        /* sin versión: prod viejo sin el endpoint, o red caída */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return versionInfo;
}
