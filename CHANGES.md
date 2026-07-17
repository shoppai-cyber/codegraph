# CHANGES — `feat/blender-resolver`

Fork divergence from upstream `codegraph` (`shoppai-cyber/codegraph`, base tip `7d624ec`).
Adds a **Blender add-on / extension framework resolver** so codegraph stops treating
host-invoked Blender code as dead. Ships in the single binary, auto-activates on bpy detection,
inert on every non-Blender repo — the same pattern as the existing Django/Flask/FastAPI resolvers.

## Why

Blender add-ons are Python packages whose entry points are invoked **by the Blender host**, not by
in-project calls, so without domain knowledge they look uncalled to the graph:

- `register()` / `unregister()` module functions Blender calls on enable/disable.
- Classes handed to `bpy.utils.register_class()` (directly, via lists/loops, or
  `register_classes_factory`) whose methods (`execute`, `draw`, `poll`, …) Blender invokes per base.
- String idnames linking call sites to operators/panels/menus at runtime
  (`bpy.ops.<cat>.<name>()`, `layout.operator("cat.name")`, `keymap_items.new(...)`, `bl_parent_id`).
- Callback-registration APIs (`bpy.app.handlers`, `bpy.app.timers`, `bpy.msgbus`, draw handlers,
  menu `append`) taking plain callables otherwise never referenced.
- `bpy.props.*Property(...)` callback kwargs (`update=`, `items=`) and `type=` PropertyGroup links.

## Files

| File | Change |
|---|---|
| `src/resolution/frameworks/blender.ts` | **NEW** — the resolver (~1010 LOC). |
| `src/resolution/frameworks/blender-invocation-table.json` | **NEW** — single source of domain rules (consumed slice + `catalogNotes` provenance). |
| `__tests__/blender.test.ts` | **NEW** — 29 cases, exhaustive `.toEqual` assertions. |
| `src/resolution/frameworks/index.ts` | import after python; `blenderResolver` in `FRAMEWORK_RESOLVERS` after `fastapiResolver`; re-export. Nothing else changed. |

## Design decisions

- **Diagnostics over guessing.** Anything statically unresolvable — computed idnames, dynamic
  `__annotations__` keys, `type(...)` classes, invalid operator idnames — emits **nothing** (no node,
  no reference). Fabricating a plausible-looking target is worse than staying silent.
- **Data-driven core.** `blender-invocation-table.json` is the only domain-rule source. The runtime
  consumes exactly `registerableBases`, `propertyCallbacks`, `operatorIdnameValidation`, and
  `manifest`; everything under `catalogNotes` is documentation-only provenance (`"documentationOnly": true`),
  cited by rule id in the resolver's regex comments.
- **Literal `__annotations__` keys → emit-nothing** (Ruling 4 decision). Literal annotation keys are
  reconciled to the false-positive-safe side (skipped like computed keys), reasoning recorded in the
  JSON `catalogNotes.falsePositiveGuards.no-computed-annotations-fabrication`. Rationale: a mistaken
  PropertyGroup/callback edge is more damaging to the graph than a missed one.
- **No `CATEGORY_OT_name` inference.** className-default idnames apply only to bases whose table rule
  sets `idname.default === 'className'`; the `Operator` base has `idname.default: null`, so operator
  idnames are never inferred from class name.

## Known limitation — cross-file host-callback methods (work item 6, PARTIAL BY DESIGN)

The registration-edge half is implemented: a registered class not defined in-file emits a
`register-class:<name>` node + a plain class-name `references` ref, which the core pipeline resolves
cross-file via normal symbol resolution. The resolver deliberately does **not** use `postExtract` to
emit per-method host-callback nodes for an externally-registered class, because `postExtract` persists
via `updateNode` (update-by-id; the id must already exist — `types.ts:216-223`), which can patch
existing nodes but cannot fabricate new per-method nodes for a class body extracted by another worker.
**Effect:** host-callback method nodes for an externally-registered class are not emitted. Removing
this limitation would require an insert-capable post-extract channel upstream, not `updateNode`.

## REVIEW_r1 coverage

