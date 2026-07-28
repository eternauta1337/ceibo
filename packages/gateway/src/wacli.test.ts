import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { onNdjson } from "./wacli.ts";

// onNdjson lee NDJSON línea-a-línea de un stream (vía readline) y emite los eventos
// válidos. Le damos un Readable de juguete. (El resto de wacli.ts spawnea el binario
// `wacli` → I/O irreducible, va a integración.)
function collect(lines: string[]): Promise<{ event: string }[]> {
  return new Promise((resolve) => {
    const out: { event: string }[] = [];
    const stream = Readable.from(lines);
    onNdjson(stream, (e) => out.push(e as { event: string }));
    stream.on("end", () => setImmediate(() => resolve(out)));
  });
}

describe("onNdjson", () => {
  it("emite los eventos JSON válidos con campo `event` string", async () => {
    const out = await collect([
      '{"event":"pair_code","data":{"code":"123-456"}}\n',
      '{"event":"connected"}\n',
    ]);
    expect(out.map((e) => e.event)).toEqual(["pair_code", "connected"]);
  });

  it("ignora logs humanos (no arrancan con {) y JSON malformado", async () => {
    const out = await collect(["iniciando wacli...\n", "{ no es json\n", '{"event":"connected"}\n']);
    expect(out.map((e) => e.event)).toEqual(["connected"]);
  });

  it("ignora JSON sin `event` string", async () => {
    const out = await collect(['{"foo":1}\n', '{"event":42}\n']);
    expect(out).toEqual([]);
  });
});
