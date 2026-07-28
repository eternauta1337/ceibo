// Smoke de los aliases de wiki (Fase 16). Convención username-label: el dueño ve la wiki por
// su label ("personal"), los demás con el prefijo del dueño ("demo-personal"). Es capa de
// display — el repo de GitHub NO se renombra. Corré: tsx packages/store/smoke-aliases.mts
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addRepo,
  addUser,
  getRepoByName,
  getUser,
  grantAccess,
  openDb,
  renameRepoInStore,
  setRepoLabel,
  setUserActiveWiki,
  wikiDisplayName,
  wikiLabel,
} from "./src/index.ts";

const db = openDb(join(tmpdir(), `ceibo-alias-smoke-${Date.now()}.db`));

// 1) Fallback sin label seteado: la wiki propia del dueño (repo.name === ownerHandle) cae a
// "personal"; cualquier otra, al nombre del repo.
const own = addRepo(db, "example-wikis", "demo");
if (wikiLabel(own, "demo") !== "personal") throw new Error("wiki propia sin label debería ser 'personal'");
const shared = addRepo(db, "example-wikis", "casa");
if (wikiLabel(shared, "demo") !== "casa") throw new Error("wiki no-propia sin label debería caer al nombre");

// 2) Display: el dueño ve el label pelado; otro viewer ve el prefijo del dueño.
if (wikiDisplayName(own, "demo", "demo") !== "personal") throw new Error("el dueño debería ver 'personal'");
if (wikiDisplayName(own, "demo", "luminos") !== "demo-personal")
  throw new Error("otro viewer debería ver 'demo-personal'");

// 3) Label explícito gana sobre el fallback, y persiste.
setRepoLabel(db, own.id, "trabajo");
const reloaded = getRepoByName(db, "example-wikis", "demo");
if (!reloaded || reloaded.label !== "trabajo") throw new Error("setRepoLabel no persistió");
if (wikiLabel(reloaded, "demo") !== "trabajo") throw new Error("el label explícito debería ganar");
if (wikiDisplayName(reloaded, "demo", "luminos") !== "demo-trabajo")
  throw new Error("display con label explícito mal compuesto");

// 4) Limpiar el label (null) vuelve al fallback.
setRepoLabel(db, own.id, null);
const cleared = getRepoByName(db, "example-wikis", "demo");
if (!cleared || cleared.label !== null) throw new Error("limpiar el label no lo dejó en null");
if (wikiLabel(cleared, "demo") !== "personal") throw new Error("tras limpiar debería volver a 'personal'");

// 5) Convención <handle>-<label> (Fase 16): sin label explícito, wikiLabel pela el prefijo del
// dueño. demo-ceibo (dueño demo) → "ceibo"; lula-personal (dueño lula) → "personal".
const conv = addRepo(db, "example-wikis", "demo-ceibo");
if (wikiLabel(conv, "demo") !== "ceibo") throw new Error("debería pelar el prefijo del dueño → 'ceibo'");
if (wikiDisplayName(conv, "demo", "demo") !== "ceibo") throw new Error("el dueño debería ver 'ceibo'");
if (wikiDisplayName(conv, "demo", "lula") !== "demo-ceibo")
  throw new Error("otro viewer debería ver 'demo-ceibo'");

// 6) renameRepoInStore: cambia nombre + label y repunta el active_wiki de quien lo tenía en foco.
const ren = addRepo(db, "example-wikis", "viejo");
const u = addUser(db, "renamer");
grantAccess(db, ren.id, u.id);
setUserActiveWiki(db, u.id, "viejo");
renameRepoInStore(db, ren.id, "viejo", "renamer-nuevo", "nuevo");
const after = getRepoByName(db, "example-wikis", "renamer-nuevo");
if (!after || after.label !== "nuevo") throw new Error("renameRepoInStore no actualizó nombre/label");
if (getRepoByName(db, "example-wikis", "viejo"))
  throw new Error("el nombre viejo debería haber desaparecido");
if (getUser(db, u.id)?.active_wiki !== "renamer-nuevo")
  throw new Error("renameRepoInStore no repuntó el active_wiki al nombre nuevo");

console.log("OK aliases smoke");
