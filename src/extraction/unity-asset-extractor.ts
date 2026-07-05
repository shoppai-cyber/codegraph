import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * Standalone extractor for Unity serialized YAML: scenes (`.unity`), prefabs
 * (`.prefab`), and ScriptableObject/settings assets (`.asset`).
 *
 * Unity's Force-Text serialization is a YAML dialect where each object is a
 * document headed by `--- !u!<classId> &<fileID>[ stripped]`. We do NOT run a
 * full YAML parser — we scan the small, well-known set of keys that carry
 * wiring facts. What we emit:
 *
 * - a `file` node for every valid Unity YAML file (so it is a resolvable
 *   prefab/asset target);
 * - a `component` node for every GameObject that (a) carries ≥1 MonoBehaviour,
 *   (b) is an ancestor of such a GameObject or of a PrefabInstance, or (c) is a
 *   PrefabInstance root. Pure-decoration subtrees (bones, mesh children) get NO
 *   node — their count is summarized on the nearest kept ancestor (the
 *   node-explosion guard);
 * - `contains` edges following the kept-node hierarchy (file → root, parent →
 *   child, GameObject → nested PrefabInstance);
 * - direct `references` edges for scene-object field wires (a serialized
 *   `{fileID}` with no guid, resolved to a target GameObject in the SAME file);
 * - `UnresolvedReference`s (all `referenceKind: 'references'`) for cross-file
 *   wiring — `unity-yaml:script:<guid>` (attached script), `unity-yaml:asset:<guid>`
 *   (PrefabInstance source / serialized prefab-asset field), and
 *   `unity-yaml:event:<Type>:<method>` (UnityEvent persistent call — the target
 *   TYPE from `m_TargetAssemblyTypeName`, not a fileID/guid deref, plus the bare
 *   `m_MethodName`). The `unity-assets` framework resolver binds the guid forms
 *   via a sibling `.meta` map, and the event form by resolving the type name to
 *   an indexed C# class.
 *
 * Emit-nothing policy: an unresolvable GUID yields no edge (package scripts
 * under Library/ are never indexed → correct silence), ambiguity yields
 * nothing, and non-Unity or binary-serialized content yields an empty result
 * (not even a file node). A missed edge beats a fabricated one.
 *
 * fileIDs are kept as STRINGS throughout — Unity fileIDs routinely exceed
 * Number.MAX_SAFE_INTEGER (e.g. 5041805692429606940), so parsing them as
 * numbers would corrupt the identity that every cross-reference depends on.
 */

const CLASS_GAMEOBJECT = 1;
const CLASS_TRANSFORM = 4;
const CLASS_RECTTRANSFORM = 224;
const CLASS_MONOBEHAVIOUR = 114;
const CLASS_PREFABINSTANCE = 1001;

// MonoBehaviour keys whose value is an inline `{fileID …}` but which are
// structural bookkeeping, never a user-authored serialized-field wire.
const STRUCTURAL_MB_KEYS = new Set([
  'm_ObjectHideFlags',
  'm_CorrespondingSourceObject',
  'm_PrefabInstance',
  'm_PrefabAsset',
  'm_GameObject',
  'm_Script',
  'm_Icon',
]);

interface UnityDoc {
  classId: number;
  fileID: string;
  stripped: boolean;
  blockType: string;
  startLine: number;
  body: string[];
}

interface InlineRef {
  fileID: string;
  guid?: string;
  type?: string;
}

interface GameObjectInfo {
  fileID: string;
  name: string;
  isActive: boolean;
  tag?: string;
  layer?: string;
  components: string[]; // ordered component fileIDs
  startLine: number;
}

interface TransformInfo {
  fileID: string;
  goFileID: string; // '0' for stripped stubs
  fatherFileID: string; // '0' = root
  stripped: boolean;
  prefabInstanceFileID: string; // stripped stub → owning instance; else '0'
  localPosition?: string;
}

