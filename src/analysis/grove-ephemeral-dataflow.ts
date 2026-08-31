import { getParser, loadGrammarsForLanguages } from '../extraction/grammars';
import type { Node as SyntaxNode } from 'web-tree-sitter';

export interface EphemeralDataflowSpan {
  start: number;
  end: number;
}

export interface EphemeralDataflowResult {
  text: string;
  spans: EphemeralDataflowSpan[];
  factCount: number;
}

type ZoneKind = 'repeat' | 'simulation' | 'foreach';

interface ZoneInfo {
  kind: ZoneKind | null;
  error: string | null;
  line: number;
}

interface Binding {
  id: string;
  name: string;
  scope: Scope;
  line: number;
  invalid: boolean;
  hasDefault: boolean;
}

interface Scope {
  id: string;
  name: string;
  node: SyntaxNode;
  body: SyntaxNode;
  parent: Scope | null;
  children: Scope[];
  bindings: Map<string, Binding>;
  parameters: Binding[];
  zoneKind: ZoneKind | null;
  zoneError: string | null;
  zoneLine: number;
  reasons: Reason[];
}

interface Reason {
  line: number;
  message: string;
  scope: Scope;
  bindings: Binding[];
}

interface EdgeFact {
  source: Binding;
  target: Binding;
  line: number;
  label: string;
  kind: 'WIRE' | 'ARG' | 'RET';
}

interface ReturnSpec {
  arity: number;
  refs: Binding[][];
  line: number;
  compatible: boolean;
}

interface FunctionScope extends Scope {
  returnSpec: ReturnSpec | null;
  returnSpecs: ReturnSpec[];
}

const BRANCH_TYPES = new Set([
  'if_statement',
  'elif_clause',
  'else_clause',
  'for_statement',
  'while_statement',
  'try_statement',
  'except_clause',
  'finally_clause',
  'with_statement',
]);

const FUNCTION_TYPES = new Set(['function_definition', 'decorated_definition']);

function lineOf(node: SyntaxNode): number {
  return node.startPosition.row + 1;
}

function sameNode(a: SyntaxNode | null, b: SyntaxNode | null): boolean {
  return !!a && !!b && a.startIndex === b.startIndex && a.endIndex === b.endIndex;
}

function functionNode(node: SyntaxNode): SyntaxNode | null {
  if (node.type === 'function_definition') return node;
  if (node.type !== 'decorated_definition') return null;
  return node.namedChildren.find((child) => child.type === 'function_definition') ?? null;
}

function decoratorZoneInfo(node: SyntaxNode, name: string): ZoneInfo {
  if (node.type !== 'decorated_definition') return { kind: null, error: null, line: 0 };
  const decorators = node.namedChildren.filter((child) => child.type === 'decorator');
  const text = decorators.map((child) => child.text).join(' ');
  const kinds: ZoneKind[] = [];
  if (/\bforeach(?:_zone)?\b/.test(text)) kinds.push('foreach');
  if (/\brepeat_zone\b/.test(text)) kinds.push('repeat');
  if (/\bsimulation_zone\b/.test(text)) kinds.push('simulation');
  const line = kinds.length > 0 ? lineOf(node) : 0;
  if (kinds.length > 1) return { kind: null, error: `ambiguous zone decorators on ${name}`, line };
  const kind = kinds[0] ?? null;
  if (kind === 'foreach') return { kind, error: `unsupported foreach zone ${name}`, line };
  return { kind, error: null, line };
}

function hasNodeTreeDecorator(root: SyntaxNode): boolean {
  return root.namedChildren.some((statement) =>
    statement.type === 'decorated_definition' &&
    statement.namedChildren.some((child) => child.type === 'decorator' && /\bnode_tree\b/.test(child.text)),
  );
}

function functionName(node: SyntaxNode): string | null {
  return node.childForFieldName('name')?.text ?? null;
}

function makeScope(
  node: SyntaxNode,
  parent: Scope | null,
  name: string,
  zone: ZoneInfo,
): FunctionScope {
  const body = node.type === 'module' ? node : node.childForFieldName('body');
  if (!body) {
    throw new Error(`Grove dataflow function ${name} has no body`);
  }
  return {
    id: `${name}@${node.startIndex}`,
    name,
    node,
    body,
    parent,
    children: [],
    bindings: new Map(),
    parameters: [],
    zoneKind: zone.kind,
    zoneError: zone.error,
    zoneLine: zone.line,
    reasons: [],
    returnSpec: null,
    returnSpecs: [],
  };
}