All **15** REVIEW_r1 findings and all convention divergences were addressed; **no finding was
rejected or disagreed with**. Highlights (full file:line index in `scratch/_handoff/ASSESS_codegraph.md`
in the AutoResearch repo):

- **HIGH** — `from bpy.types import` bases (incl. `as`-renames / parenthesized) now collected; bare &
  imported `register_class` recognized (real add-ons no longer silently emit zero nodes); per-ref
  full-project re-analysis replaced by a lazy once-per-context cached idname index.
- **MED** — dead `candidates` path removed; `function_ref` carries the bare tail only; `bl_parent_id`
  line offset fixed; `PointerProperty/CollectionProperty(type=X)` emits a `references` edge;
  double-emission eliminated; `CATEGORY_OT_name` fallback removed.
- **LOW** — nested-bracket list parsing; annotated `bl_idname: str = "…"`; msgbus `notify=` bounded to
  its own call; occurrence-discriminated node ids; `keymap` accepts `Class.bl_idname`.

## Verification (fresh, 2026-07-03)

- `npm run build` (tsc + copy-assets): **exit 0**; `blender.js` + the 37 KB invocation table emitted to
  `dist/resolution/frameworks/`.
- `npx vitest run __tests__/blender.test.ts`: **29 passed / 29**.
- Full suite: the Blender work adds **zero** new failures over the pre-existing ~44-failure Windows
  baseline (CLI-spawn / MCP-daemon / tinypool infra flakiness — none Blender-attributable); the
  Blender file passes 29/29 inside the full run.
- **Inertness:** `detect()` requires a real bpy import or `bl_info=` (a bare `bpy.` mention in a comment
  does not trigger), so non-Blender repos are unaffected.

## r2.1 — post-review follow-up fixes (2026-07-03, independent review `APPROVE-WITH-NITS`)

A codegraph-dogfooded review (findings in the AutoResearch repo `scratch/_cgb_review/FINDINGS.md`)
returned **APPROVE-WITH-NITS**: 0 Critical, 0 false positives, all r1/r2 claims verified. Two
Important **false-negatives** fixed here (TDD — failing tests written first, 29 → 32):

- **I-1 — dotted `module.Class.bl_idname` link args** (`emitLinkArg`). The class-attr regex matched
  only a single identifier, so `pkg.mod.Class.bl_idname` (common in multi-file add-ons) emitted
  nothing. Now matches a dotted path and binds the **tail** class name (mirrors the callable-tail
  handling). Fixes all string-link sites (operator/menu/keymap/gizmo/macro) at once — they share
  `emitLinkArg`.
- **I-2 — annotated `def register() -> None:` / `def unregister() -> None:`** (`entryRegex`). The
  entry-point regex required the colon immediately after `)`, so a return annotation dropped the
  `BLENDER module register()` entry node. Now tolerates an optional `-> …` return annotation.
- **M-7 — test gap:** added a regression test for `keymap_items.new(Class.bl_idname, …)` (behavior
  already correct; now locked).

**Verification:** `npx vitest run __tests__/blender.test.ts` → **32 passed / 32**; `npm run build`
exit 0; reinstalled globally; installed-binary smoke confirms both fixes emit the expected edges.

**Deferred Minors (backlogged — AutoResearch `scratch/_cgb_review/MINORS-BACKLOG.md`):** M-1 multi-line
`__annotations__` guard, M-2 unanchored macro/UI receiver regexes, M-3 built-in `bpy.ops`
unresolved-node noise, M-4 ALL-CAPS constant admitted as class, M-5 detection on raw content, M-6
escaped-quote literal, M-8 trailing-comma `register_class(X,)`. All edge cases; none affects the
mainline patterns. **I-3** (work-item-6 cross-file host-callback ceiling) confirmed genuine, already
documented above — no code change.

---

# CHANGES — Unity Mirror networking (Tier-2 gated resolver)

Adds **Mirror (MirrorNetworking) 96.x** networking liveness to the Unity framework resolver,
alongside the existing FishNet Tier-2 support. Same pattern as FishNet: a per-file gate keeps the
colliding networking tokens (`NetworkBehaviour`, `[ClientRpc]`, `[TargetRpc]`) from being confused
across stacks, and every row emits nothing unless its precondition is structurally proven in the same
file. Corpus-verified against Mirror 96.10.3 + Weaver source (`resolver-facts/MIRROR-RESOLVER-FACTS.md`,
in the mirror-docs database, not this repo).

