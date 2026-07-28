// Merge a 3 vías POR LÍNEAS para el rebase transparente del autosave (Fase B de "notas
// rock solid", síntomas (a)/(c) del análisis de conflictos): ante un 409 del PUT optimista,
// el editor trae lo del server (`theirs`), retiene lo último que él mismo guardó/adoptó
// (`base`) y mergea contra el buffer (`mine`). Sin solapamiento de líneas (el caso común:
// REM consolida una sección que no estás tocando) el merge es limpio y el save se rebasea
// solo; con solapamiento REAL devuelve conflicto y el editor muestra opciones.
//
// Implementación propia, chica y determinista (sin dependencia nueva): diff por LCS de
// líneas base↔mine y base↔theirs, y un sweep estilo diff3 que agrupa regiones cambiadas
// por coordenadas de base. Semántica de solapamiento tipo git:
//   - regiones que se PISAN en base → grupo único; si ambos lados lo cambiaron distinto
//     → conflicto (si lo cambiaron IGUAL, vale una sola copia).
//   - regiones adyacentes (tocan líneas de base distintas, aunque consecutivas) → mergean.
//   - dos INSERTS en el MISMO punto de base → conflicto (salvo inserts idénticos).
//
// Todo puro y testeable (merge3.test.ts). Las líneas conservan su `\n` (igualdad incluye
// el salto) → el merge re-arma el texto por concatenación directa, sin remendar newlines.

/** Región cambiada entre dos secuencias de líneas: [aS,aE) en la vieja ↔ [bS,bE) en la
 *  nueva. Un insert puro tiene aS === aE; un delete puro, bS === bE. */
export interface ChangedRegion {
  aS: number;
  aE: number;
  bS: number;
  bE: number;
}

// Tope de celdas de la tabla LCS (mismo criterio que externalChange.MAX_LCS_CELLS): por
// encima, UNA región con todo el medio. Para el merge eso degrada a "conflicto" si ambos
// lados tocaron el doc — conservador pero correcto. Notas reales no se acercan.
const MAX_LCS_CELLS = 250_000;

/** Líneas CON su `\n` terminador (la última puede no tenerlo). */
export function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      if (start < text.length) out.push(text.slice(start));
      return out;
    }
    out.push(text.slice(start, nl + 1));
    start = nl + 1;
  }
}

/** Regiones cambiadas entre dos arrays de líneas (LCS con prefijo/sufijo pelados y
 *  fallback a una región única si el medio excede el tope). Ordenadas, sin solaparse. */
export function changedRegions(a: string[], b: string[]): ChangedRegion[] {
  let pre = 0;
  const maxPre = Math.min(a.length, b.length);
  while (pre < maxPre && a[pre] === b[pre]) pre++;
  let suf = 0;
  const maxSuf = Math.min(a.length, b.length) - pre;
  while (suf < maxSuf && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const n = a.length - suf - pre;
  const m = b.length - suf - pre;
  if (n === 0 && m === 0) return [];
  if (n * m > MAX_LCS_CELLS) {
    return [{ aS: pre, aE: a.length - suf, bS: pre, bE: b.length - suf }];
  }

  const aMid = a.slice(pre, pre + n);
  const bMid = b.slice(pre, pre + m);
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        aMid[i] === bMid[j]
          ? (dp[(i + 1) * w + j + 1] as number) + 1
          : Math.max(dp[(i + 1) * w + j] as number, dp[i * w + j + 1] as number);
    }
  }
  const out: ChangedRegion[] = [];
  let i = 0;
  let j = 0;
  let ri = -1; // inicio de la región distinta en curso (-1 = no hay)
  let rj = -1;
  const flush = (endI: number, endJ: number) => {
    if (ri >= 0) {
      out.push({ aS: pre + ri, aE: pre + endI, bS: pre + rj, bE: pre + endJ });
      ri = -1;
      rj = -1;
    }
  };
  while (i < n || j < m) {
    if (i < n && j < m && aMid[i] === bMid[j]) {
      flush(i, j);
      i++;
      j++;
    } else if (j < m && (i === n || (dp[i * w + j + 1] as number) >= (dp[(i + 1) * w + j] as number))) {
      if (ri < 0) {
        ri = i;
        rj = j;
      }
      j++;
    } else {
      if (ri < 0) {
        ri = i;
        rj = j;
      }
      i++;
    }
  }
  flush(n, m);
  return out;
}

export type Merge3Result = { ok: true; merged: string } | { ok: false; conflicts: number }; // cantidad de grupos en conflicto (≥1)

/** Merge a 3 vías por líneas. `base` = lo último guardado/adoptado por este editor,
 *  `mine` = el buffer actual, `theirs` = lo que está en el server.
 *
 *  `resolve` (opcional) fuerza el ganador de los grupos EN CONFLICTO — es lo que usan los
 *  botones de la UI ("conservar lo mío" / "traer lo de afuera"): los cambios NO
 *  conflictivos del otro lado se conservan igual; solo las líneas pisadas se deciden.
 *  Con `resolve`, el resultado es siempre `ok: true`. */