function buildScopeTree(root: SyntaxNode): FunctionScope {
  const moduleScope = makeScope(root, null, '<module>', { kind: null, error: null, line: 0 });
  const visit = (scope: FunctionScope): void => {
    for (const statement of scope.body.namedChildren) {
      const fn = functionNode(statement);
      if (!fn) continue;
      const name = functionName(fn);
      if (!name) continue;
      const child = makeScope(
        fn,
        scope,
        scope.name === '<module>' ? name : `${scope.name}::${name}`,
        decoratorZoneInfo(statement, name),
      );
      scope.children.push(child);
      visit(child);
    }
  };
  visit(moduleScope);
  return moduleScope;
}

function walkCode(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  if (FUNCTION_TYPES.has(node.type) && node.type !== 'module') return;
  visit(node);
  for (const child of node.namedChildren) walkCode(child, visit);
}

function isBranchAssignment(node: SyntaxNode, scope: Scope): boolean {
  for (let parent = node.parent; parent && parent !== scope.node; parent = parent.parent) {
    if (BRANCH_TYPES.has(parent.type)) return true;
  }
  return false;
}

function parameterName(node: SyntaxNode): { name: string | null; unsupported: boolean; hasDefault: boolean } {
  if (node.type.includes('splat') || node.type.includes('separator')) {
    return { name: null, unsupported: true, hasDefault: false };
  }
  const named = node.childForFieldName('name');
  if (named?.type === 'identifier') {
    return { name: named.text, unsupported: false, hasDefault: node.type.includes('default') };
  }
  if (node.type === 'identifier') return { name: node.text, unsupported: false, hasDefault: false };
  for (const child of node.namedChildren) {
    if (child.type === 'identifier') {
      return { name: child.text, unsupported: false, hasDefault: node.type.includes('default') };
    }
    if (child.type.includes('parameter')) {
      const nested = parameterName(child);
      if (nested.name) {
        return {
          name: nested.name,
          unsupported: false,
          hasDefault: node.type.includes('default') || nested.hasDefault,
        };
      }
    }
  }
  return { name: null, unsupported: true, hasDefault: false };
}

function addReason(scope: Scope, line: number, message: string, bindings: Binding[] = []): void {
  if (scope.reasons.some((reason) => reason.line === line && reason.message === message)) return;
  scope.reasons.push({ line, message, scope, bindings });
}

function targetNames(left: SyntaxNode): { names: string[]; unsupported: boolean } {
  if (left.type === 'identifier') return { names: [left.text], unsupported: false };
  if (!['pattern_list', 'tuple_pattern', 'list_pattern'].includes(left.type)) {
    return { names: [], unsupported: true };
  }
  const names: string[] = [];
  for (const child of left.namedChildren) {
    if (child.type.includes('splat')) return { names: [], unsupported: true };
    if (child.type !== 'identifier') return { names: [], unsupported: true };
    names.push(child.text);
  }
  return { names, unsupported: names.length === 0 };
}

function assignmentNode(node: SyntaxNode): SyntaxNode | null {
  return node.type === 'assignment' ? node : null;
}

function collectParameters(scope: FunctionScope): void {
  if (scope.name === '<module>') return;
  const parameters = scope.node.childForFieldName('parameters');
  if (!parameters) return;
  for (const parameter of parameters.namedChildren) {
    // Tree-sitter keeps comments embedded in a multiline parameter list as
    // named children. They are not parameter forms and must not turn a valid
    // function signature into a visible dataflow rejection.
    if (parameter.type === 'comment') continue;
    const parsed = parameterName(parameter);
    if (parsed.unsupported) {
      addReason(scope, lineOf(parameter), 'unsupported parameter form', []);
      continue;
    }
    if (!parsed.name) continue;
    const binding: Binding = {
      id: `${scope.id}:${parsed.name}:param`,
      name: parsed.name,
      scope,
      line: lineOf(parameter),
      invalid: false,
      hasDefault: parsed.hasDefault,
    };
    if (scope.bindings.has(parsed.name)) {
      binding.invalid = true;
      addReason(scope, lineOf(parameter), `duplicate parameter ${parsed.name}`, [binding]);
      continue;
    }
    scope.bindings.set(parsed.name, binding);
    scope.parameters.push(binding);
  }
}

