# Mirror resolver validation record — Mirror v96.11.0

Date: 2026-07-16
Resolver branch: `worktree-agent-aee2f98c11370f812` (rounds 5–6 on top of rejected tip `c113cfa`;
round 5 fix `129723f`, round 6 fix in the commit carrying this update)

## Upstream authority

| Field | Value |
|---|---|
| Repository | `https://github.com/MirrorNetworking/Mirror.git` |
| Tag | `v96.11.0` (immutable official release, published 2026-07-14) |
| Commit | `370582a36f6f2cac05669634b924c3da3cab7ac4` |
| Tip commit subject | `breaking: NetworkTime. scaled + unscaled time (#4119)` |
| Local source snapshot | `C:\dev\databases\unity\mirror\96.11.0\source` (read-only; provenance in sibling `manifest.json`) |
| Acquired | 2026-07-16, via `git clone --branch v96.11.0 --depth 1 https://github.com/MirrorNetworking/Mirror.git source` |
| Verification | `git rev-parse HEAD` → `370582a36f6f2cac05669634b924c3da3cab7ac4`; `git describe --tags` → `v96.11.0` |

**Authority rule:** this source snapshot is authoritative for all v96.11.0 API facts. MirrorDocs
(separate repo, `main` @ `b2cc5252a29a660b5244b1efed92e93e6d98e18c`, 2026-04-25) is context only —
it predates this release and must not be used to assert v96.11.0 behavior. The historical
`96.10.3` snapshot (`C:\dev\databases\unity\mirror\96.10.3\`, MirrorDocs sqlite) and its facts file
(`mirror-docs/96.10.3/resolver-facts/MIRROR-RESOLVER-FACTS.md`) are immutable history — never
relabeled or edited for 96.11.0.

## API comparison — every consumed rule re-verified against v96.11.0 source

All rows in `src/resolution/frameworks/unity-invocation-table.json` (`mirror` section) were
originally corpus-verified at 96.10.3. Each was re-checked against the v96.11.0 source tree.
Result: **no consumed rule changed; no relevant symbol was added, renamed, or removed.**

### Host-invoked NetworkBehaviour methods (12 consumed)

`Assets/Mirror/Core/NetworkBehaviour.cs` (`namespace Mirror`, `public abstract class
NetworkBehaviour : MonoBehaviour` line 30):

| Member | v96.11.0 evidence |
|---|---|
| `OnStartServer` / `OnStopServer` | `public virtual`, lines 1466/1469 |
| `OnStartClient` / `OnStopClient` | `public virtual`, lines 1472/1475 |
| `OnStartLocalPlayer` / `OnStopLocalPlayer` | `public virtual`, lines 1478/1481 |
| `OnStartAuthority` / `OnStopAuthority` | `public virtual`, lines 1484/1487 |
| `OnSerialize` / `OnDeserialize` | `public virtual`, lines 1225/1232 |
| `SerializeSyncVars` / `DeserializeSyncVars` | `protected virtual`, lines 1261/1273 |

Excluded-by-role members unchanged: `OnValidate` (line 176 — already a MonoBehaviour message),
`Weaved()` (line 1492 — Weaver-injected marker), `showSyncMethod()` (line 128 — internal editor
affordance). **No new overridable framework-invoked member appeared in v96.11.0.**

Weaver conditional generation still holds
(`Assets/Mirror/Editor/Weaver/Processors/NetworkBehaviourProcessor.cs`):
`GenerateSerialization` (line ~406) and `GenerateDeSerialization` (line ~676) both early-return
when the subclass already declares `SerializeSyncVars`/`DeserializeSyncVars` — a user override is
retained and invoked via `OnSerialize`/`OnDeserialize`, so both remain valid host-invoked rows.

### RPC attribute entry points (3 consumed)

`Assets/Mirror/Core/Attributes.cs` (`namespace Mirror`, line 4): `CommandAttribute`,
`ClientRpcAttribute`, `TargetRpcAttribute` all present. The Weaver still keys RPC processing off
exactly these three (`NetworkBehaviourProcessor.cs` lines 946/952/958:
`ca.AttributeType.Is<CommandAttribute|TargetRpcAttribute|ClientRpcAttribute>()`).

A repo-wide sweep of `Assets/Mirror/Core` for `class \w+Attribute` returns exactly the 96.10.3
attribute universe — 12 attributes, no additions, no removals:
SyncVar, Command, ClientRpc, TargetRpc (consumed); Server, ServerCallback, Client, ClientCallback
(guards — excluded, unchanged); Scene, ShowInInspector, ReadOnly, WeaverPriority (editor —
excluded, unchanged).

### SyncVar fields and hooks

`Assets/Mirror/Editor/Weaver/Processors/SyncVarAttributeProcessor.cs`:

- `ProcessSyncVars` (line ~445) still enumerates `td.Fields` bearing `SyncVarAttribute`.
- Static `[SyncVar]` is still a Weaver **error** (line ~462: `"{fd.Name} cannot be static"`) —
  the resolver's static/const emit-nothing rule remains exact parity.
- Generic-typed SyncVars are a Weaver error (line ~469) — resolver never keyed on this; no impact.
- `FindHookMethod` (line 126) still resolves the hook string via `td.GetMethods(hookFunctionName)`
  (line 128) — **same-declaring-type-only lookup**, so the resolver's same-class-block matching
  remains aligned with the Weaver, not narrower.
- v96.11.0 explicitly supports **static hook methods** (`GenerateNewActionFromHookMethod`, comment
  "we support static hooks and instance hooks"). The resolver does not filter hook targets by
  static-ness, which is therefore correct, not a fabrication risk.
- `SyncVarAttribute.hook` is still a plain `public string hook;` (Attributes.cs line 17).

### v96.11.0 breaking change assessed

The release's breaking change (`NetworkTime` scaled + unscaled time, #4119) touches no consumed
row: `NetworkTime` is not a host base, attribute, or SyncVar mechanism, and the resolver never
references it. No resolver change required for v96.11.0.

## Round-5 blocker outcomes (B1/B2/B3)

Prior adversarial verdict at tip `c113cfa` was REJECT (despite 178 green tests) on three
fabrication families. All three were reproduced at the tip via executable probe
(source of truth: probe against built `dist/`), fixed TDD-first, and re-probed green:

| Blocker | Tip behavior (reproduced) | Post-fix behavior |
|---|---|---|
| B1 — `global::`/extern-alias RHS discarded, bare LHS falls back to gated host | fabricated Mirror host + Command rows | alias-bound bare names shadowed in classification and base-chaining → **emit nothing**; supported same-scope alias control still emits |
| B2 — file-wide alias applied across namespace scopes | fabricated rows for classes outside the alias's namespace | positional, namespace-scoped alias resolution (exactly one distinct active visible target) → **emit nothing** across scopes; same-scope + file-scoped-namespace controls still emit |
| B3 — `using Mirror;` inside `#if false` opens the gate | fabricated rows from provably-inactive text | three-state preprocessor analysis (active/unknown/inactive) with asymmetric gate semantics: evidence requires provably-active text; competing-stack exclusion fires from potentially-active (active+unknown) text; provably-inactive regions blanked → **emit nothing**; `#else`-of-`#if false` correctly active |

Governing rule preserved throughout: **when C# identity or scope is uncertain, emit nothing** —
a missed edge is strictly preferred to a fabricated edge.

## Round-6 findings (independent adversarial review of the round-5 state)

The round-6 review (Codex GPT-5.6 Sol xhigh, Overstory lane `r5-mirror-review`; artifact
`ROUND5-REVIEW.md`) confirmed B1/B2/B3 closed, source/dist parity, and doc counts, then returned
**REJECT** on two new fabrication families — rows emitted from compilation units the C# compiler
rejects (verified by the reviewer against .NET SDK 10.0.301):

| Finding | Illegal shape | Compiler error | Fix |
|---|---|---|---|
| N1 | class/type declared before a file-scoped `namespace X;` | CS8956 | whole file emits nothing |
| N2 | file-scoped + block namespaces mixed in one file (either order) | CS8955 | whole file emits nothing |
| (adjacent) | two file-scoped declarations | CS8954 | whole file emits nothing |

Fixed TDD-first: 6 regression tests added (5 red before the fix — N1 across all four emission
kinds, N1 struct-variant, N2 both orders, CS8954, plus an `#if false` control proving the layout
check runs on preprocessor-blanked text). After the fix: targeted suite **234/234** (unity 166 +
unity-assets 36 + blender 32), blocker probe zero fabrications, the reviewer's own 23-fixture
probe suite reruns with `unexpected=0`, and the 923-file real-project scan is unchanged (zero
rows lost — no legal real file trips the layout check).

## Round-7 findings (independent adversarial review of the round-6 state)

The round-7 review (fresh Codex GPT-5.6 Sol xhigh pane, Overstory lane `r7-mirror-review`;
artifact `ROUND7-REVIEW.md`, probes `round7-adversarial-probes.mjs` + compiler receipts, .NET SDK
10.0.301) confirmed the blocker probe, the prior 23-fixture suite (`unexpected=0`), the targeted
counts and source/dist parity (25/25 novel fixtures byte-equal), then returned **REJECT** on the
identifier grammar: the round-6 layout check, the namespace-span scanner and the class scanner
each encoded a different ASCII-only subset of C#'s identifier grammar (verbatim `@` prefixes and
Unicode identifier characters are legal C#), and the gaps fabricated or falsely suppressed:

| Finding | Shape | Compiler receipt | Direction |
|---|---|---|---|
| I3/I4 | `@`-escaped / Unicode type name before file-scoped namespace | CS8956 | fabrication |
| I5 | top-level statement before file-scoped namespace | CS8956 | fabrication |
| I6/I7/I8 | `@`-escaped / Unicode namespace name in file-scoped+block mixes | CS8955 | fabrication |
| A1 | legal `class @namespace : NetworkBehaviour` | compiles clean | false suppression |

Fixed TDD-first: 14 regression tests added (12 red before the fix — I3-I8, a `using (…)`
statement prelude, a nameless `namespace {`, A1, an `@`-escaped alias LHS, an `@`-escaped local
shadow, a `\uXXXX`-escaped shadow; plus 2 green controls pinning the legal prelude and
escapes-in-strings). The fix unifies all name scanners on one shared C# identifier grammar with
canonicalization (`@X` ≡ `X`), makes layout classification name-agnostic (keyword + delimiter;
unparsable declaration ⇒ suppress), replaces the CS8956 type-keyword blacklist with a
legal-prelude whitelist (extern alias / using directives / assembly-module attributes only), and
suppresses any file carrying Unicode identifier escapes the scanner cannot decode. After the
fix: targeted suite **248/248**, blocker probe zero fabrications, prior 23-fixture suite
`unexpected=0`, the round-7 reviewer's own 25-fixture suite `unexpected=0 parityMismatches=0`
(A1 emits `namespace.OnStartServer` / `namespace.Cmd`), and the Mirror-source scan shows the
identical result (zero rows lost — no legal real file trips the whitelist or the escape guard).

## Round-8 findings (parallel adversarial panel of the round-7 state, commit `dfea637`)

Round 8 ran as a three-reviewer parallel panel — independent Codex sol-xhigh (Overstory lane
`r8-mirror-review-codex`, dotnet compiler receipts), GLM (`r8-mirror-review-glm`), and Opus
(Agent-Teams `r8-mirror-review-opus`) — each probing to exhaustion instead of stopping at the
first REJECT. All three confirmed every prior suite stayed closed (blocker probe, 23-fixture,
25-fixture, targeted counts, source/dist parity) and all three returned **REJECT**. Artifacts:
`scratch/round8-review/{codex,glm,opus}/` (fork-local, gitignored).

| Finding | Reviewer | Shape | Direction |
|---|---|---|---|
| ID10 | Codex | U+200D (Cf) in `interface Net‍workBehaviour` — ECMA-334 §6.4.3 removes Cf for identity; scanner compared verbatim, shadow missed | fabrication |
| ID11 | Codex | `namespace class;` — reserved keyword accepted as namespace name (CS-rejected) | fabrication |
| ID13 | Codex | `: @NetworkBehaviour` base clause (base scanner was ASCII-only) | false suppression |
| ID14 | Codex | `using NB = Mirror.@NetworkBehaviour;` alias target | false suppression |
| ID15 | Codex | `[@CommandAttribute]` attribute spelling | row lost |
| P7 | Codex | `using T = ;` empty alias target passed the prelude whitelist (CS-rejected) | fabrication |
| P8 | Codex | `[assembly:]` empty attribute list passed the whitelist (CS-rejected) | fabrication |
| R8-1 | Opus | `\u` sequence as DATA inside a C# 11 raw string (`"""…"""` JSON/regex) tripped the escape guard — the masker had no raw-string awareness | false suppression (whole legal file) + falsified doc claim |
| F1 | GLM | one internal `"` (legal raw-string content) desynced the masker; `class Decoy : NetworkBehaviour` inside the literal emitted rows | **fabrication** |
| F2a/F2b | GLM | same desync consumed real code as string content (with or without `\u`) | false suppression |

Fixed TDD-first as five classes (32 regression tests added; 12 + 8 red at `dfea637`):
Cf-stripping canonicalization; a 77-keyword `RESERVED_KEYWORDS` check at every
identifier-required position; `CS_ID`/`CS_QID` + canonicalization extended to base clauses,
alias targets, and attribute names; token-level prelude shape validators (`isShapeValidType`,
`isShapeValidAttributeList`); and `maskCSharpLiterals` — a single-pass C# literal lexer (line/
block comments, directive lines, char literals, regular/verbatim/interpolated/raw strings,
`$$"""` fences, interpolation holes with recursively-lexed nested literals) producing
offset-aligned `code` (literals/comments/freeform-directive tails blanked) and `text` (literals
kept, for string-content readers) views; an unterminated or unsoundly-lexable literal suppresses
the whole file. After the fix all three reviewers' own probe suites rerun clean: Codex 37
fixtures `unexpected=0 parityMismatches=0`; Opus 34-fixture main suite `fabrications=0
falseSuppressions=0 parityMismatches=0` plus all raw-string suites (realraw 5/5 EMIT, isolate
3/3 EMIT, rawedge 7/7 EMIT, rawfab 0 fabrications, rawstring 5/5); GLM's F1/F2 shapes are pinned
by the new regression tests. Opus's advisory C1 (`: @NetworkBehaviour` missed edge) now emits
via the ID13 fix.

