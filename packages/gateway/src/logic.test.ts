import { describe, expect, it } from "vitest";
import {
  buildRemPlannerPrompt,
  buildTitlePrompt,
  controlUrlSecret,
  currentTimeTag,
  formatRemPlanForExecutor,
  formatTurnSummary,
  formatWorkerResultForCoordinator,
  isInternalDetail,
  isoWithOffset,
  isSubstantialForTitle,
  langTag,
  noteName,
  parseModalityDirective,
  parseRemStructuredPlan,
  parseWorkerStructuredResult,
  parseWorkerStructuredResultFromParts,
  pickDefaultProfile,
  publicErrorReason,
  remForeignCommits,
  remMaxDeletions,
  remNetDeletions,
  remPlanHasWork,
  resolveAgentId,
  sanitizeTitle,
  scoreRemRouting,
  sessionFingerprint,
  verifyWorkerObservedDiff,
  verifyWorkerStructuredResult,
  type WikiTurnChange,
  wikiMatches,
} from "./logic.ts";
import type { ChatModel } from "./models.ts";

describe("parseModalityDirective", () => {
  it("[[voice]] → voice true y quita el marcador", () => {
    expect(parseModalityDirective("[[voice]] hola")).toEqual({ voice: true, text: "hola" });
    expect(parseModalityDirective("  [[ VOICE ]]respuesta")).toEqual({ voice: true, text: "respuesta" });
  });
  it("[[text]] → voice false y quita el marcador", () => {
    expect(parseModalityDirective("[[text]] hola")).toEqual({ voice: false, text: "hola" });
  });
  it("sin marcador → voice false, texto intacto", () => {
    expect(parseModalityDirective("hola mundo")).toEqual({ voice: false, text: "hola mundo" });
  });
});

describe("langTag", () => {
  it("en → tag de inglés; es/desconocido → undefined", () => {
    expect(langTag("en")).toMatch(/inglés/);
    expect(langTag("es")).toBeUndefined();
    expect(langTag("fr")).toBeUndefined();
  });
});

describe("isoWithOffset", () => {
  // Un instante UTC fijo: 2026-06-08T20:23:00Z. En Buenos Aires/Montevideo (-03:00, sin DST)
  // son las 17:23 del MISMO día. El ISO resultante DEBE llevar el offset explícito.
  const utc = new Date("2026-06-08T20:23:00Z");

  it("formatea con el wall-clock y el offset reales de la tz (Buenos Aires = -03:00)", () => {
    expect(isoWithOffset(utc, "America/Argentina/Buenos_Aires")).toBe("2026-06-08T17:23:00-03:00");
  });
  it("Montevideo da el MISMO -03:00 (consistente con archima/UY)", () => {
    expect(isoWithOffset(utc, "America/Montevideo")).toBe("2026-06-08T17:23:00-03:00");
  });
  it("UTC → offset +00:00 (no rompe cuando longOffset es 'GMT')", () => {
    expect(isoWithOffset(utc, "UTC")).toBe("2026-06-08T20:23:00+00:00");
  });
  it("cruza el límite de día hacia atrás (UTC 02:00 → día anterior 23:00 -03:00)", () => {
    expect(isoWithOffset(new Date("2026-06-08T02:00:00Z"), "America/Argentina/Buenos_Aires")).toBe(
      "2026-06-07T23:00:00-03:00",
    );
  });
  it("default tz = la del MCP schedule (-03:00)", () => {
    expect(isoWithOffset(utc)).toBe("2026-06-08T17:23:00-03:00");
  });
});

describe("currentTimeTag", () => {
  it("envuelve el ISO con offset en el tag que lee el prompt", () => {
    expect(currentTimeTag(new Date("2026-06-08T20:23:00Z"), "America/Argentina/Buenos_Aires")).toBe(
      "[fecha y hora actual: 2026-06-08T17:23:00-03:00]",
    );
  });
  it("siempre incluye un offset explícito (inequívoco)", () => {
    expect(currentTimeTag(new Date("2026-06-08T20:23:00Z"))).toMatch(
      /^\[fecha y hora actual: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\]$/,
    );
  });
});