function collectAssignments(scope: FunctionScope): void {
  walkCode(scope.body, (node) => {
    const assignment = assignmentNode(node);
    if (!assignment) {
      if (node.type === 'augmented_assignment') {
        addReason(scope, lineOf(node), 'augmented assignment is ambiguous', []);
      }
      return;
    }
    const left = assignment.childForFieldName('left');
    if (!left) return;
    const parsed = targetNames(left);
    if (parsed.unsupported) {
      addReason(scope, lineOf(assignment), 'starred or partial destructuring is unsupported', []);
      return;
    }
    for (const name of parsed.names) {
      const existing = scope.bindings.get(name);
      if (existing) {
        existing.invalid = true;
        addReason(scope, lineOf(assignment), `reassignment of ${name} is ambiguous`, [existing]);
        continue;
      }
      const binding: Binding = {
        id: `${scope.id}:${name}:${lineOf(assignment)}`,
        name,
        scope,
        line: lineOf(assignment),
        invalid: isBranchAssignment(assignment, scope),
        hasDefault: false,
      };
      scope.bindings.set(name, binding);
      if (binding.invalid) {
        addReason(scope, lineOf(assignment), `branch assignment of ${name} is unsupported`, [binding]);
      }
    }
  });
}

function allScopes(moduleScope: Scope): Scope[] {
  const scopes: Scope[] = [];
  const visit = (scope: Scope): void => {
    scopes.push(scope);
    for (const child of scope.children) visit(child);
  };
  visit(moduleScope);
  return scopes;
}

function resolveBinding(scope: Scope, name: string): Binding | null {
  for (let current: Scope | null = scope; current; current = current.parent) {
    const binding = current.bindings.get(name);
    if (binding) return binding;
  }
  return null;
}

function resolveFunction(scope: Scope, name: string): FunctionScope | null {
  for (let current: Scope | null = scope; current; current = current.parent) {
    const matches = current.children.filter((child) => child.name.endsWith(`::${name}`) || child.name === name);
    if (matches.length === 1) return matches[0] as FunctionScope;
    if (matches.length > 1) return null;
  }
  return null;
}

function expressionParts(node: SyntaxNode | null): SyntaxNode[] {
  if (!node) return [];
  if (node.type === 'parenthesized_expression') {
    return expressionParts(node.namedChildren[0] ?? null);
  }
  if (['expression_list', 'tuple', 'list'].includes(node.type)) return node.namedChildren;
  return [node];
}

function expressionReferences(node: SyntaxNode | null, scope: Scope): Binding[] {
  if (!node) return [];
  const refs = new Map<string, Binding>();
  const visit = (current: SyntaxNode): void => {
    if (FUNCTION_TYPES.has(current.type)) return;
    if (current.type === 'identifier') {
      const parent = current.parent;
      const isCallName = parent?.type === 'call' && sameNode(parent.childForFieldName('function'), current);
      const isKeywordName = parent?.type === 'keyword_argument' && sameNode(parent.childForFieldName('name'), current);
      const isAttributeName = parent?.type === 'attribute' && sameNode(parent.childForFieldName('attribute'), current);
      if (!isCallName && !isKeywordName && !isAttributeName) {
        const binding = resolveBinding(scope, current.text);
        if (binding) refs.set(binding.id, binding);
      }
    }
    for (const child of current.namedChildren) visit(child);
  };
  visit(node);
  return [...refs.values()];
}

function collectReturns(scope: FunctionScope): void {
  if (scope.name === '<module>') return;
  const returns: ReturnSpec[] = [];
  walkCode(scope.body, (node) => {
    if (node.type !== 'return_statement') return;
    const expression = node.childForFieldName('expression') ?? node.namedChildren[0] ?? null;
    const parts = expressionParts(expression);
    returns.push({
      arity: parts.length,
      refs: parts.map((part) => expressionReferences(part, scope)),
      line: lineOf(node),
      compatible: true,
    });
  });
  scope.returnSpecs = returns;
  const first = returns[0];
  if (!first) return;
  let compatible = true;
  for (const candidate of returns.slice(1)) {
    if (candidate.arity !== first.arity) {
      compatible = false;
      break;
    }
    for (let index = 0; index < first.refs.length; index++) {
      const left = first.refs[index] ?? [];
      const right = candidate.refs[index] ?? [];
      if (left.map((binding) => binding.id).join(',') !== right.map((binding) => binding.id).join(',')) {
        compatible = false;
        break;
      }
    }
    if (!compatible) break;
  }
  if (!compatible) {
    addReason(scope, first.line, 'incompatible multiple returns are unsupported', []);
  }
  first.compatible = compatible;
  scope.returnSpec = first;
}

