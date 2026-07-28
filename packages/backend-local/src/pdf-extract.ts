// Extracción de TEXTO de PDFs entrantes ANTES de armar las parts del prompt de opencode.
//
// Por qué: el agente archima (opencode → vLLM, modelo local Gemma-31B) NO
// parsea PDF nativo como lo hace Claude en MA. opencode inlinea el archivo como data-URL
// (`{type:"file", mime:"application/pdf", ...}`) pero el modelo local no "ve" su contenido.
// Comparar con imágenes: `image-downscale.ts` baja las fotos para que Gemma (multimodal en
// imágenes, NO en PDF) las consuma. Para PDFs hacemos el equivalente del lado de ceibo:
// extraemos la capa de texto y la pasamos como texto al modelo, que sí la entiende. Cubre la
// mayoría de los PDFs de un asistente personal (facturas, tickets, docs de texto).
//
// Limitación deliberada (opción B del plan): esto NO renderiza páginas a imagen. Un PDF
// ESCANEADO (sin capa de texto) no rinde → devolvemos un aviso EXPLÍCITO en vez de silencio,
// así el agente puede decirle al usuario que no pudo leerlo (el render-a-imagen para
// escaneados es un fallback futuro).
//
// Librería: `unpdf` (JS puro, 0 deps nativas; bundlea un build serverless de pdf.js) → install
// determinístico en CI, en la box (rsync + pnpm install, sin binarios por plataforma) y en
// local. No necesita `onlyBuiltDependencies` (no corre build-script).

import { extractText, getDocumentProxy } from "unpdf";

/** Tope de páginas a extraer. Un PDF largo volaría el contexto del modelo local (7B/31B).
 *  Más allá de esto truncamos y avisamos. */
export const MAX_PDF_PAGES = 50;
/** Tope de caracteres del texto extraído. Segundo cinturón sobre el cap de páginas: una
 *  página densa puede ser enorme. ~60k chars ≈ 15k tokens, holgado para los modelos locales. */
export const MAX_PDF_TEXT_CHARS = 60_000;

export interface PdfExtractResult {
  /** true si pudimos extraer texto real; false si el PDF no tiene capa de texto (escaneado)
   *  o no se pudo decodificar. */
  ok: boolean;
  /** El texto extraído (sólo si ok). */
  text: string;
  /** Total de páginas del PDF (0 si no se pudo abrir). */
  totalPages: number;
  /** Páginas efectivamente incluidas en `text`. */
  pagesUsed: number;
  /** true si recortamos por MAX_PDF_PAGES o MAX_PDF_TEXT_CHARS. */
  truncated: boolean;
}

/** Extrae la capa de texto de un PDF (base64). Best-effort: nunca tira — un PDF roto o
 *  escaneado devuelve `ok:false` para que el caller arme un aviso claro. */
export async function extractPdfText(base64: string): Promise<PdfExtractResult> {
  const empty: PdfExtractResult = { ok: false, text: "", totalPages: 0, pagesUsed: 0, truncated: false };

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(base64, "base64"));
  } catch {
    return empty;
  }
  if (bytes.length === 0) return empty;

  let totalPages: number;
  let pageTexts: string[];
  try {
    const pdf = await getDocumentProxy(bytes);
    // mergePages:false → un string por página, para poder capear por nº de página.
    const res = await extractText(pdf, { mergePages: false });
    totalPages = res.totalPages;
    pageTexts = res.text;
  } catch {
    return empty;
  }

  const pagesUsed = Math.min(pageTexts.length, MAX_PDF_PAGES);
  let truncated = pageTexts.length > MAX_PDF_PAGES;
  let text = pageTexts.slice(0, MAX_PDF_PAGES).join("\n\n").trim();

  if (text.length > MAX_PDF_TEXT_CHARS) {
    text = text.slice(0, MAX_PDF_TEXT_CHARS).trim();
    truncated = true;
  }

  // Sin capa de texto (escaneado / sólo imágenes) → no rinde con extracción de texto.
  if (!text) return { ...empty, totalPages };

  return { ok: true, text, totalPages, pagesUsed, truncated };
}

/** Arma el bloque de texto que reemplaza al PDF en el prompt. Si se pudo extraer, envuelve
 *  el contenido con un encabezado que lo identifica (y avisa si se truncó); si no, devuelve un
 *  aviso EXPLÍCITO de que no se pudo leer (escaneado), mejor que pasar un PDF mudo en silencio. */
export function formatPdfTextBlock(filename: string | undefined, r: PdfExtractResult): string {
  const name = filename || "documento.pdf";
  if (!r.ok) {
    return (
      `[No pude extraer texto del PDF "${name}". ` +
      `Probablemente sea un PDF escaneado (imágenes sin capa de texto); ` +
      `pedile al usuario el contenido en texto o una foto legible de las páginas relevantes.]`
    );
  }
  const trunc = r.truncated
    ? ` (truncado: ${r.pagesUsed}/${r.totalPages} páginas${r.totalPages > MAX_PDF_PAGES ? "" : ", texto recortado"})`
    : ` (${r.totalPages} página${r.totalPages === 1 ? "" : "s"})`;
  return `[Texto extraído del PDF "${name}"${trunc}]\n\n${r.text}`;
}

/** Conveniencia: PDF (base64) → bloque de texto listo para una part `{type:"text"}`. */
export async function pdfToTextBlock(base64: string, filename?: string): Promise<string> {
  return formatPdfTextBlock(filename, await extractPdfText(base64));
}
