import type { InboundMedia } from "@ceibo/agent";
import { Jimp } from "jimp";
import { describe, expect, it } from "vitest";
import { downscaleImage, downscaleMedia, JPEG_QUALITY, MAX_SIDE } from "./image-downscale.ts";

/** Construye un PNG base64 de WxH. `noise` llena con bytes pseudo-aleatorios
 *  (determinísticos) → PNG incompresible y pesado, para forzar el caso "jpeg achica". */
async function makePngB64(width: number, height: number, noise = false): Promise<string> {
  const img = new Jimp({ width, height, color: 0x102030ff });
  if (noise) {
    const d = img.bitmap.data;
    let s = 0x12345678;
    for (let i = 0; i < d.length; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      d[i] = s & 0xff;
    }
    for (let i = 3; i < d.length; i += 4) d[i] = 255; // alpha opaco
  }
  const buf = await img.getBuffer("image/png");
  return buf.toString("base64");
}

const b64len = (s: string) => Buffer.from(s, "base64").length;

describe("downscaleImage", () => {
  it("deja los documentos (PDF) intactos", async () => {
    const doc: InboundMedia = {
      kind: "document",
      mediaType: "application/pdf",
      data: "JVBERi0=",
      filename: "x.pdf",
    };
    expect(await downscaleImage(doc)).toBe(doc);
  });

  it("deja pasar mimes que jimp no decodifica (HEIC) sin tocar", async () => {
    const heic: InboundMedia = { kind: "image", mediaType: "image/heic", data: "AAAA", filename: "p.heic" };
    expect(await downscaleImage(heic)).toBe(heic);
  });

  it("deja pasar bytes no decodificables sin romper", async () => {
    const junk: InboundMedia = { kind: "image", mediaType: "image/png", data: "bm90LWFuLWltYWdl" };
    expect(await downscaleImage(junk)).toBe(junk);
  });

  it("deja pasar data vacía", async () => {
    const empty: InboundMedia = { kind: "image", mediaType: "image/png", data: "" };
    expect(await downscaleImage(empty)).toBe(empty);
  });

  it("redimensiona una imagen grande a <= MAX_SIDE y la pasa a JPEG", async () => {
    // Apenas por encima de MAX_SIDE (1568) en el lado largo: dispara el downscale igual
    // (entra >1568 → sale =1568) pero con pocos píxeles. Un PNG de ruido 3000×2000 tardaba
    // >5s bajo coverage+suite paralela (CI) → timeout. El timeout holgado abajo cubre la
    // contención del worker pool; en la práctica corre en ~1-2s.
    const data = await makePngB64(1600, 1000, true);
    const out = await downscaleImage({ kind: "image", mediaType: "image/png", data, filename: "foto.PNG" });
    expect(out.mediaType).toBe("image/jpeg");
    expect(out.filename).toBe("foto.jpg"); // extension reescrita
    const img = await Jimp.fromBuffer(Buffer.from(out.data, "base64"));
    expect(Math.max(img.bitmap.width, img.bitmap.height)).toBe(MAX_SIDE);
    expect(img.bitmap.width).toBe(MAX_SIDE); // lado largo era el width (1600)
    expect(b64len(out.data)).toBeLessThan(b64len(data)); // mucho mas chico
  }, 20_000);

  it("re-encodea a JPEG (sin resize) una imagen sub-MAX_SIDE pero pesada - caso foto real chica", async () => {
    const data = await makePngB64(800, 600, true); // PNG de ruido = pesado
    const out = await downscaleImage({ kind: "image", mediaType: "image/png", data });
    expect(out.mediaType).toBe("image/jpeg");
    expect(out.filename).toBeUndefined(); // sin filename de entrada -> sin filename de salida
    const img = await Jimp.fromBuffer(Buffer.from(out.data, "base64"));
    expect(img.bitmap.width).toBe(800); // sin resize: dims preservadas
    expect(img.bitmap.height).toBe(600);
    expect(b64len(out.data)).toBeLessThan(b64len(data)); // el jpeg achico
  }, 20_000);

  it("deja la imagen chica original si el re-encode no la achica", async () => {
    // 16x16 solido: el PNG ya es minusculo, el jpeg q80 seria igual o mas grande -> keep original.
    const data = await makePngB64(16, 16, false);
    const original: InboundMedia = { kind: "image", mediaType: "image/png", data };
    expect(await downscaleImage(original)).toBe(original);
  });

  it("constantes exportadas en rango sano", () => {
    expect(JPEG_QUALITY).toBeGreaterThanOrEqual(40);
    expect(JPEG_QUALITY).toBeLessThanOrEqual(95);
    expect(MAX_SIDE).toBeGreaterThanOrEqual(1024);
  });
});

describe("downscaleMedia", () => {
  it("devuelve undefined si no hay media", async () => {
    expect(await downscaleMedia(undefined)).toBeUndefined();
  });

  it("devuelve el mismo array (vacio) si no hay items", async () => {
    const empty: InboundMedia[] = [];
    expect(await downscaleMedia(empty)).toBe(empty);
  });

  it("procesa imagenes y deja documentos intactos en una mezcla", async () => {
    const big = await makePngB64(1600, 1000, true); // > MAX_SIDE → dispara downscale
    const doc: InboundMedia = { kind: "document", mediaType: "application/pdf", data: "JVBERi0=" };
    const out = await downscaleMedia([{ kind: "image", mediaType: "image/png", data: big }, doc]);
    expect(out).toHaveLength(2);
    expect(out?.[0]?.mediaType).toBe("image/jpeg");
    expect(out?.[1]).toBe(doc);
  }, 20_000);
});
