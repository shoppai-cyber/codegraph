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

// Hook liveness is DELIBERATELY COUPLED to the SyncVar field rule, not an independent channel
// (CONSIDER 6 / round-1 #7): a hook is only ever resolved for a field that has ALREADY matched
// `syncVarFields.attribute`, and the hook argument is read from an attribute on that same field.
// So `syncVarHooks` without a `syncVarFields` on the same stack does nothing — it refines a field
// match, it does not stand alone. This models every real target (Mirror/FishNet carry the hook on
// the SyncVar attribute itself). A hook-only or separately-attributed stack is intentionally
// unsupported; adding one means teaching the field loop to iterate hook attributes independently.
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
  // Namespaces the stack's gated ATTRIBUTES live in — used to validate a qualified attribute
  // spelling. Kept SEPARATE from the gate prefixes: FishNet's gate is `FishNet` but its RPC
  // attributes live in `FishNet.Object`, so the two cannot be inferred from one list (BLOCKING 2 r3).
  attributeNamespaces?: string[];
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
  // Positions in the masked source used for nesting detection (BLOCKING 3, round 3): declIndex is
  // the declaration start, braceOpen/braceClose the class body span. A block whose declIndex falls
  // inside another block's [braceOpen, braceClose] is a nested class and is excluded from the
  // top-level name map.
  declIndex: number;
  braceOpen: number;
  braceClose: number;
  // Whether the declaration carried the `partial` keyword. All-partial blocks of one name are a
  // single compiler type and are merged in the name map rather than treated as ambiguous.
  isPartial: boolean;
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
  // Namespaces the stack's gated attributes live in (own list, not the gate prefixes) — see
  // GatedStackSection.attributeNamespaces. Consulted ONLY by attrQualifierBelongsToStack.
  attributeNamespaces: string[];
  hostRules: Record<string, HostBaseRule>;
  hostBases: Set<string>;
  methodAttributes: MethodAttributeRule[];
  syncVarAttribute: string | null;
  // Hook fields are consumed ONLY inside the SyncVar-field match (coupled by design — see
  // SyncVarHooksRule). syncVarHookAttribute defaults to syncVarAttribute when a stack omits a
  // dedicated syncVarHooks.attribute; both stay null when the stack has no SyncVar field rule at
  // all, so the hook branch is unreachable without a field match.
  syncVarHookAttribute: string | null;
  syncVarHookArg: string | null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function usingPrefixRegex(prefix: string): RegExp {
  // Matches a real `using`/`global using`/`using static` namespace import for <prefix>, recognized
  // TOKEN-WISE rather than at physical line start (SHOULD-FIX 3, round 4). `\busing` (not the old
  // `^\s*using` with the `m` flag) so a second import on the same line (`using System; using
  // Mirror;`), a `global using Mirror;` (the boundary before `using` still holds), and a
  // `using static Mirror.Tools;` all register — the gate/exclusion contract is per-directive, not
  // per-physical-line, and a mid-line competitor `using` must still fire an exclusion. The
  // post-prefix token is still constrained to `.` (sub-namespace) or `;` (exact import) so that a
  // longer identifier (`MirrorSharp`) and an ALIAS directive (`using Mirror = X;`, whose next token
  // is `=`) are both rejected — only real namespace imports count (F3).
  return new RegExp(`\\busing\\s+(?:static\\s+)?${escapeRegExp(prefix)}(?:\\.|\\s*;)`);
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
    attributeNamespaces: section.attributeNamespaces ?? [],
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
 *  - A BARE gated token the file LOCALLY REDECLARES (`shadowed`) is suppressed (BLOCKING 5, round
 *    4): `class NetworkBehaviour {}` in the file means a bare `: NetworkBehaviour` binds to that
 *    local type, not the framework base, so emitting a host row would fabricate. A DOTTED owning FQ
 *    base (`Mirror.NetworkBehaviour`) is fully qualified and cannot be shadowed by a local simple
 *    name, so the shadow check applies to the bare branch only.
 *  - A BARE token the file binds with ANY using-alias (`aliasBound`) is likewise suppressed (B1,
 *    round 5): when the alias's target was expandable, resolveBaseFull already rewrote the token to
 *    its dotted form before this function runs — so a bare survivor means the alias target was NOT
 *    resolvable (`global::`/extern-`::`/generic RHS, ambiguous bindings, uncertain `#if` region, or
 *    out-of-scope use). C# would bind the bare token to the alias, so classifying the fallback as a
 *    framework base fabricates a host. Applies to the bare Tier-1 branch too — an alias-rebound
 *    `MonoBehaviour` is the same fabrication one tier down.
 */
function classifyHost(
  fullBase: string,
  openStacks: GatedStack[],
  shadowed: Set<string>,
  aliasBound: Set<string>
): HostInfo | null {
  const short = fullBase.split('.').pop() || fullBase;
  const bare = !fullBase.includes('.');
  if (HOST_BASES.has(short)) {
    if (bare && aliasBound.has(short)) return null;
    return { hostBase: short, applicable: [] };
  }
  if (GATED_HOST_TOKENS.has(short)) {
    if (!bare) {
      const owners = openStacks.filter((s) => s.fqBaseAlternative === fullBase);
      return owners.length ? { hostBase: short, applicable: owners } : null;
    }
    if (shadowed.has(short) || aliasBound.has(short)) return null;
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
function openStacksFor(
  safe: string,
  evidence: string,
  classes: ClassBlock[],
  stateAt: (index: number) => PpState
): GatedStack[] {
  // Preprocessor asymmetry (B3, round 5): EXCLUSION reads the parse text (`safe` — provably-active
  // + uncertain regions; a potentially-compiled competitor closes the gate, suppression is safe),
  // while EVIDENCE reads the evidence text (provably-active only; an uncertain `using Mirror;`
  // proves nothing, and provably-inactive text was blanked from both). FQ-base evidence likewise
  // requires the class declaration itself to sit in provably-active text.
  return GATED_STACKS.filter((stack) => {
    if (stack.disqualifyUsingRes.some((re) => re.test(safe))) return false;
    if (stack.requiredUsingRes.some((re) => re.test(evidence))) return true;
    if (stack.fqBaseAlternative) {
      return classes.some(
        (cls) => cls.fullBases.includes(stack.fqBaseAlternative!) && stateAt(cls.declIndex) === 'active'
      );
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
  // Shared identifier grammar (round 8): `[@CommandAttribute]` and Cf-carrying spellings name the
  // SAME attribute as the plain spelling under C# identity, so the name is canonicalized
  // per-segment before any comparison against rule names or the KILL set.
  const targetRe = new RegExp(`^(${CS_ID})\\s*:\\s*(.+)$`, 'u');
  const nameRe = new RegExp(`^(${CS_QID})`, 'u');
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(text)) !== null) {
    let body = match[1]!.trim();
    let target: string | null = null;
    const targetMatch = targetRe.exec(body);
    if (targetMatch) {
      target = canonicalIdName(targetMatch[1]!);
      body = targetMatch[2]!.trim();
    }
    const nameMatch = nameRe.exec(body);
    if (!nameMatch) continue;
    const rawName = nameMatch[1]!
      .split('.')
      .map((segment) => canonicalIdName(segment.trim()))
      .join('.');
    const parenIndex = body.indexOf('(');
    const args = parenIndex === -1 ? '' : body.slice(parenIndex + 1, body.lastIndexOf(')'));
    attrs.push({ rawName, name: normalizeAttributeName(rawName), args, target });
  }
  return attrs;
}

function leadingAttributes(content: string, index: number): AttributeUse[] {
  const prefix = content.slice(Math.max(0, index - 1000), index);
  const match = /((?:\[[^\]]+\][ \t]*(?:\r?\n[ \t]*)?)+)[ \t]*$/.exec(prefix);
  return match ? parseAttributes(match[1]!) : [];
}

// A C# 11 raw string (`"""…"""`), an interpolation hole carrying a nested quoted string, or a
// longer quote fence desynchronizes a character-at-a-time quote scanner: string DATA leaks into
// the parse text (a phantom `class X : NetworkBehaviour` inside a literal fabricates — GLM F1)
// or code is consumed as string content (a legal file loses every row — R8-1/F2). This lexer
// walks the file once knowing every C# lexical form — line/block comments, preprocessor
// directive lines, char literals, regular / verbatim / interpolated / raw strings, and
// interpolation holes with nested literals — and produces two offset-aligned views (newlines
// kept so line numbers hold):
//   `code` — string/char literals AND comments blanked; freeform directive tails (`#region …`,
//            `#error …`, `#pragma …`) blanked past the keyword so their arbitrary text (quotes,
//            apostrophes) can never desynchronize a later pass; conditional/define directives
//            kept whole for the preprocessor pass.
//   `text` — comments and freeform directive tails blanked, literals KEPT: the view for readers
//            of string CONTENT (Invoke("X") linking, SyncVar hook names, ContextMenuItem).
// Returns null when a literal is unterminated or a form is beyond sound lexing (an over-long
// `{` run inside a raw interpolation, runaway nesting): such a file cannot be lexed with
// certainty, so the caller emits nothing (round 9).
function maskCSharpLiterals(content: string): { code: string; text: string } | null {
  const chars = content.split('');
  const textChars = content.split('');
  const n = chars.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) {
      if (chars[k] !== '\n' && chars[k] !== '\r') chars[k] = ' ';
    }
  };
  const blankBoth = (from: number, to: number): void => {
    for (let k = from; k < to; k++) {
      if (chars[k] !== '\n' && chars[k] !== '\r') {
        chars[k] = ' ';
        textChars[k] = ' ';
      }
    }
  };
  const runLength = (index: number, ch: string): number => {
    let k = index;
    while (k < n && chars[k] === ch) k++;
    return k - index;
  };
  const skipLine = (index: number): number => {
    let k = index;
    while (k < n && chars[k] !== '\n' && chars[k] !== '\r') k++;
    return k;
  };
  // C# whitespace is more than space/tab (\f, \v, Unicode Zs all count before a directive `#`
  // — compiler-receipted, round 10 FormFeedIf/FormFeedRegion).
  const isInlineWs = (ch: string): boolean => ch !== '\n' && ch !== '\r' && /\s/.test(ch);
  const atLineStart = (index: number): boolean => {
    for (let k = index - 1; k >= 0; k--) {
      const c = chars[k]!;
      if (c === '\n' || c === '\r') return true;
      if (!isInlineWs(c)) return false;
    }
    return true;
  };

  // Char literal starting at `'`. Returns the index past the closing quote, or null.
  const lexChar = (start: number): number | null => {
    let k = start + 1;
    while (k < n) {
      const c = chars[k];
      if (c === '\n' || c === '\r') return null; // char literals cannot span lines
      if (c === '\\') {
        k += 2;
        continue;
      }
      if (c === "'") {
        blank(start, k + 1);
        return k + 1;
      }
      k++;
    }
    return null;
  };

  // Interpolation hole: expression code until `dollars` closing braces at brace depth 0.
  // Nested literals (including nested raw strings) are lexed recursively. Returns the index
  // past the hole's closing braces, or null.
  const lexHole = (start: number, dollars: number, nesting: number): number | null => {
    if (nesting > 16) return null;
    let k = start;
    let depth = 0;
    while (k < n) {
      const c = chars[k];
      if (c === '/' && chars[k + 1] === '/') {
        k = skipLine(k);
        continue;
      }
      if (c === '/' && chars[k + 1] === '*') {
        const close = content.indexOf('*/', k + 2);
        if (close === -1) return null;
        k = close + 2;
        continue;
      }
      if (c === "'") {
        const end = lexChar(k);
        if (end === null) return null;
        k = end;
        continue;
      }
      if (c === '"' || c === '$' || c === '@') {
        const end = lexString(k, nesting + 1);
        if (end === null) return null;
        if (end !== undefined) {
          k = end;
          continue;
        }
        k++;
        continue;
      }
      if (c === '{') {
        depth++;
        k++;
        continue;
      }
      if (c === '}') {
        if (depth > 0) {
          depth--;
          k++;
          continue;
        }
        const run = runLength(k, '}');
        if (run >= dollars) return k + dollars;
        return null; // a stray close brace short of the hole delimiter cannot compile
      }
      k++;
    }
    return null;
  };

  // String literal whose optional `$`/`@` prefix starts at `start`. Returns the index past the
  // literal, undefined when `start` is not actually a string (e.g. an `@identifier`), or null
  // when the literal cannot be lexed soundly.
  const lexString = (start: number, nesting: number): number | null | undefined => {
    if (nesting > 16) return null;
    let k = start;
    let dollars = 0;
    let verbatim = false;
    while (k < n && (chars[k] === '$' || chars[k] === '@')) {
      if (chars[k] === '$') dollars++;
      else verbatim = true;
      k++;
    }
    if (k >= n || chars[k] !== '"') return undefined;
    if (verbatim && dollars > 1) return null; // multiple $ is raw-only; @$$"…" cannot compile
    const quotes = runLength(k, '"');
    if (!verbatim && quotes >= 3) {
      // C# 11 raw string literal. The opening run is the fence; the CLOSING run must be exactly
      // the fence — a longer run cannot compile (CS8998). Two layout grammars (all rules below
      // compiler-receipted, round 10):
      //   single-line — content follows the fence on the opening line and must close on it
      //                 (a newline first is CS8997);
      //   multiline  — only whitespace may follow the opening fence; the closing fence sits on
      //                its own line (CS9000, including a hole ending on that line) and its
      //                whitespace prefix must lead every content line (CS8999; same whitespace
      //                KIND — CS9003). Whitespace-only lines may stop short of the prefix, and
      //                lines that START inside an interpolation hole are exempt.
      // With a `$` prefix, opening brace runs group inside-out: runs shorter than the dollar
      // count are content, runs of dollars..2*dollars-1 open a hole (the outer braces are
      // content), and longer runs cannot compile (CS9006). A closing-brace run in CONTENT at or
      // above the dollar count cannot compile either (CS9007) — `lexHole` consumes exactly
      // `dollars` closing braces, so a legal N..2N-1 closing run leaves a shorter-than-dollars
      // remainder here.
      const fence = quotes;
      let pos = k + fence;
      while (pos < n && isInlineWs(chars[pos]!)) pos++;
      const multiline = pos < n && (chars[pos] === '\n' || chars[pos] === '\r');
      const contentLineStarts: number[] = [];
      if (multiline) {
        if (chars[pos] === '\r' && chars[pos + 1] === '\n') pos += 2;
        else pos++;
        contentLineStarts.push(pos);
      } else {
        pos = k + fence; // the whitespace we skipped is single-line content
      }
      while (pos < n) {
        const c = chars[pos]!;
        if (c === '"') {
          const run = runLength(pos, '"');
          if (run > fence) return null; // CS8998 — more quotes than the fence permits
          if (run < fence) {
            pos += run;
            continue;
          }
          if (multiline) {
            // Closing fence must be alone on its line (CS9000). Anything non-whitespace
            // between the line start and the fence — content or a hole's tail — cannot compile.
            let ls = pos;
            while (ls > 0 && chars[ls - 1] !== '\n' && chars[ls - 1] !== '\r') ls--;
            for (let t = ls; t < pos; t++) {
              if (!isInlineWs(chars[t]!)) return null; // CS9000
            }
            const closePrefix = chars.slice(ls, pos).join('');
            // Indentation: every line that STARTS in content must begin with the closing
            // prefix; whitespace-only lines may be any prefix-consistent shorter run.
            for (const lineStart of contentLineStarts) {
              if (lineStart === ls) continue; // the closing line itself
              let t = lineStart;
              while (t < n && isInlineWs(chars[t]!)) t++;
              const prefix = chars.slice(lineStart, t).join('');
              const wsOnly = t >= n || chars[t] === '\n' || chars[t] === '\r';
              if (wsOnly) {
                if (!prefix.startsWith(closePrefix) && !closePrefix.startsWith(prefix)) {
                  return null; // CS9003 — mismatched whitespace kind
                }
              } else if (!prefix.startsWith(closePrefix)) {
                return null; // CS8999 — content line not led by the closing whitespace
              }
            }
          }
          blank(start, pos + fence);
          return pos + fence;
        }
        if (c === '\n' || c === '\r') {
          if (!multiline) return null; // CS8997 — single-line form cannot span lines
          if (c === '\r' && chars[pos + 1] === '\n') pos += 2;
          else pos++;
          contentLineStarts.push(pos);
          continue;
        }
        if (dollars > 0 && c === '{') {
          const run = runLength(pos, '{');
          if (run < dollars) {
            pos += run;
            continue;
          }
          if (run >= dollars * 2) return null; // CS9006 — too many opening braces
          const end = lexHole(pos + run, dollars, nesting + 1);
          if (end === null) return null;
          if (!multiline) {
            for (let t = pos; t < end; t++) {
              if (chars[t] === '\n' || chars[t] === '\r') return null; // CS8997
            }
          }
          pos = end;
          continue;
        }
        if (dollars > 0 && c === '}') {
          const run = runLength(pos, '}');
          if (run >= dollars) return null; // CS9007 — unmatched closing run in content
          pos += run;
          continue;
        }
        pos++;
      }
      return null; // unterminated fence
    }
    if (dollars > 1) return null; // $$ without a raw fence cannot compile
    if (quotes >= 2) {
      // `""` — an empty literal (a verbatim `""` escape only exists INSIDE an open literal, so
      // two quotes here always close immediately; any following quotes re-enter the main loop).
      blank(start, k + 2);
      return k + 2;
    }
    let pos = k + 1;
    while (pos < n) {
      const c = chars[pos];
      if (c === '"') {
        if (verbatim && chars[pos + 1] === '"') {
          pos += 2;
          continue;
        }
        blank(start, pos + 1);
        return pos + 1;
      }
      if (!verbatim && c === '\\') {
        pos += 2;
        continue;
      }
      if (!verbatim && (c === '\n' || c === '\r')) return null; // cannot span lines
      if (dollars === 1 && c === '{') {
        if (chars[pos + 1] === '{') {
          pos += 2;
          continue;
        }
        const end = lexHole(pos + 1, 1, nesting + 1);
        if (end === null) return null;
        pos = end;
        continue;
      }
      if (dollars === 1 && c === '}') {
        if (chars[pos + 1] === '}') {
          pos += 2;
          continue;
        }
        return null; // CS8086 — a lone `}` in interpolated content cannot compile
      }
      pos++;
    }
    return null; // unterminated
  };

  // Directives the preprocessor pass parses — kept whole. Everything else (`#region`,
  // `#error`, `#pragma`, `#line`, `#nullable`, …) carries freeform text: blanked past the
  // keyword in BOTH views so it can never desynchronize a later pass or feed a string reader.
  const PP_KEEP = new Set(['if', 'elif', 'else', 'endif', 'define', 'undef']);
  // Conditional directives change region state; they are the only lines kept intact inside a
  // provably-inactive region (analyzePreprocessor must see the same structure we tracked here).
  const CONDITIONAL = new Set(['if', 'elif', 'else', 'endif']);
  // This lexer needs its own region tracking (in addition to analyzePreprocessor's) because
  // excluded text is NOT compiled: an unterminated string inside `#if false` is legal C#
  // (round-10 PPDeadUnterminatedString/RawFence receipts), so the lexer must skip such regions
  // entirely instead of failing on them. Both passes run the same tracker, so states agree.
  const tracker = createPpTracker();

  // Lex one directive line starting at the `#` (which is at line start). Kept directives get
  // their trailing `//` comment blanked in BOTH views (a comment is a comment even here — and
  // an odd quote inside one must never reach maskStringLiterals: round-10 PP02/07-11) and their
  // condition fed to the tracker. Quotes or block comments in a kept directive's tail cannot
  // compile (CS1025 — only `//` comments may follow a directive): suppress the file.
  // Returns the end-of-line offset, or null to suppress.
  const lexDirectiveLine = (start: number): number | null => {
    let k = start + 1;
    while (k < n && isInlineWs(chars[k]!)) k++;
    const wordStart = k;
    while (k < n && /[a-z]/.test(chars[k]!)) k++;
    const keyword = chars.slice(wordStart, k).join('');
    const end = skipLine(start);
    if (!PP_KEEP.has(keyword)) {
      blankBoth(k, end);
      return end;
    }
    let restEnd = end;
    for (let t = k; t < end; t++) {
      const ch = chars[t]!;
      if (ch === '/' && chars[t + 1] === '/') {
        blankBoth(t, end);
        restEnd = t;
        break;
      }
      if (ch === '/' && chars[t + 1] === '*') return null; // CS1025
      if (ch === '"' || ch === "'") return null; // CS1025
    }
    tracker.handle(keyword, chars.slice(k, restEnd).join(''));
    return end;
  };

  for (let i = 0; i < n; ) {
    const c = chars[i];
    if (c === '/' && chars[i + 1] === '/') {
      const end = skipLine(i);
      blankBoth(i, end);
      i = end;
      continue;
    }
    if (c === '/' && chars[i + 1] === '*') {
      const close = content.indexOf('*/', i + 2);
      if (close === -1) {
        // Unterminated block comment: nothing after it is code.
        blankBoth(i, n);
        return { code: chars.join(''), text: textChars.join('') };
      }
      blankBoth(i, close + 2);
      i = close + 2;
      continue;
    }
    if (c === '#' && atLineStart(i)) {
      const dirEnd = lexDirectiveLine(i);
      if (dirEnd === null) return null;
      i = dirEnd;
      // Provably-inactive region: its text is never compiled, so it must not be lexed at all —
      // blank every line in BOTH views. Only nested conditional directives are kept intact
      // (and fed to the tracker) so analyzePreprocessor later derives the same region states.
      while (tracker.cur() === 'inactive' && i < n) {
        if (chars[i] === '\r' && chars[i + 1] === '\n') i += 2;
        else if (chars[i] === '\n' || chars[i] === '\r') i++;
        if (i >= n) break;
        const lineStart = i;
        let t = i;
        while (t < n && isInlineWs(chars[t]!)) t++;
        if (t < n && chars[t] === '#') {
          let k = t + 1;
          while (k < n && isInlineWs(chars[k]!)) k++;
          const wordStart = k;
          while (k < n && /[a-z]/.test(chars[k]!)) k++;
          if (CONDITIONAL.has(chars.slice(wordStart, k).join(''))) {
            const nested = lexDirectiveLine(t);
            if (nested === null) return null;
            i = nested;
            continue;
          }
        }
        const eol = skipLine(lineStart);
        blankBoth(lineStart, eol);
        i = eol;
      }
      continue;
    }
    if (c === "'") {
      const end = lexChar(i);
      if (end === null) return null;
      i = end;
      continue;
    }
    if (c === '"' || c === '$' || c === '@') {
      const end = lexString(i, 0);
      if (end === null) return null;
      if (end !== undefined) {
        i = end;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return { code: chars.join(''), text: textChars.join('') };
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

// --- C# preprocessor awareness (B3, round 5) ---------------------------------------------------
// Text in a provably-INACTIVE region (`#if false`) is not compiled: a `using Mirror;` there must
// not open the gate and declarations there are not evidence of anything, so those regions are
// BLANKED from the parse text exactly like comments. Regions whose condition we cannot decide
// from the file (`#if SOME_BUILD_SYMBOL`) are UNKNOWN: their text stays in the parse text (the
// code may well be compiled) and still fires EXCLUSIONS (a potentially-active competitor using
// closes a gate — suppression is safe), but it never provides gate-opening EVIDENCE (uncertain
// evidence fabricates; emit nothing instead). Only provably-ACTIVE text is evidence.
//
// The condition evaluator is deliberately tiny and provability-oriented: `true`/`false` literals,
// `!expr`, balanced outer parentheses, and single symbols tracked through in-file `#define`/
// `#undef` (an in-file directive overrides the build configuration, so it IS provable; a symbol
// never (un)defined in-file is UNKNOWN). Anything else — `&&`, `||`, comparisons — is UNKNOWN.
// Directive lines themselves are always blanked. Must run on comment-stripped, string-masked
// text so `// #if false` and `"#if false"` are non-evidence in both directions.

type PpState = 'active' | 'unknown' | 'inactive';
type PpTri = 'true' | 'false' | 'unknown';

interface PreprocessorAnalysis {
  /** Parse text: provably-inactive regions and directive lines blanked (offsets preserved). */
  text: string;
  /** Evidence text: only provably-active text survives (unknown regions also blanked). */
  evidence: string;
  /** Region state at a source offset. */
  stateAt(index: number): PpState;
}

interface PpTracker {
  /** Feed one directive (keyword + raw condition/symbol tail). Non-state keywords are ignored. */
  handle(kw: string, rest: string): void;
  /** Region state after the directives fed so far. */
  cur(): PpState;
}

// Shared conditional-compilation tracker. maskCSharpLiterals uses it to know when a region is
// provably inactive (excluded text is never compiled, so it must not be lexed at all), and
// analyzePreprocessor uses the same logic for the parse/evidence texts. Both passes MUST agree
// on region states or the views desynchronize.
function createPpTracker(): PpTracker {
  const defined = new Set<string>();
  const undefd = new Set<string>();
  const tainted = new Set<string>();

  // Split at top-level occurrences of a two-char operator, respecting parentheses.
  const splitTop = (e: string, op: string): string[] | null => {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < e.length - 1; i++) {
      const c = e[i]!;
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (depth === 0 && c === op[0] && e[i + 1] === op[1]) {
        parts.push(e.slice(start, i));
        start = i + 2;
        i++;
      }
    }
    if (parts.length === 0) return null;
    parts.push(e.slice(start));
    return parts;
  };

  const evalExpr = (raw: string): PpTri => {
    let e = raw.trim();
    // Strip balanced OUTER parentheses only (`(true)` → `true`; `(A) && (B)` is left alone).
    for (;;) {
      if (!e.startsWith('(') || !e.endsWith(')')) break;
      let depth = 0;
      let wraps = true;
      for (let i = 0; i < e.length; i++) {
        if (e[i] === '(') depth++;
        else if (e[i] === ')') {
          depth--;
          if (depth === 0 && i !== e.length - 1) {
            wraps = false;
            break;
          }
        }
      }
      if (!wraps || depth !== 0) break;
      e = e.slice(1, -1).trim();
    }
    // Tri-state fold across top-level `||` (binds loosest, so it splits first) then `&&`: one
    // provably-true disjunct / provably-false conjunct decides the whole expression even when a
    // sibling is unknown — `#if false && SYMBOL` is provably false (round-10 PPCompoundFalse /
    // PPCompoundTrueOr receipts). Undecidable operands keep the whole expression unknown.
    const orParts = splitTop(e, '||');
    if (orParts) {
      let sawUnknown = false;
      for (const part of orParts) {
        const v = evalExpr(part);
        if (v === 'true') return 'true';
        if (v === 'unknown') sawUnknown = true;
      }
      return sawUnknown ? 'unknown' : 'false';
    }
    const andParts = splitTop(e, '&&');
    if (andParts) {
      let sawUnknown = false;
      for (const part of andParts) {
        const v = evalExpr(part);
        if (v === 'false') return 'false';
        if (v === 'unknown') sawUnknown = true;
      }
      return sawUnknown ? 'unknown' : 'true';
    }
    if (e === 'true') return 'true';
    if (e === 'false') return 'false';
    if (e.startsWith('!')) {
      const inner = evalExpr(e.slice(1));
      return inner === 'true' ? 'false' : inner === 'false' ? 'true' : 'unknown';
    }
    if (/^[A-Za-z_]\w*$/.test(e)) {
      if (tainted.has(e)) return 'unknown';
      if (defined.has(e)) return 'true';
      if (undefd.has(e)) return 'false';
      return 'unknown';
    }
    return 'unknown';
  };

  interface Frame {
    parent: PpState;
    state: PpState;
    seenTrue: boolean; // an earlier branch of this #if was provably taken → later branches dead
    seenUnknown: boolean; // an earlier branch MIGHT have been taken → later branches undecidable
  }
  const stack: Frame[] = [];
  const cur = (): PpState => (stack.length ? stack[stack.length - 1]!.state : 'active');
  // A branch's state combines its parent's state with its own condition; inactive dominates.
  const combine = (parent: PpState, cond: PpTri): PpState => {
    if (parent === 'inactive' || cond === 'false') return 'inactive';
    if (cond === 'unknown') return 'unknown';
    return parent;
  };

  const handle = (kw: string, rest: string): void => {
    if (kw === 'if') {
      const parent = cur();
      const cond = evalExpr(rest);
      stack.push({
        parent,
        state: combine(parent, cond),
        seenTrue: cond === 'true',
        seenUnknown: cond === 'unknown',
      });
    } else if (kw === 'elif') {
      const f = stack[stack.length - 1];
      if (f) {
        const cond = evalExpr(rest);
        if (f.seenTrue || cond === 'false') f.state = 'inactive';
        else if (cond === 'true' && !f.seenUnknown) f.state = f.parent;
        else f.state = f.parent === 'inactive' ? 'inactive' : 'unknown';
        if (cond === 'true') f.seenTrue = true;
        if (cond === 'unknown') f.seenUnknown = true;
      }
    } else if (kw === 'else') {
      const f = stack[stack.length - 1];
      if (f) {
        if (f.seenTrue) f.state = 'inactive';
        else if (f.seenUnknown) f.state = f.parent === 'inactive' ? 'inactive' : 'unknown';
        else f.state = f.parent; // every earlier branch provably false → the #else is taken
      }
    } else if (kw === 'endif') {
      stack.pop();
    } else if (kw === 'define' || kw === 'undef') {
      const sym = /^\s*([A-Za-z_]\w*)/.exec(rest)?.[1];
      if (sym) {
        const state = cur();
        if (state === 'active') {
          if (kw === 'define') {
            defined.add(sym);
            undefd.delete(sym);
          } else {
            undefd.add(sym);
            defined.delete(sym);
          }
        } else if (state === 'unknown') {
          // A conditionally-compiled (re)definition makes the symbol undecidable for the rest
          // of the file — never let a maybe-#define prove a later region active.
          tainted.add(sym);
        }
      }
    }
    // #region/#endregion/#pragma/#nullable/#line/#error/#warning: no state change.
  };

  return { handle, cur };
}

function analyzePreprocessor(masked: string): PreprocessorAnalysis {
  const lines = masked.split('\n');
  const tracker = createPpTracker();

  // Per line: 'directive' lines are blanked everywhere; other lines carry their region state.
  const lineKinds: Array<PpState | 'directive'> = [];
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const m = /^\s*#\s*([A-Za-z]\w*)(.*)$/.exec(line);
    if (!m) {
      lineKinds.push(tracker.cur());
      continue;
    }
    // #region/#endregion/#pragma/#nullable/#line/#error/#warning: no state change, line blanked.
    tracker.handle(m[1]!, m[2] ?? '');
    lineKinds.push('directive');
  }

  const blank = (s: string): string => s.replace(/[^\r]/g, ' ');
  const textLines: string[] = [];
  const evidenceLines: string[] = [];
  const lineStarts: number[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    lineStarts.push(offset);
    offset += lines[i]!.length + 1;
    const kind = lineKinds[i]!;
    const keepInText = kind !== 'directive' && kind !== 'inactive';
    const keepInEvidence = kind === 'active';
    textLines.push(keepInText ? lines[i]! : blank(lines[i]!));
    evidenceLines.push(keepInEvidence ? lines[i]! : blank(lines[i]!));
  }

  const stateAt = (index: number): PpState => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    const kind = lineKinds[lo];
    return kind === 'directive' || kind === undefined ? 'unknown' : kind;
  };

  return { text: textLines.join('\n'), evidence: evidenceLines.join('\n'), stateAt };
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
// `FishNet.Object.NetworkBehaviour`. Used for gate FQ-base evidence (F2). Alias lookups are
// positional so a namespace-scoped alias only applies inside its own scope (B2, round 5).
function resolveBaseFull(
  base: string,
  resolveAlias: (name: string, pos: number) => string | null,
  pos: number
): string {
  // Canonicalize each written segment BEFORE alias lookup (round 8): `@NetworkBehaviour` and a
  // Cf-carrying spelling denote the same C# name as the plain form, at a base USE site exactly
  // as at a declaration site. (`::`-qualified segments pass through untouched and simply fail
  // the downstream host lookups — the conservative direction.)
  //
  // Round 10 (GLM F-LOW-1): a segment whose first character (after an optional `@`) is a Cf
  // format char is NOT a legal C# identifier — the identifier START class is [\p{L}\p{Nl}_],
  // which excludes Cf; only identifier-PART positions admit it. Every other canonicalization
  // site is regex-gated by CS_ID/CS_QID (whose start class enforces this), but base text here
  // arrives from the class-declaration scan ungated — so stripping the Cf would canonicalize an
  // uncompilable spelling onto a real name and emit on it. Return the trimmed original instead:
  // the retained Cf fails every downstream lookup, i.e. suppression.
  const trimmed = stripGenericSuffix(base.trim());
  for (const segment of trimmed.split('.')) {
    const bare = segment.trim().replace(/^@/, '');
    if (/^\p{Cf}/u.test(bare)) return base.trim();
  }
  let value = trimmed
    .split('.')
    .map((segment) => canonicalIdName(segment.trim()))
    .join('.');
  const dot = value.indexOf('.');
  if (dot !== -1) {
    const head = value.slice(0, dot);
    const alias = resolveAlias(head, pos);
    if (alias) value = `${alias}${value.slice(dot)}`;
  } else {
    value = resolveAlias(value, pos) || value;
  }
  return value;
}

// One C# using-alias directive (`using <Name> = <target>;`), with the span it is visible in and
// the preprocessor state of its own position. Parsed TOKEN-WISE from anywhere in the (masked)
// file — same-line, multiple per line, inside namespace blocks (BLOCKING 2 r3).
interface AliasDecl {
  name: string;
  target: string;
  /** The enclosing namespace declaration's span — the alias is visible only inside it (B2 r5). */
  scopeStart: number;
  scopeEnd: number;
  /** Preprocessor state at the directive: only an 'active' alias may resolve positively (B3 r5). */
  state: PpState;
}

// A C# using-alias is scoped to its enclosing namespace DECLARATION (file-scoped namespaces and
// the global scope span to EOF; nested block namespaces see outer aliases via span containment).
// The old file-global map applied a namespace-scoped alias to classes OUTSIDE its C# scope, which
// fabricated ownership across namespaces (B2, round 5). Directives always precede members inside a
// scope, so span containment is a sound visibility test.
function parseAliasDecls(
  safe: string,
  nsSpans: Array<{ name: string; start: number; end: number }>,
  stateAt: (index: number) => PpState
): AliasDecl[] {
  const decls: AliasDecl[] = [];
  const regex = new RegExp(`\\busing\\s+(${CS_ID})\\s*=\\s*([^;]+?)\\s*;`, 'gu');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(safe)) !== null) {
    let scopeStart = 0;
    let scopeEnd = safe.length;
    let innermost = -1;
    for (const span of nsSpans) {
      if (span.start <= match.index && match.index <= span.end && span.start > innermost) {
        innermost = span.start;
        scopeStart = span.start;
        scopeEnd = span.end;
      }
    }
    decls.push({
      name: canonicalIdName(match[1]!),
      target: match[2]!.replace(/\s+/g, ''),
      scopeStart,
      scopeEnd,
      state: stateAt(match.index),
    });
  }
  return decls;
}

// Positional base-alias resolution. A name resolves at a position ONLY when the visible (span
// contains the position), provably-active alias declarations for it agree on EXACTLY ONE distinct
// target AND that target is a plain dotted identifier we can expand. Everything else — two or more
// distinct visible bindings (BLOCKING 4, round 4), a `global::`/extern-`::`/generic target (its
// bare-token fallback is separately killed via aliasBoundNames — B1, round 5), an alias in an
// uncertain `#if` region — leaves the token UNRESOLVED so a class using it is never falsely rooted
// (the complementary missed edge is acceptable).
function makeAliasResolver(decls: AliasDecl[]): (name: string, pos: number) => string | null {
  return (name, pos) => {
    const targets = new Set<string>();
    for (const d of decls) {
      if (d.name !== name || d.state !== 'active') continue;
      if (pos < d.scopeStart || pos > d.scopeEnd) continue;
      targets.add(d.target);
    }
    if (targets.size !== 1) return null;
    const target = [...targets][0]!;
    // Round 8: the target follows the shared identifier grammar (`Mirror.@NetworkBehaviour` is
    // Mirror.NetworkBehaviour), canonicalized per segment; a reserved-keyword segment can never
    // compile, so such a target stays unresolved (the LHS still kills the bare fallback).
    if (!new RegExp(`^${CS_QID}$`, 'u').test(target)) return null;
    const segments = target.split('.');
    if (segments.some((segment) => isReservedSpelling(segment))) return null;
    return segments.map((segment) => canonicalIdName(segment)).join('.');
  };
}

// Every simple name bound by a `using <Name> = …;` alias directive anywhere in the file, regardless
// of the target shape (`global::`, extern `::`, dotted, generic — the LHS is all the KILL rule
// needs). Feeds the conservative attribute KILL set (BLOCKING 3, round 4): the base-resolution map
// above deliberately drops `global::`/ambiguous targets, so it can no longer be the KILL source
// without re-leaking a bare `[Command]` whose alias target was `global::Other.CommandAttribute`.
function aliasBoundNames(content: string): Set<string> {
  const names = new Set<string>();
  const regex = new RegExp(`\\busing\\s+(${CS_ID})\\s*=`, 'gu');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) names.add(canonicalIdName(match[1]!));
  return names;
}

