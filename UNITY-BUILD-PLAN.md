# Unity Framework Resolver Build Plan

Status: post-Fable fix pass complete for Tier 1; ready for Fable re-check
against `FABLE-IMPL-REVIEW.md`.

## Baseline Confirmed

- `npx vitest run __tests__/blender.test.ts`: 32 passed / 32.
- `npm run build`: exit 0.
- Initial `git status --short --branch`: branch `feat/unity-resolver`; existing
  untracked `CODEX-REVIEW-HANDOFF.md`.

## Implementation Checkpoint

Completed on 2026-07-05:

- Red test gate: `npx vitest run __tests__/unity.test.ts` initially failed
  because `src/resolution/frameworks/unity.ts` did not exist.
- Implemented `src/resolution/frameworks/unity.ts` and registered it in
  `src/resolution/frameworks/index.ts`.
- Green checks:
  - `npx vitest run __tests__/unity.test.ts`: 26 passed / 26.
  - `npx vitest run __tests__/blender.test.ts`: 32 passed / 32.
  - `npm run build`: exit 0.

Post-Fable fix checkpoint:

- Review source:
  `C:\dev\repos\unity\databases\unity-docs\unity-6.5\resolver-facts\FABLE-IMPL-REVIEW.md`.
- Added red tests for:
  - non-self member-access chains such as another object's `gameObject`
    message call, null-conditional sends, and expression-returned invoke
    receivers;
  - suffix-colliding class names during synthetic reference resolution;
  - serialized member declarations embedded inside string literals;
  - expression-bodied siblings during string-invoked overload ambiguity.
- Added the missing `CHANGELOG.md` entry under `[Unreleased]`.
- Green checks after fixes:
  - `npx vitest run __tests__/unity.test.ts`: 30 passed / 30.
  - `npx vitest run __tests__/blender.test.ts`: 32 passed / 32.
  - `npm run build`: exit 0.

## Scope Decision

Build Tier 1 first: code-only Unity C# framework awareness, mirroring the
Blender resolver shape.

Tier 1 should emit synthetic `route` nodes plus unresolved `references` refs for
Unity host-invoked code that the normal C# extractor already parses but cannot
connect to callers. It should not add asset/YAML parsing, GUID resolution,
scene/prefab `UnityEvent` wiring, animation events, or `.meta` indexing. Those
belong to Tier 2.

The resolver must preserve the inherited Blender promise: if the target is not
statically resolvable, emit nothing. A missed Unity edge is better than a
fabricated one.

## Fable Review Outcome

Decision source:
`C:\dev\repos\unity\databases\unity-docs\unity-6.5\resolver-facts\FABLE-SCOPE-DECISIONS.md`.
Builder checklist:
`C:\dev\repos\unity\databases\unity-docs\unity-6.5\resolver-facts\FABLE-BUILDER-CHECKLIST.md`.

Fable approved nine v1 host bases: `MonoBehaviour`, `ScriptableObject`,
`StateMachineBehaviour`, `Editor`, `EditorWindow`, `PropertyDrawer`,
`DecoratorDrawer`, `AssetPostprocessor`, and `AssetModificationProcessor`.
`ScriptableWizard`, build interfaces, PlayerLoop, networking packages, test
framework attributes, public-field implicit serialization, editor callback
registrations, and Tier 2 asset wiring are deferred.

Per-base method lists in `src/resolution/frameworks/unity-invocation-table.json`
are now the authoritative consumed sets for implementation. The important
corrections are:

- `MonoBehaviour`: docs-56 list; UGUI-internal draft rows quarantined.
- `EditorWindow`: docs-17 list; `ShowButton` quarantined.
- `Editor`: 20 rows including `CreateInspectorGUI` and preview/frame-bounds
  overrides; `OnHeaderGUI` quarantined.
- `StateMachineBehaviour`: 13 rows including ScriptableObject lifecycle rows.
- `AssetPostprocessor`: closed 28-row set; no open-ended
  `OnPostprocess<Type>` convention matching.
- `AssetModificationProcessor`: new base with 8 static hooks.
- `DecoratorDrawer.CreatePropertyGUI`: corpus-validated.

