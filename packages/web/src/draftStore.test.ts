// Tests del draft store (Fase A "rock solid"). IndexedDB simulada con fake-indexeddb:
// cada test resetea el módulo Y la DB fake para empezar limpio. Lo crítico acá:
//  - read-your-writes síncrono (la garantía anti-remount),
//  - persistencia vía IDB entre "sesiones" (reset de memoria),
//  - limpieza sin carrera (clearDraftIfUnchanged no borra un draft más nuevo),
//  - degradación a solo-memoria cuando IndexedDB no existe.
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetDraftStoreForTests,
  clearDraft,
  clearDraftIfUnchanged,
  type DraftRecord,
  draftKeyOf,
  flushDraft,
  isDraftLive,
  listDrafts,
  loadDraft,
  moveDraft,
  saveDraft,
  shouldRestoreDraft,
} from "./draftStore.ts";

const K = draftKeyOf("demo", "demo-wiki", "notas/test.md");

// "Nueva sesión": tira la memoria y la conexión, PERO conserva la IDB fake (como un
// reload de la pestaña). `freshIdb` además reemplaza la DB (como un browser nuevo).
function newSession(): void {
  _resetDraftStoreForTests();
}
function freshIdb(): void {
  globalThis.indexedDB = new IDBFactory();
}

beforeEach(() => {
  freshIdb();
  newSession();
});
afterEach(() => {
  newSession();
});

describe("draftKeyOf", () => {
  it("aísla por handle/repo/path sin ambigüedad de concatenación", () => {
    expect(draftKeyOf("a", "bc", "d")).not.toBe(draftKeyOf("ab", "c", "d"));
    expect(draftKeyOf("demo", "r", "p")).not.toBe(draftKeyOf("maria", "r", "p"));
  });
});

describe("isDraftLive (definición de 'draft vivo')", () => {
  const rec: DraftRecord = { k: K, content: "# hola\ntexto", baseSha: "s1", ts: 1 };
  it("vivo cuando el contenido difiere de lo confirmado", () => {
    expect(isDraftLive(rec, "# hola\notra cosa")).toBe(true);
  });
  it("NO vivo cuando coincide con lo confirmado (residuo de un save)", () => {
    expect(isDraftLive(rec, "# hola\ntexto")).toBe(false);
  });
  it("NO vivo cuando no hay draft", () => {
    expect(isDraftLive(null, "lo que sea")).toBe(false);
  });
  it("NO vivo cuando solo difiere el `\\n` terminal (residuo de un save, buffer sin newline)", () => {
    // El bug crónico: onChange espeja el buffer crudo (sin `\n` final) pero el save commitea con
    // `withTrailingNewline` → sin tolerancia, el residuo se leía "vivo" y se rehidrataba en cada
    // remount. La nota commiteada termina en `\n`; el draft del buffer, no.
    const noNl: DraftRecord = { k: K, content: "# hola\ntexto", baseSha: "s1", ts: 1 };
    expect(isDraftLive(noNl, "# hola\ntexto\n")).toBe(false);
  });
});

describe("shouldRestoreDraft (rehidratar solo si continúa el server de AHORA)", () => {
  const live: DraftRecord = { k: K, content: "# hola\nlo mío sin guardar", baseSha: "s1", ts: 1 };
  it("rehidrata cuando el draft continúa la versión actual del server (baseSha == serverSha)", () => {
    expect(shouldRestoreDraft(live, "# hola\nlo del server", "s1")).toBe(true);
  });
  it("NO rehidrata un draft VIEJO: el server avanzó afuera (baseSha != serverSha) → tapaba lo nuevo", () => {
    // Repro del bug del owner: editó en el web (draft baseSha=s1), después editó la MISMA nota
    // desde un editor local que sincronizó a git → el server quedó en s2 con contenido nuevo.
    // Rehidratar el draft viejo taparía ese contenido nuevo (y lo pisaría por autosave).
    expect(shouldRestoreDraft(live, "# hola\ncontenido nuevo de afuera", "s2")).toBe(false);
  });
  it("NO rehidrata residuo (contenido == server, salvo `\\n`) aunque el sha coincida", () => {
    const residue: DraftRecord = { k: K, content: "# hola\ntexto", baseSha: "s1", ts: 1 };
    expect(shouldRestoreDraft(residue, "# hola\ntexto\n", "s1")).toBe(false);
  });
  it("NO rehidrata sin baseSha (draft legacy / nunca adoptó un sha)", () => {
    const noBase: DraftRecord = { k: K, content: "algo", ts: 1 };
    expect(shouldRestoreDraft(noBase, "otra cosa", "s1")).toBe(false);
  });
  it("NO rehidrata si no hay draft", () => {
    expect(shouldRestoreDraft(null, "server", "s1")).toBe(false);
  });
});

describe("read-your-writes síncrono (garantía anti-remount)", () => {
  it("loadDraft inmediato tras saveDraft ve la última tecla, sin esperar el throttle a IDB", async () => {
    saveDraft(K, { content: "v1", baseSha: "s1" });
    saveDraft(K, { content: "v2", baseSha: "s1" }); // misma ventana de throttle
    const d = await loadDraft(K);
    expect(d?.content).toBe("v2");
    expect(d?.baseSha).toBe("s1");
  });

  it("clearDraft deja tombstone: el load posterior no resucita lo de IDB", async () => {
    saveDraft(K, { content: "v1" });
    await flushDraft(K); // quedó en IDB
    await clearDraft(K);
    expect(await loadDraft(K)).toBeNull();
  });
});

