// El prompt se compone de un core agnóstico + el adapter del backend. Este test fija que el core
// (persona + voz) lo heredan los dos, y que cada adapter aporta SU mecánica.

import { describe, expect, it } from "vitest";
import { composeArchimaRolePrompt, composePrompt } from "../prompt/compose.ts";

describe("composePrompt", () => {
  const ma = composePrompt("ma");
  const archima = composePrompt("archima");

  it("el core (persona + voz) está en LOS DOS backends", () => {
    for (const p of [ma, archima]) {
      expect(p).toContain("Te llamás CEIBO"); // persona
      expect(p).toContain("[[voice]]"); // convención de voz
      expect(p).toContain("IDIOMA:"); // idioma
    }
  });

  it("MA prohíbe git crudo para las wikis (el sync va por wiki-sync.mjs)", () => {
    // El git nativo se cuelga en el sandbox de MA → toda sync va por el script, nunca git.
    expect(ma).toContain("git pull"); // se nombra para prohibirlo
    expect(ma).toMatch(/NUNCA (uses git|git para las wikis|corras git)/);
  });

  it("archima trabaja las notas por las tools de la DB, NO git ni el script de MA (git desconectado)", () => {
    // Cutover F3/F4: las notas viven en la DB; el agente lee/escribe con notes_*, no con git.
    expect(archima).toContain("notes_");
    expect(archima).not.toContain("GIT NATIVO");
    expect(archima).not.toContain("git -C ~/work");
    expect(archima).not.toContain("wiki-sync.mjs"); // el script de MA no se filtra a archima
  });

  it("el adapter MA aporta su mecánica (wiki-sync.mjs, roster)", () => {
    expect(ma).toContain("/mnt/session/uploads/wiki-sync.mjs");
    expect(ma).toContain("worker-low");
    expect(ma).not.toContain("opencode"); // mecánica de archima no se filtra
  });

  it("MA enseña las tools semánticas de conexión, NUNCA el comando /connect", () => {
    expect(ma).toContain("connect_service");
    expect(ma).toContain("connect_whatsapp");
    expect(ma).not.toContain("/connect"); // el comando-string no debe aparecer en el prompt
  });

  it("MA sustituye el username del bot de Telegram desde el env (sin placeholder crudo)", () => {
    expect(ma).not.toContain("{{TELEGRAM_BOT_USERNAME}}"); // placeholder resuelto
    expect(ma).toMatch(/https:\/\/t\.me\/\S+/); // queda un link concreto
    // El default es "ceibo" si la var no está en el env del test.
    const withEnv = (() => {
      process.env.TELEGRAM_BOT_USERNAME = "ceibo_test_bot";
      try {
        return composePrompt("ma");
      } finally {
        delete process.env.TELEGRAM_BOT_USERNAME;
      }
    })();
    expect(withEnv).toContain("https://t.me/ceibo_test_bot");
  });

  it("el adapter archima aporta su mecánica (opencode) sin filtrar el mount de MA", () => {
    expect(archima).toContain("opencode");
    expect(archima).toContain("task"); // sub-agentes de opencode
    expect(archima).not.toContain("/mnt/session/uploads"); // el mount de MA no se filtra
  });

  it("archima enseña notes_search para buscar y notes_read para leer (git desconectado)", () => {
    expect(archima).toContain("notes_search");
    expect(archima).toContain("notes_read");
    expect(archima).not.toContain("note_snippet"); // el fósil viejo no vuelve
  });

  it("el WORKER (ceibo-worker vivo) escribe por las tools notes_*, NO por git/archivos", () => {
    const worker = composeArchimaRolePrompt("worker");
    for (const t of ["notes_create", "notes_write", "notes_delete", "notes_move", "notes_batch"]) {
      expect(worker).toContain(t);
    }
    expect(worker).not.toContain("git -C ~/work"); // no escribe por git
    expect(worker).not.toContain("git push");
  });

  it("el COORDINADOR no grepea el clon para leer notas (lee por notes_*)", () => {
    const coordinator = composeArchimaRolePrompt("coordinator");
    expect(coordinator).toContain("notes_search");
    expect(coordinator).not.toContain("git -C ~/work");
  });

  it("el COORDINADOR (ceibo.md vivo, delegv2) también enseña notes_search — es el prompt que corre en las VMs", () => {
    // Bug real (staging 2026-07-11): actualizamos adapter-archima pero el prompt vivo del
    // coordinador se genera de coordinator-archima.md → el agente seguía greppeando y decía
    // "NO existe ningún tool de búsqueda custom".
    const coordinator = composeArchimaRolePrompt("coordinator");
    expect(coordinator).toContain("notes_search");
    expect(coordinator).toContain("notes_read");
    expect(coordinator).not.toContain("NO existe ningún tool de búsqueda custom");
    expect(coordinator).toContain("grep"); // fallback sigue
  });

  it("archima TAMBIÉN enseña las tools semánticas de conexión, NUNCA /connect ni 'config → Canales'", () => {
    // archima usa el MISMO control MCP + servers OAuth que MA (buildAgentMcpConfig es compartido):
    // SÍ puede conectar cuentas. El prompt no debe decir que no, ni alucinar una pantalla de config.
    expect(archima).toContain("connect_service");
    expect(archima).toContain("connect_whatsapp");
    expect(archima).not.toContain("/connect"); // el comando-string no debe aparecer en el prompt
    // Guía de onboarding presente: Telegram (link al bot) + WhatsApp (vinculación por código).
    expect(archima).toContain("CONECTAR TELEGRAM");
    expect(archima).toContain("Dispositivos vinculados");
  });

  it("archima sustituye el username del bot de Telegram desde el env (sin placeholder crudo)", () => {
    // La sustitución de composePrompt corre para LOS DOS backends, no solo MA.
    expect(archima).not.toContain("{{TELEGRAM_BOT_USERNAME}}"); // placeholder resuelto
    expect(archima).toMatch(/https:\/\/t\.me\/\S+/); // queda un link concreto
    const withEnv = (() => {
      process.env.TELEGRAM_BOT_USERNAME = "ceibo_test_bot";
      try {
        return composePrompt("archima");
      } finally {
        delete process.env.TELEGRAM_BOT_USERNAME;
      }
    })();
    expect(withEnv).toContain("https://t.me/ceibo_test_bot");
  });

  it("el adapter archima refuerza la guía de modalidad voz/texto (Gemma la sigue peor)", () => {
    // El modelo local sobre-emite `[[voice]]`; el adapter la refuerza corta e imperativa,
    // reusando los MISMOS marcadores de core.md. El refuerzo NO debe filtrarse a MA.
    expect(archima).toContain("VOZ vs TEXTO");
    expect(archima).toContain("[[voice]]"); // mismo marcador que core.md
    expect(archima).toContain("[el usuario te habló por una nota de voz]"); // señal de entrada por voz
    expect(ma).not.toContain("VOZ vs TEXTO"); // el refuerzo es solo-local
  });
});