The `UnityEditor.Callbacks` attributes `PostProcessBuild`,
`PostProcessScene`, `DidReloadScripts`, and `OnOpenAsset` were verified in the
local corpus on 2026-07-05 and kept with `requiresStatic: true`:
`Callbacks.PostProcessBuildAttribute`, `Callbacks.PostProcessSceneAttribute`,
`Callbacks.DidReloadScripts`, and `Callbacks.OnOpenAssetAttribute`.

String-invoked method rules are the spec for implementation:

1. The containing class is provably host-based in the SAME file (direct or
   same-file-chained Unity host base).
2. The argument is a single string literal or bare-identifier `nameof(M)`.
   Dotted `nameof`, concatenation, interpolation, variables, and empty strings
   emit nothing.
3. Exactly one same-class method matches. Zero matches or overload ambiguity
   emits nothing.

Receiver rules:

- `Invoke`, `InvokeRepeating`, `CancelInvoke`, `IsInvoking`,
  `StartCoroutine("M")`, and `StopCoroutine("M")`: implicit or `this` receiver
  only.
- `SendMessage`, `BroadcastMessage`, and `SendMessageUpwards`: implicit,
  `this`, or `gameObject` receiver only; link the unique same-class sibling
  method and never project-wide name matches.

Pre-implementation spot checks completed:

- The four `UnityEditor.Callbacks` attributes above were found as local corpus
  pages/xrefs and kept.
- `OnChildRectTransformDimensionsChange` has a local
  `MonoBehaviour.OnChildRectTransformDimensionsChange` page/xref and Messages
  row; `OnRectTransformDimensionsChange` has no local page, xref, or search
  hit and remains quarantined.

## Proposed Resolver Surface

Runtime-consumed table sections should stay close to Blender's model:

- `hostInvokedBases`: direct Unity base whitelist plus host method names.
- `serializationAttributes`: field attributes whose field is live and whose
  declared custom type can be referenced.
- `attributeEntryPoints`: method/class attributes that make a method/class live.
- `typeReferenceAttributes`: `typeof(X)` attributes that reference local types.
- `stringInvokedCallSites`: string or `nameof(...)` method-name call sites.
- `detection`: cheap Unity project markers.

The TypeScript resolver should:

- Use `stripCommentsForRegex(content, 'csharp')`.
- Gate extraction to `.cs`.
- Collect C# classes, direct base names, class bodies, methods, fields, and
  attributes from the same file.
- Emit only route nodes and references, using `NodeKind` and `EdgeKind` fixed
  strings from `src/types.ts`.
- Use synthetic reference prefixes such as `unity:host:Class.Method`,
  `unity:field:Class.field`, and `unity:method:Class.Method` so `claimsReference`
  can opt them through the name-exists pre-filter.
- Resolve synthetic refs by exact same-file class containment, not by bare method
  name fallback.

## TDD Test Harness

Create `__tests__/unity.test.ts` by copying the Blender harness style:

- Directly call `unityResolver.extract!(filePath, source)`.
- Assert exact sorted `nodeNames(result)` and exact sorted `refPairs(result)`.
- Include `makeContext`, `makeSymbol`, and `makeRef` helpers for `detect()`,
  `claimsReference()`, and `resolve()`.
- Each behavior starts red before implementation.

Planned helper names:

```ts
function extract(source: string, filePath = 'Assets/Scripts/Player.cs')
function nodeNames(result: FrameworkExtractionResult): string[]
function refPairs(result: FrameworkExtractionResult): string[]
```

Preferred node-name convention, subject to review:

- `UNITY MonoBehaviour.Update Player.Update`
- `UNITY serialized field Player.weapon`
- `UNITY attribute RuntimeInitializeOnLoadMethod Bootstrap.Init`
- `UNITY type-ref RequireComponent Player`
- `UNITY string-invoke Invoke Player.Explode`

Preferred ref convention:

- Host methods: `references:unity:host:Player.Update`
- Serialized fields: `references:unity:field:Player.weapon`
- Declared custom field type: `references:WeaponConfig`
- Attribute entry method: `references:unity:method:Bootstrap.Init`
- Attribute class target: `references:Player`
- Type attribute arg: `references:HealthComponent`