## Why

Mirror's networking entry points are invoked by the Mirror runtime / Weaver-rewritten call sites, not
(only) by in-project calls, so without domain knowledge they look uncalled:

- `NetworkBehaviour` lifecycle/serialization callbacks — the 8 `OnStart*`/`OnStop*` (server, client,
  local-player, authority), `OnSerialize`/`OnDeserialize`, and the `SerializeSyncVars`/`DeserializeSyncVars`
  overrides Mirror invokes by reflection/Weaver.
- `[Command]` / `[ClientRpc]` / `[TargetRpc]` methods — the Weaver moves the body aside and rewrites
  the call site into a network send; the remote-receive dispatch reaches the method with no in-project
  caller.
- `[SyncVar]` fields — enumerated and rewritten by the Weaver; a `hook = nameof(M)` / `"M"` names a
  change-callback resolved from a plain string, so the hook method otherwise looks dead.

Because those tokens collide with NGO, FishNet, and Photon Fusion, matching them unconditionally would
fabricate edges in a project on any of those stacks.

## Files

| File | Change |
|---|---|
| `src/resolution/frameworks/unity-invocation-table.json` | **NEW `mirror` section** — gate (NGO/FishNet/Fusion disqualifiers), `NetworkBehaviour` host callbacks + MonoBehaviour union, `attributeEntryPoints` (Command/ClientRpc/TargetRpc), `syncVarFields`, `syncVarHooks`, excluded/deferred rows, eventSubscriptions. Top-level `consumed.mirror` + version 0.3.0 → 0.4.0. |
| `src/resolution/frameworks/unity.ts` | Consumes `TABLE.mirror` through the generic `GATED_STACKS` mechanism (added in the preceding refactor). NEW: SyncVar field + hook emission block; FQ-base stack-ownership guard so an open Mirror gate can't claim a FishNet-FQ-based class. |
| `__tests__/unity.test.ts` | **NEW `describe('extract() — Mirror networking (Tier 2, gated)')`** — 61 cases, exhaustive `.toEqual` assertions (grown from the initial 21 by two adversarial-review hardening passes: FQ-collision/chain-ownership, raw-name attribute qualification, array/nullable/generic/multi-declarator SyncVar fields, the all-12-callback sweep, the design-v2 gate matrix, and — round 2 — same-name-across-namespace collision guard, exact-qualifier + using-alias attribute provenance, and brace-initializer / `const` no-emit / nullable-array / unclosed-generic-perf field shapes). Round 2 also added 2 FishNet-block and 2 Tier-1-block cases for the shared attribute-provenance and field-scanner fixes. |

This work sits on top of two preceding commits on the same branch: a **generic-GATED_STACKS refactor**
(generalizes the FishNet-specific gate/host/RPC code to run any number of stacks from data, no behavior
change, all FishNet tests green) and a **gate-hardening pass** (F1–F4 below).

## Design decisions

- **Emit-nothing, uniformly.** Every ambiguous Mirror case emits nothing: static `[SyncVar]`,
  overloaded hook name, qualified/non-literal hook value, hook naming an absent method, cross-file
  base chain, cross-file SyncVar field. A missed edge beats a fabricated one — documented as coverage
  bounds in the JSON + facts doc, not silently narrowed.
- **Data-driven, shared mechanism.** The `mirror` JSON section is the only Mirror domain-rule source;
  `unity.ts` reads it through the same `GATED_STACKS` runtime that serves FishNet. Adding Mirror was
  (after the refactor) almost entirely a JSON change plus the SyncVar block the refactor left dormant.
- **SyncVar field liveness reuses the serialized-field emission shape.** A non-static `[SyncVar]` field
  emits the same `unity:field:` reference (plus a local-type type-ref) the Tier-1 serialized-field rule
  already emits — no new reference kind.
