# Unity UI Toolkit (UXML / USS) indexing — plan

**Status: PHASE 1 BUILT AND VALIDATED (2026-07-27). Phase 2+ still plan-only.**
Scoped 2026-07-27 against `C:\dev\repos\unity\mirror-multiplayer` on a build of
`fix/affected-testfile-syncvar-hooks-heal-gate`; built on `feat/uxml-phase1`.

Two things this plan got wrong were corrected before building, both flagged by
field measurement of the 39 declared names. They are marked **SUPERSEDED** /
**CORRECTED** in place below rather than edited away, because the reasoning that
produced them is the reasoning that would produce them again:

- **§2b's `Q<T>("name")` keying is SUPERSEDED** by an inverted match — a C#
  string literal is tested against the *declared UXML name set* instead of
  being required to sit at a `Q` site. Measured payoff: **95 edges instead of
  31**, because the field project's largest consumer names elements from a
  const-string table with zero `Q` sites in the file.
- **§3's read of `GameHudPanel.cs:120` is CORRECTED.** The plan saw a variable
  `Q` site and called it a dead end that emits nothing. It is a *wrapper*
  (`Region<T>(string name)`) hiding two real names, which is what exposed the
  keying flaw.

What the plan got *right* and is now load-bearing: §3's bottom tier and §7's
open question 1 both said name-only resolution "degrades to *wrong*, not to
*absent*, unless we make non-unique names emit nothing." That is now a hard
condition with a dedicated test — and it fired on the first real project
indexed (four ambiguous names; see §8).

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

> **The `Q<T>("name")` keying below is SUPERSEDED.** It was the plan's biggest
> error. What shipped is described immediately after the table.

| Step | File | Change |
|---|---|---|
| Emit the C# side | ~~`src/resolution/frameworks/unity.ts`~~ | ~~new rule: `Q<T>("name")` / `Query<T>("name")` → unresolved ref `unity:uielement:<name>`~~ |
| Resolve it | **new** `src/resolution/frameworks/unity-uxml.ts` | `claimsReference` on the new prefix; `resolve` maps it to the `component` node for that element |
| Register | `src/resolution/frameworks/index.ts` | one registry entry |

This is a copy of the existing `SCRIPT_REF_PREFIX` / `ASSET_REF_PREFIX` /
`EVENT_REF_PREFIX` flow in `unity-assets.ts` — the C# or YAML side emits a
prefixed unresolved ref, the resolver claims the prefix and resolves it or
emits nothing.

**What shipped instead: the match is inverted.** Keying on the *call shape*
assumes every element name is written at a `Q` site. It is not. Two failure
modes were measured in the field project, and both are silent:

- A **wrapper**. `GameHudPanel.Region<T>(string name)` forwards to `Q<T>(name)`;
  its callers write `Region<Label>("interaction-prompt", this)`. A `Q`-keyed
  scanner sees nothing at either end. 2 of 33 names in `Assets/Game`.
- A **const-ID table**. `EdgegapWindowMetadata.cs` is 60+ lines of
  `public const string DEBUG_BTN_ID = "DebugBtn";` and contains **zero `.Q<`
  sites**. A `Q`-keyed scanner produces **0 edges** for a 113-element window.

Chasing these by widening the call-shape pattern is unbounded — every new
wrapper signature is a new pattern. So the test runs the other way: the C# side
emits a candidate ref for **every string literal shaped like an element name**,
and the resolver keeps only those that hit the declared-name set, which is
small, closed, and fully known by resolve time. Failure mode inverts from
*silent miss* to *visible noise* — and the noise is bounded by the fact that a
literal must match a declared name to survive at all.

The accepted noise is real and deliberate: a doc-comment mentioning
`"interaction-prompt"` produces an edge. That is the right trade — the comment
genuinely is about that element, and it is a better anchor than the wrapper
call site it describes.

Two structural constraints shaped the implementation:

- `extract(filePath, content)` gets **no `ResolutionContext`** and may run in a
  worker thread, so the declared-name set is unknowable at C# extraction time.
  The membership test therefore happens in `resolve()`, not at extraction.
- Candidate refs create **no nodes**. A route node per candidate literal would
  persist whether or not it resolved, which is exactly the node explosion §4
  forbids. The literal's line rides on the edge instead, and the ref is anchored
  to the C# **file** node (`file:<relativePath>` — the TreeSitterExtractor/kernel
  convention, *not* `generateNodeId`'s hashed form).

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

**Answered by measurement, and the answer changed the feature's shape.** All 39
declared names in the field project are unique; **zero** appear in more than one
file. Name-only resolution is 100% correct there, and the
`PanelRenderer` → `VisualTreeAsset` GUID walk (tier 1 below) buys **zero**
additional edges today — so it was not built.

That is not a licence to resolve by bare name. **The uniqueness is convention,
not structure.** Nothing in UXML namespaces a name; `Settings.uxml` already uses
bare `apply` and `cancel`. So the load-bearing rule for Phase 1 is not the
observed uniqueness — it is **tier 2's emit-nothing clause**, promoted from
fallback to *hard condition*: a name declared more than once anywhere in the
project resolves to nothing, and that is pinned by a test declaring the same
name in two `.uxml` files. Without it, the feature manufactures confident wrong
edges — the exact failure class it exists to remove — and would make the tool
worse, not better. With it, the GUID walk stays optional indefinitely.

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