// Simple names of every top-level type declared IN this file that is NOT a class (interface, struct,
// enum, record). Used two ways (round 4): (a) BLOCKING 2 — a same-simple-name non-class declaration
// competes with a networked class as a base-list target under C#'s namespace-scoped name resolution,
// which our bare-name chain can't model, so its presence poisons that name's chain; (b) BLOCKING 5 —
// together with class names it forms the local-shadow set that suppresses a bare gated token the
// file locally redeclares. Nesting is not excluded on purpose: an over-broad poison/kill is only
// ever a missed edge (the safe direction), never a fabrication.
function collectNonClassTypeNames(safe: string): Set<string> {
  const names = new Set<string>();
  const regex = new RegExp(`\\b(?:interface|struct|enum|record(?:\\s+(?:class|struct))?)\\s+(${CS_ID})`, 'gu');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(safe)) !== null) names.add(canonicalIdName(match[1]!));
  return names;
}

// --- C# identifier grammar (round 7) ------------------------------------------------------------
// ONE grammar for every scanner that reads a C# identifier. C# identifiers may carry a verbatim
// `@` prefix (the prefix is NOT part of the name: `@namespace` names the type `namespace`) and may
// use Unicode letters/digits/combining marks (ECMA-334 §6.4.3, approximated by Unicode property
// classes). Round 6's layout check, the namespace-span scanner and the class scanner each encoded
// a narrower ASCII subset; the gaps between those subsets fabricated rows from names one scanner
// saw and another didn't (round 7 I3-I8) and suppressed a legal `class @namespace` (A1).
const CS_ID_PART = '\\p{L}\\p{Nl}\\p{Nd}\\p{Pc}\\p{Mn}\\p{Mc}\\p{Cf}';
const CS_ID = `@?[\\p{L}\\p{Nl}_][${CS_ID_PART}]*`;
const CS_QID = `${CS_ID}(?:\\s*\\.\\s*${CS_ID})*`;

