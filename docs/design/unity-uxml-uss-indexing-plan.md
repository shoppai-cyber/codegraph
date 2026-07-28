# Unity UI Toolkit (UXML / USS) indexing — plan

**Status: PLAN ONLY. Nothing here is implemented.** Scoped 2026-07-27 against
`C:\dev\repos\unity\mirror-multiplayer` on a build of
`fix/affected-testfile-syncvar-hooks-heal-gate`.

## 1. The problem, measured

`.uxml` and `.uss` are not indexed at all. Measured on the field project:

```
$ codegraph status .
Files by Language:
  csharp          633
  unity_yaml      132
  yaml              1
```

766 files, none of them UI Toolkit. The project has **4 `.uxml` and 7 `.uss`**
files (3 uxml + 4 uss under `Assets/Game/`), and **32 `root.Q<T>("…")` call
sites** in `Assets/Game` alone (94 across all of `Assets/`, the rest in
vendored Mirror/Edgegap editor code).

Absence is not the whole problem. The lookup **succeeds with the wrong answer**:

```
$ codegraph query "solo-button"
field       soloButton
  Assets/Game/Presentation/Menu/MenuScreen.cs:66
  Button soloButton
```

The C# field that *holds* the element is returned as if it were the definition.
The actual definition —

```xml
<ui:Button name="solo-button" text="Play Solo" class="button button--primary button--wide" />
```

in `Assets/Game/Presentation/Menu/Menu.uxml` — is not in the graph at all. An
agent reads that result as a resolved lookup and stops. Renaming either side
fails silently at runtime; neither `callers` nor `impact` can see the coupling.

This is the same class of asset↔C# **string wiring** the fork already resolves
inside prefab/scene YAML (script GUIDs, UnityEvent target methods). It is a new
**surface** (XML instead of YAML), not a new mechanism.

## 2. Where it hooks in

Everything below has an existing precedent in-tree; nothing needs inventing.

### 2a. Extraction

| Step | File | Change |
|---|---|---|
| Language enum | `src/types.ts` | append `'uxml'`, `'uss'` to `LANGUAGES` |
| Extension map | `src/extraction/grammars.ts` | `'.uxml': 'uxml'`, `'.uss': 'uss'` |
| Grammar gates | `src/extraction/grammars.ts` | add both to the two "no WASM grammar needed / custom extractor" predicates (~lines 544-558), exactly as `unity_yaml` does |
| Display name | `src/extraction/grammars.ts` | `uxml: 'Unity UXML'`, `uss: 'Unity USS'` |
| Routing | `src/extraction/tree-sitter.ts` (~6715) | new `else if (detectedLanguage === 'uxml')` branch next to the `unity_yaml` one |
| Extractor | **new** `src/extraction/uxml-extractor.ts` | standalone, modeled on `unity-asset-extractor.ts` |

**Dedicated language, not the existing `xml`.** `.xml` already maps to language
`xml` with the MyBatis extractor hanging off it. Reusing it would (a) mix UI
Toolkit files into MyBatis's routing, and (b) make `status` and every
language-filtered query unable to tell UI files apart. `unity_yaml` set the
precedent by taking its own language rather than riding `yaml`; follow it.

**A tree-sitter XML grammar is not needed and not wanted.** UXML is a small,
fixed, hand-authored schema. What we need out of it is three attributes
(`name`, `class`, `src`/`template`) and the element tag. A targeted scanner —
the same shape as `DfmExtractor` and `UnityAssetExtractor` — is cheaper, has no
new wasm asset to ship through `copy-assets`, and cannot regress the kernel.

### 2b. Resolution

| Step | File | Change |
|---|---|---|
| Emit the C# side | `src/resolution/frameworks/unity.ts` | new rule: `Q<T>("name")` / `Query<T>("name")` → unresolved ref `unity:uielement:<name>` |
| Resolve it | **new** `src/resolution/frameworks/uxml.ts`, or extend `unity-assets.ts` | `claimsReference` on the new prefix; `resolve` maps it to the `component` node for that element |
| Register | `src/resolution/frameworks/index.ts` | one registry entry |

This is a copy of the existing `SCRIPT_REF_PREFIX` / `ASSET_REF_PREFIX` /
`EVENT_REF_PREFIX` flow in `unity-assets.ts` — the C# or YAML side emits a
prefixed unresolved ref, the resolver claims the prefix and resolves it or
emits nothing.

### 2c. Node and edge kinds — **no append required**

This is the load-bearing finding for risk: **Phase 1 needs no change to
`NODE_KINDS` or `EDGE_KINDS`**, so the native kernel's wire contract
(`src/extraction/kernel/layout.ts`, where kinds cross the JS↔Rust boundary as
array indexes) is not touched at all.

| Thing | Kind | Why it already fits |
|---|---|---|
| A `.uxml` / `.uss` document | `file` | standard |
| A named UXML element (`<ui:Button name="solo-button">`) | `component` | the exact kind `unity-asset-extractor.ts` already uses for scene GameObjects and prefab instances |
| `Q<T>("solo-button")` → element | `references` | generic reference edge, as UnityEvent targets already use |
| `<ui:Style src="Menu.uss">`, `<ui:Template src=…>` | `imports` | file→file, same as every other import |
| uxml document → its named elements | `contains` | standard parent/child |

**USS style rules have no good existing kind** (`.button--primary` is not a
class, constant, or property in any honest sense). That is the *only* thing in
this feature that would need a `NODE_KINDS` append — which is why USS rule
extraction is deliberately **Phase 2** below, kept out of the first landing.