describe("resolveAgentId", () => {
  const models = new Map<string, ChatModel>([
    ["haiku", { key: "haiku", label: "H", model: "claude-haiku", envKey: "AGENT_ID", agentName: "ceibo" }],
    [
      "sonnet",
      {
        key: "sonnet",
        label: "S",
        model: "claude-sonnet",
        envKey: "AGENT_ID_SONNET",
        agentName: "ceibo-sonnet",
      },
    ],
  ]);
  const env = { AGENT_ID: "ag-haiku", AGENT_ID_SONNET: "ag-sonnet" } as NodeJS.ProcessEnv;

  it("usa el agentId del modelo elegido", () => {
    expect(resolveAgentId("sonnet", models, env, "fallback", "haiku")).toBe("ag-sonnet");
  });
  it("modelKey null → default", () => {
    expect(resolveAgentId(null, models, env, "fallback", "sonnet")).toBe("ag-sonnet");
  });
  it("modelo sin env publicado → fallback", () => {
    expect(resolveAgentId("sonnet", models, {} as NodeJS.ProcessEnv, "fallback", "haiku")).toBe("fallback");
  });
  it("modelKey desconocido → cae al default", () => {
    expect(resolveAgentId("opus", models, env, "fallback", "haiku")).toBe("ag-haiku");
  });
});

describe("pickDefaultProfile", () => {
  it("perfil explícito del usuario gana", () => {
    expect(pickDefaultProfile("personal", ["work"], "default")).toBe("personal");
  });
  it("sin grants → default", () => {
    expect(pickDefaultProfile(null, [], "default")).toBe("default");
  });
  it("todos los grants de UN perfil con nombre → ese perfil", () => {
    expect(pickDefaultProfile(null, ["work", "work"], "default")).toBe("work");
  });
  it("varios perfiles → default", () => {
    expect(pickDefaultProfile(null, ["work", "personal"], "default")).toBe("default");
  });
  it("único perfil pero ES el default → default", () => {
    expect(pickDefaultProfile(null, ["default"], "default")).toBe("default");
  });
});

describe("wikiMatches", () => {
  const meta = { name: "demo-notas", label: "notas", ownerHandle: "demo", display: "Notas" };
  it("matchea por nombre de repo, label, dueño-label y display (case-insensitive)", () => {
    expect(wikiMatches(meta, "demo-notas")).toBe(true);
    expect(wikiMatches(meta, "NOTAS")).toBe(true);
    expect(wikiMatches(meta, "demo-notas")).toBe(true);
    expect(wikiMatches(meta, "notas")).toBe(true);
    expect(wikiMatches(meta, "Notas")).toBe(true);
  });
  it("no matchea lo que no corresponde", () => {
    expect(wikiMatches(meta, "otra")).toBe(false);
  });
  it("sin display no rompe", () => {
    expect(wikiMatches({ name: "r", label: "l", ownerHandle: "o" }, "l")).toBe(true);
    expect(wikiMatches({ name: "r", label: "l", ownerHandle: "o" }, "nope")).toBe(false);
  });
});

describe("noteName", () => {
  it("devuelve el nombre de archivo sin carpetas", () => {
    expect(noteName("diario/2026/agenda.md")).toBe("agenda.md");
    expect(noteName("recetas.md")).toBe("recetas.md");
  });
});

describe("formatTurnSummary", () => {
  it("vacío → string vacío", () => {
    expect(formatTurnSummary([])).toBe("");
  });

  it("una sola op, una sola nota → primera persona, nombre sin carpeta ni .md", () => {
    const out = formatTurnSummary([{ op: "edit", path: "diario/agenda.md" }]);
    expect(out).toBe("Listo: edité «agenda».");
  });

  it("agrupa por op, en 1ª persona, con conteo y nombres", () => {
    const items: WikiTurnChange[] = [
      { op: "create", path: "cocina/recetas.md" },
      { op: "create", path: "compras.md" },
      { op: "delete", path: "viejo.md" },
      { op: "edit", path: "agenda.md" },
    ];
    const out = formatTurnSummary(items);
    expect(out).toContain("creé 2 notas (recetas, compras)");
    expect(out).toContain("edité «agenda»");
    expect(out).toContain("borré «viejo»");
    expect(out).not.toContain("cocina/"); // sin rutas
    expect(out).not.toContain(".md"); // sin extensión
    expect(out.startsWith("Listo: ")).toBe(true);
    expect(out.endsWith(".")).toBe(true);
  });

  it("coalesce por nota con la op de mayor precedencia: create + edit → creé", () => {
    const out = formatTurnSummary([
      { op: "create", path: "x.md" },
      { op: "edit", path: "x.md" },
    ]);
    expect(out).toBe("Listo: creé «x».");
  });

  it("edit luego delete → borré (delete gana)", () => {
    const out = formatTurnSummary([
      { op: "edit", path: "x.md" },
      { op: "delete", path: "x.md" },
    ]);
    expect(out).toBe("Listo: borré «x».");
  });

  it("trunca la lista de nombres con '…y N más'", () => {
    const items: WikiTurnChange[] = ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md"].map((p) => ({
      op: "create" as const,
      path: p,
    }));
    const out = formatTurnSummary(items);
    expect(out).toContain("creé 6 notas (a, b, c, d …y 2 más)");
  });

  it("varias cláusulas se unen con comas y 'y' final", () => {
    const out = formatTurnSummary([
      { op: "create", path: "a.md" },
      { op: "edit", path: "b.md" },
      { op: "delete", path: "c.md" },
    ]);
    // create, edit, delete (en OP_ORDER) → "..., ... y ..."
    expect(out).toBe("Listo: creé «a», edité «b» y borré «c».");
  });
});

