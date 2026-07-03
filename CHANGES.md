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
