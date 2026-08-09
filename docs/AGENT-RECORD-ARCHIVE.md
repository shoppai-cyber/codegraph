# Agent record archive (codegraph)

Exported 2026-08-09, when the OS Eco toolchain (mulch / seeds / canopy) was removed from this
repository on the owner's decision. These records were written by agents working here and are
kept because the decision retired the *tooling*, not the findings. Nothing reads this file
automatically; it is plain prose so any agent or human can read it without a CLI.

## Expertise records

### Invert string-literal asset resolution: match the declared name set, not the call shape

- Type: `decision` | Domain: `resolution`
- Rationale: Call-shape keying assumes every name is written at a recognizable call. Measured on mirror-multiplayer: keying on Q<T>(literal) yields 31 edges where the inverted match yields 95, because names also arrive via a Region<T>(string) wrapper and via EdgegapWindowMetadata.cs, a const-ID table with zero .Q< sites. Widening the pattern to chase wrapper signatures is unbounded. Inverting flips the failure mode from silent-miss to bounded visible noise. Two constraints follow: emit-nothing-on-ambiguity is a HARD condition (a name declared more than once resolves to nothing -- uniqueness is convention, not structure; four ambiguous names appeared in the first real project), and since extract() receives no ResolutionContext and may run in a worker thread, the membership test must live in resolve() while candidates create no nodes.

### Mirror resolver graduation: round-10 repair merged to local main

- Type: `decision` | Domain: `unity-resolver`
- Rationale: Round-9 partitioned panel (Codex sol-xhigh lexer, GLM identity/scope, Opus preprocessor) REJECTed 4e4d4bc; all findings repaired in one consolidated round per the round-cap commitment, then confirmed PASS by an executable-verification confirmation round.

### compiler-receipt-first-tdd

- Type: `pattern` | Domain: `unity-resolver`
- Description: Compiler-receipt-first TDD for the C# scanner: before implementing any legality rule in unity.ts, pin the real compiler's verdict with a dotnet -p:Case= harness case (pattern from Codex round-9 CompilerCases.csproj: net10.0, LangVersion 12, EnableDefaultCompileItems=false, Mirror stubs + one case file). Then write red regression tests asserting the receipted behavior, then implement. This caught multiple wrong assumptions (e.g. whitespace-only raw-string lines MAY be shorter than the closing prefix; hole-interior lines are indentation-exempt; '#if false /* c */' is CS1025-illegal).
- Files: `.mulch/mulch.config.yaml`, `.overstory/agent-defs/workflow-supervisor.md`, `.seeds/issues.jsonl`

## Issues

- **CodeGraph callers and impact double-count containing file nodes** — status `open` (`codegraph-ef0a`)
  - Observed while dogfooding CodeGraph 1.2.0 on C:\dev\repos\blender\character-creator-originals after initializing its 12-file Python index (263 nodes, 691 edges). Reproduction:   codegraph callers build_fixture -p C:\dev\repos\blender\character-creator-originals Expected: four function callers: _fresh_case, main, _create_phase, and _fresh. Actual: `Callers of "build_fixture" (8)` lists those four function nodes plus four containing file nodes at line 1. The same file-node doubling reproduces for apply_object_control, reconstruct_visible_state, validate_fixture, and impact output. Impact: LOW. Real function edges remain present; counts are inflated and files are labeled as callers. This appears to be core caller aggregation/file attribution, not the Blender framework resolver. Triage may classify it as intended file-level reference behavior, but callers output should distinguish or avoid double-counting. Full evidence: C:\dev\repos\blender\character-creator-originals\staging\mixed-representative-slice\reviews\U1-U5-CODEGRAPH-REVIEW.md, section C-1.
- **Mirror resolver graduation: fix B1/B2/B3 fabrication families, validate vs v96.11.0, adversarial PASS, merge to main** — status `closed` (`codegraph-ac8e`)