describe("resultado estructurado de sub-agentes", () => {
  it("parsea el último bloque json fenced con el contrato esperado", () => {
    const out = parseWorkerStructuredResult(`
Narración previa.

\`\`\`json
{
  "status": "done",
  "pushed": true,
  "commit_message": "Reordenar notas de viajes",
  "changed_notes": [
    { "path": "viajes/japon.md", "action": "edited" },
    { "path": "viajes/inbox.md", "action": "archived" }
  ],
  "opened_note": "viajes/japon.md",
  "blockers": [],
  "summary_for_user": "Reorganicé las notas de Japón y archivé el inbox viejo."
}
\`\`\`
`);
    expect(out).toEqual({
      status: "done",
      pushed: true,
      commit_message: "Reordenar notas de viajes",
      changed_notes: [
        { path: "viajes/japon.md", action: "edited" },
        { path: "viajes/inbox.md", action: "archived" },
      ],
      opened_note: "viajes/japon.md",
      summary_for_user: "Reorganicé las notas de Japón y archivé el inbox viejo.",
    });
  });

  it("rechaza json inválido o sin status/resumen mínimo", () => {
    expect(parseWorkerStructuredResult("sin json")).toBeUndefined();
    expect(parseWorkerStructuredResult("```json\n{ nope\n```")).toBeUndefined();
    expect(parseWorkerStructuredResult('```json\n{"status":"done"}\n```')).toBeUndefined();
    expect(
      parseWorkerStructuredResult('```json\n{"status":"weird","summary_for_user":"x"}\n```'),
    ).toBeUndefined();
  });

  it("formatea el resultado estructurado para el coordinador", () => {
    const out = formatWorkerResultForCoordinator(
      [
        "mensaje intermedio",
        `Cierre:
\`\`\`json
{
  "status": "partial",
  "pushed": false,
  "changed_notes": [{ "path": "ideas/rem.md", "action": "created" }],
  "blockers": ["faltó credencial de calendario"],
  "summary_for_user": "Creé el borrador de REM, pero no pude agendar."
}
\`\`\``,
      ],
      1000,
    );
    expect(out).toContain("Estado: parcial.");
    expect(out).toContain("Resumen para usuario: Creé el borrador de REM, pero no pude agendar.");
    expect(out).toContain("Cambios subidos: no.");
    expect(out).toContain("ideas/rem.md (creada)");
    expect(out).toContain("Bloqueos: faltó credencial de calendario");
    expect(out).not.toContain("mensaje intermedio");
  });

  it("mantiene fallback legacy: último mensaje libre, capado", () => {
    const out = formatWorkerResultForCoordinator(["ruido anterior", `RESUMEN: ${"x".repeat(60)} FIN`], 30);
    expect(out).toBe(`RESUMEN: ${"x".repeat(21)}\n[…resumen recortado]`);
    expect(out).not.toContain("ruido anterior");
  });

  it("verifica metadata peligrosa antes de inyectar al coordinador", () => {
    const issues = verifyWorkerStructuredResult(
      {
        status: "done",
        pushed: false,
        changed_notes: [
          { path: "memoria/a.md", action: "deleted" },
          { path: "../secreto.md", action: "edited" },
          { path: "memoria/b.md", action: "deleted" },
        ],
        summary_for_user: "hice cambios",
      },
      { maxDeletedNotes: 1 },
    );
    expect(issues.map((i) => i.code)).toEqual(["not_pushed", "unsafe_path", "too_many_deletions"]);
  });

  it("incluye advertencias de verificación en el resumen estructurado", () => {
    const out = formatWorkerResultForCoordinator(
      [
        `\`\`\`json
{
  "status": "done",
  "pushed": false,
  "changed_notes": [{ "path": "/tmp/x.md", "action": "edited" }],
  "summary_for_user": "Edité una nota."
}
\`\`\``,
      ],
      1000,
    );
    expect(out).toContain("Verificación:");
    expect(out).toContain("el worker reportó cambios que no fueron subidos");
    expect(out).toContain("path sospechoso reportado: /tmp/x.md");
  });

  it("parsea el resultado estructurado desde el último part no vacío", () => {
    const out = parseWorkerStructuredResultFromParts([
      "intermedio",
      `\`\`\`json
{"status":"done","summary_for_user":"Listo."}
\`\`\``,
    ]);
    expect(out?.summary_for_user).toBe("Listo.");
  });

  it("verifica el diff real contra pushed reportado", () => {
    const noDiff = verifyWorkerObservedDiff({ status: "done", pushed: true, summary_for_user: "Listo." }, []);
    expect(noDiff.map((i) => i.code)).toEqual(["reported_push_missing"]);

    const withDiff = verifyWorkerObservedDiff({ status: "done", pushed: false, summary_for_user: "Listo." }, [
      { repo: "wiki", added: [{ path: "a.md", sha: "a" }], removed: [], renamed: [], modified: [] },
    ]);
    expect(withDiff.map((i) => i.code)).toEqual(["real_changes_not_reported_pushed"]);
  });

  it("verifica borrados reales netos de notas markdown", () => {
    const issues = verifyWorkerObservedDiff(
      undefined,
      [
        {
          repo: "wiki",
          added: [{ path: "movida.md", sha: "same" }],
          removed: [
            { path: "vieja.md", sha: "old" },
            { path: "movida-vieja.md", sha: "same" },
            { path: "tmp.txt", sha: "txt" },
          ],
          renamed: [],
          modified: [],
        },
      ],
      { maxDeletedNotes: 0 },
    );
    expect(issues).toEqual([
      {
        code: "real_too_many_deletions",
        message: "se detectaron 1 borrados reales de notas .md (máximo 0)",
      },
    ]);
  });

  it("agrega advertencias externas de diff real al resumen inyectado", () => {
    const out = formatWorkerResultForCoordinator(["RESUMEN legacy"], 1000, {
      verificationIssues: [{ code: "reported_push_missing", message: "sin diff real" }],
    });
    expect(out).toContain("RESUMEN legacy");
    expect(out).toContain("Verificación real: sin diff real");
  });
});

