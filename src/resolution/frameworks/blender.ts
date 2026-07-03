/**
 * Blender Add-on Framework Resolver
 *
 * Blender add-ons and extensions are Python packages whose entry points are
 * invoked BY the Blender host application, not by in-project calls:
 *
 * - `register()` / `unregister()` module functions are called by Blender when
 *   the add-on is enabled/disabled.
 * - Classes passed to `bpy.utils.register_class()` (directly, via lists/loops,
 *   or via `register_classes_factory`) become live: Blender calls their
 *   host-invoked methods (`execute`, `draw`, `poll`, ...) per registered base.
 * - String idnames link call sites to operators/panels/menus at runtime:
 *   `bpy.ops.<category>.<name>()`, `layout.operator("cat.name")`,
 *   `keymap_items.new("cat.name", ...)`, `bl_parent_id = "..."`, etc.
 * - Callback registration APIs (`bpy.app.handlers`, `bpy.app.timers`,
 *   `bpy.msgbus`, draw handlers, menu `append`) take plain callables that are
 *   otherwise never referenced.
 * - `bpy.props.*Property(...)` keyword arguments (`update=`, `items=`, ...)
 *   register runtime callbacks; `type=` links to a PropertyGroup class.
 *
 * Without this resolver all of the above look like dead code to the graph.
 *
 * Data-driven core: `blender-invocation-table.json` is the single source of
 * domain rules. The sections consumed at runtime are exactly:
 *   - `registerableBases` (key set = registerable-base whitelist;
 *     `hostInvokedMethods`; `idname.default`)
 *   - `propertyCallbacks` (`callbackKwargs`, `enumItemsKwarg`,
 *     `typeReferenceKwargs`)
 *   - `operatorIdnameValidation` (`pattern`)
 *   - `manifest` (all fields)
 * Everything under the table's `catalogNotes` key is documentation-only
 * provenance; the extraction regexes below cite its rule ids in comments.
 *
 * Diagnostics over guessing: anything statically unresolvable (computed
 * idnames, dynamic `__annotations__` keys, `type(...)` classes, invalid
 * operator idnames) emits NOTHING — no node, no reference. Fabricating a
 * plausible-looking target is worse than staying silent.
 */

import { Node, ReferenceKind } from '../../types';
import {
  FrameworkExtractionResult,
  FrameworkResolver,
  ResolutionContext,
  ResolvedRef,
  UnresolvedRef,
} from '../types';
import { stripCommentsForRegex } from '../strip-comments';
import invocationTable from './blender-invocation-table.json';

// ---------------------------------------------------------------------------
// Invocation table (consumed slice)
// ---------------------------------------------------------------------------

interface RegisterableBaseRule {
  hostInvokedMethods: string[];
  idname: { default: string | null };
}

interface InvocationTable {
  registerableBases: Record<string, RegisterableBaseRule>;
  propertyCallbacks: {
    callbackKwargs: string[];
    enumItemsKwarg: string;
    typeReferenceKwargs: string[];
  };
  operatorIdnameValidation: { pattern: string };
  manifest: {
    fileName: string;
    idField: string;
    typeField: string;
    skipExtractionForTypes: string[];
    virtualPackagePrefix: string;
  };
}

const TABLE = invocationTable as unknown as InvocationTable;

const REGISTERABLE_BASES = new Set(Object.keys(TABLE.registerableBases));
const CALLBACK_KWARGS = TABLE.propertyCallbacks.callbackKwargs;
const ENUM_ITEMS_KWARG = TABLE.propertyCallbacks.enumItemsKwarg;
const TYPE_REFERENCE_KWARGS = TABLE.propertyCallbacks.typeReferenceKwargs;
const OPERATOR_IDNAME_PATTERN = new RegExp(TABLE.operatorIdnameValidation.pattern);
const MANIFEST_FILE = TABLE.manifest.fileName;

/** `bl_ext.` — virtual package root prefix for Blender extensions. */
const BL_EXT_PREFIX = TABLE.manifest.virtualPackagePrefix + '.';
/** Synthetic ref prefix: host-invoked method of a registered class. */
const HOST_REF_PREFIX = 'blender:host:';
/** Synthetic ref prefix: idname string whose class was not found in-file. */
const IDNAME_REF_PREFIX = 'blender:idname:';

