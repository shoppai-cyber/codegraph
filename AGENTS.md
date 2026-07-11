# AGENTS.md — codegraph fork (shoppai-cyber) · active workstream + operating rules

> **Fork-specific file** (not upstream). This repo is **`shoppai-cyber/codegraph`**, Kyle's private
> fork of `colbymchenry/codegraph`. This file is the canonical router for whoever is working the
> fork's **active workstream**; `CLAUDE.md` (upstream dev guide) stays authoritative for HOW codegraph
> itself works — read it, don't duplicate it here. Claude/Fable read this via the `CLAUDE.md` pointer;
> Codex reads it directly.

> **Updating this fork from upstream:** follow **`FORK-MAINTENANCE.md`** (repo root). Always check
> the divergence first; merge (never rebase) `main`; known conflict hotspots + validation steps are
> in that runbook. Never push/PR/tag upstream.

## Who works here
- **Codex (GPT-5.5 xhigh) — primary builder** on the active workstream.
- **Fable — secondary** (design pressure-test / review), pulled in as needed.
- **AutoResearch orchestrator — advisor**, not a co-committer. It scaffolded this branch and then
  handed off. **From that handoff on, the agent working here is the SOLE git actor for this repo**
  (single-writer). The orchestrator does not commit here concurrently.

## Active workstream — Unity framework resolver
Add **Unity awareness** to codegraph, mirroring the shipped **Blender resolver**. Unity C# lifecycle
methods, `[SerializeField]` fields, attribute/string-invoked entry points are engine-invoked, so they
look dead to the graph (the "zero callers ≠ dead" footgun). C# already parses natively — this is a
**framework resolver on top of existing C# parsing**, NOT a language build.

**Full plan (read first):** `C:\dev\vault\projects\AutoResearch\staging\plan-2026-07-05-codegraph-unity-resolver.md`
(cross-repo absolute path — readable from here). It carries the tiered scope, deliverables, and sequencing.

**Canonical current plan (read next, update in place):**
`C:\dev\repos\unity\databases\unity-docs\UNITY-CORPUS-RESOLVER-PLAN.md`. This is the durable
live plan for the reusable Unity docs corpus + CodeGraph Unity resolver handoff. If Kyle asks for
"the plan" or asks to update it, update that file rather than creating another plan file unless
Kyle explicitly asks for a new versioned plan.

**Current external issue intake (read on startup for CodeGraph triage):**
`scratch/reports/daw-project-persistent-pending-added-2026-07-07.md`. Source: the fresh DAW repo
`C:\dev\repos\sound\daw-project` reports `codegraph status` `Pending Changes: Added 2` after
`sync` and full `index`, while the indexed file list is current. Treat as a candidate CodeGraph
status/change-detection bug until reduced.

**The template is right here in-tree** (this branch is stacked on `feat/blender-resolver`):
- `src/resolution/frameworks/blender.ts` (~1033 LOC) — the `FrameworkResolver` implementation to mirror.
- `src/resolution/frameworks/blender-invocation-table.json` — the domain-rule data file; `unity-invocation-table.json` mirrors its shape (a `consumed` slice the `.ts` reads + a `catalogNotes` provenance section).
- `src/resolution/frameworks/index.ts` — registration (Blender is +4 lines into `FRAMEWORK_RESOLVERS`).
- `__tests__/blender.test.ts` (32 green tests) — the exhaustive `extract()` → `nodeNames`/`refPairs` `.toEqual` harness to copy.
- `CHANGES.md` — the Blender design rationale (read for the emit-nothing reasoning + the work-item-6 ceiling).
- `CODEX-REVIEW-HANDOFF.md` — the proven review pattern (GLM lens + Codex adversarial lens) to repeat for Unity.

**The unity build target:** `src/resolution/frameworks/unity-invocation-table.json` (the orchestrator drafts the
skeleton; you implement `unity.ts` against it) — see the plan doc §3 for the Unity invocation surface (Tier 1
code-only first; Tier 2 asset-aware `.meta`/scene/prefab wiring is a documented follow-up, not v1).

## The non-negotiable design promise (inherited from Blender — do not weaken)
**Emit NOTHING when a target is statically unresolvable.** A *missed* edge is strictly preferred to a
*fabricated* one — false positives are worse than false negatives. Every ambiguous case (computed names,
cross-file base chains, dynamic dispatch) emits nothing, never a guess.