## TDD Test List

### 1. MonoBehaviour direct lifecycle methods

Fixture:

- `using UnityEngine;`
- `class Player : MonoBehaviour`
- methods `Awake`, `Start`, `Update`, `FixedUpdate`, `OnTriggerEnter2D`,
  `OnApplicationPause`, `OnDrawGizmosSelected`, and helper `TickInternal`.

Expected:

- Nodes only for whitelisted Unity messages.
- Refs only to `unity:host:Player.<message>`.
- No node/ref for `TickInternal`.

### 2. Non-host class with magic names emits nothing

Fixture:

- `class PlainService`
- methods `Start`, `Update`, `OnEnable`.

Expected:

- `{ nodes: [], references: [] }`.

This locks the core false-positive guard: names alone do not imply Unity
invocation.

### 3. Qualified and aliased Unity bases

Fixtures:

- `class Player : UnityEngine.MonoBehaviour`
- `using UE = UnityEngine; class Player : UE.MonoBehaviour`
- optional simple alias: `using MB = UnityEngine.MonoBehaviour; class Player : MB`

Expected:

- Direct and qualified bases emit.
- Alias support should be implemented only for simple `using X = ...` aliases
  that are statically visible in the same file.

### 4. Cross-file base-chain ceiling

Fixture A:

- Same file defines `class BaseBehaviour : MonoBehaviour` and
  `class Player : BaseBehaviour`.

Expected:

- Same-file base closure is in scope after direct-base extraction is green.
- Emit for `Player.Update` only because `BaseBehaviour : MonoBehaviour` is
  proven in the same file.
- If implementation pressure forces this to v1.1, update this plan explicitly;
  cross-file chains still never emit.

Fixture B:

- Current file defines `class Player : BaseBehaviour` with `Update`.
- `BaseBehaviour : MonoBehaviour` is not in this file.

Expected:

- Emit nothing for `Player.Update`.

Document the inherited limitation: per-file extraction cannot later insert
method nodes when another file proves the base chain.

### 5. Partial class ceiling

Fixture:

- One partial file has `partial class Player : MonoBehaviour`.
- Another partial file has `partial class Player { void Update() {} }`.

Expected for the method-only file:

- Emit nothing unless the file itself proves host-invokedness.

This is the C# variant of the cross-file base-chain ceiling.

### 6. ScriptableObject lifecycle and CreateAssetMenu

Fixture:

- `class ItemConfig : ScriptableObject`
- `Awake`, `OnEnable`, `OnDisable`, `OnDestroy`, `OnValidate`, `Reset`
- `[CreateAssetMenu(menuName = "Items/Sword")]`.

Expected:

- Host method nodes for the ScriptableObject messages.
- A class-attribute node referencing `ItemConfig`.
- No path-string resolution beyond provenance.

### 7. StateMachineBehaviour callbacks

Fixture:

- `class AttackState : StateMachineBehaviour`
- methods `OnStateEnter`, `OnStateUpdate`, `OnStateExit`,
  `OnStateMachineEnter`, helper `Evaluate`.

Expected:

- Nodes/refs for whitelisted callbacks only.

### 8. Editor custom inspector callbacks

Fixture:

- `using UnityEditor;`
- `[CustomEditor(typeof(Player))]`
- `class PlayerEditor : Editor`
- methods `OnInspectorGUI`, `CreateInspectorGUI`, `OnSceneGUI`,
  `HasPreviewGUI`, `OnPreviewGUI`, `RequiresConstantRepaint`, helper
  `DrawHealth`.

Expected:

- Host method nodes for official Editor override/callback methods.
- Type ref to `Player` from `CustomEditor(typeof(Player))`.
- No node/ref for helper method.

### 9. EditorWindow callbacks and false-positive correction

Fixture:

- `class ToolsWindow : EditorWindow`
- methods `OnGUI`, `CreateGUI`, `Update`, `OnSelectionChange`,
  `OnProjectChange`, `OnBecameVisible`, `OnBecameInvisible`, `ShowButton`.

Expected:

