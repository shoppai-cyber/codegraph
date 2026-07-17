# Mirror resolver validation record — Mirror v96.11.0

Date: 2026-07-16
Resolver branch: `worktree-agent-aee2f98c11370f812` (round 5, commit `129723f` on top of tip `c113cfa`)

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

## Executable evidence (exact counts)

All runs on Windows (this machine), Node from repo toolchain, at commit `129723f` in the resolver
worktree, 2026-07-16.

### Targeted gate

```
npx vitest run __tests__/unity.test.ts __tests__/unity-assets.test.ts __tests__/blender.test.ts
```

- `__tests__/unity.test.ts` — **160 passed** (142 prior + 18 new round-5 regression tests;
  the 18 covered B1×4, B2×5, B3×9; 12 were red at tip `c113cfa`, 6 were controls already green)
- `__tests__/unity-assets.test.ts` — **36 passed**
- `__tests__/blender.test.ts` — **32 passed**
- Total targeted: **228/228 passed, 0 failed**

### Build + dist parity probe

`npm run build` — clean. Probe (`blocker-repro-probe.mjs`) against the freshly built
`dist/resolution/frameworks/unity.js`: all B1/B2/B3 fabrication cases **EMPTY**, all controls
(normal Mirror class, same-scope alias, `#else`-active, active `using Mirror;`) **emit** the
expected host/Command rows. Source-tip and dist behavior match.

### Full suite with pre-change baselining

`npm test` at `129723f`: **1931 passed | 11–12 failed | 33 skipped (2354 tests, 127 files)**.

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