function callParts(call: SyntaxNode): { name: string; args: SyntaxNode[] } | null {
  const fn = call.childForFieldName('function');
  if (!fn || fn.type !== 'identifier') return null;
  const argumentsNode = call.childForFieldName('arguments');
  return { name: fn.text, args: argumentsNode?.namedChildren ?? [] };
}

function effectiveParameters(scope: FunctionScope): Binding[] {
  if (scope.zoneKind === 'repeat' && scope.parameters.at(-1)?.name === 'index') {
    return scope.parameters.slice(0, -1);
  }
  return scope.parameters;
}

function validateZone(scope: FunctionScope): void {
  if (scope.zoneKind !== 'repeat' || scope.zoneError) return;
  const indexPositions = scope.parameters
    .map((parameter, index) => parameter.name === 'index' ? index : -1)
    .filter((index) => index >= 0);
  // Grove accepts both spellings: an author may expose the implicit index as
  // a trailing parameter, or omit it from the function signature entirely.
  // Only a spelled `index` in any other position is ambiguous and must fail
  // closed rather than shifting state positions.
  if (indexPositions.length === 0 || indexPositions.at(-1) === scope.parameters.length - 1) return;
  scope.zoneError = `repeat zone ${scope.name.split('::').at(-1)} requires a trailing implicit index parameter`;
}

function addEdge(edges: EdgeFact[], source: Binding, target: Binding, line: number, label: string, kind: EdgeFact['kind']): void {
  if (source.invalid || target.invalid) return;
  if (edges.some((edge) => edge.source.id === source.id && edge.target.id === target.id && edge.label === label)) return;
  edges.push({ source, target, line, label, kind });
}

interface CallMapping {
  parameter: Binding;
  value: SyntaxNode;
}

function callArgumentMappings(
  call: SyntaxNode,
  caller: FunctionScope,
  callee: FunctionScope,
): { mappings: CallMapping[]; error: string | null; sources: Binding[] } {
  const info = callParts(call);
  if (!info) return { mappings: [], error: 'unsupported call form', sources: [] };
  const parameters = effectiveParameters(callee);
  const byName = new Map(parameters.map((parameter) => [parameter.name, parameter]));
  const assigned = new Set<string>();
  const mappings: CallMapping[] = [];
  const sources = new Map<string, Binding>();
  let positionalIndex = 0;
  for (const argument of info.args) {
    if (argument.type === 'list_splat' || argument.type === 'dictionary_splat') {
      return { mappings: [], error: 'starred call arguments are unsupported', sources: [...sources.values()] };
    }
    let parameter: Binding | undefined;
    let value = argument;
    if (argument.type === 'keyword_argument') {
      const name = argument.childForFieldName('name')?.text;
      value = argument.childForFieldName('value') ?? argument.namedChild(1) ?? argument;
      parameter = name ? byName.get(name) : undefined;
      if (!parameter) {
        return { mappings: [], error: `unknown or duplicate keyword argument in ${info.name}`, sources: [...sources.values()] };
      }
    } else {
      parameter = parameters[positionalIndex++];
      if (!parameter) {
        return { mappings: [], error: `argument arity mismatch calling ${info.name}`, sources: [...sources.values()] };
      }
    }
    if (assigned.has(parameter.name)) {
      return { mappings: [], error: `duplicate argument ${parameter.name} calling ${info.name}`, sources: [...sources.values()] };
    }
    assigned.add(parameter.name);
    mappings.push({ parameter, value });
    for (const source of expressionReferences(value, caller)) sources.set(source.id, source);
  }
  if ((callee.zoneKind === 'repeat' || callee.zoneKind === 'simulation') && assigned.size !== parameters.length) {
    return { mappings: [], error: `zone state arity mismatch calling ${info.name}`, sources: [...sources.values()] };
  }
  if (parameters.some((parameter) => !parameter.hasDefault && !assigned.has(parameter.name))) {
    return { mappings: [], error: `argument arity mismatch calling ${info.name}`, sources: [...sources.values()] };
  }
  return { mappings, error: null, sources: [...sources.values()] };
}

function mapCallArguments(
  call: SyntaxNode,
  caller: FunctionScope,
  callee: FunctionScope,
  edges: EdgeFact[],
): void {
  const info = callParts(call);
  if (!info) return;
  if (callee.zoneError) {
    const sources = info.args.flatMap((argument) => expressionReferences(argument, caller));
    addReason(caller, lineOf(call), callee.zoneError, sources);
    return;
  }
  const mapped = callArgumentMappings(call, caller, callee);
  if (mapped.error) {
    addReason(caller, lineOf(call), mapped.error, mapped.sources);
    return;
  }
  for (const mapping of mapped.mappings) {
    for (const source of expressionReferences(mapping.value, caller)) {
      addEdge(edges, source, mapping.parameter, lineOf(call), `ARG ${source.name} -> ${callee.name.split('::').at(-1)}.${mapping.parameter.name}`, 'ARG');
    }
  }
}

