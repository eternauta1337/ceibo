// Tests de serialización/restauración del formato de pestañas con páginas de sistema.
//
// Valida el contrato de persistencia de useChannel.ts:
// - Las tabs de sistema se serializan como { kind: "system", page: SystemPage }
// - Las tabs de nota se serializan como { repo, path } (o { kind: "note", repo, path })
// - El formato viejo sin `kind` se parsea como nota (back-compat)
// - Back-compat: el format viejo de una sola nota { repo, path } (antes de las tabs) sigue parseando
//
// El código real de parse vive en el boot de useChannel.ts; este test valida el contrato
// del formato JSON que se lee/escribe en localStorage, para asegurar el round-trip.

import { describe, expect, it } from "vitest";
import { isSystemPage } from "./systemPages.ts";

// --- Lógica de parse extraída del boot de useChannel.ts (espejo del código real) -------
// Estos helpers replican el contrato de parsing para permitir tests puros sin React.

type PersistedEntry = { kind?: "note"; repo: string; path: string } | { kind: "system"; page: string };

function isNoteEntry(e: unknown): e is { repo: string; path: string } {
  return (
    !!e &&
    typeof (e as Record<string, unknown>).repo === "string" &&
    typeof (e as Record<string, unknown>).path === "string"
  );
}

function isSystemEntry(e: unknown): e is { kind: "system"; page: string } {
  return (
    !!e &&
    (e as Record<string, unknown>).kind === "system" &&
    isSystemPage((e as Record<string, unknown>).page)
  );
}

function parseTabsCache(raw: string): { entries: PersistedEntry[]; active: number } | null {
  try {
    const parsed = JSON.parse(raw) as {
      tabs?: unknown[];
      active?: number;
      repo?: string;
      path?: string;
    };
    if (Array.isArray(parsed?.tabs)) {
      const entries = parsed.tabs.filter((e): e is PersistedEntry => isNoteEntry(e) || isSystemEntry(e));
      const active = typeof parsed.active === "number" ? parsed.active : 0;
      return { entries, active };
    }
    if (isNoteEntry(parsed)) {
      // back-compat: formato viejo de una sola nota
      return { entries: [parsed], active: 0 };
    }
    return null;
  } catch {
    return null;
  }
}

// Serializa el estado de tabs (espejo del efecto de persistencia de useChannel.ts).
function serializeTabsCache(entries: PersistedEntry[], active: number): string {
  const slim = {
    tabs: entries.map((e) => {
      if (e.kind === "system") return { kind: "system" as const, page: e.page };
      return {
        repo: (e as { repo: string; path: string }).repo,
        path: (e as { repo: string; path: string }).path,
      };
    }),
    active,
  };
  return JSON.stringify(slim);
}

// --------------------------------------------------------------------------------------

describe("serialización de tabs de sistema (contrato de useChannel.ts)", () => {
  it("una tab de sistema serializa como { kind: 'system', page }", () => {
    const raw = serializeTabsCache([{ kind: "system", page: "config" }], 0);
    const parsed = JSON.parse(raw) as { tabs: unknown[]; active: number };
    expect(parsed.tabs[0]).toEqual({ kind: "system", page: "config" });
    expect(parsed.active).toBe(0);
  });

  it("una tab de nota serializa como { repo, path } (sin kind)", () => {
    const raw = serializeTabsCache([{ repo: "demo", path: "nota.md" }], 0);
    const parsed = JSON.parse(raw) as { tabs: unknown[]; active: number };
    expect(parsed.tabs[0]).toEqual({ repo: "demo", path: "nota.md" });
  });

  it("mix: nota + sistema serializa correctamente", () => {
    const raw = serializeTabsCache(
      [
        { repo: "demo", path: "nota.md" },
        { kind: "system", page: "agenda" },
        { repo: "ceibo", path: "ideas.md" },
      ],
      1,
    );
    const parsed = JSON.parse(raw) as { tabs: unknown[]; active: number };
    expect(parsed.tabs).toHaveLength(3);
    expect(parsed.tabs[0]).toEqual({ repo: "demo", path: "nota.md" });
    expect(parsed.tabs[1]).toEqual({ kind: "system", page: "agenda" });
    expect(parsed.tabs[2]).toEqual({ repo: "ceibo", path: "ideas.md" });
    expect(parsed.active).toBe(1);
  });
});

