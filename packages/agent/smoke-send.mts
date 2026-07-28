// Smoke del ingress del relay (Fase 16): send() arma el user.message con bloques de imagen /
// documento (lo que el modelo VE) + texto, en el shape de la API de sesiones. Mockea el client
// (no toca la red). Corré: tsx packages/agent/smoke-send.mts
import type Anthropic from "@anthropic-ai/sdk";
import { attach } from "./src/index.ts";

const sent: Array<{ events: Array<{ content: Array<Record<string, unknown>> }> }> = [];
const fake = {
  beta: {
    sessions: {
      events: {
        // pump() hace `for await` sobre esto; un promise colgado = nunca itera (no nos importa acá).
        stream: () => new Promise(() => {}),
        send: (_sid: string, payload: unknown) => {
          sent.push(payload as (typeof sent)[number]);
          return Promise.resolve({});
        },
      },
    },
  },
} as unknown as Anthropic;

const relay = attach(fake, "sess-1", { message() {} });

await relay.send("qué ves?", [{ kind: "image", data: "QUJD", mediaType: "image/png" }]);
await relay.send("", [
  { kind: "document", data: "REVG", mediaType: "application/pdf", filename: "factura.pdf" },
]);
await relay.send("solo texto");
relay.close();

const c0 = sent[0]?.events[0]?.content ?? [];
if (c0[0]?.type !== "image") throw new Error("bloque 0 debería ser image");
if ((c0[0]?.source as { media_type?: string })?.media_type !== "image/png")
  throw new Error("media_type de imagen mal");
if (c0[1]?.type !== "text" || c0[1]?.text !== "qué ves?")
  throw new Error("falta el bloque de texto tras la imagen");

const c1 = sent[1]?.events[0]?.content ?? [];
if (c1[0]?.type !== "document") throw new Error("bloque 0 debería ser document");
if ((c1[0]?.source as { media_type?: string })?.media_type !== "application/pdf")
  throw new Error("media_type de PDF mal");
if (c1[0]?.title !== "factura.pdf") throw new Error("falta el title del documento");
if (c1.length !== 1) throw new Error("texto vacío NO debería agregar bloque de texto");

const c2 = sent[2]?.events[0]?.content ?? [];
if (c2.length !== 1 || c2[0]?.type !== "text" || c2[0]?.text !== "solo texto")
  throw new Error("solo-texto mal armado");

console.log("OK send smoke");
