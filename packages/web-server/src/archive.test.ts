import type { Wikis } from "@ceibo/wikis";
import { describe, expect, it } from "vitest";
import { archiveEntry, archiveFolder, archiveNote } from "./archive.ts";

describe("archiveEntry", () => {
  it("nota en subcarpeta → manifest en esa carpeta, link = basename, preview de la 1ª línea", () => {
    const { manifestPath, line } = archiveEntry("projects/compras.md", "# Compras\n\nlista del super");
    expect(manifestPath).toBe("projects/.archived.md");
    expect(line).toBe("- [compras](compras.md) — lista del super");
  });
  it("nota en raíz → manifest en raíz; saltea frontmatter y headings para el preview", () => {
    const { manifestPath, line } = archiveEntry("nota.md", "---\nk: v\n---\n# Título\n\ncuerpo real");
    expect(manifestPath).toBe(".archived.md");
    expect(line).toBe("- [nota](nota.md) — cuerpo real");
  });
});

/** Wikis fakeado: getFile devuelve la nota o (para un manifest de archivado, nuevo `.archived.md`
 *  o legacy `_archivado.md`) el manifest existente —o tira si `manifest` es undefined (simula 404).
 *  `manifestName` controla bajo qué nombre "existe" el manifest (default `.archived.md`), para
 *  testear el append al legacy. Registra el commit para inspeccionarlo. */
function fakeWikis(o: {
  note: { content: string; sha: string };
  manifest?: string;
  manifestName?: string;
  commitOk?: boolean;
}) {
  const calls: {
    commit?: { baseRef: string; changes: Array<{ op: string; path: string; content?: string }> };
  } = {};
  const manifestBase = o.manifestName ?? ".archived.md";
  const wikis = {
    async getFile(_repo: string, path: string) {
      if (path.endsWith(".archived.md") || path.endsWith("_archivado.md")) {
        // El manifest sólo "existe" bajo el nombre configurado (simula 404 para el otro).
        if (o.manifest === undefined || !path.endsWith(manifestBase)) throw new Error("404");
        return { content: o.manifest, sha: "m", path };
      }
      return { content: o.note.content, sha: o.note.sha, path };
    },
    async headSha() {
      return "headsha";
    },
    async commit(
      _repo: string,
      baseRef: string,
      changes: Array<{ op: string; path: string; content?: string }>,
    ) {
      calls.commit = { baseRef, changes };
      return o.commitOk === false
        ? { ok: false as const, conflictPaths: ["x"] }
        : { ok: true as const, ref: "newref" };
    },
  } as unknown as Wikis;
  return { wikis, calls };
}

describe("archiveNote", () => {
  it("borra la nota + crea el manifest con header (no existía), en un commit sobre HEAD", async () => {
    const { wikis, calls } = fakeWikis({ note: { content: "# C\n\nx", sha: "base" } });
    const r = await archiveNote(wikis, "repo", "dir/c.md", "base", "ale");
    expect(r).toEqual({ ok: true, manifestPath: "dir/.archived.md" });
    expect(calls.commit?.baseRef).toBe("headsha");
    const ch = calls.commit?.changes ?? [];
    expect(ch[0]).toEqual({ op: "delete", path: "dir/c.md" });
    expect(ch[1]?.op).toBe("put");
    expect(ch[1]?.path).toBe("dir/.archived.md");
    expect(ch[1]?.content).toContain("- [c](c.md)");
    expect(ch[1]?.content).toContain("# Archivado");
  });

  it("agrega al manifest existente (no lo pisa)", async () => {
    const { wikis, calls } = fakeWikis({
      note: { content: "# C\n\nx", sha: "base" },
      manifest: "# Archivado\n\n- [vieja](vieja.md)\n",
    });
    await archiveNote(wikis, "repo", "c.md", "base", "ale");
    const put = (calls.commit?.changes ?? []).find((c) => c.op === "put");
    expect(put?.content).toContain("- [vieja](vieja.md)");
    expect(put?.content).toContain("- [c](c.md)");
  });

  it("transición: agrega al manifest legacy `_archivado.md` existente (no parte el índice)", async () => {
    const { wikis, calls } = fakeWikis({
      note: { content: "# C\n\nx", sha: "base" },
      manifest: "# Archivado\n\n- [vieja](vieja.md)\n",
      manifestName: "_archivado.md", // la carpeta tiene el manifest viejo, sin migrar
    });
    await archiveNote(wikis, "repo", "c.md", "base", "ale");
    const put = (calls.commit?.changes ?? []).find((c) => c.op === "put");
    expect(put?.path).toBe("_archivado.md"); // escribe en el legacy existente, no crea .archived.md
    expect(put?.content).toContain("- [vieja](vieja.md)");
    expect(put?.content).toContain("- [c](c.md)");
  });

  it("conflict si la nota cambió desde baseSha (no commitea)", async () => {
    const { wikis, calls } = fakeWikis({ note: { content: "x", sha: "OTRO" } });
    const r = await archiveNote(wikis, "repo", "c.md", "base", "ale");
    expect(r).toEqual({ ok: false, conflict: true });
    expect(calls.commit).toBeUndefined();
  });
});