- Nodes for documented EditorWindow messages.
- No node for `ShowButton`; it is quarantined and absent from consumed data.

### 10. PropertyDrawer and DecoratorDrawer

Fixture:

- `[CustomPropertyDrawer(typeof(MyAttribute))]`
- `class MyDrawer : PropertyDrawer`
- methods `OnGUI`, `GetPropertyHeight`, `CreatePropertyGUI`.

Expected:

- Host method nodes for documented drawer methods.
- Type ref to `MyAttribute`.

Separate DecoratorDrawer fixture should include `CreatePropertyGUI`; this is
corpus-validated in the local Unity 6.5 docs and should stay in the consumed
table.

### 11. AssetPostprocessor import callbacks

Fixture:

- `class ImportHooks : AssetPostprocessor`
- methods `OnPreprocessAsset`, `OnPreprocessTexture`, `OnPostprocessTexture`,
  `OnPreprocessModel`, `OnPostprocessModel`, `OnPostprocessAllAssets`,
  `GetPostprocessOrder`, `GetVersion`, helper `NormalizeName`.

Expected:

- Nodes/refs for approved AssetPostprocessor callbacks.
- No helper node.

The table now uses a closed 28-row set; tests should include at least the rows
above and assert that helpers and convention-only names emit nothing.

### 11A. AssetModificationProcessor static hooks

Fixture:

- `class AssetSaveHooks : AssetModificationProcessor`
- static hooks `CanOpenForEdit`, `FileModeChanged`, `IsOpenForEdit`,
  `MakeEditable`, `OnWillCreateAsset`, `OnWillDeleteAsset`,
  `OnWillMoveAsset`, `OnWillSaveAssets`
- non-static `OnWillSaveAssets`
- helper method `NormalizePath`.

Expected:

- Nodes/refs for the eight approved hooks only.
- Non-static hook declarations emit nothing.
- No node/ref for the helper method.

### 12. Serialization attributes on fields

Fixture:

- `class Player : MonoBehaviour`
- `[SerializeField] private WeaponConfig weapon;`
- `[SerializeReference] private IBehavior behavior;`
- `[SerializeField] private int health;`
- `[SerializeField] private UnityEngine.GameObject prefab;`

Expected:

- Field liveness nodes for all serialized fields.
- Synthetic field refs to exact containing fields.
- Type refs only for local/custom types (`WeaponConfig`, `IBehavior`).
- No type refs for primitives or UnityEngine external types.

### 13. Attribute target syntax for serialized properties

Fixture:

- `[field: SerializeField] public WeaponConfig Weapon { get; private set; }`

Expected:

- Emit a property-shaped liveness node referencing the property symbol.
- Never fabricate a backing-field node.
- Emit nothing if the property symbol is unavailable from C# extraction.

### 14. Public serialized fields deferred test

Fixture:

- `public WeaponConfig weapon;` inside `MonoBehaviour`.

Recommendation:

- Do not include in initial green unless validated. Unity serializes public
  fields by default, but implementing this correctly requires Unity
  serializability rules, ownership context, and skip rules. `[SerializeField]`
  and `[SerializeReference]` are safer Tier-1 anchors.

### 15. Method attribute entry points

Fixture:

- `[RuntimeInitializeOnLoadMethod] static void Boot()`
- `[InitializeOnLoadMethod] static void EditorBoot()`
- `[MenuItem("Tools/Rebuild")] static void Rebuild()`
- `[MenuItem("Tools/Rebuild", true)] static bool ValidateRebuild()`
- `[ContextMenu("Reset Stats")] void ResetStats()`
- `[PostProcessBuild] static void OnBuild(...)`
- `[PostProcessScene] static void OnScene()`
- `[DidReloadScripts] static void Reloaded()`
- `[OnOpenAsset] static bool OpenAsset(...)`

Expected:

- Attribute nodes referencing exact containing methods.
- Menu/context path strings captured only in node names/provenance, not resolved
  to targets.
- Non-static methods with static-only attributes emit nothing.
- Static methods with `[ContextMenu]` emit nothing.
- `PostProcessBuild`, `PostProcessScene`, `DidReloadScripts`, and
  `OnOpenAsset` are behind the table's pending-corpus-verification gate; split
  tests so they can be kept or quarantined based on that local corpus result.

