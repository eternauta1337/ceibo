// Lógica PURA de listas markdown para el atomic editor (sin imports de CodeMirror,
// testeable con Vitest): parseo de items, detección de bloques de lista, indent/outdent
// por niveles discretos y renumeración POR NIVEL de listas ordenadas.
//
// Por qué existe: el editor traía `indentWithTab` genérico (indentMore/indentLess, unidad
// fija de 2 espacios) que es ciego a listas. Para bullets (`- ` = contenido en col 2) dos
// espacios anidan "de casualidad", pero para ordenadas (`1. ` = contenido en col 3) dos
// espacios dejan el item como HERMANO de la misma lista (CommonMark exige indentar hasta
// la columna de contenido del padre) → la numeración seguía la secuencia global (1,2,3,4
// con offsets raros) en vez de renumerar por nivel. Y nada renumeraba nunca.
//
// Modelo: niveles discretos. Indentar un item lo alinea a la columna de CONTENIDO de su
// hermano anterior (se vuelve su hijo) y arrastra su subtree (descendientes + líneas de
// continuación). Desindentar lo alinea a la columna del padre. La renumeración asigna
// secuencias por nivel: el primer item de una corrida conserva su número en el nivel 0
// (CommonMark respeta el arranque de la lista) y arranca en 1 en niveles anidados.

export type ListItemParse = {
  /** whitespace crudo al inicio de la línea */
  indent: string;
  /** columna visual del marker (tab = 4 columnas, regla CommonMark) */
  col: number;
  ordered: boolean;
  number: number | null;
  /** "-" | "*" | "+" | "<n>." | "<n>)" */
  marker: string;
  /** "[ ]" / "[x]" si es un todo (el estado viaja con el texto, nunca lo tocamos) */
  task: string | null;
  /** columna visual donde empieza el contenido (tras marker + espacio; el task ES contenido) */
  contentCol: number;
  /** offsets (en chars de la línea) de los dígitos del número, para reemplazo quirúrgico */
  numFrom: number;
  numTo: number;
};

/** Edición quirúrgica dentro de una línea: reemplazar [from, to) por `insert`. */
export type LineEdit = { line: number; from: number; to: number; insert: string };

export type BlockItem = {
  line: number;
  p: ListItemParse;
  /** profundidad 0-based asignada por la pila de columnas (ver analyzeBlock) */
  level: number;
  /** última línea (inclusive) del subtree: descendientes + continuaciones */
  subtreeEnd: number;
};

export type ListBlock = { start: number; end: number; items: BlockItem[] };

/** Ancho visual de un prefijo de línea, expandiendo tabs a tab-stops de 4 (CommonMark). */
function colWidth(s: string, to = s.length): number {
  let col = 0;
  for (let i = 0; i < to; i++) col += s[i] === "\t" ? 4 - (col % 4) : 1;
  return col;
}