describe("isSubstantialForTitle", () => {
  it("turno con tema real → true", () => {
    expect(isSubstantialForTitle("contame las noticias de hoy", "Hoy pasó X, Y, Z.")).toBe(true);
    expect(isSubstantialForTitle("ayudame a planear un viaje a Japón", "Dale, ¿cuándo viajás?")).toBe(true);
  });
  it("saludos / confirmaciones / despedidas → false (sin gastar haiku)", () => {
    for (const s of ["hola", "Hola!", "  gracias  ", "ok", "dale", "buenas noches", "chau", "jajaja"]) {
      expect(isSubstantialForTitle(s, "respuesta")).toBe(false);
    }
  });
  it("normaliza tildes y puntuación de borde antes de comparar", () => {
    expect(isSubstantialForTitle("¿buenas tardes?", "hola")).toBe(false); // tras normalizar = "buenas tardes"
    expect(isSubstantialForTitle("Adiós...", "hola")).toBe(false);
  });
  it("texto demasiado corto → false", () => {
    expect(isSubstantialForTitle("hi", "respuesta")).toBe(false);
    expect(isSubstantialForTitle("👍", "respuesta")).toBe(false);
  });
  it("sin respuesta del agente → false (no hay tema cerrado)", () => {
    expect(isSubstantialForTitle("contame algo interesante", "   ")).toBe(false);
  });
});

