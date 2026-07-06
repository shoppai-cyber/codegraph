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

- Clean working tree (`git status`). Stash or commit residue first.
- No in-flight fork branch is mid-review against old main (a merge commit on
  main is fine for them, but know what's in flight).

### 3. Merge — on a sync branch, never directly on main

Kyle's machines run a branch-safety hook that **blocks `git commit` on
`main`** whenever the repo has open PRs (and concluding a conflicted merge IS
a `git commit`). Don't fight it and don't route around it — do the whole sync
on a branch, then fast-forward main (a ff-merge invokes no commit):

```bash
git checkout -b sync/upstream-<YYYY-MM-DD>
git merge upstream/main -m "merge: sync upstream/main (<latest upstream sha, date>)"
# ...resolve conflicts, validate (steps 4-5), then:
git checkout main
git merge sync/upstream-<YYYY-MM-DD>     # fast-forward
git push origin main
git branch -d sync/upstream-<YYYY-MM-DD>
```

### 4. Resolve conflicts — known hotspots and how each resolves

Both sides register things in the same files; resolution is almost always
**union (keep both sides)**:

| File | What conflicts | Resolution |
|---|---|---|
| `src/extraction/grammars.ts` | language/wasm registrations | keep both registrations |
| `src/extraction/tree-sitter.ts` | routing entries (incl. our `unity_yaml` content-gated routing) | keep both; **preserve the `isUnityYaml()` content check** |
| `src/resolution/frameworks/index.ts` | resolver registry entries | keep both entries |
| `src/types.ts` | NodeKind/EdgeKind/metadata additions | keep both |
| `CHANGELOG.md` | `[Unreleased]` entries | union — upstream's entries AND ours, both user-facing per house rules |
| `package.json` / lock | new deps (rare — grammars ship as checked-in `.wasm`) | union `package.json`, then `npm install` to regenerate the lock; never hand-edit the lock |
| `AGENTS.md` / `CLAUDE.md` | doc drift | fork-specific sections are ours; upstream edits to shared how-codegraph-works content win |

Anything conflicting outside this table: stop and read both sides properly —
it means one of us changed shared logic, not just a registry.

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

First-sync data point (2026-07-06, 12 upstream commits of new-language work):
conflicts landed in `CHANGELOG.md`, `grammars.ts` (two hunks), and `types.ts`;
`tree-sitter.ts` and `frameworks/index.ts` auto-merged. All unions.

### 5. Validate — build, tests, downstream smoke

```bash
npm ci          # only if package.json/lock changed
npm run build   # REQUIRED — external tools run dist/bin/codegraph.js directly
npm test
```

- **Fork-critical suites that must stay green:** `unity.test.ts`,
  `unity-assets.test.ts`, `blender.test.ts`, plus upstream's
  `extraction.test.ts` / `resolution.test.ts` / `frameworks-integration.test.ts`.
- **Known pre-existing Windows failures** (confirmed on pre-merge main
  2026-07-06 — always re-confirm on the pre-merge commit before blaming the
  merge): `security.test.ts` symlink test (needs privileges),
  `mcp-initialize.test.ts` / `mcp-roots.test.ts` `afterEach` EPERM temp-dir
  cleanup, and `frameworks-integration.test.ts`'s three "JVM FQN imports —
  end-to-end" tests. Additionally `mcp-daemon.test.ts` and
  `multi-repo-workspace.test.ts` are **flaky** on Windows
  (process-lifecycle/timing) — they fail intermittently on clean main;
  re-run before treating a failure as real.
- **Discrimination procedure when anything else fails:** `git checkout main`
  (pre-merge), run exactly the failing suites there, compare, then
  `git checkout` back to the sync branch. A failure that reproduces at
  baseline is not the merge's fault.
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

  (Flag quirk: `index` takes its path as a positional argument; the query
  commands take `-p`.) Pass = the GameManager scene component links to the
  `GameManager` class (attached-script edge, both directions), and
  `ResetScore` shows its two UnityEvent callers (`RestartButton`, `Player`).

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
