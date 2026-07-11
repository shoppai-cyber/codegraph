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

    it('treats each partial class block independently', () => {
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
      expect(result).toEqual({ nodes: [], references: [] });
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