### 16. Class attribute entry points

Fixture:

- `[InitializeOnLoad] class EditorBootstrap { static EditorBootstrap() {} }`
- `[AddComponentMenu("Gameplay/Player")] class Player : MonoBehaviour`
- `[CreateAssetMenu(menuName = "Items/Sword")] class ItemConfig : ScriptableObject`

Expected:

- Class attribute nodes referencing the class.
- If a static constructor is present and the C# extractor exposes it, a ref to
  the exact static constructor can be added. Otherwise class reference only.

### 17. Type reference attributes

Fixture:

- `[RequireComponent(typeof(HealthComponent), typeof(Rigidbody))]`
- `[CustomEditor(typeof(Player))]`
- `[CustomPropertyDrawer(typeof(MyAttribute), true)]`
- `[DrawGizmo(GizmoType.Selected)] static void Draw(Player p, GizmoType g)`

Expected:

- `RequireComponent`: ref only to local/custom `HealthComponent`; skip external
  `Rigidbody`.
- `CustomEditor`: ref to `Player`.
- `CustomPropertyDrawer`: ref to `MyAttribute`.
- `DrawGizmo`: method entry-point node for the static method. Emit a typeof ref
  only when an explicit `typeof(local type)` argument is present. Do not infer
  the target type from the first method parameter in v1.

### 18. String-invoked same-class methods

Fixture:

- `Invoke("Explode", 1f)`
- `InvokeRepeating(nameof(Tick), 1f, 1f)`
- `IsInvoking("Tick")`
- `StartCoroutine("Blink")`
- `StopCoroutine("Blink")`
- `CancelInvoke("Tick")`
- sibling methods `Explode`, `Tick`, `IEnumerator Blink`.

Expected:

- String-invoke nodes referencing same-class methods by exact containment.
- `nameof(M)` accepted.
- Concatenated, interpolated, variable, or empty strings emit nothing.
- The three global preconditions in the Fable Review Outcome section apply to
  all string-invoked call-site families.

### 19. Overload ambiguity emits nothing

Fixture:

- `Invoke("Explode", 1f)`
- `void Explode()`
- `void Explode(int amount)`

Expected:

- Emit nothing for `Explode` unless the resolver can prove the invoked overload.

The draft table's "link all overloads" note is too aggressive for this repo's
false-positive policy.

### 20. SendMessage/BroadcastMessage guard

Fixture:

- `SendMessage("ApplyDamage")` in `Player`.
- `other.SendMessage("ApplyDamage")`.
- sibling method `ApplyDamage`.

Expected:

- Same-class implicit or `this` receiver links to the same class method when
  exactly one sibling method matches.
- `gameObject.SendMessage("ApplyDamage")` can also link to the same-class
  unique sibling because self is always among the receivers.
- Receiver expressions other than implicit `this`, `this`, or possibly
  `gameObject` emit nothing.
- No project-wide method-name linking.

The draft table's "best-effort within project" language is an overreach.

### 21. ContextMenuItem string method

Fixture:

- `[ContextMenuItem("Reset", "ResetBiography")] [SerializeField] string bio;`
- method `ResetBiography`.

Expected:

- Node/ref to same-class `ResetBiography`.
- Computed or variable method names emit nothing.

### 22. Network and test package attributes

Fixtures:

- `[ServerRpc]`, `[ClientRpc]`, `[Rpc]` on `NetworkBehaviour`.
- `[Command]`, `[ClientRpc]`, `[TargetRpc]`, `[SyncVar(hook = nameof(OnHealthChanged))]`
  with `using Mirror;`.
- `[Test]`, `[UnityTest]`, `[SetUp]`, `[UnitySetUp]`, `[TearDown]`.

Expected:

- No networking or test attributes are consumed in v1.
- `[ServerRpc]`, `[ClientRpc]`, `[Rpc]`, `[Command]`, `[TargetRpc]`,
  `[SyncVar]`, `[Test]`, `[UnityTest]`, `[SetUp]`, and related rows emit
  nothing in v1.
