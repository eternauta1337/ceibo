// Downscale + recompresión de imágenes entrantes ANTES de armar el data-URL para opencode.
//
// Por qué: el agente archima (opencode → vLLM/Gemma, provider OpenAI-compat `local`) NO
// "ve" fotos reales. opencode trae su propia normalización de imágenes
// (`Image.normalize`, refs/opencode/.../image/image.ts) que SÓLO redimensiona arriba de
// 2000px / 4.5MB base64, y para hacerlo necesita el WASM de Photon cargado en la VM; si la
// foto cae en ese camino y Photon no está disponible, la imagen no llega como visión. Las
// fotos de teléfono (varios MB, >2000px) caen justo ahí. Mitigamos del lado de ceibo:
// bajamos cada imagen a un lado máximo razonable (≤ el nativo de los modelos de visión y muy
// por debajo del umbral de opencode) y la re-encodeamos como JPEG baseline limpio (sin EXIF,
// sin progresivo) calidad ~80. Así opencode nunca tiene que invocar su path de resize y el
// provider recibe bytes chicos y normalizados. Los PDFs/documentos NO se tocan.
//
// Librería: `jimp` (JS puro, sin binarios nativos) → install determinístico en CI, en la box
// (rsync + pnpm install, sin sorpresas de binario por plataforma) y en local. Para el volumen
// de imágenes entrantes (esporádicas, no hot-path) su velocidad alcanza de sobra.

import type { InboundMedia } from "@ceibo/agent";
import { Jimp } from "jimp";

/** Lado máximo (px) del output. 1568 ≈ resolución nativa que usan los modelos de visión y
 *  queda MUY por debajo del umbral de resize de opencode (2000px) → opencode nunca resizea. */
export const MAX_SIDE = 1568;
/** Calidad JPEG del re-encode. 80 es el sweet-spot visión/bytes para fotos. */
export const JPEG_QUALITY = 80;

/** Mimes raster que jimp puede decodificar/re-encodear. HEIC/HEIF NO (jimp no los decodifica)
 *  → se dejan pasar tal cual (las plataformas de chat suelen transcodear HEIC→JPEG igual). */
const RASTER_MIME = /^image\/(jpe?g|png|webp|bmp|gif|tiff?)$/i;

/** Reescribe la extensión del filename a .jpg (el output siempre es JPEG). */
function jpegName(filename: string): string {
  const base = filename.replace(/\.[^./\\]+$/, "");
  return `${base}.jpg`;
}

/** Downscalea + re-encodea UNA media entrante a JPEG baseline limpio dentro de MAX_SIDE.
 *  Devuelve una InboundMedia NUEVA (image/jpeg) o la original sin tocar si:
 *   - no es una imagen raster procesable (documento/PDF, o mime que jimp no decodifica),
 *   - jimp no puede decodificar los bytes,
 *   - el re-encode NO achica y la imagen NO necesitaba resize (no degradamos imágenes ya
 *     chicas — p.ej. screenshots con texto — a JPEG sin ganancia). */
export async function downscaleImage(m: InboundMedia): Promise<InboundMedia> {
  if (m.kind !== "image" || !RASTER_MIME.test(m.mediaType)) return m;

  let buf: Buffer;
  try {
    buf = Buffer.from(m.data, "base64");
  } catch {
    return m;
  }
  if (buf.length === 0) return m;

  let img: Awaited<ReturnType<typeof Jimp.fromBuffer>>;
  try {
    img = await Jimp.fromBuffer(buf);
  } catch {
    return m; // formato que jimp no entiende → lo dejamos pasar como vino
  }

  const { width, height } = img.bitmap;
  const resized = width > MAX_SIDE || height > MAX_SIDE;
  // scaleToFit ENCOGE para caber en MAX_SIDE×MAX_SIDE preservando aspect ratio. Sólo lo
  // llamamos si hace falta (scaleToFit también AGRANDARÍA si la imagen fuese más chica).
  if (resized) img.scaleToFit({ w: MAX_SIDE, h: MAX_SIDE });

  let out: Buffer;
  try {
    out = await img.getBuffer("image/jpeg", { quality: JPEG_QUALITY });
  } catch {
    return m;
  }

  // Si no hubo que redimensionar y el re-encode no achica → quedate con el original.
  if (!resized && out.length >= buf.length) return m;

  return {
    kind: "image",
    mediaType: "image/jpeg",
    data: out.toString("base64"),
    ...(m.filename ? { filename: jpegName(m.filename) } : {}),
  };
}

/** Aplica downscaleImage a cada media (en paralelo). Documentos pasan intactos. */
export async function downscaleMedia(media?: InboundMedia[]): Promise<InboundMedia[] | undefined> {
  if (!media?.length) return media;
  return Promise.all(media.map(downscaleImage));
}
