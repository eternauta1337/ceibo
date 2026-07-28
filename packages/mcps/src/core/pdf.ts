// Render de PDF a imágenes, server-side, con ghostscript (gs). Corre en el server (donde vive
// el MCP y el binario gs); el resultado son PNGs base64 que el MCP devuelve como content blocks
// para que el agente (en el sandbox) VEA el PDF. MA no tiene vía MCP para PDF nativo, de ahí el
// rasterizado. Mismo patrón shell-out + temp files que @ceibo/speech con ffmpeg.

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RenderPdfResult {
  pages: string[]; // PNG base64, en orden de página
  truncated: boolean; // se cortó por tope de páginas o de tamaño (hay más PDF sin mostrar)
}

export interface RenderPdfOpts {
  maxPages?: number; // tope de páginas a renderizar (default 15)
  dpi?: number; // densidad del raster (default 150)
  maxTotalBytes?: number; // tope acumulado de los PNG (default 25MB; req a MA ~32MB)
}

// gs nombra los outputs page-001.png, page-002.png, … (orden = nombre).
export async function renderPdfToImages(pdf: Buffer, opts: RenderPdfOpts = {}): Promise<RenderPdfResult> {
  const gs = process.env.GS_BIN ?? "gs";
  const maxPages = opts.maxPages ?? 15;
  const dpi = opts.dpi ?? 150;
  const maxTotal = opts.maxTotalBytes ?? 25 * 1024 * 1024;

  const dir = await mkdtemp(join(tmpdir(), "ceibo-pdf-"));
  try {
    const input = join(dir, "in.pdf");
    await writeFile(input, pdf);
    // Renderizamos maxPages+1 para saber si HAY más (truncado) sin un probe aparte de pagecount
    // (que requeriría operadores de archivo PostScript, bloqueados por -dSAFER).
    await execFileAsync(
      gs,
      [
        "-q",
        "-dSAFER", // contra PDFs maliciosos: sin operaciones de archivo desde el PDF
        "-dBATCH",
        "-dNOPAUSE",
        "-sDEVICE=png16m",
        `-r${dpi}`,
        "-dFirstPage=1",
        `-dLastPage=${maxPages + 1}`,
        `-sOutputFile=${join(dir, "page-%03d.png")}`,
        input,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith(".png")).sort();
    const overPageCap = files.length > maxPages;
    const usable = files.slice(0, maxPages); // descarta la página extra de sondeo

    const pages: string[] = [];
    let total = 0;
    let cutBySize = false;
    for (const f of usable) {
      const buf = await readFile(join(dir, f));
      if (total + buf.length > maxTotal) {
        cutBySize = true;
        break;
      }
      pages.push(buf.toString("base64"));
      total += buf.length;
    }
    return { pages, truncated: overPageCap || cutBySize };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