function baseRule(base: string): RegisterableBaseRule {
  const rule = TABLE.registerableBases[base];
  /* istanbul ignore next -- callers only pass keys from REGISTERABLE_BASES */
  if (!rule) throw new Error(`blender: unknown registerable base '${base}'`);
  return rule;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Blender signal = a real bpy import (any form) or legacy `bl_info` metadata. */
function hasBlenderSignal(content: string): boolean {
  return (
    /^[ \t]*(?:import[ \t]+bpy\b|from[ \t]+bpy(?:\.[\w.]*)?[ \t]+import\b)/m.test(content) ||
    /^bl_info[ \t]*=/m.test(content)
  );
}

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Index of the bracket closing the one at `openIndex`, or -1. Quote-aware so
 * brackets inside string arguments don't shift the depth.
 */
function findMatchingBracket(content: string, openIndex: number): number {
  const open = content[openIndex];
  if (open !== '(' && open !== '[' && open !== '{') return -1;
  let depth = 0;
  let inString: string | null = null;
  for (let i = openIndex; i < content.length; i++) {
    const c = content[i]!;
    if (inString !== null) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on top-level commas (bracket-aware). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * The inner text of a plain (optionally raw) string literal, or null. F-strings
 * and concatenations are rejected — computed idnames are never guessed
 * (catalogNotes.idnameRules.computed-idname-no-guess).
 */
function literalString(expr: string): string | null {
  const m = expr.trim().match(/^r?(['"])((?:(?!\1).)*)\1$/);
  return m ? m[2]! : null;
}

/** A dotted/plain identifier that can name a callable (not a literal). */
function isCallableName(value: string): boolean {
  if (!/^[A-Za-z_][\w.]*$/.test(value)) return false;
  return value !== 'True' && value !== 'False' && value !== 'None';
}

/** Capitalized identifier tokens in a list/tuple body (class-name shaped). */
function extractClassNames(listBody: string): Set<string> {
  const names = new Set<string>();
  const withoutStrings = listBody.replace(/(['"])(?:(?!\1).)*\1/g, ' ');
  const tokenRegex = /\b([A-Z][A-Za-z0-9_]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRegex.exec(withoutStrings)) !== null) {
    const token = m[1]!;
    if (token === 'True' || token === 'False' || token === 'None') continue;
    names.add(token);
  }
  return names;
}

function pathsEqual(a: string, b: string): boolean {
  return a.replace(/\\/g, '/') === b.replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// Per-file collection
// ---------------------------------------------------------------------------

interface ClassInfo {
  name: string;
  /** Resolved registerable base (a key of TABLE.registerableBases). */
  base: string;
  line: number;
  /** Offset of the class body within the stripped source. */
  bodyStart: number;
  body: string;
  /** Literal `bl_idname` value, or null (absent or computed). */
  idname: string | null;
  /** Method name -> offset within `body` (defs at the body's base indent only). */
  methods: Map<string, number>;
}

/**
 * Aliases resolving to registerable bases: `X = bpy.types.Operator` assignments
 * AND `from bpy.types import Operator, Panel as _P` imports (single-line or
 * parenthesized). catalogNotes.registrationSignals.register-class resolverNotes.
 */
function collectBaseAliases(safe: string): Map<string, string> {
  const aliases = new Map<string, string>();
  let m: RegExpExecArray | null;
  const assignRegex = /^[ \t]*([A-Za-z_]\w*)\s*=\s*bpy\.types\.([A-Za-z_]\w*)[ \t]*$/gm;
  while ((m = assignRegex.exec(safe)) !== null) {
    const base = m[2]!;
    if (REGISTERABLE_BASES.has(base)) aliases.set(m[1]!, base);
  }
  const fromRegex = /^[ \t]*from\s+bpy\.types\s+import\s+(?:\(([^)]*)\)|([^\n]+))/gm;
  while ((m = fromRegex.exec(safe)) !== null) {
    for (const item of (m[1] ?? m[2] ?? '').split(',')) {
      const im = item.trim().match(/^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/);
      if (!im) continue;
      const base = im[1]!;
      if (REGISTERABLE_BASES.has(base)) aliases.set(im[2] ?? base, base);
    }
  }
  return aliases;
}

interface RegistrationCallables {
  registerClass: Set<string>;
  factory: Set<string>;
}

/** Local names bound by `from bpy.utils import register_class [as alias], ...`. */
function collectRegistrationCallables(safe: string): RegistrationCallables {
  const result: RegistrationCallables = { registerClass: new Set(), factory: new Set() };
  const fromRegex = /^[ \t]*from\s+bpy\.utils\s+import\s+(?:\(([^)]*)\)|([^\n]+))/gm;
  let m: RegExpExecArray | null;
  while ((m = fromRegex.exec(safe)) !== null) {
    for (const item of (m[1] ?? m[2] ?? '').split(',')) {
      const im = item.trim().match(/^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/);
      if (!im) continue;
      const local = im[2] ?? im[1]!;
      if (im[1] === 'register_class') result.registerClass.add(local);
      else if (im[1] === 'register_classes_factory') result.factory.add(local);
    }
  }
  return result;
}

/**
 * Module-level list/tuple assignments holding class-name-shaped members, plus
 * `list.append(ClassName)` additions. Balanced-bracket parse so nested tuples
 * (e.g. keymap specs) don't truncate membership.
 */
function collectClassLists(safe: string): Map<string, Set<string>> {
  const lists = new Map<string, Set<string>>();
  let m: RegExpExecArray | null;
  const assignRegex = /^[ \t]*([A-Za-z_]\w*)\s*(?::[^=\n]+)?=\s*([[(])/gm;
  while ((m = assignRegex.exec(safe)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = findMatchingBracket(safe, open);
    if (close === -1) continue;
    const names = extractClassNames(safe.slice(open + 1, close));
    if (names.size > 0) lists.set(m[1]!, names);
  }
  const appendRegex = /\b([A-Za-z_]\w*)\.append\(\s*([A-Z]\w*)\s*\)/g;
  while ((m = appendRegex.exec(safe)) !== null) {
    const target = lists.get(m[1]!);
    if (target) target.add(m[2]!);
  }
  return lists;
}

interface RegistrationInfo {
  /** Class names (dotted tails) registered by this file's registration calls. */
  registered: Set<string>;
  /** Name -> offset of the first registration site mentioning it. */
  siteIndex: Map<string, number>;
}

/**
 * All register_class surfaces: direct calls (bpy.utils-qualified or imported
 * names), `for cls in <list>:` loops, and register_classes_factory (identifier
 * or inline tuple/list). catalogNotes.registrationSignals.
 */
function collectRegistrations(
  safe: string,
  classLists: Map<string, Set<string>>,
  callables: RegistrationCallables
): RegistrationInfo {
  const registered = new Set<string>();
  const siteIndex = new Map<string, number>();
  const record = (name: string, offset: number): void => {
    registered.add(name);
    if (!siteIndex.has(name)) siteIndex.set(name, offset);
  };
  let m: RegExpExecArray | null;

  // A register_class(loopVar) argument is membership via the loop's iterable,
  // never a class itself (catalogNotes.falsePositiveGuards
  // .no-loop-variable-registration-target).
  const loopVars = new Set<string>();
  const forRegex = /\bfor\s+([A-Za-z_]\w*)\s+in\b/g;
  while ((m = forRegex.exec(safe)) !== null) loopVars.add(m[1]!);

  const regNames = ['bpy\\.utils\\.register_class', ...[...callables.registerClass].map(escapeRegExp)];
  const factoryNames = [
    'bpy\\.utils\\.register_classes_factory',
    ...[...callables.factory].map(escapeRegExp),
  ];

  const directRegex = new RegExp(`\\b(?:${regNames.join('|')})\\(\\s*([A-Za-z_][\\w.]*)\\s*\\)`, 'g');
  while ((m = directRegex.exec(safe)) !== null) {
    const arg = m[1]!;
    if (loopVars.has(arg)) continue;
    record(arg.split('.').pop()!, m.index);
  }

  const loopRegex = new RegExp(
    `\\bfor\\s+([A-Za-z_]\\w*)\\s+in\\s+([A-Za-z_]\\w*)\\s*:[\\s\\S]{0,600}?\\b(?:${regNames.join('|')})\\(\\s*\\1\\s*\\)`,
    'g'
  );
  while ((m = loopRegex.exec(safe)) !== null) {
    const members = classLists.get(m[2]!);
    if (!members) continue;
    for (const name of members) record(name, m.index);
  }

  const factoryRegex = new RegExp(`\\b(?:${factoryNames.join('|')})\\(\\s*`, 'g');
  while ((m = factoryRegex.exec(safe)) !== null) {
    const argStart = m.index + m[0].length;
    const ch = safe[argStart];
    if (ch === '(' || ch === '[') {
      const close = findMatchingBracket(safe, argStart);
      if (close === -1) continue;
      for (const name of extractClassNames(safe.slice(argStart + 1, close))) record(name, m.index);
    } else {
      const idm = safe.slice(argStart, argStart + 200).match(/^([A-Za-z_]\w*)/);
      const members = idm ? classLists.get(idm[1]!) : undefined;
      if (!members) continue;
      for (const name of members) record(name, m.index);
    }
  }

  return { registered, siteIndex };
}

/** Offset where the block whose header has `headerIndent` indentation ends. */
function findBlockEnd(content: string, bodyStart: number, headerIndent: number): number {
  const lineRegex = /^([ \t]*)\S/gm;
  lineRegex.lastIndex = bodyStart;
  let m: RegExpExecArray | null;
  while ((m = lineRegex.exec(content)) !== null) {
    if (m[1]!.length <= headerIndent) return m.index;
  }
  return content.length;
}

/**
 * Method defs at the class body's base indent only — nested helper defs are
 * not the class's methods. Duplicate names keep the LAST def (Python rebinding
 * semantics: the final binding is what the host calls).
 */
function collectClassMethods(body: string): Map<string, number> {
  const methods = new Map<string, number>();
  const first = body.match(/^([ \t]*)\S/m);
  if (!first) return methods;
  const baseIndent = first[1]!.length;
  const defRegex = /^([ \t]*)(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = defRegex.exec(body)) !== null) {
    if (m[1]!.length !== baseIndent) continue;
    methods.set(m[2]!, m.index + m[1]!.length);
  }
  return methods;
}

/**
 * Literal `bl_idname` (plain assignment or `bl_idname: str = "..."` annotated
 * form). Computed values (f-strings, concatenation, `__package__`) return
 * null — never guessed (catalogNotes.idnameRules.computed-idname-no-guess).
 */
function extractLiteralIdname(body: string): string | null {
  const m = body.match(/^[ \t]*bl_idname[ \t]*(?::[^=\n]+)?=[ \t]*r?(['"])((?:(?!\1).)*)\1[ \t]*$/m);
  return m ? m[2]! : null;
}

/** Classes whose header names a registerable base (directly or via alias). */
function collectClasses(safe: string, aliases: Map<string, string>): ClassInfo[] {
  const classes: ClassInfo[] = [];
  const classRegex = /^([ \t]*)class\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*:/gm;
  let m: RegExpExecArray | null;
  while ((m = classRegex.exec(safe)) !== null) {
    const base = resolveRegisterableBase(m[3]!, aliases);
    if (!base) continue;
    const bodyStart = m.index + m[0].length;
    const body = safe.slice(bodyStart, findBlockEnd(safe, bodyStart, m[1]!.length));
    classes.push({
      name: m[2]!,
      base,
      line: lineNumberAt(safe, m.index),
      bodyStart,
      body,
      idname: extractLiteralIdname(body),
      methods: collectClassMethods(body),
    });
  }
  return classes;
}

function resolveRegisterableBase(basesText: string, aliases: Map<string, string>): string | null {
  for (const rawBase of splitTopLevel(basesText)) {
    const base = rawBase.trim();
    // Subscripted bases are generics, not registration
    // (catalogNotes.falsePositiveGuards.no-pep585-subscript-registration).
    if (base.includes('[')) continue;
    const dotted = base.match(/^bpy\.types\.([A-Za-z_]\w*)$/);
    if (dotted && REGISTERABLE_BASES.has(dotted[1]!)) return dotted[1]!;
    const aliased = aliases.get(base);
    if (aliased) return aliased;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function makeNode(
  filePath: string,
  line: number,
  key: string,
  name: string,
  now: number,
  matchLength: number
): Node {
  return {
    id: `route:${filePath}:${line}:${key}`,
    kind: 'route',
    name,
    qualifiedName: `${filePath}::blender:${key}`,
    filePath,
    startLine: line,
    endLine: line,
    startColumn: 0,
    endColumn: matchLength,
    language: 'python',
    updatedAt: now,
  };
}

function makeRef(
  fromNodeId: string,
  referenceName: string,
  referenceKind: ReferenceKind,
  line: number,
  filePath: string
): UnresolvedRef {
  return { fromNodeId, referenceName, referenceKind, line, column: 0, filePath, language: 'python' };
}

function analyze(filePath: string, content: string): FrameworkExtractionResult {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();
  const safe = stripCommentsForRegex(content, 'python');
  let m: RegExpExecArray | null;

  const aliases = collectBaseAliases(safe);
  const callables = collectRegistrationCallables(safe);
  const classLists = collectClassLists(safe);
  const registration = collectRegistrations(safe, classLists, callables);
  const classes = collectClasses(safe, aliases);
  const classByName = new Map(classes.map((c) => [c.name, c]));

  // Idname -> in-file class (literal idnames, plus className defaults for UI
  // bases per registerableBases.<base>.idname.default).
  const idnameToClass = new Map<string, string>();
  for (const cls of classes) {
    const idname = cls.idname ?? (baseRule(cls.base).idname.default === 'className' ? cls.name : null);
    if (idname !== null && !idnameToClass.has(idname)) idnameToClass.set(idname, cls.name);
  }

  const emitNode = (line: number, key: string, name: string, matchLength: number): Node => {
    const node = makeNode(filePath, line, key, name, now, matchLength);
    nodes.push(node);
    return node;
  };

  // --- module entry points (catalogNotes.registrationSignals.module-register)
  const entryRegex = /^def[ \t]+(register|unregister)[ \t]*\([ \t]*\)[ \t]*(?:->[^:\n]+)?[ \t]*:/gm;
  while ((m = entryRegex.exec(safe)) !== null) {
    const fn = m[1]!;
    const line = lineNumberAt(safe, m.index);
    const node = emitNode(line, `module:${fn}`, `BLENDER module ${fn}()`, m[0].length);
    references.push(makeRef(node.id, fn, 'function_ref', line, filePath));
  }

  /**
   * Idname link site: node + reference. Known in-file idnames reference the
   * class by name; unknown idnames become `blender:idname:<id>` refs resolved
   * cross-file by resolve() via the project idname index. Invalid OPERATOR
   * idnames emit nothing (operatorIdnameValidation); UI-class idnames
   * (menus, panels, template lists, bl_parent_id) follow the class-name
   * convention and skip that charset rule.
   */
  const emitIdnameLink = (
    line: number,
    offset: number,
    matchLength: number,
    idname: string,
    source: string,
    validateOperator: boolean
  ): void => {
    if (validateOperator && !OPERATOR_IDNAME_PATTERN.test(idname)) return;
    const node = emitNode(line, `${source}:${idname}:${offset}`, `BLENDER ${source} ${idname}`, matchLength);
    const target = idnameToClass.get(idname);
    references.push(makeRef(node.id, target ?? `${IDNAME_REF_PREFIX}${idname}`, 'references', line, filePath));
  };

  /**
   * An operator/menu argument expression: string literal -> idname link;
   * `SomeClass.bl_idname` -> direct class reference; anything else (variables,
   * f-strings) -> nothing.
   */
  const emitLinkArg = (
    line: number,
    offset: number,
    matchLength: number,
    rawArg: string,
    source: string,
    validateOperator: boolean
  ): void => {
    const arg = rawArg.trim();
    const literal = literalString(arg);
    if (literal !== null) {
      emitIdnameLink(line, offset, matchLength, literal, source, validateOperator);
      return;
    }
    const attr = arg.match(/^([A-Za-z_][\w.]*)\.bl_idname$/);
    if (attr) {
      // Bind the tail class name so module-qualified `pkg.mod.Class.bl_idname`
      // links the same as a bare `Class.bl_idname` (mirrors emitCallable tail).
      const cls = attr[1]!.split('.').pop()!;
      if (!/^[A-Za-z_]\w*$/.test(cls)) return;
      const node = emitNode(
        line,
        `${source}-class-attr:${cls}:${offset}`,
        `BLENDER ${source}-class-attr ${cls}`,
        matchLength
      );
      references.push(makeRef(node.id, cls, 'references', line, filePath));
    }
  };

  /** Callback registration site: node + function_ref to the callable's tail name. */
  const emitCallable = (
    line: number,
    offset: number,
    matchLength: number,
    source: string,
    rawTarget: string
  ): void => {
    const tail = rawTarget.split('.').pop()!;
    if (!/^[A-Za-z_]\w*$/.test(tail)) return;
    const node = emitNode(line, `${source}:${rawTarget}:${offset}`, `BLENDER ${source} ${rawTarget}`, matchLength);
    references.push(makeRef(node.id, tail, 'function_ref', line, filePath));
  };

  /**
   * References carried by a bpy.props.*Property(...) argument list
   * (propertyCallbacks). Returned, not pushed — the caller decides whether the
   * surrounding node is worth keeping.
   */
  const propertyKwargRefs = (fromNodeId: string, line: number, args: string): UnresolvedRef[] => {
    const refs: UnresolvedRef[] = [];
    for (const kwarg of CALLBACK_KWARGS) {
      const km = args.match(new RegExp(`(?:^|[,(\\n])\\s*${kwarg}\\s*=\\s*([^,\\n)]+)`));
      if (!km) continue;
      const value = km[1]!.trim();
      // Static tuple/list enum items are data, not callbacks
      // (catalogNotes.falsePositiveGuards.no-static-enum-items-callback).
      if (kwarg === ENUM_ITEMS_KWARG && /^[([{'"]/.test(value)) continue;
      if (!isCallableName(value)) continue;
      refs.push(makeRef(fromNodeId, value.split('.').pop()!, 'function_ref', line, filePath));
    }
    for (const kwarg of TYPE_REFERENCE_KWARGS) {
      const km = args.match(new RegExp(`(?:^|[,(\\n])\\s*${kwarg}\\s*=\\s*([^,\\n)]+)`));
      if (!km) continue;
      const value = km[1]!.trim();
      // False-positive-safe: a plain capitalized class name only. Loop
      // variables (`type=ty`) and builtin RNA types (`type=bpy.types.Object`)
      // are skipped rather than guessed.
      if (!/^[A-Z][A-Za-z0-9_]*$/.test(value)) continue;
      refs.push(makeRef(fromNodeId, value, 'references', line, filePath));
    }
    return refs;
  };

  // --- registered classes: registration + host-invoked methods
  //     (catalogNotes.registrationSignals.register-class). Unregistered classes
  //     emit nothing — the base symbol graph already indexes the class itself.
  for (const cls of classes) {
    if (!registration.registered.has(cls.name)) continue;
    const rule = baseRule(cls.base);
    const registerNode = emitNode(
      cls.line,
      `register-class:${cls.name}`,
      `BLENDER register ${cls.base} ${cls.name}`,
      0
    );
    references.push(makeRef(registerNode.id, cls.name, 'references', cls.line, filePath));

    for (const [method, offset] of cls.methods) {
      if (!rule.hostInvokedMethods.includes(method)) continue;
      const line = lineNumberAt(safe, cls.bodyStart + offset);
      const node = emitNode(
        line,
        `host-callback:${cls.name}.${method}`,
        `BLENDER ${cls.base}.${method} ${cls.name}.${method}`,
        0
      );
      references.push(
        makeRef(node.id, `${HOST_REF_PREFIX}${cls.name}.${method}`, 'references', line, filePath)
      );
    }

    // bl_parent_id (catalogNotes.stringLinkingCallSites.panel-parent-id) —
    // class-name-form idname, so no operator charset validation.
    const parent = cls.body.match(/^[ \t]*bl_parent_id[ \t]*(?::[^=\n]+)?=[ \t]*r?(['"])((?:(?!\1).)*)\1[ \t]*$/m);
    if (parent && parent.index !== undefined) {
      const offset = cls.bodyStart + parent.index;
      emitIdnameLink(lineNumberAt(safe, offset), offset, parent[0].length, parent[2]!, 'panel-parent', false);
    }
  }

  // --- cross-file registration sites: an argument not defined in this file is
  //     a class imported from a sibling module. Emit the registration-site node
  //     with a plain class-name reference; the pipeline resolves it cross-file.
  //     (Host-callback nodes for such classes cannot be emitted here — see the
  //     resolver coverage notes in the table.)
  for (const [name, offset] of registration.siteIndex) {
    if (classByName.has(name)) continue;
    if (!/^[A-Z]/.test(name)) continue;
    const line = lineNumberAt(safe, offset);
    const node = emitNode(line, `register-class:${name}`, `BLENDER register ${name}`, 0);
    references.push(makeRef(node.id, name, 'references', line, filePath));
  }

  // --- string-linking call sites (catalogNotes.stringLinkingCallSites)
  const opsRegex = /\bbpy\.ops\.(\w+)\.(\w+)\s*\(/g;
  while ((m = opsRegex.exec(safe)) !== null) {
    emitIdnameLink(lineNumberAt(safe, m.index), m.index, m[0].length, `${m[1]!}.${m[2]!}`, 'bpy-ops', true);
  }

  const uiOpRegex = /\.\s*operator(?:_menu_enum|_enum)?\s*\(\s*([^,\n)]+)/g;
  while ((m = uiOpRegex.exec(safe)) !== null) {
    emitLinkArg(lineNumberAt(safe, m.index), m.index, m[0].length, m[1]!, 'ui-operator', true);
  }

  const menuRegex = /\.\s*menu\s*\(\s*([^,\n)]+)/g;
  while ((m = menuRegex.exec(safe)) !== null) {
    emitLinkArg(lineNumberAt(safe, m.index), m.index, m[0].length, m[1]!, 'ui-menu', false);
  }

  const templateListRegex = /\.\s*template_list\s*\(\s*([^,\n)]+)/g;
  while ((m = templateListRegex.exec(safe)) !== null) {
    emitLinkArg(lineNumberAt(safe, m.index), m.index, m[0].length, m[1]!, 'ui-template-list', false);
  }

  const keymapRegex = /\.keymap_items\.new\s*\(\s*(?:idname\s*=\s*)?([^,\n)]+)/g;
  while ((m = keymapRegex.exec(safe)) !== null) {
    emitLinkArg(lineNumberAt(safe, m.index), m.index, m[0].length, m[1]!, 'keymap', true);
  }

  const gizmoRegex = /\btarget_set_operator\s*\(\s*([^,\n)]+)/g;
  while ((m = gizmoRegex.exec(safe)) !== null) {
    emitLinkArg(lineNumberAt(safe, m.index), m.index, m[0].length, m[1]!, 'gizmo-target', true);
  }

  const macroRegex = /\b[A-Za-z_]\w*\.define\s*\(\s*([^,\n)]+)/g;
  while ((m = macroRegex.exec(safe)) !== null) {
    emitLinkArg(lineNumberAt(safe, m.index), m.index, m[0].length, m[1]!, 'macro-define', true);
  }

  // --- callback registrations (catalogNotes.callbackRegistrationCalls)
  const handlersRegex = /\bbpy\.app\.handlers\.(\w+)\.append\s*\(\s*([A-Za-z_][\w.]*)\s*[,)]/g;
  while ((m = handlersRegex.exec(safe)) !== null) {
    emitCallable(lineNumberAt(safe, m.index), m.index, m[0].length, `handler-${m[1]!}`, m[2]!);
  }

  const timerRegex = /\bbpy\.app\.timers\.register\s*\(\s*([A-Za-z_][\w.]*)\s*[,)]/g;
  while ((m = timerRegex.exec(safe)) !== null) {
    emitCallable(lineNumberAt(safe, m.index), m.index, m[0].length, 'timer', m[1]!);
  }

  const drawHandlerRegex = /\.draw_handler_add\s*\(\s*([A-Za-z_][\w.]*)\s*,/g;
  while ((m = drawHandlerRegex.exec(safe)) !== null) {
    emitCallable(lineNumberAt(safe, m.index), m.index, m[0].length, 'draw-handler', m[1]!);
  }

  // Menu/panel extension: bpy.types.SOME_MT_menu.append(draw_fn). Distinct from
  // bpy.app.handlers (different regex root) and from list.append(Class) (which
  // requires a capitalized argument and no bpy.types prefix).
  const menuAppendRegex = /\bbpy\.types\.([A-Za-z_]\w*)\.(?:append|prepend)\s*\(\s*([A-Za-z_][\w.]*)\s*\)/g;
  while ((m = menuAppendRegex.exec(safe)) !== null) {
    emitCallable(lineNumberAt(safe, m.index), m.index, m[0].length, 'menu-append', m[2]!);
  }

  const manualMapRegex = /\bbpy\.utils\.register_manual_map\s*\(\s*([A-Za-z_][\w.]*)\s*\)/g;
  while ((m = manualMapRegex.exec(safe)) !== null) {
    emitCallable(lineNumberAt(safe, m.index), m.index, m[0].length, 'manual-map', m[1]!);
  }

  const cliRegex = /\bbpy\.utils\.register_cli_command\s*\(\s*[^,\n]+,\s*([A-Za-z_][\w.]*)\s*\)/g;
  while ((m = cliRegex.exec(safe)) !== null) {
    emitCallable(lineNumberAt(safe, m.index), m.index, m[0].length, 'cli-command', m[1]!);
  }

  // msgbus: notify= searched only inside the call's own balanced parens
  // (catalogNotes.callbackRegistrationCalls.msgbus-subscribe-rna).
  const msgbusRegex = /\bbpy\.msgbus\.subscribe_rna\s*\(/g;
  while ((m = msgbusRegex.exec(safe)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = findMatchingBracket(safe, open);
    if (close === -1) continue;
    const notify = safe.slice(open + 1, close).match(/\bnotify\s*=\s*([A-Za-z_][\w.]*)/);
    if (notify) {
      emitCallable(lineNumberAt(safe, m.index), m.index, m[0].length, 'msgbus-notify', notify[1]!);
    }
  }

  // --- RNA property injection: bpy.types.<Type>.<attr> = bpy.props.*Property(...)
  //     Spans are recorded so the generic property sweep below doesn't emit the
  //     same call twice.
  const injectionSpans: Array<[number, number]> = [];
  const injRegex = /\bbpy\.types\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*=\s*bpy\.props\.([A-Za-z_]\w*Property)\s*\(/g;
  while ((m = injRegex.exec(safe)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = findMatchingBracket(safe, open);
    if (close === -1) continue;
    injectionSpans.push([m.index, close]);
    const line = lineNumberAt(safe, m.index);
    const node = emitNode(
      line,
      `rna-property:${m[1]!}.${m[2]!}:${m.index}`,
      `BLENDER RNA ${m[1]!}.${m[2]!}`,
      m[0].length
    );
    references.push(...propertyKwargRefs(node.id, line, safe.slice(open + 1, close)));
  }

  // --- generic bpy.props.*Property(...) calls (class annotations etc.): kept
  //     only when they carry at least one callback/type reference. Dict-form
  //     __annotations__ injection emits nothing, literal key or not
  //     (catalogNotes.dynamicOrOutOfScopeSignals
  //     .dynamic-annotations-property-injection).
  const propCallRegex = /\bbpy\.props\.([A-Za-z_]\w*Property)\s*\(/g;
  while ((m = propCallRegex.exec(safe)) !== null) {
    const at = m.index;
    if (injectionSpans.some(([s, e]) => at >= s && at <= e)) continue;
    const lineStart = safe.lastIndexOf('\n', at) + 1;
    if (/__annotations__\s*\[/.test(safe.slice(lineStart, at))) continue;
    const open = at + m[0].length - 1;
    const close = findMatchingBracket(safe, open);
    if (close === -1) continue;
    const line = lineNumberAt(safe, at);
    const node = makeNode(filePath, line, `property:${m[1]!}:${at}`, `BLENDER property ${m[1]!}`, now, m[0].length);
    const refs = propertyKwargRefs(node.id, line, safe.slice(open + 1, close));
    if (refs.length > 0) {
      nodes.push(node);
      references.push(...refs);
    }
  }

  return { nodes, references };
}

// ---------------------------------------------------------------------------
// Resolution (main-thread side)
// ---------------------------------------------------------------------------

interface ManifestInfo {
  /** Directory holding the manifest, '' for project root (forward slashes). */
  dir: string;
  id: string | null;
  type: string | null;
}

// Per-ResolutionContext caches. WeakMap keyed on the context object so daemon
// restarts / multiple projects never see each other's data.
const manifestCache = new WeakMap<ResolutionContext, ManifestInfo | null>();
const idnameIndexCache = new WeakMap<
  ResolutionContext,
  Map<string, { filePath: string; className: string }>
>();

function matchTomlString(content: string, key: string): string | null {
  const m = content.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*["']([^"']+)["']`, 'm'));
  return m ? m[1]! : null;
}

/** First blender_manifest.toml in the project (root preferred), minimally parsed. */
function getManifest(context: ResolutionContext): ManifestInfo | null {
  if (manifestCache.has(context)) return manifestCache.get(context) ?? null;
  let info: ManifestInfo | null = null;
  const candidates: string[] = [];
  if (context.fileExists(MANIFEST_FILE)) {
    candidates.push(MANIFEST_FILE);
  } else {
    for (const f of context.getAllFiles()) {
      if (f.replace(/\\/g, '/').endsWith('/' + MANIFEST_FILE)) {
        candidates.push(f);
        if (candidates.length >= 3) break;
      }
    }
  }
  for (const path of candidates) {
    const content = context.readFile(path);
    if (!content) continue;
    const normalized = path.replace(/\\/g, '/');
    info = {
      dir: normalized === MANIFEST_FILE ? '' : normalized.slice(0, normalized.length - MANIFEST_FILE.length - 1),
      id: matchTomlString(content, TABLE.manifest.idField),
      type: matchTomlString(content, TABLE.manifest.typeField),
    };
    break;
  }
  manifestCache.set(context, info);
  return info;
}

function findFileNode(context: ResolutionContext, filePath: string): Node | null {
  const baseName = filePath.split('/').pop()!;
  const fileNodes = context.getNodesByName(baseName).filter((n) => n.kind === 'file');
  return (
    fileNodes.find((n) => pathsEqual(n.filePath, filePath)) ??
    fileNodes.find((n) => n.filePath.replace(/\\/g, '/').endsWith('/' + filePath)) ??
    null
  );
}

/**
 * Map a `bl_ext.{repository_module}.{id}.sub.module` dotted name to its file
 * node. The repository segment is host-configured (statically unknowable), so
 * any single segment is accepted there; the id segment must match the
 * manifest's id (TABLE.manifest rule — never guess across extensions).
 */
function resolveBlExtTarget(moduleName: string, context: ResolutionContext): Node | null {
  const manifest = getManifest(context);
  if (!manifest || !manifest.id) return null;
  const segments = moduleName.split('.');
  if (segments.length < 3) return null;
  if (segments[2] !== manifest.id) return null;
  const sub = segments.slice(3);
  const base = manifest.dir === '' ? '' : manifest.dir + '/';
  if (sub.length === 0) return findFileNode(context, `${base}__init__.py`);
  const stem = base + sub.join('/');
  return findFileNode(context, `${stem}.py`) ?? findFileNode(context, `${stem}/__init__.py`);
}

function resolveBlExtModule(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const target = resolveBlExtTarget(ref.referenceName, context);
  if (!target) return null;
  return { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'framework' };
}

/**
 * `from bl_ext.{repo}.{id}.utils import helper` — the ref names `helper`; the
 * bl_ext source only exists in the file's import mappings, and core import
 * resolution can't map it (the virtual root is not a disk path). Resolve the
 * mapping's source through the manifest instead.
 */
function resolveViaBlExtImport(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  for (const imp of context.getImportMappings(ref.filePath, 'python')) {
    if (!imp.source.startsWith(BL_EXT_PREFIX)) continue;
    if (imp.localName !== ref.referenceName) continue;
    const file = resolveBlExtTarget(imp.source, context);
    if (!file) continue;
    const symbolName = imp.exportedName || imp.localName;
    const symbol = context
      .getNodesInFile(file.filePath)
      .find((n) => n.name === symbolName && n.kind !== 'file');
    return {
      original: ref,
      targetNodeId: (symbol ?? file).id,
      confidence: symbol ? 0.9 : 0.7,
      resolvedBy: 'framework',
    };
  }
  return null;
}

/**
 * `blender:host:<Class>.<method>` — exact class containment only: the method
 * node must sit inside the class's span in the emitting file. No bare-name
 * fallback (a same-file `def draw` outside the class is NOT the host callback).
 */
function resolveHostMethod(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const spec = ref.referenceName.slice(HOST_REF_PREFIX.length);
  const dot = spec.lastIndexOf('.');
  if (dot <= 0 || dot === spec.length - 1) return null;
  const className = spec.slice(0, dot);
  const methodName = spec.slice(dot + 1);
  for (const cls of context.getNodesByName(className)) {
    if (cls.kind !== 'class') continue;
    if (!pathsEqual(cls.filePath, ref.filePath)) continue;
    const method = context
      .getNodesByName(methodName)
      .find(
        (n) =>
          n.id !== cls.id &&
          pathsEqual(n.filePath, cls.filePath) &&
          n.startLine >= cls.startLine &&
          n.startLine <= cls.endLine
      );
    if (method) {
      return { original: ref, targetNodeId: method.id, confidence: 0.85, resolvedBy: 'framework' };
    }
  }
  return null;
}

/**
 * Project-wide idname -> declaring class index, built lazily ONCE per context
 * (replaces the r1 per-ref full-project re-analysis). Light parse: registerable
 * classes + literal bl_idname / className defaults only.
 */
function getIdnameIndex(context: ResolutionContext): Map<string, { filePath: string; className: string }> {
  const cached = idnameIndexCache.get(context);
  if (cached) return cached;
  const index = new Map<string, { filePath: string; className: string }>();
  for (const file of context.getAllFiles()) {
    if (!file.endsWith('.py')) continue;
    const content = context.readFile(file);
    if (!content || !hasBlenderSignal(content)) continue;
    const safe = stripCommentsForRegex(content, 'python');
    const aliases = collectBaseAliases(safe);
    for (const cls of collectClasses(safe, aliases)) {
      const idname = cls.idname ?? (baseRule(cls.base).idname.default === 'className' ? cls.name : null);
      if (idname !== null && !index.has(idname)) {
        index.set(idname, { filePath: file, className: cls.name });
      }
    }
  }
  idnameIndexCache.set(context, index);
  return index;
}

function resolveIdname(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const idname = ref.referenceName.slice(IDNAME_REF_PREFIX.length);
  const entry = getIdnameIndex(context).get(idname);
  if (!entry) return null;
  const cls = context
    .getNodesByName(entry.className)
    .find((n) => n.kind === 'class' && pathsEqual(n.filePath, entry.filePath));
  if (!cls) return null;
  return { original: ref, targetNodeId: cls.id, confidence: 0.8, resolvedBy: 'framework' };
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export const blenderResolver: FrameworkResolver = {
  name: 'blender',
  languages: ['python'],

  detect(context: ResolutionContext): boolean {
    const manifest = getManifest(context);
    if (manifest) {
      // type == "theme" disables Python invocation extraction (TABLE.manifest).
      return !TABLE.manifest.skipExtractionForTypes.includes(manifest.type ?? '');
    }
    // Legacy add-ons: bounded scan, package entry files first.
    const allFiles = context.getAllFiles();
    let reads = 0;
    const check = (f: string): boolean => {
      const content = context.readFile(f);
      reads++;
      return content !== null && hasBlenderSignal(content);
    };
    for (const f of allFiles) {
      const n = f.replace(/\\/g, '/');
      if (n !== '__init__.py' && !n.endsWith('/__init__.py')) continue;
      if (check(f)) return true;
      if (reads >= 25) return false;
    }
    for (const f of allFiles) {
      const n = f.replace(/\\/g, '/');
      if (!n.endsWith('.py') || n === '__init__.py' || n.endsWith('/__init__.py')) continue;
      if (check(f)) return true;
      if (reads >= 50) return false;
    }
    return false;
  },

  // Synthetic refs (`blender:*`) and bl_ext virtual-root module names have no
  // matching declared symbol; opt them through the name-exists pre-filter.
  claimsReference(name: string): boolean {
    return name.startsWith('blender:') || name.startsWith(BL_EXT_PREFIX);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.language !== 'python') return null;
    if (ref.referenceName.startsWith(BL_EXT_PREFIX)) return resolveBlExtModule(ref, context);
    if (ref.referenceName.startsWith(HOST_REF_PREFIX)) return resolveHostMethod(ref, context);
    if (ref.referenceName.startsWith(IDNAME_REF_PREFIX)) return resolveIdname(ref, context);
    return resolveViaBlExtImport(ref, context);
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    if (!filePath.endsWith('.py') || !hasBlenderSignal(content)) {
      return { nodes: [], references: [] };
    }
    return analyze(filePath, content);
  },
};
