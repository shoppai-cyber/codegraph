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
| `__tests__/unity.test.ts` | **NEW `describe('extract() — Mirror networking (Tier 2, gated)')`** — 48 cases, exhaustive `.toEqual` assertions (grown from the initial 21 by the adversarial-review hardening pass: FQ-collision/chain-ownership, raw-name attribute qualification, array/nullable/generic/multi-declarator SyncVar fields, the all-12-callback sweep, and the design-v2 gate matrix). |

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
- **SyncVar hook matching is aligned with the Weaver, not narrower.** Mirror's `FindHookMethod` searches
  only the declaring type's own methods (`td.GetMethods()` → `td.Methods`), so same-class-block
  resolution is exactly the Weaver's scope. Overloads are deliberately not disambiguated (the Weaver
  picks by the 2-param signature; we won't guess a signature).
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

## Verification

- `npx vitest run __tests__/unity.test.ts`: **97 passed / 97**. Per describe block (sums to 97):
  1 top-level + 12 host-base/lifecycle + 13 fields/attributes/strings + 13 FishNet + 6 gate-hardening
  (F1–F4) + 48 Mirror + 4 detect/claimsReference/resolve. No pre-existing FishNet or Tier-1 assertion
  was weakened or removed. (Earlier drafts of this doc miscounted — a 20-vs-21 slip and a breakdown
  that didn't sum; the block-level counts above are the authoritative figures.)
- `npx tsc --noEmit`: **exit 0**. `npm run build`: **exit 0**.
- **Corpus verification (Mirror 96.10.3, `mirror_docs.sqlite`): ZERO corrections.** All 12 host
  callbacks, `NetworkBehaviour : MonoBehaviour`, the 3 RPC + guard + editor attribute classes,
  `SyncVarAttribute.hook`, the deferred host-base virtual counts, and the SyncObject Action-callback
  surfaces match the JSON exactly. Weaver `FindHookMethod`/`ProcessSyncVar` signatures confirmed.