**Fabrication boundary (adopted this round; review judges a satisfiable standard).** An emission
is *fabricated* when the scanner's IDENTITY or SCOPE reasoning is unsound for the emitted row —
name identity (escapes, Cf, keywords), declaration scope (namespaces, aliases, shadows, kills),
file-scoped-namespace layout legality, and literal/comment/directive lexing are in scope; any
error there suppresses. Expression-level compile errors (attribute argument expressions, method
bodies, interpolation-hole contents) are outside scanner scope: a regex scanner cannot verify
whole-file compilability, and rows from such files are not fabrications provided the
identity/scope reasoning for the row itself is sound.

## Executable evidence (exact counts)

All runs on Windows (this machine), Node from repo toolchain, in the resolver worktree,
2026-07-16/17 (round-5 numbers at commit `129723f`; round-6/7 updates at the commits noted in
their sections).

### Targeted gate

```
npx vitest run __tests__/unity.test.ts __tests__/unity-assets.test.ts __tests__/blender.test.ts
```

- `__tests__/unity.test.ts` — **212 passed** (142 prior + 18 round-5 regression tests covering
  B1×4, B2×5, B3×9 (12 red at tip `c113cfa`) + 6 round-6 tests covering N1/N2/CS8954 (5 red
  before the round-6 fix) + 14 round-7 identifier-grammar tests (12 red before the round-7 fix)
  + 32 round-8/9 tests across the panel's defect classes (12 + 8 red at `dfea637`))
- `__tests__/unity-assets.test.ts` — **36 passed**
- `__tests__/blender.test.ts` — **32 passed**
- Total targeted: **280/280 passed, 0 failed**

### Build + dist parity probe

`npm run build` — clean. Probe (`blocker-repro-probe.mjs`) against the freshly built
`dist/resolution/frameworks/unity.js`: all B1/B2/B3 fabrication cases **EMPTY**, all controls
(normal Mirror class, same-scope alias, `#else`-active, active `using Mirror;`) **emit** the
expected host/Command rows. Source-tip and dist behavior match.

### Full suite with pre-change baselining

`npm test` at `129723f`: **1931 passed | 11–12 failed | 33 skipped (2354 tests, 127 files)**.
After the round-6 fix: **1938 passed | 10 failed | 33 skipped (2360 tests)** — the same
pre-existing failure families, zero new. After the round-7 fix: **1947 passed | 9 failed |
33 skipped (2374 tests)** — again only the pre-existing families (JVM/Kotlin ×3,
mcp-initialize ×3, mcp-roots ×3; the flaky daemon-lifecycle test passed this run). After the
round-9 fix: **1980 passed | 11 failed | 33 skipped (2406 tests)** — the same 9 pre-existing
families plus 2 flaky `mcp-daemon` lifecycle tests that reproduce identically on unmodified
`main` under machine load (both daemon suites pass 9/9 in isolation in the worktree AND on
`main`; the flakes vary test-to-test run-to-run and are environmental, not branch-caused).

Every failure was re-run at the pre-change baseline (round-5 diff stashed) and reproduced there:

| File | Failures | Status |
|---|---|---|
| `frameworks-integration.test.ts` (JVM/Kotlin FQN imports) | 3 | pre-existing (also recorded by round 4/5 handoff) |
| `mcp-initialize.test.ts` | 3 | pre-existing documented Windows EPERM teardown quirk |
| `mcp-roots.test.ts` | 3 | pre-existing documented Windows EPERM teardown quirk |
| `mcp-daemon.test.ts` | 1–2 (one flaky run-to-run) | pre-existing Windows process/file-locking family; reproduced at baseline |

Baseline run of those 4 files (changes stashed): **10 failed** — same families
(the 12th/11th failure is a flaky daemon-lifecycle test that fails intermittently in both states).
None of the failures touch unity, resolution, or any file changed by this branch.

### Real-project validation (Mirror v96.11.0 source as the corpus)

Every `.cs` file under the acquired release's `Assets/Mirror` tree (923 files — Core, Examples,
Authenticators, Tests: real user-style Mirror code) was run through **both** resolver builds
(round-5 fix vs a from-source build of rejected tip `c113cfa`, which reproduces all six probe
fabrications) and the emitted rows diffed per file:

- files scanned: **923**; files with rows (new build): **313**
- total rows — new: **1707**, baseline: **1703**, delta: **+4**; extraction errors: **0**
- files with differing rows: **2**, both pure GAINS (zero rows lost anywhere):
  - `Authenticators/UniqueNameAuthenticator.cs` — `[UnityEngine.RuntimeInitializeOnLoadMethod]`
    `ResetStatics` (a genuine Unity-invoked static entry point; the baseline's scanner was
    desynced by raw `#if !UNITY_2020_3_OR_NEWER`/`#else` field-declaration lines).
  - `Examples/TopDownShooter/Scripts/PlayerTopDown.cs` — `[Command] CmdFlashLight` (a genuine
    Mirror Command in a `NetworkBehaviour` class with an active top-level `using Mirror;`; the
    baseline was desynced by the file's many `#if !UNITY_SERVER` regions).

Conclusion: the round-5 suppressions cause **no regression on real code** — no mass suppression
from real-world `#if` regions or scoped aliases — and blanking directive lines *recovered* two
genuine rows the old scanner dropped. Scan tooling: `real-project-scan.mjs` /
`blocker-repro-probe.mjs` (fork-local, gitignored `scratch/round5-review/`).

Re-run after the round-7 fix (invoked from the acquisition root one level above `Assets`, hence
one extra scanned file): **924 scanned, 314 with rows, new 1709 vs baseline 1705 (+4)**, the same
two pure-gain files, zero rows lost anywhere — the legal-prelude whitelist, the name-agnostic
namespace scanner and the Unicode-escape guard suppress **no** legal real Mirror file.

Re-run after the round-9 fix (reserved-keyword checks, prelude shape validators, and the C#
literal lexer all active): **identical result — 924 scanned, 314 with rows, 1709 vs 1705 (+4),
the same two pure-gain files, zero rows lost anywhere.** Caveat recorded by the round-8 panel:
this corpus contains **zero raw string literals** (GLM verified by grep), so it cannot exercise
the raw-string surface; that surface is pinned instead by the 18 raw-string/lexer regression
tests and the three reviewers' probe suites rerun clean.

Re-run after the round-10 fix (directive-tail lexing, excluded-region skipping, tri-state
condition folding, raw-string layout grammar, leading-Cf base rejection): **identical result —
924 scanned, 314 with rows, 1709 vs 1705 (+4), the same two pure-gain files
(`UniqueNameAuthenticator.cs`, `PlayerTopDown.cs`), zero rows lost anywhere.**

## Round-10 compiler receipts (dotnet SDK 10.0.301, C# 12, LangVersion 12.0)

Every round-10 behavior change was legality-receipted BEFORE implementation with a `-p:Case=`
compiler harness (net10.0, `EnableDefaultCompileItems=false`, Mirror stubs; extends the round-9
Codex `CompilerCases.csproj` pattern). Results, verbatim:

| Case | Verdict | Pins |
|---|---|---|
| `WsEmptyLine` | LEGAL | empty line inside a multiline raw string needs no indentation prefix |
| `WsShortLine` | LEGAL | whitespace-only line may be SHORTER than the closing prefix (same kind) |
| `WsTabLine` | CS9003 | whitespace-only line of a different whitespace KIND is illegal |
| `WsContentShort` | CS8999 | content line not led by the closing whitespace prefix is illegal |
| `RawHoleLineNoIndent` | LEGAL | a line starting inside an interpolation hole is indentation-exempt |
| `RawHoleMultiNoIndent` | LEGAL | multiple hole-interior lines are all indentation-exempt |
| `RawCloseAfterHole` | CS9000 | a hole ending on the closing-fence line is illegal (close must be alone) |
| `PPDeadUnterminatedString` | LEGAL | unterminated string inside `#if false` (excluded text is not compiled) |
| `PPDeadUnterminatedRawFence` | LEGAL | unterminated raw fence inside `#if false` |
| `PPCompoundFalse` | LEGAL | `#if false && true` + arbitrary garbage in region — region provably dead |
| `PPCompoundTrueOr` | LEGAL | `#if true \|\| UNDEFINED` — region provably live |
| `FormFeedRegion` | LEGAL | form-feed before `#region` — still a directive |
| `FormFeedIf` | LEGAL | form-feed before `#if false` — still a directive, region dead |
| `PPIfQuoteJunk` | CS1025 | a quote in an `#if` tail is illegal (only `//` comments may follow) |
| `PPElifChain` | LEGAL | odd-quote `//` comments on `#if`/`#elif`/`#else` chains |

## Round-10 gate results (worktree, post-fix)

- `npx vitest run __tests__/unity.test.ts __tests__/unity-assets.test.ts __tests__/blender.test.ts __tests__/unity-round10.test.ts`:
  **311 passed / 311** (212 + 36 + 32 + 31; the 31 new round-10 tests were 22 red / 9 green at
  `4e4d4bc`). `npx tsc --noEmit` exit 0; `npm run build` exit 0.
- Probe suites (bun, src + dist, parity clean in every run):
  - Codex round-9 67-fixture suite: **66/67, parityMismatches=0, lineMismatches=0.** The single
    delta is PP04 (`#if false /* c */` expected EMIT) — Codex's own round-9 review corrected
    this control to CS1025-illegal and excluded it from blockers; r10 suppresses (pinned by a
    round-10 test). Fixture kept verbatim for provenance.
  - Codex round-8 37-fixture suite: **unexpected=0, parityMismatches=0.**
  - GLM round-9 25-fixture suite: **24/25, parityMismatches=0.** The single delta is F-RG-19
    (alias-only Mirror gate evidence), which GLM's review itself classifies as a coverage-bound
    question — a conservative miss, not a fabrication. Unchanged from round 9.
  - Round-7 reviewer 25-fixture suite: **unexpected=0, parityMismatches=0.**
  - Round-5 23-fixture suite: **22/23.** The single delta is P6 (`#if true && true` expected to
    stay 'unknown') — stale by design: round-10 tri-state folding proves it TRUE (receipted),
    so the active `using Mirror;` correctly opens the gate. A5 remains a passing advisory miss.
  - Blocker-repro probe (B1/B2/B3): **10/10 OK.**
- Full `npm test`: **2014 passed / 11 failed / 33 skipped** — the identical 11 pre-existing
  Windows-environment failures recorded at the round-9 gate (JVM FQN ×3, MCP initialize ×3, MCP
  roots ×3, MCP daemon ×2; file-locking/timing suites, none touching the resolver).

## Conservative omissions (deliberate missed edges, unchanged)

Recorded in the invocation table; re-affirmed against v96.11.0 — none became unsafe:

- Deferred host bases: `NetworkManager`, `NetworkRoomManager`, `NetworkRoomPlayer`,
  `NetworkAuthenticator`, `InterestManagement` (cross-file MonoBehaviour chains; NGO name
  collision). Still deferred, still real virtual surfaces at v96.11.0.
- Guard attributes (`Server`/`ServerCallback`/`Client`/`ClientCallback`) and editor attributes —
  excluded by role; unchanged at v96.11.0.
- Overloaded SyncVar hook names, cross-partial/cross-file hooks, derived-class virtual hook
  overrides — emit nothing (Weaver would resolve; we deliberately miss rather than guess).
- Cross-file inherited `[SyncVar]` fields; generic container element types (`SyncList<T>`'s `T`).
- Message handlers (`RegisterHandler<T>`) and SyncObject `+=` callbacks — covered by the general
  function-ref mechanism; no Mirror-specific rule (avoids double-emit).
- Round-5 additions: an alias whose target cannot be positively resolved suppresses its bare
  token entirely (B1); an alias is invisible outside its namespace scope even when the reference
  would be legal C# via outer-scope lookup in some layouts (B2 — suppression over guessed
  ownership); `using Mirror;` under an *unknown* preprocessor symbol (e.g. `#if UNITY_SERVER`)
  is NOT evidence, while a competing stack's using under the same unknown region still closes
  the gate (B3 asymmetry — both directions favor emit-nothing).
