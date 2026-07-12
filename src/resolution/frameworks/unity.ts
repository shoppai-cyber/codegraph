/**
 * Unity Framework Resolver
 *
 * Tier 1 is code-only. It keeps Unity host-invoked C# surfaces live without
 * importing scene/prefab/meta snapshot facts into CodeGraph.
 */

import { Node } from '../../types';
import {
  FrameworkExtractionResult,
  FrameworkResolver,
  ResolutionContext,
  ResolvedRef,
  UnresolvedRef,
} from '../types';
import { stripCommentsForRegex } from '../strip-comments';
import invocationTable from './unity-invocation-table.json';

interface HostBaseRule {
  hostInvokedMethods: string[];
  includesMonoBehaviourMessages?: boolean;
  note?: string;
}

interface MethodAttributeRule {
  attribute: string;
  requiresStatic?: boolean;
  requiresInstance?: boolean;
  optionalTypeofReference?: boolean;
}

interface TypeReferenceAttributeRule {
  attribute: string;
}

interface GateConfig {
  requiresAnyUsingPrefix?: string[];
  disqualifyingUsingPrefixes?: string[];
  fullyQualifiedBaseAlternative?: string;
}

interface SyncVarFieldsRule {
  attribute: string;
}

interface SyncVarHooksRule {
  attribute: string;
  argumentName: string;
}

// A gated networking stack (FishNet, Mirror, …). All sub-objects use the same mixed
// documentation/runtime JSON convention as the top-level table, so the loader filters to
// runtime shapes: host bases keep only object values carrying a string[] hostInvokedMethods,
// method attributes keep only entries with a string `attribute`.
interface GatedStackSection {
  gate: GateConfig;
  hostInvokedBases: Record<string, HostBaseRule | string>;
  attributeEntryPoints?: { methodAttributes?: MethodAttributeRule[] };
  syncVarFields?: SyncVarFieldsRule;
  syncVarHooks?: SyncVarHooksRule;
}

interface InvocationTable {
  hostInvokedBases: Record<string, HostBaseRule | string>;
  serializationAttributes: { attributes: string[] };
  attributeEntryPoints: {
    methodAttributes: MethodAttributeRule[];
    classAttributes: Array<{ attribute: string }>;
  };
  typeReferenceAttributes: { attributes: TypeReferenceAttributeRule[] };
  fishnet?: GatedStackSection;
  mirror?: GatedStackSection;
}

interface ClassBlock {
  name: string;
  bases: string[];
  fullBases: string[];
  attributes: AttributeUse[];
  body: string;
  rawBody: string;
  bodyOffset: number;
  filePath: string;
  hostBase: string | null;
  // The gated stacks whose gated rules (host callbacks, RPC/SyncVar attributes) may apply to
  // this class in this file — already filtered to open stacks that OWN this class's host base.
  // Empty for ungated Tier-1 hosts (MonoBehaviour, …) and for non-host classes.
  applicableStacks: GatedStack[];
}

interface MethodDecl {
  name: string;
  isStatic: boolean;
  attributes: AttributeUse[];
  line: number;
  index: number;
  bodyStart: number;
  bodyEnd: number;
  canEmit: boolean;
}

interface MemberDecl {
  name: string;
  typeName: string;
  attributes: AttributeUse[];
  line: number;
  isStatic: boolean;
}

interface AttributeUse {
  rawName: string;
  name: string;
  args: string;
  target: string | null;
}

const TABLE = invocationTable as unknown as InvocationTable;
const HOST_BASE_RULES = Object.fromEntries(
  Object.entries(TABLE.hostInvokedBases).filter(([, value]) => typeof value !== 'string')
) as Record<string, HostBaseRule>;

const HOST_BASES = new Set(Object.keys(HOST_BASE_RULES));
const STATIC_HOST_BASES = new Set(['AssetModificationProcessor']);
const SERIALIZATION_ATTRIBUTES = new Set(TABLE.serializationAttributes.attributes);
const METHOD_ATTRIBUTES = TABLE.attributeEntryPoints.methodAttributes;
const CLASS_ATTRIBUTES = new Set(TABLE.attributeEntryPoints.classAttributes.map((a) => a.attribute));
const TYPE_REFERENCE_ATTRIBUTES = new Set(TABLE.typeReferenceAttributes.attributes.map((a) => a.attribute));

// Gated networking stacks (Tier 2) — FishNet and Mirror. Each stack's host base
// (NetworkBehaviour) is deliberately kept OUT of the ungated HOST_BASES because the bare
// token collides across NGO / FishNet / Mirror / Fusion; a stack's rules fire in a file
// only when its per-file gate is open, and mutual using-disqualification means at most one
// netcode stack opens per file. The NetworkBehaviour host-method set unions the stack's own
// callbacks with MonoBehaviour's messages (the `NetworkBehaviour : MonoBehaviour` chain is
// framework-guaranteed), materialised from the MonoBehaviour entry so that list stays the
// single source of truth (no drift).
const MONO_MESSAGES = HOST_BASE_RULES['MonoBehaviour']?.hostInvokedMethods ?? [];

