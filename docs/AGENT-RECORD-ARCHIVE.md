# Agent record archive (codegraph)

Exported 2026-08-09, when the OS Eco toolchain (mulch / seeds / canopy) was removed from this
repository on the owner's decision. These records were written by agents working here and are
kept because the decision retired the *tooling*, not the findings. Nothing reads this file
automatically; it is plain prose so any agent or human can read it without a CLI.

Each entry is rendered for reading and then repeated verbatim as JSON, so no field is lost to
the prose summary — including `id`, `classification`, `recorded_at`, and `evidence` (the commit
that produced the finding). A line that could not be parsed is preserved as raw text rather
than skipped.

## Expertise records

### Invert string-literal asset resolution: match the declared name set, not the call shape

- Type: `decision` | Domain: `resolution`
- Rationale: Call-shape keying assumes every name is written at a recognizable call. Measured on mirror-multiplayer: keying on Q<T>(literal) yields 31 edges where the inverted match yields 95, because names also arrive via a Region<T>(string) wrapper and via EdgegapWindowMetadata.cs, a const-ID table with zero .Q< sites. Widening the pattern to chase wrapper signatures is unbounded. Inverting flips the failure mode from silent-miss to bounded visible noise. Two constraints follow: emit-nothing-on-ambiguity is a HARD condition (a name declared more than once resolves to nothing -- uniqueness is convention, not structure; four ambiguous names appeared in the first real project), and since extract() receives no ResolutionContext and may run in a worker thread, the membership test must live in resolve() while candidates create no nodes.

<details><summary>Complete record</summary>

```json
{
  "type": "decision",
  "title": "Invert string-literal asset resolution: match the declared name set, not the call shape",
  "rationale": "Call-shape keying assumes every name is written at a recognizable call. Measured on mirror-multiplayer: keying on Q<T>(literal) yields 31 edges where the inverted match yields 95, because names also arrive via a Region<T>(string) wrapper and via EdgegapWindowMetadata.cs, a const-ID table with zero .Q< sites. Widening the pattern to chase wrapper signatures is unbounded. Inverting flips the failure mode from silent-miss to bounded visible noise. Two constraints follow: emit-nothing-on-ambiguity is a HARD condition (a name declared more than once resolves to nothing -- uniqueness is convention, not structure; four ambiguous names appeared in the first real project), and since extract() receives no ResolutionContext and may run in a worker thread, the membership test must live in resolve() while candidates create no nodes.",
  "classification": "tactical",
  "recorded_at": "2026-07-28T02:26:48.844Z",
  "evidence": {
    "commit": "0aef579198c703ce61098ade099127599c27f7e9"
  },
  "id": "mx-75ad57"
}
```

</details>

### Mirror resolver graduation: round-10 repair merged to local main

- Type: `decision` | Domain: `unity-resolver`
- Rationale: Round-9 partitioned panel (Codex sol-xhigh lexer, GLM identity/scope, Opus preprocessor) REJECTed 4e4d4bc; all findings repaired in one consolidated round per the round-cap commitment, then confirmed PASS by an executable-verification confirmation round.

<details><summary>Complete record</summary>

```json
{
  "type": "decision",
  "title": "Mirror resolver graduation: round-10 repair merged to local main",
  "rationale": "Round-9 partitioned panel (Codex sol-xhigh lexer, GLM identity/scope, Opus preprocessor) REJECTed 4e4d4bc; all findings repaired in one consolidated round per the round-cap commitment, then confirmed PASS by an executable-verification confirmation round.",
  "classification": "tactical",
  "recorded_at": "2026-07-17T07:48:45.090Z",
  "evidence": {
    "commit": "63e5d7d"
  },
  "id": "mx-e0c8b1"
}
```

</details>

### compiler-receipt-first-tdd

- Type: `pattern` | Domain: `unity-resolver`
- Description: Compiler-receipt-first TDD for the C# scanner: before implementing any legality rule in unity.ts, pin the real compiler's verdict with a dotnet -p:Case= harness case (pattern from Codex round-9 CompilerCases.csproj: net10.0, LangVersion 12, EnableDefaultCompileItems=false, Mirror stubs + one case file). Then write red regression tests asserting the receipted behavior, then implement. This caught multiple wrong assumptions (e.g. whitespace-only raw-string lines MAY be shorter than the closing prefix; hole-interior lines are indentation-exempt; '#if false /* c */' is CS1025-illegal).
- Files: `.mulch/mulch.config.yaml`, `.overstory/agent-defs/workflow-supervisor.md`, `.seeds/issues.jsonl`