// The verbatim prefix is spelling, not identity: `@X` and `X` are the SAME C# name. Formatting
// characters (Unicode Cf, e.g. U+200D) are likewise spelling only — ECMA-334 compares identifiers
// after REMOVING them, so `Net‍workBehaviour` and `NetworkBehaviour` are ONE name (round 8).
// Every name stored for comparison (class names, alias LHS/targets, base uses, attribute names,
// local-type shadows, namespace labels) must be canonicalized or the exotic spelling slips past
// shadow/kill sets and fabricates.
function canonicalIdName(token: string): string {
  const bare = token.startsWith('@') ? token.slice(1) : token;
  return bare.replace(/\p{Cf}/gu, '');
}

// C# reserved keywords (ECMA-334 §6.4.4). An UNESCAPED spelling that canonicalizes to one of
// these can never be an identifier — a declaration using one cannot compile, so scanners treat it
// as unparsable and suppress rather than guess (round 8: `namespace class;` emitted rows).
// Contextual keywords (record, var, global, where, …) ARE legal identifiers and are not listed.
const RESERVED_KEYWORDS = new Set([
  'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked', 'class',
  'const', 'continue', 'decimal', 'default', 'delegate', 'do', 'double', 'else', 'enum', 'event',
  'explicit', 'extern', 'false', 'finally', 'fixed', 'float', 'for', 'foreach', 'goto', 'if',
  'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock', 'long', 'namespace', 'new',
  'null', 'object', 'operator', 'out', 'override', 'params', 'private', 'protected', 'public',
  'readonly', 'ref', 'return', 'sbyte', 'sealed', 'short', 'sizeof', 'stackalloc', 'static',
  'string', 'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong',
  'unchecked', 'unsafe', 'ushort', 'using', 'virtual', 'void', 'volatile', 'while',
]);

