# ceibo

A multi-user personal assistant that lives where you already are: **Telegram**, **WhatsApp**,
and a **web app with push-to-talk**. Every user gets their own notes (git-backed wikis),
their own connected accounts (Gmail, Calendar, Drive, Sheets, Notion), and their own agent,
with real isolation between users at every layer.

This isn't a chat wrapper. It's the infrastructure around the model: identity, permissions,
channels, persistent memory, voice, scheduled tasks, and spend accounting.

> **Status:** a personal project, now archived as a work sample. It ran in production for
> several months with real users. The code is exactly as it came out of that operation, with
> infrastructure identifiers replaced by examples.
>
> **This README and [docs/PROCESS.md](docs/PROCESS.md) are the only files in English.**
> Comments, docs, planning notes, and commit messages are in **Spanish**, which is how it
> was written.

---

## What makes it interesting

**Two model backends, swappable per user.** The same assistant runs on
[Managed Agents](https://docs.anthropic.com/) in Anthropic's cloud, or on a self-hosted model
(Gemma on vLLM) inside an ephemeral libvirt VM dedicated to each user. You switch with one
command (`ceibo user set-backend <handle> ma|local`), no code changes. The channel layer and
the data layer have no idea which one is active.

**MCP servers are the permission boundary, not plumbing.** There are ten self-hosted MCP
servers. Each has two independent gates: a *path secret* that guards the URL (and is
therefore assumed to leak into proxy access logs), and a *separate HMAC key* that signs a
per-user identity bearer token. One user's agent cannot reach another user's data even if it
guesses the URL.

**Notes are real git repos.** Each user has one or more wikis — actual repositories, created
on demand through a GitHub App, with ephemeral installation tokens scoped to the exact repo.
The agent writes notes, the web editor writes notes, and both share history, blame, and
merges. A scoped smart-HTTP git proxy lets an inference VM clone only its owner's wikis.

**Voice end to end, layered above the model.** The model has no audio: the bridge transcribes
what comes in and synthesizes what goes out, with two interchangeable providers
(faster-whisper + edge-tts locally, or Inworld over HTTP).

**Honest accounting.** Every turn records the session's raw token counts as a delta against a
snapshot — not an estimate. `ceibo usage` reports real spend per user and per day.

---

## Architecture in 30 seconds

```
   Telegram ─┐
   WhatsApp ─┼─► gateway ──► agent (MA cloud │ local model)
   web/SSE ──┘      │            │
                    │            └──► MCP servers ──► Gmail · Calendar · Drive
                    │                  (self-hosted)   Sheets · Notion · crons
                    │                                  WhatsApp · notes · control
                    ▼
                 SQLite  ◄──  web-server ──► wikis (git repos via GitHub App)
                                  │
                                  └──► SPA (React) + SSE
```

Four processes behind an nginx ingress that routes by path:

| Process | Responsibility | Port |
|---|---|---|
| `gateway` | Receives from the channels, routes to user/session, meters every turn. Serves the `control` and `notes` MCPs in-process. | 8830 / 8832 |
| `web-server` | SPA + SSE + login + the notes plane. Serves the `viewer` MCP. | 8820 |
| `oauth` | Enrolls external accounts and writes the encrypted credential into the user's vault. | 8801 |
| `mcps` | Single launcher for the stateless MCPs (gmail, calendar, drive, sheets, notion, schedule, wacli). | 8810 |

Details in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** (Spanish).

---

## The packages

A pnpm monorepo, 15 packages, one rule: **no cycles**. Leaves depend on nothing internal; the
two deploy targets consume almost everything.

| Package | Role | Depends on |
|---|---|---|
| `@ceibo/store` | Data layer: users, per-channel identities, repos and N:N access, sessions, usage ledger, notes index (FTS + vectors). SQLite. | — |
| `@ceibo/agent` | Managed Agents client: the session as a turnless bidirectional stream, plus vault helpers. Channel-agnostic. | — |
| `@ceibo/wikis` | Wiki substrate: creates repos on demand and mints ephemeral per-user scoped tokens. Backend: GitHub App. | — |
| `@ceibo/speech` | Channel-agnostic STT/TTS, two providers. | — |
| `@ceibo/web` | SPA: push-to-talk orb, notes editor, explorer. React + Vite. | — |
| `@ceibo/orb` | The animated orb (canvas), isolated so it can be iterated in a sandbox. | — |
| `@ceibo/channels` | Channel-agnostic contract + concrete channels (telegram, cli, wacli) + the remote channel. | `agent`, `store` |
| `@ceibo/mcps` | The stateless MCP servers and their single launcher. | `speech`, `store` |
| `@ceibo/oauth` | OAuth broker: PKCE, at-rest encryption of grants, refresh. | `agent`, `store` |
| `@ceibo/backend-local` | Local backend client: VM control plane, opencode over HTTP. | `agent`, `store` |
| `@ceibo/archima-runtime` | The versioned VM runtime (control plane, provisioning, config), de-secreted, with tests that keep it that way. | — |
| `@ceibo/rem-runner` | Batch wiki consolidation: plans and executes note refactors offline. | several |
| `@ceibo/gateway` | The always-on process. The heart of it. | 7 internal |
| `@ceibo/web-server` | Standalone web service. | 6 internal |
| `@ceibo/cli` | Admin CLI (`ceibo`): users, channels, repos, enrollment, spend. | `oauth`, `store`, `wikis` |

`store` is a deep leaf: six packages depend on it, so a contract change there ripples
everywhere. Each package carries its own `CLAUDE.md` documenting its contract and boundary.

---

## Running it

You need **Node 22+**, **pnpm 10**, and an Anthropic API key. Everything else is optional.

```bash
pnpm install
cp .env.example .env         # fill in ANTHROPIC_API_KEY, AGENT_ID, ENV_ID,
                             # WEB_SESSION_KEY and REMOTE_CHANNEL_SECRET
pnpm dev:setup               # once: creates the DB and a dev@ceibo.local / "dev" user
pnpm dev                     # gateway + web-server + web together
```

Log in at `http://localhost:5173`. Dev mode runs entirely against a local database and
touches nothing remote.

`.env.example` documents all ~145 variables grouped by subsystem, with the required ones
marked. Almost everything either has a sane default or switches its feature off when absent.

Verification:

```bash
pnpm lint          # biome
pnpm typecheck     # tsc --noEmit across all 15 packages
pnpm test          # ~2,200 tests
```

The husky pre-push hook runs all three. Dev setup details, including the local backend, are in
**[dev.md](dev.md)** (Spanish).

---

## How it was planned

Every non-trivial feature has a `spec.md` (the design argument and the rejected
alternatives), a `plan.md` (checkboxes and PR numbers, updated as the work landed), and the
record of what was actually run to verify it. Those documents lived in a private wiki next
to the repo; they are reproduced under **[docs/planning/](docs/planning/)**, with
**[docs/PROCESS.md](docs/PROCESS.md)** as the map.

The shortest path in is [the decay feature](docs/planning/features/decay/) — memory that
forgets, where the plan opens with the analysis that invalidated the original design.

---

## Worth a look

If you came to read code rather than run it, this is where the interesting parts live:

- `packages/web-server/src/wiki-git-proxy.ts` — the scoped git proxy, with both security
  boundaries documented in the header.
- `packages/mcps/src/launch.ts` — how one process mounts N MCP servers, and why the path
  secret is decoupled from the HMAC key.
- `packages/store/src/crypto.ts` — at-rest encryption of OAuth tokens, and why the master key
  lives outside the database.
- `packages/gateway/prompt/` — the agent prompts, composed from a shared core plus a
  per-backend adapter.
- `packages/archima-runtime/src/build.ts` — how to version a VM runtime without versioning its
  secrets, with tests that break the build if a literal slips in.
- `vitest.config.ts` — per-file coverage floors, ratcheted manually on purpose.

---

## License

MIT. See [LICENSE](LICENSE).

All dependencies are permissive (MIT / ISC / Apache-2.0 / BSD); there is no copyleft in the
tree.