export function merge3(
  base: string,
  mine: string,
  theirs: string,
  resolve?: "mine" | "theirs",
): Merge3Result {
  // Atajos exactos (cubren los casos degenerados sin pasar por el diff).
  if (mine === theirs) return { ok: true, merged: mine };
  if (base === mine) return { ok: true, merged: theirs };
  if (base === theirs) return { ok: true, merged: mine };

  const o = splitLines(base);
  const a = splitLines(mine);
  const b = splitLines(theirs);
  const ra = changedRegions(o, a);
  const rb = changedRegions(o, b);

  // Sweep: agrupar regiones por solapamiento en coordenadas de base. `touches` define la
  // semántica git-like: pisarse de verdad agrupa; tocarse en un borde NO (adyacente
  // mergea), salvo el caso de dos inserts en el MISMO punto (grupo vacío en base).
  const touches = (gS: number, gE: number, rS: number, rE: number): boolean =>
    rS < gE || (rS === gE && rS === rE && gS === gE);

  // Los segmentos de cada lado se ubican con offsets ACUMULADOS al consumir regiones (no
  // con un mapeo por punto): así un insert (región vacía en base) en el borde del grupo
  // cae DENTRO de su segmento y no se pierde. offA/offB = corrimiento base→lado de todo
  // lo consumido hasta acá; el delta de una región es (len lado) − (len base).
  const out: string[] = [];
  let pos = 0; // próximo índice de base sin emitir
  let conflicts = 0;
  let ia = 0;
  let ib = 0;
  let offA = 0;
  let offB = 0;
  while (ia < ra.length || ib < rb.length) {
    const na = ra[ia];
    const nb = rb[ib];
    const startOffA = offA;
    const startOffB = offB;
    // Arranca el grupo la región con menor inicio en base (empate: cualquiera; se absorben).
    let s: number;
    let e: number;
    let aTouched = false;
    let bTouched = false;
    if (na && (!nb || na.aS <= nb.aS)) {
      s = na.aS;
      e = na.aE;
      aTouched = true;
      offA += na.bE - na.bS - (na.aE - na.aS);
      ia++;
    } else if (nb) {
      s = nb.aS;
      e = nb.aE;
      bTouched = true;
      offB += nb.bE - nb.bS - (nb.aE - nb.aS);
      ib++;
    } else break; // inalcanzable, tranquiliza al narrowing
    let grew = true;
    while (grew) {
      grew = false;
      while (ia < ra.length) {
        const r = ra[ia] as ChangedRegion;
        if (!touches(s, e, r.aS, r.aE)) break;
        e = Math.max(e, r.aE);
        aTouched = true;
        offA += r.bE - r.bS - (r.aE - r.aS);
        ia++;
        grew = true;
      }
      while (ib < rb.length) {
        const r = rb[ib] as ChangedRegion;
        if (!touches(s, e, r.aS, r.aE)) break;
        e = Math.max(e, r.aE);
        bTouched = true;
        offB += r.bE - r.bS - (r.aE - r.aS);
        ib++;
        grew = true;
      }
    }

    for (let k = pos; k < s; k++) out.push(o[k] as string);
    pos = e;
    const baseSeg = o.slice(s, e).join("");
    const aSeg = a.slice(s + startOffA, e + offA).join("");
    const bSeg = b.slice(s + startOffB, e + offB).join("");
    if (!bTouched || bSeg === baseSeg) out.push(aSeg);
    else if (!aTouched || aSeg === baseSeg) out.push(bSeg);
    else if (aSeg === bSeg)
      out.push(aSeg); // los dos hicieron el MISMO cambio
    else if (resolve === "mine") out.push(aSeg);
    else if (resolve === "theirs") out.push(bSeg);
    else conflicts++; // solapamiento real: ambos cambiaron las mismas líneas, distinto
  }
  if (conflicts > 0) return { ok: false, conflicts };
  for (let k = pos; k < o.length; k++) out.push(o[k] as string);
  return { ok: true, merged: out.join("") };
}

/** Línea del diff 2 vías para la vista "ver diferencias" del conflicto real:
 *  `same` está en ambos, `mine` solo en lo mío, `theirs` solo en lo del server. */
export interface DiffLine {
  t: "same" | "mine" | "theirs";
  line: string; // sin el \n terminador (es para render)
}

/** Diff colapsado listo para render: líneas + separadores de corridas iguales largas. */
export type DiffView = (DiffLine | { t: "skip"; count: number })[];

/** Colapsa corridas largas de líneas iguales del diff del conflicto: contexto de 2 líneas
 *  alrededor de cada cambio, el resto se reemplaza por un separador "⋯ N líneas". */
export function collapseDiff(lines: DiffLine[]): DiffView {
  const CTX = 2;
  const out: DiffView = [];
  let run: DiffLine[] = [];
  const flushRun = (isLast: boolean) => {
    const head = out.length === 0 ? 0 : CTX; // sin contexto antes del primer cambio…
    const tail = isLast ? 0 : CTX; // …ni después del último
    if (run.length > head + tail + 1) {
      for (let i = 0; i < head; i++) out.push(run[i] as DiffLine);
      out.push({ t: "skip", count: run.length - head - tail });
      for (let i = run.length - tail; i < run.length; i++) out.push(run[i] as DiffLine);
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const l of lines) {
    if (l.t === "same") run.push(l);
    else {
      flushRun(false);
      out.push(l);
    }
  }
  flushRun(true);
  return out;
}

/** Diff por líneas mío↔de-ellos para mostrar (no para aplicar). */
export function diffLines(mine: string, theirs: string): DiffLine[] {
  const a = splitLines(mine);
  const b = splitLines(theirs);
  const strip = (s: string) => (s.endsWith("\n") ? s.slice(0, -1) : s);
  const out: DiffLine[] = [];
  let pa = 0;
  let pb = 0;
  for (const r of changedRegions(a, b)) {
    for (; pa < r.aS; pa++, pb++) out.push({ t: "same", line: strip(a[pa] as string) });
    for (; pa < r.aE; pa++) out.push({ t: "mine", line: strip(a[pa] as string) });
    for (; pb < r.bE; pb++) out.push({ t: "theirs", line: strip(b[pb] as string) });
  }
  for (; pa < a.length; pa++) out.push({ t: "same", line: strip(a[pa] as string) });
  return out;
}