function mapAssignment(
  assignment: SyntaxNode,
  scope: FunctionScope,
  edges: EdgeFact[],
): void {
  const left = assignment.childForFieldName('left');
  const right = assignment.childForFieldName('right');
  if (!left || !right) return;
  const targets = targetNames(left);
  if (targets.unsupported) return;
  const targetBindings = targets.names.map((name) => scope.bindings.get(name)).filter((binding): binding is Binding => !!binding);
  if (targetBindings.length !== targets.names.length) return;

  const call = right.type === 'call' ? right : null;
  const callee = call ? callParts(call) : null;
  const calleeScope = callee ? resolveFunction(scope, callee.name) : null;
  if (call && calleeScope) {
    if (calleeScope.zoneError) {
      addReason(scope, lineOf(assignment), calleeScope.zoneError, targetBindings);
      return;
    }
    const mapped = callArgumentMappings(call, scope, calleeScope);
    if (mapped.error) {
      addReason(scope, lineOf(assignment), mapped.error, [...targetBindings, ...mapped.sources]);
      return;
    }
    if (calleeScope.returnSpec && !calleeScope.returnSpec.compatible) {
      addReason(scope, lineOf(assignment), `incompatible multiple returns from ${callee!.name}`, targetBindings);
      return;
    }
  }
  if (calleeScope && calleeScope.returnSpec?.compatible) {
    const returnSpec = calleeScope.returnSpec;
    if (returnSpec.arity !== targetBindings.length) {
      addReason(scope, lineOf(assignment), `return arity mismatch from ${callee!.name}`, targetBindings);
      return;
    }
    for (let index = 0; index < targetBindings.length; index++) {
      const target = targetBindings[index]!;
      for (const source of returnSpec.refs[index] ?? []) {
        addEdge(edges, source, target, lineOf(assignment), `RET ${callee!.name}[${index}] -> ${target.name}`, 'RET');
      }
    }
    return;
  }
  if (callee && calleeScope && !calleeScope.returnSpec) {
    addReason(scope, lineOf(assignment), `return arity is unavailable from ${callee.name}`, targetBindings);
    return;
  }
  const parts = expressionParts(right);
  if (targetBindings.length > 1) {
    if (parts.length !== targetBindings.length) {
      addReason(scope, lineOf(assignment), 'tuple return or destructuring arity mismatch', targetBindings);
      return;
    }
    for (let index = 0; index < targetBindings.length; index++) {
      for (const source of expressionReferences(parts[index] ?? null, scope)) {
        addEdge(edges, source, targetBindings[index]!, lineOf(assignment), `${source.name} -> ${targetBindings[index]!.name}`, 'WIRE');
      }
    }
    return;
  }
  for (const source of expressionReferences(right, scope)) {
    addEdge(edges, source, targetBindings[0]!, lineOf(assignment), `${source.name} -> ${targetBindings[0]!.name}`, 'WIRE');
  }
}

function processScope(scope: FunctionScope, edges: EdgeFact[]): void {
  walkCode(scope.body, (node) => {
    const assignment = assignmentNode(node);
    if (assignment) mapAssignment(assignment, scope, edges);
    if (node.type === 'call') {
      const info = callParts(node);
      const callee = info ? resolveFunction(scope, info.name) : null;
      if (callee) mapCallArguments(node, scope, callee, edges);
    }
  });
}

function bindingScopeIsWithin(binding: Binding, scope: Scope): boolean {
  for (let current: Scope | null = binding.scope; current; current = current.parent) {
    if (current === scope) return true;
  }
  return false;
}

function extractQueryIdentifiers(query: string): string[] {
  const tokens = query.match(/[A-Za-z_][A-Za-z0-9_.:]*/g) ?? [];
  const precise = tokens.filter((token) => {
    const leaf = token.split('.').at(-1) ?? token;
    return leaf.length > 2 && (/[A-Z]/.test(leaf) || leaf.includes('_') || token.includes('.') || token.includes('::'));
  });
  return [...new Set(precise)];
}

