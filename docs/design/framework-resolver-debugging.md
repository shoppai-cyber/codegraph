# Framework Resolver Debugging & Triage Playbook

Runbook for diagnosing and fixing bugs in codegraph's **host-invocation** framework
resolvers: the Blender add-on resolver (Python) and the Unity C# resolver (including the
gated FishNet Tier-2 section). These resolvers keep engine-invoked code live ("zero
callers ≠ dead") by emitting synthetic `route` nodes + `references`/`function_ref` edges.

Read this before touching `blender.ts`, `unity.ts`, or their invocation tables. It
distills the real bug history — the Fable implementation-review ledger (F1–F5, N1–N8,
D7), the FishNet facts, and the build-plan ceilings — so you don't re-derive the method.

**Prime directive (never weaken): emit NOTHING when a target is statically
unresolvable.** A *missed* edge is strictly preferred to a *fabricated* one. Every
ambiguous case (computed names, cross-file base chains, dynamic dispatch, overload
ambiguity, non-self receivers) emits nothing, never a guess. Every triage decision below
flows from this.

---

## 1. Symptom taxonomy (triage by severity)

| # | Symptom | Severity | First reflex |
|---|---|---|---|
| S1 | **Fabricated edge / node** — a `route` node or `references`/`function_ref` edge points at something the source does not actually wire (wrong method, string-literal ghost, cross-class bind). | **HIGHEST** — violates the emit-nothing promise. | Reproduce, then **remove or tighten**. Never rationalize a false positive as "close enough." |
| S2 | **Missed edge** — an expected host callback / idname link / RPC entry point is absent. | Often **CORRECT**. | Check §2 FIRST. A "missing" edge that matches a recorded ceiling is working as designed, not a bug. |
| S3 | **Gate misfire (FishNet)** — FishNet rows fire on NGO/Mirror code, or fail to fire on real FishNet code. | High (a firing-when-shouldn't is an S1). | Evaluate the gate by hand (§4.4) on comment-stripped, string-masked source. |
| S4 | **Node/edge-count instability** across re-index — counts differ run-to-run on an unchanged tree. | High — breaks determinism guarantees. | Double-index and diff (§3, D7). Distinguish real nondeterminism from tree-sitter parse-timeout variance. |
| S5 | **Crash / timeout** during extract or resolve. | High. | Bound the input; check for an unbalanced-bracket / catastrophic-regex input; confirm it isn't a pre-existing tree-sitter 10s parse timeout. |

S1 is the only category where "when unsure, do less" is automatic. S2 is the trap: most
"bugs" reported against these resolvers are deliberate silence.

---

## 2. First move: is it actually a bug?

Both resolvers **deliberately emit nothing** for the cases below. Before writing a fix,
confirm the "missing" edge is not one of these recorded ceilings. If it matches, the
answer is "working as designed" — update docs/tests to lock the ceiling, do not widen the
resolver.

| Ceiling (emit nothing) | Applies to | Recorded at |
|---|---|---|
| **Cross-file base chains** (`class B : A` where `A : MonoBehaviour`/`bpy.types.Operator` lives in another file) | Unity, Blender | `unity-invocation-table.json` → `catalogNotes.falsePositiveGuards.same-file-base-chain-only` + `resolverCoverageNotes`; `blender-invocation-table.json` → `catalogNotes.resolverCoverageNotes[1]`; `UNITY-BUILD-PLAN.md` §"Cross-file Base-chain Ceiling"; `AGENTS.md` "Inherited ceiling". The mechanical reason: per-file `extract()` runs in isolated workers; `postExtract`'s `updateNode` is update-by-id and cannot insert. |
| **Partial-class method files** (a `partial class` block that doesn't itself carry the Unity base proof) | Unity | `unity.test.ts` "treats each partial class block independently"; `UNITY-BUILD-PLAN.md` test §5. Same root cause as cross-file. |
| **Computed / concatenated / interpolated strings** (f-strings, `"a"+"b"`, `$"..."`, variable idnames/method names, `__package__`) | Unity, Blender | Blender `catalogNotes.idnameRules.computed-idname-no-guess`; Unity `catalogNotes.falsePositiveGuards.no-computed-string-invoke`. |
| **Overload ambiguity** — a string-invoke name matching >1 same-class method | Unity | `catalogNotes.falsePositiveGuards.unique-overload-string-invoke`; `unity.ts` `uniqueMethod()` returns null unless exactly one match. |
| **Non-self receivers** — `other.SendMessage(...)`, `x.gameObject.SendMessage(...)`, `foo?.Invoke(...)`, `GetX().Invoke(...)` | Unity | `catalogNotes.falsePositiveGuards.receiver-whitelist-send-message`; `unity.ts` `allowsStringCallReceiver()`. Only implicit / `this.` / own-`gameObject.` (SendMessage family only) link. |
| **Alias-only `using` (FishNet)** — `using FN = FishNet.Object;` never opens the gate | Unity/FishNet | `FABLE-IMPL-REVIEW.md` note **N8**; gate regex is line-anchored `^\s*using\s+FishNet\b`. Conservative miss. |
| **Competing-stack files (FishNet)** — any `using Unity.Netcode` / `using Mirror` present disqualifies, even alongside FishNet evidence | Unity/FishNet | `fishnet.gate.disqualifyingUsingPrefixes`; `FISHNET-RESOLVER-FACTS.md` §1. |
| **Dynamic dispatch / reflection** — `MethodInfo.Invoke`, `Type.GetType("...")`, `type('N',(Base,),{...})`, `importlib.import_module(var)`, `__annotations__[k]=...` | Unity, Blender | Unity `catalogNotes.dynamicOrOutOfScope`; Blender `catalogNotes.dynamicOrOutOfScopeSignals` + `falsePositiveGuards.no-computed-annotations-fabrication`. |
| **Public-field implicit serialization, UnityEvent/scene/prefab/.meta wiring, animation events** | Unity Tier 2 | `catalogNotes.tier2Deferred`; `UNITY-BUILD-PLAN.md` "Scope Decision". Not v1. |
| **Quarantined magic methods** — `ShowButton`, `OnHeaderGUI`, the 4 UGUI/UIBehaviour rows | Unity | `catalogNotes.quarantine`. Absent from consumed data on purpose. |

Decision rule: **a missing edge that matches a row above is not a defect.** Only escalate
to a fix if the miss is *outside* every ceiling AND (for S2) closing it would not risk an
S1 fabrication.

---

## 3. Minimal-repro procedure

Shrink to the smallest input that reproduces, then drive it two ways: fast unit harness
first, deterministic dist probe second.

### 3.1 Unit harness (fastest — no build, no index)

The tests call the resolver's `extract()` directly and assert the **exact sorted**
node-name set and the **exact sorted** `referenceKind:referenceName` set. An extra
fabricated node/ref fails the test just as hard as a missing one — this is what makes the
harness good at catching S1.

- Files: `__tests__/unity.test.ts`, `__tests__/blender.test.ts`.
- Helpers (copy verbatim): `extract(source, filePath)`, `nodeNames(result)` (sorted),
  `refPairs(result)` (sorted `kind:name`), plus `makeContext` / `makeSymbol` / `makeRef`
  for `detect()`/`claimsReference()`/`resolve()`.
- Shrink the fixture to one class + one member reproducing the symptom. Keep the `using
  UnityEngine;` / `import bpy` signal — without it `extract()` returns `{nodes:[],
  references:[]}` by the file-level gate (`hasBlenderSignal`, `.cs` + Unity signal).

```bash
npx vitest run __tests__/unity.test.ts    # or blender.test.ts
npx vitest run __tests__/unity.test.ts -t "string-invoked"   # single pattern
```

To probe interactively without a test, a scratch `.cjs`/`.mjs` that imports the resolver
and calls `unityResolver.extract(path, src)` reproduces the review's adversarial-probe
route (the ledger's `unity-exploits.cjs`).

### 3.2 Deterministic dist probe (the D7 procedure — for S4 and corpus-level claims)

When the bug only shows at scale (node explosion, resolution across files, gate behavior
on a real corpus), reproduce against the **built `dist/`** on the validation project.
Template = the D7 run in `FABLE-IMPL-REVIEW.md`:

1. `npm run build` (exit 0). Copies schema + wasm into `dist/`.
2. Index the target twice: `node dist/bin/codegraph.js index --quiet <repo>` — the corpus
   is `C:\dev\repos\unity\Unity-MP-Course-Project` (Unity Tier-1 + FishNet 4.6.20).
3. **Stability check (S4):** compare the two indexes. Total nodes/edges, route-node count,
   and every name-bucket must be **byte-identical** run-to-run. D7 baseline: 37,133 nodes /
   93,050 edges / 1,133 unity route nodes (Tier-1); +120 with FishNet.
   - A ±small edge delta that is NOT stable is almost always the **2 files that hit the
     tree-sitter 10s parse timeout** (`.codegraph/errors.log`), not the resolver. Confirm
     before blaming a change.
4. **Fabrication sample (S1):** `select … from nodes/edges where …` the synthetic buckets
   (`unity:host:`, `unity:field:`, `unity:method:`, `blender:host:`, `blender:idname:`)
   and hand-verify a sample against the real source line. D7 bar: **0 fabrications in the
   sample** (21/21 clean Tier-1; 15/15 clean FishNet).
5. **Node-explosion check:** `select count(*) from nodes` stable before/after the change.
6. Convenience probes against `dist/` (bypass the agent): `scripts/agent-eval/probe-node.mjs
   <repo> <Symbol> [code]` and `scripts/agent-eval/probe-explore.mjs <repo> "<symbol bag>"`
   show the `codegraph_node` trail / `codegraph_explore` Flow section for one symbol.

Read-only always: no git mutation, no agent sessions during probing.

---

## 4. Locating the seam — which layer is wrong

Three layers can produce a symptom. Identify which before editing.

### 4.1 The consumed-vs-catalogNotes split (know what is data-driven)

Each invocation table is split into a **`consumed`** slice (read by the `.ts` at runtime)
and **`catalogNotes`** (documentation-only provenance; the resolver hardcodes those
behaviors and cites the rule ids in comments). Editing `catalogNotes` changes NOTHING at
runtime.

What the code **actually reads**:

- **`blender.ts`** reads exactly: `registerableBases` (key set = whitelist,
  `hostInvokedMethods`, `idname.default`), `propertyCallbacks`
  (`callbackKwargs`/`enumItemsKwarg`/`typeReferenceKwargs`), `operatorIdnameValidation.pattern`,
  `manifest.*`. Everything else (string-linking call sites, callback-registration calls,
  false-positive guards) is **hardcoded regex** documented under `catalogNotes`.
- **`unity.ts`** reads exactly: `hostInvokedBases`, `serializationAttributes.attributes`,
  `attributeEntryPoints.methodAttributes` + `classAttributes`,
  `typeReferenceAttributes.attributes`, and the `fishnet` subsections
  (`gate`, `hostInvokedBases.NetworkBehaviour`, `attributeEntryPoints.methodAttributes`).
  **NOT** `detection` and **NOT** `stringInvokedCallSites` — those two are listed under the
  table's `consumed` note but the resolver **hardcodes** them (detection markers in
  `detect()`/`hasConcreteUnitySourceSignal`; the SendMessage/Invoke/StartCoroutine/
  ContextMenuItem families in `processStringCalls`/`processContextMenuItems`). See §7
  contradictions. **A string-invoke bug is in `unity.ts` code, not the table.**

### 4.2 Table row (consumed section) — when the data is wrong

Symptom shape: a **whole category** is wrong the same way (a lifecycle method never kept
live; an attribute never recognized; a base treated/ignored wholesale). Fix in the JSON.
Examples: adding a missing `MonoBehaviour` message, quarantining a magic method, adding a
callback kwarg. Table edits carry obligations — §5.

### 4.3 Resolver scan code — when the parse/gate/emit logic is wrong

Symptom shape: right rule, wrong *instances* (fabricated on one receiver shape, missed on
an expression-bodied sibling, wrong line number). Fix in the `.ts` extract path:
`parseClassBlocks`/`collectClasses`, `parseMethods`/`collectClassMethods`,
`processStringCalls`, `emitLinkArg`, `analyze()`.

### 4.4 claimsReference / resolve — when the edge is emitted but mis-targets

`extract()` emits an **unresolved** ref carrying a synthetic name
(`unity:host:Class.Method`, `blender:idname:...`, `bl_ext....`). `claimsReference(name)`
opts that name through the name-exists pre-filter; `resolve(ref, context)` binds it to a
real node. A mis-*target* (not a mis-emit) is here. Both resolvers resolve host methods by
**exact class-span containment** (`resolveSynthetic` / `resolveHostMethod`): the member
node must sit within the class node's `startLine..endLine` in the same file — **no
bare-name fallback** (that was F2). If `resolve` returns null when a target exists, check
`claimsReference` first (an unclaimed name never reaches `resolve`).

### 4.5 How the FishNet gate is evaluated

`fishnetGateOpen(safe)` runs on **comment-stripped, string-masked** source (`safe`), so a
commented or string-literal `using` never counts. Order is **disqualify-wins**:

1. If any `disqualifyingUsingPrefixes` (`Unity.Netcode`, `Mirror`) matches → **closed**
   (return false) even if FishNet evidence is also present.
2. Else if any `requiresAnyUsingPrefix` (`FishNet`) `^\s*using` matches → open.
3. Else if the FQ base `\bFishNet.Object.NetworkBehaviour\b` appears → open.
4. Else closed.

Gate closed ⇒ `NetworkBehaviour` is not in `activeHostBases` and all `fishnet.*` rows
emit nothing. When a FishNet row fires where it shouldn't (S3/S1), the bug is either the
gate evaluation or a base-name that slipped `resolveBaseName` (see N7 in §7).

---

## 5. Fix discipline

1. **Red test first, in the existing harness.** No production change without a failing
   `extract()`/`resolve()` assertion first (repo TDD rule). Use the exact-sorted
   `nodeNames`/`refPairs` style so a fix that over-emits also fails.
2. **Emit-nothing bias when uncertain.** If you can't prove the target, suppress. A red
   test that asserts `{nodes:[], references:[]}` for the ambiguous input is a valid,
   preferred fix.
3. **Never widen a regex without adding the collision case that motivated the original
   tightness.** Worked example — **P6 / note N5** (`FABLE-IMPL-REVIEW.md`): the F4 fix
   added a declaration-only scan (`declarationRegex`) so declaration-signatures count as
   overload siblings. But its param class `\([^;{}]*\)` is wide enough to *also* re-match
   expression-bodied methods (`void M(int n) => Foo(n);`), double-counting them; a lone
   expression-bodied `M` then reads as ambiguous and `Invoke("M")` never links. Direction
   is conservative (suppresses, never fabricates) so it was left as a recorded miss, with
   the one-char fix noted (`\([^;{}()]*\)\s*;`). Lesson: touching a sibling/receiver regex
   means re-checking every collision shape, not just the one you're widening for.
4. **Table edits bump the version and record provenance.** `unity-invocation-table.json` /
   `blender-invocation-table.json` carry a `version`; a consumed-section change bumps it
   and adds provenance (`provenance`/`validated`/`corpusPage`/`status`) so the row is
   traceable to a corpus fact — never add an unverified row to a consumed section (put it
   in `catalogNotes` quarantine/deferred with a reason).
5. **CHANGELOG entry per house rules.** User-facing bullet under `## [Unreleased]` (see
   `CLAUDE.md` "Writing changelog entries"): framework name yes, file paths/symbols/counts
   no. Missing entry was F5.
6. **Corpus re-validation before merge.** Re-run §3.2 (stability double-index +
   fabrication sample) on the validation project. For a new language/framework, the full
   REQUIRED methodology applies (`CLAUDE.md` §"Validation methodology"): small/medium/large
   real repos, ≥3 flow prompts each, deterministic probes, and A/B arms on **Sonnet
   `--effort high`** (the deliberate floor model — do not raise it).

---

## 6. Known footguns

| # | Footgun | Reference | Discriminator / fix |
|---|---|---|---|
| P6 | `declarationRegex` params `[^;{}]*` double-match expression-bodied methods → lone expression-bodied string-invoke target never links. | `FABLE-IMPL-REVIEW.md` note N5, probe P6; `unity.ts` `parseMethods` `declarationRegex`. | Conservative miss (never fabricates); fix is `\([^;{}()]*\)\s*;` **with** the P6 case as a red test. |
| F1 | Receiver whitelist bypassed by member-access chains — `collision.gameObject.SendMessage("M")` fabricated a self-link. | `FABLE-IMPL-REVIEW.md` F1 (fixed). | `allowsStringCallReceiver` now does explicit backward analysis on masked body; only implicit / `this.` / own-`gameObject.` (SendMessage family) pass. Regression tests: probes 1a/1b/1d. |
| F2 | `resolve()` substring containment cross-bound suffix-colliding classes (`NetworkPlayer.Update` claimed `Player.Update`). | `FABLE-IMPL-REVIEW.md` F2 (fixed). | Class-span containment first, then boundary-aware (`.`/`::`/`/`/`:`) suffix match. Test: suffix-colliding class first in file. |
| F3 | Fields/properties scanned on **string-unmasked** text → a `"[SerializeField] int fake;"` string literal fabricated a field. | `FABLE-IMPL-REVIEW.md` F3 (fixed). | Structure matched on masked `body`; attribute text sliced from `rawBody` at identical indices. **This is the canonical "reads RAW content" bug** — see next row. |
| RAW | A fix that reads the original `content` (or `rawBody` for structure) instead of the masked/stripped source re-opens the comment/string false-positive class. | `strip-comments.ts`; `unity.ts` `maskStringLiterals` + `parseClassBlocks` (`body` = masked, `rawBody` = comment-stripped strings-intact). | **If your fix reads raw content, it is probably wrong.** Structural scans (class/method/field/gate) run on masked `safe`/`body`; string *arguments* (ContextMenuItem label, SendMessage name, `bl_idname`) are recovered from strings-intact source at the same offsets. Note the C-style stripper blanks only comments (strings stay), so unity.ts adds its own `maskStringLiterals`; the Python stripper keeps single-line strings so `bl_idname="..."` survives for Blender. |
| I-1 | Blender dotted `module.Class.bl_idname` operator arg must bind the **tail** class, not the dotted path. | `blender.test.ts` "I-1: dotted module.Class.bl_idname"; `blender.ts` `emitLinkArg` attr branch. | Regression-guarded; `ops.CGB_OT_target.bl_idname` → `references:CGB_OT_target`. |
| LINE | Route-node `startLine` drifts up 1–3 lines (leading `\s*` in member regexes). | `FABLE-IMPL-REVIEW.md` D7 observations; `blender.test.ts` asserts the `bl_parent_id` line, not the class header. | **Cosmetic** — resolved edges still target the correct member node. Don't "fix" it by reading raw content (RAW footgun). Not an S4. |
| CRLF/BOM | Line-ending / BOM differences shift offsets and false-flag source comparisons. | `SOURCES.md` "Oracle D" (CRLF vs LF false-flagged 375 files until normalized). | When diffing a fixture/corpus against a reference, **normalize BOM + CRLF→LF first**. In-resolver, `stripCommentsForRegex` preserves `\n` so CRLF is safe, but a leading BOM shifts line 1 — strip it in minimal-repro fixtures. |
| WIN | Pre-existing Windows test failures unrelated to any resolver change. | `CLAUDE.md` "Windows-gated tests"; `FABLE-IMPL-REVIEW.md` full-suite triage. | `frameworks-integration.test.ts` (3 JVM FQN, EPERM in `afterEach`), `mcp-initialize.test.ts`/`mcp-roots.test.ts` (EPERM temp-dir removal), `security.test.ts` symlink test. **Reproduce on a clean `origin/main` clone to confirm pre-existing.** |
| FLAKE | tinypool "worker exited unexpectedly" crashes under parallel run. | `FABLE-IMPL-REVIEW.md` full-suite triage. | `mcp-catchup-gate`/`mcp-daemon` **pass when run individually** — parallel resource contention, not a regression. Discriminate: **solo re-run the failing file**; if green, it's a flake. |

**Discriminating pre-existing vs regression (the general move):** solo-re-run the failing
test; if still red, `git stash` your change (or check out `origin/main`) and re-run — a
failure that reproduces on `main` is not yours. The Unity/FishNet branches landed with a
full-suite run of 1,478 passed / 12 failed where **every** failure was accounted for as
pre-existing Windows/flake, none resolver-caused.

---

## 7. Reference map

| Artifact | Absolute path | Role |
|---|---|---|
| Unity resolver | `C:\dev\repos\forks\codegraph\src\resolution\frameworks\unity.ts` | C# + FishNet extract/resolve/detect. |
| Unity table | `C:\dev\repos\forks\codegraph\src\resolution\frameworks\unity-invocation-table.json` | Consumed rules + `catalogNotes` + `fishnet` section (v0.3.0). |
| Blender resolver | `C:\dev\repos\forks\codegraph\src\resolution\frameworks\blender.ts` | Python add-on/extension extract/resolve/detect. |
| Blender table | `C:\dev\repos\forks\codegraph\src\resolution\frameworks\blender-invocation-table.json` | Consumed rules + `catalogNotes` (v0.2.0). |
| Resolver registry | `C:\dev\repos\forks\codegraph\src\resolution\frameworks\index.ts` | Registration + `detectFrameworks`/`getApplicableFrameworks`. |
| Comment stripper | `C:\dev\repos\forks\codegraph\src\resolution\strip-comments.ts` | Offset-preserving comment blanking; the masking substrate. |
| Unity tests | `C:\dev\repos\forks\codegraph\__tests__\unity.test.ts` | 39 tests incl. FishNet describe block; harness style. |
| Blender tests | `C:\dev\repos\forks\codegraph\__tests__\blender.test.ts` | 32 tests; `extract()` → nodeNames/refPairs harness. |
| Fable review ledger | `C:\dev\repos\unity\databases\unity-docs\unity-6.5\resolver-facts\FABLE-IMPL-REVIEW.md` | F1–F5 findings, N1–N8 notes, D7 probe procedure, full-suite triage, FishNet approval. |
| Scope decisions | `C:\dev\repos\unity\databases\unity-docs\unity-6.5\resolver-facts\FABLE-SCOPE-DECISIONS.md` | The 9 approved v1 host bases + deferrals. |
| Builder checklist | `C:\dev\repos\unity\databases\unity-docs\unity-6.5\resolver-facts\FABLE-BUILDER-CHECKLIST.md` | §C 15 traps + §D 10 questions the ledger scored against. |
| FishNet facts | `C:\dev\repos\unity\databases\fishnet-docs\4.7.2\resolver-facts\FISHNET-RESOLVER-FACTS.md` | Gate rationale, 10 callbacks, RPC entry points, excluded rows, 4.6.20 parity, corpus validation. |
| FishNet sources | `C:\dev\repos\unity\databases\fishnet-docs\SOURCES.md` | Free/Pro oracles, Oracle D CRLF/BOM caveat, corpus build. |
| Unity build plan | `C:\dev\repos\forks\codegraph\UNITY-BUILD-PLAN.md` | Tier-1 scope, TDD list, cross-file/partial ceilings. |
| Corpus plan (live) | `C:\dev\repos\unity\databases\unity-docs\UNITY-CORPUS-RESOLVER-PLAN.md` | Durable Unity docs-corpus + resolver plan; update in place. |
| Unity corpus DB | `C:\dev\repos\unity\databases\unity-docs\unity-6.5\unity_docs.sqlite` | Ground truth for host-method/attribute rows. |
| Unity DB query CLI | `C:\dev\repos\unity\databases\unity-docs\query_unity_docs.py` | search / page / api against the Unity corpus. |
| FishNet corpus DB | `C:\dev\repos\unity\databases\fishnet-docs\4.7.2\fishnet_docs.sqlite` | `api_members`, `pages`, tier tags (free/pro). |
| FishNet DB query CLI | `C:\dev\repos\unity\databases\fishnet-docs\query_fishnet.py` | `search`/`page`/`pro`/`files`/`api`/`sql` (parent dir, not the `4.7.2/` subdir). |
| Validation corpus | `C:\dev\repos\unity\Unity-MP-Course-Project` | D7 probe target; Unity Tier-1 + FishNet 4.6.20. |
| Probe: node | `C:\dev\repos\forks\codegraph\scripts\agent-eval\probe-node.mjs` | `codegraph_node` trail against built `dist/`. |
| Probe: explore | `C:\dev\repos\forks\codegraph\scripts\agent-eval\probe-explore.mjs` | `codegraph_explore` Flow section against `dist/`. |
| A/B (with/without) | `C:\dev\repos\forks\codegraph\scripts\agent-eval\run-all.sh` | Agent A/B, both arms Sonnet `--effort high`. |
| A/B (new vs baseline) | `C:\dev\repos\forks\codegraph\scripts\agent-eval\ab-new-vs-baseline.sh` | Isolate a build change, both codegraph-on. |
| Coverage playbook | `C:\dev\repos\forks\codegraph\docs\design\dynamic-dispatch-coverage-playbook.md` | Where per-framework validation numbers get recorded. |

---

## Source contradictions found (reported, not silently resolved)

1. **Unity `consumed` manifest is broader than what `unity.ts` reads.** The table's
   `consumed` note lists `detection` and `stringInvokedCallSites` as runtime-consumed, but
   `unity.ts` **hardcodes** both (detection markers in `detect()`/`hasConcreteUnitySourceSignal`;
   the SendMessage/Invoke/StartCoroutine/ContextMenuItem families in `processStringCalls`/
   `processContextMenuItems`). They are effectively `catalogNotes`. Blender's table gets this
   right — it documents its analogous hardcoded call-site behavior under `catalogNotes.stringLinkingCallSites`.
   Consequence for debugging: editing the Unity `stringInvokedCallSites` or `detection`
   section changes nothing at runtime. (The table's manifest entries for both sections
   were annotated "DOCUMENTATION-ONLY" in the same commit that added this playbook.)
2. **FishNet query-CLI path in `SOURCES.md` is stale.** `FISHNET-RESOLVER-FACTS.md` §8 and
   `SOURCES.md` imply `query_fishnet.py` lives beside the DB (`4.7.2/`), but it is actually at
   `C:\dev\repos\unity\databases\fishnet-docs\query_fishnet.py` (parent dir). The corpus DB
   path (`4.7.2/fishnet_docs.sqlite`) is correct. The FISHNET-RESOLVER-FACTS §8 "reproduction"
   also cites `scratchpad/*.mjs` probe scripts that are ephemeral (not in-repo).
3. **Table version in the ledger vs on disk.** `FABLE-IMPL-REVIEW.md` D3 records
   "version 0.2.0; 9 host bases" — that was the Tier-1 snapshot. The FishNet Tier-2 work bumped
   the shipped table to **0.3.0** (the ledger's own Tier-2 addendum notes the 0.2.0→0.3.0 bump).
   Not a defect, but read D3's version as pre-FishNet.
4. **`UNITY-BUILD-PLAN.md` status line is stale.** It reads "ready for Fable re-check," but the
   ledger shows the re-check is complete and **APPROVED for commit** (Tier-1 and Tier-2). Trust
   the ledger for current state.