- Package-specific rows are deferred to sibling corpora/gated resolvers; test
  attributes are a v1.1 candidate with same-file NUnit/Unity Test Framework
  using gates.

### 23. Attribute name collision guard

Fixture:

- User-defined `class TestAttribute : Attribute`.
- `[Test] void LooksLikeNUnit()`.
- No `using NUnit.Framework`.

Expected:

- Emit nothing in v1 because `[Test]` is absent from consumed data.

### 24. Detection tests

Fixtures:

- `ProjectSettings/ProjectVersion.txt` present -> true.
- `Packages/manifest.json` with `com.unity.*` -> true.
- `.asmdef` file present -> true.
- `.cs` file with Unity base/attribute evidence -> true.
- Plain C# repo with `using UnityEngine;` only in comments or docs -> false.
- Plain C# repo with a real `using UnityEngine;` but no Unity host base,
  attribute, project file markers, `.asmdef`, `.meta`, `Assets/`, or
  `ProjectSettings/` layout -> false.

The source fallback should be stronger than a raw `using UnityEngine;`: prefer a
Unity base, Unity attribute, or UnityEditor callback signal in source.

### 25. claimsReference and resolve tests

Expected:

- `claimsReference('unity:host:Player.Update')` true.
- `claimsReference('unity:method:Player.Explode')` true.
- `claimsReference('Update')` false.
- `resolve()` finds exact same-file contained method/field/class.
- `resolve()` returns null for same-name method outside the class span.

## Accepted Table Corrections

The original draft critique is superseded by Fable's decision record and the
`unity-invocation-table.json` v0.2.0 edits. Implementation should treat the
consumed table as authoritative and preserve these decisions:

- `ShowButton`, `OnHeaderGUI`, and the four UGUI-internal MonoBehaviour rows
  are quarantined, not consumed.
- `Editor`, `EditorWindow`, `StateMachineBehaviour`, and `AssetPostprocessor`
  use the Fable-approved closed lists.
- `AssetModificationProcessor` is in v1 with eight static hooks.
- `DrawGizmo` is a static method entry point with optional explicit
  `typeof(local type)` reference; no first-parameter inference in v1.
- `DecoratorDrawer.CreatePropertyGUI` is corpus-validated.
- String-invoked links require host-based same-file containment, literal or
  bare `nameof(M)`, and a unique same-class target.
- `SendMessage` families link only implicit, `this`, or `gameObject` receivers
  to a unique same-class sibling; never project-wide names.
- Networking and test attributes are deferred out of v1 consumed data.
- Public-field implicit serialization, build interfaces, ScriptableWizard,
  editor callback registrations, UIBehaviour/UGUI rows, and all Tier 2 asset
  wiring remain cataloged deferrals.

## detect() Approach

Use a cheap project-level `detect(context)` with strong markers first:

1. `ProjectSettings/ProjectVersion.txt` exists.
2. `Packages/manifest.json` contains Unity packages such as `com.unity.`.
3. Any `*.asmdef` file exists.
4. `.meta` files plus `Assets/` or `ProjectSettings/` layout signals exist.
5. Bounded source scan of `.cs` files for direct Unity evidence:
   - `: MonoBehaviour`, `: UnityEngine.MonoBehaviour`, etc.
   - `: ScriptableObject`, `: Editor`, `: EditorWindow`, etc.
   - Unity attributes such as `[SerializeField]`, `[CreateAssetMenu]`,
     `[RuntimeInitializeOnLoadMethod]`, `[MenuItem]`, `[RequireComponent]`.

Avoid treating `using UnityEngine;` alone as a strong source marker. It is useful
as supporting context, but it is too broad for repo-level detection when the
resolver can instead look for concrete Unity base/attribute syntax.

In `extract(filePath, content)`, keep a second local gate:

- File must end in `.cs`.
- Source must contain a Unity signal before deeper regex scans.
- Individual emission paths must still prove their own local condition.

## Cross-file Base-chain Ceiling

The inherited Blender limitation applies directly to Unity:

