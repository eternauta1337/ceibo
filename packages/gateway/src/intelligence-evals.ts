/** Casos de evaluación de inteligencia del asistente.
 *
 * Esta suite NO llama modelos todavía: define el contrato versionado de casos y expectativas para
 * que después podamos correrlos contra archima/MA y comparar modelos por rol. El primer uso es
 * offline: asegurar cobertura de áreas críticas y que cada caso tenga expectativas accionables
 * (tool/action/guardrail), no sólo "respuesta linda".
 */

export type EvalArea =
  | "conversation"
  | "delegation"
  | "notes"
  | "memory"
  | "schedule"
  | "connections"
  | "rem"
  | "voice";

export type EvalBackend = "archima" | "ma" | "any";

export interface IntelligenceEvalCase {
  id: string;
  area: EvalArea;
  backend: EvalBackend;
  description: string;
  input: string;
  facts?: string[];
  expected: {
    /** Tool/capability principal que esperamos ver, si aplica. */
    tool?: string;
    /** Acción observable esperada: crear nota, despachar sub-agente, agendar, etc. */
    action: string;
    /** Cosas que NO deben aparecer o pasar (git crudo, bluff de sub-agente, mutación externa). */
    forbids?: string[];
  };
}

export interface IntelligenceEvalReport {
  total: number;
  byArea: Record<EvalArea, number>;
  byBackend: Record<EvalBackend, number>;
  actionable: number;
  withForbids: number;
}

export interface IntelligenceEvalScore {
  id: string;
  passed: boolean;
  score: number;
  checks: {
    nonEmpty: boolean;
    tool?: boolean;
    forbids: { term: string; passed: boolean }[];
  };
}

export const CRITICAL_EVAL_AREAS: EvalArea[] = [
  "conversation",
  "delegation",
  "notes",
  "memory",
  "schedule",
  "connections",
  "rem",
  "voice",
];

export const INTELLIGENCE_EVALS: IntelligenceEvalCase[] = [
  {
    id: "conversation-direct-answer",
    area: "conversation",
    backend: "any",
    description: "Pregunta conversacional simple: responder directo sin despachar workers.",
    input: "Como venimos con la arquitectura del coordinador local?",
    expected: {
      action: "responde con criterio directo",
      forbids: ["subagent_spawn", "lectura de wiki innecesaria"],
    },
  },
  {
    id: "delegation-complex-wiki",
    area: "delegation",
    backend: "archima",
    description: "Pedido multi-paso sobre wiki: el coordinador debe despachar worker primero.",
    input: "Reorganizame las notas de viajes y dejame un indice prolijo.",
    facts: ["[wikis: demo-personal (en foco: demo-personal)]"],
    expected: {
      tool: "subagent_spawn",
      action: "despacha worker con goal autocontenido",
      forbids: ["bash antes de subagent_spawn", "leer wiki desde coordinador", "anunciar sin tool-call"],
    },
  },
  {
    id: "notes-create-blank",
    area: "notes",
    backend: "any",
    description: "Abrir una nota en blanco en la vista web: usar viewer_create, no inventar contenido.",
    input: "Abrime una nota nueva para pensar el viaje a Japon.",
    facts: ["[canal: web]", "[wikis: demo-personal (en foco: demo-personal)]"],
    expected: {
      tool: "viewer_create",
      action: "crea y abre nota vacia con path realista",
      forbids: ["viewer_open para path inexistente", "resumen en chat en vez de abrir nota"],
    },
  },
  {
    id: "notes-search-simple",
    area: "notes",
    backend: "archima",
    description: "Pregunta simple sobre notas: el coordinador busca con notes_search (híbrida) primero.",
    input: "Donde anote lo del colegio de los chicos?",
    facts: ["[wikis: demo-personal (en foco: demo-personal)]"],
    expected: {
      tool: "notes_search",
      action: "busca con notes_search y lee/abre la nota encontrada",
      forbids: ["respuesta inventada sin fuente", "git crudo", "grep antes de intentar notes_search"],
    },
  },
  {
    id: "notes-search-semantica",
    area: "notes",
    backend: "archima",
    description: "Búsqueda por paráfrasis (el literal no está en la nota): sólo la semántica la encuentra.",
    input: "Que habiamos dicho de la comida con la familia el finde?",
    facts: ["[wikis: demo-personal (en foco: demo-personal)]"],
    expected: {
      tool: "notes_search",
      action: "usa notes_search en modo hybrid (default) — no lexical — y cita la nota fuente",
      forbids: ["grep de literales como unica via", "respuesta inventada sin fuente"],
    },
  },
  {
    id: "memory-durable-fact",
    area: "memory",
    backend: "archima",
    description: "Hecho durable: debe terminar persistido en memoria personal.",
    input: "Acordate que a Uma no le gusta la banana.",
    facts: ["[wikis: demo-personal (en foco: demo-personal)]"],
    expected: {
      tool: "subagent_spawn",
      action: "actualiza memoria personal sin duplicar contradicciones",
      forbids: ["guardar en wiki compartida", "pedir permiso para dato durable simple"],
    },
  },
  {
    id: "schedule-relative-time",
    area: "schedule",
    backend: "any",
    description: "Recordatorio relativo: usar fecha actual con offset y schedule_create.",
    input: "Acordame en 20 minutos de sacar la ropa del lavarropas.",
    facts: ["[fecha y hora actual: 2026-06-13T10:00:00-03:00]"],
    expected: {
      tool: "schedule_create",
      action: "agenda timestamp ISO con offset -03:00",
      forbids: ["usar hora UTC como local", "crear tarea markdown en vez de cron"],
    },
  },
  {
    id: "connections-gmail",
    area: "connections",
    backend: "any",
    description: "Conectar cuenta externa: usar tool semantica y pasar auth_url.",
    input: "Quiero conectar mi Gmail personal.",
    expected: {
      tool: "connect_service",
      action: "conecta gmail perfil personal y devuelve link de autorizacion",
      forbids: ["pedir comando /connect", "mandar a pantalla de configuracion inexistente"],
    },
  },
  {
    id: "voice-mirror",
    area: "voice",
    backend: "any",
    description: "Entrada por voz: respuesta corta debe espejar con marcador de voz.",
    input: "Que tengo para hoy?",
    facts: ["[el usuario te habló por una nota de voz]"],
    expected: {
      action: "responde con [[voice]] si no hay links/codigo/tablas",
      forbids: ["decir que no puede procesar audio", "dictar URLs"],
    },
  },
  {
    id: "rem-first-pass",
    area: "rem",
    backend: "archima",
    description: "Primera corrida REM: debe ser conservadora y worker/batch, no coordinador.",
    input: "/rem demo-personal",
    facts: ["watermark: null"],
    expected: {
      action: "abre sesion REM worker con scope completo y guardrails",
      forbids: ["subagent_spawn en loop", "borrado masivo sin guardrail", "avanzar cursor si falla baseline"],
    },
  },
  {
    id: "rem-incremental-no-changes",
    area: "rem",
    backend: "archima",
    description: "REM incremental sin cambios: reporta corto y no reescanea wiki completa.",
    input: "/rem demo-personal",
    facts: ["watermark: deadbeef", "delta: []"],
    expected: {
      action: "reporte sin cambios y fin de turno",
      forbids: ["hydrate full innecesario", "ediciones sin delta"],
    },
  },
];

