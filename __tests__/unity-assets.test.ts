/**
 * Unity asset-wiring extractor + resolver tests.
 *
 * TDD red tests for the Tier-2 Unity asset extractor: it parses `.unity`,
 * `.prefab`, and `.asset` YAML at index time and emits GameObject/prefab
 * nodes, containment/hierarchy edges, intra-file scene-object field wires,
 * and cross-file references (script class, prefab/asset source, UnityEvent
 * method) that the `unity-assets` framework resolver binds — the guid forms
 * via a sibling `.meta` GUID map, and the UnityEvent form by resolving the
 * serialized target TYPE name (`m_TargetAssemblyTypeName`) to an indexed
 * C# class.
 *
 * Assertions are exhaustive: exact sorted node names, edge pairs, and
 * reference names. A fabricated node/edge/ref fails the test as hard as a
 * missing one — the emit-nothing policy (a missed edge beats a fabricated
 * one) is what these tests defend.
 *
 * GUIDs below are the real ones from the CoinDash `tester-01` fixture so the
 * resolver tests line up with on-disk `.meta` files.
 */

import { describe, it, expect } from 'vitest';
import { UnityAssetExtractor } from '../src/extraction/unity-asset-extractor';
import { unityAssetResolver } from '../src/resolution/frameworks/unity-assets';
import { getFrameworkResolver } from '../src/resolution/frameworks';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import type { ExtractionResult, Node } from '../src/types';

// Real fixture GUIDs (tester-01 CoinDash).
const GUID = {
  coinScript: '568548bd1ccbaea45829ff34965ca2be',
  playerController: 'd4f7d915c779359488bd8f769df80d6b',
  cameraFollow: '96b00f100c98ec241abd777f38d3d2fa',
  enemySpawner: 'e4681e23be4fe644ebc8908b74f1d000',
  enemyAI: '58067f1d0bb95044f9f3d19e820ac6f1',
  enemyPrefab: 'e6664d4658ea11f4db518b9ec367f031',
  weaponPrefab: 'a1d1502710d762e43a0c9d2908a0e5e4',
  coinPrefab: 'b2c3d4e5f60718293a4b5c6d7e8f9012',
  // Part F UnityEvent fixture (tester-01 CoinDash): PlayerHealth.onDeath and
  // Button.m_OnClick both persistently invoke GameManager.ResetScore.
  playerHealth: 'fd5424596a3326042a0ca777d9f1b77f',
  gameManager: 'f5b17122a270e4948a67e1d6c0a0e1c1',
  uiButton: '4e29b1a8efbd4b44bb3f3716e73f07ff',
} as const;

// ---------------------------------------------------------------------------
// Extractor helpers
// ---------------------------------------------------------------------------

function extract(source: string, filePath = 'Assets/prefabs/Thing.prefab'): ExtractionResult {
  return new UnityAssetExtractor(filePath, source).extract();
}

function nodeNames(result: ExtractionResult): string[] {
  return result.nodes.map((n) => n.name).sort();
}

function idToName(result: ExtractionResult): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of result.nodes) m.set(n.id, n.name);
  return m;
}

/** Direct (intra-file) edges rendered as `kind:sourceName->targetName`, sorted. */
function edgePairs(result: ExtractionResult): string[] {
  const names = idToName(result);
  return result.edges
    .map((e) => `${e.kind}:${names.get(e.source) ?? e.source}->${names.get(e.target) ?? e.target}`)
    .sort();
}

/** Cross-file unresolved references rendered as `kind:name`, sorted. */
function refNames(result: ExtractionResult): string[] {
  return result.unresolvedReferences.map((r) => `${r.referenceKind}:${r.referenceName}`).sort();
}

function nodeByName(result: ExtractionResult, name: string): Node | undefined {
  return result.nodes.find((n) => n.name === name);
}

/**
 * A stable projection of an extraction result for cross-run equality. Excludes
 * the volatile `updatedAt` timestamp; every id-bearing field is derived from
 * file path + kind + name + line (deterministic), so an LF vs CRLF run of the
 * same content must produce an identical fingerprint.
 */
function fingerprint(result: ExtractionResult) {
  const byStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    nodes: result.nodes
      .map((n) => ({
        id: n.id,
        kind: n.kind,
        name: n.name,
        qualifiedName: n.qualifiedName,
        startLine: n.startLine,
        endLine: n.endLine,
        signature: n.signature ?? null,
        docstring: n.docstring ?? null,
      }))
      .sort((a, b) => byStr(a.id, b.id)),
    edges: result.edges
      .map((e) => ({ source: e.source, target: e.target, kind: e.kind }))
      .sort((a, b) => byStr(a.source + a.target + a.kind, b.source + b.target + b.kind)),
    refs: result.unresolvedReferences
      .map((r) => ({ name: r.referenceName, kind: r.referenceKind, line: r.line }))
      .sort((a, b) => byStr(a.name, b.name)),
  };
}

// A minimal but structurally-real Unity YAML header.
const HEADER = '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:';

// ---------------------------------------------------------------------------
// Resolver helpers
// ---------------------------------------------------------------------------

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
  fields: Pick<Node, 'id' | 'kind' | 'name' | 'filePath' | 'startLine' | 'endLine'> & Partial<Node>
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
    fromNodeId: 'component:unity:test:1',
    referenceKind: 'references',
    line: 1,
    column: 0,
    filePath: 'Assets/prefabs/Thing.prefab',
    language: 'unity_yaml',
    ...fields,
  };
}

// ===========================================================================
// Extractor
// ===========================================================================