// The reserved keywords that ARE legal as standalone type atoms in a using-directive target
// (`using T = int?;`). Never legal as a qualifier segment (`int.Foo` is not a type).
const TYPE_KEYWORDS = new Set([
  'bool', 'byte', 'char', 'decimal', 'double', 'float', 'int', 'long', 'object', 'sbyte', 'short',
  'string', 'uint', 'ulong', 'ushort', 'void',
]);

// A raw token spelled WITHOUT `@` whose canonical form is a reserved keyword — never a legal
// identifier. Also fires on Cf-carrying spellings of a keyword: Roslyn keys keyword recognition
// off the transformed spelling, and even if some build accepted it, suppressing stays safe.
function isReservedSpelling(raw: string): boolean {
  return !raw.startsWith('@') && RESERVED_KEYWORDS.has(canonicalIdName(raw));
}

// `[ ... ]` matcher for attribute lists (nesting from array creation inside attribute arguments).
function findMatchingBracket(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const c = text[i];
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Every `namespace` KEYWORD occurrence with its declared name and delimiter. The keyword match is
// spelling-exact: never the escaped identifier `@namespace`, never a fragment of a longer (Unicode)
// identifier. A keyword whose following text does not parse as `qualified-name { or ;` is
// `malformed` — such a file cannot compile (`namespace {`, a name using `\uXXXX` escapes we cannot
// decode, a truncated declaration), so the layout check suppresses it rather than guessing.
// Shared by namespaceSpans and illegalNamespaceLayout so the two can never disagree on what a
// namespace declaration is (round 7: they encoded different subsets and the gap fabricated).
interface NsDecl {
  start: number;
  kind: '{' | ';' | 'malformed';
  name: string;
  delim: number;
}

function scanNamespaceDecls(safe: string): NsDecl[] {
  const decls: NsDecl[] = [];
  const keyword = new RegExp(`(?<![@.${CS_ID_PART}])namespace(?![${CS_ID_PART}])`, 'gu');
  const nameAndDelim = new RegExp(`^\\s*(${CS_QID})\\s*([{;])`, 'u');
  let match: RegExpExecArray | null;
  while ((match = keyword.exec(safe)) !== null) {
    const after = safe.slice(match.index + 'namespace'.length);
    const parsed = nameAndDelim.exec(after);
    if (!parsed) {
      decls.push({ start: match.index, kind: 'malformed', name: '', delim: match.index + 'namespace'.length });
      continue;
    }
    const delim = match.index + 'namespace'.length + parsed[0].length - 1;
    const rawSegments = parsed[1]!.split('.').map((segment) => segment.trim());
    if (rawSegments.some((segment) => isReservedSpelling(segment))) {
      // `namespace class;` — an unescaped reserved keyword is never an identifier (round 8).
      decls.push({ start: match.index, kind: 'malformed', name: '', delim });
      continue;
    }
    const name = rawSegments.map((segment) => canonicalIdName(segment)).join('.');
    decls.push({ start: match.index, kind: parsed[2] as '{' | ';', name, delim });
    keyword.lastIndex = delim + 1;
  }
  return decls;
}

// Enclosing-namespace label for a source offset, used only to decide whether two same-named partial
// blocks are ONE compiler type (BLOCKING 1, round 4). Handles block-scoped `namespace A.B { … }`
// (brace span) and file-scoped `namespace A.B;` (to EOF); nested namespaces concatenate outer→inner.
// A declaration outside any namespace yields '' (the global namespace). Two partial blocks merge
// only when their labels are byte-equal, so partials in different namespaces stay distinct.
// Malformed declarations produce no span — parseClassBlocks has already suppressed such files.
function namespaceSpans(safe: string): Array<{ name: string; start: number; end: number }> {
  const spans: Array<{ name: string; start: number; end: number }> = [];
  for (const decl of scanNamespaceDecls(safe)) {
    if (decl.kind === 'malformed') continue;
    if (decl.kind === '{') {
      const close = findMatchingBrace(safe, decl.delim);
      spans.push({ name: decl.name, start: decl.start, end: close === -1 ? safe.length : close });
    } else {
      spans.push({ name: decl.name, start: decl.start, end: safe.length });
    }
  }
  return spans;
}

// Shape-level validator for a using-directive TARGET (C#12 alias-any-type): qualified names with
// an optional `::` qualifier and balanced type-argument lists, tuples of two or more (optionally
// named) elements, builtin type keywords, and `?`/`*`/`[…]` suffixes. This verifies TOKEN SHAPE,
// not semantic type validity — but everything it cannot positively verify (an empty target, a
// number, an operator soup, a function-pointer type) is REJECTED, and rejection only ever
// suppresses (round 8 P7: `using T = ;` walked through the old `[^;]*` hole and fabricated).
function isShapeValidType(input: string, allowTuple: boolean): boolean {
  const s = input;
  let i = 0;
  const idRe = new RegExp(`^${CS_ID}`, 'u');
  const ws = (): void => {
    while (i < s.length && /\s/.test(s[i]!)) i++;
  };
  const ident = (): string | null => {
    ws();
    const m = idRe.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  const typeArgs = (): boolean => {
    i++; // consume '<'
    for (;;) {
      if (!parseType(true)) return false;
      ws();
      if (s[i] === ',') {
        i++;
        continue;
      }
      if (s[i] === '>') {
        i++;
        return true;
      }
      return false;
    }
  };
  const qualifiedCore = (): boolean => {
    let seg = ident();
    if (seg === null) return false;
    if (!seg.startsWith('@') && RESERVED_KEYWORDS.has(canonicalIdName(seg))) {
      // A builtin type keyword is a complete core on its own (`int?`); any other reserved
      // keyword — or a builtin used as a qualifier (`int.Foo`) — is not a type shape.
      if (!TYPE_KEYWORDS.has(canonicalIdName(seg))) return false;
      ws();
      return s[i] !== '.' && s[i] !== '<' && s.slice(i, i + 2) !== '::';
    }
    ws();
    if (s.slice(i, i + 2) === '::') {
      i += 2;
      seg = ident();
      if (seg === null || isReservedSpelling(seg)) return false;
      ws();
    }
    for (;;) {
      if (s[i] === '<') {
        if (!typeArgs()) return false;
        ws();
      }
      if (s[i] === '.') {
        i++;
        seg = ident();
        if (seg === null || isReservedSpelling(seg)) return false;
        ws();
        continue;
      }
      return true;
    }
  };
  const parseType = (tupleOk: boolean): boolean => {
    ws();
    if (s[i] === '(') {
      if (!tupleOk) return false;
      i++;
      let elements = 0;
      for (;;) {
        if (!parseType(true)) return false;
        elements++;
        ws();
        const save = i;
        const elementName = ident();
        if (elementName !== null && isReservedSpelling(elementName)) return false;
        if (elementName === null) i = save;
        ws();
        if (s[i] === ',') {
          i++;
          continue;
        }
        if (s[i] === ')') {
          i++;
          break;
        }
        return false;
      }
      if (elements < 2) return false; // a tuple type needs at least two elements
    } else if (!qualifiedCore()) {
      return false;
    }
    for (;;) {
      ws();
      if (s[i] === '?' || s[i] === '*') {
        i++;
        continue;
      }
      if (s[i] === '[') {
        i++;
        ws();
        while (s[i] === ',') {
          i++;
          ws();
        }
        if (s[i] !== ']') return false;
        i++;
        continue;
      }
      return true;
    }
  };
  if (!parseType(allowTuple)) return false;
  ws();
  return i === s.length;
}

// Shape-level validator for the ATTRIBUTES of a global attribute list (the text after the
// `assembly:`/`module:` target): one or more comma-separated `Name` / `Name(args)` attributes
// (C# permits a trailing comma). Names follow the shared identifier grammar; argument lists are
// matched as a balanced opaque span (argument EXPRESSIONS are outside the scanner's scope). An
// empty list cannot compile — `[assembly:]` fabricated through the old prefix-only check (P8).
function isShapeValidAttributeList(body: string): boolean {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  if (parts.length > 1 && parts[parts.length - 1]!.trim() === '') parts.pop(); // trailing comma
  const attrRe = new RegExp(`^\\s*(${CS_QID})\\s*(?:<[^<>]*>\\s*)?(?:\\([\\s\\S]*\\))?\\s*$`, 'u');
  return (
    parts.length > 0 &&
    parts.every((part) => {
      const m = attrRe.exec(part);
      if (!m) return false;
      return m[1]!.split('.').every((seg) => !isReservedSpelling(seg.trim()));
    })
  );
}

// Everything the compiler allows BEFORE a file-scoped namespace declaration: extern-alias
// directives, using directives (`global using`, `using static`, using-aliases — including
// C# 12 alias-any-type targets) and assembly/module attribute lists. ANY other leading construct
// — a type declaration in any identifier spelling, a top-level statement (including a `using (…)`
// STATEMENT, which is not a directive), anything unrecognized — makes the layout CS8956-illegal.
// A whitelist, because the round-6 keyword blacklist could only reject spellings it could parse:
// escaped/Unicode type names and top-level statements walked straight past it (round 7 I3/I4/I5).
// Round 8 (P7/P8): each accepted form is verified to the TOKEN level — alias targets must parse
// as a type shape, static imports as a type name, plain imports as a qualified name with no
// reserved-keyword segment, attribute lists as a non-empty attribute sequence — because the old
// `[^;]*`-style holes accepted degenerate directives the compiler rejects.
function isLegalFileScopedPrelude(prelude: string): boolean {
  const externAlias = new RegExp(`^extern\\s+alias\\s+(${CS_ID})\\s*;`, 'u');
  const usingHead = /^(global\s+)?using\s+(static\s+)?(unsafe\s+)?/u;
  const aliasForm = new RegExp(`^(${CS_ID})\\s*=\\s*([^;]*);`, 'u');
  const importForm = new RegExp(`^((?:${CS_ID}\\s*::\\s*)?${CS_QID})\\s*;`, 'u');
  let rest = prelude;
  for (;;) {
    rest = rest.replace(/^\s+/u, '');
    if (rest === '') return true;
    const extern = externAlias.exec(rest);
    if (extern) {
      if (isReservedSpelling(extern[1]!)) return false;
      rest = rest.slice(extern[0].length);
      continue;
    }
    const head = usingHead.exec(rest);
    if (head) {
      const isStatic = head[2] !== undefined;
      const isUnsafe = head[3] !== undefined;
      const afterHead = rest.slice(head[0].length);
      const alias = !isStatic && aliasForm.exec(afterHead);
      if (alias) {
        if (isReservedSpelling(alias[1]!)) return false;
        if (!isShapeValidType(alias[2]!, true)) return false;
        rest = afterHead.slice(alias[0].length);
        continue;
      }
      if (isStatic) {
        const semi = afterHead.indexOf(';');
        if (semi === -1) return false;
        if (!isShapeValidType(afterHead.slice(0, semi), false)) return false;
        rest = afterHead.slice(semi + 1);
        continue;
      }
      if (isUnsafe) return false; // `using unsafe` is only legal on alias/static forms
      const imported = importForm.exec(afterHead);
      if (!imported) return false;
      if (imported[1]!.split(/::|\./u).some((seg) => isReservedSpelling(seg.trim()))) return false;
      rest = afterHead.slice(imported[0].length);
      continue;
    }
    if (rest.startsWith('[')) {
      const close = findMatchingBracket(rest, 0);
      if (close === -1) return false;
      const inner = rest.slice(1, close);
      const target = /^\s*(?:assembly|module)\s*:/u.exec(inner);
      if (!target) return false;
      if (!isShapeValidAttributeList(inner.slice(target[0].length))) return false;
      rest = rest.slice(close + 1);
      continue;
    }
    return false;
  }
}

// A compilation unit whose namespace layout the C# compiler rejects cannot produce any
// framework-invoked member, and the scanner's namespace spans are meaningless on it — every row
// derived from them would be a fabrication (N1/N2, round 6). Runs on the comment-stripped,
// string-masked, preprocessor-blanked text, so an inactive `#if false` declaration never counts.
// Illegal shapes (each maps to a compiler error): a file-scoped declaration preceded by anything
// other than the legal directive/attribute prelude (CS8956 — members of ANY kind count, not just
// type declarations), file-scoped mixed with block namespaces in either order (CS8955), more than
// one file-scoped declaration (CS8954), and a declaration whose name the scanner cannot parse
// (uncompilable or undecodable — suppression is the safe direction either way).
function illegalNamespaceLayout(safe: string): boolean {
  let firstFileScoped = -1;
  let hasBlock = false;
  for (const decl of scanNamespaceDecls(safe)) {
    if (decl.kind === 'malformed') return true;
    if (decl.kind === ';') {
      if (firstFileScoped !== -1) return true; // second file-scoped declaration (CS8954)
      firstFileScoped = decl.start;
    } else {
      hasBlock = true;
    }
  }
  if (firstFileScoped === -1) return false;
  if (hasBlock) return true; // mixed forms, either order (CS8955)
  return !isLegalFileScopedPrelude(safe.slice(0, firstFileScoped)); // CS8956
}

function namespaceLabelAt(spans: Array<{ name: string; start: number; end: number }>, index: number): string {
  return spans
    .filter((s) => s.start <= index && index <= s.end)
    .sort((a, b) => a.start - b.start)
    .map((s) => s.name)
    .join('.');
}

function stripAttributeSuffix(name: string): string {
  return name.endsWith('Attribute') ? name.slice(0, -'Attribute'.length) : name;
}

// Conservative KILL set for bare attribute tokens. A bare `[Token]` is REJECTED whenever the file
// either binds that name with a using-alias (regardless of target — BLOCKING 3 r4) or locally
// declares a type of that name (BLOCKING 5 r4). Both are cases where C#'s own name resolution would
// bind the bare token to something OTHER than the framework attribute, so emitting a gated row would
// be a fabrication; a qualified `[Mirror.Command]` is unaffected. Names are normalized by stripping
// a trailing `Attribute` so `using CommandAttribute = …` / `class CommandAttribute {}` kill bare
// `[Command]` too. The complementary missed edge (a real `[Command]` also suppressed) is acceptable.
function buildKilledAttrNames(aliasBound: Set<string>, localTypeNames: Set<string>): Set<string> {
  const killed = new Set<string>();
  for (const name of aliasBound) killed.add(stripAttributeSuffix(name));
  for (const name of localTypeNames) killed.add(stripAttributeSuffix(name));
  return killed;
}

// Two host descriptors are equivalent when they name the same host base and the same set of open
// owning stacks. Used to decide whether the direct evidence carried by the separate blocks of an
// all-partial type agrees (mergeable) or conflicts (ambiguous) — BLOCKING 3, round 3.
function sameHostInfo(a: HostInfo, b: HostInfo): boolean {
  if (a.hostBase !== b.hostBase) return false;
  const an = a.applicable.map((s) => s.name).sort();
  const bn = b.applicable.map((s) => s.name).sort();
  return an.length === bn.length && an.every((name, i) => name === bn[i]);
}

// A base may drive same-file chain propagation only when it was written BARE in source — its full
// form carries no dot (BLOCKING 1, round 3). A dotted base, whether spelled explicitly
// (`Other.Root`) or alias-expanded into a foreign namespace, denotes a specific external type and
// must never be shortened into a same-file class that merely shares its last segment. Owning FQ
// bases (`Mirror.NetworkBehaviour`) are admitted directly by classifyHost, not through this
// same-file name chain, so excluding all dotted bases here loses no real edge. A bare token the
// file binds with ANY using-alias is also excluded (B1/B2, round 5): a bare survivor of alias
// resolution means the alias did not expand (unresolvable target, ambiguity, or out-of-scope use),
// and C# would bind the token to the alias — chaining it to a same-named local class fabricates.
function chainableBase(cls: ClassBlock, byName: Map<string, HostInfo>, aliasBound: Set<string>): string | null {
  for (let i = 0; i < cls.bases.length; i++) {
    if (cls.fullBases[i]!.includes('.')) continue;
    const bare = cls.bases[i]!;
    if (aliasBound.has(bare)) continue;
    if (byName.has(bare)) return bare;
  }
  return null;
}

function parseClassBlocks(
  content: string,
  filePath: string
): { classes: ClassBlock[]; openStacks: GatedStack[]; killedAttrNames: Set<string> } {
  // Literal lexing FIRST (round 9): raw strings, interpolation holes, char literals, comments,
  // and freeform directive tails are blanked with full C# lexical knowledge, so no string data
  // ever reaches the parse passes and no comment/directive text reaches the string readers. A
  // null means a literal could not be lexed soundly — emit nothing for the whole file.
  const lexed = maskCSharpLiterals(content);
  if (lexed === null) {
    return { classes: [], openStacks: [], killedAttrNames: new Set() };
  }
  const noComments = lexed.text;
  const masked = maskStringLiterals(lexed.code);
  // Preprocessor pass (B3, round 5) AFTER comment-strip + string-mask (so `// #if false` and
  // `"#if false"` are non-evidence): provably-inactive regions and directive lines are blanked
  // from the parse text — an `#if false` block is not compiled, exactly like a comment.
  const pp = analyzePreprocessor(masked);
  const safe = pp.text;
  // Compiler-rejected namespace layout → the whole file emits nothing (N1/N2, round 6).
  if (illegalNamespaceLayout(safe)) {
    return { classes: [], openStacks: [], killedAttrNames: new Set() };
  }
  // A `\uXXXX`/`\UXXXXXXXX` escape surviving the literal lexer (raw strings and interpolation
  // holes included, round 9) + comment-strip + string-mask + preprocessor-blank sits
  // in CODE — a Unicode-escaped identifier (legal C#: an interface spelled with \u-escapes can
  // declare the NAME NetworkBehaviour). This scanner cannot decode escape equivalence, so every
  // name
  // comparison in such a file is unsound — shadow and kill sets silently miss, which fabricates.
  // Emit nothing for the whole file instead (round 7, closed conservatively).
  if (/\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8}/.test(safe)) {
    return { classes: [], openStacks: [], killedAttrNames: new Set() };
  }
  // An unescaped reserved keyword can never be an identifier. A using-alias binding one
  // (`using class = Mirror.NetworkBehaviour;`) cannot compile, and resolving a base through it
  // would fabricate ownership from a compiler-rejected unit (round 8).
  const aliasLhsRegex = new RegExp(`\\busing\\s+(${CS_ID})\\s*=`, 'gu');
  let lhsMatch: RegExpExecArray | null;
  while ((lhsMatch = aliasLhsRegex.exec(safe)) !== null) {
    if (isReservedSpelling(lhsMatch[1]!)) {
      return { classes: [], openStacks: [], killedAttrNames: new Set() };
    }
  }
  const nsSpans = namespaceSpans(safe);
  const aliasDecls = parseAliasDecls(safe, nsSpans, pp.stateAt);
  const resolveAlias = makeAliasResolver(aliasDecls);
  const classes: ClassBlock[] = [];
  const classRegex = new RegExp(
    `(?:\\b(?:public|private|protected|internal|sealed|abstract|partial|static|new)\\s+)*class\\s+(${CS_ID})(?:\\s*:\\s*([^{]+))?\\s*\\{`,
    'gu'
  );
  let match: RegExpExecArray | null;
  while ((match = classRegex.exec(safe)) !== null) {
    if (isReservedSpelling(match[1]!)) {
      // `class class` cannot compile — the same reserved-keyword rule as namespace names (r8).
      return { classes: [], openStacks: [], killedAttrNames: new Set() };
    }
    const openBrace = safe.indexOf('{', match.index);
    if (openBrace === -1) continue;
    const closeBrace = findMatchingBrace(safe, openBrace);
    if (closeBrace === -1) continue;
    const baseTokens = splitTopLevel(match[2] || '');
    const fullBases = baseTokens.map((b) => resolveBaseFull(b, resolveAlias, match!.index));
    const bases = fullBases.map((b) => b.split('.').pop() || b);
    const header = match[0]!.slice(0, match[0]!.indexOf('class'));
    classes.push({
      name: canonicalIdName(match[1]!),
      bases,
      fullBases,
      attributes: leadingAttributes(safe, match.index),
      body: safe.slice(openBrace + 1, closeBrace),
      rawBody: noComments.slice(openBrace + 1, closeBrace),
      bodyOffset: openBrace + 1,
      declIndex: match.index,
      braceOpen: openBrace,
      braceClose: closeBrace,
      isPartial: /\bpartial\b/.test(header),
      filePath,
      hostBase: null,
      applicableStacks: [],
    });
  }

  // Gate resolution happens AFTER class parsing so FQ-base evidence (F2) can be checked
  // against real base clauses. Exclusion is still pre-parse (inside openStacksFor).
  const openStacks = openStacksFor(safe, pp.evidence, classes, pp.stateAt);

  // Every type NAME declared in this file (classes + interfaces/structs/enums/records). Two uses:
  //  - LOCAL SHADOW (BLOCKING 5): a bare gated token the file redeclares binds to the local type,
  //    so classifyHost suppresses the host and the attribute KILL set suppresses the bare attribute.
  //  - COMPETITION (BLOCKING 2): a same-simple-name non-class declaration makes a bare base token
  //    ambiguous under C#'s namespace-scoped resolution (see the name loop below).
  const nonClassTypeNames = collectNonClassTypeNames(safe);
  const localTypeNames = new Set<string>(nonClassTypeNames);
  for (const cls of classes) localTypeNames.add(cls.name);
  const aliasBound = aliasBoundNames(safe);
  const killedAttrNames = buildKilledAttrNames(aliasBound, localTypeNames);

  // Direct host classification from a class's OWN resolved bases. fullBases carries the dotted
  // form so classifyHost distinguishes a foreign FQ token from an owning stack's FQ alternative
  // (BLOCKING 1); the returned HostInfo carries the open owning stacks so FQ ownership can
  // propagate (BLOCKING 2). `localTypeNames` shadows a bare gated token the file redeclares
  // (BLOCKING 5); `aliasBound` shadows a bare token that survived alias resolution unexpanded
  // (B1, round 5). Evaluated per-block (not read back from the name map) so partial class blocks
  // sharing a name stay independent — a base-less partial block is not a host.
  const directInfoFor = (cls: ClassBlock): HostInfo | null => {
    for (const full of cls.fullBases) {
      const info = classifyHost(full, openStacks, localTypeNames, aliasBound);
      if (info) return info;
    }
    return null;
  };

  // Nested classes never participate in the top-level name map — neither as a chain donor nor as
  // an ambiguity trigger (BLOCKING 3, round 3). A class whose declaration sits inside another
  // class's body is scoped to that outer class; a top-level `: Root` can never denote it. Detected
  // by brace span: the declaration index falls inside another block's [braceOpen, braceClose].
  const topLevelClasses = classes.filter(
    (cls) => !classes.some((o) => o !== cls && o.braceOpen < cls.declIndex && cls.declIndex < o.braceClose)
  );
  const topLevelSet = new Set(topLevelClasses);

  // Enclosing-namespace label per top-level block — the identity check for partial merging below.
  // (nsSpans was computed up top, before alias parsing, since alias scoping needs it too.)
  const nsLabelOf = new Map<ClassBlock, string>();
  for (const cls of topLevelClasses) nsLabelOf.set(cls, namespaceLabelAt(nsSpans, cls.declIndex));

  // Group top-level blocks by simple name to decide chain-target identity. A name is an AMBIGUOUS
  // chain target — refuse to install or propagate through it — whenever a bare `: Name` base token
  // cannot be resolved to ONE local type with confidence:
  //   * A same-simple-name NON-CLASS type (interface/struct/enum/record) competes as a base-list
  //     target C# would resolve by namespace scope; our lookup is namespace-blind, so poison it
  //     (BLOCKING 2, round 4).
  //   * Multiple NON-partial class blocks of one name are distinct types in different namespaces;
  //     emit-nothing beats donating an unrelated stack's ownership (round 2).
  //   * All-partial class blocks of one name are a SINGLE compiler type ONLY when they share a
  //     namespace (BLOCKING 1, round 4): two one-part partial `Root`s in different namespaces are
  //     unrelated types, so a differing namespace label poisons the name. Same-namespace partials
  //     merge, installing the HostInfo from whichever block carries direct base evidence; only
  //     CONFLICTING direct evidence across those blocks is ambiguous.
  // Direct per-block classification is unaffected — each block is still classified from its OWN
  // base in `resolved` below, so a directly-rooted block of a duplicated name still emits its rows.
  const blocksByName = new Map<string, ClassBlock[]>();
  for (const cls of topLevelClasses) {
    const list = blocksByName.get(cls.name);
    if (list) list.push(cls);
    else blocksByName.set(cls.name, [cls]);
  }

  const ambiguousNames = new Set<string>();
  // Name → direct HostInfo, the lookup target when another class in the same file names it as a
  // base. The whole descriptor propagates, so a same-file chain inherits its root's owning stacks.
  const directHostByName = new Map<string, HostInfo>();
  for (const [name, blocks] of blocksByName) {
    if (nonClassTypeNames.has(name)) {
      ambiguousNames.add(name);
      continue;
    }
    if (blocks.length === 1) {
      const info = directInfoFor(blocks[0]!);
      if (info) directHostByName.set(name, info);
      continue;
    }
    if (!blocks.every((b) => b.isPartial)) {
      ambiguousNames.add(name);
      continue;
    }
    const labels = new Set(blocks.map((b) => nsLabelOf.get(b) ?? ''));
    if (labels.size !== 1) {
      ambiguousNames.add(name);
      continue;
    }
    let merged: HostInfo | null = null;
    let conflict = false;
    for (const b of blocks) {
      const info = directInfoFor(b);
      if (!info) continue;
      if (!merged) merged = info;
      else if (!sameHostInfo(merged, info)) conflict = true;
    }
    if (conflict) ambiguousNames.add(name);
    else if (merged) directHostByName.set(name, merged);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const cls of topLevelClasses) {
      if (directHostByName.has(cls.name)) continue;
      if (ambiguousNames.has(cls.name)) continue;
      const inheritedBase = chainableBase(cls, directHostByName, aliasBound);
      if (inheritedBase) {
        directHostByName.set(cls.name, directHostByName.get(inheritedBase)!);
        changed = true;
      }
    }
  }

  const resolved = classes.map((cls) => {
    const direct = directInfoFor(cls);
    const chainedBase = chainableBase(cls, directHostByName, aliasBound);
    let info = direct ?? (chainedBase ? directHostByName.get(chainedBase)! : null);
    // SHOULD-FIX 1 (round 4): a base-less block of a merged all-partial type carries no base of its
    // own and has no base token to chain FROM, so its members would be lost. Inherit the descriptor
    // installed for the (same-namespace, all-partial, non-ambiguous) name. Gated to top-level blocks
    // so a nested partial can never read a same-named top-level type's ownership.
    if (!info && cls.isPartial && topLevelSet.has(cls) && !ambiguousNames.has(cls.name)) {
      info = directHostByName.get(cls.name) ?? null;
    }
    return {
      ...cls,
      hostBase: info ? info.hostBase : null,
      applicableStacks: info ? info.applicable : [],
    };
  });
  return { classes: resolved, openStacks, killedAttrNames };
}