/** Wikis fakeado para archiveFolder: un repo plano `files` (path → contenido). Registra el
 *  commit para inspeccionarlo. */
function fakeRepo(files: Record<string, string>, o: { commitOk?: boolean } = {}) {
  const calls: {
    commit?: { baseRef: string; changes: Array<{ op: string; path: string; content?: string }> };
  } = {};
  const wikis = {
    async listFiles() {
      return Object.keys(files);
    },
    async read(_repo: string, _ref: string | undefined, paths?: string[]) {
      const want = paths ?? Object.keys(files);
      return {
        ref: "headsha",
        files: want.filter((p) => p in files).map((p) => ({ path: p, content: files[p] ?? "", sha: "s" })),
      };
    },
    async getFile(_repo: string, path: string) {
      const content = files[path];
      if (content === undefined) throw new Error("404");
      return { content, sha: "s", path };
    },
    async headSha() {
      return "headsha";
    },
    async commit(
      _repo: string,
      baseRef: string,
      changes: Array<{ op: string; path: string; content?: string }>,
    ) {
      calls.commit = { baseRef, changes };
      return o.commitOk === false
        ? { ok: false as const, conflictPaths: ["x"] }
        : { ok: true as const, ref: "newref" };
    },
  } as unknown as Wikis;
  return { wikis, calls };
}

