# Fork maintenance runbook — syncing with upstream

**Audience:** any agent (Claude/Opus, GPT/Codex, GLM) or human maintaining this
fork. No prior session context required — this document is self-contained.

- **This repo:** `shoppai-cyber/codegraph` (Kyle's private fork; `origin`)
- **Upstream:** `colbymchenry/codegraph` (`upstream` remote, read-only)
- **Fork-only surface:** framework resolvers + extractors (Unity engine
  liveness, FishNet, Unity asset-wiring YAML, Blender, CFML) plus their tests
  and docs. See `AGENTS.md` for the active workstream.

## Standing rules (read before doing anything)

1. **Never push to `upstream`, never open PRs/Issues/comments against it.**
   All publishing goes to `origin` (the shoppai-cyber fork) only.
2. **Never run the Release workflow, `npm publish`, `git tag`, or version
   bumps on this fork.** Upstream releases; we don't.
3. **Merge, never rebase, `main`.** Fork `main` is published and shared;
   rebasing it rewrites history other worktrees/agents may be based on.
4. **Keep fork work additive.** New resolvers/extractors go in NEW files
   (`src/resolution/frameworks/<name>.ts`, `src/extraction/<name>.ts`,
   `__tests__/<name>.test.ts`). Shared upstream files get only small
   registration hooks. This discipline is *why* syncs are cheap — protect it.

## Sync procedure

### 1. Look at the divergence FIRST — every time, before deciding anything

Never merge blind. The delta tells you whether to sync now, what will
conflict, and what to re-validate after.

```bash
git fetch upstream
git rev-list --left-right --count main...upstream/main   # "<ahead> <behind>"
git log --oneline main..upstream/main                    # what we'd take
git diff --name-only main...upstream/main                # files they touch
git diff --name-only upstream/main...main                # files we touch
```

The intersection of those two file lists is your exact conflict surface.
If upstream's commits are all additive language/extractor work (the common
case), expect conflicts only in the registry hotspots below.

### 2. Preconditions

- **Push `main` to `origin` first.** Fork work (the resolvers) may exist only
  on this machine; a sync is the wrong moment to be the sole copy.
- Clean working tree (`git status`). **Uncommitted changes are work, not
  residue** — commit them or set them aside deliberately. Never `git checkout
  --`, reset, or discard them, and never let a stash be the only copy.