interface MonoBehaviourInfo {
  fileID: string;
  goFileID: string; // '0' for ScriptableObjects / added components
  prefabInstanceFileID: string; // != '0' → added component of that instance
  scriptGuid?: string;
  className?: string; // from m_EditorClassIdentifier tail
  body: string[];
  startLine: number;
}

interface PrefabInstanceInfo {
  fileID: string;
  sourceGuid?: string;
  transformParentFileID: string; // m_TransformParent → parent transform
  // Every m_Name override with the source-prefab-local id it targets. We keep
  // ALL of them and apply NONE to the node name — which id is the source
  // prefab's root GameObject is only knowable by reading that prefab.
  nameOverrides: Array<{ target: string; value: string }>;
  fieldOverrideCount: number;
  addedComponentFileIDs: string[];
  startLine: number;
}

type Owner =
  | { kind: 'go'; id: string }
  | { kind: 'instance'; id: string }
  | { kind: 'root' };

export class UnityAssetExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  // De-dup guards: two serialized fields pointing at the same target must not
  // emit the same edge/ref twice (keyed without line number).
  private seenEdges = new Set<string>();
  private seenRefs = new Set<string>();

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();
    try {
      if (this.isUnityYaml()) {
        this.run();
      }
    } catch (error) {
      // A parse failure must never fabricate; drop everything for this file.
      this.nodes = [];
      this.edges = [];
      this.unresolvedReferences = [];
      this.errors.push({
        message: `Unity asset extraction error: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'warning',
        code: 'parse_error',
      });
    }
    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Force-Text Unity YAML begins with `%YAML` and/or carries `--- !u!` object
   * documents. Binary-serialized `.asset` files and unrelated `.asset`/YAML
   * files match neither and produce nothing.
   */
  private isUnityYaml(): boolean {
    const head = this.source.slice(0, 4096);
    if (head.replace(/^﻿/, '').startsWith('%YAML')) return true;
    return /^--- !u!\d+ &\d+/m.test(head);
  }

  private run(): void {
    const docs = this.tokenize();
    if (docs.length === 0) return;

    const fileNode = this.createFileNode();

    const gameObjects = new Map<string, GameObjectInfo>();
    const transforms = new Map<string, TransformInfo>();
    const monoBehaviours = new Map<string, MonoBehaviourInfo>();
    const prefabInstances = new Map<string, PrefabInstanceInfo>();
    const componentType = new Map<string, string>(); // component fileID → display type
    const componentToGO = new Map<string, string>(); // component fileID → owning GO fileID

    for (const doc of docs) {
      switch (doc.classId) {
        case CLASS_GAMEOBJECT: {
          if (doc.stripped) break; // stripped GO stubs are instance placeholders
          const go = this.parseGameObject(doc);
          gameObjects.set(doc.fileID, go);
          break;
        }
        case CLASS_TRANSFORM:
        case CLASS_RECTTRANSFORM: {
          const t = this.parseTransform(doc);
          transforms.set(doc.fileID, t);
          if (!doc.stripped && t.goFileID !== '0') componentToGO.set(doc.fileID, t.goFileID);
          componentType.set(doc.fileID, doc.blockType);
          break;
        }
        case CLASS_MONOBEHAVIOUR: {
          const mb = this.parseMonoBehaviour(doc);
          monoBehaviours.set(doc.fileID, mb);
          if (mb.goFileID !== '0') componentToGO.set(doc.fileID, mb.goFileID);
          componentType.set(doc.fileID, mb.className || 'MonoBehaviour');
          break;
        }
        case CLASS_PREFABINSTANCE: {
          const pi = this.parsePrefabInstance(doc);
          prefabInstances.set(doc.fileID, pi);
          break;
        }
        default: {
          // Any other component (Collider, Renderer, Camera, …): record its
          // owner + type for the signature list only.
          const owner = this.inline(this.topScalar(doc.body, 'm_GameObject'));
          if (owner && owner.fileID !== '0') componentToGO.set(doc.fileID, owner.fileID);
          componentType.set(doc.fileID, doc.blockType);
          break;
        }
      }
    }

    // Which GameObjects carry a script (→ always kept).
    const goScripts = new Map<string, string[]>();
    for (const mb of monoBehaviours.values()) {
      if (mb.goFileID === '0' || !mb.scriptGuid) continue;
      const list = goScripts.get(mb.goFileID) ?? [];
      if (!list.includes(mb.scriptGuid)) list.push(mb.scriptGuid);
      goScripts.set(mb.goFileID, list);
    }

    // Stripped Transform stub → the PrefabInstance it stands in for.
    const strippedToInstance = new Map<string, string>();
    for (const t of transforms.values()) {
      if (t.stripped && t.prefabInstanceFileID !== '0') {
        strippedToInstance.set(t.fileID, t.prefabInstanceFileID);
      }
    }

    // Resolve a transform fileID to the hierarchy owner it represents.
    const resolveTransformOwner = (transformFileID: string): Owner => {
      if (transformFileID === '0') return { kind: 'root' };
      const t = transforms.get(transformFileID);
      if (t) {
        if (t.stripped) {
          const inst = strippedToInstance.get(transformFileID);
          return inst ? { kind: 'instance', id: inst } : { kind: 'root' };
        }
        if (t.goFileID !== '0') return { kind: 'go', id: t.goFileID };
      }
      return { kind: 'root' };
    };

    // GameObject fileID → its own Transform fileID (to read m_Father).
    const goToTransform = new Map<string, string>();
    for (const t of transforms.values()) {
      if (!t.stripped && t.goFileID !== '0') goToTransform.set(t.goFileID, t.fileID);
    }

    // Parent map over hierarchy nodes (GO fileIDs and instance fileIDs).
    const parentOf = new Map<string, Owner>();
    for (const go of gameObjects.values()) {
      const tf = goToTransform.get(go.fileID);
      const father = tf ? transforms.get(tf)?.fatherFileID ?? '0' : '0';
      parentOf.set(go.fileID, resolveTransformOwner(father));
    }
    for (const pi of prefabInstances.values()) {
      parentOf.set(pi.fileID, resolveTransformOwner(pi.transformParentFileID));
    }

    // Kept set: scripted GOs, all PrefabInstances, and every ancestor of those.
    const keptGO = new Set<string>();
    const keptInstance = new Set<string>(prefabInstances.keys());
    const markAncestors = (owner: Owner) => {
      let cur = owner;
      const guard = new Set<string>();
      while (cur.kind !== 'root') {
        if (cur.kind === 'go') {
          if (guard.has(cur.id)) break;
          guard.add(cur.id);
          keptGO.add(cur.id);
          cur = parentOf.get(cur.id) ?? { kind: 'root' };
        } else {
          // instance ancestor: continue up from the instance's parent
          if (guard.has(cur.id)) break;
          guard.add(cur.id);
          cur = parentOf.get(cur.id) ?? { kind: 'root' };
        }
      }
    };
    for (const goFileID of goScripts.keys()) {
      keptGO.add(goFileID);
      markAncestors(parentOf.get(goFileID) ?? { kind: 'root' });
    }
    for (const pi of prefabInstances.values()) {
      markAncestors(parentOf.get(pi.fileID) ?? { kind: 'root' });
    }

    // Pruned-descendant (decoration) count per kept hierarchy node.
    const childrenOf = new Map<string, string[]>(); // hierId → child hierIds
    const addChild = (parent: Owner, childId: string) => {
      if (parent.kind === 'root') return;
      const list = childrenOf.get(parent.id) ?? [];
      list.push(childId);
      childrenOf.set(parent.id, list);
    };
    for (const go of gameObjects.values()) addChild(parentOf.get(go.fileID) ?? { kind: 'root' }, go.fileID);
    for (const pi of prefabInstances.values()) addChild(parentOf.get(pi.fileID) ?? { kind: 'root' }, pi.fileID);

    const isKept = (hierId: string) => keptGO.has(hierId) || keptInstance.has(hierId);
    const countPrunedDescendants = (hierId: string): number => {
      let n = 0;
      const stack = [...(childrenOf.get(hierId) ?? [])];
      while (stack.length) {
        const c = stack.pop()!;
        if (!isKept(c)) {
          n++;
          stack.push(...(childrenOf.get(c) ?? []));
        }
      }
      return n;
    };

    // ---- Emit nodes ----
    const goNodeId = new Map<string, string>();
    for (const go of gameObjects.values()) {
      if (!keptGO.has(go.fileID)) continue;
      const name = go.name || 'GameObject';
      const id = generateNodeId(this.filePath, 'component', name, go.startLine);
      goNodeId.set(go.fileID, id);
      const signature = go.components
        .map((c) => componentType.get(c))
        .filter((t): t is string => !!t)
        .join(', ');
      this.nodes.push(
        this.componentNode(id, name, go.startLine, signature, this.gameObjectDocstring(go, countPrunedDescendants(go.fileID)))
      );
    }

    const instanceNodeId = new Map<string, string>();
    for (const pi of prefabInstances.values()) {
      // Conservative, always-safe name. We cannot verify at extract time which
      // (if any) m_Name override targets the source prefab's ROOT GameObject, so
      // we never name the instance after an override — the source prefab is
      // surfaced via the `unity-yaml:asset:<guid>` reference and the overrides
      // are kept in the docstring. (Follow-up: a resolution-phase `postExtract`
      // can safely name it from the source-prefab file stem.)
      const name = 'PrefabInstance';
      const id = generateNodeId(this.filePath, 'component', name, pi.startLine);
      instanceNodeId.set(pi.fileID, id);
      this.nodes.push(
        this.componentNode(id, name, pi.startLine, 'PrefabInstance', this.instanceDocstring(pi, countPrunedDescendants(pi.fileID)))
      );
    }

    const hierNodeId = (hierId: string): string | undefined => goNodeId.get(hierId) ?? instanceNodeId.get(hierId);

    // ---- Emit containment edges (kept-node tree) ----
    const emitContains = (hierId: string) => {
      const childNode = hierNodeId(hierId);
      if (!childNode) return;
      const parent = parentOf.get(hierId) ?? { kind: 'root' };
      const parentNode = parent.kind === 'root' ? undefined : hierNodeId(parent.id);
      this.pushEdge(parentNode ?? fileNode.id, childNode, 'contains');
    };
    for (const goFileID of keptGO) emitContains(goFileID);
    for (const piFileID of keptInstance) emitContains(piFileID);

    // ---- Emit script / field / event references ----
    for (const mb of monoBehaviours.values()) {
      let ownerNodeId: string | undefined;
      if (mb.goFileID !== '0') {
        ownerNodeId = goNodeId.get(mb.goFileID);
      } else if (mb.prefabInstanceFileID !== '0') {
        // Added component — attributed via m_AddedComponents below, not here.
        continue;
      } else {
        // Top-level MonoBehaviour with no GameObject → ScriptableObject asset.
        ownerNodeId = fileNode.id;
      }
      if (!ownerNodeId) continue;

      if (mb.scriptGuid) {
        this.addRef(ownerNodeId, `unity-yaml:script:${mb.scriptGuid}`, mb.startLine);
      }
      this.emitFieldWires(mb, ownerNodeId, goNodeId, componentToGO, gameObjects, keptGO);
      this.emitPersistentCalls(mb, ownerNodeId);
    }

    // ---- PrefabInstance → source prefab, and added-component scripts ----
    for (const pi of prefabInstances.values()) {
      const instNode = instanceNodeId.get(pi.fileID);
      if (!instNode) continue;
      if (pi.sourceGuid) this.addRef(instNode, `unity-yaml:asset:${pi.sourceGuid}`, pi.startLine);
      for (const addedFileID of pi.addedComponentFileIDs) {
        const addedMb = monoBehaviours.get(addedFileID);
        if (addedMb?.scriptGuid) this.addRef(instNode, `unity-yaml:script:${addedMb.scriptGuid}`, addedMb.startLine);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Per-MonoBehaviour reference emission
  // -------------------------------------------------------------------------

  /**
   * Scan a MonoBehaviour's top-level serialized fields (2-space indent). A
   * `{fileID, guid}` field is a cross-file prefab/asset ref; a `{fileID}` with
   * no guid is a same-file scene-object ref → a direct `references` edge to the
   * target GameObject node when that GameObject is itself a kept node.
   */
  private emitFieldWires(
    mb: MonoBehaviourInfo,
    ownerNodeId: string,
    goNodeId: Map<string, string>,
    componentToGO: Map<string, string>,
    gameObjects: Map<string, GameObjectInfo>,
    keptGO: Set<string>
  ): void {
    const fieldRe = /^  ([A-Za-z_]\w*): \{fileID: (-?\d+)(?:, guid: ([0-9a-fA-F]+))?(?:, type: -?\d+)?\}\s*$/;
    for (let i = 0; i < mb.body.length; i++) {
      const m = mb.body[i]!.match(fieldRe);
      if (!m) continue;
      const [, key, fileID, guid] = m;
      if (STRUCTURAL_MB_KEYS.has(key!)) continue;

      if (guid) {
        // Cross-file prefab / ScriptableObject / material reference.
        this.addRef(ownerNodeId, `unity-yaml:asset:${guid}`, mb.startLine + i);
        continue;
      }
      if (fileID === '0') continue;
      // Same-file scene-object reference. The value points at a component or a
      // GameObject; map either to the owning GameObject node.
      const targetGO = gameObjects.has(fileID!) ? fileID! : componentToGO.get(fileID!);
      if (!targetGO || !keptGO.has(targetGO)) continue;
      const targetNode = goNodeId.get(targetGO);
      if (!targetNode || targetNode === ownerNodeId) continue;
      this.pushEdge(ownerNodeId, targetNode, 'references');
    }
  }

  /**
   * UnityEvent persistent calls. Each call in `m_PersistentCalls.m_Calls` is a
   * list item of the shape (verbatim Unity serialization):
   *
   *     - m_Target: {fileID: 1357023918}
   *       m_TargetAssemblyTypeName: GameManager, Assembly-CSharp
   *       m_MethodName: ResetScore
   *       m_Mode: 0
   *
   * `m_Target` is a scene-local `!u!114` COMPONENT fileID (never a MonoScript
   * guid), so its type can't be read from the target line. The reliable, deref-
   * free type source is `m_TargetAssemblyTypeName` (`<Type>, <Assembly>`) sitting
   * beside `m_MethodName` — comma-split gives the assembly-qualified type. We emit
   * `unity-yaml:event:<Type>:<method>`, keyed by TYPE NAME; the resolver binds it
   * to a uniquely-named method on the indexed C# class of that name. This shape
   * appears identically under our own serialized fields (`onDeath:`) and package
   * component fields (Button's `m_OnClick:`) — both parse the same way; a target
   * whose type has no source in the project (Button, etc.) simply never resolves.
   *
   * Emit-nothing discipline: a cleared target (`m_Target: {fileID: 0}`) or an
   * empty/absent `m_TargetAssemblyTypeName` yields no ref. Overload disambiguation
   * (no parameter list exists in the YAML) is left to the resolver.
   */
  private emitPersistentCalls(mb: MonoBehaviourInfo, ownerNodeId: string): void {
    let pendingTargetFileID: string | undefined;
    let pendingType: string | undefined;
    let pendingLine = mb.startLine;
    for (let i = 0; i < mb.body.length; i++) {
      const line = mb.body[i]!;

      // Start of a persistent call. A new m_Target resets per-call accumulation
      // so a prior call's type can't leak into one that omits its own.
      const target = line.match(/m_Target: \{fileID: (-?\d+)/);
      if (target) {
        pendingTargetFileID = target[1];
        pendingType = undefined;
        pendingLine = mb.startLine + i;
        continue;
      }

      // Assembly-qualified target type `<Type>, <Assembly>`: the type part is
      // everything before the first comma (keep any dotted namespace for the
      // resolver to disambiguate on). An empty value (cleared target) leaves it
      // unset so nothing is emitted.
      const typeName = line.match(/m_TargetAssemblyTypeName:\s*(.*\S)?\s*$/);
      if (typeName && pendingTargetFileID !== undefined) {
        const typePart = (typeName[1] ?? '').split(',')[0]!.trim();
        pendingType = typePart || undefined;
        continue;
      }

      // Bare method name (no signature). Emit only for a live scene-local target
      // (fileID ≠ 0) carrying a resolvable type.
      const method = line.match(/m_MethodName:\s*(\S+)\s*$/);
      if (method) {
        if (pendingType && pendingTargetFileID && pendingTargetFileID !== '0') {
          this.addRef(ownerNodeId, `unity-yaml:event:${pendingType}:${method[1]}`, pendingLine);
        }
        pendingTargetFileID = undefined;
        pendingType = undefined;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Block parsers
  // -------------------------------------------------------------------------

  private parseGameObject(doc: UnityDoc): GameObjectInfo {
    return {
      fileID: doc.fileID,
      name: this.unquote(this.topScalar(doc.body, 'm_Name') ?? ''),
      isActive: (this.topScalar(doc.body, 'm_IsActive') ?? '1') === '1',
      tag: this.topScalar(doc.body, 'm_TagString'),
      layer: this.topScalar(doc.body, 'm_Layer'),
      components: this.componentList(doc.body),
      startLine: doc.startLine,
    };
  }

  private parseTransform(doc: UnityDoc): TransformInfo {
    return {
      fileID: doc.fileID,
      goFileID: this.inline(this.topScalar(doc.body, 'm_GameObject'))?.fileID ?? '0',
      fatherFileID: this.inline(this.topScalar(doc.body, 'm_Father'))?.fileID ?? '0',
      stripped: doc.stripped,
      prefabInstanceFileID: this.inline(this.topScalar(doc.body, 'm_PrefabInstance'))?.fileID ?? '0',
      localPosition: this.topScalar(doc.body, 'm_LocalPosition'),
    };
  }

  private parseMonoBehaviour(doc: UnityDoc): MonoBehaviourInfo {
    const editorClassId = this.topScalar(doc.body, 'm_EditorClassIdentifier');
    return {
      fileID: doc.fileID,
      goFileID: this.inline(this.topScalar(doc.body, 'm_GameObject'))?.fileID ?? '0',
      prefabInstanceFileID: this.inline(this.topScalar(doc.body, 'm_PrefabInstance'))?.fileID ?? '0',
      scriptGuid: this.inline(this.topScalar(doc.body, 'm_Script'))?.guid,
      className: this.classNameFromEditorId(editorClassId),
      body: doc.body,
      startLine: doc.startLine,
    };
  }

  private parsePrefabInstance(doc: UnityDoc): PrefabInstanceInfo {
    // m_TransformParent lives under m_Modification; a plain topScalar scan finds
    // it regardless of the extra indent because we match on the key name.
    let transformParent = '0';
    const nameOverrides: Array<{ target: string; value: string }> = [];
    let fieldOverrideCount = 0;
    const addedComponentFileIDs: string[] = [];
    let sourceGuid: string | undefined;
    // The fileID of the most recent modification `target:` — a source-prefab-
    // local id. Paired with the m_Name propertyPath below so each rename keeps
    // the id of the object it targets (a root rename vs a child rename can only
    // be told apart later, by reading the source prefab).
    let lastTargetFileID = '0';

    for (let i = 0; i < doc.body.length; i++) {
      const line = doc.body[i]!;
      const tp = line.match(/m_TransformParent: \{fileID: (-?\d+)/);
      if (tp) {
        transformParent = tp[1]!;
        continue;
      }
      const src = line.match(/m_SourcePrefab: \{fileID: -?\d+(?:, guid: ([0-9a-fA-F]+))?/);
      if (src && src[1]) {
        sourceGuid = src[1];
        continue;
      }
      const tgt = line.match(/\btarget: \{fileID: (-?\d+)/);
      if (tgt) {
        lastTargetFileID = tgt[1]!;
        continue;
      }
      const prop = line.match(/^\s*propertyPath:\s*(\S+)\s*$/);
      if (prop) {
        const valueLine = doc.body[i + 1] ?? '';
        const val = valueLine.match(/^\s*value:\s*(.*)$/);
        if (prop[1] === 'm_Name' && val) {
          // Record every m_Name override with the id it targets; deliberately do
          // NOT pick one to name the instance root (see the node-naming note).
          nameOverrides.push({ target: lastTargetFileID, value: this.unquote(val[1]!.trim()) });
        } else {
          fieldOverrideCount++;
        }
        continue;
      }
      const added = line.match(/addedObject: \{fileID: (-?\d+)\}/);
      if (added && added[1] !== '0') {
        addedComponentFileIDs.push(added[1]!);
      }
    }

    return {
      fileID: doc.fileID,
      sourceGuid,
      transformParentFileID: transformParent,
      nameOverrides,
      fieldOverrideCount,
      addedComponentFileIDs,
      startLine: doc.startLine,
    };
  }

  // -------------------------------------------------------------------------
  // Small scanning helpers
  // -------------------------------------------------------------------------

  /** First top-level (`  key: value`) scalar for `key`, or undefined. */
  private topScalar(body: string[], key: string): string | undefined {
    const re = new RegExp(`^  ${key}:\\s?(.*)$`);
    for (const line of body) {
      const m = line.match(re);
      if (m) return m[1] === '' ? '' : m[1];
    }
    return undefined;
  }

  private componentList(body: string[]): string[] {
    const out: string[] = [];
    let inList = false;
    for (const line of body) {
      if (/^  m_Component:\s*$/.test(line)) {
        inList = true;
        continue;
      }
      if (inList) {
        const m = line.match(/^  - component: \{fileID: (-?\d+)\}/);
        if (m) {
          out.push(m[1]!);
          continue;
        }
        // any other 2-space key ends the list
        if (/^  \S/.test(line)) break;
      }
    }
    return out;
  }

  private inline(value: string | undefined): InlineRef | undefined {
    if (!value) return undefined;
    const m = value.match(/\{fileID: (-?\d+)(?:, guid: ([0-9a-fA-F]+))?(?:, type: (-?\d+))?\}/);
    if (!m) return undefined;
    return { fileID: m[1]!, guid: m[2], type: m[3] };
  }

  private classNameFromEditorId(editorClassId: string | undefined): string | undefined {
    if (!editorClassId) return undefined;
    const afterAssembly = editorClassId.includes('::') ? editorClassId.split('::')[1]! : editorClassId;
    const tail = afterAssembly.includes('.') ? afterAssembly.split('.').pop()! : afterAssembly;
    return tail.trim() || undefined;
  }

  /**
   * Strip matching surrounding quotes from a Unity YAML scalar. Unity only
   * quotes a name when it must (leading/trailing space, special chars); an
   * unquoted value is returned unchanged. Double-quoted values unescape `\\`
   * and `\"`; single-quoted values unescape the `''` pair.
   */
  private unquote(value: string): string {
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
    }
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      return value.slice(1, -1).replace(/''/g, "'");
    }
    return value;
  }

  // -------------------------------------------------------------------------
  // Tokenizer + node factories
  // -------------------------------------------------------------------------

  private tokenize(): UnityDoc[] {
    const lines = this.source.split(/\r?\n/);
    const docs: UnityDoc[] = [];
    const header = /^--- !u!(\d+) &(\d+)( stripped)?/;
    let current: UnityDoc | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const m = line.match(header);
      if (m) {
        if (current) docs.push(current);
        current = {
          classId: parseInt(m[1]!, 10),
          fileID: m[2]!,
          stripped: !!m[3],
          blockType: '',
          startLine: i + 1,
          body: [],
        };
        continue;
      }
      if (!current) continue;
      if (!current.blockType) {
        const bt = line.match(/^([A-Za-z_]\w*):\s*$/);
        if (bt) {
          current.blockType = bt[1]!;
          continue;
        }
      }
      current.body.push(line);
    }
    if (current) docs.push(current);
    return docs;
  }

  private createFileNode(): Node {
    const lines = this.source.split(/\r?\n/);
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);
    const fileNode: Node = {
      id,
      kind: 'file',
      name: this.filePath.split(/[\\/]/).pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'unity_yaml',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(fileNode);
    return fileNode;
  }

  private componentNode(id: string, name: string, line: number, signature: string, docstring: string): Node {
    return {
      id,
      kind: 'component',
      name,
      qualifiedName: `${this.filePath}#${name}`,
      filePath: this.filePath,
      language: 'unity_yaml',
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: 0,
      signature: signature || undefined,
      docstring: docstring || undefined,
      updatedAt: Date.now(),
    };
  }

  private gameObjectDocstring(go: GameObjectInfo, prunedDescendants: number): string {
    const parts = [`active=${go.isActive}`];
    if (go.tag && go.tag !== 'Untagged') parts.push(`tag=${go.tag}`);
    if (go.layer && go.layer !== '0') parts.push(`layer=${go.layer}`);
    if (prunedDescendants > 0) parts.push(`decorationChildren=${prunedDescendants}`);
    return parts.join(' ');
  }

  private instanceDocstring(pi: PrefabInstanceInfo, prunedDescendants: number): string {
    const parts = ['prefabInstance'];
    if (pi.nameOverrides.length > 0) {
      // Kept as metadata (target-id:value), never applied to the node name.
      parts.push(`nameOverrides=${pi.nameOverrides.map((o) => `${o.target}:${o.value}`).join(',')}`);
    }
    if (pi.fieldOverrideCount > 0) parts.push(`overrides=${pi.fieldOverrideCount}`);
    if (pi.addedComponentFileIDs.length > 0) parts.push(`addedComponents=${pi.addedComponentFileIDs.length}`);
    if (prunedDescendants > 0) parts.push(`decorationChildren=${prunedDescendants}`);
    return parts.join(' ');
  }

  private addRef(fromNodeId: string, referenceName: string, line: number): void {
    const key = `${fromNodeId} ${referenceName}`;
    if (this.seenRefs.has(key)) return;
    this.seenRefs.add(key);
    this.unresolvedReferences.push({
      fromNodeId,
      referenceName,
      referenceKind: 'references',
      line,
      column: 0,
    });
  }

  /**
   * Push an edge de-duplicated by (source, target, kind). Two serialized fields
   * that point at the same target — or a containment reached two ways — must not
   * emit the same edge twice.
   */
  private pushEdge(source: string, target: string, kind: Edge['kind']): void {
    const key = `${source} ${target} ${kind}`;
    if (this.seenEdges.has(key)) return;
    this.seenEdges.add(key);
    this.edges.push({ source, target, kind });
  }
}