describe("archiveFolder", () => {
  // REPRO del bug zombie: archivar carpeta nota-a-nota (archiveNote) escribía el manifest
  // ADENTRO de la carpeta → la carpeta "borrada" renacía anclada por su `_archivado.md`.
  it("zombie: el archivado por-nota indexa DENTRO de la carpeta que se está borrando", () => {
    // archiveNote (correcto para UNA nota) indexa en la carpeta de la nota: si la operación
    // era "borrar la carpeta", ese put la revive — y como los índices se saltean al archivar,
    // la carpeta nunca más se podía borrar. archiveFolder existe para ese caso.
    const { manifestPath } = archiveEntry("tecnico/delete-me/nota.md", "# N\n\nx");
    expect(manifestPath).toBe("tecnico/delete-me/.archived.md"); // ← dentro de la carpeta borrada
  });

  it("borra TODO bajo el prefijo (notas + _index.md) e indexa en el .archived.md del PADRE", async () => {
    const { wikis, calls } = fakeRepo({
      "tecnico/delete-me/nota.md": "# Nota\n\nAsistimos 9 vecinos.",
      "tecnico/delete-me/_index.md": "# Índice",
      "tecnico/otra.md": "# Otra", // fuera de la carpeta: no se toca
    });
    const r = await archiveFolder(wikis, "repo", "tecnico/delete-me", "ale");
    expect(r).toEqual({
      ok: true,
      manifestPath: "tecnico/.archived.md",
      archived: ["tecnico/delete-me/nota.md"],
    });
    const ch = calls.commit?.changes ?? [];
    const deleted = ch.filter((c) => c.op === "delete").map((c) => c.path);
    expect(deleted.sort()).toEqual(["tecnico/delete-me/_index.md", "tecnico/delete-me/nota.md"]);
    // El manifest va al PADRE, con el link re-prefijado (relativo a tecnico/) — NADA se
    // escribe dentro de la carpeta borrada (eso era el zombie).
    const puts = ch.filter((c) => c.op === "put");
    expect(puts).toHaveLength(1);
    expect(puts[0]?.path).toBe("tecnico/.archived.md");
    expect(puts[0]?.content).toContain("- [nota](delete-me/nota.md) — Asistimos 9 vecinos.");
    expect(ch.some((c) => c.path.startsWith("tecnico/delete-me/") && c.op === "put")).toBe(false);
  });

  it("carpeta zombie (solo _archivado.md): la borra y migra sus entradas al manifest del padre", async () => {
    // El estado en el que quedó la carpeta del owner: sin notas, solo el índice de archivado.
    const { wikis, calls } = fakeRepo({
      "tecnico/delete-me/_archivado.md":
        "# Archivado\n\n- [notas-reunion-cooperativa](notas-reunion-cooperativa.md) — Asistimos 9 vecinos.\n",
    });
    const r = await archiveFolder(wikis, "repo", "tecnico/delete-me", "ale");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.archived).toEqual([]); // sin notas nuevas que archivar
    const ch = calls.commit?.changes ?? [];
    expect(ch.filter((c) => c.op === "delete").map((c) => c.path)).toEqual([
      "tecnico/delete-me/_archivado.md",
    ]);
    // Las entradas viejas siguen localizables: link re-prefijado relativo al manifest del padre.
    const put = ch.find((c) => c.op === "put");
    expect(put?.path).toBe("tecnico/.archived.md");
    expect(put?.content).toContain(
      "- [notas-reunion-cooperativa](delete-me/notas-reunion-cooperativa.md) — Asistimos 9 vecinos.",
    );
  });

  it("subcarpetas: notas anidadas y manifests internos re-prefijan con el path completo", async () => {
    const { wikis, calls } = fakeRepo({
      "top/sub/nota.md": "# N\n\ncuerpo",
      "top/sub/_archivado.md": "# Archivado\n\n- [vieja](vieja.md) — preview\n",
    });
    const r = await archiveFolder(wikis, "repo", "top", "ale");
    expect(r.ok).toBe(true);
    const put = (calls.commit?.changes ?? []).find((c) => c.op === "put");
    expect(put?.path).toBe(".archived.md"); // carpeta de raíz → manifest de raíz
    expect(put?.content).toContain("- [nota](top/sub/nota.md) — cuerpo");
    expect(put?.content).toContain("- [vieja](top/sub/vieja.md) — preview");
    expect(put?.content).toContain("# Archivado"); // no existía → header
  });

  it("agrega al manifest del padre existente (no lo pisa)", async () => {
    const { wikis, calls } = fakeRepo({
      "dir/carpeta/n.md": "# N\n\nx",
      "dir/_archivado.md": "# Archivado\n\n- [previa](previa.md)\n",
    });
    await archiveFolder(wikis, "repo", "dir/carpeta", "ale");
    const put = (calls.commit?.changes ?? []).find((c) => c.op === "put");
    expect(put?.content).toContain("- [previa](previa.md)");
    expect(put?.content).toContain("- [n](carpeta/n.md)");
  });

  it("carpeta inexistente/vacía → ok sin commit (no inventa un manifest)", async () => {
    const { wikis, calls } = fakeRepo({ "otra/n.md": "# N" });
    const r = await archiveFolder(wikis, "repo", "no-existe", "ale");
    expect(r).toEqual({ ok: true, manifestPath: ".archived.md", archived: [] });
    expect(calls.commit).toBeUndefined();
  });

  it("assets no-md: se borran (sin entrada de índice) — no quedan anclando la carpeta", async () => {
    const { wikis, calls } = fakeRepo({
      "c/nota.md": "# N\n\nx",
      "c/foto.png": "binario",
    });
    const r = await archiveFolder(wikis, "repo", "c", "ale");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.archived).toEqual(["c/nota.md"]);
    const ch = calls.commit?.changes ?? [];
    expect(
      ch
        .filter((c) => c.op === "delete")
        .map((c) => c.path)
        .sort(),
    ).toEqual(["c/foto.png", "c/nota.md"]);
    expect(ch.find((c) => c.op === "put")?.content).not.toContain("foto.png");
  });

  it("conflict si el commit pierde la carrera (HEAD movió y tocó nuestros paths)", async () => {
    const { wikis } = fakeRepo({ "c/n.md": "# N" }, { commitOk: false });
    const r = await archiveFolder(wikis, "repo", "c", "ale");
    expect(r).toEqual({ ok: false, conflict: true });
  });
});
