// Fase 7 — probe empírico: ¿cómo distingue el vault de Anthropic dos credenciales
// del MISMO servicio que difieren sólo en la mcp_server_url?
//
// Responde la pregunta que define el diseño de multi-cuenta (path vs query):
//   T1  query string  : .../mcp/probe/SECRET?profile=work  vs  ?profile=personal
//   T2  path segment  : .../mcp/probe/SECRET/work          vs  .../work-personal
//   T3  duplicado exacto (control): ¿el vault rechaza 2 creds con la MISMA URL?
//   T4  ¿la URL devuelta preserva el query string tal cual (sin normalizar)?
//
// Crea UN vault descartable y lo borra al final (best-effort). Token dummy: este
// probe sólo mide el bookkeeping del vault (entradas distintas o colisión), no la
// inyección real en una sesión. NO loguea tokens.
//
// Uso (en la box, con ANTHROPIC_API_KEY en el entorno):
//   node --env-file=.env scripts/probe-vault-url-matching.mjs

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BASE = "https://ceibo-old.example.com/mcp/probe/0000probe0000";
const TOKEN = "probe-dummy-token-not-real";

const log = (...a) => console.log(...a);
const short = (u) => u.replace("https://ceibo-old.example.com/mcp/probe/0000probe0000", "…");

async function listUrls(vaultId) {
  const page = await client.beta.vaults.credentials.list(vaultId, {});
  return (page.data ?? []).map((c) => ({ id: c.id, url: c.auth?.mcp_server_url, type: c.auth?.type }));
}

async function tryCreate(vaultId, url, label) {
  try {
    const c = await client.beta.vaults.credentials.create(vaultId, {
      display_name: label,
      auth: { type: "static_bearer", mcp_server_url: url, token: TOKEN },
    });
    log(`  create(${short(url)}) → OK id=${c.id}`);
    return c.id;
  } catch (e) {
    log(`  create(${short(url)}) → ERROR ${e?.status ?? ""} ${e?.message ?? e}`);
    return null;
  }
}

async function clear(vaultId) {
  for (const c of await listUrls(vaultId)) {
    await client.beta.vaults.credentials.delete(c.id, { vault_id: vaultId }).catch(() => {});
  }
}

const main = async () => {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("falta ANTHROPIC_API_KEY");
  const vaultObj = await client.beta.vaults.create({ display_name: "fase7-url-probe (descartable)" });
  const vault = vaultObj.id;
  log(`vault descartable: ${vault}\n`);
  try {
    log("T1 — query string (?profile=work vs ?profile=personal)");
    await tryCreate(vault, `${BASE}?profile=work`, "probe-work");
    await tryCreate(vault, `${BASE}?profile=personal`, "probe-personal");
    log("  estado del vault:", JSON.stringify(await listUrls(vault).then((l) => l.map((x) => ({ url: short(x.url) }))), null, 0));
    await clear(vault);

    log("\nT2 — path segment (/work vs /work-personal)");
    await tryCreate(vault, `${BASE}/work`, "probe-path-work");
    await tryCreate(vault, `${BASE}/work-personal`, "probe-path-personal");
    log("  estado del vault:", JSON.stringify(await listUrls(vault).then((l) => l.map((x) => ({ url: short(x.url) }))), null, 0));
    await clear(vault);

    log("\nT3 — duplicado EXACTO (misma URL dos veces)");
    await tryCreate(vault, `${BASE}/dup`, "probe-dup-1");
    await tryCreate(vault, `${BASE}/dup`, "probe-dup-2");
    log("  estado del vault:", JSON.stringify(await listUrls(vault).then((l) => l.map((x) => ({ url: short(x.url) }))), null, 0));
    await clear(vault);

    log("\nT4 — ¿se preserva el query string al devolver la URL?");
    await tryCreate(vault, `${BASE}?profile=work&x=1`, "probe-preserve");
    const got = (await listUrls(vault))[0]?.url;
    log(`  enviado : ${short(`${BASE}?profile=work&x=1`)}`);
    log(`  devuelto: ${got ? short(got) : "(nada)"}`);
    await clear(vault);
  } finally {
    await client.beta.vaults.delete(vault, {}).then(() => log(`\nvault ${vault} borrado`)).catch((e) => log(`\nno pude borrar vault: ${e?.message ?? e}`));
  }
};

main().catch((e) => {
  console.error("FATAL:", e?.message ?? e);
  process.exit(1);
});
