// Cómo renderizar un link dentro del markdown del chat (respuesta del agente). Pedido del owner:
// que un click en un link NUNCA navegue el SPA — "no se va ceibo". Por eso TODO link clickeable
// abre en otra pestaña del browser (`target=_blank` + `rel=noopener noreferrer`), incluyendo los
// internos (sin esquema): da igual a dónde apunten, no deben sacar la sesión viva de ceibo.
//
// Seguridad: el texto del agente es prompt-injectable. Reusamos `classifyLink` (linkScheme.ts,
// ya testeado) para NO renderizar como link clickeable un esquema peligroso
// (`javascript:`/`data:`/`vbscript:`/`file:` → `blocked`): esos caen a texto plano, sin href.
//
// Lógica pura (sin DOM/React) para testearla bajo el harness node del monorepo; el JSX que la
// consume vive en App.tsx (ChatBubble).

import { classifyLink } from "./linkScheme";

/** Decisión de render para un `<a>` del markdown del chat. */
export type ChatLinkRender =
  | { render: "link"; href: string; target: "_blank"; rel: "noopener noreferrer" }
  | { render: "text" };

/** Mapea el href de un link del chat a cómo renderizarlo:
 *  - sin href / `blocked` (esquema peligroso) → `text` (texto plano, sin href clickeable).
 *  - external (http(s)/mailto/tel/`//host`) o internal (path a nota) → `link` que abre en otra
 *    pestaña (`_blank`), así el click jamás navega el SPA. */
export function chatLinkRender(href: string | undefined | null): ChatLinkRender {
  if (!href) return { render: "text" };
  if (classifyLink(href) === "blocked") return { render: "text" };
  return { render: "link", href, target: "_blank", rel: "noopener noreferrer" };
}