interface GatedStack {
  name: string;
  usingPrefixes: string[];
  requiredUsingRes: RegExp[];
  disqualifyUsingRes: RegExp[];
  fqBaseAlternative: string | null;
  hostRules: Record<string, HostBaseRule>;
  hostBases: Set<string>;
  methodAttributes: MethodAttributeRule[];
  syncVarAttribute: string | null;
  syncVarHookAttribute: string | null;
  syncVarHookArg: string | null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function usingPrefixRegex(prefix: string): RegExp {
  // Matches a real `using [static] <prefix>;` or `using [static] <prefix>.<sub>;` namespace
  // import. The post-prefix token is constrained to `.` (sub-namespace) or `;` (exact import)
  // so that a longer identifier (`MirrorSharp`) and an ALIAS directive (`using Mirror = X;`,
  // whose next token is `=`) are both rejected — only real namespace imports count (F3).
  return new RegExp(`^\\s*using\\s+(?:static\\s+)?${escapeRegExp(prefix)}(?:\\.|\\s*;)`, 'm');
}

// Loader (decision 3 / F4): only object values carrying a string[] `hostInvokedMethods`
// become host-base rules; string/provenance keys (`note`, `detection`, …) are ignored
// deterministically. NetworkBehaviour unions the stack callbacks with MonoBehaviour's.
function loadStackHostRules(section: Record<string, HostBaseRule | string>): Record<string, HostBaseRule> {
  const rules: Record<string, HostBaseRule> = {};
  for (const [base, value] of Object.entries(section)) {
    if (!value || typeof value !== 'object') continue;
    if (!Array.isArray(value.hostInvokedMethods)) continue;
    const methods = value.includesMonoBehaviourMessages
      ? Array.from(new Set([...value.hostInvokedMethods, ...MONO_MESSAGES]))
      : value.hostInvokedMethods;
    rules[base] = { ...value, hostInvokedMethods: methods };
  }
  return rules;
}

function buildGatedStack(name: string, section: GatedStackSection | undefined): GatedStack | null {
  if (!section) return null;
  const gate = section.gate ?? {};
  const hostRules = loadStackHostRules(section.hostInvokedBases ?? {});
  const methodAttributes = (section.attributeEntryPoints?.methodAttributes ?? []).filter(
    (a): a is MethodAttributeRule => !!a && typeof a.attribute === 'string'
  );
  return {
    name,
    usingPrefixes: gate.requiresAnyUsingPrefix ?? [],
    requiredUsingRes: (gate.requiresAnyUsingPrefix ?? []).map(usingPrefixRegex),
    disqualifyUsingRes: (gate.disqualifyingUsingPrefixes ?? []).map(usingPrefixRegex),
    fqBaseAlternative: gate.fullyQualifiedBaseAlternative ?? null,
    hostRules,
    hostBases: new Set(Object.keys(hostRules)),
    methodAttributes,
    syncVarAttribute: section.syncVarFields?.attribute ?? null,
    // CONSIDER 7: consume syncVarHooks.attribute as the hook-bearing attribute, falling
    // back to the field attribute when absent. For Mirror both are `SyncVar`.
    syncVarHookAttribute: section.syncVarHooks?.attribute ?? section.syncVarFields?.attribute ?? null,
    syncVarHookArg: section.syncVarHooks?.argumentName ?? null,
  };
}

const GATED_STACKS: GatedStack[] = [
  buildGatedStack('fishnet', TABLE.fishnet),
  buildGatedStack('mirror', TABLE.mirror),
].filter((s): s is GatedStack => s !== null);

/** Test-only: exposes the parsed gated-stack shapes for manifest-shape assertions (F4). */
export const __gatedStacksForTest: ReadonlyArray<GatedStack> = GATED_STACKS;

// Every host-base token owned by SOME gated stack (NetworkBehaviour, …). These collide across
// NGO/FishNet/Mirror/Fusion, so a bare occurrence is only a host under an OPEN owning gate and a
// dotted occurrence is only a host when its full form is an open stack's FQ alternative — see
// classifyHost. Kept distinct from the ungated Tier-1 HOST_BASES (MonoBehaviour, …).
const GATED_HOST_TOKENS = new Set<string>();
for (const stack of GATED_STACKS) for (const base of stack.hostBases) GATED_HOST_TOKENS.add(base);

// Host classification descriptor propagated through same-file base chains: the resolved host-base
// token plus the OPEN gated stacks whose gated rules may apply to it (empty for Tier-1 hosts).
interface HostInfo {
  hostBase: string;
  applicable: GatedStack[];
}

/**
 * Classify a single resolved base clause as a Unity host base, or null if it is not one.
 *  - Tier-1 ungated hosts (MonoBehaviour, …) match by short token (a dotted
 *    `UnityEngine.MonoBehaviour` still counts) and carry `applicable: []`.
 *  - Tier-2 gated tokens (NetworkBehaviour, …) are admitted ONLY when they resolve to an OPEN
 *    owning stack: a DOTTED token must equal that stack's `fullyQualifiedBaseAlternative`
 *    exactly (so a foreign `Unity.Netcode.NetworkBehaviour` / `Fusion.NetworkBehaviour` /
 *    `MyStuff.NetworkBehaviour` whose last segment merely collides emits nothing — BLOCKING 1);
 *    a BARE token applies to every open stack that owns it. `applicable` is the surviving
 *    open owners; an empty result means "not a host here" (null).
 */
function classifyHost(fullBase: string, openStacks: GatedStack[]): HostInfo | null {
  const short = fullBase.split('.').pop() || fullBase;
  if (HOST_BASES.has(short)) return { hostBase: short, applicable: [] };
  if (GATED_HOST_TOKENS.has(short)) {
    if (fullBase.includes('.')) {
      const owners = openStacks.filter((s) => s.fqBaseAlternative === fullBase);
      return owners.length ? { hostBase: short, applicable: owners } : null;
    }
    const applicable = openStacks.filter((s) => s.hostBases.has(short));
    return applicable.length ? { hostBase: short, applicable } : null;
  }
  return null;
}

/**
 * Stacks whose per-file gate is open. Two-phase (F2):
 *  - EXCLUSION (a disqualifying competitor `using`) always wins and is decidable pre-parse.
 *  - EVIDENCE is either a required namespace import OR the stack's fully-qualified base
 *    alternative appearing as a PARSED CLASS BASE clause — a bare occurrence of that token
 *    elsewhere (e.g. a field/parameter type) never opens the gate.
 * Read from comment-stripped, string-masked source.
 */
function openStacksFor(safe: string, classes: ClassBlock[]): GatedStack[] {
  return GATED_STACKS.filter((stack) => {
    if (stack.disqualifyUsingRes.some((re) => re.test(safe))) return false;
    if (stack.requiredUsingRes.some((re) => re.test(safe))) return true;
    if (stack.fqBaseAlternative) {
      return classes.some((cls) => cls.fullBases.includes(stack.fqBaseAlternative!));
    }
    return false;
  });
}

const HOST_REF_PREFIX = 'unity:host:';
const FIELD_REF_PREFIX = 'unity:field:';
const METHOD_REF_PREFIX = 'unity:method:';

const BUILTIN_TYPE_NAMES = new Set([
  'bool',
  'byte',
  'char',
  'decimal',
  'double',
  'float',
  'int',
  'long',
  'object',
  'sbyte',
  'short',
  'string',
  'uint',
  'ulong',
  'ushort',
  'void',
  'Boolean',
  'Byte',
  'Char',
  'Decimal',
  'Double',
  'Single',
  'Int32',
  'Int64',
  'Object',
  'String',
  'UInt32',
  'UInt64',
  'Vector2',
  'Vector3',
  'Vector4',
  'Quaternion',
  'GameObject',
  'Transform',
  'Rigidbody',
  'Rigidbody2D',
  'Collider',
  'Collider2D',
  'MonoBehaviour',
  'ScriptableObject',
]);

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function normalizeAttributeName(name: string): string {
  const last = name.split('.').pop() || name;
  return last.endsWith('Attribute') ? last.slice(0, -'Attribute'.length) : last;
}

function parseAttributes(text: string): AttributeUse[] {
  const attrs: AttributeUse[] = [];
  const attrRegex = /\[([^\]]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(text)) !== null) {
    let body = match[1]!.trim();
    let target: string | null = null;
    const targetMatch = /^([A-Za-z_]\w*)\s*:\s*(.+)$/.exec(body);
    if (targetMatch) {
      target = targetMatch[1]!;
      body = targetMatch[2]!.trim();
    }
    const nameMatch = /^([A-Za-z_][\w.]*)/.exec(body);
    if (!nameMatch) continue;
    const rawName = nameMatch[1]!;
    const parenIndex = body.indexOf('(');
    const args = parenIndex === -1 ? '' : body.slice(parenIndex + 1, body.lastIndexOf(')'));
    attrs.push({ rawName, name: normalizeAttributeName(rawName), args, target });
  }
  return attrs;
}