**Inherited ceiling (accept, document, don't fight in v1):** per-file `extract()` runs in isolated workers
and `postExtract`'s `updateNode` is update-by-id (can't insert). So a class whose host-invoked-ness depends
on a base defined in **another file** (`class B : A` where `A : MonoBehaviour` lives elsewhere) can't get its
method nodes emitted after the fact — same as Blender's work-item-6. Document it as a known limitation.

## HARD RULES (operating — all harnesses)
- **NO HEADLESS, ever.** No `claude -p`, `codex exec` loops, or fire-and-read-output. Interactive sessions
  and Overstory *interactive* panes only. (Local Codex *review* via the codex-companion broker is the one
  sanctioned exception — see `CODEX-REVIEW-HANDOFF.md`.)
- **Targeted edits, never full-file rewrites.** Grow existing files by diffs. A true restructure moves the
  old file aside first, then writes fresh — and says so.
- **Single-writer git; scoped commits.** `git add <paths>` — **never `git add -A`**. The agent working the
  workstream is the sole git actor for this repo at a time.
- **Fork-only. NEVER push/PR/issue to upstream `colbymchenry/*` or any public repo.** `git push origin` only.
  Public-repo PRs are forbidden by default unless Kyle initiates that exact request in the same turn.
- **TDD** — no production code without a failing test first (red→green). Copy `blender.test.ts`'s harness.
- **Follow codegraph's OWN required validation methodology** for a new framework: `CLAUDE.md` §"Validation
  methodology (REQUIRED for every new language/framework)" + `docs/design/dynamic-dispatch-coverage-playbook.md`.
  A/B eval arms run **Sonnet `--effort high`** (codegraph's deliberate floor-model rule — do not raise it).
- **Merge/ship is Kyle-gated.** Report the outcome + what you applied; let Kyle call the merge.
- **`NodeKind`/`EdgeKind` are fixed strings** in `src/types.ts` — extractors and resolvers use them verbatim.

## Delegation (Overstory → GLM / Codex panes) — for offloading mechanical volume
You may fan mechanical, low-judgment volume out to **GLM (ZAI) or Codex** panes via **Overstory** — e.g. the
Unity API doc-folder harvest, bulk test-fixture generation, catalog research. Keep design/judgment work
(the invocation table, the resolver logic, review triage) in-session.

**Read the canonical recipe BEFORE your first sling — do not reason from priors:**
`C:\Users\Kyle\.claude\skills\overstory-delegation\SKILL.md` (readable from here). Essentials:
- One shared Overstory project machine-wide: `--project C:\dev\repos\tools\overstory`. Check live panes first:
  `ov status --project C:\dev\repos\tools\overstory`. Caps: ≤5 GLM + ~2 Codex; ≤2–3 index/compile-heavy lanes.
- Fire one: `~\.claude\skills\overstory-delegation\sling_overstory_task.ps1 -Name <n> -Brief <abs .md> -Marker <UNIQUE> [-Runtime claude|codex]` (Runtime `claude`=GLM default, `codex`=GPT-5.5). Fire many: `sling_overstory_fleet.ps1 -Manifest <abs .json>`.
- **Brief contract** (the worker's whole world): goal + ONE deliverable file written to its CWD; absolute input
  paths; constraints verbatim (*no git; write files only; targeted edits*); and the `worker_done` done-mail.
- **Harvest from the worktree** (`…\.overstory\worktrees\<Name>\`), then **tear down** (`ov stop <Name> --force
  --clean-worktree --project …`) and verify no residue. Panes don't self-terminate — track every one you fire.
- **"Is GLM up?"** → `uv run python C:\dev\repos\Research\AutoResearch\scratch\_zai_anthropic_raw_probe.py`
  (HTTP 200 ≈ up). **Never** a `claude -p` smoke.

## Build lifecycle (the proven Blender sequence — repeat for Unity)
1. Orchestrator drafts `unity-invocation-table.json` skeleton (the domain model).
2. Implement `unity.ts` against it (TDD; mirror `blender.ts`). Register in `frameworks/index.ts`.
3. `npx vitest run __tests__/unity.test.ts` green; `npm run build` exit 0.
4. Validate per codegraph's REQUIRED methodology (probes + A/B on small/med/large real Unity repos; test
   subject on hand: `C:\dev\repos\unity\Unity-MP-Course-Project`). Record in the coverage playbook.
5. Two review lenses: a GLM structural review + a Codex adversarial review (pattern in `CODEX-REVIEW-HANDOFF.md`).
6. Triage → apply valid findings via TDD → `CHANGES.md` entry → `git push origin` → **Kyle-gated merge.**