function parseMethods(cls: ClassBlock, originalContent: string): MethodDecl[] {
  const methods: MethodDecl[] = [];
  // The return-type span is length-bounded (`{0,512}`) so an unclosed generic in a pathological
  // line (SHOULD-FIX 4) can't trigger the quadratic per-position rescan this pattern otherwise
  // does — 512 chars is far beyond any real signature's return type. Same bound on the
  // expression-bodied and no-body declaration regexes below.
  // The leading attribute run is `(?:\[..\]\s*)*` with a SINGLE trailing `\s*` per iteration — NOT
  // `(?:\s*\[..\]\s*)*`. A `\s*` on both sides of the repeated bracket makes the whitespace between
  // adjacent attributes split ambiguously, so a method with N stacked attributes whose tail then
  // fails to match (e.g. a block body against the `=>` expression regex) backtracks 2^N ways and
  // hangs (BLOCKING 7). Single-sided is unambiguous; the run still captures every attribute into
  // group 1. Same shape on the property regex below.
  const methodRegex = /((?:\[[^\]]+\]\s*)*)(?:(?:public|private|protected|internal|static|virtual|override|sealed|async|new|unsafe|extern)\s+)*[A-Za-z_][\w<>,\s\[\]?.]{0,512}\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{/g;
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

  const expressionRegex = /((?:\[[^\]]+\]\s*)*)(?:(?:public|private|protected|internal|static|virtual|override|sealed|async|new|unsafe|extern)\s+)*[A-Za-z_][\w<>,\s\[\]?.]{0,512}\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*=>[^;{}]*;/g;
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

  const declarationRegex = /((?:\[[^\]]+\]\s*)*)(?:(?:public|private|protected|internal|static|virtual|override|sealed|async|new|unsafe|extern|abstract)\s+)*[A-Za-z_][\w<>,\s\[\]?.]{0,512}\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*;/g;
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