<details><summary>Complete record</summary>

```json
{
  "type": "pattern",
  "name": "compiler-receipt-first-tdd",
  "description": "Compiler-receipt-first TDD for the C# scanner: before implementing any legality rule in unity.ts, pin the real compiler's verdict with a dotnet -p:Case= harness case (pattern from Codex round-9 CompilerCases.csproj: net10.0, LangVersion 12, EnableDefaultCompileItems=false, Mirror stubs + one case file). Then write red regression tests asserting the receipted behavior, then implement. This caught multiple wrong assumptions (e.g. whitespace-only raw-string lines MAY be shorter than the closing prefix; hole-interior lines are indentation-exempt; '#if false /* c */' is CS1025-illegal).",
  "classification": "tactical",
  "recorded_at": "2026-07-17T07:49:20.685Z",
  "evidence": {
    "commit": "63e5d7ded50717ad3c80564f8f48b5847e42fc17"
  },
  "files": [
    ".mulch/mulch.config.yaml",
    ".overstory/agent-defs/workflow-supervisor.md",
    ".seeds/issues.jsonl"
  ],
  "id": "mx-c1f3a7"
}
```

</details>

## Issues

### CodeGraph callers and impact double-count containing file nodes

- Status: `open` | ID: `codegraph-ef0a`
- Observed while dogfooding CodeGraph 1.2.0 on C:\dev\repos\blender\character-creator-originals after initializing its 12-file Python index (263 nodes, 691 edges). Reproduction:   codegraph callers build_fixture -p C:\dev\repos\blender\character-creator-originals Expected: four function callers: _fresh_case, main, _create_phase, and _fresh. Actual: `Callers of "build_fixture" (8)` lists those four function nodes plus four containing file nodes at line 1. The same file-node doubling reproduces for apply_object_control, reconstruct_visible_state, validate_fixture, and impact output. Impact: LOW. Real function edges remain present; counts are inflated and files are labeled as callers. This appears to be core caller aggregation/file attribution, not the Blender framework resolver. Triage may classify it as intended file-level reference behavior, but callers output should distinguish or avoid double-counting. Full evidence: C:\dev\repos\blender\character-creator-originals\staging\mixed-representative-slice\reviews\U1-U5-CODEGRAPH-REVIEW.md, section C-1.

<details><summary>Complete record</summary>

```json
{
  "id": "codegraph-ef0a",
  "title": "CodeGraph callers and impact double-count containing file nodes",
  "status": "open",
  "type": "bug",
  "priority": 3,
  "createdAt": "2026-07-11T16:42:36.222Z",
  "updatedAt": "2026-07-11T16:42:36.222Z",
  "description": "Observed while dogfooding CodeGraph 1.2.0 on C:\\dev\\repos\\blender\\character-creator-originals after initializing its 12-file Python index (263 nodes, 691 edges).\n\nReproduction:\n  codegraph callers build_fixture -p C:\\dev\\repos\\blender\\character-creator-originals\n\nExpected: four function callers: _fresh_case, main, _create_phase, and _fresh.\nActual: `Callers of \"build_fixture\" (8)` lists those four function nodes plus four containing file nodes at line 1. The same file-node doubling reproduces for apply_object_control, reconstruct_visible_state, validate_fixture, and impact output.\n\nImpact: LOW. Real function edges remain present; counts are inflated and files are labeled as callers. This appears to be core caller aggregation/file attribution, not the Blender framework resolver. Triage may classify it as intended file-level reference behavior, but callers output should distinguish or avoid double-counting.\n\nFull evidence: C:\\dev\\repos\\blender\\character-creator-originals\\staging\\mixed-representative-slice\\reviews\\U1-U5-CODEGRAPH-REVIEW.md, section C-1.",
  "labels": [
    "python",
    "call-graph",
    "dogfood"
  ]
}
```

</details>

### Mirror resolver graduation: fix B1/B2/B3 fabrication families, validate vs v96.11.0, adversarial PASS, merge to main

- Status: `closed` | ID: `codegraph-ac8e`

<details><summary>Complete record</summary>

```json
{
  "id": "codegraph-ac8e",
  "title": "Mirror resolver graduation: fix B1/B2/B3 fabrication families, validate vs v96.11.0, adversarial PASS, merge to main",
  "status": "closed",
  "type": "task",
  "priority": 1,
  "createdAt": "2026-07-17T03:00:20.638Z",
  "updatedAt": "2026-07-17T07:48:10.430Z"
}
```

</details>