- **SyncVar hook matching is block-local — the Weaver's scope for a single-block class, deliberately
  narrower for partial classes.** Mirror's `FindHookMethod` searches the declaring type's
  compiler-merged method table (`td.Methods`), which spans *every* `partial` declaration of the type
  across all files. Our resolution is scoped to the single class BLOCK the field is declared in, so for
  a type split across multiple `partial` blocks it is strictly narrower than the Weaver: a hook whose
  method lives in a sibling partial block resolves to nothing (emit-nothing, not a cross-block guess).
  For the common single-block class the two scopes coincide. Overloads are deliberately not
  disambiguated either (the Weaver picks by the 2-param signature; we won't guess a signature).
- **RPC self-reference supplements, does not assert-uncalled.** Because Mirror RPC methods are commonly
  called directly in user code (Weaver-rewritten call site), the synthetic entry-point reference is
  additive to any real callers.
- **FQ base pins to its owning stack.** A class based on a fully-qualified `X.NetworkBehaviour` is
  claimed only by the stack whose `fullyQualifiedBaseAlternative` matches, and only when that stack's
  gate is open — so activating Mirror does not let an open Mirror gate claim a class rooted in
  `FishNet.Object.NetworkBehaviour` (regression-locked by the preserved FishNet characterization test).

## Gate-hardening (F1–F4, preceding commit, shared across all gated stacks)

- **F1** — the FishNet gate now also disqualifies on Photon Fusion (`using Fusion`), matching the
  Mirror gate's disqualifier set.
- **F2** — the fully-qualified base alternative is matched against **parsed base clauses only**, not a
  file-wide token search: `X.NetworkBehaviour` as a field type no longer opens a gate.
- **F3** — the required/disqualifying `using` regexes reject **alias directives**
  (`using Mirror = …;`): an alias is not a namespace import, and does not open (or close) a gate.
- **F4** — the host-base loader filters documentation-only keys (`note`, `detection`) out of each
  stack's host-base rule set, so a doc key can't be read as a host base.

## r3 — post-review conservative pass (adversarial re-review round 3)

Round 3 rejected the round-2 fixes as unsafe as a set: two residual false edges and two
regressions the round-2 fixes introduced. All four are closed by narrowing scope, never widening
it — when C# scope can't be modeled cheaply, emit nothing and document the bound.

- **Chain propagation only through bare-written bases.** A dotted external base (`Other.Root`) was
  shortened to its last segment before the same-file name-chain lookup, so it inherited an unrelated
  local `Root`'s networking ownership. Now a base drives the chain only when its full form carries no
  dot; owning fully-qualified bases (`Mirror.NetworkBehaviour`) are still admitted directly. Missed
  edge: a genuine same-file chain written through a dotted alias is not followed.
- **Partial classes merge; nested classes never participate.** The round-2 flat class-name count
  treated valid `partial` blocks and nested/top-level name reuse as ambiguous and dropped classes
  that chained through them. All-partial blocks of a name are one compiler type (merged, ambiguous
  only on conflicting direct evidence); a class declared inside another class body is excluded from
  the top-level name map entirely. Genuine multi-namespace duplicates stay ambiguous.
- **Angle-aware initializer scan.** The field scanner balanced only `()[]{}`, so a generic
  constructor comma (`new Dictionary<int,string>()`) was read as a declarator separator and the field
  was dropped. It now tracks angle-bracket depth; a top-level `;` reached with an open angle context
  (a comparison operator such as `a < b`) bails the whole declaration. Missed edge: initializers whose
  `<`/`>` are comparison operators are skipped.
- **Attribute aliases KILL; attribute-owner namespaces are their own list.** Using-alias directives
  are parsed token-wise anywhere in the file; if any alias binds a gated attribute token's name (with
  or without the `Attribute` suffix), bare `[ThatToken]` is rejected file-wide — no target resolution,
  including an owning-stack target (a documented missed edge; a qualified `[Mirror.Command]` still
  emits). Qualified spellings validate against a dedicated `attributeNamespaces` list (Mirror →
  `Mirror`; FishNet → `FishNet.Object`), not the gate prefixes, so `[FishNet.ServerRpc]` (a custom
  attribute) no longer emits while `[FishNet.Object.ServerRpc]` still does.
