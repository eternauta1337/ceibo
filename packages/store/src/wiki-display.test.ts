import { describe, expect, it } from "vitest";
import {
  addRepo,
  addUser,
  backfillOwnedWikiLabels,
  type Db,
  getRepoByName,
  grantAccess,
  listReposForUser,
  openDb,
  renameUser,
  setRepoLabel,
  wikiDisplayNames,
} from "./index.ts";

const freshDb = () => openDb(":memory:");

// Crea repo `name` (label opcional) y se lo da en orden a los handles dados (el primero = dueño).
function repo(db: Db, name: string, label: string | undefined, owners: number[]): void {
  const r = addRepo(db, "org", name, label);
  for (const uid of owners) grantAccess(db, r.id, uid);
}

describe("wikiDisplayNames", () => {
  it("sin colisión: todo pelado, tanto la propia como las compartidas de otros", () => {
    const db = freshDb();
    const demo = addUser(db, "demo", { name: "demo" });
    const lula = addUser(db, "lula", { name: "lula" });
    const azul = addUser(db, "azul", { name: "azul" });
    repo(db, "lula-personal", "personal", [lula.id]);
    repo(db, "demo-luminos", undefined, [demo.id, lula.id]); // dueño demo, compartida con lula
    repo(db, "azul-origen", "origen", [azul.id, lula.id]); // dueño azul, compartida con lula

    const d = wikiDisplayNames(db, "lula", listReposForUser(db, lula.id));
    expect(d.get("lula-personal")).toBe("personal");
    expect(d.get("demo-luminos")).toBe("luminos");
    expect(d.get("azul-origen")).toBe("origen");
  });

  it("colisión propia vs ajena: la propia queda pelada, la ajena se prefija", () => {
    const db = freshDb();
    const demo = addUser(db, "demo", { name: "demo" });
    const lula = addUser(db, "lula", { name: "lula" });
    repo(db, "lula-personal", "personal", [lula.id]);
    repo(db, "demo-personal", "personal", [demo.id, lula.id]); // demo comparte SU personal con lula

    const d = wikiDisplayNames(db, "lula", listReposForUser(db, lula.id));
    expect(d.get("lula-personal")).toBe("personal");
    expect(d.get("demo-personal")).toBe("demo-personal");
  });

  it("colisión entre dos ajenas: ambas se prefijan", () => {
    const db = freshDb();
    const demo = addUser(db, "demo", { name: "demo" });
    const bob = addUser(db, "bob", { name: "bob" });
    const lula = addUser(db, "lula", { name: "lula" });
    repo(db, "demo-notas", "notas", [demo.id, lula.id]);
    repo(db, "bob-notas", "notas", [bob.id, lula.id]);

    const d = wikiDisplayNames(db, "lula", listReposForUser(db, lula.id));
    expect(d.get("demo-notas")).toBe("demo-notas");
    expect(d.get("bob-notas")).toBe("bob-notas");
  });

  it("el dueño ve la suya pelada aunque la comparta", () => {
    const db = freshDb();
    const demo = addUser(db, "demo", { name: "demo" });
    const lula = addUser(db, "lula", { name: "lula" });
    repo(db, "demo-luminos", undefined, [demo.id, lula.id]);

    const d = wikiDisplayNames(db, "demo", listReposForUser(db, demo.id));
    expect(d.get("demo-luminos")).toBe("luminos");
  });

  // Regresión (QA, identidad demo→demo-gpuhost): el nombre del repo codifica el handle viejo
  // (`demo-personal`). Sin el congelado del label, tras renombrar el usuario el display caería al
  // nombre crudo `demo-personal` en vez de `personal`.
  it("renameUser preserva el display label de las wikis sin label explícito", () => {
    const db = freshDb();
    const demo = addUser(db, "demo", { name: "demo" });
    repo(db, "demo-personal", undefined, [demo.id]); // sin label explícito
    repo(db, "demo-luminos", undefined, [demo.id]);

    // Antes del rename: el strip del prefijo funciona contra el handle actual.
    expect(wikiDisplayNames(db, "demo", listReposForUser(db, demo.id)).get("demo-personal")).toBe("personal");

    renameUser(db, demo.id, "demo-gpuhost");

    // El label quedó congelado en el store → el display sobrevive al cambio de handle.
    expect(getRepoByName(db, "org", "demo-personal")?.label).toBe("personal");
    expect(getRepoByName(db, "org", "demo-luminos")?.label).toBe("luminos");
    const d = wikiDisplayNames(db, "demo-gpuhost", listReposForUser(db, demo.id));
    expect(d.get("demo-personal")).toBe("personal");
    expect(d.get("demo-luminos")).toBe("luminos");
  });

  it("renameUser NO pisa un label explícito ya seteado", () => {
    const db = freshDb();
    const demo = addUser(db, "demo", { name: "demo" });
    const r = addRepo(db, "org", "demo-personal", undefined);
    grantAccess(db, r.id, demo.id);
    setRepoLabel(db, r.id, "diario"); // label humano explícito

    renameUser(db, demo.id, "demo-gpuhost");
    expect(getRepoByName(db, "org", "demo-personal")?.label).toBe("diario");
  });

  describe("backfillOwnedWikiLabels (migración para usuarios ya renombrados)", () => {
    it("congela el label derivado del handle viejo en wikis sin label", () => {
      const db = freshDb();
      // El usuario ya está renombrado a demo-gpuhost; sus wikis quedaron con el prefijo viejo.
      const gpuhost = addUser(db, "demo-gpuhost", { name: "demo" });
      repo(db, "demo-personal", undefined, [gpuhost.id]);
      repo(db, "demo-luminos", undefined, [gpuhost.id]);

      // Sin backfill, el display cae al nombre crudo (prefijo viejo no matchea demo-gpuhost).
      expect(
        wikiDisplayNames(db, "demo-gpuhost", listReposForUser(db, gpuhost.id)).get("demo-personal"),
      ).toBe("demo-personal");

      const n = backfillOwnedWikiLabels(db, gpuhost.id, "demo");
      expect(n).toBe(2);
      expect(getRepoByName(db, "org", "demo-personal")?.label).toBe("personal");
      expect(getRepoByName(db, "org", "demo-luminos")?.label).toBe("luminos");
      const d = wikiDisplayNames(db, "demo-gpuhost", listReposForUser(db, gpuhost.id));
      expect(d.get("demo-personal")).toBe("personal");
      expect(d.get("demo-luminos")).toBe("luminos");
    });

    it("es idempotente y no toca labels explícitos ni wikis ajenas", () => {
      const db = freshDb();
      const gpuhost = addUser(db, "demo-gpuhost", { name: "demo" });
      const otro = addUser(db, "otro", { name: "otro" });
      const conLabel = addRepo(db, "org", "demo-diario", undefined);
      grantAccess(db, conLabel.id, gpuhost.id);
      setRepoLabel(db, conLabel.id, "mi-diario"); // explícito → no se toca
      repo(db, "demo-personal", undefined, [gpuhost.id]);
      repo(db, "otro-cosas", undefined, [otro.id]); // ajena → no se toca

      expect(backfillOwnedWikiLabels(db, gpuhost.id, "demo")).toBe(1); // sólo demo-personal
      expect(backfillOwnedWikiLabels(db, gpuhost.id, "demo")).toBe(0); // 2da corrida: nada nuevo
      expect(getRepoByName(db, "org", "demo-diario")?.label).toBe("mi-diario");
      expect(getRepoByName(db, "org", "demo-personal")?.label).toBe("personal");
      expect(getRepoByName(db, "org", "otro-cosas")?.label).toBeNull();
    });

    it("conservador: no congela nada si el prefijo viejo tampoco matchea", () => {
      const db = freshDb();
      const u = addUser(db, "demo-gpuhost", { name: "demo" });
      repo(db, "demo-personal", undefined, [u.id]);
      // handle viejo equivocado → wikiLabel devuelve el nombre crudo → no se persiste basura.
      expect(backfillOwnedWikiLabels(db, u.id, "noexiste")).toBe(0);
      expect(getRepoByName(db, "org", "demo-personal")?.label).toBeNull();
    });
  });
});