const FIELD_MODIFIERS = new Set([
  'public',
  'private',
  'protected',
  'internal',
  'static',
  'readonly',
  'volatile',
  'new',
  'const',
]);

function isFieldWs(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v';
}
function isIdentStart(c: string | undefined): boolean {
  return c !== undefined && ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_');
}
function isIdentPart(c: string | undefined): boolean {
  return isIdentStart(c) || (c !== undefined && c >= '0' && c <= '9');
}

interface FieldScan {
  typeName: string;
  isStatic: boolean;
  names: string[];
  end: number;
}

// Single-pass balanced scanner for a field declaration, starting immediately after its leading
// attribute block. Replaces the old catastrophically-backtracking field regex (SHOULD-FIX 4): the
// type's generic `<...>` and array ranks are scanned by balanced depth, and a declarator's `=`
// initializer is consumed to the top-level `;`/`,` so brace object initializers survive (BLOCKING
// 3). `const` counts as static (C# consts are implicitly static — Unity never serializes them and
// Mirror rejects static SyncVars, so treating them as static routes them to the emit-nothing
// path). Any unbalanced/unterminated form returns null (skip, emit nothing) rather than backtrack,
// and a trailing `(`/`{` (method/property) also returns null so only true fields are emitted.
function scanFieldDeclaration(body: string, from: number): FieldScan | null {
  const n = body.length;
  let i = from;
  const skipWs = () => {
    while (i < n && isFieldWs(body[i])) i++;
  };

  skipWs();
  let isStatic = false;
  // Modifiers: consume leading identifier words that are field modifiers; the first word that is
  // not a modifier is the start of the TYPE (rewound below).
  for (;;) {
    const start = i;
    while (i < n && isIdentPart(body[i])) i++;
    if (i === start) break;
    const word = body.slice(start, i);
    if (FIELD_MODIFIERS.has(word)) {
      if (word === 'static' || word === 'const') isStatic = true;
      skipWs();
      continue;
    }
    i = start;
    break;
  }

  // TYPE: dotted name, then interleaved balanced generic `<...>`, nullable `?`, and array ranks
  // `[]`/`[,]` in any order.
  const typeStart = i;
  if (!isIdentStart(body[i])) return null;
  while (i < n && (isIdentPart(body[i]) || body[i] === '.')) i++;
  for (;;) {
    let j = i;
    while (j < n && isFieldWs(body[j])) j++;
    const c = body[j];
    if (c === '<') {
      let depth = 0;
      let k = j;
      for (; k < n; k++) {
        const ch = body[k];
        if (ch === '<') depth++;
        else if (ch === '>') {
          depth--;
          if (depth === 0) {
            k++;
            break;
          }
        } else if (ch === ';' || ch === '{' || ch === '}') {
          return null; // unterminated generic — bail instead of backtracking
        }
      }
      if (depth !== 0) return null; // generic never closed
      i = k;
    } else if (c === '?') {
      i = j + 1;
    } else if (c === '[') {
      let k = j + 1;
      while (k < n && (isFieldWs(body[k]) || body[k] === ',')) k++;
      if (body[k] !== ']') return null; // not an array rank
      i = k + 1;
    } else {
      break;
    }
  }
  const typeName = body.slice(typeStart, i).replace(/\s+/g, '');
  if (!typeName) return null;

  // DECLARATOR list: `name` with an optional `= initializer` (balanced to the top-level `;`/`,`),
  // comma-separated, terminated by a top-level `;`.
  const names: string[] = [];
  for (;;) {
    skipWs();
    if (!isIdentStart(body[i])) return null;
    const ns = i;
    while (i < n && isIdentPart(body[i])) i++;
    names.push(body.slice(ns, i));
    skipWs();
    const c = body[i];
    if (c === '=') {
      if (body[i + 1] === '>' || body[i + 1] === '=') return null; // expression body / comparison — not a field
      i++;
      // Scan the initializer to the top-level `;` (or `,` for the next declarator). Track `()[]{}`
      // depth AND angle-bracket depth (BLOCKING 4): a `<` immediately after an identifier char or a
      // closing `>` opens a generic context (`new Dictionary<int,string>()`), so its commas are NOT
      // declarator separators. A `<` used as a comparison operator (`a < b`) also opens the context
      // but never closes, so the initializer is unbalanced at its `;` and the whole declaration
      // bails (emit nothing) rather than mis-splitting on the comma.
      let depth = 0;
      let angle = 0;
      let prev = '=';
      for (; i < n; i++) {
        const ch = body[i]!;
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
        // `<<` is the left-shift operator, never a generic opener (SHOULD-FIX 2, round 4). Without
        // this guard the first `<` opens angle depth (prev is an identifier char in `a << 2`), the
        // second `<` doesn't, nothing closes it, and the whole declaration bails at its `;` — losing
        // a valid `[SyncVar] int x = a << 2;`. Consume both `<` and leave depth untouched. Right
        // shift `>>`/`>>>` needs no guard: those `>` only decrement when an angle context is already
        // open, and a top-level shift runs at angle 0, so a genuine `Dictionary<int,List<int>>`'s
        // `>>` still closes two levels correctly.
        else if (ch === '<' && body[i + 1] === '<') i++;
        else if (ch === '<' && (isIdentPart(prev) || prev === '>')) angle++;
        else if (ch === '>' && angle > 0) angle--;
        else if (depth === 0) {
          if (ch === ';') break; // top-level statement terminator, even with an open angle context
          if (angle === 0 && ch === ',') break; // declarator separator — only outside a generic
        }
        if (!isFieldWs(ch)) prev = ch;
      }
      if (i >= n) return null; // unterminated initializer
      if (body[i] === ';') {
        if (angle !== 0) return null; // unbalanced generic / comparison operator — bail (emit nothing)
        i++; // consume ';'
        break;
      }
      // body[i] === ',' — another declarator follows.
      i++;
      continue;
    }
    if (c === ',') {
      i++;
      continue;
    }
    if (c === ';') {
      i++;
      break;
    }
    return null; // '('/'{' (method/property) or anything unexpected — not a field
  }

  return { typeName, isStatic, names, end: i };
}

