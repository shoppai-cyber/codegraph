import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getParser } from '../../extraction/grammars';
import type { Node } from '../../types';
import type {
  FrameworkExtractionResult,
  FrameworkResolver,
  ResolvedRef,
  ResolutionContext,
  UnresolvedRef,
} from '../types';

const COMPONENT_REF_PREFIX = '__grove_component_ref__';
const FUNCTION_REF_PREFIX = '__grove_function_ref__';

function encodedReference(prefix: string, payload: unknown): string {
  return `${prefix}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

function decodeReference<T>(referenceName: string, prefix: string): T | null {
  if (!referenceName.startsWith(prefix)) return null;
  try {
    return JSON.parse(
      Buffer.from(referenceName.slice(prefix.length), 'base64url').toString('utf8')
    ) as T;
  } catch {
    return null;
  }
}

function componentReference(qualifiedName: string): string {
  return encodedReference(COMPONENT_REF_PREFIX, { qualifiedName });
}

function functionReference(qualifiedName: string, startLine: number): string {
  return encodedReference(FUNCTION_REF_PREFIX, { qualifiedName, startLine });
}

function emptyExtraction(): FrameworkExtractionResult {
  return { nodes: [], references: [] };
}

function maskPythonStringsAndComments(content: string): string {
  const masked = content.split('');
  let index = 0;

  while (index < content.length) {
    const char = content[index]!;
    if (char === '#') {
      while (index < content.length && content[index] !== '\n') {
        masked[index] = ' ';
        index++;
      }
      continue;
    }
    if (char !== '"' && char !== "'") {
      index++;
      continue;
    }

    const quote = char;
    const triple = content.slice(index, index + 3) === quote.repeat(3);
    const delimiterLength = triple ? 3 : 1;
    for (let offset = 0; offset < delimiterLength; offset++) masked[index + offset] = ' ';
    index += delimiterLength;

    while (index < content.length) {
      if (triple && content.slice(index, index + 3) === quote.repeat(3)) {
        masked[index] = ' ';
        masked[index + 1] = ' ';
        masked[index + 2] = ' ';
        index += 3;
        break;
      }
      if (!triple && content[index] === quote) {
        masked[index] = ' ';
        index++;
        break;
      }
      if (content[index] === '\\') {
        masked[index] = ' ';
        index++;
        if (index < content.length && content[index] !== '\n') {
          masked[index] = ' ';
          index++;
        }
        continue;
      }
      if (content[index] !== '\n' && content[index] !== '\r') masked[index] = ' ';
      index++;
    }
  }

  return masked.join('');
}

function hasNodeTreeImport(content: string): boolean {
  const lines = maskPythonStringsAndComments(content).split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index]?.match(
      /^from[ \t]+(?:src\.)?grove[ \t]+import[ \t]+(.*)$/
    );
    if (!match) continue;

    let importedNames = match[1] ?? '';
    const needsContinuation = (): boolean => {
      const opens = (importedNames.match(/\(/g) ?? []).length;
      const closes = (importedNames.match(/\)/g) ?? []).length;
      return opens > closes || importedNames.trimEnd().endsWith('\\');
    };
    while (needsContinuation()) {
      index++;
      if (index >= lines.length) break;
      importedNames += `\n${lines[index]}`;
    }
    if (/(?:^|[,\s(])node_tree(?:\s+as\s+[A-Za-z_]\w*)?(?=$|[,\s)])/m.test(importedNames)) {
      return true;
    }
  }
  return false;
}

function plainStringValue(node: SyntaxNode | null): string | null {
  if (!node || node.type !== 'string') return null;

  const text = node.text;
  const match = text.match(/^([uU]?)(["'])([\s\S]*)\2$/);
  if (!match) return null;
  const quote = match[2]!;
  const body = match[3]!;
  if (body.startsWith(quote.repeat(2))) return null;

  let decoded = '';
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    if (char !== '\\') {
      decoded += char;
      continue;
    }
    if (index + 1 >= body.length) return null;
    const escaped = body[++index]!;
    const simple = new Map<string, string>([
      ['\\', '\\'], ["'", "'"], ['"', '"'], ['a', '\x07'], ['b', '\b'],
      ['f', '\f'], ['n', '\n'], ['r', '\r'], ['t', '\t'], ['v', '\v'],
    ]);
    const simpleValue = simple.get(escaped);
    if (simpleValue !== undefined) {
      decoded += simpleValue;
      continue;
    }
    if (escaped === '\n') continue;
    if (escaped === '\r' && body[index + 1] === '\n') {
      index++;
      continue;
    }
    // Python decodes named Unicode escapes through its Unicode character
    // database. CodeGraph does not carry that database here, so refuse the
    // identity rather than indexing a spelling that differs from ast.Constant.
    if (escaped === 'N') return null;
    if (escaped === 'x' || escaped === 'u' || escaped === 'U') {
      const length = escaped === 'x' ? 2 : escaped === 'u' ? 4 : 8;
      const digits = body.slice(index + 1, index + 1 + length);
      if (digits.length !== length || !/^[0-9a-fA-F]+$/.test(digits)) return null;
      const codePoint = Number.parseInt(digits, 16);
      if (codePoint > 0x10ffff) return null;
      decoded += escaped === 'u'
        ? String.fromCharCode(codePoint)
        : String.fromCodePoint(codePoint);
      index += length;
      continue;
    }
    if (/[0-7]/.test(escaped)) {
      let digits = escaped;
      while (digits.length < 3 && /[0-7]/.test(body[index + 1] ?? '')) {
        digits += body[++index]!;
      }
      decoded += String.fromCharCode(Number.parseInt(digits, 8));
      continue;
    }
    // Python currently preserves unknown escapes in ordinary string
    // constants. Preserve the backslash so the source identity matches the
    // ast.Constant value instead of silently normalizing it away.
    decoded += `\\${escaped}`;
  }
  return decoded;
}

function literalDictionaryEntries(
  node: SyntaxNode | null
): Array<{ key: string; value: SyntaxNode }> | null {
  if (!node || node.type !== 'dictionary') return null;
  const entries: Array<{ key: string; value: SyntaxNode }> = [];
  const seenKeys = new Set<string>();
  for (const child of node.namedChildren) {
    if (child.type !== 'pair') return null;
    const keyNode = child.childForFieldName('key') ?? child.namedChild(0);
    const valueNode = child.childForFieldName('value') ?? child.namedChild(1);
    const key = plainStringValue(keyNode);
    if (key === null || !valueNode || seenKeys.has(key)) return null;
    seenKeys.add(key);
    entries.push({ key, value: valueNode });
  }
  return entries;
}

function literalLabelsValue(node: SyntaxNode | null): boolean {
  const entries = literalDictionaryEntries(node);
  if (!entries) return false;
  return entries.every(({ value }) => {
    const label = plainStringValue(value);
    return label !== null && label.trim().length > 0;
  });
}

function literalPanelsValue(node: SyntaxNode | null): boolean {
  const entries = literalDictionaryEntries(node);
  if (!entries) return false;
  return entries.every(({ value }) =>
    value.type === 'list' &&
    value.namedChildren.every((item) => plainStringValue(item) !== null)
  );
}

function literalStringPairSequenceValue(node: SyntaxNode | null): boolean {
  if (!node || (node.type !== 'list' && node.type !== 'tuple')) return false;
  return node.namedChildren.every(
    (item) =>
      (item.type === 'list' || item.type === 'tuple') &&
      item.namedChildren.length === 2 &&
      item.namedChildren.every((value) => plainStringValue(value) !== null)
  );
}

type GroveZoneKind = 'repeat' | 'simulation' | 'foreach';

interface GroveBindings {
  nodeTreeNames: Set<string>;
  zoneKindByName: Map<string, GroveZoneKind>;
}

const ZONE_KIND_BY_IMPORT = new Map<string, GroveZoneKind>([
  ['repeat_zone', 'repeat'],
  ['simulation_zone', 'simulation'],
  ['foreach_zone', 'foreach'],
]);

function importedGroveBindings(root: SyntaxNode): GroveBindings {
  const bindings: GroveBindings = {
    nodeTreeNames: new Set<string>(),
    zoneKindByName: new Map<string, GroveZoneKind>(),
  };

  for (const statement of root.namedChildren) {
    if (statement.type !== 'import_from_statement') continue;

    const moduleNode =
      statement.childForFieldName('module_name') ?? statement.namedChild(0);
    if (moduleNode?.text !== 'grove' && moduleNode?.text !== 'src.grove') continue;

    for (const imported of statement.namedChildren.slice(1)) {
      let originalName: string | null = null;
      let localName: string | null = null;
      if (imported.type === 'aliased_import') {
        const original = imported.childForFieldName('name') ?? imported.namedChild(0);
        const alias = imported.childForFieldName('alias') ?? imported.namedChild(1);
        originalName = original?.text ?? null;
        localName = alias?.text ?? null;
      } else {
        originalName = imported.text;
        localName = imported.text;
      }

      if (!originalName || !localName) continue;
      if (originalName === 'node_tree') bindings.nodeTreeNames.add(localName);
      const zoneKind = ZONE_KIND_BY_IMPORT.get(originalName);
      if (zoneKind) bindings.zoneKindByName.set(localName, zoneKind);
    }
  }

  return bindings;
}

function groveDecoratorId(
  decorator: SyntaxNode,
  nodeTreeNames: ReadonlySet<string>
): string | null {
  const call = decorator.namedChildren.find((child) => child.type === 'call');
  if (!call) return null;

  const callee = call.childForFieldName('function') ?? call.namedChild(0);
  if (!callee || callee.type !== 'identifier' || !nodeTreeNames.has(callee.text)) {
    return null;
  }

  const argumentsNode =
    call.childForFieldName('arguments') ??
    call.namedChildren.find((child) => child.type === 'argument_list');
  if (!argumentsNode) return null;

  let groupId: string | null = null;
  let target: string | null = null;
  let hasId = false;
  let hasTarget = false;
  let host: string | null = null;
  const seenNames = new Set<string>();
  const allowedNames = new Set([
    'description', 'host', 'id', 'interface_layout', 'interface_order', 'labels',
    'name', 'panels', 'target',
  ]);
  for (const argument of argumentsNode.namedChildren) {
    if (argument.type !== 'keyword_argument') return null;
    const name = argument.childForFieldName('name') ?? argument.namedChild(0);
    const value = argument.childForFieldName('value') ?? argument.namedChild(1);
    const keyword = name?.text;
    if (!keyword || !allowedNames.has(keyword) || seenNames.has(keyword)) return null;
    seenNames.add(keyword);
    if (keyword === 'labels') {
      if (!literalLabelsValue(value)) return null;
      continue;
    }
    if (keyword === 'panels') {
      if (!literalPanelsValue(value)) return null;
      continue;
    }
    if (keyword === 'interface_order' || keyword === 'interface_layout') {
      if (!literalStringPairSequenceValue(value)) return null;
      continue;
    }
    const literal = plainStringValue(value);
    if (literal === null) return null;
    if (keyword === 'id') {
      if (hasId) return null;
      hasId = true;
      groupId = literal;
    }
    if (keyword === 'target') {
      if (hasTarget) return null;
      hasTarget = true;
      target = literal;
    }
    if (keyword === 'host') host = literal;
  }

  if (!groupId || !target || !['geometry', 'shader', 'compositor'].includes(target)) {
    return null;
  }
  if (host && !['MESH', 'CURVE', 'WORLD'].includes(host)) return null;
  if (host === 'WORLD' && target !== 'shader') return null;
  return groupId;
}

function boundGroveZoneKind(
  decorator: SyntaxNode,
  bindings: GroveBindings
): GroveZoneKind | null {
  const call = decorator.namedChildren.find((child) => child.type === 'call');
  const callee = call
    ? call.childForFieldName('function') ?? call.namedChild(0)
    : decorator.namedChildren.find((child) => child.type === 'identifier') ?? null;
  if (callee?.type !== 'identifier') return null;

  return bindings.zoneKindByName.get(callee.text) ?? null;
}

function groveZoneKind(
  decorator: SyntaxNode,
  bindings: GroveBindings
): GroveZoneKind | null {
  const call = decorator.namedChildren.find((child) => child.type === 'call');
  const kind = boundGroveZoneKind(decorator, bindings);
  if (!kind) return null;

  const argumentsNode = call
    ? call.childForFieldName('arguments') ??
      call.namedChildren.find((child) => child.type === 'argument_list') ?? null
    : null;
  const argumentsList = argumentsNode?.namedChildren ?? [];
  if (kind === 'simulation') {
    return !call || argumentsList.length === 0 ? kind : null;
  }
  if (!call || !argumentsNode) return null;

  const keywordValues = new Map<string, SyntaxNode>();
  for (const argument of argumentsList) {
    if (argument.type !== 'keyword_argument') return null;
    const name = argument.childForFieldName('name') ?? argument.namedChild(0);
    const value = argument.childForFieldName('value') ?? argument.namedChild(1);
    const keyword = name?.text;
    if (!keyword || !value || keywordValues.has(keyword)) return null;
    keywordValues.set(keyword, value);
  }
  if (kind === 'repeat') {
    return keywordValues.size === 1 && keywordValues.has('iterations') ? kind : null;
  }

  if (
    keywordValues.size !== 2 ||
    !keywordValues.has('domain') ||
    !keywordValues.has('geometry')
  ) {
    return null;
  }
  const domain = plainStringValue(keywordValues.get('domain') ?? null);
  return domain && [
    'POINT', 'EDGE', 'FACE', 'CORNER', 'CURVE', 'INSTANCE', 'LAYER',
  ].includes(domain)
    ? kind
    : null;
}

function syntaxNodeKey(node: SyntaxNode): string {
  return `${node.startIndex}:${node.endIndex}`;
}

function functionHeaderEnd(functionNode: SyntaxNode): { row: number; column: number } {
  const body = functionNode.childForFieldName('body');
  let end = functionNode.startPosition;
  for (const child of functionNode.namedChildren) {
    if (body && syntaxNodeKey(child) === syntaxNodeKey(body)) continue;
    if (
      child.endPosition.row > end.row ||
      (child.endPosition.row === end.row && child.endPosition.column > end.column)
    ) {
      end = child.endPosition;
    }
  }
  return end;
}

function groveScopeCalls(
  functionNode: SyntaxNode,
  zoneFunctions: ReadonlySet<string>,
  zoneNamesByOwner: ReadonlyMap<string, ReadonlySet<string>>
): Array<{ call: SyntaxNode; shadowedZoneNames: ReadonlySet<string> }> {
  const calls: Array<{ call: SyntaxNode; shadowedZoneNames: ReadonlySet<string> }> = [];
  const visitFunction = (currentFunction: SyntaxNode): void => {
    const body = currentFunction.childForFieldName('body');
    if (!body) return;
    const shadowedZoneNames =
      zoneNamesByOwner.get(syntaxNodeKey(currentFunction)) ?? new Set<string>();

    const visit = (node: SyntaxNode): void => {
      if (node.type === 'decorated_definition') {
        const nestedFunction = node.namedChildren.find(
          (child) => child.type === 'function_definition'
        );
        if (nestedFunction && zoneFunctions.has(syntaxNodeKey(nestedFunction))) {
          visitFunction(nestedFunction);
        }
        return;
      }
      if (node !== body && node.type === 'function_definition') {
        if (zoneFunctions.has(syntaxNodeKey(node))) {
          visitFunction(node);
        }
        return;
      }
      if (node.type === 'class_definition' || node.type === 'lambda') return;
      if (node.type === 'call') calls.push({ call: node, shadowedZoneNames });
      for (const child of node.namedChildren) visit(child);
    };
    visit(body);
  };
  visitFunction(functionNode);
  return calls;
}

function collectZones(
  filePath: string,
  groupId: string,
  functionNode: SyntaxNode,
  ownerNode: Node,
  pythonOwnerQualifiedName: string,
  bindings: GroveBindings,
  updatedAt: number,
  nodes: Node[],
  references: UnresolvedRef[],
  zoneFunctions: Set<string>,
  zoneNamesByOwner: Map<string, Set<string>>
): void {
  const body = functionNode.childForFieldName('body');
  if (!body) return;

  const candidates: Array<{
    decorators: SyntaxNode[];
    nestedFunction: SyntaxNode;
    zoneKind: GroveZoneKind;
    zoneName: string;
  }> = [];
  const declaredNames = new Set<string>();
  for (const statement of body.namedChildren) {
    if (statement.type !== 'decorated_definition') continue;
    const decorators = statement.namedChildren.filter(
      (child) => child.type === 'decorator'
    );
    const nestedFunction = statement.namedChildren.find(
      (child) => child.type === 'function_definition'
    );
    if (decorators.length !== 1 || !nestedFunction) continue;

    const zoneName = nestedFunction.childForFieldName('name')?.text;
    if (!zoneName) continue;
    if (boundGroveZoneKind(decorators[0]!, bindings)) declaredNames.add(zoneName);
    const zoneKind = groveZoneKind(decorators[0]!, bindings);
    if (!zoneKind) continue;
    candidates.push({ decorators, nestedFunction, zoneKind, zoneName });
  }

  const zoneNameCounts = new Map<string, number>();
  for (const candidate of candidates) {
    zoneNameCounts.set(
      candidate.zoneName,
      (zoneNameCounts.get(candidate.zoneName) ?? 0) + 1
    );
  }
  zoneNamesByOwner.set(syntaxNodeKey(functionNode), declaredNames);

  for (const { decorators, nestedFunction, zoneKind, zoneName } of candidates) {
    if (zoneNameCounts.get(zoneName) !== 1) continue;

    const startLine = decorators[0]!.startPosition.row + 1;
    const headerEnd = functionHeaderEnd(nestedFunction);
    const groupQualifiedName = `${filePath}::grove:${groupId}`;
    const qualifiedName =
      ownerNode.qualifiedName === groupQualifiedName
        ? `${groupQualifiedName}::zone:${zoneKind}:${zoneName}`
        : `${ownerNode.qualifiedName}::${zoneKind}:${zoneName}`;
    const zoneNode: Node = {
      id: `grove-zone:${filePath}:${groupId}:${qualifiedName}:${startLine}`,
      kind: 'component',
      name: zoneName,
      qualifiedName,
      filePath,
      language: 'python',
      startLine,
      endLine: headerEnd.row + 1,
      startColumn: decorators[0]!.startPosition.column,
      endColumn: headerEnd.column,
      updatedAt,
    };
    nodes.push(zoneNode);
    zoneFunctions.add(syntaxNodeKey(nestedFunction));
    references.push({
      fromNodeId: ownerNode.id,
      referenceName: componentReference(qualifiedName),
      referenceKind: 'contains',
      line: startLine,
      column: decorators[0]!.startPosition.column,
      filePath,
      language: 'python',
    });
    const pythonQualifiedName = `${pythonOwnerQualifiedName}::${zoneName}`;
    references.push({
      fromNodeId: zoneNode.id,
      referenceName: functionReference(
        pythonQualifiedName,
        nestedFunction.startPosition.row + 1
      ),
      referenceKind: 'decorates',
      line: startLine,
      column: decorators[0]!.startPosition.column,
      filePath,
      language: 'python',
    });

    collectZones(
      filePath,
      groupId,
      nestedFunction,
      zoneNode,
      pythonQualifiedName,
      bindings,
      updatedAt,
      nodes,
      references,
      zoneFunctions,
      zoneNamesByOwner
    );
  }
}

function extractGrove(filePath: string, content: string): FrameworkExtractionResult {
  const parser = getParser('python');
  if (!parser) return emptyExtraction();

  const tree = parser.parse(content);
  if (!tree) return emptyExtraction();
  try {
  const bindings = importedGroveBindings(tree.rootNode);
  if (bindings.nodeTreeNames.size === 0) return emptyExtraction();

  let groups: Array<{ node: Node; functionNode: SyntaxNode }> = [];
  const updatedAt = Date.now();

  for (const statement of tree.rootNode.namedChildren) {
    if (statement.type !== 'decorated_definition') continue;

    const functionNode = statement.namedChildren.find(
      (child) => child.type === 'function_definition'
    );
    if (!functionNode) continue;

    const decorators = statement.namedChildren.filter(
      (child) => child.type === 'decorator'
    );
    if (decorators.length !== 1) continue;
    const decorator = decorators[0]!;
    const groupId = groveDecoratorId(decorator, bindings.nodeTreeNames);
    if (!groupId) continue;

    const startLine = decorator.startPosition.row + 1;
    const headerEnd = functionHeaderEnd(functionNode);
    groups.push({
      functionNode,
      node: {
        id: `grove-group:${filePath}:${groupId}:${startLine}`,
        kind: 'component',
        name: groupId,
        qualifiedName: `${filePath}::grove:${groupId}`,
        filePath,
        language: 'python',
        startLine,
        endLine: headerEnd.row + 1,
        startColumn: decorator.startPosition.column,
        endColumn: headerEnd.column,
        updatedAt,
      },
    });
  }

  const groupIdCounts = new Map<string, number>();
  const functionNameCounts = new Map<string, number>();
  for (const group of groups) {
    groupIdCounts.set(group.node.name, (groupIdCounts.get(group.node.name) ?? 0) + 1);
    const functionName = group.functionNode.childForFieldName('name')?.text;
    if (functionName) {
      functionNameCounts.set(functionName, (functionNameCounts.get(functionName) ?? 0) + 1);
    }
  }
  groups = groups.filter((group) => {
    const functionName = group.functionNode.childForFieldName('name')?.text;
    return (
      groupIdCounts.get(group.node.name) === 1 &&
      !!functionName &&
      functionNameCounts.get(functionName) === 1
    );
  });

  const nodes = groups.map((group) => group.node);
  const references: UnresolvedRef[] = [];
  const zoneFunctionsByGroup = new Map<string, Set<string>>();
  const zoneNamesByOwnerByGroup = new Map<string, Map<string, Set<string>>>();
  for (const group of groups) {
    const zoneFunctions = new Set<string>();
    const zoneNamesByOwner = new Map<string, Set<string>>();
    zoneFunctionsByGroup.set(group.node.id, zoneFunctions);
    zoneNamesByOwnerByGroup.set(group.node.id, zoneNamesByOwner);
    const functionName = group.functionNode.childForFieldName('name')?.text;
    if (!functionName) continue;
    references.push({
      fromNodeId: group.node.id,
      referenceName: functionReference(
        functionName,
        group.functionNode.startPosition.row + 1
      ),
      referenceKind: 'decorates',
      line: group.node.startLine,
      column: group.node.startColumn,
      filePath,
      language: 'python',
    });
    collectZones(
      filePath,
      group.node.name,
      group.functionNode,
      group.node,
      functionName,
      bindings,
      updatedAt,
      nodes,
      references,
      zoneFunctions,
      zoneNamesByOwner
    );
  }

  const groupByFunctionName = new Map<
    string,
    { node: Node; functionNode: SyntaxNode }
  >();
  for (const group of groups) {
    const functionName = group.functionNode.childForFieldName('name')?.text;
    if (functionName) groupByFunctionName.set(functionName, group);
  }

  for (const group of groups) {
    const zoneFunctions = zoneFunctionsByGroup.get(group.node.id) ?? new Set<string>();
    const zoneNamesByOwner =
      zoneNamesByOwnerByGroup.get(group.node.id) ?? new Map<string, Set<string>>();
    for (const { call, shadowedZoneNames } of groveScopeCalls(
      group.functionNode,
      zoneFunctions,
      zoneNamesByOwner
    )) {
      const callee = call.childForFieldName('function') ?? call.namedChild(0);
      if (callee?.type !== 'identifier') continue;
      if (shadowedZoneNames.has(callee.text)) continue;
      const targetGroup = groupByFunctionName.get(callee.text);
      if (!targetGroup) continue;
      references.push({
        fromNodeId: group.node.id,
        referenceName: componentReference(targetGroup.node.qualifiedName),
        referenceKind: 'calls',
        line: call.startPosition.row + 1,
        column: call.startPosition.column,
        filePath,
        language: 'python',
      });
    }
  }

  return { nodes, references };
  } finally {
    tree.delete();
  }
}

function resolveGroveReference(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (ref.language !== 'python') return null;

  if (ref.referenceKind === 'calls' || ref.referenceKind === 'contains') {
    const target = decodeReference<{ qualifiedName?: unknown }>(
      ref.referenceName,
      COMPONENT_REF_PREFIX
    );
    if (!target || typeof target.qualifiedName !== 'string') return null;
    const candidates = context
      .getNodesByQualifiedName(target.qualifiedName)
      .filter(
        (node) =>
          node.kind === 'component' &&
          node.language === 'python' &&
          node.filePath === ref.filePath
      );
    if (candidates.length !== 1) return null;
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: 1,
      resolvedBy: 'framework',
    };
  }

  if (ref.referenceKind === 'decorates') {
    const target = decodeReference<{
      qualifiedName?: unknown;
      startLine?: unknown;
    }>(ref.referenceName, FUNCTION_REF_PREFIX);
    if (
      !target ||
      typeof target.qualifiedName !== 'string' ||
      typeof target.startLine !== 'number'
    ) {
      return null;
    }
    const candidates = context
      .getNodesByQualifiedName(target.qualifiedName)
      .filter(
        (node) =>
          node.kind === 'function' &&
          node.language === 'python' &&
          node.filePath === ref.filePath &&
          node.startLine === target.startLine
      );
    if (candidates.length !== 1) return null;
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: 1,
      resolvedBy: 'framework',
    };
  }

  return null;
}

export const groveResolver: FrameworkResolver = {
  name: 'grove',
  languages: ['python'],
  detect: (context) => {
    for (const filePath of context.getAllFiles()) {
      if (!filePath.endsWith('.py')) continue;
      const content = context.readFile(filePath);
      if (content !== null && hasNodeTreeImport(content)) return true;
    }
    return false;
  },
  claimsReference: (name) =>
    name.startsWith(COMPONENT_REF_PREFIX) || name.startsWith(FUNCTION_REF_PREFIX),
  resolve: resolveGroveReference,
  extract: extractGrove,
};
