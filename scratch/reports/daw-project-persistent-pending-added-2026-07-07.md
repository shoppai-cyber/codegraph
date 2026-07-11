# DAW Project Persistent Pending Added Status

Date: 2026-07-07

Status: candidate CodeGraph status/change-detection bug.

Originating repo:

```text
C:\dev\repos\sound\daw-project
```

Observed from CodeGraph fork work context:

```text
C:\dev\repos\forks\codegraph
```

## Summary

The fresh DAW repo reports a persistent CodeGraph pending status:

```text
Pending Changes:
  Added: 2 files
```

This persists after:

```powershell
codegraph sync C:\dev\repos\sound\daw-project
codegraph index C:\dev\repos\sound\daw-project
codegraph sync C:\dev\repos\sound\daw-project
```

The indexed graph itself appears usable and current for the files CodeGraph lists. This looks like a status/change-detection disagreement rather than a broken index.

## Installed CodeGraph Route

The `codegraph` command in the DAW session resolves to the global npm install:

```text
C:\Users\Kyle\AppData\Roaming\npm\codegraph.ps1
C:\Users\Kyle\AppData\Roaming\npm\node_modules\@colbymchenry\codegraph\dist\bin\codegraph.js
```

Reported version:

```text
1.2.0
```

This may differ from Kyle's private fork state.

## Repro Data From DAW Repo

Command:

```powershell
codegraph status --json C:\dev\repos\sound\daw-project
```

Observed JSON:

```json
{
  "initialized": true,
  "version": "1.2.0",
  "projectPath": "C:\\dev\\repos\\sound\\daw-project",
  "indexPath": "C:\\dev\\repos\\sound\\daw-project\\.codegraph",
  "fileCount": 6,
  "nodeCount": 72,
  "edgeCount": 178,
  "backend": "node-sqlite",
  "journalMode": "wal",
  "languages": ["javascript", "typescript"],
  "pendingChanges": {"added": 2, "modified": 0, "removed": 0},
  "worktreeMismatch": null,
  "index": {
    "builtWithVersion": "1.2.0",
    "builtWithExtractionVersion": 24,
    "currentExtractionVersion": 24,
    "reindexRecommended": false
  }
}
```

Command:

```powershell
codegraph files -p C:\dev\repos\sound\daw-project --format flat
```

Indexed files:

```text
research/proofs/opendaw-roundtrip-2026-07-07-8note/opendaw-script.ts
src/opendaw-bridge/cli.mjs
src/opendaw-bridge/roundtrip.mjs
tests/opendaw-bridge.test.mjs
tests/opendaw-cli.test.mjs
vitest.config.mjs
```

These are the expected source files for the current DAW bridge. `codegraph sync` reports the index is already up to date, but `status` still reports `added: 2`.

## DAW Git State Context

The DAW repo is a no-commit bootstrap repo. Most files are untracked.

The untracked source-ish/root files include:

```text
package.json
package-lock.json
delegation/fleet-manifest.example.json
examples/opendaw/eight-note-phrase.json
research/proofs/opendaw-roundtrip-2026-07-07-8note/extracted-phrase.json
research/proofs/opendaw-roundtrip-2026-07-07-8note/input.json
research/proofs/opendaw-roundtrip-2026-07-07-8note/opendaw-script.ts
research/proofs/opendaw-roundtrip-2026-07-07-8note/readback.json
src/opendaw-bridge/cli.mjs
src/opendaw-bridge/roundtrip.mjs
tests/opendaw-bridge.test.mjs
tests/opendaw-cli.test.mjs
vitest.config.mjs
```

The two pending additions are not exposed by `status --json`, so the exact paths are unknown from the public CLI output.

## Negative Controls

I tried two small temp repos with the same globally installed `codegraph`:

1. New git repo with two untracked JS source files.
2. New git repo with one untracked JS source file plus untracked `package.json` and `package-lock.json`.

In both cases:

```text
pendingChanges.added: 0
```

after `codegraph init` and after `codegraph sync`.

So this is not trivially reproduced by all untracked bootstrap repos or by root package JSON alone.

## Relevant Source Pointers

The likely area is change detection/status disagreement, not graph query behavior:

```text
src/bin/codegraph.ts
  status command renders pendingChanges from getChangedFiles()

src/extraction/index.ts
  getGitChangedFiles()
  collectGitStatus()
  comments around untracked files, ignored files, and issue #206/#766 behavior

__tests__/sync.test.ts
  should stop reporting untracked files once they are indexed (issue #206)
  status (getChangedFiles) agrees with sync - no phantom pending changes
```

## Suggested Investigation

1. Add or temporarily expose pending filenames in `codegraph status --json`.
2. Re-run against `C:\dev\repos\sound\daw-project`.
3. Compare `getChangedFiles().added` against `codegraph files -p ... --json`.
4. Check whether the two pending paths are generated/binary/non-indexed files that pass `isSourceFile()` in the fast git-status path but are excluded by the full index path.
5. Add a regression test once reduced.

## Severity

P2.

The DAW repo can still use CodeGraph for source orientation. The issue is misleading onboarding/status output: an agent sees "Pending Changes: Added 2" after sync/index and may think the index is stale when it is probably usable.

## Source Of This Report

This report came from DAW onboarding work in:

```text
C:\dev\repos\sound\daw-project
```

Related DAW-side report:

```text
C:\dev\repos\sound\daw-project\delegation\onboarding-codegraph-mismatch-report-2026-07-07.md
```