function leadingAttributes(content: string, index: number): AttributeUse[] {
  const prefix = content.slice(Math.max(0, index - 1000), index);
  const match = /((?:[ \t]*\[[^\]]+\][ \t]*(?:\r?\n)?)+)[ \t]*$/.exec(prefix);
  return match ? parseAttributes(match[1]!) : [];
}

function maskStringLiterals(content: string): string {
  const chars = content.split('');
  for (let i = 0; i < chars.length; i++) {
    const quote = chars[i];
    const prev = i > 0 ? chars[i - 1] : '';
    if (quote !== '"' && quote !== "'") continue;
    const isVerbatim = prev === '@' || (prev === '"' && i > 1 && chars[i - 2] === '@');
    chars[i] = ' ';
    let j = i + 1;
    while (j < chars.length) {
      const c = chars[j];
      chars[j] = ' ';
      if (c === quote) {
        if (isVerbatim && chars[j + 1] === quote) {
          chars[j + 1] = ' ';
          j += 2;
          continue;
        }
        break;
      }
      if (!isVerbatim && c === '\\') {
        if (j + 1 < chars.length) chars[j + 1] = ' ';
        j += 2;
        continue;
      }
      j++;
    }
    i = j;
  }
  return chars.join('');
}

function findMatchingBrace(content: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < content.length; i++) {
    const c = content[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findMatchingParen(content: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < content.length; i++) {
    const c = content[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '(' || c === '[' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '>') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

function topLevelAt(body: string, index: number): boolean {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    const c = body[i];
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
  }
  return depth === 0;
}

function stripGenericSuffix(base: string): string {
  const generic = base.indexOf('<');
  return (generic === -1 ? base : base.slice(0, generic)).trim();
}

// Full alias-resolved dotted base form (generic suffix stripped) — e.g.
// `FishNet.Object.NetworkBehaviour`. Used for gate FQ-base evidence (F2).
function resolveBaseFull(base: string, aliases: Map<string, string>): string {
  let value = stripGenericSuffix(base.trim());
  const dot = value.indexOf('.');
  if (dot !== -1) {
    const head = value.slice(0, dot);
    const alias = aliases.get(head);
    if (alias) value = `${alias}${value.slice(dot)}`;
  } else {
    value = aliases.get(value) || value;
  }
  return value;
}

function parseAliases(content: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const regex = /^\s*using\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_][\w.]*)\s*;/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    aliases.set(match[1]!, match[2]!);
  }
  return aliases;
}

function parseClassBlocks(content: string, filePath: string): { classes: ClassBlock[]; openStacks: GatedStack[] } {
  const noComments = stripCommentsForRegex(content, 'csharp');
  const safe = maskStringLiterals(noComments);
  const aliases = parseAliases(safe);
  const classes: ClassBlock[] = [];
  const classRegex = /(?:\b(?:public|private|protected|internal|sealed|abstract|partial|static|new)\s+)*class\s+([A-Za-z_]\w*)(?:\s*:\s*([^{]+))?\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = classRegex.exec(safe)) !== null) {
    const openBrace = safe.indexOf('{', match.index);
    if (openBrace === -1) continue;
    const closeBrace = findMatchingBrace(safe, openBrace);
    if (closeBrace === -1) continue;
    const baseTokens = splitTopLevel(match[2] || '');
    const fullBases = baseTokens.map((b) => resolveBaseFull(b, aliases));
    const bases = fullBases.map((b) => b.split('.').pop() || b);
    classes.push({
      name: match[1]!,
      bases,
      fullBases,
      attributes: leadingAttributes(safe, match.index),
      body: safe.slice(openBrace + 1, closeBrace),
      rawBody: noComments.slice(openBrace + 1, closeBrace),
      bodyOffset: openBrace + 1,
      filePath,
      hostBase: null,
      applicableStacks: [],
    });
  }

  // Gate resolution happens AFTER class parsing so FQ-base evidence (F2) can be checked
  // against real base clauses. Exclusion is still pre-parse (inside openStacksFor).
  const openStacks = openStacksFor(safe, classes);

  // Direct host classification from a class's OWN resolved bases. fullBases carries the dotted
  // form so classifyHost distinguishes a foreign FQ token from an owning stack's FQ alternative
  // (BLOCKING 1); the returned HostInfo carries the open owning stacks so FQ ownership can
  // propagate (BLOCKING 2). Evaluated per-block (not read back from the name map) so partial
  // class blocks sharing a name stay independent — a base-less partial block is not a host.
  const directInfoFor = (cls: ClassBlock): HostInfo | null => {
    for (const full of cls.fullBases) {
      const info = classifyHost(full, openStacks);
      if (info) return info;
    }
    return null;
  };

  // Name → direct HostInfo, the lookup target when another class in the same file names it as a
  // base. The whole descriptor propagates, so a same-file chain inherits its root's owning stacks.
  const directHostByName = new Map<string, HostInfo>();
  for (const cls of classes) {
    const info = directInfoFor(cls);
    if (info) directHostByName.set(cls.name, info);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const cls of classes) {
      if (directHostByName.has(cls.name)) continue;
      const inheritedBase = cls.bases.find((b) => directHostByName.has(b));
      if (inheritedBase) {
        directHostByName.set(cls.name, directHostByName.get(inheritedBase)!);
        changed = true;
      }
    }
  }

  const resolved = classes.map((cls) => {
    const direct = directInfoFor(cls);
    const chainedBase = cls.bases.find((b) => directHostByName.has(b));
    const info = direct ?? (chainedBase ? directHostByName.get(chainedBase)! : null);
    return {
      ...cls,
      hostBase: info ? info.hostBase : null,
      applicableStacks: info ? info.applicable : [],
    };
  });
  return { classes: resolved, openStacks };
}