describe("persistencia entre sesiones (IDB)", () => {
  it("flushDraft persiste y una sesión nueva recupera el draft", async () => {
    saveDraft(K, { content: "lo tipeado", baseSha: "sha-base" });
    await flushDraft(K);
    newSession(); // como cerrar y reabrir la pestaña
    const d = await loadDraft(K);
    expect(d?.content).toBe("lo tipeado");
    expect(d?.baseSha).toBe("sha-base");
  });

  it("el throttle hace flush trailing solo (~400ms) con el contenido MÁS nuevo", async () => {
    saveDraft(K, { content: "a" });
    saveDraft(K, { content: "ab" });
    saveDraft(K, { content: "abc" }); // ráfaga dentro de la ventana
    await new Promise((r) => setTimeout(r, 500)); // deja vencer el throttle
    newSession();
    expect((await loadDraft(K))?.content).toBe("abc");
  });

  it("clearDraft borra también en IDB (la próxima sesión no ve nada)", async () => {
    saveDraft(K, { content: "x" });
    await flushDraft(K);
    await clearDraft(K);
    newSession();
    expect(await loadDraft(K)).toBeNull();
  });
});

describe("clearDraftIfUnchanged (limpieza sin carrera)", () => {
  it("borra cuando el draft es exactamente lo confirmado", async () => {
    saveDraft(K, { content: "contenido guardado" });
    await clearDraftIfUnchanged(K, "contenido guardado");
    expect(await loadDraft(K)).toBeNull();
  });

  it("NO borra si el usuario siguió tipeando después del PUT (draft más nuevo)", async () => {
    saveDraft(K, { content: "v1" }); // esto es lo que el PUT confirmó
    saveDraft(K, { content: "v1 + más tipeo" }); // tecleó durante el PUT en vuelo
    await clearDraftIfUnchanged(K, "v1"); // el 200 llega y limpia "v1"
    expect((await loadDraft(K))?.content).toBe("v1 + más tipeo"); // el nuevo sigue protegido
  });

  it("no hace nada si no hay draft", async () => {
    await clearDraftIfUnchanged(K, "lo que sea");
    expect(await loadDraft(K)).toBeNull();
  });

  it("borra el residuo aunque solo difiera el `\\n` terminal (buffer sin newline vs commit con newline)", async () => {
    // El bug: el draft espeja el buffer crudo ("...texto"), el save confirma la forma
    // newline-terminada ("...texto\n"). Sin tolerancia, el residuo nunca se limpiaba.
    saveDraft(K, { content: "# hola\ntexto", baseSha: "s1" });
    await clearDraftIfUnchanged(K, "# hola\ntexto\n");
    expect(await loadDraft(K)).toBeNull();
  });
});

describe("moveDraft (rename de la nota re-keyea)", () => {
  it("mueve el draft vivo a la key nueva y borra la vieja", async () => {
    const K2 = draftKeyOf("demo", "demo-wiki", "notas/renombrada.md");
    saveDraft(K, { content: "draft vivo", baseSha: "s9" });
    moveDraft(K, K2);
    expect(await loadDraft(K)).toBeNull();
    const d = await loadDraft(K2);
    expect(d?.content).toBe("draft vivo");
    expect(d?.baseSha).toBe("s9");
  });

  it("sin draft en la key vieja → no-op", async () => {
    const K2 = draftKeyOf("demo", "demo-wiki", "notas/otra.md");
    moveDraft(K, K2);
    expect(await loadDraft(K2)).toBeNull();
  });
});

describe("listDrafts", () => {
  it("une IDB y memoria (memoria gana, tombstones afuera)", async () => {
    const KA = draftKeyOf("demo", "r", "a.md");
    const KB = draftKeyOf("demo", "r", "b.md");
    saveDraft(KA, { content: "a-idb" });
    saveDraft(KB, { content: "b-idb" });
    await flushDraft(KA);
    await flushDraft(KB);
    newSession();
    saveDraft(KA, { content: "a-mem" }); // pisa en memoria, IDB todavía vieja
    await clearDraft(KB); // tombstone
    const all = await listDrafts();
    expect(all.map((d) => [d.k, d.content])).toEqual([[KA, "a-mem"]]);
  });
});

describe("degradación sin IndexedDB", () => {
  it("todo funciona en memoria cuando indexedDB no existe", async () => {
    // @ts-expect-error — simulamos un browser sin IDB
    globalThis.indexedDB = undefined;
    newSession();
    saveDraft(K, { content: "solo en memoria", baseSha: "s1" });
    await flushDraft(K); // no explota
    expect((await loadDraft(K))?.content).toBe("solo en memoria");
    await clearDraftIfUnchanged(K, "solo en memoria");
    expect(await loadDraft(K)).toBeNull();
    expect(await listDrafts()).toEqual([]);
  });
});