describe('UnityAssetExtractor', () => {
  it('minimal prefab: a GameObject carrying a script → node + file-contains edge + script ref', () => {
    const src = `${HEADER}
--- !u!1 &100
GameObject:
  m_Component:
  - component: {fileID: 200}
  - component: {fileID: 300}
  m_Layer: 0
  m_Name: Coin
  m_TagString: Untagged
  m_IsActive: 1
--- !u!4 &200
Transform:
  m_GameObject: {fileID: 100}
  m_LocalPosition: {x: 0, y: 0.5, z: 0}
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Father: {fileID: 0}
--- !u!114 &300
MonoBehaviour:
  m_GameObject: {fileID: 100}
  m_Script: {fileID: 11500000, guid: ${GUID.coinScript}, type: 3}
  m_EditorClassIdentifier: Assembly-CSharp::Coin
`;
    const result = extract(src, 'Assets/prefabs/Coin.prefab');

    expect(nodeNames(result)).toEqual(['Coin', 'Coin.prefab']);
    expect(edgePairs(result)).toEqual(['contains:Coin.prefab->Coin']);
    expect(refNames(result)).toEqual([`references:unity-yaml:script:${GUID.coinScript}`]);

    const coin = nodeByName(result, 'Coin')!;
    expect(coin.kind).toBe('component');
    expect(coin.language).toBe('unity_yaml');
    // Signature is the ordered component-type list; the MonoBehaviour resolves
    // to its class via m_EditorClassIdentifier's tail.
    expect(coin.signature).toBe('Transform, Coin');

    const file = nodeByName(result, 'Coin.prefab')!;
    expect(file.kind).toBe('file');
  });

  it('CRLF and LF checkouts produce byte-identical nodes, edges, and refs', () => {
    // A Windows checkout (or `* text=auto` normalization) can deliver CRLF; the
    // extractor must strip the trailing \r so every captured scalar and the graph
    // it produces are identical to the LF form.
    const lf = `${HEADER}
--- !u!1 &100
GameObject:
  m_Component:
  - component: {fileID: 200}
  - component: {fileID: 300}
  m_Name: Coin
  m_IsActive: 1
--- !u!4 &200
Transform:
  m_GameObject: {fileID: 100}
  m_Father: {fileID: 0}
--- !u!114 &300
MonoBehaviour:
  m_GameObject: {fileID: 100}
  m_Script: {fileID: 11500000, guid: ${GUID.coinScript}, type: 3}
  m_EditorClassIdentifier: Assembly-CSharp::Coin
`;
    const crlf = lf.replace(/\n/g, '\r\n');
    const a = extract(lf, 'Assets/prefabs/Coin.prefab');
    const b = extract(crlf, 'Assets/prefabs/Coin.prefab');

    expect(fingerprint(b)).toEqual(fingerprint(a));
    // Guard against "identical because both are empty".
    expect(nodeNames(a)).toEqual(['Coin', 'Coin.prefab']);
    expect(refNames(a)).toEqual([`references:unity-yaml:script:${GUID.coinScript}`]);
  });

  it('hierarchy: a script-less ancestor is kept for containment; pure decoration is pruned to a summary', () => {
    // Level (no script) > Player (PlayerController) and Level > Decor (no script) > 3 bones (no script).
    const src = `${HEADER}
--- !u!1 &1
GameObject:
  m_Component:
  - component: {fileID: 2}
  m_Name: Level
  m_IsActive: 1
--- !u!4 &2
Transform:
  m_GameObject: {fileID: 1}
  m_Children:
  - {fileID: 12}
  - {fileID: 32}
  m_Father: {fileID: 0}
--- !u!1 &11
GameObject:
  m_Component:
  - component: {fileID: 12}
  - component: {fileID: 13}
  m_Name: Player
  m_IsActive: 1
--- !u!4 &12
Transform:
  m_GameObject: {fileID: 11}
  m_Father: {fileID: 2}
--- !u!114 &13
MonoBehaviour:
  m_GameObject: {fileID: 11}
  m_Script: {fileID: 11500000, guid: ${GUID.playerController}, type: 3}
  m_EditorClassIdentifier: Assembly-CSharp::PlayerController
--- !u!1 &31
GameObject:
  m_Component:
  - component: {fileID: 32}
  m_Name: Decor
  m_IsActive: 1
--- !u!4 &32
Transform:
  m_GameObject: {fileID: 31}
  m_Children:
  - {fileID: 42}
  - {fileID: 52}
  - {fileID: 62}
  m_Father: {fileID: 2}
--- !u!1 &41
GameObject:
  m_Component:
  - component: {fileID: 42}
  m_Name: Bone_A
--- !u!4 &42
Transform:
  m_GameObject: {fileID: 41}
  m_Father: {fileID: 32}
--- !u!1 &51
GameObject:
  m_Component:
  - component: {fileID: 52}
  m_Name: Bone_B
--- !u!4 &52
Transform:
  m_GameObject: {fileID: 51}
  m_Father: {fileID: 32}
--- !u!1 &61
GameObject:
  m_Component:
  - component: {fileID: 62}
  m_Name: Bone_C
--- !u!4 &62
Transform:
  m_GameObject: {fileID: 61}
  m_Father: {fileID: 32}
`;
    const result = extract(src, 'Assets/Scenes/Game.unity');

    // Only the scene file, the kept ancestor (Level), and the scripted GO
    // (Player). Decor and its 3 bones produce NO nodes.
    expect(nodeNames(result)).toEqual(['Game.unity', 'Level', 'Player']);
    expect(edgePairs(result)).toEqual([
      'contains:Game.unity->Level',
      'contains:Level->Player',
    ]);
    expect(refNames(result)).toEqual([`references:unity-yaml:script:${GUID.playerController}`]);

    // The pruned decoration subtree is summarized on its nearest kept ancestor,
    // never expanded into nodes (the 300-bone-rig explosion guard).
    const level = nodeByName(result, 'Level')!;
    expect(level.docstring ?? '').toMatch(/decorat/i);
    expect(nodeByName(result, 'Decor')).toBeUndefined();
    expect(nodeByName(result, 'Bone_A')).toBeUndefined();
  });

  it('PrefabInstance: m_Name override is kept as metadata, never applied to the node name; source prefab is referenced', () => {
    const src = `${HEADER}
--- !u!1 &1
GameObject:
  m_Component:
  - component: {fileID: 2}
  m_Name: Level
--- !u!4 &2
Transform:
  m_GameObject: {fileID: 1}
  m_Father: {fileID: 0}
--- !u!1001 &900
PrefabInstance:
  m_Modification:
    m_TransformParent: {fileID: 2}
    m_Modifications:
    - target: {fileID: 555, guid: ${GUID.coinScript}, type: 3}
      propertyPath: m_Name
      value: BonusCoin
      objectReference: {fileID: 0}
    - target: {fileID: 777, guid: ${GUID.coinScript}, type: 3}
      propertyPath: value
      value: 5
      objectReference: {fileID: 0}
  m_SourcePrefab: {fileID: 100100000, guid: ${GUID.coinScript}, type: 3}
`;
    const result = extract(src, 'Assets/Scenes/Game.unity');

    // The instance is named conservatively — we cannot prove the m_Name override
    // targets the source prefab's root, so it is NOT used as the node name.
    expect(nodeNames(result)).toContain('PrefabInstance');
    expect(nodeNames(result)).not.toContain('BonusCoin');
    expect(nodeNames(result)).not.toContain('Coin');
    // Nested under its transform-parent (Level), which is kept as an ancestor.
    expect(edgePairs(result)).toContain('contains:Level->PrefabInstance');
    // Source prefab is referenced by GUID — the instance's identity is carried
    // by this edge, not by a guessed name.
    expect(refNames(result)).toContain(`references:unity-yaml:asset:${GUID.coinScript}`);

    // The override is preserved as metadata (with the id it targets), never lost.
    const inst = nodeByName(result, 'PrefabInstance')!;
    expect(inst.kind).toBe('component');
    expect(inst.docstring ?? '').toContain('BonusCoin');
    expect(inst.docstring ?? '').toContain('555');
  });

  it('PrefabInstance with only a child renamed: the instance root is NOT named after the child override', () => {
    // The override targets some object inside the source prefab; at extract time
    // we cannot prove it is the root, so the instance node is never named "Torso".
    // This is the failure the conservative naming rule exists to prevent.
    const src = `${HEADER}
--- !u!1 &1
GameObject:
  m_Component:
  - component: {fileID: 2}
  m_Name: Level
--- !u!4 &2
Transform:
  m_GameObject: {fileID: 1}
  m_Father: {fileID: 0}
--- !u!1001 &900
PrefabInstance:
  m_Modification:
    m_TransformParent: {fileID: 2}
    m_Modifications:
    - target: {fileID: 123456, guid: ${GUID.enemyPrefab}, type: 3}
      propertyPath: m_Name
      value: Torso
      objectReference: {fileID: 0}
  m_SourcePrefab: {fileID: 100100000, guid: ${GUID.enemyPrefab}, type: 3}
`;
    const result = extract(src, 'Assets/Scenes/Game.unity');

    expect(nodeNames(result)).not.toContain('Torso');
    expect(nodeNames(result)).toContain('PrefabInstance');
    // Still preserved as metadata (target-id:value), just never applied.
    const inst = nodeByName(result, 'PrefabInstance')!;
    expect(inst.docstring ?? '').toContain('123456:Torso');
  });

  it('m_AddedComponents: an added script component emits a script ref from the instance', () => {
    // A prefab instance of Weapon with an EnemyAI MonoBehaviour added on top.
    const src = `${HEADER}
--- !u!1 &1
GameObject:
  m_Component:
  - component: {fileID: 2}
  m_Name: Root
--- !u!4 &2
Transform:
  m_GameObject: {fileID: 1}
  m_Father: {fileID: 0}
--- !u!1001 &900
PrefabInstance:
  m_Modification:
    m_TransformParent: {fileID: 2}
    m_Modifications: []
    m_AddedComponents:
    - targetCorrespondingSourceObject: {fileID: 484176316724941476, guid: ${GUID.weaponPrefab}, type: 3}
      insertIndex: -1
      addedObject: {fileID: 901}
  m_SourcePrefab: {fileID: 100100000, guid: ${GUID.weaponPrefab}, type: 3}
--- !u!114 &901
MonoBehaviour:
  m_GameObject: {fileID: 0}
  m_PrefabInstance: {fileID: 900}
  m_Script: {fileID: 11500000, guid: ${GUID.enemyAI}, type: 3}
  m_EditorClassIdentifier: Assembly-CSharp::EnemyAI
`;
    const result = extract(src, 'Assets/prefabs/Combo.prefab');

    // Both the source-prefab ref and the added-component script ref surface.
    expect(refNames(result)).toContain(`references:unity-yaml:asset:${GUID.weaponPrefab}`);
    expect(refNames(result)).toContain(`references:unity-yaml:script:${GUID.enemyAI}`);
  });

  it('nested prefab (Unity 6.5 direct form): child PrefabInstance node + source ref, nested under its holder', () => {
    // Enemy (script) > WeaponHolder (no script) > Weapon (PrefabInstance, no stripped stub).
    const src = `${HEADER}
--- !u!1 &10
GameObject:
  m_Component:
  - component: {fileID: 11}
  - component: {fileID: 12}
  m_Name: Enemy
--- !u!4 &11
Transform:
  m_GameObject: {fileID: 10}
  m_Children:
  - {fileID: 21}
  m_Father: {fileID: 0}
--- !u!114 &12
MonoBehaviour:
  m_GameObject: {fileID: 10}
  m_Script: {fileID: 11500000, guid: ${GUID.enemyAI}, type: 3}
  m_EditorClassIdentifier: Assembly-CSharp::EnemyAI
--- !u!1 &20
GameObject:
  m_Component:
  - component: {fileID: 21}
  m_Name: WeaponHolder
--- !u!4 &21
Transform:
  m_GameObject: {fileID: 20}
  m_Children:
  - {fileID: 901}
  m_Father: {fileID: 11}
--- !u!1001 &900
PrefabInstance:
  m_Modification:
    m_TransformParent: {fileID: 21}
    m_Modifications:
    - target: {fileID: 484176316724941476, guid: ${GUID.weaponPrefab}, type: 3}
      propertyPath: m_Name
      value: Weapon
      objectReference: {fileID: 0}
  m_SourcePrefab: {fileID: 100100000, guid: ${GUID.weaponPrefab}, type: 3}
`;
    const result = extract(src, 'Assets/prefabs/Enemy.prefab');

    // The nested instance is named conservatively ("PrefabInstance"), not from
    // its m_Name override — its identity is carried by the source-prefab ref.
    expect(nodeNames(result)).toEqual(['Enemy', 'Enemy.prefab', 'PrefabInstance', 'WeaponHolder'].sort());
    expect(edgePairs(result)).toEqual([
      'contains:Enemy.prefab->Enemy',
      'contains:Enemy->WeaponHolder',
      'contains:WeaponHolder->PrefabInstance',
    ].sort());
    expect(refNames(result)).toEqual([
      `references:unity-yaml:asset:${GUID.weaponPrefab}`,
      `references:unity-yaml:script:${GUID.enemyAI}`,
    ].sort());
  });

  it('nested prefab (older stripped-stub form): stripped Transform stub resolves to its instance', () => {
    // The real Enemy.prefab shape: PrefabInstance + a `stripped` Transform stub
    // that carries the m_PrefabInstance back-reference into the local hierarchy.
    const src = `${HEADER}
--- !u!1 &10
GameObject:
  m_Component:
  - component: {fileID: 11}
  - component: {fileID: 12}
  m_Name: Enemy
--- !u!4 &11
Transform:
  m_GameObject: {fileID: 10}
  m_Children:
  - {fileID: 21}
  m_Father: {fileID: 0}
--- !u!114 &12
MonoBehaviour:
  m_GameObject: {fileID: 10}
  m_Script: {fileID: 11500000, guid: ${GUID.enemyAI}, type: 3}
  m_EditorClassIdentifier: Assembly-CSharp::EnemyAI
--- !u!1 &20
GameObject:
  m_Component:
  - component: {fileID: 21}
  m_Name: WeaponHolder
--- !u!4 &21
Transform:
  m_GameObject: {fileID: 20}
  m_Children:
  - {fileID: 5026491508943727811}
  m_Father: {fileID: 11}
--- !u!1001 &900
PrefabInstance:
  m_Modification:
    m_TransformParent: {fileID: 21}
    m_Modifications:
    - target: {fileID: 484176316724941476, guid: ${GUID.weaponPrefab}, type: 3}
      propertyPath: m_Name
      value: Weapon
      objectReference: {fileID: 0}
  m_SourcePrefab: {fileID: 100100000, guid: ${GUID.weaponPrefab}, type: 3}
--- !u!4 &5026491508943727811 stripped
Transform:
  m_CorrespondingSourceObject: {fileID: 16247439616150751, guid: ${GUID.weaponPrefab}, type: 3}
  m_PrefabInstance: {fileID: 900}
  m_PrefabAsset: {fileID: 0}
`;
    const result = extract(src, 'Assets/prefabs/Enemy.prefab');

    // Same graph as the direct form — the stripped stub must not become a node,
    // and the instance is named conservatively ("PrefabInstance").
    expect(nodeNames(result)).toEqual(['Enemy', 'Enemy.prefab', 'PrefabInstance', 'WeaponHolder'].sort());
    expect(edgePairs(result)).toEqual([
      'contains:Enemy.prefab->Enemy',
      'contains:Enemy->WeaponHolder',
      'contains:WeaponHolder->PrefabInstance',
    ].sort());
    expect(refNames(result)).toEqual([
      `references:unity-yaml:asset:${GUID.weaponPrefab}`,
      `references:unity-yaml:script:${GUID.enemyAI}`,
    ].sort());
  });

  it('scene-object field wire: a serialized {fileID} field → intra-file references edge to the target GameObject', () => {
    // Main Camera's CameraFollow.target points at Player's Transform fileID.
    const src = `${HEADER}
--- !u!1 &100
GameObject:
  m_Component:
  - component: {fileID: 101}
  - component: {fileID: 102}
  m_Name: Main Camera
--- !u!4 &101
Transform:
  m_GameObject: {fileID: 100}
  m_Father: {fileID: 0}
--- !u!114 &102
MonoBehaviour:
  m_GameObject: {fileID: 100}
  m_Script: {fileID: 11500000, guid: ${GUID.cameraFollow}, type: 3}
  m_EditorClassIdentifier: Assembly-CSharp::CameraFollow
  target: {fileID: 201}
  smooth: 5
--- !u!1 &200
GameObject:
  m_Component:
  - component: {fileID: 201}
  - component: {fileID: 202}
  m_Name: Player
--- !u!4 &201
Transform:
  m_GameObject: {fileID: 200}
  m_Father: {fileID: 0}
--- !u!114 &202
MonoBehaviour:
  m_GameObject: {fileID: 200}
  m_Script: {fileID: 11500000, guid: ${GUID.playerController}, type: 3}
  m_EditorClassIdentifier: Assembly-CSharp::PlayerController
`;
    const result = extract(src, 'Assets/Scenes/Game.unity');

    // The field wire is same-file, so it's a DIRECT edge (Main Camera → Player).
    expect(edgePairs(result)).toContain('references:Main Camera->Player');
    // Both GameObjects carry their own script refs.
    expect(refNames(result)).toEqual([
      `references:unity-yaml:script:${GUID.cameraFollow}`,
      `references:unity-yaml:script:${GUID.playerController}`,
    ].sort());
  });

  it('scene-object field wire to a decoration-pruned target emits nothing (never fabricates the target node)', () => {
    // Scripted "Watcher" has a field pointing at a plain decoration GameObject
    // that carries no script and is nobody's scripted ancestor, so it has no
    // node. The wire has nothing to point at and is dropped — we do NOT invent a
    // "Decoration" node just to satisfy the reference.
    const src = `${HEADER}
--- !u!1 &100
GameObject:
  m_Component:
  - component: {fileID: 101}
  - component: {fileID: 102}
  m_Name: Watcher
--- !u!4 &101
Transform:
  m_GameObject: {fileID: 100}
  m_Father: {fileID: 0}
--- !u!114 &102
MonoBehaviour:
  m_GameObject: {fileID: 100}
  m_Script: {fileID: 11500000, guid: ${GUID.cameraFollow}, type: 3}
  m_EditorClassIdentifier: Assembly-CSharp::CameraFollow
  target: {fileID: 201}
--- !u!1 &200
GameObject:
  m_Component:
  - component: {fileID: 201}
  m_Name: Decoration
--- !u!4 &201
Transform:
  m_GameObject: {fileID: 200}
  m_Father: {fileID: 0}
`;
    const result = extract(src, 'Assets/Scenes/Game.unity');

    // Watcher is a node (scripted); Decoration is pruned; no references edge.
    expect(nodeNames(result)).toEqual(['Game.unity', 'Watcher']);
    expect(nodeByName(result, 'Decoration')).toBeUndefined();
    expect(edgePairs(result).some((e) => e.startsWith('references:'))).toBe(false);
  });

  it('prefab-asset field wire: a serialized {fileID, guid} field → cross-file asset ref', () => {
    const src = `${HEADER}
--- !u!1 &100
GameObject:
  m_Component:
  - component: {fileID: 101}
  - component: {fileID: 102}
  m_Name: EnemySpawner
--- !u!4 &101
Transform:
  m_GameObject: {fileID: 100}
  m_Father: {fileID: 0}
--- !u!114 &102
MonoBehaviour:
  m_GameObject: {fileID: 100}
  m_Script: {fileID: 11500000, guid: ${GUID.enemySpawner}, type: 3}
  m_EditorClassIdentifier: Assembly-CSharp::EnemySpawner
  enemyPrefab: {fileID: 4487460391369444348, guid: ${GUID.enemyPrefab}, type: 3}
  spawnInterval: 4
`;
    const result = extract(src, 'Assets/Scenes/Game.unity');

    expect(refNames(result)).toEqual([
      `references:unity-yaml:asset:${GUID.enemyPrefab}`,
      `references:unity-yaml:script:${GUID.enemySpawner}`,
    ].sort());
  });

  it('UnityEvent persistent calls (real Part F shape): onDeath (our field) and m_OnClick (package Button) → one event ref each, keyed by target type', () => {
    // Verbatim from tester-01: PlayerHealth.onDeath and Button.m_OnClick both
    // persistently invoke GameManager.ResetScore. m_Target is a scene-local
    // component fileID (not a MonoScript guid); the type comes from
    // m_TargetAssemblyTypeName, so BOTH shapes parse the same way — the host
    // block's own m_Script guid is irrelevant to the target type.
    const src = `${HEADER}
--- !u!1 &975176587
GameObject:
  m_Component:
  - component: {fileID: 975176588}
  - component: {fileID: 975176589}
  m_Name: Player
  m_IsActive: 1
--- !u!4 &975176588
Transform:
  m_GameObject: {fileID: 975176587}
  m_Father: {fileID: 0}
--- !u!114 &975176589
MonoBehaviour:
  m_GameObject: {fileID: 975176587}
  m_Script: {fileID: 11500000, guid: ${GUID.playerHealth}, type: 3}
  m_EditorClassIdentifier: Assembly-CSharp::PlayerHealth
  maxHealth: 100
  currentHealth: 0
  onDeath:
    m_PersistentCalls:
      m_Calls:
      - m_Target: {fileID: 1357023918}
        m_TargetAssemblyTypeName: GameManager, Assembly-CSharp
        m_MethodName: ResetScore
        m_Mode: 0
        m_Arguments:
          m_ObjectArgument: {fileID: 0}
          m_ObjectArgumentAssemblyTypeName:
          m_IntArgument: 0
          m_FloatArgument: 0
          m_StringArgument:
          m_BoolArgument: 0
        m_CallState: 2
--- !u!1 &483588818
GameObject:
  m_Component:
  - component: {fileID: 483588819}
  - component: {fileID: 483588820}
  m_Name: RestartButton
  m_IsActive: 1
--- !u!224 &483588819
RectTransform:
  m_GameObject: {fileID: 483588818}
  m_Father: {fileID: 0}
--- !u!114 &483588820
MonoBehaviour:
  m_GameObject: {fileID: 483588818}
  m_Script: {fileID: 11500000, guid: ${GUID.uiButton}, type: 3}
  m_EditorClassIdentifier: UnityEngine.UI::UnityEngine.UI.Button
  m_Interactable: 1
  m_OnClick:
    m_PersistentCalls:
      m_Calls:
      - m_Target: {fileID: 1357023918}
        m_TargetAssemblyTypeName: GameManager, Assembly-CSharp
        m_MethodName: ResetScore
        m_Mode: 0
        m_Arguments:
          m_ObjectArgument: {fileID: 0}
          m_ObjectArgumentAssemblyTypeName:
          m_IntArgument: 0
          m_FloatArgument: 0
          m_StringArgument:
          m_BoolArgument: 0
        m_CallState: 2
--- !u!1 &1357023917
GameObject:
  m_Component:
  - component: {fileID: 1357023919}
  - component: {fileID: 1357023918}
  m_Name: GameManager
  m_IsActive: 1
--- !u!4 &1357023919
Transform:
  m_GameObject: {fileID: 1357023917}
  m_Father: {fileID: 0}
--- !u!114 &1357023918
MonoBehaviour:
  m_GameObject: {fileID: 1357023917}
  m_Script: {fileID: 11500000, guid: ${GUID.gameManager}, type: 3}
  m_EditorClassIdentifier: Assembly-CSharp::GameManager
  score: 0
`;
    const result = extract(src, 'Assets/Scenes/Game.unity');

    // Exactly two event refs, both keyed by the TARGET type (GameManager), one
    // attributed to each host field site (Player's PlayerHealth, RestartButton's
    // Button) — proving the user-field and package-field shapes both parse.
    const eventRefs = result.unresolvedReferences.filter(
      (r) => r.referenceName === 'unity-yaml:event:GameManager:ResetScore'
    );
    expect(eventRefs.length).toBe(2);
    const names = idToName(result);
    expect(eventRefs.map((r) => names.get(r.fromNodeId)).sort()).toEqual(['Player', 'RestartButton']);

    // Each host still carries its own script ref (the Button's ugui guid is
    // never indexed → correct silence at resolution, but the ref is still emitted).
    expect(refNames(result)).toContain(`references:unity-yaml:script:${GUID.playerHealth}`);
    expect(refNames(result)).toContain(`references:unity-yaml:script:${GUID.uiButton}`);
    expect(refNames(result)).toContain(`references:unity-yaml:script:${GUID.gameManager}`);
  });

  it('UnityEvent persistent call with an empty m_TargetAssemblyTypeName emits no event ref', () => {
    // A cleared/unassigned target type carries no resolvable class name → nothing
    // (emit-nothing discipline: a missed edge beats a fabricated one).
    const src = `${HEADER}
--- !u!1 &100
GameObject:
  m_Component:
  - component: {fileID: 101}
  - component: {fileID: 102}
  m_Name: Player
--- !u!4 &101
Transform:
  m_GameObject: {fileID: 100}
  m_Father: {fileID: 0}
--- !u!114 &102
MonoBehaviour:
  m_GameObject: {fileID: 100}
  m_Script: {fileID: 11500000, guid: ${GUID.playerHealth}, type: 3}
  m_EditorClassIdentifier: Assembly-CSharp::PlayerHealth
  onDeath:
    m_PersistentCalls:
      m_Calls:
      - m_Target: {fileID: 1357023918}
        m_TargetAssemblyTypeName:
        m_MethodName: ResetScore
        m_Mode: 0
`;
    const result = extract(src, 'Assets/Scenes/Game.unity');

    expect(refNames(result).some((r) => r.includes(':event:'))).toBe(false);
    // The host script ref is still emitted.
    expect(refNames(result)).toContain(`references:unity-yaml:script:${GUID.playerHealth}`);
  });

  it('UnityEvent persistent call with a cleared m_Target (fileID 0) emits no event ref', () => {
    // fileID 0 = no assigned receiver; even with a type name present there is no
    // live call, so nothing is emitted.
    const src = `${HEADER}
--- !u!1 &100
GameObject:
  m_Component:
  - component: {fileID: 101}
  - component: {fileID: 102}
  m_Name: Player
--- !u!4 &101
Transform:
  m_GameObject: {fileID: 100}
  m_Father: {fileID: 0}
--- !u!114 &102
MonoBehaviour:
  m_GameObject: {fileID: 100}
  m_Script: {fileID: 11500000, guid: ${GUID.playerHealth}, type: 3}
  m_EditorClassIdentifier: Assembly-CSharp::PlayerHealth
  onDeath:
    m_PersistentCalls:
      m_Calls:
      - m_Target: {fileID: 0}
        m_TargetAssemblyTypeName: GameManager, Assembly-CSharp
        m_MethodName: ResetScore
        m_Mode: 0
`;
    const result = extract(src, 'Assets/Scenes/Game.unity');

    expect(refNames(result).some((r) => r.includes(':event:'))).toBe(false);
    expect(refNames(result)).toContain(`references:unity-yaml:script:${GUID.playerHealth}`);
  });

  it('decoration-only prefab: emits a file node (so it is a resolvable asset target) but no GameObject nodes', () => {
    // Weapon.prefab shape: a root + mesh children, no scripts anywhere.
    const src = `${HEADER}
--- !u!1 &10
GameObject:
  m_Component:
  - component: {fileID: 11}
  m_Name: Weapon
--- !u!4 &11
Transform:
  m_GameObject: {fileID: 10}
  m_Children:
  - {fileID: 21}
  m_Father: {fileID: 0}
--- !u!1 &20
GameObject:
  m_Component:
  - component: {fileID: 21}
  - component: {fileID: 22}
  m_Name: Blade
--- !u!4 &21
Transform:
  m_GameObject: {fileID: 20}
  m_Father: {fileID: 11}
--- !u!33 &22
MeshFilter:
  m_GameObject: {fileID: 20}
`;
    const result = extract(src, 'Assets/prefabs/Weapon.prefab');

    expect(nodeNames(result)).toEqual(['Weapon.prefab']);
    expect(result.edges).toEqual([]);
    expect(result.unresolvedReferences).toEqual([]);
  });

  it('non-Unity YAML emits nothing', () => {
    const src = `name: CI
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;
    const result = extract(src, 'Assets/weird/workflow.asset');
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.unresolvedReferences).toEqual([]);
  });

  it('binary-serialized asset (no %YAML header) emits nothing', () => {
    // Force-Binary assets have no text YAML header; we must not misparse them.
    const src = ' BinaryUnityFile  m_Script guid junk';
    const result = extract(src, 'Assets/Settings/PC_RPAsset.asset');
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.unresolvedReferences).toEqual([]);
  });

  it('ScriptableObject .asset: top-level MonoBehaviour → file node + script ref (stretch, node + m_Script link only)', () => {
    const src = `${HEADER}
--- !u!114 &11400000
MonoBehaviour:
  m_ObjectHideFlags: 0
  m_GameObject: {fileID: 0}
  m_Script: {fileID: 11500000, guid: ${GUID.enemySpawner}, type: 3}
  m_Name: SpawnConfig
  m_EditorClassIdentifier: Assembly-CSharp::SpawnConfig
`;
    const result = extract(src, 'Assets/Settings/SpawnConfig.asset');
    // A ScriptableObject has no GameObject hierarchy; just the file node and the
    // MonoBehaviour's script link.
    expect(nodeNames(result)).toEqual(['SpawnConfig.asset']);
    expect(refNames(result)).toEqual([`references:unity-yaml:script:${GUID.enemySpawner}`]);
  });
});

// ===========================================================================
// Resolver
// ===========================================================================

describe('unityAssetResolver', () => {
  it('is registered in the framework resolver registry under "unity-assets"', () => {
    expect(getFrameworkResolver('unity-assets')).toBe(unityAssetResolver);
  });

  it('claimsReference only for its own unity-yaml: prefixes, never the C# resolver ones', () => {
    expect(unityAssetResolver.claimsReference!(`unity-yaml:script:${GUID.coinScript}`)).toBe(true);
    expect(unityAssetResolver.claimsReference!(`unity-yaml:asset:${GUID.enemyPrefab}`)).toBe(true);
    expect(unityAssetResolver.claimsReference!('unity-yaml:event:GameManager:ResetScore')).toBe(true);
    expect(unityAssetResolver.claimsReference!('SomeClass')).toBe(false);
    // The C# Unity resolver owns unity:host: / unity:field: / unity:method: — the
    // YAML resolver must NOT claim any of them (finding 4: the method form used to
    // collide, disambiguated only by the language guard).
    expect(unityAssetResolver.claimsReference!('unity:host:Player.Update')).toBe(false);
    expect(unityAssetResolver.claimsReference!('unity:field:Player.health')).toBe(false);
    expect(unityAssetResolver.claimsReference!('unity:method:Player.Move')).toBe(false);
  });

  it('detect() is true for a Unity project and false otherwise', () => {
    const unity = makeContext({
      fileExists: (p) => p === 'ProjectSettings/ProjectVersion.txt',
    });
    expect(unityAssetResolver.detect(unity)).toBe(true);

    const notUnity = makeContext();
    expect(unityAssetResolver.detect(notUnity)).toBe(false);
  });

  it('resolves unity-yaml:script:<guid> to the primary class node via the sibling .meta GUID map', () => {
    const coinClass = makeSymbol({
      id: 'class:coin',
      kind: 'class',
      name: 'Coin',
      filePath: 'Assets/Scripts/Coin.cs',
      startLine: 1,
      endLine: 20,
    });
    const ctx = makeContext({
      getAllFiles: () => ['Assets/Scripts/Coin.cs', 'Assets/prefabs/Coin.prefab'],
      readFile: (p) => {
        if (p === 'Assets/Scripts/Coin.cs.meta') return `fileFormatVersion: 2\nguid: ${GUID.coinScript}`;
        if (p === 'Assets/prefabs/Coin.prefab.meta') return `fileFormatVersion: 2\nguid: ef398c0cee743e8458f0c7abb7ee59b4`;
        return null;
      },
      getNodesInFile: (p) => (p === 'Assets/Scripts/Coin.cs' ? [coinClass] : []),
    });

    const resolved = unityAssetResolver.resolve(
      makeRef({ referenceName: `unity-yaml:script:${GUID.coinScript}` }),
      ctx
    );
    expect(resolved?.targetNodeId).toBe('class:coin');
  });

  it('resolves unity-yaml:asset:<guid> to the prefab file node', () => {
    const prefabFile = makeSymbol({
      id: 'file:enemy-prefab',
      kind: 'file',
      name: 'Enemy.prefab',
      filePath: 'Assets/prefabs/Enemy.prefab',
      startLine: 1,
      endLine: 100,
      language: 'unity_yaml',
    });
    const ctx = makeContext({
      getAllFiles: () => ['Assets/prefabs/Enemy.prefab'],
      readFile: (p) =>
        p === 'Assets/prefabs/Enemy.prefab.meta' ? `fileFormatVersion: 2\nguid: ${GUID.enemyPrefab}` : null,
      getNodesInFile: (p) => (p === 'Assets/prefabs/Enemy.prefab' ? [prefabFile] : []),
    });

    const resolved = unityAssetResolver.resolve(
      makeRef({ referenceName: `unity-yaml:asset:${GUID.enemyPrefab}` }),
      ctx
    );
    expect(resolved?.targetNodeId).toBe('file:enemy-prefab');
  });

  it('resolves unity-yaml:event:<Type>:<name> to the uniquely-named method on the indexed class', () => {
    const gmClass = makeSymbol({
      id: 'class:gm',
      kind: 'class',
      name: 'GameManager',
      filePath: 'Assets/Scripts/GameManager.cs',
      startLine: 1,
      endLine: 20,
    });
    const method = makeSymbol({
      id: 'method:resetscore',
      kind: 'method',
      name: 'ResetScore',
      filePath: 'Assets/Scripts/GameManager.cs',
      startLine: 10,
      endLine: 14,
    });
    const ctx = makeContext({
      getNodesByName: (n) => (n === 'GameManager' ? [gmClass] : []),
      getNodesInFile: (p) => (p === 'Assets/Scripts/GameManager.cs' ? [gmClass, method] : []),
    });

    const resolved = unityAssetResolver.resolve(
      makeRef({ referenceName: 'unity-yaml:event:GameManager:ResetScore' }),
      ctx
    );
    expect(resolved?.targetNodeId).toBe('method:resetscore');
  });

  it('resolves a namespaced m_TargetAssemblyTypeName by its bare (last dot-segment) class name', () => {
    const gmClass = makeSymbol({
      id: 'class:gm',
      kind: 'class',
      name: 'GameManager',
      filePath: 'Assets/Scripts/GameManager.cs',
      startLine: 1,
      endLine: 20,
    });
    const method = makeSymbol({
      id: 'method:resetscore',
      kind: 'method',
      name: 'ResetScore',
      filePath: 'Assets/Scripts/GameManager.cs',
      startLine: 10,
      endLine: 14,
    });
    const ctx = makeContext({
      getNodesByName: (n) => (n === 'GameManager' ? [gmClass] : []),
      getNodesInFile: (p) => (p === 'Assets/Scripts/GameManager.cs' ? [gmClass, method] : []),
    });

    const resolved = unityAssetResolver.resolve(
      makeRef({ referenceName: 'unity-yaml:event:CoinDash.Systems.GameManager:ResetScore' }),
      ctx
    );
    expect(resolved?.targetNodeId).toBe('method:resetscore');
  });

  it('emits nothing for a UnityEvent target type with no source in the project (package type)', () => {
    // Button lives in a Unity package (not indexed) → no class node → correct
    // silence, exactly as for the fixture's real Button.m_OnClick target-type.
    const ctx = makeContext({ getNodesByName: () => [] });
    const resolved = unityAssetResolver.resolve(
      makeRef({ referenceName: 'unity-yaml:event:Button:onClick' }),
      ctx
    );
    expect(resolved).toBeNull();
  });

  it('emits nothing for an overloaded UnityEvent target method (the YAML carries no parameter list)', () => {
    const gmClass = makeSymbol({ id: 'class:gm', kind: 'class', name: 'GameManager', filePath: 'Assets/Scripts/GameManager.cs', startLine: 1, endLine: 30 });
    const m1 = makeSymbol({ id: 'method:reset1', kind: 'method', name: 'ResetScore', filePath: 'Assets/Scripts/GameManager.cs', startLine: 10, endLine: 12 });
    const m2 = makeSymbol({ id: 'method:reset2', kind: 'method', name: 'ResetScore', filePath: 'Assets/Scripts/GameManager.cs', startLine: 14, endLine: 16 });
    const ctx = makeContext({
      getNodesByName: (n) => (n === 'GameManager' ? [gmClass] : []),
      getNodesInFile: (p) => (p === 'Assets/Scripts/GameManager.cs' ? [gmClass, m1, m2] : []),
    });
    const resolved = unityAssetResolver.resolve(
      makeRef({ referenceName: 'unity-yaml:event:GameManager:ResetScore' }),
      ctx
    );
    expect(resolved).toBeNull();
  });

  it('emits nothing when the UnityEvent target class name is ambiguous (two indexed classes share it)', () => {
    const a = makeSymbol({ id: 'class:gm1', kind: 'class', name: 'GameManager', filePath: 'A/GameManager.cs', startLine: 1, endLine: 10 });
    const b = makeSymbol({ id: 'class:gm2', kind: 'class', name: 'GameManager', filePath: 'B/GameManager.cs', startLine: 1, endLine: 10 });
    const ctx = makeContext({ getNodesByName: (n) => (n === 'GameManager' ? [a, b] : []) });
    const resolved = unityAssetResolver.resolve(
      makeRef({ referenceName: 'unity-yaml:event:GameManager:ResetScore' }),
      ctx
    );
    expect(resolved).toBeNull();
  });

  it('emits nothing for an unresolvable GUID (package script not indexed)', () => {
    const ctx = makeContext({
      getAllFiles: () => ['Assets/Scripts/Coin.cs'],
      readFile: (p) =>
        p === 'Assets/Scripts/Coin.cs.meta' ? `fileFormatVersion: 2\nguid: ${GUID.coinScript}` : null,
      getNodesInFile: () => [],
    });
    // A URP package script GUID that isn't in the indexed project.
    const resolved = unityAssetResolver.resolve(
      makeRef({ referenceName: 'unity-yaml:script:474bcb49853aa07438625e644c072ee6' }),
      ctx
    );
    expect(resolved).toBeNull();
  });

  it('emits nothing when the target class is ambiguous (no filename-matching primary)', () => {
    // Two classes in the file, neither named for the file — resolution refuses
    // to guess (a missed edge beats a fabricated one).
    const a = makeSymbol({ id: 'class:a', kind: 'class', name: 'Alpha', filePath: 'Assets/Scripts/Coin.cs', startLine: 1, endLine: 5 });
    const b = makeSymbol({ id: 'class:b', kind: 'class', name: 'Beta', filePath: 'Assets/Scripts/Coin.cs', startLine: 6, endLine: 10 });
    const ctx = makeContext({
      getAllFiles: () => ['Assets/Scripts/Coin.cs'],
      readFile: (p) => (p === 'Assets/Scripts/Coin.cs.meta' ? `fileFormatVersion: 2\nguid: ${GUID.coinScript}` : null),
      getNodesInFile: (p) => (p === 'Assets/Scripts/Coin.cs' ? [a, b] : []),
    });
    const resolved = unityAssetResolver.resolve(
      makeRef({ referenceName: `unity-yaml:script:${GUID.coinScript}` }),
      ctx
    );
    expect(resolved).toBeNull();
  });

  it('does not touch references from other languages (self-guards on unity_yaml)', () => {
    const ctx = makeContext({
      getAllFiles: () => ['Assets/Scripts/Coin.cs'],
      readFile: (p) => (p === 'Assets/Scripts/Coin.cs.meta' ? `fileFormatVersion: 2\nguid: ${GUID.coinScript}` : null),
      getNodesInFile: () => [makeSymbol({ id: 'class:coin', kind: 'class', name: 'Coin', filePath: 'Assets/Scripts/Coin.cs', startLine: 1, endLine: 5 })],
    });
    const resolved = unityAssetResolver.resolve(
      makeRef({ referenceName: `unity-yaml:script:${GUID.coinScript}`, language: 'csharp' }),
      ctx
    );
    expect(resolved).toBeNull();
  });
});

// ===========================================================================
// Resolver — postExtract (PrefabInstance friendly-naming)
// ===========================================================================

describe('unityAssetResolver.postExtract', () => {
  const SCENE = 'Assets/Scenes/Game.unity';

  // A PrefabInstance node as the extractor emits it: conservative name, the
  // `#PrefabInstance` qualifiedName marker, startLine = the `!u!1001` header line.
  function instanceNode(startLine: number, name = 'PrefabInstance'): Node {
    return makeSymbol({
      id: `component:inst${startLine}`,
      kind: 'component',
      name,
      filePath: SCENE,
      startLine,
      endLine: startLine,
      language: 'unity_yaml',
      qualifiedName: `${SCENE}#PrefabInstance`,
      signature: 'PrefabInstance',
      docstring: 'prefabInstance nameOverrides=555:BonusCoin',
    });
  }

  // A scene whose only `!u!1001` document (header at line 1) sources `guid`.
  function sceneWithInstance(guid: string): string {
    return `--- !u!1001 &900
PrefabInstance:
  m_Modification:
    m_TransformParent: {fileID: 2}
    m_Modifications: []
  m_SourcePrefab: {fileID: 100100000, guid: ${guid}, type: 3}
`;
  }

  it('renames a PrefabInstance node to its source-prefab file stem (id + #PrefabInstance qualifiedName preserved)', () => {
    const inst = instanceNode(1);
    const ctx = makeContext({
      getNodesByKind: (k) => (k === 'component' ? [inst] : []),
      getAllFiles: () => ['Assets/prefabs/Enemy.prefab'],
      readFile: (p) => {
        if (p === SCENE) return sceneWithInstance(GUID.enemyPrefab);
        if (p === 'Assets/prefabs/Enemy.prefab.meta') return `fileFormatVersion: 2\nguid: ${GUID.enemyPrefab}`;
        return null;
      },
    });

    const updates = unityAssetResolver.postExtract!(ctx);
    expect(updates.length).toBe(1);
    expect(updates[0]!.id).toBe('component:inst1'); // id preserved → edges intact
    expect(updates[0]!.name).toBe('Enemy'); // renamed to the source-prefab stem
    expect(updates[0]!.qualifiedName).toBe(`${SCENE}#PrefabInstance`); // stable idempotency marker
    // The overrides metadata is left untouched.
    expect(updates[0]!.docstring).toContain('BonusCoin');
  });

  it('names the instance from the source-prefab stem (Coin), never from a child m_Name override, and preserves the nameOverrides metadata', () => {
    // The instanceNode helper carries a child override `nameOverrides=555:BonusCoin`
    // in its docstring. The rename must take the source-prefab file STEM (`Coin`),
    // never the child override value (`BonusCoin`) — the finding-2 child-rename
    // hazard the postExtract design avoids — and must leave the metadata intact.
    const inst = instanceNode(1);
    const ctx = makeContext({
      getNodesByKind: (k) => (k === 'component' ? [inst] : []),
      getAllFiles: () => ['Assets/prefabs/Coin.prefab'],
      readFile: (p) => {
        if (p === SCENE) return sceneWithInstance(GUID.coinPrefab);
        if (p === 'Assets/prefabs/Coin.prefab.meta') return `fileFormatVersion: 2\nguid: ${GUID.coinPrefab}`;
        return null;
      },
    });

    const updates = unityAssetResolver.postExtract!(ctx);
    expect(updates.length).toBe(1);
    expect(updates[0]!.name).toBe('Coin'); // source-prefab file stem
    expect(updates[0]!.name).not.toBe('BonusCoin'); // never the child override — child-rename hazard avoided
    expect(updates[0]!.docstring).toContain('nameOverrides=555:BonusCoin'); // metadata preserved verbatim
  });

  it('leaves an instance conservatively named when its source guid is unindexed (package prefab)', () => {
    const inst = instanceNode(1);
    const ctx = makeContext({
      getNodesByKind: (k) => (k === 'component' ? [inst] : []),
      // The source guid maps to no indexed asset (a package prefab under Library/).
      getAllFiles: () => [],
      readFile: (p) => (p === SCENE ? sceneWithInstance('ffffffffffffffffffffffffffffffff') : null),
    });

    expect(unityAssetResolver.postExtract!(ctx)).toEqual([]);
  });

  it('is idempotent: an already-renamed instance re-derives the same stem and yields no update', () => {
    const inst = instanceNode(1, 'Enemy'); // name already upgraded; qualifiedName still #PrefabInstance
    const ctx = makeContext({
      getNodesByKind: (k) => (k === 'component' ? [inst] : []),
      getAllFiles: () => ['Assets/prefabs/Enemy.prefab'],
      readFile: (p) => {
        if (p === SCENE) return sceneWithInstance(GUID.enemyPrefab);
        if (p === 'Assets/prefabs/Enemy.prefab.meta') return `fileFormatVersion: 2\nguid: ${GUID.enemyPrefab}`;
        return null;
      },
    });

    expect(unityAssetResolver.postExtract!(ctx)).toEqual([]);
  });

  it('does not rename a plain GameObject that happens to be named "PrefabInstance" (no 1001 doc at its line)', () => {
    // A real GameObject literally named "PrefabInstance" shares the qualifiedName
    // marker but has no `!u!1001` document at its line → never renamed.
    const go = makeSymbol({
      id: 'component:go5',
      kind: 'component',
      name: 'PrefabInstance',
      filePath: SCENE,
      startLine: 5,
      endLine: 5,
      language: 'unity_yaml',
      qualifiedName: `${SCENE}#PrefabInstance`,
    });
    const ctx = makeContext({
      getNodesByKind: (k) => (k === 'component' ? [go] : []),
      getAllFiles: () => ['Assets/prefabs/Enemy.prefab'],
      readFile: (p) => {
        // The 1001 doc is at line 1; the GameObject node claims line 5.
        if (p === SCENE) return sceneWithInstance(GUID.enemyPrefab);
        if (p === 'Assets/prefabs/Enemy.prefab.meta') return `fileFormatVersion: 2\nguid: ${GUID.enemyPrefab}`;
        return null;
      },
    });

    expect(unityAssetResolver.postExtract!(ctx)).toEqual([]);
  });
});
