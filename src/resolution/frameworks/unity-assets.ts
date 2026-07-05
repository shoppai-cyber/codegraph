/**
 * Unity asset-wiring resolver.
 *
 * Binds the cross-file references the standalone `UnityAssetExtractor` emits
 * from `.unity`/`.prefab`/`.asset` YAML:
 *
 * - `unity-yaml:script:<guid>` → the script's primary class node (attached
 *   MonoBehaviour, or a ScriptableObject's type).
 * - `unity-yaml:asset:<guid>`  → the referenced prefab/asset's `file` node (a
 *   PrefabInstance source, or a serialized prefab-asset field). A guid that
 *   maps to a `.cs` (a MonoScript reference) resolves to its class node.
 * - `unity-yaml:event:<Type>:<name>` → the uniquely-named method `<name>` on the
 *   indexed C# class `<Type>` (a UnityEvent persistent call). The type comes from
 *   the YAML's `m_TargetAssemblyTypeName` (no guid deref), so a package/asset
 *   target with no source in the project (Button, …) resolves to nothing, and an
 *   overloaded method name — the YAML carries no parameter list — also resolves
 *   to nothing (a documented v1 limit).
 *
 * The link from a guid to a file is Unity's `.meta` sidecar convention: every
 * asset `X` has an `X.meta` whose `guid:` line is the stable identity that
 * scenes/prefabs reference. We build a guid→path map by reading the `.meta`
 * of each indexed `.cs`/`.prefab`/`.asset`, memoized per project (rebuilt when
 * the asset-file count changes). Package scripts under `Library/PackageCache`
 * are never indexed, so their guids are absent — an unresolvable guid yields
 * no edge (correct silence). Resolution refuses to guess: a guid missing from
 * the map, or a `.cs` whose primary class is ambiguous, resolves to nothing. A
 * missed edge beats a fabricated one.
 *
 * `postExtract` renames `PrefabInstance` component nodes to their source-prefab
 * file stem (`Coin`, `Enemy`) — the always-correct friendly name the extractor
 * can't produce per-file (the source guid → path map is only available
 * cross-file, at resolution time). The extractor names every instance the
 * conservative `PrefabInstance`; this pass upgrades that where the source
 * resolves, leaving the `#PrefabInstance` qualifiedName as the stable idempotency
 * marker and the `nameOverrides` docstring metadata untouched.
 */