describe("REM planner estructurado", () => {
  it("arma un prompt de planner que prohíbe editar y exige JSON final", () => {
    const prompt = buildRemPlannerPrompt("notas", "Desde el último commit cambió agenda.md");
    expect(prompt).toContain('Planificá REM para la wiki "notas"');
    expect(prompt).toContain("NO edites archivos");
    expect(prompt).toContain("```json");
    expect(prompt).toContain("Desde el último commit cambió agenda.md");
  });

  it("instruye no-op explícito: delta sin trabajo → should_execute:false, sin inventar acciones", () => {
    const prompt = buildRemPlannerPrompt("notas", "El único cambio es un borrado intencional ya reflejado.");
    expect(prompt).toContain("should_execute:false");
    expect(prompt).toContain("actions:[]");
    expect(prompt).toContain("NUNCA inventes acciones");
    expect(prompt).toContain("sin consolidación necesaria");
  });

  it("parsea un plan no-op (should_execute:false, sin acciones)", () => {
    const plan = parseRemStructuredPlan(
      '```json\n{"risk":"low","should_execute":false,"requires_user_confirmation":false,' +
        '"summary":"nada que consolidar","actions":[],"report_for_user":"sin consolidación necesaria"}\n```',
    );
    expect(plan).toMatchObject({ should_execute: false, actions: [] });
  });

  describe("remPlanHasWork (guard mecánico anti-loop)", () => {
    const base = {
      risk: "low" as const,
      should_execute: true,
      requires_user_confirmation: false,
      summary: "x",
    };
    it("false cuando no hay acciones", () => {
      expect(remPlanHasWork({ ...base, actions: [] })).toBe(false);
    });
    it("false cuando todas las acciones son {type:'none'}", () => {
      expect(
        remPlanHasWork({ ...base, actions: [{ type: "none", path: "a.md", reason: "nada que hacer" }] }),
      ).toBe(false);
    });
    it("true cuando hay al menos una acción accionable", () => {
      expect(
        remPlanHasWork({
          ...base,
          actions: [
            { type: "none", path: "a.md", reason: "nada" },
            { type: "merge", path: "b.md", target: "c.md", reason: "duplicado" },
          ],
        }),
      ).toBe(true);
    });
  });

  it("parsea plan REM válido", () => {
    const plan = parseRemStructuredPlan(`
texto previo
\`\`\`json
{
  "risk": "medium",
  "should_execute": true,
  "requires_user_confirmation": false,
  "summary": "Consolidar notas duplicadas de viajes.",
  "actions": [
    { "type": "merge", "path": "viajes/japon.md", "target": "viajes/asia.md", "reason": "contenido duplicado" },
    { "type": "archive", "path": "inbox/viejo.md", "reason": "ruido obsoleto" }
  ],
  "blockers": [],
  "report_for_user": "Voy a consolidar dos notas."
}
\`\`\`
`);
    expect(plan).toEqual({
      risk: "medium",
      should_execute: true,
      requires_user_confirmation: false,
      summary: "Consolidar notas duplicadas de viajes.",
      actions: [
        { type: "merge", path: "viajes/japon.md", target: "viajes/asia.md", reason: "contenido duplicado" },
        { type: "archive", path: "inbox/viejo.md", reason: "ruido obsoleto" },
      ],
      report_for_user: "Voy a consolidar dos notas.",
    });
  });

  it("tolera escapes octales de UTF-8 que emiten los modelos locales (Gemma)", () => {
    // Gemma a veces emite "ñ" como \303\261 (bytes octales) dentro del JSON, que es inválido.
    const plan = parseRemStructuredPlan(
      '```json\n{"risk":"low","should_execute":true,"requires_user_confirmation":false,' +
        '"summary":"mover receta","actions":[{"type":"move","path":"trabajo/receta-\\303\\261oquis.md",' +
        '"target":"personal/receta-\\303\\261oquis.md","reason":"nota personal mal ubicada"}]}\n```',
    );
    expect(plan?.actions[0]?.path).toBe("trabajo/receta-ñoquis.md");
    expect(plan?.actions[0]?.target).toBe("personal/receta-ñoquis.md");
  });

  it("rechaza planes malformados o sin contrato mínimo", () => {
    expect(parseRemStructuredPlan("sin json")).toBeUndefined();
    expect(parseRemStructuredPlan("```json\n{ nope\n```")).toBeUndefined();
    expect(
      parseRemStructuredPlan(
        '```json\n{"risk":"high","should_execute":true,"requires_user_confirmation":false,"summary":"x"}\n```',
      ),
    ).toBeUndefined();
    expect(
      parseRemStructuredPlan(
        '```json\n{"risk":"extreme","should_execute":true,"requires_user_confirmation":false,"summary":"x","actions":[]}\n```',
      ),
    ).toBeUndefined();
  });

  it("formatea el plan para un executor y preserva la señal de riesgo", () => {
    const out = formatRemPlanForExecutor({
      risk: "high",
      should_execute: false,
      requires_user_confirmation: true,
      summary: "Hay riesgo de borrar demasiadas notas.",
      actions: [{ type: "delete", path: "archivo/ruido.md", reason: "posible duplicado, requiere revisión" }],
      blockers: ["borrados ambiguos"],
    });
    expect(out).toContain("Riesgo: high");
    expect(out).toContain("Ejecutar: no");
    expect(out).toContain("Requiere confirmación: sí");
    expect(out).toContain("- delete archivo/ruido.md: posible duplicado, requiere revisión");
    expect(out).toContain("Bloqueos: borrados ambiguos");
  });
});

