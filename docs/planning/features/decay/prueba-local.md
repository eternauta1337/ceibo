# decay — prueba local (runbook para un agente en la mac)

> Para vos, agente que corre en la **mac de Ale** (entorno `dev`). Objetivo: probar el feature `decay` end-to-end en local, **sin tocar prod/staging ni archi**. (2026-06-29) Diseño: `spec.md` · checkboxes: `plan.md`.

## Qué vas a probar (y qué NO)

✅ **En la mac (este runbook):**

- El editor **esconde** el frontmatter tras un chip (#658).
- El **web-producer**: abrir una nota le estampa `accessed`/`reads` en el frontmatter (#670).
- El **debounce** diario (no re-escribe la misma nota el mismo día).
- (opcional) El **seed** y el **gate de REM** por dry-run.

❌ **NO acá** (necesita una VM de archima, no esta mac): el **plugin de opencode** (#669). Ese se verifica en la VM `ceibo-dev` en archi, es un paso aparte.

> ⛔ Todo es local contra `ceibo.dev.db` y la **wiki de dev** (NO la wiki real de Ale). No corras nada contra prod (`app.example.com`) ni staging.


---

## 1\. Preparar el árbol con el código del feature

Los PRs todavía pueden no estar en `dev`. Armá una branch de integración que los junte:

```bash
cd ~/ceibo/ceibo            # el repo (ajustá si tu path difiere)
git fetch origin
git switch -c test/decay-local origin/dev
# #658 editor, #670 web-producer (arrastra #665 wikis), #672 gate de REM:
git merge --no-edit origin/feat/wiki-frontmatter
git merge --no-edit origin/feat/decay-web-producer
git merge --no-edit origin/feat/rem-decay-gate
```

Si NO hay conflictos, seguí. Si los hubiera (improbable, tocan paquetes distintos), pará y avisá — no fuerces.

> Atajo: si Ale ya mergeó los PRs a `dev`, saltá esto y usá `dev` directo: `git switch dev && git pull`.

```bash
pnpm install                # por si cambió algo
```


---

## 2\. Levantar dev

Prerequisito (una sola vez): `tailscale set --accept-routes=true` en la mac (si no, el chat se cuelga; el editor/web NO lo necesitan, pero dejalo listo). Setup de la DB+wiki (una vez):

```bash
pnpm dev:setup              # seedea ceibo.dev.db (user dev@ceibo.local / pass "dev") + provisiona la wiki de dev
pnpm dev                    # levanta gateway + web-server + web. Dejá esto corriendo.
```

`pnpm dev` imprime tres streams:  `**[gw]**`  (gateway),  `**[api]**`  (web-server),  `**[web]**` (vite). Anotá la URL que imprime `[api]` (el web-server) y la del `[web]` (típico `http://localhost:5173`). **Dejá** `**pnpm dev**` **corriendo en background y seguí.**


---

## 3\. Prueba A — el editor esconde el frontmatter + el web-producer bumpea


1. Abrí `http://localhost:5173`, login con `**dev@ceibo.local**`  **/**  `**dev**`.
2. En el explorer, abrí una nota cualquiera de la wiki de dev (ej. `Bienvenida.md`). Si no hay, creá una con el botón `+` y escribile un par de líneas.
3. **Mirá la nota apenas la abrís:**
  - ✅ **NO** tenés que ver un bloque `---\n...\n---` de texto crudo arriba.
  - ✅ Tenés que ver un chip discreto  **"⚙ N propiedades"**  (o ningún chip la primera vez, y aparece al re-abrir — ver abajo). Click en el chip revela el YAML.

### Verificación autoritativa (la del agente): por la API

El bump es un commit real a la wiki de dev. Confirmalo por la API del web-server (sin browser). `$API` = la URL que imprimió `[api]`. Necesitás la cookie de sesión (login dev):

```bash
# login (password dev) → guarda la cookie
curl -sc /tmp/ck.txt -X POST "$API/api/login/password" \
  -H 'content-type: application/json' -H "origin: $API" \
  -d '{"email":"dev@ceibo.local","password":"dev"}' | head -c 200; echo
# (si el body no es {email,password}, mirá el handler /api/login/password en
#  packages/web-server/src/web.ts y ajustá — es lo único que puede variar)

# averiguá el repo de la wiki de dev y un path .md
curl -sb /tmp/ck.txt "$API/api/explorer" | head -c 800; echo
#   → buscá el `repo` (típico "dev-personal") y un `path` .md

# LEE la nota (esto dispara el bump del web-producer):
REPO="dev-personal"; NOTE="Bienvenida.md"   # ajustá con lo de arriba
curl -sb /tmp/ck.txt "$API/api/file?repo=$REPO&path=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$NOTE")"
```

✅ **Éxito A:**  la respuesta JSON trae `content` con un frontmatter al tope:

```
---
accessed: <hoy YYYY-MM-DD>
reads: 1
---
# <título>...
```

y un `sha` distinto al que tenía antes (el editor guarda con ese sha → sin conflictos).


---

## 4\. Prueba B — debounce diario

Volvé a leer la MISMA nota el mismo día:

```bash
curl -sb /tmp/ck.txt "$API/api/file?repo=$REPO&path=...mismo..." | grep -E 'reads|accessed'
```

✅ **Éxito B:**  `reads` **sigue en 1** (no subió a 2) y NO se generó un commit nuevo. El debounce (≤1 escritura por nota por día) funciona. (Si querés ver el incremento, sólo sube al día siguiente, o bajá el reloj — no hace falta para validar.)


---

## 5\. Prueba C (opcional) — el seed por dry-run

Sin tocar ninguna wiki real: copiá una y corré el seed.

```bash
cp -a ~/wiki/ceibo /tmp/wiki-copy        # una copia, el original no se toca
pnpm --filter @ceibo/wikis seed:decay /tmp/wiki-copy            # DRY-RUN: muestra qué sembraría
pnpm --filter @ceibo/wikis seed:decay /tmp/wiki-copy --apply    # escribe (NO commitea/pushea)
git -C /tmp/wiki-copy diff | head -40                          # revisá el frontmatter agregado
```

✅ **Éxito C:**  el dry-run lista N notas a sembrar con `created`/`accessed` (de git) y `reads:0`; el `--apply` agrega el bloque **arriba del**  `**# H1**` de cada nota; correrlo de nuevo dice "0 a sembrar" (idempotente).


---

## 6\. Prueba D (opcional) — el gate de REM por dry-run

Sobre la copia **ya sembrada** del paso 5:

```bash
pnpm --filter @ceibo/rem-runner run:dry decaytest --local /tmp/wiki-copy
```

✅ **Éxito D:**  en la salida aparece la línea `decay-gate (ON): X de Y archive/delete vetadas`. Como recién sembraste (todo `reads:0`, `accessed` reciente), el gate debería **vetar casi todoarchivado** (las notas no están "frías" todavía) — eso es lo correcto/conservador.

> ⚠️ Este paso corre el **planner real** (gemma vía vLLM o `--planner anthropic`). Necesita el endpoint configurado (`REM_VLLM_BASE` en `~/.config/ceibo/rem-batch.env`, o `ANTHROPIC_API_KEY`
>
> - `--planner anthropic`). Si no lo tenés a mano, **saltá D**: la lógica del gate está cubierta por tests unitarios; D es sólo el end-to-end.


---

## Monitoreo / dónde mirar

- `**[api]**`  **stream** (web-server): errores del GET/PUT de notas. Un bump exitoso NO loguea (es silencioso); un PUT de edición sí loguea `web edit: ...`.
- `**[gw]**`   **/**   `**[web]**` : no relevantes para esta prueba (chat / vite).
- **La respuesta de**  `**/api/file**` es la fuente de verdad del bump (frontmatter + sha).
- **Browser → DevTools → Network →**  `**file?repo=...**` : ves el JSON con el `content` bumpeado.

## Criterios de éxito (resumen)

- [ ] A: abrir una nota NO muestra `---` crudo (hay chip), y `/api/file` devuelve frontmatter con `accessed=hoy` + `reads:1` \+ sha nuevo.
- [ ] B: re-leer el mismo día deja `reads` en 1 (debounce).
- [ ] C (opt): seed dry-run + apply idempotente, bloque sobre el H1.
- [ ] D (opt): el dry-run de REM imprime la línea `decay-gate` y veta los archivados de notas no frías.

## Si algo falla

- **Ves**  `**---**`  **crudo en el editor** → no está el código de #658 en tu árbol (revisá el merge del paso 1) o el editor no rebuildeó (reiniciá `pnpm dev`).
- `**/api/file**` **no agrega frontmatter** → ¿la nota está en un repo escribible del user? (no bumpea repos archivados/read-only). ¿`#670` está en el árbol? ¿El login dio cookie válida?
- **El login curl falla** → confirmá el body exacto en el handler `/api/login/password` (`packages/web-server/src/web.ts`) o hacelo desde el browser y verificá por DevTools.
- **El chat se cuelga** (si probás chat) → falta `tailscale set --accept-routes=true`. No afecta el editor/web-producer.

## Limpieza

```bash
# Ctrl-C en pnpm dev. Borrá la copia de prueba:
rm -rf /tmp/wiki-copy /tmp/ck.txt
# La branch de integración es descartable:
git switch dev && git branch -D test/decay-local   # (opcional)
```

## Reportá

Cuando termines, devolvé: qué criterios ✅/❌, la salida de `/api/file` (el frontmatter que viste), y cualquier error de los streams. Eso le dice a Ale si el feature quedó listo para el deploy (orden en `plan.md`: prod web primero, después seed, después archi).