const ITEM_RE = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+|$)/;
const TASK_RE = /^(\[[ xX]\])(?:[ \t]|$)/;
const FENCE_RE = /^[ \t]*(```|~~~)/;
const BLANK_RE = /^[ \t]*$/;
// Líneas que NO son continuación lazy de un item (cortan el párrafo en CommonMark).
const INTERRUPT_RE = /^(#{1,6}[ \t]|>|---\s*$|\*\*\*\s*$|___\s*$)/;

/** Parsea una línea como item de lista (bullet / ordenada / todo). null si no lo es. */
export function parseItem(line: string): ListItemParse | null {
  const m = ITEM_RE.exec(line);
  if (!m) return null;
  const [, indent = "", marker = "", space = ""] = m;
  const rest = line.slice(indent.length + marker.length + space.length);
  const task = TASK_RE.exec(rest)?.[1] ?? null;
  const col = colWidth(indent);
  const markerW = marker.length; // markers no llevan tabs
  // Columna de contenido: marker + 1..4 espacios; con >4 (o item vacío) CommonMark cuenta 1.
  const spaceW = colWidth(line, indent.length + marker.length + space.length) - col - markerW;
  const contentCol = col + markerW + (space === "" || spaceW > 4 ? 1 : spaceW);
  const ordered = /\d/.test(marker[0] ?? "");
  const digits = ordered ? marker.slice(0, -1) : "";
  return {
    indent,
    col,
    ordered,
    number: ordered ? Number(digits) : null,
    marker,
    task,
    contentCol,
    numFrom: ordered ? indent.length : -1,
    numTo: ordered ? indent.length + digits.length : -1,
  };
}

/** Detecta los bloques de lista del documento (corridas contiguas de items + sus
 *  continuaciones, tolerando líneas en blanco internas y salteando fenced code). */
export function scanBlocks(lines: string[]): ListBlock[] {
  const blocks: ListBlock[] = [];
  let cur: ListBlock | null = null;
  let inFence = false;
  let blankPending = false;

  const close = () => {
    if (cur?.items.length) blocks.push(cur);
    cur = null;
    blankPending = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (inFence) {
      // dentro de un fence nada es item; si el fence vive dentro del bloque lo extiende
      if (cur && !blankPending) cur.end = i;
      if (FENCE_RE.test(line)) inFence = false;
      continue;
    }
    if (BLANK_RE.test(line)) {
      if (cur) blankPending = true;
      continue;
    }
    const p = parseItem(line);
    if (p) {
      if (!cur) cur = { start: i, end: i, items: [] };
      cur.items.push({ line: i, p, level: 0, subtreeEnd: i });
      cur.end = i;
      blankPending = false;
      continue;
    }
    // No-item: ¿continuación del bloque abierto?
    const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
    const c = colWidth(indent);
    const lazy = cur && !blankPending && !INTERRUPT_RE.test(line.slice(indent.length));
    const indented = cur && c >= 2; // contenido indentado (vale aún tras blancos)
    if (cur && (lazy || indented)) {
      if (FENCE_RE.test(line)) inFence = true;
      cur.end = i;
      blankPending = false;
      continue;
    }
    close();
    if (FENCE_RE.test(line)) inFence = true;
  }
  close();
  return blocks;
}

/** Asigna niveles (pila de columnas estilo CommonMark: hijo si col >= contentCol del tope,
 *  hermano si cae sobre el marker del tope) y calcula el subtree de cada item. Muta y
 *  devuelve los items del bloque. */
export function analyzeBlock(block: ListBlock): BlockItem[] {
  const stack: { col: number; contentCol: number }[] = [];
  for (const item of block.items) {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (!top) break;
      if (item.p.col >= top.contentCol) break; // hijo del tope
      stack.pop();
      if (item.p.col >= top.col) break; // hermano del tope (lo reemplaza)
    }
    item.level = stack.length;
    stack.push({ col: item.p.col, contentCol: item.p.contentCol });
  }
  // subtree: hasta el próximo item con nivel <= propio (exclusive), o el fin del bloque
  for (let i = 0; i < block.items.length; i++) {
    const item = block.items[i];
    if (!item) continue;
    item.subtreeEnd = block.end;
    for (let j = i + 1; j < block.items.length; j++) {
      const next = block.items[j];
      if (next && next.level <= item.level) {
        item.subtreeEnd = next.line - 1;
        break;
      }
    }
  }
  return block.items;
}

/** Renumeración canónica POR NIVEL de un bloque: cada corrida de hermanos ordenados es
 *  secuencial; un bullet en el medio corta la corrida (CommonMark: lista nueva). El primer
 *  item de una corrida de nivel 0 conserva su número (arranque deliberado); las corridas
 *  anidadas arrancan en 1. Devuelve solo los reemplazos de dígitos necesarios. */
export function renumberEdits(block: ListBlock): LineEdit[] {
  const items = analyzeBlock(block);
  const counters: (number | null | undefined)[] = []; // por nivel; null = corrida cortada (bullet)
  const edits: LineEdit[] = [];
  for (const item of items) {
    counters.length = item.level + 1; // volver a un nivel mata los counters más profundos
    if (!item.p.ordered) {
      counters[item.level] = null;
      continue;
    }
    const c = counters[item.level];
    const want = c == null ? (item.level === 0 ? (item.p.number ?? 1) : 1) : c + 1;
    counters[item.level] = want;
    if (want !== item.p.number) {
      edits.push({ line: item.line, from: item.p.numFrom, to: item.p.numTo, insert: String(want) });
    }
  }
  return edits;
}

/** Renumera todos los bloques que toquen alguna de las líneas dadas (con ±1 de margen,
 *  para agarrar merges/splits en los bordes). */
export function renumberTouching(lines: string[], touched: Iterable<number>): LineEdit[] {
  const touchedSet = new Set(touched);
  const edits: LineEdit[] = [];
  for (const block of scanBlocks(lines)) {
    let hit = false;
    for (const t of touchedSet) {
      if (t >= block.start - 1 && t <= block.end + 1) {
        hit = true;
        break;
      }
    }
    if (hit) edits.push(...renumberEdits(block));
  }
  return edits;
}

/** Mueve el item de lista en `lineNo` (con su subtree completo) hacia arriba ("up") o
 *  hacia abajo ("down"), intercambiándolo con su hermano ANTERIOR/SIGUIENTE del MISMO nivel.
 *  Reglas:
 *  - Si `lineNo` no es el marker de un item de lista → null.
 *  - Si no hay hermano en esa dirección (primer/último del nivel) → null (no-op).
 *  - El intercambio es de rangos de líneas completos (item + subtree de cada uno).
 *    Los subtrees de dos hermanos adyacentes son CONTIGUOS (subtreeEnd del top == botStart-1),
 *    pero puede haber líneas en blanco o de continuación entre ellos en el doc; el rango
 *    [topStart..botEnd] cubre todo y se reordena como [botLines, topLines].
 *  - La renumeración NO se hace aquí: la delega al autoRenumberFilter del glue CM6.
 *  Devuelve los LineEdits necesarios para el intercambio, o null si no aplica. */
export function moveItemEdits(lines: string[], lineNo: number, dir: "up" | "down"): LineEdit[] | null {
  return moveItem(lines, lineNo, dir)?.edits ?? null;
}

/** Como moveItemEdits, pero además devuelve `newLine`: la línea (0-based) donde queda el
 *  MARKER del item movido tras aplicar los edits. El glue CM6 la usa para que el cursor
 *  siga al item (mapear la selección por el changeset NO sirve: los edits son reemplazos
 *  por línea y el cursor quedaría clavado en su línea original — Alt+↑ repetido rebotaría
 *  los dos items en vez de seguir subiendo el mismo). */
export function moveItem(
  lines: string[],
  lineNo: number,
  dir: "up" | "down",
): { edits: LineEdit[]; newLine: number } | null {
  const blocks = scanBlocks(lines);
  for (const block of blocks) {
    if (lineNo < block.start || lineNo > block.end) continue;
    const items = analyzeBlock(block);
    // Encontrar el item cuyo marker está en lineNo
    const idx = items.findIndex((it) => it.line === lineNo);
    if (idx === -1) return null;
    const item = items[idx];
    if (!item) return null;

    // Buscar el hermano en la dirección indicada (mismo level, sin pasar por un ancestro)
    let sibIdx = -1;
    if (dir === "up") {
      for (let j = idx - 1; j >= 0; j--) {
        const prev = items[j];
        if (!prev) continue;
        if (prev.level < item.level) break; // pasamos por ancestro → sin hermano
        if (prev.level === item.level) {
          sibIdx = j;
          break;
        }
      }
    } else {
      for (let j = idx + 1; j < items.length; j++) {
        const next = items[j];
        if (!next) continue;
        if (next.level < item.level) break; // pasamos por ancestro
        if (next.level === item.level) {
          sibIdx = j;
          break;
        }
      }
    }
    if (sibIdx === -1) return null; // sin hermano en esa dirección

    const sib = items[sibIdx];
    if (!sib) return null;

    // Determinar cuál es el grupo "superior" (topIdx) y cuál el "inferior" (botIdx)
    const [topIdx, botIdx] = dir === "up" ? [sibIdx, idx] : [idx, sibIdx];
    const topItem = items[topIdx];
    const botItem = items[botIdx];
    if (!topItem || !botItem) return null;

    const topStart = topItem.line;
    const topEnd = topItem.subtreeEnd; // inclusive
    const botStart = botItem.line;
    const botEnd = botItem.subtreeEnd; // inclusive

    // Extraer los dos grupos de líneas
    const topLines = lines.slice(topStart, topEnd + 1);
    const botLines = lines.slice(botStart, botEnd + 1);

    // El rango completo [topStart..botEnd] se reemplaza con [botLines, líneas intermedias, topLines].
    // Las "líneas intermedias" son topEnd+1..botStart-1 (blancos / continuaciones entre hermanos).
    const midLines = lines.slice(topEnd + 1, botStart);
    const reordered = [...botLines, ...midLines, ...topLines];

    // Un edit por línea del rango completo
    const edits: LineEdit[] = [];
    for (let i = topStart; i <= botEnd; i++) {
      const newText = reordered[i - topStart];
      const origLine = lines[i] ?? "";
      // Solo emitir edit si el texto cambia (optimización: evita no-ops)
      if (newText !== undefined && newText !== origLine) {
        edits.push({ line: i, from: 0, to: origLine.length, insert: newText });
      }
    }

    // Nueva línea del marker del item movido: subiendo (item = bot) queda en topStart;
    // bajando (item = top) queda corrido por el largo de [botLines + midLines] = botEnd - topEnd.
    const newLine = dir === "up" ? topStart : lineNo + (botEnd - topEnd);
    return { edits, newLine };
  }
  return null; // lineNo no cayó en ningún bloque de lista
}

// ── Drag & drop (v2 del reordenamiento) ───────────────────────────────────────
//
// Modelo de drop por GAPS: un gap es "antes de la línea-marker de un item" o "después
// del fin del bloque" (line = block.end + 1). Reglas v2 (deliberadamente simples):
//
//   - Solo gaps del MISMO bloque de lista del item arrastrado.
//   - PROHIBIDO soltar dentro del propio subtree (un item no puede caer adentro de sí).
//   - Los gaps pegados al propio item (justo antes de su marker, o justo después de su
//     subtree) son NO-OP: soltar ahí no mueve ni re-indenta nada (= cancelar).
//   - Nivel destino = el del item de ARRIBA del gap (excluyendo el subtree arrastrado;
//     CommonMark: el item soltado queda como hermano inmediato del de arriba). Si el gap
//     no tiene item arriba (tope del bloque), el del item de abajo. Consecuencia
//     documentada: soltar entre un padre y su primer hijo cae al nivel del PADRE, y los
//     hijos que siguen al gap pasan a colgar del item soltado.
//   - La renumeración NO se hace acá (la delega al autoRenumberFilter, igual que v1).

export type DropTarget = {
  /** línea (0-based) ANTES de la cual se insertaría el subtree; block.end+1 = al final */
  line: number;
  /** nivel destino según la regla del gap */
  level: number;
  /** columna destino del marker (para re-indentar y para dibujar el indicador) */
  col: number;
  /** línea del item cuyo marker define la columna (ancla X del indicador visual) */
  refLine: number;
  /** gap pegado al propio item: soltar acá es cancelar */
  noop: boolean;
};

export type DragModel = { fromLine: number; subtreeEnd: number; targets: DropTarget[] };

/** Targets de drop válidos para arrastrar el item cuyo marker está en `fromLine`.
 *  null si la línea no es el marker de un item de lista. La lista puede contener solo
 *  noops (bloque de un solo item): el glue decide si vale la pena iniciar el drag. */
export function dragTargets(lines: string[], fromLine: number): DragModel | null {
  const block = scanBlocks(lines).find((b) => fromLine >= b.start && fromLine <= b.end);
  if (!block) return null;
  const items = analyzeBlock(block);
  const item = items.find((it) => it.line === fromLine);
  if (!item) return null;
  const inSub = (it: BlockItem) => it.line >= item.line && it.line <= item.subtreeEnd;

  const targets: DropTarget[] = [];
  let ref: BlockItem | null = null; // último item NO arrastrado por encima del gap
  const gapLines = [...items.map((it) => it.line), block.end + 1];
  for (const L of gapLines) {
    for (const it of items) {
      if (!inSub(it) && it.line < L && (!ref || it.line > ref.line)) ref = it;
    }
    if (L > item.line && L <= item.subtreeEnd) continue; // dentro del propio subtree
    if (L === item.line || L === item.subtreeEnd + 1) {
      targets.push({ line: L, level: item.level, col: item.p.col, refLine: item.line, noop: true });
      continue;
    }
    const anchor = ref ?? items.find((it) => !inSub(it) && it.line >= L) ?? null;
    if (!anchor) continue; // bloque de un solo item: no hay gaps reales
    targets.push({ line: L, level: anchor.level, col: anchor.p.col, refLine: anchor.line, noop: false });
  }
  return { fromLine, subtreeEnd: item.subtreeEnd, targets };
}

/** Columna que corresponde a `level` en el gap cuyo item de arriba es items[refIdx]
 *  (excluyendo el subtree arrastrado). null si el nivel no es alcanzable en ese gap:
 *  como hijo directo del de arriba (ref.level+1 → contentCol), como hermano suyo
 *  (ref.level → su col) o de alguno de sus ancestros (subiendo la cadena). */
function colForLevel(
  items: BlockItem[],
  refIdx: number,
  inSub: (it: BlockItem) => boolean,
  level: number,
): number | null {
  const ref = items[refIdx];
  if (!ref) return null;
  if (level === ref.level + 1) return ref.p.contentCol;
  if (level > ref.level + 1) return null;
  // ancestro (o hermano previo) más cercano en `level`: caminar hacia atrás bajando niveles
  let ceiling = ref.level;
  for (let j = refIdx; j >= 0; j--) {
    const it = items[j];
    if (!it || inSub(it)) continue;
    if (it.level <= ceiling) {
      if (it.level === level) return it.p.col;
      ceiling = it.level;
    }
  }
  return null;
}

/** Como moveItemToEdits, pero además devuelve `newLine`: la línea (0-based) donde queda
 *  el marker del item tras aplicar los edits (para que el cursor lo siga, igual que v1). */
export function moveItemTo(
  lines: string[],
  fromLine: number,
  targetLine: number,
  targetLevel?: number,
): { edits: LineEdit[]; newLine: number } | null {
  const block = scanBlocks(lines).find((b) => fromLine >= b.start && fromLine <= b.end);
  if (!block) return null;
  const items = analyzeBlock(block);
  const idx = items.findIndex((it) => it.line === fromLine);
  if (idx === -1) return null;
  const item = items[idx];
  if (!item) return null;

  // El target tiene que ser un gap del MISMO bloque…
  if (targetLine !== block.end + 1 && !items.some((it) => it.line === targetLine)) return null;
  // …y NUNCA dentro del propio subtree.
  if (targetLine > item.line && targetLine <= item.subtreeEnd) return null;

  const inSub = (it: BlockItem) => it.line >= item.line && it.line <= item.subtreeEnd;
  const noop = targetLine === item.line || targetLine === item.subtreeEnd + 1;

  // ── nivel/columna destino (regla documentada arriba) ──
  let refIdx = -1;
  for (let j = 0; j < items.length; j++) {
    const it = items[j];
    if (!it || inSub(it)) continue;
    if (it.line < targetLine) refIdx = j;
    else break;
  }
  let col: number;
  if (targetLevel === undefined) {
    if (noop) col = item.p.col;
    else if (refIdx >= 0) col = items[refIdx]?.p.col ?? item.p.col;
    else {
      const below = items.find((it) => !inSub(it));
      if (!below) return null; // bloque de un solo item: no hay adónde moverlo
      col = below.p.col;
    }
  } else if (refIdx >= 0) {
    const resolved = colForLevel(items, refIdx, inSub, targetLevel);
    if (resolved === null) return null;
    col = resolved;
  } else {
    // gap al tope del bloque: solo el nivel del primer item restante (nivel 0)
    const below = items.find((it) => !inSub(it));
    if (!below || targetLevel !== below.level) return null;
    col = below.p.col;
  }

  // ── re-indentar el subtree al destino (misma mecánica que indentListEdits) ──
  const subtree = lines.slice(item.line, item.subtreeEnd + 1);
  const delta = col - item.p.col;
  const moved =
    delta === 0
      ? subtree
      : subtree.map((text, k) => {
          if (k === 0) return " ".repeat(col) + text.slice(item.p.indent.length);
          if (BLANK_RE.test(text)) return text;
          const ind = /^[ \t]*/.exec(text)?.[0] ?? "";
          return " ".repeat(Math.max(0, colWidth(ind) + delta)) + text.slice(ind.length);
        });

  // ── reordenar líneas dentro del rango afectado (el total de líneas no cambia) ──
  let rangeStart: number;
  let reordered: string[];
  let newLine: number;
  if (targetLine <= item.line) {
    rangeStart = targetLine;
    reordered = [...moved, ...lines.slice(targetLine, item.line)];
    newLine = targetLine;
  } else {
    rangeStart = item.line;
    reordered = [...lines.slice(item.subtreeEnd + 1, targetLine), ...moved];
    newLine = targetLine - subtree.length;
  }
  const edits: LineEdit[] = [];
  for (let i = 0; i < reordered.length; i++) {
    const ln = rangeStart + i;
    const orig = lines[ln] ?? "";
    const text = reordered[i];
    if (text !== undefined && text !== orig) edits.push({ line: ln, from: 0, to: orig.length, insert: text });
  }
  return { edits, newLine };
}

/** Mueve el item de `fromLine` (con su subtree) al gap `targetLine` del mismo bloque,
 *  re-indentándolo al nivel del gap (o a `targetLevel` si se pasa explícito). null si no
 *  aplica (no es item, gap inválido, dentro del propio subtree, nivel inalcanzable);
 *  [] si el drop es un no-op (gap pegado al propio item, sin cambio de nivel). */
export function moveItemToEdits(
  lines: string[],
  fromLine: number,
  targetLine: number,
  targetLevel?: number,
): LineEdit[] | null {
  return moveItemTo(lines, fromLine, targetLine, targetLevel)?.edits ?? null;
}

/** Indenta (dir=1) o desindenta (dir=-1) los items de lista cuyas líneas-marker caen en
 *  [selFrom, selTo], arrastrando el subtree de cada uno. Reglas outliner estándar:
 *  - indentar alinea el item a la columna de contenido de su hermano anterior (se vuelve
 *    su hijo); sin hermano anterior (primer item del nivel) → no-op.
 *  - desindentar alinea a la columna del padre; en nivel 0 normaliza a columna 0.
 *  Devuelve null si NINGUNA línea seleccionada es un item (→ que Tab siga su curso
 *  default), o la lista de ediciones ([] = consumir la tecla sin cambios). */
export function indentListEdits(
  lines: string[],
  selFrom: number,
  selTo: number,
  dir: 1 | -1,
): LineEdit[] | null {
  const blocks = scanBlocks(lines);
  let sawItem = false;
  const edits: LineEdit[] = [];
  let processedUpto = -1;

  for (const block of blocks) {
    if (block.end < selFrom || block.start > selTo) continue;
    const items = analyzeBlock(block);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || item.line < selFrom || item.line > selTo) continue;
      sawItem = true;
      if (item.line <= processedUpto) continue; // ya arrastrado por un ancestro seleccionado

      let targetCol: number | null = null;
      if (dir === 1) {
        // hermano anterior en el mismo nivel → su columna de contenido
        for (let j = i - 1; j >= 0; j--) {
          const prev = items[j];
          if (!prev) continue;
          if (prev.level < item.level) break; // primer item de su nivel: no se puede indentar
          if (prev.level === item.level) {
            targetCol = prev.p.contentCol;
            break;
          }
        }
      } else if (item.level === 0) {
        targetCol = item.p.col > 0 ? 0 : null; // normalizar indent residual; ya en 0 → no-op
      } else {
        for (let j = i - 1; j >= 0; j--) {
          const prev = items[j];
          if (prev && prev.level === item.level - 1) {
            targetCol = prev.p.col;
            break;
          }
        }
      }
      if (targetCol === null || targetCol === item.p.col) continue;

      const delta = targetCol - item.p.col;
      edits.push({ line: item.line, from: 0, to: item.p.indent.length, insert: " ".repeat(targetCol) });
      // arrastrar el subtree (descendientes + continuaciones) con el mismo delta
      for (let ln = item.line + 1; ln <= item.subtreeEnd; ln++) {
        const text = lines[ln] ?? "";
        if (BLANK_RE.test(text)) continue;
        const ind = /^[ \t]*/.exec(text)?.[0] ?? "";
        const c = colWidth(ind);
        edits.push({ line: ln, from: 0, to: ind.length, insert: " ".repeat(Math.max(0, c + delta)) });
      }
      processedUpto = item.subtreeEnd;
    }
  }
  return sawItem ? edits : null;
}