describe("scoreRemRouting", () => {
  it("mantiene bajo un delta chico sin borrados", () => {
    expect(
      scoreRemRouting({
        firstRun: false,
        changedPaths: ["notas/a.md", "notas/b.md"],
        deletedPaths: [],
        threshold: 8,
      }),
    ).toMatchObject({ score: 2, tier: "low", usePlanner: false });
  });

  it("sube a planner con primera corrida o borrados/memoria", () => {
    expect(
      scoreRemRouting({ firstRun: true, changedPaths: [], deletedPaths: [], threshold: 8 }),
    ).toMatchObject({ tier: "medium", usePlanner: true });
    expect(
      scoreRemRouting({
        firstRun: false,
        changedPaths: ["memoria/familia.md"],
        deletedPaths: ["notas/vieja.md"],
        threshold: 8,
      }),
    ).toMatchObject({ score: 8, tier: "medium", usePlanner: true });
  });
});

describe("buildTitlePrompt", () => {
  it("arma system + user con el intercambio; sin prev no menciona OK", () => {
    const { system, user } = buildTitlePrompt("hola tema", "una respuesta");
    expect(system).toMatch(/2 a 5 palabras/);
    expect(system).not.toMatch(/OK/);
    expect(user).toContain("hola tema");
    expect(user).toContain("una respuesta");
  });
  it("con prev, instruye devolver OK si el tema no cambió", () => {
    const { system } = buildTitlePrompt("u", "a", "Noticias del mundo");
    expect(system).toContain("Noticias del mundo");
    expect(system).toMatch(/OK/);
  });
  it("capa los textos largos (slice 800) para no inflar el prompt", () => {
    const long = "x".repeat(2000);
    const { user } = buildTitlePrompt(long, long);
    expect(user.length).toBeLessThan(1800);
  });
});

describe("sanitizeTitle", () => {
  it("devuelve el título limpio", () => {
    expect(sanitizeTitle("Noticias del mundo")).toBe("Noticias del mundo");
  });
  it("saca comillas/«», prefijo «Título:» y puntuación de borde", () => {
    expect(sanitizeTitle('"Plan viaje a Japón"')).toBe("Plan viaje a Japón");
    expect(sanitizeTitle("«Receta de ñoquis»")).toBe("Receta de ñoquis");
    expect(sanitizeTitle("Título: Mudanza")).toBe("Mudanza");
    expect(sanitizeTitle("Noticias del mundo.")).toBe("Noticias del mundo");
  });
  it("OK (sentinel) / vacío → undefined (mantener el previo)", () => {
    expect(sanitizeTitle("OK")).toBeUndefined();
    expect(sanitizeTitle("  ok  ")).toBeUndefined();
    expect(sanitizeTitle("")).toBeUndefined();
    expect(sanitizeTitle("   ")).toBeUndefined();
  });
  it("idéntico al previo (case-insensitive) → undefined (no re-emitir)", () => {
    expect(sanitizeTitle("noticias del mundo", "Noticias del mundo")).toBeUndefined();
    expect(sanitizeTitle("Tema nuevo", "Tema viejo")).toBe("Tema nuevo");
  });
  it("colapsa espacios y capa el largo a 48 chars", () => {
    expect(sanitizeTitle("a    b   c")).toBe("a b c");
    const out = sanitizeTitle("x".repeat(80));
    expect(out?.length).toBe(48);
  });
});