- **Known bound — duplicated-name direct-emission collapse (SHOULD-FIX 5).** Node names are
  namespace-free by resolver-wide design, so two same-named classes whose members ALSO share names
  collapse to a single row at the first declaration's line. The row is real (not a fabricated edge);
  the second directly-proven declaration is simply not separately represented. Pinned by a regression
  test.

## r5 — no-fabrication hardening (adversarial re-review round 4)

Round 4 found that simple-name matching without a C# name-identity model still fabricated edges on
five paths. Every fix moves in one direction: when type identity is uncertain, **emit nothing** — a
missed edge is acceptable, a fabricated edge is the defect. None builds a namespace resolver; each
poisons the bare-name chain (or kills the bare token) on ambiguity.

- **Partial merge is namespace-aware (BLOCKING 1).** All-partial blocks of one simple name are merged
  as a single compiler type ONLY when they share an enclosing-namespace label; two one-part partial
  `Root`s in different namespaces are unrelated types, so the name is poisoned. Missed edge: a genuine
  cross-namespace partial we can't confirm equal is left unlinked.
- **Any same-named non-class type poisons the chain (BLOCKING 2).** A same-simple-name `interface`/
  `struct`/`enum`/`record` competes as a base-list target under C#'s scoped resolution, which the
  bare-name lookup can't model. Its presence marks the name ambiguous, so a networked class of that
  name can no longer be the sole donor.
- **The attribute KILL keys on the alias LHS only (BLOCKING 3).** The bare-attribute KILL set is built
  from every `using <Name> = …;` LHS regardless of the target shape (`global::`, extern `::`, dotted,
  generic), so an alias with a `global::Other.CommandAttribute` target still kills bare `[Command]`.
  The base-resolution alias map (below) intentionally drops those targets, so it can no longer be the
  KILL source without re-leaking.
- **Base aliases with two distinct bindings are unresolved (BLOCKING 4).** The base-resolution alias
  map now resolves a name only when it has exactly one distinct binding file-wide; a namespace-scoped
  alias rebound differently in another namespace is ambiguous and left unresolved, so it can never
  last-wins a class onto a foreign owning base. Missed edge: a legitimately scoped alias is not
  followed either. (Superseded in r6: resolution is now positional and namespace-scoped — exactly one
  distinct *active, visible* target at the use site — which keeps this guarantee while restoring
  legitimately scoped aliases.)
- **Locally-declared types shadow bare gated tokens (BLOCKING 5).** A bare `: NetworkBehaviour` or
  `[Command]` is suppressed when the file locally declares a type of that name (`class NetworkBehaviour
  {}`, `class CommandAttribute {}`) — C# binds the bare token to the local type, not the framework's,
  so emitting a gated row would be a fabrication. A qualified/FQ spelling is unaffected; a host class
  whose non-shadowed callbacks are live still emits them (the kill is surgical).
- **Gate `using` recognition is token-wise (SHOULD-FIX 3).** Required/disqualifying `using` detection
  is no longer anchored to physical line start, so a mid-line competitor (`using Mirror; using
  FishNet.Object;`) still fires its exclusion and a `global using Mirror;` still opens the gate.
- **Shift operators are not generic openers (SHOULD-FIX 2).** The initializer scanner recognizes
  `<<`/`>>`/`>>>` as shift operators, so a valid `[SyncVar] int x = a << 2;` no longer bails. The bail
  frontier is now only a lone `<` comparison and an unclosed generic.
- **Base-less sibling partial blocks are classified (SHOULD-FIX 1).** A base-less block of a merged
  all-partial type inherits the merged host descriptor, so members declared in a sibling block that
  lacks the base clause are live.
- **Known bound — inactive-`#if` alias KILL (CONSIDER 1).** *(Resolved in r6.)* The masked source now
  evaluates preprocessor conditions: provably-inactive regions are blanked before alias parsing, so a
  `using` alias inside `#if false` no longer enters the KILL set. An alias under an *unknown* symbol
  (`#if SOME_DEFINE`) still kills — potentially-active text errs toward silence.

## r6 — scope & preprocessor correctness (adversarial re-review round 5, graduation)

