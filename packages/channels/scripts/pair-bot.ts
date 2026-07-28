#!/usr/bin/env node
// Parea el número del BOT de WhatsApp a su store dedicado (`wacliBotStoreDir()`), una sola
// vez, en la box. NO es un servicio: corre `wacli auth` interactivo (stdio heredado → la UI
// de QR / pairing-code de wacli aparece en tu terminal), paréa, hace el backfill inicial y
// sale. Después el gateway levanta el canal con `WHATSAPP_BOT_ENABLED=1`.
//
//   pnpm --filter @ceibo/channels pair-bot                 # QR (escaneás con el celu del bot)
//   pnpm --filter @ceibo/channels pair-bot -- --phone +5491100000000   # pairing-code
//
// El store sale de WHATSAPP_BOT_STORE (o `<WACLI_STORE_ROOT>/_bot`); el binario de WACLI_BIN.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { wacliBotStoreDir } from "@ceibo/store";

// Carga el .env del root del monorepo (best-effort) para WHATSAPP_BOT_STORE / WACLI_STORE_ROOT.
try {
  const envUrl = new URL("../../../.env", import.meta.url);
  if (existsSync(envUrl)) process.loadEnvFile(envUrl);
} catch {
  /* sin .env → seguimos con el entorno actual */
}

const bin = process.env.WACLI_BIN ?? "wacli";
const store = wacliBotStoreDir();

// `--phone +E.164` opcional → pairing-code en vez de QR. Pasale lo que venga tras `--`.
const phoneIdx = process.argv.indexOf("--phone");
const phone = phoneIdx >= 0 ? process.argv[phoneIdx + 1] : undefined;

const args = ["auth", "--store", store, "--download-media"];
if (phone) args.push("--phone", phone);

console.log(`Pareando el bot de WhatsApp · store=${store}${phone ? ` · phone=${phone}` : " · QR"}`);
console.log("Seguí las instrucciones de wacli (escaneá el QR o ingresá el código en WhatsApp).\n");

const child = spawn(bin, args, { stdio: "inherit", env: process.env });
child.on("error", (err) => {
  console.error(`No pude correr ${bin}: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code) => {
  if (code === 0) {
    console.log("\n✅ Bot pareado. Activá el canal con WHATSAPP_BOT_ENABLED=1 y reiniciá el gateway.");
  } else {
    console.error(`\nwacli auth salió con código ${code}.`);
  }
  process.exit(code ?? 1);
});
