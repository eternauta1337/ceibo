import { defineConfig } from "vitest/config";

// Harness único del monorepo: un solo `vitest run` desde el root descubre todos
// los *.test.ts co-locados bajo packages/*/src. Entorno node para todos los
// packages del alcance (web/jsdom queda fuera).
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // `all: true` (default) instrumenta también lo no importado → denominador honesto.
      // No excluimos index.ts: en varios packages (oauth, agent, channels) es la lógica
      // real, no un barrel — excluirlo escondería lo que justamente cubrimos.
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts"],
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
      // Ratchet por-archivo: piso de líneas para lo YA cubierto (redondeado hacia
      // abajo desde lo medido, para absorber ruido). Una regresión bajo el piso
      // rompe CI; los archivos sin piso son informacionales (no bloquean). Subir los
      // pisos es un cambio explícito a mano — autoUpdate OFF a propósito (preferimos
      // un diff revisado a un config que se reescribe solo).
      thresholds: {
        autoUpdate: false,
        "packages/channels/src/protocol.ts": { lines: 95 },
        "packages/cli/src/format.ts": { lines: 95 },
        "packages/gateway/src/logic.ts": { lines: 95 },
        "packages/web-server/src/http.ts": { lines: 95 },
        "packages/oauth/src/server-logic.ts": { lines: 95 },
        "packages/oauth/src/engine.ts": { lines: 90 }, // e2e PKCE start→callback (Ola 5)
        "packages/mcps/src/core/google.ts": { lines: 95 },
        "packages/mcps/src/core/transport.ts": { lines: 95 },
        "packages/wikis/src/substrate.ts": { lines: 95 },
        "packages/gateway/src/wiki-sync-mount.ts": { lines: 90 },
        "packages/oauth/src/index.ts": { lines: 95 },
        "packages/web-server/src/google-auth.ts": { lines: 95 },
        "packages/mcps/src/servers/gmail.ts": { lines: 78 },
        "packages/mcps/src/servers/calendar.ts": { lines: 95 },
        "packages/mcps/src/servers/sheets.ts": { lines: 95 },
        "packages/mcps/src/servers/drive.ts": { lines: 95 },
        "packages/mcps/src/servers/notion.ts": { lines: 90 },
        "packages/mcps/src/servers/schedule.ts": { lines: 90 },
        "packages/store/src/index.ts": { lines: 80 },
        "packages/channels/src/telegram.ts": { lines: 25 },
        "packages/channels/src/state-memory.ts": { lines: 95 },
        "packages/agent/src/index.ts": { lines: 80 },
        "packages/mcps/src/servers/wacli.ts": { lines: 50 },
        "packages/speech/src/index.ts": { lines: 35 },
        "packages/gateway/src/wacli.ts": { lines: 22 },
        "packages/gateway/src/engine.ts": { lines: 20 }, // e2e cli→motor→Sink (Ola 5); sube con más e2e
        "packages/wikis/src/index.ts": { lines: 30 },
        "packages/gateway/src/models.ts": { lines: 95 },
        "packages/web-server/src/path-safety.ts": { lines: 95 },
        "packages/web-server/src/models.ts": { lines: 95 },
        "packages/web-server/src/web.ts": { lines: 33 }, // e2e HTTP real + SSE (Ola 5); sube con más e2e
      },
    },
  },
});
