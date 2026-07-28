// Helpers de presentación del CLI: formateo de números y render del consumo como
// barras. Puros (sin I/O ni store) → testeables aparte del dispatcher de comandos.

import type { BroadcastRow, DailyRow, ModelUsageRow, SpendRow } from "@ceibo/store";

/** "owner (Nombre)" si tiene nombre, si no el handle pelado. */
export function label(u: { handle: string; name: string | null }): string {
  return u.name ? `${u.handle} (${u.name})` : u.handle;
}

/** Entero con separador de miles (en-US). */
export function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

export const BAR_WIDTH = 30;

/** Barra horizontal: `value/max` lleno con █ sobre un track de ░ de ancho fijo. */
export function bar(value: number, max: number): string {
  const n = max > 0 ? Math.round((value / max) * BAR_WIDTH) : 0;
  return "█".repeat(n) + "░".repeat(BAR_WIDTH - n);
}

/** Render del consumo diario como barras horizontales (una fila por día). */
export function renderDaily(rows: DailyRow[], single: boolean): string {
  if (rows.length === 0) return "(sin consumo registrado)";
  const days = [...new Set(rows.map((r) => r.day))].sort();
  const span = `BA, ${days[0]} → ${days[days.length - 1]}`;

  if (single) {
    // Un usuario: barra por día, escalada a su propio máximo (la forma se ve plena).
    const max = Math.max(...rows.map((r) => r.cost_usd));
    const total = rows.reduce((s, r) => s + r.cost_usd, 0);
    const out = [`Consumo diario · ${rows[0]?.handle} (${span})`, ""];
    for (const r of rows) {
      out.push(
        `${r.day.slice(5)}  ${bar(r.cost_usd, max)}  $${r.cost_usd.toFixed(4).padStart(8)}  ${String(r.turns).padStart(4)}t`,
      );
    }
    out.push("", `TOTAL: $${total.toFixed(4)}`);
    return out.join("\n");
  }

  // Varios usuarios: una sección por usuario, escala GLOBAL (barras comparables).
  const max = Math.max(...rows.map((r) => r.cost_usd));
  const byUser = new Map<string, DailyRow[]>();
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (!byUser.has(r.handle)) byUser.set(r.handle, []);
    byUser.get(r.handle)?.push(r);
    totals.set(r.handle, (totals.get(r.handle) ?? 0) + r.cost_usd);
  }
  const handles = [...byUser.keys()].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
  const out = [`Consumo diario (${span}) · barras a escala común`, ""];
  for (const h of handles) {
    out.push(`${h}  ·  $${(totals.get(h) ?? 0).toFixed(4)}`);
    for (const r of byUser.get(h) ?? []) {
      out.push(`  ${r.day.slice(5)}  ${bar(r.cost_usd, max)}  $${r.cost_usd.toFixed(4).padStart(8)}`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd();
}

/** ¿La respuesta a un prompt de confirmación es afirmativa? (si/sí/s/y/yes, case-insensitive). */
export function isYes(answer: string): boolean {
  return /^(si|sí|s|y|yes)$/i.test(answer.trim());
}

/** Línea de auditoría de un broadcast enviado (`broadcast list`). */
export function broadcastLine(b: BroadcastRow): string {
  const failed = b.failed_count ? ` · ${b.failed_count} fallaron` : "";
  const preview = b.text.replace(/\n/g, " ").slice(0, 70);
  return `#${b.id}  ${b.created_at}  →  ${b.sent_count} ok${failed}\n   ${preview}`;
}

/** Reporte de gasto por usuario (header + bloque por usuario + TOTAL si hay >1).
 *  "" si no hay filas (el caller muestra "(sin usuarios)"). */
export function renderSpendReport(rows: SpendRow[], markup: number): string {
  if (rows.length === 0) return "";
  const out = [`Gasto por usuario (markup ×${markup})`, ""];
  let total = 0;
  for (const r of rows) {
    total += r.cost_usd;
    out.push(
      `${label(r)}\n` +
        `   turnos:${r.turns}  in:${fmtInt(r.input_tokens)}  out:${fmtInt(r.output_tokens)}  ` +
        `cache(5m/1h/read):${fmtInt(r.cache_5m_tokens)}/${fmtInt(r.cache_1h_tokens)}/${fmtInt(r.cache_read_tokens)}\n` +
        `   USD: $${r.cost_usd.toFixed(4)}`,
    );
  }
  if (rows.length > 1) out.push(`\nTOTAL: $${total.toFixed(4)}`);
  return out.join("\n");
}

export function renderModelUsage(rows: ModelUsageRow[], days?: number): string {
  if (rows.length === 0) return "(sin consumo registrado)";
  const out = [`Uso por modelo${days ? ` · últimos ${days} día(s)` : ""}`, ""];
  let totalCost = 0;
  let totalTurns = 0;
  for (const r of rows) {
    totalCost += r.cost_usd;
    totalTurns += r.turns;
    out.push(
      `${r.model}\n` +
        `   turnos:${r.turns}  usuarios:${r.users}  in:${fmtInt(r.input_tokens)}  out:${fmtInt(r.output_tokens)}  ` +
        `cache_read:${fmtInt(r.cache_read_tokens)}\n` +
        `   USD: $${r.cost_usd.toFixed(4)}`,
    );
  }
  out.push("", `TOTAL: ${totalTurns} turnos · $${totalCost.toFixed(4)}`);
  return out.join("\n");
}