describe("remNetDeletions — deletions netas del guardrail de REM (incidente 2026-06-09)", () => {
  it("cuenta sólo .md con status removed; lo no-.md no cuenta", () => {
    expect(
      remNetDeletions({
        added: [],
        removed: [
          { path: "notas/a.md", sha: "s1" },
          { path: "notas/b.md", sha: "s2" },
          { path: "img/foto.png", sha: "s3" }, // no es nota
        ],
      }),
    ).toEqual(["notas/a.md", "notas/b.md"]);
  });

  it("un move que git no detectó como rename (D+A con el MISMO blob) no cuenta", () => {
    expect(
      remNetDeletions({
        added: [{ path: "archivo/2026/a.md", sha: "sameblob" }],
        removed: [
          { path: "notas/a.md", sha: "sameblob" }, // movida → el contenido sigue vivo
          { path: "notas/b.md", sha: "gone" }, // borrada de verdad
        ],
      }),
    ).toEqual(["notas/b.md"]);
  });

  it("sha vacío (GitHub no lo dio) NO matchea added vacíos: cuenta como borrado real (conservador)", () => {
    expect(
      remNetDeletions({
        added: [{ path: "x.md", sha: "" }],
        removed: [{ path: "y.md", sha: "" }],
      }),
    ).toEqual(["y.md"]);
  });

  it("sin removed → vacío (los renames detectados por git ni siquiera llegan acá)", () => {
    expect(remNetDeletions({ added: [{ path: "n.md", sha: "s" }], removed: [] })).toEqual([]);
  });
});

describe("remMaxDeletions — parseo del tope REM_MAX_DELETIONS", () => {
  it("default 10 sin env; acepta valores explícitos incluido 0", () => {
    expect(remMaxDeletions(undefined)).toBe(10);
    expect(remMaxDeletions("25")).toBe(25);
    expect(remMaxDeletions("0")).toBe(0);
  });
  it("basura, vacío o negativos caen al default (no a 0: 0 revertiría todo)", () => {
    expect(remMaxDeletions("abc")).toBe(10);
    expect(remMaxDeletions("")).toBe(10);
    expect(remMaxDeletions("-3")).toBe(10);
  });
});

describe("remForeignCommits — atribución de commits del rango del guardrail (review 2026-06-10)", () => {
  const REM_USER = 7;
  const commit = (sha: string, message = `msg ${sha}`) => ({ sha, message });
  const agentRow = (ref: string, userId = REM_USER) => ({ ref, source: "agent", userId });

  it("todos los commits con fila agent + userId de la corrida → vacío (auto-revert seguro)", () => {
    expect(
      remForeignCommits([commit("c1"), commit("c2")], [agentRow("c1"), agentRow("c2")], REM_USER),
    ).toEqual([]);
  });

  it("commit SIN fila en el feed (push git directo) → foreign", () => {
    const out = remForeignCommits([commit("c1"), commit("c2")], [agentRow("c1")], REM_USER);
    expect(out.map((f) => f.sha)).toEqual(["c2"]);
    expect(out[0]?.why).toMatch(/push directo/);
  });

  it("edición web del usuario en el rango → foreign (NO se le imputa a REM)", () => {
    const out = remForeignCommits(
      [commit("c1"), commit("cweb", "guardé desde el editor")],
      [agentRow("c1"), { ref: "cweb", source: "web", userId: REM_USER }],
      REM_USER,
    );
    expect(out).toEqual([{ sha: "cweb", message: "guardé desde el editor", why: "edición web del usuario" }]);
  });

  it("commit de agente de OTRO usuario → foreign", () => {
    const out = remForeignCommits([commit("c1")], [agentRow("c1", 99)], REM_USER);
    expect(out[0]?.why).toMatch(/OTRO usuario/);
  });

  it("fila del watcher out-of-band (source null) NO atribuye", () => {
    const out = remForeignCommits([commit("c1")], [{ ref: "c1", source: null, userId: null }], REM_USER);
    expect(out[0]?.why).toMatch(/watcher out-of-band/);
  });

  it("filas duplicadas para el mismo sha (race watcher/sync): alcanza UNA atribuible", () => {
    const out = remForeignCommits(
      [commit("c1")],
      [
        { ref: "c1", source: null, userId: null }, // el watcher lo vio primero
        agentRow("c1"), // el sync lo registró después
      ],
      REM_USER,
    );
    expect(out).toEqual([]);
  });

  it("source 'rem' (reservado) también atribuye", () => {
    expect(
      remForeignCommits([commit("c1")], [{ ref: "c1", source: "rem", userId: REM_USER }], REM_USER),
    ).toEqual([]);
  });

  it("sin commits → vacío (rango vacío: nada que atribuir)", () => {
    expect(remForeignCommits([], [agentRow("x")], REM_USER)).toEqual([]);
  });
});