- `extract()` runs per file in isolated workers.
- `postExtract()` can update existing nodes by id, but cannot insert new route
  nodes for methods discovered after cross-file reasoning.
- Therefore `class Player : GameBehaviour` where `GameBehaviour : MonoBehaviour`
  is defined in another file cannot safely emit `Player.Update` host-liveness
  nodes during Tier 1.

Policy:

- Direct Unity base in the same class header emits.
- Same-file base-chain support is in scope after direct-base extraction is
  green; the closure is bounded to class facts proven in the same file.
- Cross-file base chains emit nothing.
- Partial class method parts that do not contain the Unity base proof emit
  nothing.
- Document this in `CHANGES.md` when implementation lands.

## Validation Plan After Implementation

After the reviewed TDD list is implemented:

1. `npx vitest run __tests__/unity.test.ts`
2. `npx vitest run __tests__/blender.test.ts`
3. `npm run build`
4. Deterministic codegraph probes on `C:\dev\repos\unity\Unity-MP-Course-Project`:
   - Index before/after.
   - Confirm lifecycle methods gain callers/refs.
   - Confirm node count does not explode.
   - Spot-check synthetic/reference edges for false positives.
5. Required methodology from `CLAUDE.md`:
   - small, medium, large real Unity repos
   - at least three flow prompts each
   - deterministic `probe-explore` / node probes against built `dist/`
   - A/B eval arms on Sonnet `--effort high`
   - record in `docs/design/dynamic-dispatch-coverage-playbook.md`
6. Two-lens review:
   - GLM structural review via Overstory
   - Codex adversarial review via the sanctioned companion pattern

## Delegation Recommendation

Do not delegate resolver design or the initial `unity.ts` implementation. The
table corrections and false-positive policy require in-session judgment.

Delegate mechanical sub-work after this plan is reviewed:

- GLM lane: harvest official Unity docs into `C:\dev\vault\kb\gamedev\unity\`
  with one deliverable report listing source URLs, version coverage, and any
  uncertain callback lists. This is high-volume and mechanically checkable.
- GLM or Codex lane: independent table audit of
  `unity-invocation-table.json`, focused only on list correctness and missing
  official callback surfaces, with no repo edits.
- Codex/GLM lane later: generate additional test fixture source snippets after
  the accepted TDD list is frozen. I should still write/own the actual tests.

Per the Overstory recipe, any worker must get a complete brief, write exactly
one deliverable in its worktree CWD, run no git commands, and send `worker_done`.
No panes have been fired for this plan.

## Official Docs Spot-checked For This Plan

- `https://docs.unity3d.com/ScriptReference/MonoBehaviour.html`
- `https://docs.unity3d.com/6000.5/Documentation/ScriptReference/ScriptableObject.html`
- `https://docs.unity3d.com/6000.4/Documentation/ScriptReference/Editor.html`
- `https://docs.unity3d.com/2022.3/Documentation/ScriptReference/EditorWindow.html`
- `https://docs.unity3d.com/6000.0/Documentation/ScriptReference/PropertyDrawer.html`
- `https://docs.unity3d.com/6000.4/Documentation/ScriptReference/AssetPostprocessor.html`
- `https://docs.unity3d.com/6000.0/Documentation/ScriptReference/SerializeField.html`
- `https://docs.unity3d.com/ScriptReference/SerializeReference.html`
- `https://docs.unity3d.com/6000.4/Documentation/ScriptReference/RuntimeInitializeOnLoadMethodAttribute.html`
- `https://docs.unity3d.com/ScriptReference/ContextMenuItemAttribute.html`
- `https://docs.unity3d.com/6000.6/Documentation/ScriptReference/RequireComponent.html`
- `https://docs.unity3d.com/6000.4/Documentation/ScriptReference/GameObject.SendMessage.html`
- `https://docs.unity3d.com/6000.2/Documentation/ScriptReference/MonoBehaviour.StartCoroutine.html`
- `https://docs.unity3d.com/Packages/com.unity.netcode.gameobjects%402.5/manual/advanced-topics/message-system/rpc.html`
- `https://docs.unity3d.com/Packages/com.unity.test-framework%401.1/manual/reference-unitysetup-and-unityteardown.html`
