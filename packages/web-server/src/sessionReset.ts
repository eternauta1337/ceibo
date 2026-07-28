// Plano de control F3: web-server → gateway, reset de sesión MA.
//
// Cuando el web-server cambia la membresía de un usuario (archivar / irse / borrar /
// quitar miembro), la sesión MA viva del gateway sigue teniendo la working copy de esa
// wiki hasta que se recrea. Este módulo emite un frame de control `reset-session` por el
// canal remoto para que el gateway recree la sesión del/los usuarios afectados.
//
// Contrato:
//   - Best-effort: si el gateway está caído / no hay conexión activa, se loguea y se
//     continúa. La próxima sesión del usuario leerá el estado nuevo de la DB igual.
//   - Idempotente: resetear dos veces es inocuo (recrea una sesión limpia). Sin ack.
//   - Fire-and-forget: no awaiteamos respuesta.

import type { RemoteClient } from "@ceibo/channels";

/**
 * Emite un frame `reset-session` al gateway por cada userId de `userIds`.
 * `client` es el cliente del canal remoto (puede ser undefined si el gateway está caído).
 *
 * Firma estable para que los call-sites de F2 no cambien si llegan antes que F3 se mergee:
 * si `client` no se pasó o es undefined, es no-op logueado.
 */
export function requestSessionReset(
  userIds: number[],
  client: RemoteClient | undefined,
  log?: (s: string) => void,
): void {
  if (!userIds.length) return;
  if (!client) {
    (log ?? console.log)(
      `[session-reset] gateway no conectado — reset diferido para users [${userIds.join(", ")}] (se aplicará en la próxima sesión)`,
    );
    return;
  }
  for (const userId of userIds) {
    try {
      client.sendControl("reset-session", userId);
      (log ?? console.log)(`[session-reset] reset-session enviado → user=${userId}`);
    } catch (e) {
      (log ?? console.log)(
        `[session-reset] error enviando reset para user=${userId}: ${(e as Error)?.message ?? e}`,
      );
    }
  }
}
