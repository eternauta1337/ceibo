// Traducción pura ServerFrame (del gateway, por el canal remoto) → mensaje SSE del cliente.
// El entry-point (`index.ts` `onFrame`) resuelve user/origin y empuja el resultado con
// `pushToUser`; acá va SÓLO el mapeo frame→payload, aislado para poder testearlo sin levantar
// el server. Cada `case` que falte = un frame que muere en el web-server y nunca llega al
// browser (regresión histórica: el frame `subagents` quedó sin reenviar → los mini-orbs nunca
// aparecían). `undefined` = frame sin payload de cliente (ej. auth-ok/auth-err: ruido de canal).

import type { ServerFrame } from "@ceibo/channels";

/** Payload que viaja al browser por SSE (shape libre; `pushToUser` lo acepta como `unknown`). */
export type ClientMsg = Record<string, unknown>;

/** Mapea un ServerFrame al mensaje SSE del cliente, o `undefined` si el frame no se reenvía. */
export function serverFrameToClient(f: ServerFrame): ClientMsg | undefined {
  switch (f.t) {
    case "out":
      return { t: "text", text: f.text };
    case "typing":
      return { t: "typing" };
    case "heard":
      return { t: "heard", text: f.text };
    case "voice":
      return { t: "voice", mime: f.mime, data: f.bytes, text: f.text };
    case "viewer":
      return { t: "open", repo: f.repo, path: f.path };
    case "created":
      return { t: "created", repo: f.repo, path: f.path, sha: f.sha };
    case "activity":
      // `label` (amable) + `detail` (params) ya vienen humanizados server-side. `kind:"subagent"`
      // (si viene) enciende el indicador dedicado/persistente en la web.
      return { t: "activity", label: f.label, detail: f.detail, ...(f.kind ? { kind: f.kind } : {}) };
    case "chat-title":
      return { t: "chat-title", title: f.title };
    case "subagents":
      // Conteo de sub-agentes vivos AHORA (#234): la web decora el orb con N mini-orbs.
      return { t: "subagents", count: f.count };
    case "turn-done":
      return { t: "turn-done" };
    case "notice":
      // Aviso de sistema (compactada / reiniciada): la web lo pinta como una línea de sistema
      // atenuada, distinta de una burbuja de usuario/agente.
      return { t: "notice", text: f.text };
    case "inbox":
      // Item nuevo en el inbox (feature crons-delivery): push en vivo del conteo de no-leídos → la
      // web sube el badge del FAB 🔔 al instante. La burbuja se baja por click (GET /api/inbox).
      return { t: "inbox", count: f.count };
    case "error":
      return { t: "error", error: f.error };
    default:
      // auth-ok / auth-err y cualquier frame futuro sin payload de cliente.
      return undefined;
  }
}