Round 5 rejected the r5 state (tip `c113cfa`, 178 green tests) on three fabrication families:
alias-parser fallback (B1), namespace-scoped alias leakage (B2), and preprocessor-blind gating (B3).
All three reproduced by executable probe at the tip; 18 regression tests added first (12 red),
then fixed. Direction unchanged: uncertain identity or scope → emit nothing.

- **Unresolvable alias targets kill their bare token (B1).** The alias parser drops `global::` and
  extern-`::` targets it cannot positively resolve; previously the bare LHS token then fell through
  to gated/Tier-1 classification (`using NetworkBehaviour = global::Foreign.Net.NetworkBehaviour;`
  fabricated a Mirror host). Alias-bound LHS names now shadow the bare token in host classification
  (both gated and Tier-1 branches) and poison the same-file base chain. A bare survivor of alias
  resolution means C# binds it to the alias, not the framework — so it emits nothing. A resolvable
  same-scope alias (`using NB = Mirror.NetworkBehaviour;`) still expands and emits.
- **Alias resolution is positional and namespace-scoped (B2).** Alias declarations record their
  innermost enclosing namespace span; a use site resolves only against aliases whose span contains
  it, requiring exactly one distinct active visible target. An alias declared in `namespace A` no
  longer binds a base in `namespace B` (file-wide application fabricated cross-namespace ownership).
  Block-scoped and file-scoped (`namespace X;`) forms covered; same-scope controls unchanged.
- **Preprocessor-aware gating with asymmetric semantics (B3).** A three-state line analysis
  (active / unknown / inactive) evaluates `#if`/`#elif`/`#else`/`#endif` with a deliberately tiny
  provability model: literals, `!`, parentheses, and in-file `#define`/`#undef` (a define under an
  unknown region taints its symbol). Gate **evidence** requires provably-active text — `using
  Mirror;` inside `#if false` or under an unknown build symbol (`#if UNITY_SERVER`) opens nothing.
  Gate **exclusion** fires from potentially-active text (active + unknown) — a competing stack's
  `using` under an unknown region still closes the gate. Provably-inactive regions and directive
  lines are blanked (offset-preserving) before all parsing, so inactive text can no longer feed
  aliases, kills, or FQ-base evidence; the `#else` of `#if false` is correctly active. Both
  asymmetry directions favor emit-nothing.

## r7 — illegal namespace layouts (adversarial re-review round 6)

Round 6 (independent Codex sol-xhigh review of the r6 state) confirmed B1/B2/B3 closed, dist
parity, and doc counts, then REJECTED on two new fabrication families: rows emitted from
compilation units the C# compiler rejects outright.

- **Compiler-rejected namespace layouts emit nothing, file-wide (N1/N2).** A file whose namespace
  layout can't compile has no framework-invoked members, and the scanner's namespace spans are
  meaningless on it — so `parseClassBlocks` returns no classes at all when the
  preprocessor-blanked text contains: a file-scoped `namespace X;` preceded by any type
  declaration (CS8956 — N1), file-scoped and block namespaces mixed in either order (CS8955 —
  N2), or a second file-scoped declaration (CS8954). A file-scoped declaration inside `#if false`
  is blanked before the check and never counts. The type-keyword pre-scan errs toward
  suppression (a keyword-shaped token before the declaration marks the file illegal even where
  the compiler's first error would differ) — a missed edge, never a fabricated one.
  *(Superseded in r8: the r7 keyword/name scan itself encoded an ASCII-only identifier subset and
  a type-keyword blacklist; escaped/Unicode identifiers and top-level statements walked past it.
  r8 replaces it with a name-agnostic keyword scan plus a legal-prelude whitelist.)*

## r8 — C# identifier grammar unification (adversarial re-review round 7)

Round 7 (fresh independent Codex sol-xhigh review of the r7 state) confirmed B1/B2/B3 and the
prior 23-fixture suite stayed closed, then REJECTED on the identifier grammar: the r7 layout
check, the namespace-span scanner and the class scanner each encoded a different ASCII-only
subset of C#'s identifier grammar, and every gap between those subsets was a hole. Six
fabrication fixtures (all compiler-receipted: CS8956 ×3, CS8955 ×3) and one clear-cut legal-file
suppression were demonstrated.

- **One shared identifier grammar (`CS_ID`).** C# identifiers may carry a verbatim `@` prefix
  (spelling, not identity: `@namespace` names the type `namespace`) and Unicode
  letters/digits/marks. All name scanners — namespace declarations, class names, non-class type
  names, using-alias left-hand sides — now share one grammar, and every stored name is
  canonicalized (verbatim prefix stripped) so an escaped spelling can no longer slip past
  shadow/kill sets (`using @NetworkBehaviour = …` kills the bare token; `interface
  @NetworkBehaviour` shadows it) or suppress a legal class (`class @namespace :
  NetworkBehaviour` emits — the round-7 false suppression).
- **Name-agnostic layout classification.** Namespace declarations are found by the `namespace`
  KEYWORD (spelling-exact — never `@namespace`, never a fragment of a longer identifier) plus
  the following `{`/`;` delimiter, shared by the span scanner and the layout check so the two
  can never disagree. A declaration whose name doesn't parse (`namespace {`, undecodable
  spellings, truncated declarations) marks the file illegal — suppression, never a guess.