function parseFields(cls: ClassBlock, originalContent: string): MemberDecl[] {
  const fields: MemberDecl[] = [];
  // A field we care about always carries an attribute block (bare fields are never emitted). Anchor
  // on that block, then hand-scan the declaration that follows (scanFieldDeclaration) so brace
  // initializers, nullable-array ranks, and adversarial/unclosed generics resolve in one linear
  // pass with no regex backtracking.
  const attrBlockRegex = /(?:\[[^\]]+\]\s*)+/g;
  let match: RegExpExecArray | null;
  while ((match = attrBlockRegex.exec(cls.body)) !== null) {
    if (!topLevelAt(cls.body, match.index)) continue;
    const scan = scanFieldDeclaration(cls.body, attrBlockRegex.lastIndex);
    if (!scan) continue;
    const attrBlock = match[0];
    const attrs = cls.rawBody.slice(match.index, match.index + attrBlock.length);
    const parsedAttrs = parseAttributes(attrs);
    const line = lineNumberAt(originalContent, cls.bodyOffset + match.index);
    for (const name of scan.names) {
      fields.push({
        name,
        typeName: scan.typeName,
        attributes: parsedAttrs,
        line,
        isStatic: scan.isStatic,
      });
    }
    // Advance past the whole consumed declaration so array ranks inside it are not re-matched as
    // attribute blocks on the next iteration.
    attrBlockRegex.lastIndex = scan.end;
  }
  return fields;
}

