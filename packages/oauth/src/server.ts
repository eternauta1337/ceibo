// Servicio OAuth — proceso público propio (no el gateway). Bootstrap.
//
// Lee el entorno, construye las dependencias (Anthropic, DB) y monta el motor
// (`createOauthServer` en `./engine.ts` — el state-machine del enrollment PKCE) en un
// `http.createServer`. Escucha en :8000; el edge de vps.example.com termina TLS para
// https://<box>ceibo.example.com y proxea a 127.0.0.1:8000. El motor no tiene side-effects de
// arranque: viven acá.
//
//   pnpm start   (carga .env automáticamente)

import { createServer } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { makeMaBackend, type SessionBackend } from "@ceibo/agent";
import { makeArchimaBackend } from "@ceibo/backend-local";
import { defaultDbPath, openDb, type User } from "@ceibo/store";
import { createOauthServer } from "./engine.ts";
import { backfillGrantAccounts } from "./index.ts";

process.loadEnvFile(new URL("../../../.env", import.meta.url)); // Node 22+; .env único en el root del monorepo

const env = process.env;
// Solo lo transversal es obligatorio al arrancar. Las credenciales de cada provider
// (GOOGLE_*, NOTION_*) se chequean al usarse → un provider sin configurar simplemente no
// enrola, sin tumbar el servicio.
const required = ["ANTHROPIC_API_KEY", "OAUTH_REDIRECT_URI"];
for (const k of required) {
  if (!env[k]) {
    console.error(`Falta ${k} en .env`);
    process.exit(1);
  }
}

const PORT = Number(env.PORT ?? "8000");
const HOST = env.HOST ?? "0.0.0.0";
const REDIRECT_URI = env.OAUTH_REDIRECT_URI as string;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
// La costura: el motor habla con un SessionBackend por usuario, no con el SDK. El selector es el
// GEMELO del gateway (makeBackendForUser): el oauth-server es su propio proceso → no comparte
// runtime, y oauth no puede importar de @ceibo/gateway, así que replicamos la lógica acá.
// 'local' (archima) resuelve al backend de archima si ARCHIMA_* está en el env (mismo .env y misma
// llave ssh que el gateway → el push de la cred al vault del user va por ssh a gpuhost, donde
// corre el AV broker). El enrollment de un user 'local' sólo usa createVault + setStaticBearerCredential.
const maBackend = makeMaBackend(client);
const archimaDefaultModel =
  env.ARCHIMA_MODEL_ID ?? env.ARCHIMA_COORDINATOR_MODEL_ID ?? env.ARCHIMA_WORKER_MODEL_ID;
const archimaBackend = env.ARCHIMA_SSH_TARGET
  ? makeArchimaBackend({
      sshTarget: env.ARCHIMA_SSH_TARGET,
      sshKey: env.ARCHIMA_SSH_KEY as string,
      cp: env.ARCHIMA_CP,
      av: env.ARCHIMA_AV,
      providerID: env.ARCHIMA_PROVIDER_ID as string,
      modelID: archimaDefaultModel as string,
      coordinatorModelID: env.ARCHIMA_COORDINATOR_MODEL_ID,
      workerModelID: env.ARCHIMA_WORKER_MODEL_ID,
      vmPort: env.ARCHIMA_VM_PORT ? Number(env.ARCHIMA_VM_PORT) : undefined,
    })
  : undefined;
const backendForUser = (user: User): SessionBackend => {
  if (user.backend_mode === "local") {
    if (!archimaBackend) {
      throw new Error(
        `usuario ${user.id} (${user.handle}): backend 'local' pedido pero archima no está configurado (faltan ARCHIMA_* en el env)`,
      );
    }
    return archimaBackend;
  }
  return maBackend;
};
const db = openDb(defaultDbPath());

const oauth = createOauthServer({ env, backendForUser, db, redirectUri: REDIRECT_URI });
const server = createServer(oauth.handle);

server.listen(PORT, HOST, () => {
  console.log(
    dim(`oauth arriba · http://${HOST}:${PORT} · redirect=${REDIRECT_URI} · db=${defaultDbPath()}`),
  );
  // Backfill best-effort de la cuenta externa de grants viejos (sin `account`). No bloquea el
  // arranque; los que no se resuelvan quedan null y se reintentan en el próximo restart.
  void backfillGrantAccounts({ db, env })
    .then(({ scanned, filled }) => {
      if (scanned > 0) console.log(dim(`backfill cuentas: ${filled}/${scanned} resueltas`));
    })
    .catch((e) => console.error(dim(`backfill cuentas falló: ${(e as Error)?.message ?? e}`)));
});

const shutdown = () => {
  console.log(dim("\nparando oauth…"));
  server.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
