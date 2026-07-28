// Smoke de renderPdfToImages (Fase 16): genera un PDF de prueba con gs y lo rasteriza a PNG.
// REQUIERE gs en el PATH (corre en el server, no en la laptop). Corré: tsx packages/mcps/smoke-pdf.mts
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { renderPdfToImages } from "./src/core/pdf.ts";

const execFileAsync = promisify(execFile);
const gs = process.env.GS_BIN ?? "gs";

const dir = await mkdtemp(join(tmpdir(), "ceibo-pdf-smoke-"));
try {
  // 1) Generamos un PDF de 2 páginas con gs (pdfwrite + PostScript inline).
  const pdfPath = join(dir, "test.pdf");
  const ps = join(dir, "two.ps");
  await writeFile(
    ps,
    "<</PageSize[200 200]>>setpagedevice\n" +
      "/Helvetica findfont 20 scalefont setfont 30 100 moveto (pagina 1) show showpage\n" +
      "30 100 moveto (pagina 2) show showpage\n",
  );
  await execFileAsync(gs, ["-q", "-dBATCH", "-dNOPAUSE", "-sDEVICE=pdfwrite", `-sOutputFile=${pdfPath}`, ps]);

  // 2) Render con tope de 1 página → debe truncar (el PDF tiene 2).
  const pdf = await readFile(pdfPath);
  const one = await renderPdfToImages(pdf, { maxPages: 1, dpi: 72 });
  if (one.pages.length !== 1) throw new Error(`esperaba 1 página, dieron ${one.pages.length}`);
  if (!one.truncated) throw new Error("con maxPages=1 sobre un PDF de 2 páginas debería truncar");
  const png = Buffer.from(one.pages[0] as string, "base64");
  // PNG magic: 89 50 4E 47
  if (png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47)
    throw new Error("la salida no es un PNG válido");

  // 3) Render completo (tope alto) → 2 páginas, sin truncar.
  const all = await renderPdfToImages(pdf, { maxPages: 10, dpi: 72 });
  if (all.pages.length !== 2) throw new Error(`esperaba 2 páginas, dieron ${all.pages.length}`);
  if (all.truncated) throw new Error("no debería truncar con maxPages=10 sobre 2 páginas");

  console.log("OK pdf smoke");
} finally {
  await rm(dir, { recursive: true, force: true });
}