- **CS8956 by whitelist, not blacklist.** The compiler allows only extern-alias directives,
  using directives and assembly/module attribute lists before a file-scoped namespace; ANY other
  leading construct — a type declaration in any spelling, a top-level statement, a `using (…)`
  STATEMENT — now marks the layout illegal. The r7 blacklist could only reject spellings it
  could parse.
- **Unicode-escape guard.** A `\uXXXX`/`\UXXXXXXXX` escape surviving comment-strip + string-mask
  + preprocessor-blank sits in code — a Unicode-escaped identifier the scanner cannot decode
  (`interface N…` can declare the NAME NetworkBehaviour). Every name comparison in such a
  file is unsound, so the whole file emits nothing. Escapes inside strings, char literals,
  comments and inactive regions are already masked and never trigger the guard.

## Verification

- `npx vitest run __tests__/unity.test.ts __tests__/unity-assets.test.ts`: **216 passed / 216**
  (unity.test.ts 180, unity-assets.test.ts 36). Round 4 added 11 Mirror-gated cases (one per BLOCKING
  and SHOULD-FIX) and rewrote two tests whose fixtures were invalid C# or documented the pre-fix bug:
  the same-named-struct case now asserts the poison (emit nothing), and the base-less-partial case now
  asserts the sibling block's members are live. Round 5 added 18 B1/B2/B3 regression cases (12 red at
  tip `c113cfa`); round 6 added 6 N1/N2 illegal-namespace-layout cases (5 red); round 7 added 14
  identifier-grammar cases (12 red). (Round 1 was 97; round 2 → 114; round 3 → 131 for unity.test.ts;
  round 4 → 142; round 5 → 160; round 6 → 166; round 7 → 180.)
  `__tests__/blender.test.ts`: **32 passed / 32** (control, no regression).
- `npx tsc --noEmit`: **exit 0**. `npm run build`: **exit 0**. Built-`dist/` probe: all B1/B2/B3
  fabrication cases emit nothing; all controls emit (source/dist parity).
- **Corpus verification (Mirror 96.10.3, `mirror_docs.sqlite`): ZERO corrections.** All 12 host
  callbacks, `NetworkBehaviour : MonoBehaviour`, the 3 RPC + guard + editor attribute classes,
  `SyncVarAttribute.hook`, the deferred host-base virtual counts, and the SyncObject Action-callback
  surfaces match the JSON exactly. Weaver `FindHookMethod`/`ProcessSyncVar` signatures confirmed.
- **Source verification (Mirror v96.11.0, official tag @ `370582a36f6f2cac05669634b924c3da3cab7ac4`):
  ZERO corrections.** Every consumed rule re-verified against the release source — 12 host-invoked
  virtuals (no additions), the exact 12-attribute universe, Weaver static-SyncVar rejection,
  same-declaring-type `FindHookMethod`, and conditional `SerializeSyncVars`/`DeserializeSyncVars`
  generation all hold; the release's `NetworkTime` breaking change touches no consumed row. Full
  record: `docs/validation/mirror-resolver-v96.11.0.md`.