import { Node } from '../../types';
import { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';

// A `unity-yaml:` namespace, distinct from the C# Unity resolver's `unity:host:`
// / `unity:field:` / `unity:method:` prefixes — the method form would otherwise
// collide (both claim `unity:method:`), leaving only the language guard between
// them (finding 4).
const SCRIPT_REF_PREFIX = 'unity-yaml:script:';
const ASSET_REF_PREFIX = 'unity-yaml:asset:';
const EVENT_REF_PREFIX = 'unity-yaml:event:';

// Asset kinds whose `.meta` guids can be a reference target.
const GUID_BEARING_EXTS = ['.cs', '.prefab', '.asset'];

interface GuidMapCache {
  key: string;
  map: Map<string, string>; // guid → asset file path
}

let guidCache: GuidMapCache | null = null;

/** Read the `guid:` line out of a `.meta` file's content. */
function parseMetaGuid(content: string): string | undefined {
  const m = content.match(/^guid:\s*([0-9a-fA-F]{32})\s*$/m);
  return m ? m[1] : undefined;
}

function assetFiles(context: ResolutionContext): string[] {
  return context.getAllFiles().filter((f) => GUID_BEARING_EXTS.some((ext) => f.endsWith(ext)));
}

/**
 * A cheap, O(1) staleness key for the guid map: project root, asset count, and
 * a few evenly-spaced sample paths. Reading every `.meta` to hash exactly would
 * cost O(all assets) on every ref (the resolver is called per-reference), so we
 * sample instead. A change that preserves count AND all sampled endpoints is
 * picked up on the next count- or endpoint-changing sync; a stale entry only
 * ever fails to resolve (correct silence), never mis-resolves.
 */
function guidMapKey(projectRoot: string, files: string[]): string {
  const n = files.length;
  const sample = [files[0], files[n >> 1], files[n - 1]].map((f) => f ?? '').join('\0');
  return `${projectRoot}\0${n}\0${sample}`;
}

/** Guid→path map from sibling `.meta` files, memoized per project. */
function getGuidMap(context: ResolutionContext): Map<string, string> {
  const files = assetFiles(context);
  const key = guidMapKey(context.getProjectRoot(), files);
  if (guidCache && guidCache.key === key) return guidCache.map;
  const map = new Map<string, string>();
  for (const file of files) {
    const meta = context.readFile(`${file}.meta`);
    if (!meta) continue;
    const guid = parseMetaGuid(meta);
    if (guid && !map.has(guid)) map.set(guid, file);
  }
  guidCache = { key, map };
  return map;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** File basename minus its final extension (`Coin.prefab` → `Coin`). */
function fileStem(path: string): string {
  return basename(path).replace(/\.[^.]+$/, '');
}

// The stable qualifiedName suffix the extractor stamps on every PrefabInstance
// node. It is preserved verbatim through `postExtract` renames so the pass can
// re-select and re-derive the friendly name idempotently, on a full re-index or
// any later incremental sync (even one that only re-points the source prefab).
const INSTANCE_QN_SUFFIX = '#PrefabInstance';

/**
 * Map each `!u!1001` PrefabInstance document's HEADER line (1-based, equal to the
 * instance node's `startLine`) to its `m_SourcePrefab` guid. A lightweight line
 * scan — `postExtract` only needs the source guid per instance, and matching on
 * the header line ties the node back to its document without a full re-parse.
 */
function sourceGuidByInstanceLine(content: string): Map<number, string> {
  const out = new Map<number, string>();
  const lines = content.split(/\r?\n/);
  let headerLine = -1;
  let inInstance = false;
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]!.match(/^--- !u!(\d+) &\d+/);
    if (header) {
      inInstance = header[1] === '1001';
      headerLine = i + 1;
      continue;
    }
    if (!inInstance || out.has(headerLine)) continue;
    const src = lines[i]!.match(/m_SourcePrefab: \{fileID: -?\d+(?:, guid: ([0-9a-fA-F]+))?/);
    if (src && src[1]) out.set(headerLine, src[1]);
  }
  return out;
}

/** The class/struct/interface a `.cs` file is named for (Unity's rule), or the
 * lone type when there is exactly one. Ambiguous files resolve to nothing. */
function primaryTypeNode(nodes: Node[], csPath: string): Node | null {
  const types = nodes.filter(
    (n) => n.kind === 'class' || n.kind === 'struct' || n.kind === 'interface'
  );
  if (types.length === 0) return null;
  const stem = basename(csPath).replace(/\.cs$/, '');
  const named = types.find((n) => n.name === stem);
  if (named) return named;
  return types.length === 1 ? types[0]! : null;
}

function resolved(ref: UnresolvedRef, target: Node): ResolvedRef {
  return { original: ref, targetNodeId: target.id, confidence: 1, resolvedBy: 'framework' };
}

function resolveScript(ref: UnresolvedRef, guid: string, context: ResolutionContext): ResolvedRef | null {
  const path = getGuidMap(context).get(guid);
  if (!path || !path.endsWith('.cs')) return null;
  const node = primaryTypeNode(context.getNodesInFile(path), path);
  return node ? resolved(ref, node) : null;
}

function resolveAsset(ref: UnresolvedRef, guid: string, context: ResolutionContext): ResolvedRef | null {
  const path = getGuidMap(context).get(guid);
  if (!path) return null;
  if (path.endsWith('.cs')) {
    // A MonoScript reference (e.g. an m_Script-shaped field) — bind to the class.
    const node = primaryTypeNode(context.getNodesInFile(path), path);
    return node ? resolved(ref, node) : null;
  }
  const fileNode = context.getNodesInFile(path).find((n) => n.kind === 'file');
  return fileNode ? resolved(ref, fileNode) : null;
}

/**
 * Resolve a UnityEvent persistent call by TYPE NAME. `fullType` is the type part
 * of `m_TargetAssemblyTypeName` (possibly dotted, e.g. `My.Ns.GameManager`); the
 * bare class name is its last dot-segment. We bind the call to the uniquely-named
 * `method` lexically inside the single indexed class of that name. Emit-nothing
 * discipline: no such class (package/asset target), an AMBIGUOUS class name, or an
 * overloaded method (≥2 defs — the YAML has no parameter list) all resolve to null.
 */
function resolveEvent(ref: UnresolvedRef, fullType: string, method: string, context: ResolutionContext): ResolvedRef | null {
  const className = fullType.includes('.') ? fullType.split('.').pop()! : fullType;
  if (!className) return null;
  const classes = context
    .getNodesByName(className)
    .filter((n) => n.kind === 'class' || n.kind === 'struct' || n.kind === 'interface');
  if (classes.length !== 1) return null; // no class in the project, or ambiguous name
  const cls = classes[0]!;
  const methods = context
    .getNodesInFile(cls.filePath)
    .filter(
      (n) =>
        (n.kind === 'method' || n.kind === 'function') &&
        n.name === method &&
        n.startLine >= cls.startLine &&
        n.startLine <= cls.endLine
    );
  return methods.length === 1 ? resolved(ref, methods[0]!) : null;
}

export const unityAssetResolver: FrameworkResolver = {
  name: 'unity-assets',
  languages: ['unity_yaml'],

  detect(context: ResolutionContext): boolean {
    // detect() runs once at the start of each resolution pass — treat it as the
    // resolver's init and drop any guid map cached from a previous pass, so a
    // `.meta` guid edit between passes can't be served a stale mapping (the
    // sampled cache key alone wouldn't notice a same-count, same-endpoints edit).
    guidCache = null;
    if (context.fileExists('ProjectSettings/ProjectVersion.txt')) return true;
    const files = context.getAllFiles();
    if (files.some((f) => f.endsWith('.unity') || f.endsWith('.prefab') || f.endsWith('.asmdef'))) return true;
    return false;
  },

  claimsReference(name: string): boolean {
    return (
      name.startsWith(SCRIPT_REF_PREFIX) ||
      name.startsWith(ASSET_REF_PREFIX) ||
      name.startsWith(EVENT_REF_PREFIX)
    );
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.language !== 'unity_yaml') return null;
    const name = ref.referenceName;
    if (name.startsWith(SCRIPT_REF_PREFIX)) {
      return resolveScript(ref, name.slice(SCRIPT_REF_PREFIX.length), context);
    }
    if (name.startsWith(ASSET_REF_PREFIX)) {
      return resolveAsset(ref, name.slice(ASSET_REF_PREFIX.length), context);
    }
    if (name.startsWith(EVENT_REF_PREFIX)) {
      // `<Type>:<method>` — the type part is dotted (never colon-bearing), so the
      // first colon separates type from the bare method name.
      const rest = name.slice(EVENT_REF_PREFIX.length);
      const sep = rest.indexOf(':');
      if (sep <= 0) return null;
      return resolveEvent(ref, rest.slice(0, sep), rest.slice(sep + 1), context);
    }
    return null;
  },

  /**
   * Rename `PrefabInstance` component nodes to their source-prefab file stem
   * (`Coin`, `Enemy`) — the friendly, always-correct name the per-file extractor
   * can't produce (the source guid → path map is cross-file). Emit-nothing holds:
   * an instance whose source guid is unindexed (a package prefab) keeps its
   * conservative `PrefabInstance` name.
   *
   * Idempotent: instances are selected by the stable `#PrefabInstance`
   * qualifiedName suffix (preserved through the rename) and confirmed against the
   * file's actual `!u!1001` document at the node's line, so a re-run — or a run
   * over an already-renamed node — re-derives the same name. The node `id` and
   * `qualifiedName` are preserved so existing edges and the marker stay intact.
   */
  postExtract(context: ResolutionContext): Node[] {
    const instances = context
      .getNodesByKind('component')
      .filter((n) => n.language === 'unity_yaml' && n.qualifiedName.endsWith(INSTANCE_QN_SUFFIX));
    if (instances.length === 0) return [];

    const guidMap = getGuidMap(context);
    const perFile = new Map<string, Map<number, string>>(); // filePath → (headerLine → sourceGuid)
    const updates: Node[] = [];

    for (const inst of instances) {
      let lineMap = perFile.get(inst.filePath);
      if (!lineMap) {
        const content = context.readFile(inst.filePath);
        lineMap = content ? sourceGuidByInstanceLine(content) : new Map();
        perFile.set(inst.filePath, lineMap);
      }
      const guid = lineMap.get(inst.startLine);
      if (!guid) continue; // no 1001 doc at this line, or no source guid → leave as-is
      const path = guidMap.get(guid);
      if (!path || !path.endsWith('.prefab')) continue; // package/unindexed source → correct silence
      const name = fileStem(path);
      if (!name || name === inst.name) continue; // unresolvable stem or already correct
      // Preserve id (edges) + qualifiedName (idempotency marker); rename only.
      updates.push({ ...inst, name });
    }
    return updates;
  },
};
