/**
 * Unity framework resolver tests.
 *
 * These are TDD red tests for the Tier-1 code-only Unity resolver. Assertions
 * are exhaustive: exact sorted node names and exact sorted reference pairs.
 * Extra fabricated nodes/refs fail the test just as much as missing ones.
 */

import { describe, it, expect } from 'vitest';
import { unityResolver, __gatedStacksForTest } from '../src/resolution/frameworks/unity';
import { getFrameworkResolver } from '../src/resolution/frameworks';
import type {
  FrameworkExtractionResult,
  ResolutionContext,
  UnresolvedRef,
} from '../src/resolution/types';
import type { Node } from '../src/types';

function extract(source: string, filePath = 'Assets/Scripts/Player.cs'): FrameworkExtractionResult {
  return unityResolver.extract!(filePath, source);
}

function nodeNames(result: FrameworkExtractionResult): string[] {
  return result.nodes.map((n) => n.name).sort();
}

function refPairs(result: FrameworkExtractionResult): string[] {
  return result.references.map((r) => `${r.referenceKind}:${r.referenceName}`).sort();
}

function makeContext(overrides: Partial<ResolutionContext> = {}): ResolutionContext {
  return {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: () => false,
    readFile: () => null,
    getProjectRoot: () => '/project',
    getAllFiles: () => [],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
    ...overrides,
  };
}

function makeSymbol(
  fields: Pick<Node, 'id' | 'kind' | 'name' | 'filePath' | 'startLine' | 'endLine'>
): Node {
  return {
    qualifiedName: `${fields.filePath}::${fields.name}`,
    language: 'csharp',
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
    ...fields,
  };
}

function makeRef(fields: Partial<UnresolvedRef> & Pick<UnresolvedRef, 'referenceName'>): UnresolvedRef {
  return {
    fromNodeId: 'route:unity:test:1',
    referenceKind: 'references',
    line: 1,
    column: 0,
    filePath: 'Assets/Scripts/Player.cs',
    language: 'csharp',
    ...fields,
  };
}