- No in-flight fork branch is mid-review against old main (a merge commit on
  main is fine for them, but know what's in flight).
- **Gauge the scale before assuming the runbook fits.** A dozen additive
  language commits and a hundred-plus commits that replace a subsystem are
  different jobs. If `git log main..upstream/main` shows changes to
  extraction, resolution, or `src/db/`, budget for §5's graph diff and take
  the baseline *before* merging — it cannot be taken afterward.

### 3. Merge — on a sync branch, never directly on main

Kyle's machines run a branch-safety hook
(`~/.claude/hooks/branch-commit-guard.js`) that **blocks `git commit` on
`main`** whenever the repo has open PRs (and concluding a conflicted merge IS
a `git commit`). Don't fight it and don't route around it — do the whole sync
on a branch, then fast-forward main (a ff-merge invokes no commit):

```bash
git worktree add ../codegraph-sync-<YYYY-MM-DD> -b sync/upstream-<YYYY-MM-DD>
cd ../codegraph-sync-<YYYY-MM-DD>
git merge upstream/main -m "merge: sync upstream/main (<latest upstream sha, date>)"
# ...resolve conflicts, validate (steps 4-5), then, back in the primary checkout:
git checkout main
git merge sync/upstream-<YYYY-MM-DD>     # fast-forward
git push origin main
git worktree remove ../codegraph-sync-<YYYY-MM-DD>
git branch -d sync/upstream-<YYYY-MM-DD>
```

**Use a worktree, not just a branch** (corrected 2026-07-27). `npm ls -g` shows
`@colbymchenry/codegraph` symlinked straight at the primary checkout, so the
machine's live `codegraph` binary — and every consumer pointed at
`dist/bin/codegraph.js` — runs out of whatever that checkout currently has on
disk. Doing the sync in-place leaves the whole machine on a half-merged,
mid-rebuild tree for the duration. A worktree keeps the primary checkout on
`main` and functional throughout.

**The sync-branch procedure does NOT reliably evade the hook** (corrected
2026-07-27; the previous wording implied it did). Two behaviors to expect:

- The guard resolves the current branch with `git branch --show-current` **in
  the hook's own cwd**, which is the primary checkout — not the worktree the
  command actually runs in. So a commit on `sync/…` inside a worktree is judged
  against the primary checkout's `main` and is blocked anyway. This is
  deliberate: it makes the guard over-block, which is an annoyance, whereas the
  obvious "fix" (reading a cwd off the tool input — Claude Code's Bash tool has
  no such field) would silently resolve to `undefined` and disable the guard.
  **Do not patch it and do not route around it.** Ask Kyle.
- The guard's `gh pr list` is `--repo`-pinned to the slug parsed from
  `git remote get-url origin`. Unpinned it resolved to *upstream* and returned
  upstream's open PRs, which is what made it fire on this fork at all.
- The hook blocks the **entire** Bash call before anything executes, so a
  chained `git add … && git commit …` loses the `git add` too. Re-stage after
  an unblock; don't assume the index survived.

### 4. Resolve conflicts — known hotspots and how each resolves

Both sides register things in the same files; resolution is almost always
**union (keep both sides)**:

**This table mispredicted twice on the 2026-07-27 sync, in both directions.**
The `1.5.0 verdict` column records what actually happened, because a table that
was wrong and doesn't say so is worse than no table:

| File | What conflicts | Resolution | 1.5.0 verdict |
|---|---|---|---|
| `src/extraction/grammars.ts` | language/wasm registrations | keep both registrations | **FALSIFIED** — auto-merged |
| `src/extraction/tree-sitter.ts` | routing entries (incl. our `unity_yaml` content-gated routing) | keep both | **FALSIFIED** — auto-merged |
| `src/extraction/unity-asset-extractor.ts` | fork-only; **holds the `isUnityYaml()` content check** | ours — should never conflict | held (no conflict) |
| `src/resolution/frameworks/index.ts` | resolver registry entries | keep both entries | **FALSIFIED** — auto-merged |
| `src/types.ts` | NodeKind/EdgeKind/metadata additions | **append only, never reorder** (see kernel wire contract below) | **FALSIFIED** — auto-merged |
| `src/db/index.ts`, `src/db/sqlite-adapter.ts` | our read-only/immutable open (d601654) vs upstream's WAL + bulk-load work | **not a registry — real shared logic.** See the d601654 note below | **MISSED** — row added *after* the sync; both real conflicts landed here |
| `.gitignore` | fork-local ignores vs upstream's | union | **MISSED** — was not in the table |
| `CHANGELOG.md` | `[Unreleased]` entries | **not a plain union** — see the trap below | correct (2 hunks) |
| `package.json` / lock | new deps (rare — grammars ship as checked-in `.wasm`) | union `package.json`, then `npm install` to regenerate the lock; never hand-edit the lock | no conflict |
| `AGENTS.md` / `CLAUDE.md` | doc drift | fork-specific sections are ours; upstream edits to shared how-codegraph-works content win | no conflict |

Read the verdict column as a lesson, not a scoreboard: **the four registry
hotspots the table was built around are the ones that did NOT conflict, and the
only real conflicts were in the one file where the fork changed shared logic.**
Registry appends are cheap; shared-logic edits are not. §4a measures why.

Anything conflicting outside this table: stop and read both sides properly —
it means one of us changed shared logic, not just a registry.

### 4a. Why this fork is cheap to update — the measurement

Do not guess at the risk surface; it is measurable in one command, and the
measurement is the fork's central safety property:

```bash
git diff --stat upstream/main...main | tail -1
# 70 files changed, 21,366 insertions(+), 53 deletions(-)   (2026-07-27, post-UXML)

git diff --stat --diff-filter=A upstream/main...main | tail -1   # fork-only files
# 57 files changed, 20,814 insertions(+)
git diff --stat --diff-filter=M upstream/main...main | tail -1   # shared files
# 13 files changed, 552 insertions(+), 53 deletions(-)
```

**21,366 insertions against 53 deletions.** That ratio *is* the safety property.
Deletions and rewrites are what break merges; this fork barely does any.
**20,814 of those lines — 97% — are in fork-only files** upstream cannot
conflict with by construction (`src/resolution/frameworks/unity.ts`,
`unity-assets.ts`, `unity-uxml.ts`, `blender.ts`, `cfml.ts`,
`unity-asset-extractor.ts`, `uxml-extractor.ts`, their tests, and this runbook).

Watch the deletion count, not the insertion count, when re-measuring. Before
UXML landed this read 20,146 / 53; the feature added ~1,200 insertions and
**zero** deletions. Insertions growing while deletions stay flat is the fork
staying cheap to update. A jump in deletions is the signal to look hard.

The entire genuine risk surface is **302 changed lines across 9 shared source
files**, and it splits three ways — the split, not the total, is what makes
future features decidable:

| | Files (changed lines) | Total | Character |
|---|---|---|---|
| **REAL RISK** | `src/db/index.ts` (101), `src/db/sqlite-adapter.ts` (27), `src/index.ts` (21) | 149 | read-only mode (d601654) — **real shared logic**, rewrites upstream's own code paths |
| **REGISTRATION** | `src/extraction/grammars.ts` (21), `src/extraction/tree-sitter.ts` (19), `src/resolution/frameworks/index.ts` (15), `src/types.ts` (11) | 66 | pure appends at list/map/switch boundaries |
| **LOCALIZED** | `src/bin/codegraph.ts` (62), `src/search/query-utils.ts` (25) | 87 | whole-function bodies the fork replaced (the `affected` test-detection fix) — conflicts if upstream touches the same function, but the resolution is legible |

(The other 4 modified files are `CHANGELOG.md`, `CLAUDE.md`, `.gitignore`, and
`__tests__/foundation.test.ts` — doc/test surface, not behavior.)

Both unpredicted 1.5.0 conflicts landed in the REAL RISK row. That is now
covered by the read-only-open-against-an-unhealed-index regression test, which
makes that test **the single most important thing in the recent batch for this
fork's updatability** — it is what turns a silent `SQLITE_READONLY` at the next
sync into a red suite.

The REGISTRATION row has an exact precedent to size any future work against.
Adding `unity_yaml` cost: one `LANGUAGES` entry, three `EXTENSION_MAP` keys, one
type exclusion, three one-line `if` guards, one display name, one import, one
`else if`. ~20 lines, every one an append at a list/map/switch boundary inside a
hunk the fork already owns. Adding `uxml` + `uss` in 2026-07 cost the same shape
again — 66 lines across the same four files, for two languages, a standalone
extractor, and a resolver — confirming the precedent rather than merely citing
it.

> **The load-bearing conclusion: ADDING A FILE TYPE OR RESOLVER IS NEAR-ZERO
> MERGE RISK. TOUCHING `src/db/` IS NOT.**

Use that to decide features, not intuition. UXML/USS sat entirely in the first
category, which is why it landed without a merge question being asked. The
strongest evidence for the rule: the 1.5.0 sync **replaced the whole extraction
engine**, swapping wasm tree-sitter for a native Rust kernel — and all ~4,800
lines of fork resolver code came through untouched.

**Two settled decisions, recorded so they stop being re-litigated:**

- **A patch-file approach was considered and REJECTED.** A patch applies blind
  and rots silently; a merge reports exactly where and why it cannot apply. The
  additive-file structure **is** the durable form of a re-appliable patch, with
  the failure reporting built in.
- **Per-framework builds (separate vanilla / Unity / Blender versions) were
  considered and REJECTED.** `FrameworkResolver.detect()`
  (`src/resolution/types.ts:202`) is a project-level gate called once at
  startup, and `unity.ts`'s is a real one, so a non-Unity repo never runs the
  Unity resolver. Splitting would triple the merge burden to solve a problem the
  resolver contract already solves. The one legitimate second copy is a
  temporary pin at a known-good commit to bisect a broken sync — an escape
  hatch, not an architecture.

**`src/types.ts` is no longer a free union.** As of upstream 1.5.0,
`NODE_KINDS` / `EDGE_KINDS` are runtime-iterable const arrays whose **array
order is part of the native kernel's wire contract** — kinds cross the
JS↔Rust boundary as indexes (`src/extraction/kernel/layout.ts`). Append new
kinds at the end; never reorder or insert. A reorder silently mislabels every
node/edge the kernel produces.

**The CHANGELOG trap (hit 2026-07-27).** The union rule holds only while both
sides' entries sit under `[Unreleased]`. When upstream has *promoted*
`[Unreleased]` into a shipped `## [X.Y.Z]` block since the last sync, git
aligns our still-unreleased fork bullets against the body of upstream's
released version — and a naive "keep both" files our Unity/Mirror/Blender work
as part of upstream's release. Correct resolution: take **upstream's file as
the base** (it has the right release structure and history), then move only the
genuinely fork-only bullets back under `[Unreleased]`. Diff the two sides'
bullet sets rather than eyeballing it; on this sync 7 of 30 bullets were
fork-only and the other 23 were upstream's own, duplicated.

**A file can contain MULTIPLE conflict hunks.** Resolving the first hunk a
search showed you is not done — before concluding the merge, verify zero
markers repo-wide and read the FULL output (the 2026-07-06 sync shipped a
broken merge commit because a truncated `git diff --check` hid grammars.ts's
second hunk):

```bash
git diff --check                       # must print nothing
grep -rn '^<<<<<<< ' src __tests__ *.md   # must match nothing
```

(`npm run build` also catches leftover markers in `.ts` files as TS1185 — but
not in `.md`/`.json`.)

If the merge goes sideways mid-resolve: `git merge --abort` returns you to a
clean pre-merge state. Nothing is lost.

**Sync data points.** Note how different these two are — sync #1 is what most
of the original wording in this file was calibrated against, and it was the
easy case, not the representative one.

| Sync | Upstream commits | Conflicts | Character |
|---|---|---|---|
| 2026-07-06 | 12 (new-language work) | `CHANGELOG.md`, `grammars.ts` (2 hunks), `types.ts` | all pure unions |
| 2026-07-27 | 124 (**extraction engine replaced**) | `CHANGELOG.md` (2 hunks), `.gitignore`, `src/db/index.ts`, `src/db/sqlite-adapter.ts` | one real behavioral decision; see below |

The 2026-07-27 sync took upstream 1.5.0, which swapped extraction from wasm
tree-sitter to **native Rust kernel walkers** (C# and Python among them —
directly under this fork's Unity/Mirror and Blender resolvers). Every hotspot
the table predicted (`grammars.ts`, `tree-sitter.ts`, `frameworks/index.ts`,
`types.ts`) auto-merged; both *unpredicted* conflicts were in `src/db/` and
both traced to d601654. **The fork's resolvers live in fork-only files and
merged with no textual conflict at all — which is not protection, because the
producer of the nodes and edges they read had been replaced underneath them.**
That is what §5's graph-diff step exists to catch.

**The d601654 question, and its answer (2026-07-27).** d601654 "open read-only
indexes without writable sidecars" is this fork's only change to shared logic.
It was re-adjudicated against upstream's ~1,144 lines of WAL rework and
**kept** — upstream has not superseded it:

- Upstream's `DatabaseConnection.open(dbPath)` still takes no options and
  unconditionally runs `configureConnection()`, which sets `journal_mode = WAL`
  — a *write*. A read-only consumer cannot open an index through it at all.
- `OpenOptions.readOnly` exists upstream but is **declared and never
  consumed**; d601654 is what implements it.
- Upstream has no immutable / `mode=ro&immutable=1` path whatsoever.
- Upstream's WAL work bounds WAL growth *during indexing* — orthogonal.

One genuine interaction did surface and had to be adapted: upstream's new
`healBulkNodeLoad()` runs on every open and **writes** (FTS rebuild +
`CREATE TRIGGER`) when a bulk-load window was left open by a crash. Unguarded,
that turns every read-only open of an unhealed index into `SQLITE_READONLY`.
It is now gated behind `if (!options.readOnly)`; a read-only consumer degrades
to a stale `nodes_fts` (search recall only — `nodes`/`edges` are untouched)
until something opens the project writable. **No existing test covers
read-only open against an unhealed index**, so a green suite would not have
caught this. If you touch `src/db/`, keep that guard.

### 5. Validate — build, tests, downstream smoke

```bash
npm ci          # only if package.json/lock changed
npm run build   # REQUIRED — external tools run dist/bin/codegraph.js directly
npm test
```

- **Fork-critical suites that must stay green:** `unity.test.ts`,
  `unity-assets.test.ts`, `blender.test.ts`, plus upstream's
  `extraction.test.ts` / `resolution.test.ts` / `frameworks-integration.test.ts`.
- **Known pre-existing Windows failures.** Re-measured 2026-07-27 on pre-merge
  main (`a24436e`: **11 failed / 1741 passed / 33 skipped**) and post-merge
  (**21 failed / 2959 passed / 39 skipped** — upstream added ~580 tests).
  Always re-confirm on the pre-merge commit before blaming a merge.

  | Suite | Failing | Status |
  |---|---|---|
  | `frameworks-integration.test.ts` "JVM FQN imports — end-to-end" | 3 | stable pre-existing |
  | `mcp-initialize.test.ts` | 3 | stable pre-existing (`afterEach` EPERM temp-dir cleanup) |
  | `mcp-roots.test.ts` | 3 | stable pre-existing (same EPERM cause) |
  | `mcp-daemon.test.ts` | 1–2 | **flaky** — a *different* test fails run to run; process-lifecycle timing |
  | `arkts-resolution.test.ts` (7), `resolution.test.ts` C/C++ + PHP include (4) | 11 | **new with upstream 1.5.0**, see below |

  Two corrections to the previous version of this table (both verified
  2026-07-27, both wrong since at least this date):
  - **`security.test.ts`'s symlink-resistance test PASSES** on Windows now. It
    was listed as a known failure; it is not one.
  - **`multi-repo-workspace.test.ts` PASSES** and was not observed flaking. It
    was listed as flaky; drop that assumption and investigate for real if it
    ever fails.

  The 11 new failures are **not this fork's** and not the merge's. All 11 are
  the *same* single failure mode — `fs.rmSync(tempProject)` throwing `EPERM` in
  a `finally` block after every assertion in the test already passed — i.e. a
  Windows handle-retention regression in upstream 1.5.0's indexing teardown.
  Verified by running both suites on a detached worktree at pure
  `upstream/main` with **zero fork code**: all 11 reproduce identically.
  Also verified **not** kernel-related (`CODEGRAPH_KERNEL=0` reproduces them).
  Report upstream if it matters; don't spend a sync chasing it.

- **Discrimination procedure when anything else fails.** In order, stopping as
  soon as one explains it:
  1. Run exactly the failing suites at the **pre-merge commit** — a failure
     that reproduces at baseline is not the merge's fault.
  2. If the test did not exist at baseline (upstream added it), the baseline
     comparison is meaningless — instead add a detached worktree at
     `upstream/main` and run it there with no fork code:
     ```bash
     git worktree add ../cg-upstream-probe upstream/main --detach
     cmd //c "mklink /J ..\cg-upstream-probe\node_modules ..\<sync-worktree>\node_modules"
     ```
     Remove that junction with `cmd //c rmdir` when done — **never `rm -rf`**,
     which follows the junction in git-bash and would delete the real
     `node_modules`.
  3. Re-run once for the flaky suites (`mcp-daemon.test.ts`).
- **`npm run build` is load-bearing, not optional:** the Unity chunk workflow
  (`C:\dev\repos\unity\tools\carve-chunk\`), chunk `CHUNK.md` manifests, and
  MCP configs all point at `dist/bin/codegraph.js` on this machine. A sync
  that skips the rebuild leaves every consumer running the old code.
- **Unity smoke** (proves our extractors survived): re-index a Unity corpus
  and probe one wiring fact —

  ```bash
  node dist/bin/codegraph.js index C:/dev/repos/unity/tester-01 --quiet   # path is POSITIONAL here
  node dist/bin/codegraph.js node GameManager -p C:/dev/repos/unity/tester-01
  node dist/bin/codegraph.js callers ResetScore -p C:/dev/repos/unity/tester-01
  ```

  (Flag quirk: `index` and `status` take their path as a **positional**
  argument; the query commands — `node`, `callers`, `impact` — take `-p`.)
  Pass = the GameManager scene component links to the `GameManager` class
  (attached-script edge, both directions), and `ResetScore` shows its two
  UnityEvent callers (`RestartButton`, `Player`).

- **Graph diff against a pre-merge baseline — REQUIRED whenever upstream
  touched extraction or resolution** (added 2026-07-27; the smoke test above
  is the floor, not the ceiling). **A clean merge and a green test suite are
  not evidence about graph output.** The fork's resolvers live in fork-only
  files, so they merge without textual conflict even when the engine that
  produces the nodes and edges they consume has been replaced. Green tests
  don't cover it either — the fork's suites use synthetic fixtures, not the
  real corpora.

  The measurement only exists if you take it **before** merging:

  ```bash
  # BEFORE the merge, on pre-merge main, for each corpus:
  node dist/bin/codegraph.js index <corpus>
  node snapshot.mjs <corpus> baseline/<name>.txt <probe symbols...>
  # AFTER the merge + rebuild, identically, into postmerge/, then diff.
  ```

  Cover at minimum one corpus per fork resolver — a Unity/C# one
  (`C:/dev/repos/unity/tester-01`, `C:/dev/repos/unity/mirror-multiplayer`)
  and a Blender/Python one (`C:/dev/repos/blender/grove`). Snapshot totals,
  per-language/per-kind node counts, edges by kind and **provenance**,
  synthesized-edge counts, and the concrete wiring facts the resolvers exist
  to produce. **Explain every difference; do not accept one.** On 2026-07-27
  each apparent regression turned out to be an improvement — Mirror +5 edges
  was upstream correctly extracting call/reference sites in later `switch`
  arms that the old engine dropped, and grove −1 was upstream *fixing* two
  edges misattributed to the wrong enclosing function plus removing one
  spurious source→test-fake name-match. Both were only provable by dumping
  every edge and diffing, not by counts.

- **The native Rust kernel is NOT active in a source build** (as of 1.5.0).
  `getKernel()` returns `null` and everything silently falls back to the wasm
  engine, because prebuilt `.node` binaries ship only in release bundles.
  **A source-build validation therefore does not test the kernel walkers at
  all** — the risk is deferred to whenever Kyle next installs from a release.
  To actually close it, build and stage the kernel, then run upstream's own
  parity harness:

  ```bash
  npm run build:kernel        # needs cargo; stages codegraph-kernel/prebuilds/<plat>/
  node scripts/kernel-parity.mjs <corpus> --lang csharp   # exit 0 = parity
  ```

  Then re-index with the kernel live and diff against the wasm snapshots — on
  2026-07-27 all three corpora came out **byte-identical**, C# scored
  8477/8620 files at byte-parity with 0 diffs (143 safely deferred to wasm),
  and Python 703/703 with 0 diffs and 0 deferrals.

  **`scripts/kernel-parity.mjs` does not run on Windows as shipped** — it
  `await import()`s raw `C:\…` paths, which Node rejects
  (`ERR_UNSUPPORTED_ESM_URL_SCHEME`; ESM needs a `file://` URL). Run a patched
  copy that wraps `dist()` in `pathToFileURL(...).href`. This is an upstream
  bug; we deliberately do not carry a fork patch for it, to keep the sync
  surface additive.

### 6. Push and record

```bash
git push origin main
```

The merge commit is the record. If it later turns out bad:
`git revert -m 1 <merge-sha>` (note: re-merging after a revert requires
reverting the revert first — standard git merge-revert caveat).

## When to sync

- Before starting any new resolver/extractor workstream (smallest possible
  divergence = cheapest conflicts).
- When upstream ships something we want (new language, MCP/explore
  improvements, bug fixes in shared machinery).
- Not mid-workstream unless you need an upstream change — a sync invalidates
  in-flight branches' assumptions about main.

## Generalizing to other forks

For any repo we fork (`shoppai-cyber/*`), replicate this pattern:

1. **Remotes convention:** `origin` = our fork, `upstream` = the source repo
   (`git remote add upstream <url>`). Upstream is fetch-only in practice.
2. **Additive-first discipline:** our changes live in new files wherever
   possible; shared-file edits are minimal hooks. This single habit is what
   makes every future sync a five-minute job instead of an archaeology dig.
3. **A `FORK-MAINTENANCE.md` at the fork root** listing: upstream URL, what
   the fork adds (dirs/files), the shared-file conflict hotspots and their
   resolution rule, the validation commands, and any downstream consumers of
   build artifacts on our machines.
4. **Same standing rules:** look at the divergence first, merge don't rebase,
   validate before push, push to origin only, never publish/tag/PR upstream.