function parseMethods(cls: ClassBlock, originalContent: string): MethodDecl[] {
  const methods: MethodDecl[] = [];
  const methodRegex = /((?:\s*\[[^\]]+\]\s*)*)(?:(?:public|private|protected|internal|static|virtual|override|sealed|async|new|unsafe|extern)\s+)*[A-Za-z_][\w<>,\s\[\]?.]*\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = methodRegex.exec(cls.body)) !== null) {
    if (!topLevelAt(cls.body, match.index)) continue;
    const header = match[0]!;
    const name = match[2]!;
    const openBrace = cls.body.indexOf('{', match.index);
    const closeBrace = openBrace === -1 ? -1 : findMatchingBrace(cls.body, openBrace);
    methods.push({
      name,
      isStatic: /\bstatic\b/.test(header),
      attributes: parseAttributes(match[1] || ''),
      line: lineNumberAt(originalContent, cls.bodyOffset + match.index),
      index: match.index,
      bodyStart: openBrace,
      bodyEnd: closeBrace,
      canEmit: true,
    });
  }

  const expressionRegex = /((?:\s*\[[^\]]+\]\s*)*)(?:(?:public|private|protected|internal|static|virtual|override|sealed|async|new|unsafe|extern)\s+)*[A-Za-z_][\w<>,\s\[\]?.]*\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*=>[^;{}]*;/g;
  while ((match = expressionRegex.exec(cls.body)) !== null) {
    if (!topLevelAt(cls.body, match.index)) continue;
    const header = match[0]!;
    methods.push({
      name: match[2]!,
      isStatic: /\bstatic\b/.test(header),
      attributes: parseAttributes(match[1] || ''),
      line: lineNumberAt(originalContent, cls.bodyOffset + match.index),
      index: match.index,
      bodyStart: -1,
      bodyEnd: -1,
      canEmit: true,
    });
  }

  const declarationRegex = /((?:\s*\[[^\]]+\]\s*)*)(?:(?:public|private|protected|internal|static|virtual|override|sealed|async|new|unsafe|extern|abstract)\s+)*[A-Za-z_][\w<>,\s\[\]?.]*\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*;/g;
  while ((match = declarationRegex.exec(cls.body)) !== null) {
    if (!topLevelAt(cls.body, match.index)) continue;
    const header = match[0]!;
    methods.push({
      name: match[2]!,
      isStatic: /\bstatic\b/.test(header),
      attributes: parseAttributes(match[1] || ''),
      line: lineNumberAt(originalContent, cls.bodyOffset + match.index),
      index: match.index,
      bodyStart: -1,
      bodyEnd: -1,
      canEmit: false,
    });
  }

  return methods;
}

function parseFields(cls: ClassBlock, originalContent: string): MemberDecl[] {
  const fields: MemberDecl[] = [];
  // A field we care about always carries an attribute block (bare fields are never emitted).
  // Groups: (1) attribute block, (2) modifiers, (3) type, (4) declarator list.
  // The TYPE supports a plain/dotted name, a generic argument list (`<...>`, which may carry
  // commas and spaces), a nullable `?`, and one-or-more array ranks (`[]`, `[,]`, `[][]`). The
  // DECLARATOR list is a comma-separated set of `name` (with an optional `= initializer`) so a
  // multi-declarator field (`[SyncVar] int a, b, c;`) yields one MemberDecl per name. Parens are
  // excluded from names, so a method declaration (`void Foo();`) never matches as a field.
  const fieldRegex =
    /((?:\s*\[[^\]]+\]\s*)+)((?:(?:public|private|protected|internal|static|readonly|volatile|new|const)\s+)*)([A-Za-z_][\w.]*(?:\s*<[^;{}]*>)?\s*\??(?:\s*\[[\s,]*\])*)\s+([A-Za-z_]\w*(?:\s*=[^;{}]*)?(?:\s*,\s*[A-Za-z_]\w*(?:\s*=[^;{}]*)?)*)\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = fieldRegex.exec(cls.body)) !== null) {
    if (!topLevelAt(cls.body, match.index)) continue;
    const attrBlock = match[1] || '';
    const modifiers = match[2] || '';
    const typeName = match[3]!.replace(/\s+/g, ''); // `Dictionary<int, string>` → `Dictionary<int,string>`
    const attrs = cls.rawBody.slice(match.index, match.index + attrBlock.length);
    const parsedAttrs = parseAttributes(attrs);
    const isStatic = /\bstatic\b/.test(modifiers);
    const line = lineNumberAt(originalContent, cls.bodyOffset + match.index);
    for (const decl of splitTopLevel(match[4]!)) {
      const nameMatch = /^([A-Za-z_]\w*)/.exec(decl);
      if (!nameMatch) continue;
      fields.push({
        name: nameMatch[1]!,
        typeName,
        attributes: parsedAttrs,
        line,
        isStatic,
      });
    }
  }
  return fields;
}

function parseProperties(cls: ClassBlock, originalContent: string): MemberDecl[] {
  const properties: MemberDecl[] = [];
  const propRegex = /((?:\s*\[[^\]]+\]\s*)+)\s*(?:(?:public|private|protected|internal|static|new)\s+)*([A-Za-z_][\w.<>]*)\s+([A-Za-z_]\w*)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = propRegex.exec(cls.body)) !== null) {
    if (!topLevelAt(cls.body, match.index)) continue;
    const attrs = cls.rawBody.slice(match.index, match.index + (match[1] || '').length);
    properties.push({
      name: match[3]!,
      typeName: match[2]!,
      attributes: parseAttributes(attrs),
      line: lineNumberAt(originalContent, cls.bodyOffset + match.index),
      isStatic: /\bstatic\b/.test(match[0]!.slice((match[1] || '').length)),
    });
  }
  return properties;
}