describe("restore de tabs desde localStorage", () => {
  it("restaura tabs de sistema correctamente", () => {
    const raw = JSON.stringify({
      tabs: [
        { kind: "system", page: "config" },
        { kind: "system", page: "agenda" },
      ],
      active: 1,
    });
    const result = parseTabsCache(raw);
    expect(result).not.toBeNull();
    expect(result?.entries).toHaveLength(2);
    expect(result?.entries[0]).toEqual({ kind: "system", page: "config" });
    expect(result?.entries[1]).toEqual({ kind: "system", page: "agenda" });
    expect(result?.active).toBe(1);
  });

  it("restaura tabs de nota correctamente", () => {
    const raw = JSON.stringify({
      tabs: [
        { repo: "demo", path: "nota.md" },
        { repo: "ceibo", path: "ideas.md" },
      ],
      active: 0,
    });
    const result = parseTabsCache(raw);
    expect(result?.entries).toHaveLength(2);
    expect(result?.entries[0]).toEqual({ repo: "demo", path: "nota.md" });
  });

  it("back-compat: una entry vieja sin `kind` con repo/path se parsea como nota", () => {
    const raw = JSON.stringify({
      tabs: [{ repo: "demo", path: "nota.md" }], // sin kind
      active: 0,
    });
    const result = parseTabsCache(raw);
    expect(result?.entries).toHaveLength(1);
    const entry = result?.entries[0];
    // Sin kind explícito → pasa el filtro isNoteEntry → se restaura como nota
    expect(entry).toEqual({ repo: "demo", path: "nota.md" });
  });

  it("back-compat: formato viejo de una sola nota { repo, path } (sin tabs array)", () => {
    const raw = JSON.stringify({ repo: "demo", path: "nota.md" });
    const result = parseTabsCache(raw);
    expect(result?.entries).toHaveLength(1);
    expect(result?.entries[0]).toEqual({ repo: "demo", path: "nota.md" });
    expect(result?.active).toBe(0);
  });

  it("filtra entradas inválidas (sin repo/path ni kind:system válido)", () => {
    const raw = JSON.stringify({
      tabs: [
        { repo: "demo", path: "nota.md" }, // válida
        { kind: "system", page: "conexiones" }, // válida
        { kind: "note" }, // inválida: nota sin repo/path
        { kind: "system", page: "desconocida" }, // inválida: page desconocida
        null, // inválida
        42, // inválida
      ],
      active: 0,
    });
    const result = parseTabsCache(raw);
    expect(result?.entries).toHaveLength(2); // solo las 2 válidas
  });

  it("devuelve null para JSON corrupto", () => {
    expect(parseTabsCache("{invalid json")).toBeNull();
  });

  it("round-trip: serializar y restaurar produce el mismo estado", () => {
    const original: PersistedEntry[] = [
      { repo: "demo", path: "nota.md" },
      { kind: "system", page: "config" },
      { repo: "ceibo", path: "ideas/2026.md" },
      { kind: "system", page: "agenda" },
    ];
    const raw = serializeTabsCache(original, 2);
    const restored = parseTabsCache(raw);
    expect(restored?.entries).toHaveLength(4);
    expect(restored?.active).toBe(2);
    // Las tabs de sistema se preservan con su page.
    expect(restored?.entries[1]).toEqual({ kind: "system", page: "config" });
    expect(restored?.entries[3]).toEqual({ kind: "system", page: "agenda" });
    // Las notas se preservan con repo/path.
    expect(restored?.entries[0]).toEqual({ repo: "demo", path: "nota.md" });
  });
});

describe("singleton: openSystem no duplica", () => {
  // Test conceptual del invariante singleton: si una page ya está en la lista de tabs,
  // openSystem debe enfocarla, no agregar otra entrada.
  // La lógica real vive en openSystem() de useChannel.ts (usa tabsRef).
  // Acá validamos el lookup que usa: "buscar por kind==='system' && page===x".

  it("el lookup por kind+page es correcto", () => {
    type FakeTab = {
      id: string;
      entries: Array<{ kind?: string; page?: string; repo?: string; path?: string }>;
    };
    const tabs: FakeTab[] = [
      { id: "t1", entries: [{ repo: "demo", path: "nota.md" }] },
      { id: "t2", entries: [{ kind: "system", page: "config" }] },
      { id: "t3", entries: [{ kind: "system", page: "agenda" }] },
    ];

    const findExisting = (page: string) =>
      tabs.find((t) => {
        const e = t.entries[0];
        return e?.kind === "system" && e.page === page;
      });

    // config ya existe → encontramos t2
    expect(findExisting("config")?.id).toBe("t2");
    // agenda ya existe → encontramos t3
    expect(findExisting("agenda")?.id).toBe("t3");
    // conexiones no existe → undefined (se crearía una nueva tab)
    expect(findExisting("conexiones")).toBeUndefined();
  });
});
