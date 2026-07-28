import { describe, expect, it } from "vitest";
import {
  extractPdfText,
  formatPdfTextBlock,
  MAX_PDF_PAGES,
  type PdfExtractResult,
  pdfToTextBlock,
} from "./pdf-extract.ts";

/** Arma un PDF mínimo VÁLIDO con una capa de texto extraíble (un Tj por página). pdf.js
 *  reconstruye el xref si hace falta, pero igual escribimos uno correcto. */
function makeTextPdf(pages: string[]): string {
  const objs: string[] = [`<</Type/Catalog/Pages 2 0 R>>`];
  const kids: string[] = [];
  const pageObjs: string[] = [];
  const fontObjNum = 3 + pages.length * 2; // catalog(1) pages(2) + 2 objs por página
  pages.forEach((text, i) => {
    const pageNum = 3 + i * 2;
    const contentNum = pageNum + 1;
    kids.push(`${pageNum} 0 R`);
    pageObjs.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${contentNum} 0 R/Resources<</Font<</F1 ${fontObjNum} 0 R>>>>>>`,
    );
    const content = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
    pageObjs.push(`<</Length ${content.length}>>\nstream\n${content}\nendstream`);
  });
  objs.push(`<</Type/Pages/Kids[${kids.join(" ")}]/Count ${pages.length}>>`);
  objs.push(...pageObjs);
  objs.push(`<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>`);

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, "latin1").toString("base64");
}

/** PDF válido de una página SIN capa de texto (simula un escaneado: la página existe pero no
 *  hay operadores de texto). extractText devuelve "" → ok:false. */
function makeBlankPdf(): string {
  const objs = [
    `<</Type/Catalog/Pages 2 0 R>>`,
    `<</Type/Pages/Kids[3 0 R]/Count 1>>`,
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, "latin1").toString("base64");
}

describe("extractPdfText", () => {
  it("extrae la capa de texto de un PDF de texto", async () => {
    const data = makeTextPdf(["Factura 0001 Total 4500 pesos"]);
    const r = await extractPdfText(data);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Factura 0001 Total 4500 pesos");
    expect(r.totalPages).toBe(1);
    expect(r.pagesUsed).toBe(1);
    expect(r.truncated).toBe(false);
  });

  it("une el texto de varias páginas", async () => {
    const data = makeTextPdf(["Pagina uno", "Pagina dos", "Pagina tres"]);
    const r = await extractPdfText(data);
    expect(r.ok).toBe(true);
    expect(r.totalPages).toBe(3);
    expect(r.pagesUsed).toBe(3);
    expect(r.text).toContain("Pagina uno");
    expect(r.text).toContain("Pagina dos");
    expect(r.text).toContain("Pagina tres");
  });

  it("marca ok:false en un PDF escaneado (sin capa de texto)", async () => {
    const r = await extractPdfText(makeBlankPdf());
    expect(r.ok).toBe(false);
    expect(r.text).toBe("");
    expect(r.totalPages).toBe(1); // el PDF se abrió, pero no hay texto
  });

  it("no rompe con base64 que no es un PDF", async () => {
    const r = await extractPdfText(Buffer.from("esto no es un pdf").toString("base64"));
    expect(r.ok).toBe(false);
    expect(r.totalPages).toBe(0);
  });

  it("no rompe con data vacía", async () => {
    const r = await extractPdfText("");
    expect(r.ok).toBe(false);
    expect(r.totalPages).toBe(0);
  });

  it("trunca por nº de páginas cuando supera el cap", async () => {
    const pages = Array.from({ length: MAX_PDF_PAGES + 5 }, (_, i) => `Pagina ${i + 1} contenido`);
    const r = await extractPdfText(makeTextPdf(pages));
    expect(r.ok).toBe(true);
    expect(r.totalPages).toBe(MAX_PDF_PAGES + 5);
    expect(r.pagesUsed).toBe(MAX_PDF_PAGES);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("Pagina 1 contenido");
    expect(r.text).not.toContain(`Pagina ${MAX_PDF_PAGES + 1} contenido`);
  }, 20_000);
});

describe("formatPdfTextBlock", () => {
  const okRes: PdfExtractResult = {
    ok: true,
    text: "contenido del pdf",
    totalPages: 2,
    pagesUsed: 2,
    truncated: false,
  };

  it("envuelve el texto extraído con un encabezado que nombra el archivo", () => {
    const out = formatPdfTextBlock("factura.pdf", okRes);
    expect(out).toContain('"factura.pdf"');
    expect(out).toContain("2 páginas");
    expect(out).toContain("contenido del pdf");
  });

  it("singulariza 'página' con 1 sola página", () => {
    const out = formatPdfTextBlock("x.pdf", { ...okRes, totalPages: 1, pagesUsed: 1 });
    expect(out).toContain("(1 página)");
  });

  it("avisa explícito cuando no se pudo extraer (escaneado)", () => {
    const out = formatPdfTextBlock("scan.pdf", {
      ok: false,
      text: "",
      totalPages: 3,
      pagesUsed: 0,
      truncated: false,
    });
    expect(out).toContain("No pude extraer texto");
    expect(out).toContain('"scan.pdf"');
    expect(out).toContain("escaneado");
  });

  it("usa un nombre por defecto si no hay filename", () => {
    expect(formatPdfTextBlock(undefined, okRes)).toContain("documento.pdf");
  });

  it("señala truncado por páginas", () => {
    const out = formatPdfTextBlock("big.pdf", {
      ok: true,
      text: "...",
      totalPages: MAX_PDF_PAGES + 10,
      pagesUsed: MAX_PDF_PAGES,
      truncated: true,
    });
    expect(out).toContain("truncado");
    expect(out).toContain(`${MAX_PDF_PAGES}/${MAX_PDF_PAGES + 10}`);
  });
});

describe("pdfToTextBlock", () => {
  it("PDF de texto → bloque con el texto", async () => {
    const data = makeTextPdf(["Hola mundo PDF"]);
    const out = await pdfToTextBlock(data, "doc.pdf");
    expect(out).toContain("Texto extraído");
    expect(out).toContain("Hola mundo PDF");
  });

  it("PDF escaneado → bloque con el aviso", async () => {
    const out = await pdfToTextBlock(makeBlankPdf(), "scan.pdf");
    expect(out).toContain("No pude extraer texto");
  });
});