function isLocalTypeReference(typeName: string): boolean {
  const clean = typeName.replace(/\[\]$/, '').replace(/\?$/, '');
  if (!/^[A-ZI][A-Za-z0-9_]*$/.test(clean)) return false;
  if (BUILTIN_TYPE_NAMES.has(clean)) return false;
  if (clean.startsWith('System.') || clean.startsWith('UnityEngine.')) return false;
  return true;
}

// The local user-type reference name for a field/property type, or null when the type is builtin,
// external, or not resolvable to a single core identifier. Strips array/jagged/multidim ranks and
// the nullable `?` so `PlayerData[]`, `PlayerData?`, and `Some.PlayerData` all reference
// `PlayerData`. Generic types (`List<PlayerData>`) return null — element extraction from generic
// arguments is a deliberate coverage bound (the container itself is not a local user type ref).
function localTypeRefName(typeName: string): string | null {
  const simpleFull = typeName.split('.').pop() || typeName;
  const core = simpleFull.replace(/(\[[\s,]*\])+$/, '').replace(/\?$/, '');
  if (!core || core.includes('<')) return null;
  return isLocalTypeReference(core) ? core : null;
}

function localTypeFromTypeofArgs(args: string): string[] {
  const refs: string[] = [];
  const regex = /typeof\s*\(\s*([A-Za-z_][\w.]*)\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(args)) !== null) {
    const typeName = match[1]!;
    const simple = typeName.split('.').pop() || typeName;
    if (isLocalTypeReference(typeName) || isLocalTypeReference(simple)) refs.push(simple);
  }
  return refs;
}

function makeRouteNode(filePath: string, line: number, name: string): Node {
  return {
    id: `route:unity:${filePath}:${line}:${name}`,
    kind: 'route',
    name,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    startLine: line,
    endLine: line,
    startColumn: 0,
    endColumn: 0,
    language: 'csharp',
    updatedAt: Date.now(),
  };
}

function makeRef(node: Node, referenceName: string): UnresolvedRef {
  return {
    fromNodeId: node.id,
    referenceName,
    referenceKind: 'references',
    line: node.startLine,
    column: 0,
    filePath: node.filePath,
    language: 'csharp',
  };
}

function pushNodeRef(
  result: FrameworkExtractionResult,
  seenNodes: Set<string>,
  seenRefs: Set<string>,
  filePath: string,
  line: number,
  nodeName: string,
  refNames: string[]
): void {
  if (!seenNodes.has(nodeName)) {
    const node = makeRouteNode(filePath, line, nodeName);
    result.nodes.push(node);
    seenNodes.add(nodeName);
    for (const refName of refNames) {
      const key = `${node.id}:${refName}`;
      if (!seenRefs.has(key)) {
        result.references.push(makeRef(node, refName));
        seenRefs.add(key);
      }
    }
    return;
  }

  for (const node of result.nodes) {
    if (node.name !== nodeName) continue;
    for (const refName of refNames) {
      const key = `${node.id}:${refName}`;
      if (!seenRefs.has(key)) {
        result.references.push(makeRef(node, refName));
        seenRefs.add(key);
      }
    }
  }
}

function findAttribute(attrs: AttributeUse[], name: string): AttributeUse | undefined {
  return attrs.find((a) => a.name === name);
}

// True when `qualifier` (the namespace part of a written attribute name, e.g. `Mirror` in
// `[Mirror.Command]`) belongs to a gated stack's own namespace — one of its using prefixes or
// the namespace root of its fully-qualified base. `FishNet.Object` belongs to FishNet, `Other`
// belongs to nobody.
function attrQualifierBelongsToStack(qualifier: string, stack: GatedStack): boolean {
  const owners = [...stack.usingPrefixes];
  if (stack.fqBaseAlternative) {
    const ns = stack.fqBaseAlternative.split('.').slice(0, -1).join('.');
    if (ns) owners.push(ns);
  }
  return owners.some((p) => qualifier === p || qualifier.startsWith(`${p}.`));
}

// Gated attribute matching (BLOCKING 3): inspect the RAW written attribute token, not the
// fully-normalized name (which strips every namespace and would let a foreign `[Other.Command]`
// masquerade as Mirror's `[Command]`). Accept a bare token (`Command`), an `Attribute`-suffixed
// token (`CommandAttribute`), or a qualified token ONLY when the qualifier belongs to the owning
// stack's namespace (`Mirror.Command`, `Mirror.CommandAttribute`, `FishNet.Object.ServerRpc`).
function gatedAttributeMatches(rawName: string, ruleName: string, stack: GatedStack): boolean {
  const segments = rawName.split('.');
  const last = segments[segments.length - 1]!;
  const bareLast = last.endsWith('Attribute') ? last.slice(0, -'Attribute'.length) : last;
  if (bareLast !== ruleName) return false;
  if (segments.length === 1) return true;
  return attrQualifierBelongsToStack(segments.slice(0, -1).join('.'), stack);
}

function findGatedAttribute(
  attrs: AttributeUse[],
  ruleName: string,
  stack: GatedStack
): AttributeUse | undefined {
  return attrs.find((a) => gatedAttributeMatches(a.rawName, ruleName, stack));
}

function hasSerializationAttribute(attrs: AttributeUse[]): boolean {
  return attrs.some((a) => SERIALIZATION_ATTRIBUTES.has(a.name));
}

function extractMethodNameArg(arg: string): string | null {
  const trimmed = arg.trim();
  const literal = /^"([A-Za-z_]\w*)"$/.exec(trimmed);
  if (literal) return literal[1]!;
  const nameof = /^nameof\s*\(\s*([A-Za-z_]\w*)\s*\)$/.exec(trimmed);
  return nameof ? nameof[1]! : null;
}

