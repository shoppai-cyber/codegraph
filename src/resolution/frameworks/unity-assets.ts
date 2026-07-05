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
 * - `unity-yaml:method:<guid>:<name>` → the uniquely-named method on the target
 *   script (a UnityEvent persistent call).
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
 */

import { Node } from '../../types';
import { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';

// A `unity-yaml:` namespace, distinct from the C# Unity resolver's `unity:host:`
// / `unity:field:` / `unity:method:` prefixes — the method form would otherwise
// collide (both claim `unity:method:`), leaving only the language guard between
// them (finding 4).
const SCRIPT_REF_PREFIX = 'unity-yaml:script:';
const ASSET_REF_PREFIX = 'unity-yaml:asset:';
const METHOD_REF_PREFIX = 'unity-yaml:method:';

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

function resolveMethod(ref: UnresolvedRef, guid: string, method: string, context: ResolutionContext): ResolvedRef | null {
  const path = getGuidMap(context).get(guid);
  if (!path || !path.endsWith('.cs')) return null;
  const candidates = context
    .getNodesInFile(path)
    .filter((n) => (n.kind === 'method' || n.kind === 'function') && n.name === method);
  // Refuse to guess between overloads / ambiguous matches.
  return candidates.length === 1 ? resolved(ref, candidates[0]!) : null;
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
      name.startsWith(METHOD_REF_PREFIX)
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
    if (name.startsWith(METHOD_REF_PREFIX)) {
      const rest = name.slice(METHOD_REF_PREFIX.length);
      const sep = rest.indexOf(':');
      if (sep <= 0) return null;
      return resolveMethod(ref, rest.slice(0, sep), rest.slice(sep + 1), context);
    }
    return null;
  },
};