// --- Higiene de mensajes al usuario (incidente 2026-06-10: no filtrar interna) -----------------

describe("isInternalDetail", () => {
  it("detecta la interna típica del backend local (VMs, env ids, cp.sh, conteos, IPs)", () => {
    const dirty = [
      "opencode cold-start de ceibo-demo-gpuhost-env_013CMPPUUQY4YWv8ZFafECzg falló tras 8 intentos",
      "cp.sh serve vm1 exit 1: serve no respondió en archima-ceibo-demo",
      "agent-vault vault create u1 exit 2: boom",
      "archima exec timeout (60000ms): cp.sh serve vm1",
      "VM en 192.168.122.42 sin respuesta",
      "sesión no vinculada: ses_8a3bc91q",
      "opencode POST /session 502: bad gateway",
      "fetch failed",
      "connect ECONNREFUSED 10.0.0.1:14420",
    ];
    for (const m of dirty) expect(isInternalDetail(m), m).toBe(true);
  });

  it("deja pasar mensajes inocuos aptos para el usuario", () => {
    expect(isInternalDetail("Falta el token de autorización.")).toBe(false);
    expect(isInternalDetail("No tenés wikis configuradas.")).toBe(false);
  });
});

describe("publicErrorReason", () => {
  it("reemplaza el detalle interno por el fallback (el crudo va al log, no al canal)", () => {
    const e = new Error("opencode cold-start de ceibo-demo-env_013CMPP falló tras 8 intentos: cp.sh serve …");
    expect(publicErrorReason(e, "no pude conectar con tu entorno")).toBe("no pude conectar con tu entorno");
  });

  it("conserva un mensaje inocuo (capado a 160)", () => {
    expect(publicErrorReason(new Error("Falta el token de autorización."), "x")).toBe(
      "Falta el token de autorización.",
    );
    const long = new Error(`pasó algo raro ${"y".repeat(300)}`);
    expect(publicErrorReason(long, "x").length).toBeLessThanOrEqual(161); // 160 + elipsis
  });

  it("error vacío/raro → fallback", () => {
    expect(publicErrorReason(undefined, "fallback")).toBe("fallback");
    expect(publicErrorReason(new Error("   "), "fallback")).toBe("fallback");
  });
});

describe("controlUrlSecret (fail-fast del control: el secret de la URL debe == CONTROL_MCP_SECRET)", () => {
  it("extrae el secret del path, sin slash/query/fragment", () => {
    expect(controlUrlSecret("https://staging.ceibo.example.com/mcp/control/abc123")).toBe("abc123");
    expect(controlUrlSecret("https://x/mcp/control/abc123/")).toBe("abc123");
    expect(controlUrlSecret("https://x/mcp/control/abc123?q=1")).toBe("abc123");
    expect(controlUrlSecret("https://x/mcp/control/abc123#f")).toBe("abc123");
  });

  it("'' si la URL no tiene el path del control (no matchea por accidente)", () => {
    expect(controlUrlSecret("https://staging.ceibo.example.com/")).toBe("");
    expect(controlUrlSecret("https://x/mcp/viewer/abc")).toBe("");
    expect(controlUrlSecret("")).toBe("");
  });

  it("cazaría el incidente: URL con un secret distinto a CONTROL_MCP_SECRET", () => {
    const url = "https://staging.ceibo.example.com/mcp/control/dc9c48charsdeprodcopiado";
    const secret = "ecdc32charsregenerado";
    expect(controlUrlSecret(url)).not.toBe(secret); // ← el fail-fast tira en este caso
    expect(controlUrlSecret(url)).toBe("dc9c48charsdeprodcopiado");
  });
});

describe("sessionFingerprint", () => {
  it("es corto, estable y NO contiene el id real (nombre de VM / env id)", () => {
    const sid = "ceibo-demo-gpuhost-env_013CMPPUUQY4YWv8ZFafECzg";
    const fp = sessionFingerprint(sid);
    expect(fp).toMatch(/^#[0-9a-f]{8}$/);
    expect(fp).toBe(sessionFingerprint(sid)); // estable por sesión (sirve para soporte)
    expect(fp).not.toContain("env_013");
    expect(sessionFingerprint("otro-sid")).not.toBe(fp);
  });
});