describe('Unity Framework Resolver', () => {
  it('is registered in the framework resolver registry', () => {
    expect(getFrameworkResolver('unity')).toBe(unityResolver);
  });

  describe('extract() — host bases and lifecycle surfaces', () => {
    it('emits MonoBehaviour lifecycle methods and ignores helpers', () => {
      const result = extract(`
using UnityEngine;

class Player : MonoBehaviour
{
    void Awake() {}
    void Start() {}
    void Update() {}
    void FixedUpdate() {}
    void OnTriggerEnter2D(Collider2D other) {}
    void OnApplicationPause(bool paused) {}
    void OnDrawGizmosSelected() {}
    void TickInternal() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY MonoBehaviour.Awake Player.Awake',
          'UNITY MonoBehaviour.FixedUpdate Player.FixedUpdate',
          'UNITY MonoBehaviour.OnApplicationPause Player.OnApplicationPause',
          'UNITY MonoBehaviour.OnDrawGizmosSelected Player.OnDrawGizmosSelected',
          'UNITY MonoBehaviour.OnTriggerEnter2D Player.OnTriggerEnter2D',
          'UNITY MonoBehaviour.Start Player.Start',
          'UNITY MonoBehaviour.Update Player.Update',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:unity:host:Player.Awake',
          'references:unity:host:Player.FixedUpdate',
          'references:unity:host:Player.OnApplicationPause',
          'references:unity:host:Player.OnDrawGizmosSelected',
          'references:unity:host:Player.OnTriggerEnter2D',
          'references:unity:host:Player.Start',
          'references:unity:host:Player.Update',
        ].sort()
      );
    });

    it('emits nothing for magic names on non-host classes', () => {
      const result = extract(`
class PlainService
{
    void Start() {}
    void Update() {}
    void OnEnable() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('supports qualified and same-file aliased Unity bases', () => {
      const result = extract(`
using UE = UnityEngine;
using MB = UnityEngine.MonoBehaviour;

class Qualified : UnityEngine.MonoBehaviour { void Update() {} }
class NamespaceAlias : UE.MonoBehaviour { void Start() {} }
class TypeAlias : MB { void OnEnable() {} }
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY MonoBehaviour.OnEnable TypeAlias.OnEnable',
          'UNITY MonoBehaviour.Start NamespaceAlias.Start',
          'UNITY MonoBehaviour.Update Qualified.Update',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:unity:host:NamespaceAlias.Start',
          'references:unity:host:Qualified.Update',
          'references:unity:host:TypeAlias.OnEnable',
        ].sort()
      );
    });

    it('supports same-file base chains but not cross-file base chains', () => {
      const sameFile = extract(`
using UnityEngine;

class BaseBehaviour : MonoBehaviour {}
class Player : BaseBehaviour
{
    void Update() {}
}
`);
      expect(nodeNames(sameFile)).toEqual(['UNITY MonoBehaviour.Update Player.Update']);
      expect(refPairs(sameFile)).toEqual(['references:unity:host:Player.Update']);

      const crossFile = extract(`
class Player : BaseBehaviour
{
    void Update() {}
}
`);
      expect(crossFile).toEqual({ nodes: [], references: [] });
    });

    it('classifies members of a base-less sibling partial block via the merged type (SHOULD-FIX 1, round 4)', () => {
      // The two blocks are ONE compiler type (same name, same namespace, both partial); the base-less
      // block's Update() belongs to the MonoBehaviour-derived Player and must be live. The old
      // behavior lost it by classifying each block only from its own bases.
      const result = extract(`
using UnityEngine;

partial class Player : MonoBehaviour
{
}

partial class Player
{
    void Update() {}
}
`);
      expect(nodeNames(result)).toEqual(['UNITY MonoBehaviour.Update Player.Update']);
      expect(refPairs(result)).toEqual(['references:unity:host:Player.Update']);
    });

    it('emits ScriptableObject lifecycle and CreateAssetMenu class liveness', () => {
      const result = extract(`
using UnityEngine;

[CreateAssetMenu(menuName = "Items/Sword")]
class ItemConfig : ScriptableObject
{
    void Awake() {}
    void OnEnable() {}
    void OnDisable() {}
    void OnDestroy() {}
    void OnValidate() {}
    void Reset() {}
    void Helper() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY ScriptableObject.Awake ItemConfig.Awake',
          'UNITY ScriptableObject.OnDestroy ItemConfig.OnDestroy',
          'UNITY ScriptableObject.OnDisable ItemConfig.OnDisable',
          'UNITY ScriptableObject.OnEnable ItemConfig.OnEnable',
          'UNITY ScriptableObject.OnValidate ItemConfig.OnValidate',
          'UNITY ScriptableObject.Reset ItemConfig.Reset',
          'UNITY attribute CreateAssetMenu ItemConfig',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:ItemConfig',
          'references:unity:host:ItemConfig.Awake',
          'references:unity:host:ItemConfig.OnDestroy',
          'references:unity:host:ItemConfig.OnDisable',
          'references:unity:host:ItemConfig.OnEnable',
          'references:unity:host:ItemConfig.OnValidate',
          'references:unity:host:ItemConfig.Reset',
        ].sort()
      );
    });

    it('emits StateMachineBehaviour callbacks and lifecycle rows', () => {
      const result = extract(`
using UnityEngine;

class AttackState : StateMachineBehaviour
{
    void Awake() {}
    void OnStateEnter() {}
    void OnStateUpdate() {}
    void OnStateExit() {}
    void OnStateMachineEnter() {}
    void Evaluate() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY StateMachineBehaviour.Awake AttackState.Awake',
          'UNITY StateMachineBehaviour.OnStateEnter AttackState.OnStateEnter',
          'UNITY StateMachineBehaviour.OnStateExit AttackState.OnStateExit',
          'UNITY StateMachineBehaviour.OnStateMachineEnter AttackState.OnStateMachineEnter',
          'UNITY StateMachineBehaviour.OnStateUpdate AttackState.OnStateUpdate',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:unity:host:AttackState.Awake',
          'references:unity:host:AttackState.OnStateEnter',
          'references:unity:host:AttackState.OnStateExit',
          'references:unity:host:AttackState.OnStateMachineEnter',
          'references:unity:host:AttackState.OnStateUpdate',
        ].sort()
      );
    });

    it('emits Editor callbacks and CustomEditor type refs', () => {
      const result = extract(`
using UnityEditor;

[CustomEditor(typeof(Player))]
class PlayerEditor : Editor
{
    void OnInspectorGUI() {}
    void CreateInspectorGUI() {}
    void OnSceneGUI() {}
    void HasPreviewGUI() {}
    void OnPreviewGUI() {}
    void RequiresConstantRepaint() {}
    void DrawHealth() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY Editor.CreateInspectorGUI PlayerEditor.CreateInspectorGUI',
          'UNITY Editor.HasPreviewGUI PlayerEditor.HasPreviewGUI',
          'UNITY Editor.OnInspectorGUI PlayerEditor.OnInspectorGUI',
          'UNITY Editor.OnPreviewGUI PlayerEditor.OnPreviewGUI',
          'UNITY Editor.OnSceneGUI PlayerEditor.OnSceneGUI',
          'UNITY Editor.RequiresConstantRepaint PlayerEditor.RequiresConstantRepaint',
          'UNITY type-ref CustomEditor PlayerEditor',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:Player',
          'references:unity:host:PlayerEditor.CreateInspectorGUI',
          'references:unity:host:PlayerEditor.HasPreviewGUI',
          'references:unity:host:PlayerEditor.OnInspectorGUI',
          'references:unity:host:PlayerEditor.OnPreviewGUI',
          'references:unity:host:PlayerEditor.OnSceneGUI',
          'references:unity:host:PlayerEditor.RequiresConstantRepaint',
        ].sort()
      );
    });

    it('emits EditorWindow callbacks but not quarantined ShowButton', () => {
      const result = extract(`
using UnityEditor;

class ToolsWindow : EditorWindow
{
    void OnGUI() {}
    void CreateGUI() {}
    void Update() {}
    void OnSelectionChange() {}
    void OnProjectChange() {}
    void OnBecameVisible() {}
    void OnBecameInvisible() {}
    void ShowButton() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY EditorWindow.CreateGUI ToolsWindow.CreateGUI',
          'UNITY EditorWindow.OnBecameInvisible ToolsWindow.OnBecameInvisible',
          'UNITY EditorWindow.OnBecameVisible ToolsWindow.OnBecameVisible',
          'UNITY EditorWindow.OnGUI ToolsWindow.OnGUI',
          'UNITY EditorWindow.OnProjectChange ToolsWindow.OnProjectChange',
          'UNITY EditorWindow.OnSelectionChange ToolsWindow.OnSelectionChange',
          'UNITY EditorWindow.Update ToolsWindow.Update',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:unity:host:ToolsWindow.CreateGUI',
          'references:unity:host:ToolsWindow.OnBecameInvisible',
          'references:unity:host:ToolsWindow.OnBecameVisible',
          'references:unity:host:ToolsWindow.OnGUI',
          'references:unity:host:ToolsWindow.OnProjectChange',
          'references:unity:host:ToolsWindow.OnSelectionChange',
          'references:unity:host:ToolsWindow.Update',
        ].sort()
      );
    });

    it('emits PropertyDrawer and DecoratorDrawer callbacks', () => {
      const result = extract(`
using UnityEditor;

[CustomPropertyDrawer(typeof(MyAttribute))]
class MyDrawer : PropertyDrawer
{
    void OnGUI() {}
    void GetPropertyHeight() {}
    void CreatePropertyGUI() {}
}

class HeaderDecorator : DecoratorDrawer
{
    void OnGUI() {}
    void GetHeight() {}
    void CreatePropertyGUI() {}
    void Helper() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY DecoratorDrawer.CreatePropertyGUI HeaderDecorator.CreatePropertyGUI',
          'UNITY DecoratorDrawer.GetHeight HeaderDecorator.GetHeight',
          'UNITY DecoratorDrawer.OnGUI HeaderDecorator.OnGUI',
          'UNITY PropertyDrawer.CreatePropertyGUI MyDrawer.CreatePropertyGUI',
          'UNITY PropertyDrawer.GetPropertyHeight MyDrawer.GetPropertyHeight',
          'UNITY PropertyDrawer.OnGUI MyDrawer.OnGUI',
          'UNITY type-ref CustomPropertyDrawer MyDrawer',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:MyAttribute',
          'references:unity:host:HeaderDecorator.CreatePropertyGUI',
          'references:unity:host:HeaderDecorator.GetHeight',
          'references:unity:host:HeaderDecorator.OnGUI',
          'references:unity:host:MyDrawer.CreatePropertyGUI',
          'references:unity:host:MyDrawer.GetPropertyHeight',
          'references:unity:host:MyDrawer.OnGUI',
        ].sort()
      );
    });

    it('emits AssetPostprocessor closed-set callbacks only', () => {
      const result = extract(`
using UnityEditor;

class ImportHooks : AssetPostprocessor
{
    void OnPreprocessAsset() {}
    void OnPreprocessTexture() {}
    void OnPostprocessTexture() {}
    void OnPreprocessModel() {}
    void OnPostprocessModel() {}
    void OnPostprocessAllAssets() {}
    void GetPostprocessOrder() {}
    void GetVersion() {}
    void OnPostprocessBanana() {}
    void NormalizeName() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY AssetPostprocessor.GetPostprocessOrder ImportHooks.GetPostprocessOrder',
          'UNITY AssetPostprocessor.GetVersion ImportHooks.GetVersion',
          'UNITY AssetPostprocessor.OnPostprocessAllAssets ImportHooks.OnPostprocessAllAssets',
          'UNITY AssetPostprocessor.OnPostprocessModel ImportHooks.OnPostprocessModel',
          'UNITY AssetPostprocessor.OnPostprocessTexture ImportHooks.OnPostprocessTexture',
          'UNITY AssetPostprocessor.OnPreprocessAsset ImportHooks.OnPreprocessAsset',
          'UNITY AssetPostprocessor.OnPreprocessModel ImportHooks.OnPreprocessModel',
          'UNITY AssetPostprocessor.OnPreprocessTexture ImportHooks.OnPreprocessTexture',
        ].sort()
      );
    });

    it('emits static AssetModificationProcessor hooks only', () => {
      const result = extract(`
using UnityEditor;

class AssetSaveHooks : AssetModificationProcessor
{
    static void CanOpenForEdit() {}
    static void FileModeChanged() {}
    static void IsOpenForEdit() {}
    static void MakeEditable() {}
    static void OnWillCreateAsset() {}
    static void OnWillDeleteAsset() {}
    static void OnWillMoveAsset() {}
    static void OnWillSaveAssets() {}
    void OnWillSaveAssets(string[] paths) {}
    static void NormalizePath() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY AssetModificationProcessor.CanOpenForEdit AssetSaveHooks.CanOpenForEdit',
          'UNITY AssetModificationProcessor.FileModeChanged AssetSaveHooks.FileModeChanged',
          'UNITY AssetModificationProcessor.IsOpenForEdit AssetSaveHooks.IsOpenForEdit',
          'UNITY AssetModificationProcessor.MakeEditable AssetSaveHooks.MakeEditable',
          'UNITY AssetModificationProcessor.OnWillCreateAsset AssetSaveHooks.OnWillCreateAsset',
          'UNITY AssetModificationProcessor.OnWillDeleteAsset AssetSaveHooks.OnWillDeleteAsset',
          'UNITY AssetModificationProcessor.OnWillMoveAsset AssetSaveHooks.OnWillMoveAsset',
          'UNITY AssetModificationProcessor.OnWillSaveAssets AssetSaveHooks.OnWillSaveAssets',
        ].sort()
      );
    });
  });

  describe('extract() — fields, attributes, strings, and false-positive traps', () => {
    it('emits SerializeField and SerializeReference field liveness with local type refs only', () => {
      const result = extract(`
using UnityEngine;

class Player : MonoBehaviour
{
    [SerializeField] private WeaponConfig weapon;
    [SerializeReference] private IBehavior behavior;
    [SerializeField] private int health;
    [SerializeField] private UnityEngine.GameObject prefab;
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY serialized field Player.behavior',
          'UNITY serialized field Player.health',
          'UNITY serialized field Player.prefab',
          'UNITY serialized field Player.weapon',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:IBehavior',
          'references:WeaponConfig',
          'references:unity:field:Player.behavior',
          'references:unity:field:Player.health',
          'references:unity:field:Player.prefab',
          'references:unity:field:Player.weapon',
        ].sort()
      );
    });

    it('emits a [SerializeField] field with a BRACE object initializer (Tier-1, BLOCKING 3)', () => {
      const result = extract(`
using UnityEngine;

class Player : MonoBehaviour
{
    [SerializeField] PlayerData data = new PlayerData { Health = 100 };
}
`);
      expect(nodeNames(result)).toEqual(['UNITY serialized field Player.data']);
      expect(refPairs(result)).toEqual(
        ['references:PlayerData', 'references:unity:field:Player.data'].sort()
      );
    });

    it('emits a [SerializeField] field with a GENERIC constructor initializer (Tier-1, BLOCKING 4)', () => {
      const result = extract(`
using UnityEngine;
using System.Collections.Generic;

class Player : MonoBehaviour
{
    [SerializeField] Dictionary<int,string> lookup = new Dictionary<int,string>();
}
`);
      expect(nodeNames(result)).toEqual(['UNITY serialized field Player.lookup']);
      expect(refPairs(result)).toEqual(['references:unity:field:Player.lookup']);
    });

    it('emits nothing for a CONST [SerializeField] field (Unity does not serialize consts; BLOCKING 3)', () => {
      const result = extract(`
using UnityEngine;

class Player : MonoBehaviour
{
    [SerializeField] const int health = 100;
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits field-target SerializeField on auto-properties as property liveness', () => {
      const result = extract(`
using UnityEngine;

class Player : MonoBehaviour
{
    [field: SerializeField] public WeaponConfig Weapon { get; private set; }
}
`);
      expect(nodeNames(result)).toEqual(['UNITY serialized property Player.Weapon']);
      expect(refPairs(result)).toEqual(
        ['references:WeaponConfig', 'references:unity:field:Player.Weapon'].sort()
      );
    });

    it('emits method and class attribute entry points with static/instance enforcement', () => {
      const result = extract(`
using UnityEngine;
using UnityEditor;
using UnityEditor.Callbacks;

[InitializeOnLoad]
class EditorBootstrap { static EditorBootstrap() {} }

[AddComponentMenu("Gameplay/Player")]
class Player : MonoBehaviour
{
    [RuntimeInitializeOnLoadMethod] static void Boot() {}
    [InitializeOnLoadMethod] static void EditorBoot() {}
    [MenuItem("Tools/Rebuild")] static void Rebuild() {}
    [MenuItem("Tools/Rebuild", true)] static bool ValidateRebuild() { return true; }
    [ContextMenu("Reset Stats")] void ResetStats() {}
    [PostProcessBuild] static void OnBuild() {}
    [PostProcessScene] static void OnScene() {}
    [DidReloadScripts] static void Reloaded() {}
    [OnOpenAsset] static bool OpenAsset() { return false; }

    [MenuItem("Tools/Bad")] void BadMenu() {}
    [ContextMenu("Bad Static")] static void BadContext() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY attribute AddComponentMenu Player',
          'UNITY attribute ContextMenu Player.ResetStats',
          'UNITY attribute DidReloadScripts Player.Reloaded',
          'UNITY attribute InitializeOnLoad EditorBootstrap',
          'UNITY attribute InitializeOnLoadMethod Player.EditorBoot',
          'UNITY attribute MenuItem Player.Rebuild',
          'UNITY attribute MenuItem Player.ValidateRebuild',
          'UNITY attribute OnOpenAsset Player.OpenAsset',
          'UNITY attribute PostProcessBuild Player.OnBuild',
          'UNITY attribute PostProcessScene Player.OnScene',
          'UNITY attribute RuntimeInitializeOnLoadMethod Player.Boot',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:EditorBootstrap',
          'references:Player',
          'references:unity:method:Player.Boot',
          'references:unity:method:Player.EditorBoot',
          'references:unity:method:Player.OnBuild',
          'references:unity:method:Player.OnScene',
          'references:unity:method:Player.OpenAsset',
          'references:unity:method:Player.Rebuild',
          'references:unity:method:Player.Reloaded',
          'references:unity:method:Player.ResetStats',
          'references:unity:method:Player.ValidateRebuild',
        ].sort()
      );
    });

    it('emits type-reference attributes and DrawGizmo entry point', () => {
      const result = extract(`
using UnityEngine;
using UnityEditor;

[RequireComponent(typeof(HealthComponent), typeof(UnityEngine.Rigidbody))]
class Player : MonoBehaviour
{
    [DrawGizmo(GizmoType.Selected, typeof(PlayerGizmoTarget))]
    static void Draw(Player p, GizmoType g) {}
}

[CustomEditor(typeof(Player))]
class PlayerEditor : Editor {}

[CustomPropertyDrawer(typeof(MyAttribute), true)]
class MyDrawer : PropertyDrawer {}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY attribute DrawGizmo Player.Draw',
          'UNITY type-ref CustomEditor PlayerEditor',
          'UNITY type-ref CustomPropertyDrawer MyDrawer',
          'UNITY type-ref RequireComponent Player',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:HealthComponent',
          'references:MyAttribute',
          'references:Player',
          'references:PlayerGizmoTarget',
          'references:unity:method:Player.Draw',
        ].sort()
      );
    });

    it('links string-invoked methods only for unique same-class literal or bare nameof targets', () => {
      const result = extract(`
using UnityEngine;
using System.Collections;

class Player : MonoBehaviour
{
    void Start()
    {
        Invoke("Explode", 1f);
        InvokeRepeating(nameof(Tick), 1f, 1f);
        IsInvoking("Tick");
        StartCoroutine("Blink");
        StopCoroutine("Blink");
        CancelInvoke("Tick");
        Invoke(nameof(Player.Tick), 1f);
        Invoke("Ex" + "plode", 1f);
        Invoke($"Explode", 1f);
        Invoke(methodName, 1f);
        Invoke("", 1f);
    }

    void Explode() {}
    void Tick() {}
    IEnumerator Blink() { yield break; }
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY MonoBehaviour.Start Player.Start',
          'UNITY string-invoke Invoke Player.Explode',
          'UNITY string-invoke Invoke Player.Tick',
          'UNITY string-invoke StartCoroutine Player.Blink',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:unity:host:Player.Start',
          'references:unity:method:Player.Blink',
          'references:unity:method:Player.Explode',
          'references:unity:method:Player.Tick',
        ].sort()
      );
    });

    it('emits nothing for string-invoked overload ambiguity', () => {
      const result = extract(`
using UnityEngine;

class Player : MonoBehaviour
{
    void Start() { Invoke("Explode", 1f); }
    void Explode() {}
    void Explode(int amount) {}
}
`);
      expect(nodeNames(result)).toEqual(['UNITY MonoBehaviour.Start Player.Start']);
      expect(refPairs(result)).toEqual(['references:unity:host:Player.Start']);
    });

    it('counts expression-bodied siblings when checking string-invoked overload ambiguity', () => {
      const result = extract(`
using UnityEngine;

class Player : MonoBehaviour
{
    void Start() { Invoke("Explode", 1f); }
    void Explode() {}
    void Explode(int amount) => Apply(amount);
    void Apply(int amount) {}
}
`);
      expect(nodeNames(result)).toEqual(['UNITY MonoBehaviour.Start Player.Start']);
      expect(refPairs(result)).toEqual(['references:unity:host:Player.Start']);
    });

    it('guards SendMessage receivers and project-wide name linking', () => {
      const result = extract(`
using UnityEngine;

class Player : MonoBehaviour
{
    void Start()
    {
        SendMessage("ApplyDamage");
        this.BroadcastMessage("ApplyDamage");
        gameObject.SendMessageUpwards("ApplyDamage");
        other.SendMessage("ApplyDamage");
    }

    void ApplyDamage() {}
}

class Enemy : MonoBehaviour
{
    void ApplyDamage() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY MonoBehaviour.Start Player.Start',
          'UNITY string-invoke SendMessage Player.ApplyDamage',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:unity:host:Player.Start',
          'references:unity:method:Player.ApplyDamage',
        ].sort()
      );
    });

    it('emits nothing for string-invoked member-access chains that are not self receivers', () => {
      const result = extract(`
using UnityEngine;

class Player : MonoBehaviour
{
    void OnCollisionEnter(Collision collision)
    {
        collision.gameObject.SendMessage("ApplyDamage");
        other?.SendMessage("ApplyDamage");
        GetTimer().Invoke("Explode");
        enemy.gameObject.SendMessage("ApplyDamage");
        gameObject.SendMessage("ApplyDamage");
    }

    Timer GetTimer() { return null; }
    void ApplyDamage() {}
    void Explode() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY MonoBehaviour.OnCollisionEnter Player.OnCollisionEnter',
          'UNITY string-invoke SendMessage Player.ApplyDamage',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:unity:host:Player.OnCollisionEnter',
          'references:unity:method:Player.ApplyDamage',
        ].sort()
      );
    });

    it('links ContextMenuItem to a unique same-class method', () => {
      const result = extract(`
using UnityEngine;

class Player : MonoBehaviour
{
    [ContextMenuItem("Reset", "ResetBiography")]
    [SerializeField] string bio;

    void ResetBiography() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY serialized field Player.bio',
          'UNITY string-invoke ContextMenuItem Player.ResetBiography',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:unity:field:Player.bio',
          'references:unity:method:Player.ResetBiography',
        ].sort()
      );
    });

    it('does not parse serialized fields or properties from string literals', () => {
      const result = extract(`
using UnityEngine;

class Player : MonoBehaviour
{
    const string template = "[SerializeField] private int fake;";
    const string propTemplate = "[field: SerializeField] public int Fake { get; set; }";

    [ContextMenuItem("Reset", "ResetBiography")]
    [SerializeField] string bio;

    void ResetBiography() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY serialized field Player.bio',
          'UNITY string-invoke ContextMenuItem Player.ResetBiography',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:unity:field:Player.bio',
          'references:unity:method:Player.ResetBiography',
        ].sort()
      );
    });

    it('emits nothing for deferred package/test attributes and substring attribute matches', () => {
      const result = extract(`
using System;
using UnityEngine;

class TestAttribute : Attribute {}
class MenuItemCustomAttribute : Attribute {}

class NetworkThing : MonoBehaviour
{
    [ServerRpc] void ServerMove() {}
    [ClientRpc] void ClientMove() {}
    [Rpc] void RpcMove() {}
    [Command] void CommandMove() {}
    [TargetRpc] void TargetMove() {}
    [UnityTest] void UnityCase() {}
    [Test] void LooksLikeNUnit() {}
    [MenuItemCustom] static void NotMenuItem() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('does not match bases in generic arguments, comments, strings, local functions, or properties', () => {
      const result = extract(`
using UnityEngine;

// class Commented : MonoBehaviour { void Update() {} }
class Handler<T> {}
class GenericOnly : Handler<MonoBehaviour>
{
    void Update() {}
}

class Plain
{
    string text = "class Fake : MonoBehaviour { void Start() {} }";
}

class Player : MonoBehaviour
{
    public bool Update { get; }

    void Start()
    {
        void OnEnable() {}
    }

    class NestedPlain
    {
        void Update() {}
    }
}
`);
      expect(nodeNames(result)).toEqual(['UNITY MonoBehaviour.Start Player.Start']);
      expect(refPairs(result)).toEqual(['references:unity:host:Player.Start']);
    });
  });

  describe('extract() — FishNet networking (Tier 2, gated)', () => {
    it('emits NetworkBehaviour callbacks and MonoBehaviour-message union when the FishNet gate is open', () => {
      const result = extract(`
using FishNet.Object;

class Player : NetworkBehaviour
{
    public override void OnStartNetwork() {}
    public override void OnStartServer() {}
    public override void OnStopClient() {}
    void Update() {}
    void Helper() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY NetworkBehaviour.OnStartNetwork Player.OnStartNetwork',
          'UNITY NetworkBehaviour.OnStartServer Player.OnStartServer',
          'UNITY NetworkBehaviour.OnStopClient Player.OnStopClient',
          'UNITY NetworkBehaviour.Update Player.Update',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:unity:host:Player.OnStartNetwork',
          'references:unity:host:Player.OnStartServer',
          'references:unity:host:Player.OnStopClient',
          'references:unity:host:Player.Update',
        ].sort()
      );
    });

    it('emits nothing for a NetworkBehaviour class with no FishNet using', () => {
      const result = extract(`
class Player : NetworkBehaviour
{
    public override void OnStartServer() {}
    void Update() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing when the competing Unity.Netcode stack is present instead', () => {
      const result = extract(`
using Unity.Netcode;

class Player : NetworkBehaviour
{
    public override void OnStartServer() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing when both FishNet and a competing stack are imported (collision guard)', () => {
      const netcode = extract(`
using FishNet.Object;
using Unity.Netcode;

class Player : NetworkBehaviour
{
    public override void OnStartServer() {}
}
`);
      expect(netcode).toEqual({ nodes: [], references: [] });

      const mirror = extract(`
using FishNet.Object;
using Mirror;

class Player : NetworkBehaviour
{
    public override void OnStartServer() {}
}
`);
      expect(mirror).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing for a FOREIGN-qualified [Other.ServerRpc] under an open FishNet gate (BLOCKING 3)', () => {
      const result = extract(`
using FishNet.Object;

class Player : NetworkBehaviour
{
    [Other.ServerRpc] void CmdMove() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits a ServerRpc entry point for an OWNING-qualified [FishNet.Object.ServerRpc] (BLOCKING 3)', () => {
      const result = extract(`
using FishNet.Object;

class Player : NetworkBehaviour
{
    [FishNet.Object.ServerRpc] void CmdMove() {}
}
`);
      expect(nodeNames(result)).toEqual(['UNITY attribute ServerRpc Player.CmdMove']);
      expect(refPairs(result)).toEqual(['references:unity:method:Player.CmdMove']);
    });

    it('emits nothing for a GATE-PREFIX-qualified [FishNet.ServerRpc] — attrs live in FishNet.Object (BLOCKING 2 r3)', () => {
      // `FishNet` is the gate namespace; FishNet's RPC attributes live in `FishNet.Object`. A
      // `[FishNet.ServerRpc]` is a custom `FishNet.ServerRpcAttribute`, not the framework's, so it
      // must not emit even with the gate open.
      const result = extract(`
using FishNet.Object;

class Player : NetworkBehaviour
{
    [FishNet.ServerRpc] void CmdMove() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing for a DESCENDANT-qualified [FishNet.Whatever.ServerRpc] (exact qualifier only, BLOCKING 2 r2)', () => {
      const result = extract(`
using FishNet.Object;

class Player : NetworkBehaviour
{
    [FishNet.Whatever.ServerRpc] void CmdMove() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing for a foreign attribute ALIAS shadowing the bare [ServerRpc] token (BLOCKING 2 r2)', () => {
      const result = extract(`
using FishNet.Object;
using ServerRpc = Other.ServerRpcAttribute;

class Player : NetworkBehaviour
{
    [ServerRpc] void CmdMove() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits RPC and prediction attribute entry points on a NetworkBehaviour-based class', () => {
      const result = extract(`
using FishNet.Object;

class Player : NetworkBehaviour
{
    [ServerRpc] void CmdMove() {}
    [ObserversRpc] void RpcMove() {}
    [TargetRpc] void TargetMove() {}
    [Replicate] void Move() {}
    [Reconcile] void Recon() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY attribute ObserversRpc Player.RpcMove',
          'UNITY attribute Reconcile Player.Recon',
          'UNITY attribute Replicate Player.Move',
          'UNITY attribute ServerRpc Player.CmdMove',
          'UNITY attribute TargetRpc Player.TargetMove',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:unity:method:Player.CmdMove',
          'references:unity:method:Player.Move',
          'references:unity:method:Player.Recon',
          'references:unity:method:Player.RpcMove',
          'references:unity:method:Player.TargetMove',
        ].sort()
      );
    });

    it('emits nothing for RPC attributes on a non-NetworkBehaviour class', () => {
      const result = extract(`
using FishNet.Object;

class PlainHelper
{
    [ServerRpc] void CmdMove() {}
    [Replicate] void Move() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing for the Server/Client guard attributes', () => {
      const result = extract(`
using FishNet.Object;

class Player : NetworkBehaviour
{
    [Server] void ServerOnly() {}
    [Client] void ClientOnly() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('follows same-file NetworkBehaviour chains but not cross-file chains', () => {
      const sameFile = extract(`
using FishNet.Object;

class BaseNet : NetworkBehaviour {}
class Child : BaseNet
{
    public override void OnStartServer() {}
    [ServerRpc] void CmdMove() {}
}
`);
      expect(nodeNames(sameFile)).toEqual(
        [
          'UNITY NetworkBehaviour.OnStartServer Child.OnStartServer',
          'UNITY attribute ServerRpc Child.CmdMove',
        ].sort()
      );
      expect(refPairs(sameFile)).toEqual(
        [
          'references:unity:host:Child.OnStartServer',
          'references:unity:method:Child.CmdMove',
        ].sort()
      );

      const crossFile = extract(`
using FishNet.Object;

class Child : BaseNet
{
    public override void OnStartServer() {}
    [ServerRpc] void CmdMove() {}
}
`);
      expect(crossFile).toEqual({ nodes: [], references: [] });
    });

    it('opens the gate on a fully-qualified FishNet.Object.NetworkBehaviour base without a using', () => {
      const result = extract(`
class Player : FishNet.Object.NetworkBehaviour
{
    public override void OnStartServer() {}
    [ServerRpc] void CmdMove() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY NetworkBehaviour.OnStartServer Player.OnStartServer',
          'UNITY attribute ServerRpc Player.CmdMove',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:unity:host:Player.OnStartServer',
          'references:unity:method:Player.CmdMove',
        ].sort()
      );
    });

    // --- Phase 0 characterization: pins current gate behavior before the generic refactor ---

    it('closes the gate when a FQ FishNet base is combined with a competing Mirror using (characterization: exclusion wins over FQ evidence)', () => {
      const result = extract(`
using Mirror;

class Player : FishNet.Object.NetworkBehaviour
{
    public override void OnStartServer() {}
    [ServerRpc] void CmdMove() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('opens only on a real FishNet namespace segment, not a longer identifier (characterization: prefix boundary)', () => {
      const notFishNet = extract(`
using FishNetX;

class Player : NetworkBehaviour
{
    public override void OnStartServer() {}
}
`);
      expect(notFishNet).toEqual({ nodes: [], references: [] });

      const subNamespace = extract(`
using FishNet.Managing;

class Player : NetworkBehaviour
{
    public override void OnStartServer() {}
}
`);
      expect(nodeNames(subNamespace)).toEqual(['UNITY NetworkBehaviour.OnStartServer Player.OnStartServer']);
      expect(refPairs(subNamespace)).toEqual(['references:unity:host:Player.OnStartServer']);
    });
  });

  describe('extract() — gate hardening (F1–F4)', () => {
    it('F1: closes the FishNet gate when Photon Fusion is imported alongside FishNet', () => {
      const result = extract(`
using FishNet.Managing;
using Fusion;

class Player : NetworkBehaviour
{
    public override void OnStartServer() {}
    void Update() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('F2: a fully-qualified FishNet base token as a field TYPE does not open the gate', () => {
      const result = extract(`
class Holder
{
    FishNet.Object.NetworkBehaviour reference;
}

class Other : NetworkBehaviour
{
    public override void OnStartServer() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('F2: a fully-qualified FishNet base token in a real base clause still opens the gate', () => {
      const result = extract(`
class Player : FishNet.Object.NetworkBehaviour
{
    public override void OnStartServer() {}
}
`);
      expect(nodeNames(result)).toEqual(['UNITY NetworkBehaviour.OnStartServer Player.OnStartServer']);
      expect(refPairs(result)).toEqual(['references:unity:host:Player.OnStartServer']);
    });

    it('F3: a required-prefix using-ALIAS directive is not gate evidence', () => {
      const result = extract(`
using FishNet = Some.Other.Namespace;

class Player : NetworkBehaviour
{
    public override void OnStartServer() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('F3: a disqualifier-prefix using-ALIAS directive does not close the gate', () => {
      const result = extract(`
using FishNet.Object;
using Mirror = Some.Other.Namespace;

class Player : NetworkBehaviour
{
    public override void OnStartServer() {}
}
`);
      expect(nodeNames(result)).toEqual(['UNITY NetworkBehaviour.OnStartServer Player.OnStartServer']);
      expect(refPairs(result)).toEqual(['references:unity:host:Player.OnStartServer']);
    });

    it('F4: parsed stack host-base rules carry only object rules with a method list (no doc keys)', () => {
      expect(__gatedStacksForTest.length).toBeGreaterThan(0);
      for (const stack of __gatedStacksForTest) {
        expect(stack.hostBases.has('note')).toBe(false);
        expect(stack.hostBases.has('detection')).toBe(false);
        for (const base of stack.hostBases) {
          expect(Array.isArray(stack.hostRules[base]!.hostInvokedMethods)).toBe(true);
        }
      }
      const fishnet = __gatedStacksForTest.find((s) => s.name === 'fishnet');
      expect(fishnet?.hostBases.has('NetworkBehaviour')).toBe(true);
    });
  });

  describe('extract() — Mirror networking (Tier 2, gated)', () => {
    it('registers a mirror gated stack with a NetworkBehaviour host base', () => {
      const mirror = __gatedStacksForTest.find((s) => s.name === 'mirror');
      expect(mirror).toBeDefined();
      expect(mirror?.hostBases.has('NetworkBehaviour')).toBe(true);
      expect(mirror?.syncVarAttribute).toBe('SyncVar');
      expect(mirror?.syncVarHookArg).toBe('hook');
    });

    it('emits NetworkBehaviour callbacks and MonoBehaviour-message union when the Mirror gate is open', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    public override void OnStartServer() {}
    public override void OnStopClient() {}
    public override void OnStartLocalPlayer() {}
    public override bool OnSerialize(NetworkWriter writer, bool initialState) { return true; }
    protected override void SerializeSyncVars(NetworkWriter writer, bool initialState) {}
    void Update() {}
    void Helper() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY NetworkBehaviour.OnStartServer Player.OnStartServer',
          'UNITY NetworkBehaviour.OnStopClient Player.OnStopClient',
          'UNITY NetworkBehaviour.OnStartLocalPlayer Player.OnStartLocalPlayer',
          'UNITY NetworkBehaviour.OnSerialize Player.OnSerialize',
          'UNITY NetworkBehaviour.SerializeSyncVars Player.SerializeSyncVars',
          'UNITY NetworkBehaviour.Update Player.Update',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:unity:host:Player.OnStartServer',
          'references:unity:host:Player.OnStopClient',
          'references:unity:host:Player.OnStartLocalPlayer',
          'references:unity:host:Player.OnSerialize',
          'references:unity:host:Player.SerializeSyncVars',
          'references:unity:host:Player.Update',
        ].sort()
      );
    });

    it('recognizes ALL 12 Mirror NetworkBehaviour override callbacks', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    public override void OnStartServer() {}
    public override void OnStopServer() {}
    public override void OnStartClient() {}
    public override void OnStopClient() {}
    public override void OnStartLocalPlayer() {}
    public override void OnStopLocalPlayer() {}
    public override void OnStartAuthority() {}
    public override void OnStopAuthority() {}
    public override bool OnSerialize(NetworkWriter writer, bool initialState) { return true; }
    public override void OnDeserialize(NetworkReader reader, bool initialState) {}
    protected override void SerializeSyncVars(NetworkWriter writer, bool initialState) {}
    protected override void DeserializeSyncVars(NetworkReader reader, bool initialState) {}
    void NotACallback() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY NetworkBehaviour.OnStartServer Player.OnStartServer',
          'UNITY NetworkBehaviour.OnStopServer Player.OnStopServer',
          'UNITY NetworkBehaviour.OnStartClient Player.OnStartClient',
          'UNITY NetworkBehaviour.OnStopClient Player.OnStopClient',
          'UNITY NetworkBehaviour.OnStartLocalPlayer Player.OnStartLocalPlayer',
          'UNITY NetworkBehaviour.OnStopLocalPlayer Player.OnStopLocalPlayer',
          'UNITY NetworkBehaviour.OnStartAuthority Player.OnStartAuthority',
          'UNITY NetworkBehaviour.OnStopAuthority Player.OnStopAuthority',
          'UNITY NetworkBehaviour.OnSerialize Player.OnSerialize',
          'UNITY NetworkBehaviour.OnDeserialize Player.OnDeserialize',
          'UNITY NetworkBehaviour.SerializeSyncVars Player.SerializeSyncVars',
          'UNITY NetworkBehaviour.DeserializeSyncVars Player.DeserializeSyncVars',
        ].sort()
      );
    });

    it('emits nothing for a NetworkBehaviour class with no Mirror using', () => {
      const result = extract(`
class Player : NetworkBehaviour
{
    public override void OnStartServer() {}
    void Update() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing when a competing stack is imported alongside Mirror (collision guard)', () => {
      const netcode = extract(`
using Mirror;
using Unity.Netcode;

class Player : NetworkBehaviour
{
    public override void OnStartServer() {}
}
`);
      expect(netcode).toEqual({ nodes: [], references: [] });

      const fishnet = extract(`
using Mirror;
using FishNet.Object;

class Player : NetworkBehaviour
{
    public override void OnStartServer() {}
}
`);
      expect(fishnet).toEqual({ nodes: [], references: [] });

      const fusion = extract(`
using Mirror;
using Fusion;

class Player : NetworkBehaviour
{
    public override void OnStartServer() {}
}
`);
      expect(fusion).toEqual({ nodes: [], references: [] });
    });

    it('emits Command / ClientRpc / TargetRpc entry points on a NetworkBehaviour-based class', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [Command] void CmdMove() {}
    [ClientRpc] void RpcMove() {}
    [TargetRpc] void TargetMove() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY attribute ClientRpc Player.RpcMove',
          'UNITY attribute Command Player.CmdMove',
          'UNITY attribute TargetRpc Player.TargetMove',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:unity:method:Player.CmdMove',
          'references:unity:method:Player.RpcMove',
          'references:unity:method:Player.TargetMove',
        ].sort()
      );
    });

    it('emits nothing for Mirror RPC attributes on a non-NetworkBehaviour class', () => {
      const result = extract(`
using Mirror;

class PlainHelper
{
    [Command] void CmdMove() {}
    [ClientRpc] void RpcMove() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    // --- attribute-name qualification (BLOCKING 3) ---

    it('emits nothing for a FOREIGN-qualified [Other.Command] on a NetworkBehaviour class', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [Other.Command] void CmdMove() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits a Command entry point for an OWNING-qualified [Mirror.Command]', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [Mirror.Command] void CmdMove() {}
}
`);
      expect(nodeNames(result)).toEqual(['UNITY attribute Command Player.CmdMove']);
      expect(refPairs(result)).toEqual(['references:unity:method:Player.CmdMove']);
    });

    it('emits a Command entry point for the Attribute-suffixed [CommandAttribute]', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [CommandAttribute] void CmdMove() {}
}
`);
      expect(nodeNames(result)).toEqual(['UNITY attribute Command Player.CmdMove']);
      expect(refPairs(result)).toEqual(['references:unity:method:Player.CmdMove']);
    });

    it('emits a Command entry point for the owning-qualified + suffixed [Mirror.CommandAttribute]', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [Mirror.CommandAttribute] void CmdMove() {}
}
`);
      expect(nodeNames(result)).toEqual(['UNITY attribute Command Player.CmdMove']);
      expect(refPairs(result)).toEqual(['references:unity:method:Player.CmdMove']);
    });

    it('emits nothing for the Mirror Server/Client guard attributes', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [Server] void ServerOnly() {}
    [ServerCallback] void ServerCb() {}
    [Client] void ClientOnly() {}
    [ClientCallback] void ClientCb() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    // --- attribute provenance: exact qualifier + alias resolution (BLOCKING 2, round 2) ---

    it('emits nothing for a DESCENDANT-qualified [Mirror.Whatever.Command] (exact qualifier only)', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [Mirror.Whatever.Command] void CmdMove() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing for a DESCENDANT-qualified [Mirror.Whatever.SyncVar] field', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [Mirror.Whatever.SyncVar] int health;
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing for a foreign attribute ALIAS shadowing the bare [Command] token', () => {
      const result = extract(`
using Mirror;
using Command = Other.CommandAttribute;

class Player : NetworkBehaviour
{
    [Command] void CmdMove() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing for a foreign attribute ALIAS shadowing the bare [SyncVar] token', () => {
      const result = extract(`
using Mirror;
using SyncVar = Other.SyncVarAttribute;

class Player : NetworkBehaviour
{
    [SyncVar] int health;
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('KILLS the bare [Command] token file-wide when an alias rebinds that name, even to Mirror own (BLOCKING 2 r3)', () => {
      // Conservative KILL rule (round 3): any `using Command = …;` — regardless of target, including
      // Mirror's own attribute — makes bare `[Command]` unreliable, so it is rejected file-wide.
      // This is a deliberately accepted missed edge (a qualified `[Mirror.Command]` still emits).
      const result = extract(`
using Mirror;
using Command = Mirror.CommandAttribute;

class Player : NetworkBehaviour
{
    [Command] void CmdMove() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('still emits bare [Command] when a NON-colliding alias name is present (BLOCKING 2 r3)', () => {
      const result = extract(`
using Mirror;
using Cmd = Mirror.CommandAttribute;

class Player : NetworkBehaviour
{
    [Command] void CmdMove() {}
}
`);
      expect(nodeNames(result)).toEqual(['UNITY attribute Command Player.CmdMove']);
      expect(refPairs(result)).toEqual(['references:unity:method:Player.CmdMove']);
    });

    it('KILLS bare [Command] from a SAME-LINE alias directive (BLOCKING 2 r3)', () => {
      const result = extract(`
using Mirror; using Command = Other.CommandAttribute;

class P : NetworkBehaviour { [Command] void M() {} }
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('KILLS bare [Command] from a NAMESPACE-SCOPED alias directive, in either declaration order (BLOCKING 2 r3)', () => {
      const forward = extract(`
using Mirror;
namespace A {
    using Command = Other.CommandAttribute;
    class Victim : Mirror.NetworkBehaviour { [Command] void CmdMove() {} }
}
namespace B {
    using Command = Mirror.CommandAttribute;
}
`);
      expect(forward).toEqual({ nodes: [], references: [] });

      const reversed = extract(`
using Mirror;
namespace B {
    using Command = Mirror.CommandAttribute;
}
namespace A {
    using Command = Other.CommandAttribute;
    class Victim : Mirror.NetworkBehaviour { [Command] void CmdMove() {} }
}
`);
      expect(reversed).toEqual({ nodes: [], references: [] });
    });

    it('opens the gate on a fully-qualified Mirror.NetworkBehaviour base without a using', () => {
      const result = extract(`
class Player : Mirror.NetworkBehaviour
{
    public override void OnStartServer() {}
    [Command] void CmdMove() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY NetworkBehaviour.OnStartServer Player.OnStartServer',
          'UNITY attribute Command Player.CmdMove',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:unity:host:Player.OnStartServer',
          'references:unity:method:Player.CmdMove',
        ].sort()
      );
    });

    it('closes the gate when a FQ Mirror base is combined with a competing using (exclusion wins over FQ evidence)', () => {
      const result = extract(`
using Unity.Netcode;

class Player : Mirror.NetworkBehaviour
{
    public override void OnStartServer() {}
    [Command] void CmdMove() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('opens only on the real Mirror namespace, not a longer identifier (prefix boundary)', () => {
      const notMirror = extract(`
using MirrorX;

class Player : NetworkBehaviour
{
    public override void OnStartServer() {}
}
`);
      expect(notMirror).toEqual({ nodes: [], references: [] });
    });

    it('opens the Mirror gate on a sub-namespace using (using Mirror.Components)', () => {
      const result = extract(`
using Mirror.Components;

class Player : NetworkBehaviour
{
    public override void OnStartServer() {}
    [Command] void CmdMove() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY NetworkBehaviour.OnStartServer Player.OnStartServer',
          'UNITY attribute Command Player.CmdMove',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        ['references:unity:host:Player.OnStartServer', 'references:unity:method:Player.CmdMove'].sort()
      );
    });

    it('does not treat a Mirror using-ALIAS directive as gate evidence', () => {
      const result = extract(`
using Mirror = Some.Other.Namespace;

class Player : NetworkBehaviour
{
    public override void OnStartServer() {}
    [Command] void CmdMove() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('does not open the Mirror gate on a FQ Mirror.NetworkBehaviour token used only as a field type', () => {
      const result = extract(`
class Holder
{
    Mirror.NetworkBehaviour reference;
}

class Player : NetworkBehaviour
{
    public override void OnStartServer() {}
    [Command] void CmdMove() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('closes the Mirror gate when a FQ Mirror base is combined with using Fusion (Fusion disqualifier)', () => {
      const result = extract(`
using Fusion;

class Player : Mirror.NetworkBehaviour
{
    public override void OnStartServer() {}
    [Command] void CmdMove() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing for a STATIC [Command] under an open Mirror gate (requiresInstance)', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [Command] static void CmdMove() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('does not open the Mirror gate for a commented-out using directive', () => {
      const result = extract(`
// using Mirror;

class Player : NetworkBehaviour
{
    public override void OnStartServer() {}
    [Command] void CmdMove() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('does not double-emit for a plain MonoBehaviour class under an open Mirror gate', () => {
      const result = extract(`
using Mirror;

class Player : MonoBehaviour
{
    void Update() {}
}
`);
      expect(nodeNames(result)).toEqual(['UNITY MonoBehaviour.Update Player.Update']);
      expect(refPairs(result)).toEqual(['references:unity:host:Player.Update']);
    });

    // --- BLOCKING 1: foreign fully-qualified NetworkBehaviour bases must NOT be claimed ---

    it('emits nothing for an NGO fully-qualified NetworkBehaviour base under an open Mirror gate', () => {
      const result = extract(`
using Mirror;

class Player : Unity.Netcode.NetworkBehaviour
{
    public override void OnStartServer() {}
    [Command] void CmdMove() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing for a Photon Fusion fully-qualified NetworkBehaviour base under an open Mirror gate', () => {
      const result = extract(`
using Mirror;

class Player : Fusion.NetworkBehaviour
{
    public override void OnStartServer() {}
    [Command] void CmdMove() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing for an unrelated dotted NetworkBehaviour base whose last segment merely collides', () => {
      const result = extract(`
using Mirror;

class Player : MyStuff.NetworkBehaviour
{
    public override void OnStartServer() {}
    [Command] void CmdMove() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    // --- BLOCKING 2: FQ stack ownership propagates through same-file base chains ---

    it('does not claim a same-file FishNet-FQ-rooted chain for Mirror (Mirror gate open via using)', () => {
      const result = extract(`
using Mirror;

class ForeignBase : FishNet.Object.NetworkBehaviour {}
class Child : ForeignBase
{
    public override void OnStartServer() {}
    [Command] void CmdMove() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('does not claim a same-file Mirror-FQ-rooted chain for FishNet (FishNet gate open via using)', () => {
      const result = extract(`
using FishNet.Object;

class MirrorBase : Mirror.NetworkBehaviour {}
class Child : MirrorBase
{
    public override void OnStartServer() {}
    [ServerRpc] void CmdMove() {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('DOES apply Mirror host rules to a same-file Mirror-rooted (bare) base chain', () => {
      const result = extract(`
using Mirror;

class BaseNet : NetworkBehaviour {}
class Child : BaseNet
{
    public override void OnStartServer() {}
    [Command] void CmdMove() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY NetworkBehaviour.OnStartServer Child.OnStartServer',
          'UNITY attribute Command Child.CmdMove',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:unity:host:Child.OnStartServer',
          'references:unity:method:Child.CmdMove',
        ].sort()
      );
    });

    // --- BLOCKING 1 (round 2): namespace-blind chain propagation must not donate ownership ---

    it('does not donate Mirror ownership across a same-name collision in different namespaces', () => {
      // Two distinct `Root` types: a FishNet-rooted one (foreign) and a Mirror-rooted one. The
      // bare-name chain lookup must NOT let `Foreign.Child : Root` inherit the unrelated Mirror
      // `Local.Root` — a duplicated class name is ambiguous, so nothing may propagate through it.
      const result = extract(`
using Mirror;
namespace Foreign {
    class Root : FishNet.Object.NetworkBehaviour {}
    class Child : Root {
        public void OnStartServer() {}
        [Command] void CmdMove() {}
    }
}
namespace Local {
    class Root : NetworkBehaviour {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('still classifies each declaration of a duplicated class name from its OWN direct base', () => {
      // The ambiguity rule applies only to NAME-MAP/chain propagation. A class that is DIRECTLY
      // rooted in a Mirror base still emits its own callbacks even when its bare name is reused
      // in another namespace.
      const result = extract(`
using Mirror;
namespace A { class Widget : NetworkBehaviour { public override void OnStartServer() {} } }
namespace B { class Widget : NetworkBehaviour { public override void OnStartClient() {} } }
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY NetworkBehaviour.OnStartServer Widget.OnStartServer',
          'UNITY NetworkBehaviour.OnStartClient Widget.OnStartClient',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:unity:host:Widget.OnStartServer',
          'references:unity:host:Widget.OnStartClient',
        ].sort()
      );
    });

    it('collapses IDENTICAL members of a duplicated class name to the first declaration (SHOULD-FIX 5)', () => {
      // Node names are namespace-free by resolver-wide design, so two same-named classes whose
      // members ALSO share names collapse to one row at the first block's line. Documented bound:
      // a directly-proven second declaration with identical member names is not separately
      // represented (it is not a fabricated edge — the row is real, just deduplicated).
      const result = extract(`
using Mirror;
namespace A { class Widget : NetworkBehaviour { public void OnStartServer() {} [Command] void Cmd() {} } }
namespace B { class Widget : NetworkBehaviour { public void OnStartServer() {} [Command] void Cmd() {} } }
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY NetworkBehaviour.OnStartServer Widget.OnStartServer',
          'UNITY attribute Command Widget.Cmd',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:unity:host:Widget.OnStartServer',
          'references:unity:method:Widget.Cmd',
        ].sort()
      );
      const host = result.nodes.find((n) => n.name.includes('OnStartServer'))!;
      expect(host.startLine).toBe(3);
    });

    // --- BLOCKING 1 (round 3): only a BARE-written base may drive same-file chain propagation ---

    it('does not chain a dotted external base into an unrelated local Mirror Root', () => {
      // `Other.Root` is a type from another file/assembly. Its last segment collides with the
      // local `Local.Root : NetworkBehaviour`, but a dotted base must never be shortened into a
      // same-file chain target — `Foreign.Child : Other.Root` is not a Mirror class.
      const result = extract(`
using Mirror;
namespace Local { class Root : NetworkBehaviour {} }
namespace Foreign {
    class Child : Other.Root {
        public void OnStartServer() {}
        [Command] void CmdMove() {}
    }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('does not chain a dotted external base into an unrelated local FishNet Root', () => {
      const result = extract(`
using FishNet.Object;
namespace Local { class Root : NetworkBehaviour {} }
namespace Foreign {
    class Child : Other.Root {
        public void OnStartServer() {}
        [ServerRpc] void RpcMove() {}
    }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('still chains a bare same-file base written without a qualifier', () => {
      const result = extract(`
using Mirror;
class Root : NetworkBehaviour {}
class Child : Root {
    public void OnStartServer() {}
    [Command] void CmdMove() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY NetworkBehaviour.OnStartServer Child.OnStartServer',
          'UNITY attribute Command Child.CmdMove',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:unity:host:Child.OnStartServer',
          'references:unity:method:Child.CmdMove',
        ].sort()
      );
    });

    // --- BLOCKING 3 (round 3): the duplicate-name guard must not swallow partial / nested classes ---

    it('chains through an all-partial base type (one compiler type, not ambiguous)', () => {
      const result = extract(`
using Mirror;
partial class Root : NetworkBehaviour {}
partial class Root {}
class Child : Root {
    public void OnStartServer() {}
    [Command] void M() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY NetworkBehaviour.OnStartServer Child.OnStartServer',
          'UNITY attribute Command Child.M',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:unity:host:Child.OnStartServer',
          'references:unity:method:Child.M',
        ].sort()
      );
    });

    it('chains through a top-level base whose name is only shadowed by a nested class', () => {
      const result = extract(`
using Mirror;
class Root : NetworkBehaviour {}
class Outer { class Root {} }
class Child : Root {
    public void OnStartServer() {}
    [Command] void M() {}
}
`);
      expect(nodeNames(result)).toEqual(
        [
          'UNITY NetworkBehaviour.OnStartServer Child.OnStartServer',
          'UNITY attribute Command Child.M',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:unity:host:Child.OnStartServer',
          'references:unity:method:Child.M',
        ].sort()
      );
    });

    it('poisons the bare-name chain when a same-named struct competes in another namespace (BLOCKING 2, round 4)', () => {
      // `Plain.Child : Root` binds to `Plain.Root` (the struct), not `Networked.Root`. Our base-name
      // lookup is namespace-blind, so a same-simple-name non-class declaration must poison the chain
      // rather than donate the networked class's ownership. Emit nothing (the missed edge is safe).
      const result = extract(`
using Mirror;
namespace Networked { class Root : NetworkBehaviour {} }
namespace Plain {
    struct Root { int x; }
    class Child : Root {
        public void OnStartServer() {}
        [Command] void M() {}
    }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    // --- Round 5: fabrication fixes (emit nothing on uncertain type identity) ---

    it('does not merge two same-named partial types across namespaces (BLOCKING 1, round 4)', () => {
      // `Plain.Root` (base-less partial) is a DIFFERENT compiler type from `Networked.Root`; merging
      // them by simple name fabricates Mirror ownership for `Plain.Child : Root`. Poison, emit nothing.
      const result = extract(`
using Mirror;
namespace Networked { partial class Root : NetworkBehaviour {} }
namespace Plain {
    partial class Root {}
    class Child : Root {
        public void OnStartServer() {}
        [Command] void M() {}
    }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('poisons the chain when a same-named interface competes in another namespace (BLOCKING 2, round 4)', () => {
      const result = extract(`
using Mirror;
namespace Networked { class Root : NetworkBehaviour {} }
namespace Plain {
    interface Root {}
    class Child : Root {
        public void OnStartServer() {}
        [Command] void M() {}
    }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('kills a bare [Command] whose alias target is global::-qualified (BLOCKING 3, round 4)', () => {
      // `using Command = global::Other.CommandAttribute;` rebinds the bare token; the KILL set keys on
      // the alias LHS only, so a global::/extern-qualified target no longer leaks a false Mirror row.
      const result = extract(`
using Mirror;
using Command = global::Other.CommandAttribute;
class P : NetworkBehaviour { [Command] void M() {} }
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('kills a bare [Command] whose alias target is extern-alias-qualified (BLOCKING 3, round 4)', () => {
      const result = extract(`
using Mirror;
using Command = Vendor::Other.CommandAttribute;
class P : NetworkBehaviour { [Command] void M() {} }
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('does not resolve a base alias with two distinct namespace-scoped bindings (BLOCKING 4, round 4)', () => {
      // `A.Victim : NB` derives from `Other.Base`; the later `namespace B { using NB = Mirror… }` is
      // out of scope. The file-global map must NOT last-wins `NB` to Mirror. Ambiguous -> unresolved.
      const result = extract(`
using Mirror;
namespace A {
    using NB = Other.Base;
    class Victim : NB {
        public void OnStartServer() {}
        [Command] void M() {}
    }
}
namespace B { using NB = Mirror.NetworkBehaviour; }
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('suppresses a bare gated host token the file locally redeclares (BLOCKING 5, round 4)', () => {
      // `class NetworkBehaviour {}` in the file means bare `: NetworkBehaviour` binds to the local
      // type, not Mirror's base. Emit nothing rather than fabricate a host.
      const result = extract(`
using Mirror;
namespace Game {
    class NetworkBehaviour {}
    class P : NetworkBehaviour {
        public void OnStartServer() {}
        [Command] void M() {}
    }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('suppresses a bare [Command] the file locally redeclares, but keeps a real host callback (BLOCKING 5, round 4)', () => {
      // `class CommandAttribute {}` shadows `[Command]` (killed), while the class is still a real
      // Mirror host, so its OnStartServer callback stays live — the kill is surgical, not blanket.
      const result = extract(`
using System;
using Mirror;
namespace Game {
    class CommandAttribute : Attribute {}
    class P : NetworkBehaviour {
        public void OnStartServer() {}
        [Command] void M() {}
    }
}
`);
      expect(nodeNames(result)).toEqual(['UNITY NetworkBehaviour.OnStartServer P.OnStartServer']);
      expect(refPairs(result)).toEqual(['references:unity:host:P.OnStartServer']);
    });

    it('honors a mid-line FishNet disqualifier on a shared using line (SHOULD-FIX 3, round 4)', () => {
      // `using Mirror; using FishNet.Object;` on ONE physical line: the FishNet exclusion must still
      // win, so no Mirror rows emit. Token-wise gate recognition, not physical-line anchoring.
      const result = extract(`
using Mirror; using FishNet.Object;
class P : NetworkBehaviour { [Command] void M() {} }
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    // --- Round 5: safe-direction fixes (must still emit) ---

    it('opens the Mirror gate on a `global using` directive (SHOULD-FIX 3, round 4)', () => {
      const result = extract(`
global using Mirror;
class P : NetworkBehaviour { [Command] void M() {} }
`);
      expect(nodeNames(result)).toEqual(['UNITY attribute Command P.M']);
      expect(refPairs(result)).toEqual(['references:unity:method:P.M']);
    });

    it('keeps a [SyncVar] field whose initializer uses the left-shift operator (SHOULD-FIX 2, round 4)', () => {
      const result = extract(`
using Mirror;
class P : NetworkBehaviour { [SyncVar] int x = a << 2; }
`);
      expect(nodeNames(result)).toEqual(['UNITY SyncVar field P.x']);
      expect(refPairs(result)).toEqual(['references:unity:field:P.x']);
    });

    it('classifies members of a base-less sibling partial block for a Mirror host (SHOULD-FIX 1, round 4)', () => {
      const result = extract(`
using Mirror;
partial class P : NetworkBehaviour {}
partial class P {
    public void OnStartServer() {}
    [Command] void M() {}
}
`);
      expect(nodeNames(result)).toEqual(
        ['UNITY NetworkBehaviour.OnStartServer P.OnStartServer', 'UNITY attribute Command P.M'].sort()
      );
      expect(refPairs(result)).toEqual(
        ['references:unity:host:P.OnStartServer', 'references:unity:method:P.M'].sort()
      );
    });

    // --- Round 5 (graduation): B1/B2/B3 fabrication families ---
    // B1: a `global::`/extern-qualified base ALIAS whose RHS the alias parser cannot expand must not
    // fall back to its bare LHS token — C# binds the bare token to the alias, so classifying it as a
    // framework base fabricates a Mirror host. Any alias LHS shadows the bare token for base
    // classification, exactly like a local type redeclaration (kill, never resolve-through).

    it('does not fabricate a Mirror host through a global::-qualified base alias (B1, round 5)', () => {
      const result = extract(`
using Mirror;
using NetworkBehaviour = global::Foreign.Net.NetworkBehaviour;

public class Player : NetworkBehaviour
{
    public override void OnStartServer() { }
    [Command] void CmdFire() { }
    [SyncVar] int health;
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('does not fabricate a Mirror host through an extern-alias-qualified base alias (B1, round 5)', () => {
      const result = extract(`
extern alias Vendor;
using Mirror;
using NetworkBehaviour = Vendor::Foreign.Net.NetworkBehaviour;

public class Player : NetworkBehaviour
{
    public override void OnStartServer() { }
    [Command] void CmdFire() { }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('is order-independent: the foreign global:: base alias suppresses in either declaration order (B1, round 5)', () => {
      const result = extract(`
using NetworkBehaviour = global::Foreign.Net.NetworkBehaviour;
using Mirror;

public class Player : NetworkBehaviour
{
    public override void OnStartServer() { }
    [Command] void CmdFire() { }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('still resolves a supported file-scope alias of Mirror\'s own FQ base (B1 control, round 5)', () => {
      const result = extract(`
using Mirror;
using NB = Mirror.NetworkBehaviour;

public class Player : NB
{
    public override void OnStartServer() { }
    [Command] void CmdFire() { }
}
`);
      expect(nodeNames(result)).toEqual(
        ['UNITY NetworkBehaviour.OnStartServer Player.OnStartServer', 'UNITY attribute Command Player.CmdFire'].sort()
      );
      expect(refPairs(result)).toEqual(
        ['references:unity:host:Player.OnStartServer', 'references:unity:method:Player.CmdFire'].sort()
      );
    });

    // B2: a using-alias declared inside one namespace is scoped to that namespace declaration in C#.
    // Applying it file-wide fabricates ownership for classes in OTHER namespaces. Positive alias
    // resolution is namespace-scope-aware; outside the scope the LHS name stays killed (suppression
    // over guessed ownership).

    it('does not apply an alias declared in namespace A to a class in namespace B (B2, round 5)', () => {
      const result = extract(`
using Mirror;

namespace A
{
    using NB = Mirror.NetworkBehaviour;
}

namespace B
{
    public class Victim : NB
    {
        public override void OnStartServer() { }
        [Command] void CmdFire() { }
    }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('does not apply an alias declared in a block namespace to a top-level class after it (B2, round 5)', () => {
      const result = extract(`
using Mirror;
namespace Inner { using NB = Mirror.NetworkBehaviour; }
class Victim : NB
{
    public void OnStartServer() { }
    [Command] void CmdFire() { }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('prefers suppression when a namespace-scoped alias rebinds a gated token used bare elsewhere (B2, round 5)', () => {
      // In C#, B.Victim's bare NetworkBehaviour binds to Mirror's via the file-level using — but our
      // scope model cannot prove that without full namespace resolution, so the alias-bound name is
      // killed file-wide for bare-base classification. Missed edge, never a guess.
      const result = extract(`
using Mirror;
namespace A { using NetworkBehaviour = global::Foreign.Net.NetworkBehaviour; }
namespace B
{
    class Victim : NetworkBehaviour
    {
        public void OnStartServer() { }
        [Command] void CmdFire() { }
    }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('still resolves an alias for a class in the SAME block namespace (B2 control, round 5)', () => {
      const result = extract(`
using Mirror;
namespace Game
{
    using NB = Mirror.NetworkBehaviour;
    public class Player : NB
    {
        public override void OnStartServer() { }
        [Command] void CmdFire() { }
    }
}
`);
      expect(nodeNames(result)).toEqual(
        ['UNITY NetworkBehaviour.OnStartServer Player.OnStartServer', 'UNITY attribute Command Player.CmdFire'].sort()
      );
      expect(refPairs(result)).toEqual(
        ['references:unity:host:Player.OnStartServer', 'references:unity:method:Player.CmdFire'].sort()
      );
    });

    it('still resolves an alias under a file-scoped namespace (B2 control, round 5)', () => {
      const result = extract(`
using Mirror;
namespace Game;
using NB = Mirror.NetworkBehaviour;
public class Player : NB
{
    public override void OnStartServer() { }
    [Command] void CmdFire() { }
}
`);
      expect(nodeNames(result)).toEqual(
        ['UNITY NetworkBehaviour.OnStartServer Player.OnStartServer', 'UNITY attribute Command Player.CmdFire'].sort()
      );
      expect(refPairs(result)).toEqual(
        ['references:unity:host:Player.OnStartServer', 'references:unity:method:Player.CmdFire'].sort()
      );
    });

    // B3: preprocessor text in a provably-inactive region (`#if false`) is NOT compiled — a
    // `using Mirror;` there must not open the gate, and declarations there are not evidence of
    // anything. Evidence (gate-opening) requires a provably-ACTIVE position; exclusion
    // (disqualifying usings) fires from any potentially-active position. Uncertain regions
    // (`#if UNKNOWN_SYMBOL`) provide no evidence but still exclude — emit-nothing under uncertainty.

    it('does not open the Mirror gate from a using inside #if false (B3, round 5)', () => {
      const result = extract(`
#if false
using Mirror;
#endif

public class Player : NetworkBehaviour
{
    public override void OnStartServer() { }
    [Command] void CmdFire() { }
    [SyncVar] int health;
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('does not open the Mirror gate from a using inside a nested inactive branch (B3, round 5)', () => {
      const result = extract(`
#if true
#if false
using Mirror;
#endif
#endif

public class Player : NetworkBehaviour
{
    public override void OnStartServer() { }
    [Command] void CmdFire() { }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('treats the #else of #if false as active — inactive FishNet must not disqualify, active Mirror opens (B3, round 5)', () => {
      const result = extract(`
#if false
using FishNet.Object;
#else
using Mirror;
#endif

public class Player : NetworkBehaviour
{
    public override void OnStartServer() { }
    [Command] void CmdFire() { }
}
`);
      expect(nodeNames(result)).toEqual(
        ['UNITY NetworkBehaviour.OnStartServer Player.OnStartServer', 'UNITY attribute Command Player.CmdFire'].sort()
      );
      expect(refPairs(result)).toEqual(
        ['references:unity:host:Player.OnStartServer', 'references:unity:method:Player.CmdFire'].sort()
      );
    });

    it('treats an #elif true after #if false as active (B3, round 5)', () => {
      const result = extract(`
#if false
using FishNet.Object;
#elif true
using Mirror;
#endif

public class Player : NetworkBehaviour
{
    public override void OnStartServer() { }
}
`);
      expect(nodeNames(result)).toEqual(['UNITY NetworkBehaviour.OnStartServer Player.OnStartServer']);
      expect(refPairs(result)).toEqual(['references:unity:host:Player.OnStartServer']);
    });

    it('does not open the gate from a using under an UNKNOWN conditional symbol (B3, round 5)', () => {
      // Whether UNITY_SERVER is defined is a build-configuration fact we cannot prove from the file:
      // uncertain evidence opens nothing (missed edge over fabrication).
      const result = extract(`
#if UNITY_SERVER
using Mirror;
#endif

public class Player : NetworkBehaviour
{
    public override void OnStartServer() { }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('still honors a disqualifying using under an UNKNOWN conditional symbol (B3, round 5)', () => {
      // The FishNet using is only potentially active — but a potentially-competing stack is enough
      // to close the Mirror gate (exclusion always wins; suppression is the safe direction).
      const result = extract(`
#if SOME_SYMBOL
using FishNet.Object;
#endif
using Mirror;

public class Player : NetworkBehaviour
{
    public override void OnStartServer() { }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('opens the gate when an in-file #define proves the conditional using active (B3, round 5)', () => {
      const result = extract(`
#define MIRROR_ON
#if MIRROR_ON
using Mirror;
#endif

public class Player : NetworkBehaviour
{
    public override void OnStartServer() { }
}
`);
      expect(nodeNames(result)).toEqual(['UNITY NetworkBehaviour.OnStartServer Player.OnStartServer']);
      expect(refPairs(result)).toEqual(['references:unity:host:Player.OnStartServer']);
    });

    it('ignores preprocessor text inside comments and strings (B3, round 5)', () => {
      // The commented directive and the string literal are non-evidence in BOTH directions: they
      // neither open an inactive region nor hide the genuinely active using.
      const result = extract(`
// #if false
using Mirror;

public class Player : NetworkBehaviour
{
    string s = "#if false";
    public override void OnStartServer() { }
}
`);
      expect(nodeNames(result)).toEqual(['UNITY NetworkBehaviour.OnStartServer Player.OnStartServer']);
      expect(refPairs(result)).toEqual(['references:unity:host:Player.OnStartServer']);
    });

    it('does not let a local shadow declaration inside #if false suppress a real Mirror host (B3, round 5)', () => {
      // The shadowing `class NetworkBehaviour {}` is provably not compiled, so C# binds the bare base
      // to Mirror's type — blanking the inactive region restores the correct emission.
      const result = extract(`
using Mirror;
#if false
class NetworkBehaviour {}
#endif
public class Player : NetworkBehaviour
{
    public override void OnStartServer() { }
}
`);
      expect(nodeNames(result)).toEqual(['UNITY NetworkBehaviour.OnStartServer Player.OnStartServer']);
      expect(refPairs(result)).toEqual(['references:unity:host:Player.OnStartServer']);
    });

    // --- Round 6 (graduation re-review): illegal namespace layouts (N1/N2) ---
    // A compilation unit the C# compiler rejects cannot produce framework-invoked members, so the
    // resolver must emit NOTHING for the whole file. CS8956: a file-scoped namespace must precede
    // all other members; CS8955: file-scoped and block namespaces cannot mix; CS8954: only one
    // file-scoped namespace per file. The scanner's namespace spans are meaningless on such input,
    // so any row derived from them is a fabrication.

    it('emits nothing when a class precedes a file-scoped namespace declaration (N1, round 6)', () => {
      // CS8956 — file-scoped namespace after a member. Fixture spans all four emission kinds.
      const result = extract(`
using Mirror;
class InvalidPlayer : NetworkBehaviour
{
    public override void OnStartServer() { }
    [Command] void Cmd() { }
    [SyncVar(hook = nameof(OnHealth))] int health;
    void OnHealth(int oldValue, int newValue) { }
}
namespace Later;
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing when any type declaration precedes a file-scoped namespace (N1, round 6)', () => {
      // CS8956 fires on the struct; the later class would be legal alone but the whole
      // compilation unit is rejected, so its rows would be fabrications.
      const result = extract(`
using Mirror;
struct Early { }
namespace Later;

class Player : NetworkBehaviour
{
    public override void OnStartServer() { }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing when file-scoped and block namespaces are mixed (N2, round 6)', () => {
      // CS8955 — the nested block span is impossible scope, so the alias inside it must not
      // resolve and no rows may derive from it.
      const result = extract(`
using Mirror;
namespace FileScope;
namespace Inner
{
    using NB = Mirror.NetworkBehaviour;
    class Good : NB
    {
        public override void OnStartServer() { }
        [Command] void Cmd() { }
    }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing when a block namespace precedes a file-scoped declaration (N2, round 6)', () => {
      const result = extract(`
using Mirror;
namespace First
{
    class Player : NetworkBehaviour
    {
        public override void OnStartServer() { }
    }
}
namespace Second;
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing when a file declares two file-scoped namespaces (round 6)', () => {
      // CS8954 — only one file-scoped namespace declaration is allowed per file.
      const result = extract(`
using Mirror;
namespace A;
namespace B;

class Player : NetworkBehaviour
{
    public override void OnStartServer() { }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('does not treat a file-scoped declaration inside #if false as an illegal mix (round 6 control)', () => {
      // The inactive declaration is never compiled, so the block namespace stands alone — the
      // layout check must run on the preprocessor-blanked text, not the raw source.
      const result = extract(`
using Mirror;
#if false
namespace Dead;
#endif
namespace Live
{
    public class Player : NetworkBehaviour
    {
        public override void OnStartServer() { }
    }
}
`);
      expect(nodeNames(result)).toEqual(['UNITY NetworkBehaviour.OnStartServer Player.OnStartServer']);
      expect(refPairs(result)).toEqual(['references:unity:host:Player.OnStartServer']);
    });

    // --- Round 7 (graduation re-review): C# identifier grammar (I3-I8, A1) ---
    // Round 6's layout check, the namespace-span scanner and the class scanner each encoded a
    // narrower ASCII subset of C#'s identifier grammar. C# identifiers may carry a verbatim `@`
    // prefix (`@namespace` names the type `namespace`), use Unicode letters, or use `\uXXXX`
    // escapes — so names those scanners could not parse slipped past the illegal-layout check
    // (fabrications I3-I8), local-shadow and alias-kill sets (adjacent fabrications), and the
    // class parser itself (false suppression A1). One shared grammar now backs all of them, and
    // a name the scanner still cannot decode suppresses rather than emits.

    it('emits nothing when an @-escaped type precedes a file-scoped namespace (I3, round 7)', () => {
      // CS8956 — `@EarlyType` is a type declaration even though the round-6 keyword scan could
      // not see its name.
      const result = extract(`
using Mirror;
public class @EarlyType { }
namespace Invalid.AfterEscapedType;

public class Player : NetworkBehaviour
{
    public override void OnStartServer() { }
    [Command] void Cmd() { }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing when a Unicode-named type precedes a file-scoped namespace (I4, round 7)', () => {
      // CS8956 — `Ångström` is a legal C# identifier the ASCII scan missed.
      const result = extract(`
using Mirror;
public class Ångström { }
namespace Invalid.AfterUnicodeType;

public class Player : NetworkBehaviour
{
    public override void OnStartServer() { }
    [Command] void Cmd() { }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing when a top-level statement precedes a file-scoped namespace (I5, round 7)', () => {
      // CS8956 covers ALL members, not just type declarations — the prelude before a file-scoped
      // namespace may hold only extern-alias/using directives and assembly/module attributes.
      const result = extract(`
using Mirror;
System.Console.WriteLine("before namespace");
namespace Invalid.AfterTopLevelStatement;

public class Player : NetworkBehaviour
{
    public override void OnStartServer() { }
    [Command] void Cmd() { }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing when a using STATEMENT precedes a file-scoped namespace (I5-adjacent, round 7)', () => {
      // A `using (...)` statement is a top-level statement, not a directive — it must not pass
      // the legal-prelude whitelist.
      const result = extract(`
using Mirror;
using (var f = System.IO.File.OpenRead("x")) { }
namespace Invalid.AfterUsingStatement;

public class Player : NetworkBehaviour
{
    public override void OnStartServer() { }
    [Command] void Cmd() { }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing when an @-escaped file-scoped namespace mixes with a block namespace (I6, round 7)', () => {
      // CS8955 — the file-scoped declaration's escaped name hid it from the round-6 scan.
      const result = extract(`
using Mirror;
namespace @FileScoped;
namespace Invalid.Block
{
    public class Player : NetworkBehaviour
    {
        public override void OnStartServer() { }
        [Command] void Cmd() { }
    }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing when a file-scoped namespace mixes with an @-escaped block namespace (I7, round 7)', () => {
      const result = extract(`
using Mirror;
namespace Invalid.FileScoped;
namespace @Block
{
    public class Player : NetworkBehaviour
    {
        public override void OnStartServer() { }
        [Command] void Cmd() { }
    }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing when a Unicode file-scoped namespace mixes with a block namespace (I8, round 7)', () => {
      const result = extract(`
using Mirror;
namespace Ångström;
namespace Invalid.Block
{
    public class Player : NetworkBehaviour
    {
        public override void OnStartServer() { }
        [Command] void Cmd() { }
    }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing for a namespace declaration with no parsable name (round 7)', () => {
      // `namespace {` is uncompilable; the old scanner simply failed to see the declaration and
      // parsed the class at global scope, emitting from an impossible unit.
      const result = extract(`
using Mirror;
namespace
{
    public class Player : NetworkBehaviour
    {
        public override void OnStartServer() { }
    }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('still emits for a legal @-escaped class carrying Mirror surfaces (A1, round 7)', () => {
      // False-suppression direction: `class @namespace : NetworkBehaviour` is legal C# — the
      // class is NAMED `namespace` (the verbatim prefix is not part of the name) and must emit.
      const result = extract(`
using Mirror;
namespace Legal.EscapedClass;
public class @namespace : NetworkBehaviour
{
    public override void OnStartServer() { }
    [Command] void Cmd() { }
}
`);
      expect(nodeNames(result)).toEqual([
        'UNITY NetworkBehaviour.OnStartServer namespace.OnStartServer',
        'UNITY attribute Command namespace.Cmd',
      ]);
      expect(refPairs(result)).toEqual([
        'references:unity:host:namespace.OnStartServer',
        'references:unity:method:namespace.Cmd',
      ]);
    });

    it('still emits when the legal prelude holds using, extern alias and assembly attributes (round 7 control)', () => {
      // The CS8956 check is a whitelist; everything the compiler allows before a file-scoped
      // namespace must keep the file emitting.
      const result = extract(`
extern alias Vendor;
global using System;
using Mirror;
using static System.Math;
using NB = Mirror.NetworkBehaviour;
[assembly: System.Reflection.AssemblyMetadata("k", "v")]
[module: System.CLSCompliant(false)]
namespace Legal.Prelude;

public class Player : NB
{
    public override void OnStartServer() { }
}
`);
      expect(nodeNames(result)).toEqual(['UNITY NetworkBehaviour.OnStartServer Player.OnStartServer']);
      expect(refPairs(result)).toEqual(['references:unity:host:Player.OnStartServer']);
    });

    it('suppresses a bare gated base bound by an @-escaped using-alias (round 7)', () => {
      // `using @NetworkBehaviour = …` binds the NAME NetworkBehaviour; C# resolves Player's bare
      // base to the alias target, not Mirror. The ASCII alias scan missed the escaped LHS and
      // fabricated a Mirror host.
      const result = extract(`
using Mirror;
using @NetworkBehaviour = Foreign.Net;

class Player : NetworkBehaviour
{
    public override void OnStartServer() { }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('suppresses a bare gated base shadowed by an @-escaped local type (round 7)', () => {
      // `interface @NetworkBehaviour` locally declares the NAME NetworkBehaviour, so the bare
      // base binds to the local type — same shadow rule as the ASCII spelling.
      const result = extract(`
using Mirror;
namespace N
{
    interface @NetworkBehaviour { }
    class Player : NetworkBehaviour
    {
        public override void OnStartServer() { }
    }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing when code carries Unicode identifier escapes (round 7)', () => {
      // `interface \\u004EetworkBehaviour` also declares the NAME NetworkBehaviour — C# decodes
      // \\uXXXX escapes in identifiers, this scanner cannot. Any escape surviving comment-strip +
      // string-mask + preprocessor-blank sits in code, so every name comparison in the file is
      // unsound: emit nothing.
      const result = extract(`
using Mirror;
namespace N
{
    interface \\u004EetworkBehaviour { }
    class Player : NetworkBehaviour
    {
        public override void OnStartServer() { }
    }
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('ignores Unicode escapes inside strings and inactive regions (round 7 control)', () => {
      const result = extract(`
using Mirror;
#if false
class \\u0044ead { }
#endif
namespace Live
{
    public class Player : NetworkBehaviour
    {
        public override void OnStartServer() { }
        void Log() { var s = "\\u0041"; var c = '\\u0042'; }
    }
}
`);
      expect(nodeNames(result)).toEqual(['UNITY NetworkBehaviour.OnStartServer Player.OnStartServer']);
      expect(refPairs(result)).toEqual(['references:unity:host:Player.OnStartServer']);
    });

    // --- SyncVar field liveness ---

    it('keeps a non-static [SyncVar] field live under an open Mirror gate', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar] int health;
}
`);
      expect(nodeNames(result)).toEqual(['UNITY SyncVar field Player.health']);
      expect(refPairs(result)).toEqual(['references:unity:field:Player.health']);
    });

    it('emits a type reference for a [SyncVar] field whose declared type is local', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar] PlayerData data;
}
`);
      expect(nodeNames(result)).toEqual(['UNITY SyncVar field Player.data']);
      expect(refPairs(result)).toEqual(
        ['references:unity:field:Player.data', 'references:PlayerData'].sort()
      );
    });

    it('emits nothing for a STATIC [SyncVar] field', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar] static int health;
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing for a [SyncVar] field on a non-NetworkBehaviour class', () => {
      const result = extract(`
using Mirror;

class PlainHelper
{
    [SyncVar] int health;
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits nothing for a FOREIGN-qualified [Other.SyncVar] field (BLOCKING 3)', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [Other.SyncVar] int health;
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('keeps an OWNING-qualified [Mirror.SyncVar] field live (BLOCKING 3)', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [Mirror.SyncVar] int health;
}
`);
      expect(nodeNames(result)).toEqual(['UNITY SyncVar field Player.health']);
      expect(refPairs(result)).toEqual(['references:unity:field:Player.health']);
    });

    // --- SyncVar field type shapes (SHOULD-FIX 4) ---

    it('keeps an ARRAY [SyncVar] field live (builtin element, no type ref)', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar] int[] scores;
}
`);
      expect(nodeNames(result)).toEqual(['UNITY SyncVar field Player.scores']);
      expect(refPairs(result)).toEqual(['references:unity:field:Player.scores']);
    });

    it('references the ELEMENT type of a local-typed array [SyncVar] field', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar] PlayerData[] roster;
}
`);
      expect(nodeNames(result)).toEqual(['UNITY SyncVar field Player.roster']);
      expect(refPairs(result)).toEqual(
        ['references:unity:field:Player.roster', 'references:PlayerData'].sort()
      );
    });

    it('keeps a NULLABLE [SyncVar] field live', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar] int? health;
}
`);
      expect(nodeNames(result)).toEqual(['UNITY SyncVar field Player.health']);
      expect(refPairs(result)).toEqual(['references:unity:field:Player.health']);
    });

    it('references the underlying type of a local-typed nullable [SyncVar] field', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar] PlayerData? data;
}
`);
      expect(nodeNames(result)).toEqual(['UNITY SyncVar field Player.data']);
      expect(refPairs(result)).toEqual(
        ['references:unity:field:Player.data', 'references:PlayerData'].sort()
      );
    });

    it('keeps a GENERIC [SyncVar] field live (container is not a local type ref)', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar] SyncList<int> scores;
}
`);
      expect(nodeNames(result)).toEqual(['UNITY SyncVar field Player.scores']);
      expect(refPairs(result)).toEqual(['references:unity:field:Player.scores']);
    });

    it('keeps a GENERIC [SyncVar] field with a spaced multi-argument type live', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar] SyncDictionary<int, string> lookup;
}
`);
      expect(nodeNames(result)).toEqual(['UNITY SyncVar field Player.lookup']);
      expect(refPairs(result)).toEqual(['references:unity:field:Player.lookup']);
    });

    it('keeps a [SyncVar] field with a GENERIC constructor initializer live (BLOCKING 4)', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar] Dictionary<int,string> lookup = new Dictionary<int,string>();
}
`);
      expect(nodeNames(result)).toEqual(['UNITY SyncVar field Player.lookup']);
      expect(refPairs(result)).toEqual(['references:unity:field:Player.lookup']);
    });

    it('keeps a [SyncVar] field with a NESTED-generic constructor initializer live (BLOCKING 4)', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar] Dictionary<int, List<Foo>> lookup = new Dictionary<int, List<Foo>>();
}
`);
      expect(nodeNames(result)).toEqual(['UNITY SyncVar field Player.lookup']);
      expect(refPairs(result)).toEqual(['references:unity:field:Player.lookup']);
    });

    it('emits nothing (and does not crash) for a comparison-operator initializer (BLOCKING 4)', () => {
      // `a < b` opens an angle context that never closes before the top-level `;`, so the scan
      // bails on the whole declaration rather than mis-splitting on the generic-looking comma.
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar] int x = a < b, y = 2;
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('emits one row per name for a MULTI-DECLARATOR [SyncVar] field', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar] int x, y, z;
}
`);
      expect(nodeNames(result)).toEqual(
        ['UNITY SyncVar field Player.x', 'UNITY SyncVar field Player.y', 'UNITY SyncVar field Player.z'].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'references:unity:field:Player.x',
          'references:unity:field:Player.y',
          'references:unity:field:Player.z',
        ].sort()
      );
    });

    it('emits one row per name for a MULTI-DECLARATOR [SyncVar] field with initializers', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar] int health = 100, shield = 50;
}
`);
      expect(nodeNames(result)).toEqual(
        ['UNITY SyncVar field Player.health', 'UNITY SyncVar field Player.shield'].sort()
      );
      expect(refPairs(result)).toEqual(
        ['references:unity:field:Player.health', 'references:unity:field:Player.shield'].sort()
      );
    });

    // --- SyncVar field brace initializers / const / nullable-array / perf (BLOCKING 3, SHOULD-FIX 4/5) ---

    it('keeps a [SyncVar] field with a BRACE object initializer live (BLOCKING 3)', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar] PlayerData data = new PlayerData { Health = 100 };
}
`);
      expect(nodeNames(result)).toEqual(['UNITY SyncVar field Player.data']);
      expect(refPairs(result)).toEqual(
        ['references:unity:field:Player.data', 'references:PlayerData'].sort()
      );
    });

    it('emits nothing for a CONST [SyncVar] field (const is implicitly static; BLOCKING 3)', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar] const int health = 100;
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('references the ELEMENT type of a nullable-array [SyncVar] field (T[]?; SHOULD-FIX 5)', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar] PlayerData[]? roster;
}
`);
      expect(nodeNames(result)).toEqual(['UNITY SyncVar field Player.roster']);
      expect(refPairs(result)).toEqual(
        ['references:unity:field:Player.roster', 'references:PlayerData'].sort()
      );
    });

    it('references the ELEMENT type of a nullable-element array [SyncVar] field (T?[]; SHOULD-FIX 5)', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar] PlayerData?[] roster;
}
`);
      expect(nodeNames(result)).toEqual(['UNITY SyncVar field Player.roster']);
      expect(refPairs(result)).toEqual(
        ['references:unity:field:Player.roster', 'references:PlayerData'].sort()
      );
    });

    it('keeps a JAGGED-array [SyncVar] field live (builtin element, no type ref; SHOULD-FIX 5)', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar] int[][] grid;
}
`);
      expect(nodeNames(result)).toEqual(['UNITY SyncVar field Player.grid']);
      expect(refPairs(result)).toEqual(['references:unity:field:Player.grid']);
    });

    it('does not hang on an unclosed generic in an attributed field (SHOULD-FIX 4)', () => {
      const payload = 'X'.repeat(100_000);
      const source = `
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar] A<${payload} value;
}
`;
      const start = Date.now();
      const result = extract(source);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(2000);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    // --- Member-scan catastrophic backtracking (BLOCKING 7) ---

    it('does not hang on a method preceded by many stacked attributes (BLOCKING 7)', () => {
      // Mirrors the real trigger: a block-bodied method under ~30 stacked [TestCase(...)] lines
      // (CRLF + tabs). The block body means the expression-bodied regex's `=>` tail never matches,
      // forcing the full backtrack that the double-sided `\s*` attribute run blew up on (2^N).
      const attrs = Array.from(
        { length: 30 },
        (_, i) => `\t[TestCase("a${i}", "=", "1", 1)]`
      ).join('\r\n');
      const source =
        `using Mirror;\r\n\r\nclass Player : NetworkBehaviour\r\n{\r\n${attrs}\r\n` +
        `\tpublic void Foo()\r\n\t{\r\n\t\tint x = 1;\r\n\t}\r\n}\r\n`;
      const start = Date.now();
      const result = extract(source);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(500);
      // None of the stacked attributes are gated and Foo is not a host callback, so nothing emits —
      // the point is that extract() COMPLETES.
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('still extracts an RPC method carrying many stacked attributes (BLOCKING 7)', () => {
      // The single-sided attribute run must still capture the whole stack into group 1, so the
      // gated [Command] below ~30 [TestCase] lines is found and emitted.
      const attrs = Array.from({ length: 30 }, (_, i) => `\t[TestCase("a${i}")]`).join('\r\n');
      const source =
        `using Mirror;\r\n\r\nclass Player : NetworkBehaviour\r\n{\r\n${attrs}\r\n` +
        `\t[Command]\r\n\tvoid CmdMove()\r\n\t{\r\n\t}\r\n}\r\n`;
      const start = Date.now();
      const result = extract(source);
      expect(Date.now() - start).toBeLessThan(500);
      expect(nodeNames(result)).toContain('UNITY attribute Command Player.CmdMove');
    });

    // --- SyncVar hook resolution ---

    it('resolves a [SyncVar(hook = nameof(Method))] hook to a unique same-class method', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar(hook = nameof(OnHealthChanged))] int health;
    void OnHealthChanged(int oldValue, int newValue) {}
}
`);
      expect(nodeNames(result)).toEqual(
        ['UNITY SyncVar field Player.health', 'UNITY SyncVar hook Player.OnHealthChanged'].sort()
      );
      expect(refPairs(result)).toEqual(
        ['references:unity:field:Player.health', 'references:unity:method:Player.OnHealthChanged'].sort()
      );
    });

    it('resolves a [SyncVar(hook = "Method")] string-literal hook to a unique same-class method', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar(hook = "OnHealthChanged")] int health;
    void OnHealthChanged(int oldValue, int newValue) {}
}
`);
      expect(nodeNames(result)).toEqual(
        ['UNITY SyncVar field Player.health', 'UNITY SyncVar hook Player.OnHealthChanged'].sort()
      );
      expect(refPairs(result)).toEqual(
        ['references:unity:field:Player.health', 'references:unity:method:Player.OnHealthChanged'].sort()
      );
    });

    it('keeps the field live but emits no hook ref when the hook names an OVERLOADED method', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar(hook = nameof(OnHealthChanged))] int health;
    void OnHealthChanged(int oldValue, int newValue) {}
    void OnHealthChanged(float oldValue, float newValue) {}
}
`);
      expect(nodeNames(result)).toEqual(['UNITY SyncVar field Player.health']);
      expect(refPairs(result)).toEqual(['references:unity:field:Player.health']);
    });

    it('emits no hook ref for a qualified nameof(Other.Method) hook value', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar(hook = nameof(Other.OnHealthChanged))] int health;
    void OnHealthChanged(int oldValue, int newValue) {}
}
`);
      expect(nodeNames(result)).toEqual(['UNITY SyncVar field Player.health']);
      expect(refPairs(result)).toEqual(['references:unity:field:Player.health']);
    });

    it('emits no hook ref when the hook names a method absent from the class block', () => {
      const result = extract(`
using Mirror;

class Player : NetworkBehaviour
{
    [SyncVar(hook = nameof(OnHealthChanged))] int health;
}
`);
      expect(nodeNames(result)).toEqual(['UNITY SyncVar field Player.health']);
      expect(refPairs(result)).toEqual(['references:unity:field:Player.health']);
    });

    it('emits nothing for SyncVar rows when the Mirror gate is closed by a competing stack', () => {
      const result = extract(`
using Mirror;
using FishNet.Object;

class Player : NetworkBehaviour
{
    [SyncVar(hook = nameof(OnHealthChanged))] int health;
    void OnHealthChanged(int oldValue, int newValue) {}
}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });
  });

  describe('detect(), claimsReference(), and resolve()', () => {
    it('detects Unity projects with strong markers and ignores bare using-only source', () => {
      expect(
        unityResolver.detect(
          makeContext({
            fileExists: (file) => file === 'ProjectSettings/ProjectVersion.txt',
          })
        )
      ).toBe(true);

      expect(
        unityResolver.detect(
          makeContext({
            getAllFiles: () => ['Packages/manifest.json'],
            readFile: (file) => (file === 'Packages/manifest.json' ? '{"dependencies":{"com.unity.inputsystem":"1.0.0"}}' : null),
          })
        )
      ).toBe(true);

      expect(
        unityResolver.detect(
          makeContext({
            getAllFiles: () => ['src/Plain.cs'],
            readFile: () => 'using UnityEngine; class Plain {}',
          })
        )
      ).toBe(false);

      expect(
        unityResolver.detect(
          makeContext({
            getAllFiles: () => ['src/Comment.cs'],
            readFile: () => '// using UnityEngine; class Player : MonoBehaviour {}',
          })
        )
      ).toBe(false);

      expect(
        unityResolver.detect(
          makeContext({
            getAllFiles: () => ['src/Player.cs'],
            readFile: () => 'using UnityEngine; class Player : MonoBehaviour {}',
          })
        )
      ).toBe(true);
    });

    it('claims only Unity synthetic references', () => {
      expect(unityResolver.claimsReference?.('unity:host:Player.Update')).toBe(true);
      expect(unityResolver.claimsReference?.('unity:method:Player.Explode')).toBe(true);
      expect(unityResolver.claimsReference?.('unity:field:Player.weapon')).toBe(true);
      expect(unityResolver.claimsReference?.('Update')).toBe(false);
      expect(unityResolver.claimsReference?.('blender:host:Player.Update')).toBe(false);
    });

    it('resolves synthetic refs by exact same-file contained symbols', () => {
      const update = makeSymbol({
        id: 'method:Player.Update',
        kind: 'method',
        name: 'Update',
        filePath: 'Assets/Scripts/Player.cs',
        startLine: 5,
        endLine: 5,
      });
      const enemyUpdate = makeSymbol({
        id: 'method:Enemy.Update',
        kind: 'method',
        name: 'Update',
        filePath: 'Assets/Scripts/Player.cs',
        startLine: 30,
        endLine: 30,
      });
      const field = makeSymbol({
        id: 'field:Player.weapon',
        kind: 'field',
        name: 'weapon',
        filePath: 'Assets/Scripts/Player.cs',
        startLine: 8,
        endLine: 8,
      });

      const context = makeContext({
        getNodesInFile: () => [update, enemyUpdate, field],
      });

      expect(
        unityResolver.resolve(makeRef({ referenceName: 'unity:host:Player.Update' }), context)
      ).toMatchObject({ targetNodeId: 'method:Player.Update', resolvedBy: 'framework' });
      expect(
        unityResolver.resolve(makeRef({ referenceName: 'unity:field:Player.weapon' }), context)
      ).toMatchObject({ targetNodeId: 'field:Player.weapon', resolvedBy: 'framework' });
      expect(
        unityResolver.resolve(makeRef({ referenceName: 'unity:host:Other.Update' }), context)
      ).toBeNull();
      expect(unityResolver.resolve(makeRef({ referenceName: 'Update' }), context)).toBeNull();
    });

    it('does not resolve suffix-colliding class names by substring', () => {
      const networkUpdate = makeSymbol({
        id: 'method:NetworkPlayer.Update',
        kind: 'method',
        name: 'Update',
        filePath: 'Assets/Scripts/Player.cs',
        startLine: 5,
        endLine: 5,
      });
      const playerUpdate = makeSymbol({
        id: 'method:Player.Update',
        kind: 'method',
        name: 'Update',
        filePath: 'Assets/Scripts/Player.cs',
        startLine: 20,
        endLine: 20,
      });

      const context = makeContext({
        getNodesInFile: () => [networkUpdate, playerUpdate],
      });

      expect(
        unityResolver.resolve(makeRef({ referenceName: 'unity:host:Player.Update' }), context)
      ).toMatchObject({ targetNodeId: 'method:Player.Update', resolvedBy: 'framework' });
    });
  });
});