If Phase 2 does append a kind, the append itself is safe (append-only, never
reorder) but the check to run first is whether `layout.ts` and the Rust side
tolerate a JS-side kind index the kernel has no counterpart for. UXML/USS never
route through the kernel, so nothing should ever serialize the new index across
the boundary — but that must be *verified*, not assumed.

## 3. Scoping: which UXML does a given `Q()` mean?

The hard part, and the part that decides whether this is worth building.

`Q<Button>("solo-button")` is looked up against **the visual tree that panel
loaded**, not against every UXML in the project. Two elements named
`title-label` in two screens are different elements. Resolving by bare name
project-wide produces confident wrong edges — the exact failure this feature
exists to remove.

Proposed two-tier resolution, strictest first, emit-nothing at the bottom:

1. **Bound-document scope (preferred).** The class doing the querying is a
   `MonoBehaviour` on a GameObject that also carries a `PanelRenderer` (or the
   maintenance-only `UIDocument`), whose serialized `VisualTreeAsset` field
   points at a `.uxml` **by GUID** in the scene/prefab YAML. The fork already
   builds that map — `getGuidMap(context)` in `unity-assets.ts` — and already
   resolves `.uxml.meta` GUIDs for free, because it maps every `.meta` in the
   project. Verified present in the field project: `00_Boot.unity` and
   `GameHudPanelSettings.asset` both reference the UI assets this way. Resolve
   the name **only within that document** (plus any `<ui:Template>` it pulls
   in).
2. **Project-unique fallback.** If the binding chain can't be walked (panel
   built in code, asset in a package, ambiguous component), resolve only if the
   name is unique across all indexed `.uxml`. Otherwise emit nothing.

`Q<T>(name)` where `name` is a variable — one such site exists in the field
project (`GameHudPanel.cs:120`) — emits nothing. Same for class-selector
overloads (`Q<Button>(className: "…")`) in Phase 1.

## 4. Node explosion — the budget rule

A UXML document is a tree; a HUD can be hundreds of elements. Emitting one node
per element would blow up the graph for no retrieval gain.

**Only elements carrying a `name=` attribute get a node.** Those are precisely
the ones `Q(name)` can address; everything else is layout. This is the same
discipline the scene extractor already applies ("pure decoration is summarized
on its parent rather than exploded into thousands of nodes"). Expected cost on
the field project: on the order of tens of nodes, not thousands — `Menu.uxml`
declares roughly a dozen named elements.

Node-count stability before/after re-index is a required probe (§6).

## 5. Phasing

**Phase 1 — UXML only. No kind changes. The whole reported problem.**
- `.uxml` extraction: file node, `component` node per *named* element,
  `contains` edges.
- `<ui:Style src=…>` → `imports` edge to the `.uss` file record (the USS file
  gets a `file` node only — no rule extraction).
- `Q<T>("name")` → `references` edge, scoped per §3.
- Fixes the reported false positive: `query "solo-button"` returns the UXML
  element as the definition, `callers`/`impact` see the coupling.

**Phase 2 — USS rules.** Selector nodes, `class="…"` → selector references,
`@import`. This is the part that needs a `NODE_KINDS` append and a kernel-wire
check. It answers a different question ("what styles this?") and should be
judged on its own evidence.

**Phase 3 (may never be worth it) — `Q()` class-selector overloads, UI Builder
`.uxml` binding paths, `dataSource` bindings.**

## 6. Validation — what would have to be true to land it

Per the REQUIRED methodology in `CLAUDE.md` (language × framework, small /
medium / large, ≥3 flow prompts each) and the fork's graph-diff discipline in
`FORK-MAINTENANCE.md`:

1. **Canonical flow prompt:** *"what happens when the user clicks Play Solo?"*
   — must connect `Menu.uxml`'s `solo-button` → `MenuScreen.soloButton` →
   the click handler → the session start path, with 0 Read/Grep.
2. **Deterministic probes** (`scripts/agent-eval/probe-explore.mjs` against
   built `dist/`): explore connects UXML element → C# handler end-to-end;
   `select count(*) from nodes` stable modulo the intended additions;
   precision spot-check on every emitted `references` edge (with only 3 UXML
   files, check **all** of them by hand — no sampling).
3. **Baseline-before, diff-after** on the real corpora, per FORK-MAINTENANCE §5.
   Take the snapshot before touching extraction; explain every delta.
4. **Agent A/B** `--model sonnet --effort high`, ≥2 runs/arm, both arms same
   model; report the range, never one run.
5. **Pass bar:** `query "solo-button"` names the UXML element; zero wrong
   `references` edges (an ambiguous name resolving to the wrong screen is a
   ship-blocker, not a rough edge — partial coverage that produces a *wrong*
   hop is worse than no coverage); no regression on `tester-01` as control.

## 7. Open questions for Kyle

1. **Is bound-document scoping worth the complexity, or is
   project-unique-name-only acceptable for v1?** Unique-only is maybe 30 lines
   and covers the field project today (element names there appear to be
   globally unique), but it silently stops working the moment two screens share
   a name — and it degrades to *wrong*, not to *absent*, unless we make
   non-unique names emit nothing.
2. **Does USS (Phase 2) matter to you at all**, or is the UXML↔C# string
   coupling the whole ask? Phase 2 is where the `NODE_KINDS` append and the
   kernel-wire check live; skipping it keeps this feature entirely free of
   shared-contract risk.
3. **Upstream-shaped or fork-only?** UI Toolkit is Unity-specific, so it lands
   in fork-only files under the existing additive discipline either way — but
   if it is ever meant to go upstream, the `LANGUAGES` / extension-map / gate
   edits are the shared-file hooks that would need to be minimal and
   registry-shaped.