export function validateIntelligenceEvalSuite(cases: IntelligenceEvalCase[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) errors.push(`id duplicado: ${c.id}`);
    seen.add(c.id);
    if (!c.input.trim()) errors.push(`${c.id}: input vacio`);
    if (!c.expected.action.trim()) errors.push(`${c.id}: expected.action vacio`);
    if (!c.expected.tool && (!c.expected.forbids || c.expected.forbids.length === 0)) {
      errors.push(`${c.id}: sin tool ni forbids, la expectativa no es accionable`);
    }
  }
  for (const area of CRITICAL_EVAL_AREAS) {
    if (!cases.some((c) => c.area === area)) errors.push(`falta area critica: ${area}`);
  }
  return errors;
}

export function evalCoverage(cases: IntelligenceEvalCase[]): Record<EvalArea, number> {
  const out = Object.fromEntries(CRITICAL_EVAL_AREAS.map((area) => [area, 0])) as Record<EvalArea, number>;
  for (const c of cases) out[c.area] = (out[c.area] ?? 0) + 1;
  return out;
}

export function evalReport(cases: IntelligenceEvalCase[]): IntelligenceEvalReport {
  const byBackend: Record<EvalBackend, number> = { any: 0, archima: 0, ma: 0 };
  let actionable = 0;
  let withForbids = 0;
  for (const c of cases) {
    byBackend[c.backend]++;
    if (c.expected.tool || c.expected.action.trim()) actionable++;
    if ((c.expected.forbids?.length ?? 0) > 0) withForbids++;
  }
  return {
    total: cases.length,
    byArea: evalCoverage(cases),
    byBackend,
    actionable,
    withForbids,
  };
}

export function formatEvalReport(report: IntelligenceEvalReport): string {
  const areas = CRITICAL_EVAL_AREAS.map((area) => `${area}:${report.byArea[area]}`).join(" ");
  const backends = (Object.entries(report.byBackend) as Array<[EvalBackend, number]>)
    .map(([backend, n]) => `${backend}:${n}`)
    .join(" ");
  return [
    `evals total:${report.total}`,
    `areas ${areas}`,
    `backends ${backends}`,
    `actionable:${report.actionable}`,
    `with_forbids:${report.withForbids}`,
  ].join("\n");
}

export function scoreEvalOutput(c: IntelligenceEvalCase, output: string): IntelligenceEvalScore {
  const lower = output.toLowerCase();
  const nonEmpty = output.trim().length > 0;
  const tool = c.expected.tool ? lower.includes(c.expected.tool.toLowerCase()) : undefined;
  const forbids = (c.expected.forbids ?? []).map((term) => ({
    term,
    passed: !lower.includes(term.toLowerCase()),
  }));
  const checks = [nonEmpty, tool, ...forbids.map((f) => f.passed)].filter(
    (v): v is boolean => v !== undefined,
  );
  const passed = checks.every(Boolean);
  const score = checks.filter(Boolean).length / checks.length;
  return { id: c.id, passed, score, checks: { nonEmpty, tool, forbids } };
}
