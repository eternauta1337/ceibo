// WhatsApp acepta mensajes de texto muy largos (~65k chars), así que casi nunca hace falta
// chunkear. Igual mantenemos el corte por longitud/newline para que un output largo del
// agente llegue sin truncar.
export const WHATSAPP_HARD_LIMIT = 65536;

export type ChunkMode = "length" | "newline";

export function chunkText(text: string, limit: number, mode: ChunkMode): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = limit;
    if (mode === "newline") {
      const para = rest.lastIndexOf("\n\n", limit);
      const line = rest.lastIndexOf("\n", limit);
      const space = rest.lastIndexOf(" ", limit);
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit;
    }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) out.push(rest);
  return out;
}