function parseProperties(cls: ClassBlock, originalContent: string): MemberDecl[] {
  const properties: MemberDecl[] = [];
  const propRegex = /((?:\[[^\]]+\]\s*)+)(?:(?:public|private|protected|internal|static|new)\s+)*([A-Za-z_][\w.<>]*)\s+([A-Za-z_]\w*)\s*\{/g;
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
  // Strip trailing nullable `?` and array ranks (`[]`, `[,]`) in ANY order, so `PlayerData[]?`,
  // `PlayerData?[]`, and jagged combinations all reduce to the bare element `PlayerData`.
  let core = simpleFull;
  for (;;) {
    const next = core.replace(/\?$/, '').replace(/\[[\s,]*\]$/, '');
    if (next === core) break;
    core = next;
  }
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
// `[Mirror.Command]`) is EXACTLY one of a gated stack's own ATTRIBUTE namespaces. This is the
// stack's dedicated `attributeNamespaces` list — NOT the gate prefixes (BLOCKING 2 r3): FishNet's
// gate is `FishNet` but its RPC attributes live in `FishNet.Object`, so `[FishNet.ServerRpc]` is a
// foreign custom attribute and must not match. Descendant namespaces are still rejected (exact
// match only), so `[Mirror.Whatever.Command]` / `[FishNet.Whatever.ServerRpc]` stay foreign. When a
// stack omits the list, fall back to the fully-qualified base's namespace.
function attrQualifierBelongsToStack(qualifier: string, stack: GatedStack): boolean {
  const owners = stack.attributeNamespaces.length
    ? stack.attributeNamespaces
    : stack.fqBaseAlternative
      ? [stack.fqBaseAlternative.split('.').slice(0, -1).join('.')]
      : [];
  return owners.some((p) => qualifier === p);
}

// True when a dotted or bare attribute SPELLING resolves to the owning stack's own attribute.
// A bare token matches by name (the caller decides provenance); a dotted token requires an EXACT
// owning-namespace qualifier. Used both for a written attribute and for a C# alias's target.
function spellingIsOwningAttribute(name: string, ruleName: string, stack: GatedStack): boolean {
  const segments = name.split('.');
  const last = segments[segments.length - 1]!;
  const bareLast = last.endsWith('Attribute') ? last.slice(0, -'Attribute'.length) : last;
  if (bareLast !== ruleName) return false;
  if (segments.length === 1) return true;
  return attrQualifierBelongsToStack(segments.slice(0, -1).join('.'), stack);
}

// Gated attribute matching (BLOCKING 3 + BLOCKING 2 r2/r3): inspect the RAW written attribute
// token, not the fully-normalized name (which strips every namespace and would let a foreign
// `[Other.Command]` masquerade as Mirror's `[Command]`). Accept a bare token (`Command`), an
// `Attribute`-suffixed token (`CommandAttribute`), or a qualified token ONLY when the qualifier is
// EXACTLY the owning stack's attribute namespace. A bare token is additionally REJECTED whenever a
// using-alias in the file rebinds that name (`killed`) — the conservative KILL rule; qualified
// spellings are unaffected.
function gatedAttributeMatches(
  rawName: string,
  ruleName: string,
  stack: GatedStack,
  killed: Set<string>
): boolean {
  const segments = rawName.split('.');
  if (segments.length === 1 && killed.has(stripAttributeSuffix(segments[0]!))) return false;
  return spellingIsOwningAttribute(rawName, ruleName, stack);
}

function findGatedAttribute(
  attrs: AttributeUse[],
  ruleName: string,
  stack: GatedStack,
  killed: Set<string>
): AttributeUse | undefined {
  return attrs.find((a) => gatedAttributeMatches(a.rawName, ruleName, stack, killed));
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
  originalContent: string,
  killedAttrNames: Set<string>
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
          const attr = findGatedAttribute(method.attributes, rule.attribute, stack, killedAttrNames);
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
        const attr = findGatedAttribute(field.attributes, stack.syncVarAttribute, stack, killedAttrNames);
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

        // Hook liveness is a refinement of THIS field match, not an independent pass (coupled by
        // design — see SyncVarHooksRule / GatedStack.syncVarHookAttribute). It reads the hook
        // argument from the hook-bearing attribute on the same field, matched via the stack's
        // syncVarHookAttribute (defaults to the field attribute when no dedicated one is set). For
        // Mirror both are `SyncVar`, so the hook lives on the attribute already found above.
        if (!stack.syncVarHookAttribute || !stack.syncVarHookArg) continue;
        const hookAttr =
          stack.syncVarHookAttribute === stack.syncVarAttribute
            ? attr
            : findGatedAttribute(field.attributes, stack.syncVarHookAttribute, stack, killedAttrNames);
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
    if (field.isStatic) continue; // Unity does not serialize static/const fields
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
  const lexed = maskCSharpLiterals(content);
  if (lexed === null) return false;
  const safe = maskStringLiterals(lexed.code);
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
    const { classes, killedAttrNames } = parseClassBlocks(content, filePath);
    for (const cls of classes) {
      processClass(result, seenNodes, seenRefs, cls, content, killedAttrNames);
    }
    return result;
  },
};