// Value of a named attribute argument (`name = <value>`), read at the top level of the
// attribute's argument list; returns null when the name is absent. Used for [SyncVar(hook = …)].
function namedArgValue(args: string, name: string): string | null {
  for (const part of splitTopLevel(args)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}

function firstArgument(args: string): string {
  return splitTopLevel(args)[0] || '';
}

function secondArgument(args: string): string {
  return splitTopLevel(args)[1] || '';
}

function uniqueMethod(methods: MethodDecl[], name: string): MethodDecl | null {
  const matches = methods.filter((m) => m.name === name);
  if (matches.length !== 1) return null;
  return matches[0]!.canEmit ? matches[0]! : null;
}

function isInsideTopLevelMethod(methods: MethodDecl[], index: number): boolean {
  return methods.some((method) => method.bodyStart !== -1 && method.bodyEnd !== -1 && index > method.bodyStart && index < method.bodyEnd);
}

function previousNonWhitespace(text: string, index: number): number {
  for (let i = index; i >= 0; i--) {
    if (!/\s/.test(text[i]!)) return i;
  }
  return -1;
}

function readIdentifierEndingAt(text: string, index: number): { name: string; start: number } | null {
  if (index < 0 || !/[A-Za-z0-9_]/.test(text[index]!)) return null;
  let start = index;
  while (start >= 0 && /[A-Za-z0-9_]/.test(text[start]!)) start--;
  const name = text.slice(start + 1, index + 1);
  return /^[A-Za-z_]\w*$/.test(name) ? { name, start: start + 1 } : null;
}

function hasNoMemberPrefix(text: string, identifierStart: number): boolean {
  const before = previousNonWhitespace(text, identifierStart - 1);
  return before === -1 || (text[before] !== '.' && text[before] !== '?' && text[before] !== ')' && text[before] !== ']');
}

function allowsStringCallReceiver(text: string, callStart: number, family: string): boolean {
  const beforeCall = previousNonWhitespace(text, callStart - 1);
  if (beforeCall === -1 || text[beforeCall] !== '.') {
    return hasNoMemberPrefix(text, callStart);
  }

  let receiverEnd = previousNonWhitespace(text, beforeCall - 1);
  if (receiverEnd === -1 || text[receiverEnd] === '?') return false;
  const receiver = readIdentifierEndingAt(text, receiverEnd);
  if (!receiver) return false;
  const beforeReceiver = previousNonWhitespace(text, receiver.start - 1);

  if (receiver.name === 'this') {
    return beforeReceiver === -1 || (text[beforeReceiver] !== '.' && text[beforeReceiver] !== '?' && text[beforeReceiver] !== ')' && text[beforeReceiver] !== ']');
  }

  if (family !== 'SendMessage' || receiver.name !== 'gameObject') return false;
  if (beforeReceiver === -1 || text[beforeReceiver] !== '.') return true;

  let ownerEnd = previousNonWhitespace(text, beforeReceiver - 1);
  if (ownerEnd === -1 || text[ownerEnd] === '?') return false;
  const owner = readIdentifierEndingAt(text, ownerEnd);
  if (!owner || owner.name !== 'this') return false;
  const beforeOwner = previousNonWhitespace(text, owner.start - 1);
  return beforeOwner === -1 || (text[beforeOwner] !== '.' && text[beforeOwner] !== '?' && text[beforeOwner] !== ')' && text[beforeOwner] !== ']');
}

function processStringCalls(
  result: FrameworkExtractionResult,
  seenNodes: Set<string>,
  seenRefs: Set<string>,
  cls: ClassBlock,
  methods: MethodDecl[]
): void {
  if (!cls.hostBase) return;
  const families: Array<{
    nodeFamily: string;
    regex: RegExp;
  }> = [
    {
      nodeFamily: 'SendMessage',
      regex: /\b(SendMessage|BroadcastMessage|SendMessageUpwards)\s*\(/g,
    },
    {
      nodeFamily: 'Invoke',
      regex: /\b(Invoke|InvokeRepeating|CancelInvoke|IsInvoking)\s*\(/g,
    },
    {
      nodeFamily: 'StartCoroutine',
      regex: /\b(StartCoroutine|StopCoroutine)\s*\(/g,
    },
  ];

  for (const family of families) {
    let match: RegExpExecArray | null;
    while ((match = family.regex.exec(cls.body)) !== null) {
      if (!isInsideTopLevelMethod(methods, match.index)) continue;
      if (!allowsStringCallReceiver(cls.body, match.index, family.nodeFamily)) continue;
      const open = cls.body.indexOf('(', match.index);
      const close = findMatchingParen(cls.body, open);
      if (close === -1) continue;
      const methodName = extractMethodNameArg(firstArgument(cls.rawBody.slice(open + 1, close)));
      if (!methodName) continue;
      const target = uniqueMethod(methods, methodName);
      if (!target) continue;
      pushNodeRef(
        result,
        seenNodes,
        seenRefs,
        cls.filePath,
        target.line,
        `UNITY string-invoke ${family.nodeFamily} ${cls.name}.${methodName}`,
        [`${METHOD_REF_PREFIX}${cls.name}.${methodName}`]
      );
    }
  }
}

function processContextMenuItems(
  result: FrameworkExtractionResult,
  seenNodes: Set<string>,
  seenRefs: Set<string>,
  cls: ClassBlock,
  methods: MethodDecl[],
  fields: MemberDecl[]
): void {
  if (!cls.hostBase) return;
  for (const field of fields) {
    for (const attr of field.attributes) {
      if (attr.name !== 'ContextMenuItem') continue;
      const methodName = extractMethodNameArg(secondArgument(attr.args));
      if (!methodName) continue;
      const target = uniqueMethod(methods, methodName);
      if (!target) continue;
      pushNodeRef(
        result,
        seenNodes,
        seenRefs,
        cls.filePath,
        field.line,
        `UNITY string-invoke ContextMenuItem ${cls.name}.${methodName}`,
        [`${METHOD_REF_PREFIX}${cls.name}.${methodName}`]
      );
    }
  }
}

function processClass(
  result: FrameworkExtractionResult,
  seenNodes: Set<string>,
  seenRefs: Set<string>,
  cls: ClassBlock,
  originalContent: string
): void {
  const methods = parseMethods(cls, originalContent);
  const fields = parseFields(cls, originalContent);
  const properties = parseProperties(cls, originalContent);

  // The gated stacks whose gated rules may apply to this class were resolved during class parsing
  // (classifyHost + same-file chain propagation) and carried on the class as `applicableStacks`:
  //  - a class rooted in a stack's fully-qualified base (`: Mirror.NetworkBehaviour`) is owned by
  //    THAT stack alone, so a competing stack whose gate is open in the same file cannot claim it;
  //  - a foreign FQ base whose last segment merely collides (`Unity.Netcode.NetworkBehaviour`)
  //    resolved to no host at all, so it isn't here;
  //  - a bare-token host applies to every open owning stack (mutual using-disqualification already
  //    guarantees ≤1 open stack in that case);
  //  - ownership propagates through same-file base chains, so a derived class is bound to the same
  //    stack(s) as the base it ultimately roots in (BLOCKING 1/2).
  const applicableStacks = cls.applicableStacks;

  if (cls.hostBase) {
    const stackRule = cls.hostBase
      ? applicableStacks.map((s) => s.hostRules[cls.hostBase!]).find(Boolean)
      : undefined;
    const rule = HOST_BASE_RULES[cls.hostBase] || stackRule;
    if (rule) {
      const hostMethods = new Set(rule.hostInvokedMethods);
      for (const method of methods) {
        if (!method.canEmit) continue;
        if (!hostMethods.has(method.name)) continue;
        if (STATIC_HOST_BASES.has(cls.hostBase) && !method.isStatic) continue;
        pushNodeRef(
          result,
          seenNodes,
          seenRefs,
          cls.filePath,
          method.line,
          `UNITY ${cls.hostBase}.${method.name} ${cls.name}.${method.name}`,
          [`${HOST_REF_PREFIX}${cls.name}.${method.name}`]
        );
      }
    }
  }

  for (const attrName of CLASS_ATTRIBUTES) {
    if (!findAttribute(cls.attributes, attrName)) continue;
    pushNodeRef(
      result,
      seenNodes,
      seenRefs,
      cls.filePath,
      lineNumberAt(originalContent, cls.bodyOffset),
      `UNITY attribute ${attrName} ${cls.name}`,
      [cls.name]
    );
  }

  for (const method of methods) {
    if (!method.canEmit) continue;
    for (const rule of METHOD_ATTRIBUTES) {
      const attr = findAttribute(method.attributes, rule.attribute);
      if (!attr) continue;
      if (rule.requiresStatic && !method.isStatic) continue;
      if (rule.requiresInstance && method.isStatic) continue;
      const refs = [`${METHOD_REF_PREFIX}${cls.name}.${method.name}`];
      if (rule.optionalTypeofReference) refs.push(...localTypeFromTypeofArgs(attr.args));
      pushNodeRef(
        result,
        seenNodes,
        seenRefs,
        cls.filePath,
        method.line,
        `UNITY attribute ${rule.attribute} ${cls.name}.${method.name}`,
        refs
      );
    }
  }

  // Gated networking attribute entry points (RPC / prediction / remote-call) — only on a
  // class provably host-based in an OPEN stack, and only while that stack's gate is open.
  // Mutual using-disqualification means at most one stack matches NetworkBehaviour per file.
  if (cls.hostBase) {
    for (const stack of applicableStacks) {
      if (!stack.hostBases.has(cls.hostBase)) continue;
      for (const method of methods) {
        if (!method.canEmit) continue;
        for (const rule of stack.methodAttributes) {
          const attr = findGatedAttribute(method.attributes, rule.attribute, stack);
          if (!attr) continue;
          if (rule.requiresStatic && !method.isStatic) continue;
          if (rule.requiresInstance && method.isStatic) continue;
          pushNodeRef(
            result,
            seenNodes,
            seenRefs,
            cls.filePath,
            method.line,
            `UNITY attribute ${rule.attribute} ${cls.name}.${method.name}`,
            [`${METHOD_REF_PREFIX}${cls.name}.${method.name}`]
          );
        }
      }
    }
  }

  // Gated SyncVar field + hook liveness (Mirror). A NON-STATIC [SyncVar] field on a class
  // provably host-based in an open stack gets framework-consumed field liveness (same
  // emission shape as the serialized-field rule below). A [SyncVar(hook = nameof(M) / "M")]
  // additionally keeps the resolved hook method live ONLY when the hook value is a
  // compile-time simple identifier AND names EXACTLY ONE non-overloaded method in the same
  // class block. Every ambiguous form (qualified nameof, absent name, overloaded name,
  // static field) emits nothing per the emit-nothing policy (coverage bounds in the table).
  if (cls.hostBase) {
    for (const stack of applicableStacks) {
      if (!stack.syncVarAttribute) continue;
      if (!stack.hostBases.has(cls.hostBase)) continue;
      for (const field of fields) {
        if (field.isStatic) continue;
        const attr = findGatedAttribute(field.attributes, stack.syncVarAttribute, stack);
        if (!attr) continue;
        const fieldRefs = [`${FIELD_REF_PREFIX}${cls.name}.${field.name}`];
        const typeRef = localTypeRefName(field.typeName);
        if (typeRef) fieldRefs.push(typeRef);
        pushNodeRef(
          result,
          seenNodes,
          seenRefs,
          cls.filePath,
          field.line,
          `UNITY SyncVar field ${cls.name}.${field.name}`,
          fieldRefs
        );

        // Hook liveness reads the hook argument from the hook-bearing attribute, matched via the
        // stack's dedicated syncVarHookAttribute (CONSIDER 7 — consumes syncVarHooks.attribute,
        // falling back to the field attribute). For Mirror both are `SyncVar`, so the hook lives on
        // the same attribute already found above and behavior is unchanged.
        if (!stack.syncVarHookAttribute || !stack.syncVarHookArg) continue;
        const hookAttr =
          stack.syncVarHookAttribute === stack.syncVarAttribute
            ? attr
            : findGatedAttribute(field.attributes, stack.syncVarHookAttribute, stack);
        if (!hookAttr) continue;
        const hookRaw = namedArgValue(hookAttr.args, stack.syncVarHookArg);
        if (hookRaw === null) continue;
        const hookName = extractMethodNameArg(hookRaw);
        if (!hookName) continue;
        const target = uniqueMethod(methods, hookName);
        if (!target) continue;
        pushNodeRef(
          result,
          seenNodes,
          seenRefs,
          cls.filePath,
          target.line,
          `UNITY SyncVar hook ${cls.name}.${hookName}`,
          [`${METHOD_REF_PREFIX}${cls.name}.${hookName}`]
        );
      }
    }
  }

  for (const attrName of TYPE_REFERENCE_ATTRIBUTES) {
    const attr = findAttribute(cls.attributes, attrName);
    if (!attr) continue;
    const refs = localTypeFromTypeofArgs(attr.args);
    if (refs.length === 0) continue;
    pushNodeRef(
      result,
      seenNodes,
      seenRefs,
      cls.filePath,
      lineNumberAt(originalContent, cls.bodyOffset),
      `UNITY type-ref ${attrName} ${cls.name}`,
      refs
    );
  }

  for (const field of fields) {
    if (!hasSerializationAttribute(field.attributes)) continue;
    const refs = [`${FIELD_REF_PREFIX}${cls.name}.${field.name}`];
    const typeRef = localTypeRefName(field.typeName);
    if (typeRef) refs.push(typeRef);
    pushNodeRef(
      result,
      seenNodes,
      seenRefs,
      cls.filePath,
      field.line,
      `UNITY serialized field ${cls.name}.${field.name}`,
      refs
    );
  }

  for (const prop of properties) {
    const fieldSerialize = prop.attributes.some(
      (a) => a.target === 'field' && SERIALIZATION_ATTRIBUTES.has(a.name)
    );
    if (!fieldSerialize) continue;
    const refs = [`${FIELD_REF_PREFIX}${cls.name}.${prop.name}`];
    const typeRef = localTypeRefName(prop.typeName);
    if (typeRef) refs.push(typeRef);
    pushNodeRef(
      result,
      seenNodes,
      seenRefs,
      cls.filePath,
      prop.line,
      `UNITY serialized property ${cls.name}.${prop.name}`,
      refs
    );
  }

  processStringCalls(result, seenNodes, seenRefs, cls, methods);
  processContextMenuItems(result, seenNodes, seenRefs, cls, methods, fields);
}

function hasConcreteUnitySourceSignal(content: string): boolean {
  const safe = maskStringLiterals(stripCommentsForRegex(content, 'csharp'));
  if (/\bclass\s+[A-Za-z_]\w*\s*:\s*(?:UnityEngine\.)?(?:MonoBehaviour|ScriptableObject|StateMachineBehaviour)\b/.test(safe)) return true;
  if (/\bclass\s+[A-Za-z_]\w*\s*:\s*(?:UnityEditor\.)?(?:Editor|EditorWindow|PropertyDrawer|DecoratorDrawer|AssetPostprocessor|AssetModificationProcessor)\b/.test(safe)) return true;
  if (/\[(?:UnityEngine\.|UnityEditor\.)?(?:SerializeField|SerializeReference|RuntimeInitializeOnLoadMethod|InitializeOnLoadMethod|MenuItem|ContextMenu|CreateAssetMenu|AddComponentMenu|RequireComponent|CustomEditor|CustomPropertyDrawer|DrawGizmo)(?:Attribute)?\b/.test(safe)) return true;
  return false;
}

function pathsEqual(left: string, right: string): boolean {
  return left.replace(/\\/g, '/') === right.replace(/\\/g, '/');
}

function matchesScopedSymbol(node: Node, scoped: string): boolean {
  const values = [node.id, node.qualifiedName];
  return values.some(
    (value) =>
      value === scoped ||
      value.endsWith(`.${scoped}`) ||
      value.endsWith(`::${scoped}`) ||
      value.endsWith(`/${scoped}`) ||
      value.endsWith(`:${scoped}`)
  );
}

function resolveSynthetic(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const prefix = [HOST_REF_PREFIX, FIELD_REF_PREFIX, METHOD_REF_PREFIX].find((p) =>
    ref.referenceName.startsWith(p)
  );
  if (!prefix) return null;
  const target = ref.referenceName.slice(prefix.length);
  const dot = target.lastIndexOf('.');
  if (dot === -1) return null;
  const className = target.slice(0, dot);
  const memberName = target.slice(dot + 1);
  const nodes = context.getNodesInFile(ref.filePath);
  for (const cls of context.getNodesByName(className)) {
    if (!pathsEqual(cls.filePath, ref.filePath)) continue;
    const contained = nodes.find(
      (node) =>
        node.id !== cls.id &&
        node.name === memberName &&
        pathsEqual(node.filePath, cls.filePath) &&
        node.startLine >= cls.startLine &&
        node.startLine <= cls.endLine
    );
    if (contained) {
      return {
        original: ref,
        targetNodeId: contained.id,
        confidence: 1,
        resolvedBy: 'framework',
      };
    }
  }

  const scoped = `${className}.${memberName}`;
  const match = nodes.find((node) => node.name === memberName && matchesScopedSymbol(node, scoped));
  if (!match) return null;
  return {
    original: ref,
    targetNodeId: match.id,
    confidence: 1,
    resolvedBy: 'framework',
  };
}

export const unityResolver: FrameworkResolver = {
  name: 'unity',
  languages: ['csharp'],

  detect(context: ResolutionContext): boolean {
    if (context.fileExists('ProjectSettings/ProjectVersion.txt')) return true;
    const files = context.getAllFiles();
    if (files.some((f) => f.endsWith('.asmdef'))) return true;
    if (files.some((f) => f.endsWith('.meta')) && files.some((f) => f.startsWith('Assets/') || f.startsWith('ProjectSettings/'))) return true;
    const manifestFiles = new Set(['Packages/manifest.json', ...files.filter((f) => f.endsWith('Packages/manifest.json'))]);
    for (const file of manifestFiles) {
      const manifest = context.readFile(file);
      if (manifest?.includes('com.unity.')) return true;
    }
    for (const file of files) {
      if (!file.endsWith('.cs')) continue;
      const content = context.readFile(file);
      if (content && hasConcreteUnitySourceSignal(content)) return true;
    }
    return false;
  },

  claimsReference(name: string): boolean {
    return (
      name.startsWith(HOST_REF_PREFIX) ||
      name.startsWith(FIELD_REF_PREFIX) ||
      name.startsWith(METHOD_REF_PREFIX)
    );
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.language !== 'csharp') return null;
    return resolveSynthetic(ref, context);
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    if (!filePath.endsWith('.cs')) return { nodes: [], references: [] };
    const result: FrameworkExtractionResult = { nodes: [], references: [] };
    const seenNodes = new Set<string>();
    const seenRefs = new Set<string>();
    const { classes } = parseClassBlocks(content, filePath);
    for (const cls of classes) {
      processClass(result, seenNodes, seenRefs, cls, content);
    }
    return result;
  },
};
