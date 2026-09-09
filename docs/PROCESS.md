# How this was planned

The code is half of the story. The other half is the planning that produced it, which
lived in a private wiki next to the repo. It is reproduced here under
[`planning/`](planning/), unedited except for scrubbed infrastructure identifiers and one
removed section (see *Caveats* below).

Like the rest of the repo, those documents are in **Spanish**. This page is the map.

---

## The loop

Every non-trivial feature went through the same documents, in this order:

**`spec.md` — what and why.** The design argument, the alternatives that were rejected,
and the risks accepted on purpose. No checkboxes: a spec is a position, and it gets
rewritten when the position changes.

**`plan.md` — the execution.** Checkboxes and PR numbers, updated as the work landed. It
is a log as much as a plan, which is why the interesting ones contain the moment the
original approach died.

**`prueba-local.md` / `prueba-staging.md` — the evidence.** What was actually run, in
which environment, and what came back.

**An audit or a runsheet** — the repeatable procedure that keeps it honest after the
feature ships.

Keeping the spec and the plan apart is the part that does the work. Merged into one
document, the rationale gets buried under stale checkboxes and nobody rereads it. Kept
apart, the spec is still legible a month later and the plan stays an honest record.

---

## Where to start

**[`planning/features/decay/`](planning/features/decay/)** — the best single read, because
it is the one where the plan killed the design. The feature is memory that forgets: notes
that go cold get archived out of the working tree the agent sees, and git history *is* the
cold tier, which makes forgetting reversible and auditable.

The [spec](planning/features/decay/spec.md) argues the design against Bjork's
storage-strength / retrieval-strength model, and concludes that because archiving is a
commit, decay can be aggressive without risk.

The [plan](planning/features/decay/plan.md) then opens with the descriptive analysis that
invalidated v0: scoring by git age and inbound links does not work when the repo is 32
days old (every note looks new) and 87% of the notes are orphans. The fix was to pivot to
an access counter written into each note's own frontmatter. That pivot is the reason to
write plans down.

**[`planning/features/staging/ciclo-de-release.md`](planning/features/staging/ciclo-de-release.md)**
— the release cycle in two sentences: feature PRs go only to `dev`, promotion happens
through one release PR per hop, and **merging is not deploying**. Promotions are
squash-merges, so commit ancestry is not a reliable source of truth; a CI flow-guard
enforces the branch topology that branch protection cannot express, and the changelog is
built from per-PR fragments instead of `git log`. It also records evaluating Changesets
and rejecting it, with the reason.

**[`planning/audits/procedimiento.md`](planning/audits/procedimiento.md)** — a playbook for
an agent to audit the system end to end, code and host, written to be rerun and diffed
against the previous run. It opens by calibrating severity for a single-tenant experiment
and asking for a note on what breaks when that assumption goes away.

**[`planning/features/quickboot/`](planning/features/quickboot/)** — latency work, with the
time-to-first-token instrumentation that had to exist before any of it could be judged.

**[`planning/features/db/contrato.md`](planning/features/db/contrato.md)** — the contract
for `@ceibo/store`, the deep leaf six packages depend on. Contract first, precisely
because a change there ripples everywhere.

---

## Why the planning layer exists

This was built by one person with coding agents doing most of the typing, and everything
above is the scaffolding that makes that survivable. The pattern is the same throughout:
**push the constraint into something mechanical, and write down the reasoning it came
from.**

- Each package carries its own `CLAUDE.md` stating its contract and its boundary, so an
  agent working in one package can be given that package's rules and nothing else.
- The dependency graph has no cycles, and it is stated in the README, so a violation is
  visible in review rather than discovered at runtime.
- Coverage floors are per file and ratcheted by hand (`vitest.config.ts`) — a ceiling on
  regressions, not a number to chase.
- The changelog is a file per PR (`changelog.d/`), which makes merge conflicts structurally
  impossible.
- The pre-push hook runs lint, typecheck and the full suite, so the machine catches what
  review would have to.

---

## Caveats

**The commit history is not here.** This repository is a squashed snapshot of a private
repo. The plans reference PR numbers (#439, #675, …) that were real in that history and
resolve to nothing here. They are left in because they show the actual sequence of the
work.

**The audit findings are not here.** `planning/audits/procedimiento.md` is the procedure
only; the dated baseline of open findings was removed, because some of the infrastructure
it describes is still running.

**Hosts, IPs and paths are scrubbed** throughout, the same way they are in the code.