function selectRootBindings(
  scopes: FunctionScope[],
  edges: EdgeFact[],
  seeds: readonly string[],
  query: string,
): { roots: Binding[]; rejections: Array<{ line: number; message: string }> } {
  const candidates = scopes
    .flatMap((scope) => [...scope.bindings.values()])
    .filter((binding) => seeds.includes(binding.name));
  const candidateIds = new Set(candidates.map((binding) => binding.id));
  const roots = candidates.filter((binding) =>
    !edges.some((edge) => edge.target.id === binding.id && candidateIds.has(edge.source.id)),
  );
  const queryTokens = new Set(query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
  const selected: Binding[] = [];
  const rejections: Array<{ line: number; message: string }> = [];
  const byName = new Map<string, Binding[]>();
  for (const root of roots) {
    const group = byName.get(root.name) ?? [];
    group.push(root);
    byName.set(root.name, group);
  }
  for (const [name, group] of byName) {
    if (group.length === 1) {
      selected.push(group[0]!);
      continue;
    }
    const named = group.filter((binding) =>
      binding.scope.name.split('::').some((scopeName) => queryTokens.has(scopeName)),
    );
    if (named.length === 1) {
      selected.push(named[0]!);
      continue;
    }
    const owners = [...new Set(group.map((binding) => binding.scope.name))].sort();
    rejections.push({
      line: Math.min(...group.map((binding) => binding.line)),
      message: `ambiguous seed ${name} across scopes ${owners.join(', ')}`,
    });
  }
  return { roots: selected, rejections };
}

function selectedFacts(
  edges: EdgeFact[],
  roots: Binding[],
  focusNames: ReadonlySet<string>,
  query: string,
  maxLines: number,
): { edges: EdgeFact[]; reachable: Set<string> } {
  const distances = new Map<string, number>();
  const queue: Binding[] = [];
  const outgoing = new Map<string, EdgeFact[]>();
  for (const edge of edges) {
    const bucket = outgoing.get(edge.source.id) ?? [];
    bucket.push(edge);
    outgoing.set(edge.source.id, bucket);
  }
  for (const root of roots) {
    if (!distances.has(root.id)) {
      distances.set(root.id, 0);
      queue.push(root);
    }
  }
  while (queue.length > 0) {
    const source = queue.shift()!;
    const distance = distances.get(source.id) ?? 0;
    for (const edge of outgoing.get(source.id) ?? []) {
      if (distances.has(edge.target.id)) continue;
      distances.set(edge.target.id, distance + 1);
      queue.push(edge.target);
    }
  }
  const seedReachableIds = new Set(distances.keys());
  const queryTerms = (query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 4);
  const capGateRequested = /\bcap\s+gate\b/i.test(query);
  const labelCallee = (label: string): string | null => {
    const match = label.startsWith('ARG ')
      ? /^ARG\s+[^-]+->\s*([^\.\s]+)/.exec(label)
      : /^RET\s+([^\[]+)/.exec(label);
    return match?.[1]?.split('::').at(-1)?.toLowerCase() ?? null;
  };
  const mentionsQueryTerm = (value: string, term: string): boolean => {
    const normalized = value.toLowerCase();
    if (normalized === term || normalized.startsWith(`${term}_`) || term.startsWith(`${normalized}_`)) return true;
    // A prose query commonly says "validation" while the authored helper is
    // named validate/skel_validate. Six-character stems keep this matching
    // semantic and bounded without turning ordinary stop words into roots.
    if (normalized.length >= 6 && term.length >= 6) {
      return normalized.replace(/^skel_/, '').slice(0, 6) === term.slice(0, 6);
    }
    return false;
  };
  const queryMatchCount = (edge: EdgeFact): number => {
    const values = [edge.source.name, edge.target.name, labelCallee(edge.label)].filter(
      (value): value is string => !!value,
    );
    return queryTerms.filter((term) => values.some((value) => mentionsQueryTerm(value, term))).length;
  };
  const capGateRelevant = (edge: EdgeFact): boolean => {
    if (!capGateRequested) return false;
    const inSolveScope = [edge.source.scope, edge.target.scope].some((scope) =>
      scope.name === 'solve' || scope.name.endsWith('::solve'),
    );
    if (!inSolveScope) return false;
    return [edge.source.name, edge.target.name].some((name) =>
      name.startsWith('cap_') || name.startsWith('gate_') || name.endsWith('_capped'),
    );
  };
  const queryRelevant = (edge: EdgeFact): boolean => queryMatchCount(edge) > 0;
  const rootScopes = [...new Set(roots.map((root) => root.scope))];
  const anchorEdges = edges.filter((edge) =>
    edge.kind === 'RET' &&
    !seedReachableIds.has(edge.source.id) &&
    rootScopes.some((scope) => bindingScopeIsWithin(edge.target, scope)) &&
    queryRelevant(edge),
  );
  const anchorEdgeSet = new Set(anchorEdges);
  const anchorTargets = new Set(anchorEdges.map((edge) => edge.target));
  const anchorTargetIds = new Set([...anchorTargets].map((target) => target.id));
  const anchorQueue = [...anchorTargets];
  const anchorDistances = new Map<string, number>();
  for (const target of anchorQueue) anchorDistances.set(target.id, 0);
  while (anchorQueue.length > 0) {
    const source = anchorQueue.shift()!;
    const distance = anchorDistances.get(source.id) ?? 0;
    for (const edge of outgoing.get(source.id) ?? []) {
      if (anchorDistances.has(edge.target.id)) continue;
      anchorDistances.set(edge.target.id, distance + 1);
      anchorQueue.push(edge.target);
    }
  }
  for (const [id, distance] of anchorDistances) {
    if (!distances.has(id)) distances.set(id, distance);
  }
  const incoming = new Map<string, EdgeFact[]>();
  const selectedReachableEdges = [...new Map(
    edges
      .filter((edge) => distances.has(edge.source.id) || anchorEdgeSet.has(edge))
      .map((edge) => [`${edge.line}:${edge.label}`, edge] as const),
  ).values()];
  for (const edge of selectedReachableEdges) {
    const bucket = incoming.get(edge.target.id) ?? [];
    bucket.push(edge);
    incoming.set(edge.target.id, bucket);
  }
  // A semantic anchor starts a short closure at its owning value. Preserve
  // the full fan-in of the first value it feeds (e.g. `w8_bad -> w8_all`),
  // otherwise the ordinary-call return can be shown while its merge input is
  // lost to the large-file ceiling.
  const anchorFanInTargets = new Set(
    selectedReachableEdges
      .filter((edge) => anchorTargetIds.has(edge.source.id))
      .map((edge) => edge.target.id),
  );
  const fanInTargets = new Set(
    selectedReachableEdges
      .filter((edge) => focusNames.has(edge.source.name) || focusNames.has(edge.target.name) || queryRelevant(edge))
      .map((edge) => edge.target.id),
  );
  const priority = (edge: EdgeFact): number => {
    let score = 0;
    if (focusNames.has(edge.source.name)) score += 80;
    if (focusNames.has(edge.target.name)) score += 100;
    // If a prose query names both a binding and its call boundary (for
    // example, `capped_end` and `emit`), retain that endpoint under the
    // per-file ceiling even when structural zone bullets consume slots.
    const queryMatches = queryMatchCount(edge);
    score += queryMatches * 180;
    // The phrase "cap gate" is a bounded semantic request for the named
    // gate-local bindings in the solve scope; keep those source spans ahead of
    // unrelated helper internals in a large file.
    if (capGateRelevant(edge)) score += 3000;
    // An anchored return is the explicit bridge from a queried semantic stage
    // (for example, "validation") into the owning scope. Keep that bridge in
    // the bounded result even when the file has many unrelated helper wires.
    if (anchorEdgeSet.has(edge)) score += 1600;
    // Two query-matched endpoints describe an explicit boundary request, such
    // as `capped_end -> skel_cap_emit.active`, rather than incidental context.
    if (queryMatches > 1) score += 1800;
    // Preserve the complete fan-in once any dependency of a value is relevant.
    // Otherwise a bounded slice can retain the queried direct input and drop
    // the ordinary-call return that produces the same tuple/boolean value.
    if (fanInTargets.has(edge.target.id) && (incoming.get(edge.target.id)?.length ?? 0) > 1) score += 1000;
    if (anchorFanInTargets.has(edge.target.id) && (incoming.get(edge.target.id)?.length ?? 0) > 1) score += 3000;
    if (edge.kind === 'RET') score += 30;
    if (edge.kind === 'ARG') score += 20;
    score -= (distances.get(edge.source.id) ?? 0);
    return score;
  };
  const ranked = [...selectedReachableEdges].sort((a, b) => priority(b) - priority(a) || a.line - b.line);
  return { edges: ranked.slice(0, maxLines), reachable: new Set(distances.keys()) };
}

function relevantZoneScopes(moduleScope: Scope, reachable: Set<string>): FunctionScope[] {
  const zones: FunctionScope[] = [];
  for (const scope of allScopes(moduleScope)) {
    if (!scope.zoneKind) continue;
    const hasReachableBinding = [...scope.bindings.values()].some((binding) => reachable.has(binding.id));
    const hasReachableDescendant = allScopes(scope).some((nested) =>
      [...nested.bindings.values()].some((binding) => reachable.has(binding.id)),
    );
    if (hasReachableBinding || hasReachableDescendant) zones.push(scope as FunctionScope);
  }
  return zones;
}

function formatZone(scope: FunctionScope, filePath: string): string {
  const owner = scope.parent?.name && scope.parent.name !== '<module>' ? ` owner=${scope.parent.name}` : '';
  return `ZONE ${scope.name.split('::').at(-1)} kind=${scope.zoneKind} state-arity=${effectiveParameters(scope).length}${owner} [${filePath}:${scope.zoneLine}]`;
}

export async function buildGroveEphemeralDataflow(
  content: string,
  filePath: string,
  query: string,
  seeds: readonly string[],
  maxLines: number,
): Promise<EphemeralDataflowResult> {
  await loadGrammarsForLanguages(['python']);
  const parser = getParser('python');
  if (!parser || maxLines <= 0) return { text: '', spans: [], factCount: 0 };
  const tree = parser.parse(content);
  if (!tree) return { text: '', spans: [], factCount: 0 };
  try {
    if (!hasNodeTreeDecorator(tree.rootNode)) return { text: '', spans: [], factCount: 0 };
    const moduleScope = buildScopeTree(tree.rootNode);
    const scopes = allScopes(moduleScope).filter((scope): scope is FunctionScope => scope.name !== '<module>');
    for (const scope of scopes) {
      collectParameters(scope);
      validateZone(scope);
      collectAssignments(scope);
    }
    for (const scope of scopes) collectReturns(scope);

    const edges: EdgeFact[] = [];
    for (const scope of scopes) processScope(scope, edges);
    const rootSelection = selectRootBindings(scopes, edges, seeds, query);
    const roots = rootSelection.roots;
    if (roots.length === 0 && rootSelection.rejections.length === 0) {
      return { text: '', spans: [], factCount: 0 };
    }

    const focusedNames = new Set(extractQueryIdentifiers(query));
    const selected = selectedFacts(edges, roots, focusedNames, query, maxLines);
    const zones = relevantZoneScopes(moduleScope, selected.reachable);
    const reasons = scopes
      .flatMap((scope) => scope.reasons)
      .filter((reason) =>
        reason.bindings.some((binding) => selected.reachable.has(binding.id)) ||
        zones.some((zone) => bindingScopeIsWithin(reason.bindings[0] ?? { scope: reason.scope } as Binding, zone)) ||
        reason.scope === roots[0]?.scope,
      )
      .sort((a, b) => a.line - b.line);

    const structuralBullets: Array<{ line: number; text: string }> = [];
    for (const zone of zones) structuralBullets.push({ line: zone.zoneLine, text: formatZone(zone, filePath) });
    for (const reason of reasons) {
      structuralBullets.push({ line: reason.line, text: `REJECTED: ${reason.message} [${filePath}:${reason.line}]` });
    }
    for (const rejection of rootSelection.rejections) {
      structuralBullets.push({
        line: rejection.line,
        text: `REJECTED: ${rejection.message} [${filePath}:${rejection.line}]`,
      });
    }
    structuralBullets.sort((a, b) => a.line - b.line || a.text.localeCompare(b.text));
    const bullets = structuralBullets.slice(0, maxLines);
    const renderedEdges = [...new Map(
      selected.edges.map((edge) => [`${edge.line}:${edge.label}`, edge]),
    ).values()];
    for (const edge of renderedEdges.slice(0, Math.max(0, maxLines - bullets.length))) {
      bullets.push({ line: edge.line, text: `${edge.label} [${filePath}:${edge.line}]` });
    }
    bullets.sort((a, b) => a.line - b.line || a.text.localeCompare(b.text));
    const bounded = bullets;
    if (bounded.length === 0) return { text: '', spans: [], factCount: 0 };

    const spans = [...new Map(bounded.map((bullet) => [bullet.line, { start: bullet.line, end: bullet.line }])).values()];
    const lines = [
      `**Dataflow (within \`${filePath}\`, direct wires only)**`,
      '> Query-time, exact-file, scope-aware facts; no local nodes or edges are persisted.',
      ...bounded.map((bullet) => `- ${bullet.text}`),
      '',
    ];
    return { text: lines.join('\n'), spans, factCount: bounded.length };
  } finally {
    tree.delete();
  }
}

export { extractQueryIdentifiers as extractGroveDataflowIdentifiers };
