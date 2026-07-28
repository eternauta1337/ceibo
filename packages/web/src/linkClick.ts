// Hace clickeable TODO el link renderizado del editor (no solo el iconito ↗ que trae el atomic
// editor, que era lo único que disparaba `onLinkClick` → clickear el TEXTO no hacía nada).
//
// Sutileza estilo Obsidian que sale gratis: en la línea ACTIVA (cursor ahí) el link se muestra
// como markdown crudo `[texto](url)` SIN la clase `.cm-atomic-link` → ahí el click edita normal;
// en líneas inactivas el link está renderizado (con `.cm-atomic-link`) → el click navega.
//
// cmd/ctrl/middle-click: el link renderizado es un <span>, NO un <a href>, así que el browser no
// hace NADA por default con cmd-click (no hay href que abrir en pestaña). Por eso NO bailamos ante
// modifiers ni ante el botón central: los tratamos como "abrir" igual que el click normal
// (externo→pestaña nueva via window.open _blank, interno→navegar la nota; ver Editor.tsx). El
// click izquierdo dispara el evento `click`; el central dispara `auxclick` (en browsers modernos
// `click` NO se emite para el botón central) → escuchamos ambos.
import { syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";

/** Sub-set de un nodo de sintaxis (lezer) que necesitamos: rango + hijos URL. */
export interface LinkSyntaxNode {
  from: number;
  to: number;
  getChildren(type: string): { from: number; to: number }[];
}
/** Algo que sepa cortar texto del doc por offsets (`view.state.doc` lo cumple). */
export interface DocSlice {
  sliceString(from: number, to: number): string;
}

/** Saca la URL destino de un nodo Link del árbol de sintaxis (lógica pura, testeable sin DOM).
 *  El DESTINO es el ÚLTIMO hijo URL: `[texto](destino)`. Ojo con `[https://x](https://y)` — GFM
 *  autolinkea el label, así que el PRIMER hijo URL es el label, no el destino; `getChild`
 *  devolvía el primero → abría el link equivocado. Si no hay hijo URL, es un link estilo wiki
 *  (`[nota]` / `[[nota|alias]]`): el texto entre corchetes (sin alias) ES el destino interno. */
export function linkUrlFromNode(node: LinkSyntaxNode, doc: DocSlice): string | null {
  const urlNodes = node.getChildren("URL");
  const urlNode = urlNodes[urlNodes.length - 1];
  let url: string;
  if (urlNode) {
    url = doc.sliceString(urlNode.from, urlNode.to);
  } else {
    const raw = doc.sliceString(node.from, node.to);
    url = (raw.replace(/^\[+/, "").replace(/\]+$/, "").split("|")[0] ?? "").trim();
  }
  return url || null;
}

/** Resuelve la URL destino del link renderizado bajo `target`, o null si el target no cae en un
 *  link renderizado de este editor. Sube por el árbol hasta el nodo Link. */
function resolveLinkUrl(view: EditorView, target: EventTarget | null): string | null {
  const el = target as Element | null;
  const linkEl = el?.closest?.(".cm-atomic-link");
  if (!linkEl || !view.contentDOM.contains(linkEl)) return null;
  const pos = view.posAtDOM(linkEl);
  if (pos < 0) return null;
  let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(view.state).resolveInner(pos, 1);
  while (node && node.name !== "Link") node = node.parent;
  if (!node) return null;
  return linkUrlFromNode(node, view.state.doc);
}

/** Extensión CM6: click sobre un link renderizado → resuelve su URL del árbol de sintaxis y la
 *  pasa a `getHandler()` (externo→pestaña / interno→abrir la nota; ver Editor.tsx). `getHandler`
 *  es un getter (lee la versión viva del handler vía ref) para no recapturar el editor. */
export function linkClick(getHandler: () => ((url: string) => void) | undefined) {
  const open = (event: MouseEvent, view: EditorView): boolean => {
    const url = resolveLinkUrl(view, event.target);
    if (!url) return false;
    const handler = getHandler();
    if (!handler) return false;
    event.preventDefault();
    event.stopPropagation();
    handler(url);
    return true;
  };
  return EditorView.domEventHandlers({
    // Click izquierdo (con o sin cmd/ctrl/shift/alt) → abrir. No bailamos ante modifiers: el link
    // es un <span> sin href, así que el cmd-click no haría nada por default.
    click: (event, view) => {
      if (event.button !== 0) return false; // el central llega por `auxclick`, no por `click`
      return open(event, view);
    },
    // Click central: en browsers modernos dispara `auxclick`, no `click`.
    auxclick: (event, view) => {
      if (event.button !== 1) return false;
      return open(event, view);
    },
  });
}