~~`Q<T>(name)` where `name` is a variable — one such site exists in the field
project (`GameHudPanel.cs:120`) — emits nothing.~~ **CORRECTED.** That site is
not a dead end; it is the body of `GameHudPanel.Region<T>(string name)` at
`GameHudPanel.cs:113`, a wrapper whose callers pass `"interaction-prompt"` and
`"network-stats"` as literals. Reading it as "a variable, therefore nothing to
resolve" is precisely how the `Q`-site keying in §2b looked sound while silently
dropping names. Under the inverted match those two names resolve normally, from
the caller's literal. Class-selector overloads (`Q<Button>(className: "…")`)
remain out of scope in Phase 1.

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

**Phase 1 — UXML only. No kind changes. The whole reported problem. BUILT.**
- `.uxml` extraction: file node, `component` node per *named* element,
  `contains` edges. Nesting skips unnamed layout wrappers and attaches each
  element to its nearest **named** ancestor, so the graph shows the hierarchy an
  author can actually address.
- `<ui:Style src=…>` → `imports` edge to the `.uss` file record (the USS file
  gets a `file` node only — no rule extraction).
- C# string literal matching a declared element name → `references` edge, per
  the inverted match in §2b and the emit-nothing-on-ambiguity rule in §3.
- Fixes the reported false positive: `query "solo-button"` returns the UXML
  element as the definition, `callers`/`impact` see the coupling.

Two shapes needed handling that the plan did not anticipate, both present in the
field project's real markup:
- **XML comments must be blanked before scanning.** `Menu.uxml` carries a
  comment that quotes `<Style>` markup; scanning raw text invents an import.
- **`<ui:Template name="Row" src="Row.uxml">` is a template *alias*, not an
  element.** Its `name` is not addressable by `Q()`, so it must not become a
  node — only its `src` becomes an import.

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

## 7. Open questions for Kyle — answered

1. **Is bound-document scoping worth the complexity?** **No — not now.**
   Project-unique-name-only is what shipped, *conditional on* the
   emit-nothing-on-ambiguity clause being a hard requirement rather than a
   fallback (see §3). The GUID walk buys zero edges on the field project and
   stays optional indefinitely.
2. **Does USS (Phase 2) matter?** Deferred as scoped. Phase 1 ships `.uss` file
   nodes and `imports` edges only, so it remains entirely free of
   `NODE_KINDS` / kernel-wire risk.
3. **Upstream-shaped or fork-only?** Fork-only, and the shared-file hooks came
   out exactly as hoped: `LANGUAGES` +2, extension map +2, two gate predicates
   +1 line each, display names +2, routing +2 `else if` branches, registry +1.
   Every one is an append at a list/map/switch boundary inside a hunk the fork
   already owns — the near-zero-merge-risk category in `FORK-MAINTENANCE.md`.

## 8. Measured results (2026-07-27, `mirror-multiplayer`)

Re-index of the field project, against the pre-UXML baseline of
**18,486 nodes / 39,942 edges**:

| | before | after | delta |
|---|---|---|---|
| Nodes | 18,486 | 18,649 | **+163** |
| Edges | 39,942 | 40,195 | **+253** |

Every unit of both deltas is accounted for — no explosion, nothing unexplained:

- **+163 nodes** = 152 named elements + 11 file nodes (4 `.uxml`, 7 `.uss`).
  114 of the 152 are in one vendored file, `EdgegapWindow.uxml`; `Assets/Game`
  contributes 39, matching the hand count exactly.
- **+253 edges** = 152 `contains` + 95 `references` + 6 `imports`.

**Precision: 95 of 95 `references` edges checked by hand (no sampling), zero
wrong.** Every edge points from a C# file to a `.uxml` in the same feature
folder; there is not one cross-feature binding. `status` now reports
`uxml 4 / uss 7`, and `query "solo-button"` returns the `ui:Button` at
`Menu.uxml:20` instead of the C# field — the reported symptom.

**Coverage, and what the superseded design would have produced:**

| source | edges shipped | edges a `Q`-site scanner would emit |
|---|---|---|
| `Assets/Game` (literal `Q` sites) | 31 | 31 |
| `Assets/Game` via the `Region<T>` wrapper | 2 | 0 |
| `EdgegapWindowMetadata.cs` (const-ID table, **0 `.Q<` sites**) | 62 | 0 |
| **total** | **95** | **31** |

**The ambiguity rule fired on the first real project, unprompted.**
`EdgegapWindow.uxml` declares `Row` 6×, `DiscordTxt` 3×, `DiscordLogo` 3×, and
`ApplicationNameRow` 2×. All four resolve to **zero** edges. Under a
"return the first match" rule these would have been 12+ confident wrong edges in
a single vendored file — the hard condition in §3 is not hypothetical.

Reached vs declared in `Assets/Game`: **33 of 39**. The 6 unreached
(`capture-cursor-note`, `frame-rate-note`, `hud-root`, `lobby-hint`,
`menu-panel`, `settings-panel`) are named for styling or authoring convenience
and genuinely are never queried from C# — correct absence, not a miss.

Test coverage: `__tests__/unity-uxml.test.ts`, 35 tests, including the mandated
two-file ambiguity pin, the wrapper-literal inversion proof, comment blanking,
`<Template>` aliasing, `../` and `project://database/` src resolution, CRLF
determinism, and 4 end-to-end tests through a real index. Full suite shows no
new failures against the documented known-failure set.
