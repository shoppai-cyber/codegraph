/**
 * Unity UI Toolkit (UXML/USS) indexing — Phase 1.
 *
 * Two things are load-bearing here and are pinned deliberately:
 *
 * 1. EMIT NOTHING ON AMBIGUITY. Name-only resolution is safe *only* because a
 *    name declared more than once resolves to nothing. Field measurement found
 *    all 39 declared names unique — but that is a naming CONVENTION (some
 *    panels prefix, `Settings.uxml` uses bare `apply`/`cancel`), not a
 *    namespace. The first collision under a "return the first match" rule
 *    starts manufacturing confident wrong edges, which is the exact failure
 *    this feature exists to remove.
 *
 * 2. THE MATCH IS INVERTED — declared-name set, not `Q<T>("literal")` sites.
 *    Two of the 33 names reached from C# in the field project are never
 *    written at a Q site at all; they go through a `Region<T>(string name)`
 *    wrapper. A scanner keyed on the Q shape silently gets 31 of 33, and the
 *    ratio worsens as a panel grows consumers.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UxmlExtractor, UssExtractor, resolveStyleSrc } from '../src/extraction/uxml-extractor';
import { unityUxmlResolver } from '../src/resolution/frameworks/unity-uxml';
import { getFrameworkResolver } from '../src/resolution/frameworks';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import type { ExtractionResult, Node } from '../src/types';
import { CodeGraph } from '../src';

const MENU = 'Assets/Game/Presentation/Menu/Menu.uxml';

function extract(source: string, filePath = MENU): ExtractionResult {
  return new UxmlExtractor(filePath, source).extract();
}

function componentNames(result: ExtractionResult): string[] {
  return result.nodes.filter((n) => n.kind === 'component').map((n) => n.name).sort();
}

function idToName(result: ExtractionResult): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of result.nodes) m.set(n.id, n.name);
  return m;
}

function edgePairs(result: ExtractionResult): string[] {
  const names = idToName(result);
  return result.edges
    .map((e) => `${e.kind}:${names.get(e.source) ?? e.source}->${names.get(e.target) ?? e.target}`)
    .sort();
}

function refNames(result: ExtractionResult): string[] {
  return result.unresolvedReferences.map((r) => `${r.referenceKind}:${r.referenceName}`).sort();
}

function element(name: string, filePath = MENU, line = 1): Node {
  return {
    id: `component:uxml:${filePath}:${line}:${name}`,
    kind: 'component',
    name,
    qualifiedName: `${filePath}#${name}`,
    filePath,
    language: 'uxml',
    startLine: line,
    endLine: line,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
  };
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
  } as ResolutionContext;
}

function elementRef(name: string, language: 'csharp' | 'uxml' = 'csharp'): UnresolvedRef {
  return {
    fromNodeId: 'file:Assets/Game/Presentation/Menu/MenuScreen.cs',
    referenceName: `unity-uxml:element:${name}`,
    referenceKind: 'references',
    line: 66,
    column: 0,
    filePath: 'Assets/Game/Presentation/Menu/MenuScreen.cs',
    language,
  };
}

// A structurally-real UXML document, trimmed from the field project. Note the
// comment: it quotes `<Style>` markup, which a scanner that does not blank
// comments would turn into a phantom import.
const DOC = `<ui:UXML xmlns:ui="UnityEngine.UIElements" editor-extension-mode="False">
    <!-- Namespace-prefixed deliberately: a bare <Style> imports fine at
         runtime but UI Builder refuses to OPEN the file. -->
    <ui:Style src="../UI/GameUI.uss" />
    <ui:Style src="Menu.uss" />
    <ui:VisualElement name="menu-scrim" class="scrim">
        <ui:VisualElement name="menu-panel" class="panel">
            <ui:Label name="menu-title" text="Session" class="panel__title" />
            <ui:VisualElement name="offline-group">
                <ui:VisualElement class="menu-row">
                    <ui:Button name="solo-button" text="Play Solo" class="button" />
                </ui:VisualElement>
            </ui:VisualElement>
        </ui:VisualElement>
    </ui:VisualElement>
</ui:UXML>
`;

describe('UxmlExtractor', () => {
  it('emits a node only for elements carrying a name= attribute', () => {
    const result = extract(DOC);
    // The `class="menu-row"` wrapper and `class="scrim"`-only elements are
    // layout: addressable by nothing, so they cost nothing. This IS the
    // node-explosion budget.
    expect(componentNames(result)).toEqual([
      'menu-panel',
      'menu-scrim',
      'menu-title',
      'offline-group',
      'solo-button',
    ]);
    expect(result.nodes.filter((n) => n.kind === 'file')).toHaveLength(1);
  });

  it('nests contains edges through UNNAMED wrappers to the nearest named ancestor', () => {
    // solo-button sits inside an unnamed `menu-row`; the graph must show the
    // hierarchy an author can actually address, not the raw markup tree.
    expect(edgePairs(extract(DOC))).toEqual([
      'contains:Menu.uxml->menu-scrim',
      'contains:menu-panel->menu-title',
      'contains:menu-scrim->menu-panel',
      'contains:menu-panel->offline-group',
      'contains:offline-group->solo-button',
    ].sort());
  });

  it('resolves <Style src> against the document, including ../ traversal', () => {
    expect(refNames(extract(DOC))).toEqual([
      'imports:unity-uxml:style:Assets/Game/Presentation/Menu/Menu.uss',
      'imports:unity-uxml:style:Assets/Game/Presentation/UI/GameUI.uss',
    ]);
  });

  it('ignores markup quoted inside an XML comment', () => {
    // The `<Style>` inside DOC's comment must not become a third import, and a
    // commented-out element must not become a node.
    const withCommentedElement = DOC.replace(
      '<ui:Style src="Menu.uss" />',
      '<ui:Style src="Menu.uss" />\n    <!-- <ui:Button name="ghost-button" /> -->'
    );
    const result = extract(withCommentedElement);
    expect(componentNames(result)).not.toContain('ghost-button');
    expect(refNames(result)).toHaveLength(2);
  });

  it('treats <ui:Template name=…> as a template ALIAS, not an element', () => {
    const doc = `<ui:UXML xmlns:ui="UnityEngine.UIElements">
    <ui:Template name="Row" src="Row.uxml" />
    <ui:Instance template="Row" name="first-row" />
</ui:UXML>`;
    const result = extract(doc);
    // `Row` is not addressable by Q(); `first-row` is.
    expect(componentNames(result)).toEqual(['first-row']);
    expect(refNames(result)).toEqual(['imports:unity-uxml:style:Assets/Game/Presentation/Menu/Row.uxml']);
  });

  it('emits NOTHING — not even a file node — for non-UXML content', () => {
    const result = extract('<?xml version="1.0"?><configuration><appSettings/></configuration>');
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
    expect(result.unresolvedReferences).toHaveLength(0);
  });

  it('spans a container element from its open tag to its close tag', () => {
    const scrim = extract(DOC).nodes.find((n) => n.name === 'menu-scrim')!;
    expect(scrim.startLine).toBe(6);
    expect(scrim.endLine).toBeGreaterThan(scrim.startLine);
    const solo = extract(DOC).nodes.find((n) => n.name === 'solo-button')!;
    expect(solo.startLine).toBe(11);
  });

  it('keeps two same-named elements in one document as two distinct nodes', () => {
    // Both declarations are real; the resolver is what refuses to pick one.
    const doc = `<ui:UXML xmlns:ui="UnityEngine.UIElements">
    <ui:Button name="apply" />
    <ui:Button name="apply" />
</ui:UXML>`;
    const nodes = extract(doc).nodes.filter((n) => n.kind === 'component');
    expect(nodes).toHaveLength(2);
    expect(new Set(nodes.map((n) => n.id)).size).toBe(2);
  });

  it('is deterministic across CRLF and LF line endings', () => {
    const lf = extract(DOC);
    const crlf = extract(DOC.replace(/\n/g, '\r\n'));
    const project = (r: ExtractionResult) =>
      r.nodes.map((n) => `${n.id}|${n.startLine}`).sort();
    expect(project(crlf)).toEqual(project(lf));
  });
});

describe('UssExtractor', () => {
  it('indexes a style sheet as a file node only (Phase 1)', () => {
    const result = new UssExtractor('Assets/Game/Presentation/Menu/Menu.uss', '.button { color: red; }').extract();
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.kind).toBe('file');
    expect(result.nodes[0]!.language).toBe('uss');
    expect(result.edges).toHaveLength(0);
  });
});

describe('resolveStyleSrc', () => {
  const uxml = 'Assets/Game/Presentation/Menu/Menu.uxml';

  it('resolves document-relative paths', () => {
    expect(resolveStyleSrc('Menu.uss', uxml)).toBe('Assets/Game/Presentation/Menu/Menu.uss');
    expect(resolveStyleSrc('../UI/GameUI.uss', uxml)).toBe('Assets/Game/Presentation/UI/GameUI.uss');
    expect(resolveStyleSrc('./Menu.uss', uxml)).toBe('Assets/Game/Presentation/Menu/Menu.uss');
  });

  it('resolves the project:// URI form UI Builder writes, guid query included', () => {
    expect(resolveStyleSrc('project://database/Assets/Game/UI/GameUI.uss?fileID=7433', uxml))
      .toBe('Assets/Game/UI/GameUI.uss');
  });

  it('resolves a project-root-absolute path', () => {
    expect(resolveStyleSrc('/Assets/Game/UI/GameUI.uss', uxml)).toBe('Assets/Game/UI/GameUI.uss');
  });

  it('emits nothing for what it cannot turn into a project path', () => {
    expect(resolveStyleSrc('https://example.com/x.uss', uxml)).toBeNull();
    expect(resolveStyleSrc('../../../../../etc/x.uss', uxml)).toBeNull();
    expect(resolveStyleSrc('   ', uxml)).toBeNull();
  });
});

describe('unityUxmlResolver — registration and gating', () => {
  it('is registered in the framework resolver registry under "unity-uxml"', () => {
    expect(getFrameworkResolver('unity-uxml')).toBe(unityUxmlResolver);
  });

  it('detects only a project that actually has a .uxml file', () => {
    expect(unityUxmlResolver.detect(makeContext({ getAllFiles: () => ['Assets/A.cs', MENU] }))).toBe(true);
    // A Unity project with no UI Toolkit markup never runs the C# literal scan.
    expect(unityUxmlResolver.detect(makeContext({ getAllFiles: () => ['Assets/A.cs', 'Assets/S.unity'] }))).toBe(false);
  });

  it('claims only its own two prefixes', () => {
    expect(unityUxmlResolver.claimsReference!('unity-uxml:element:solo-button')).toBe(true);
    expect(unityUxmlResolver.claimsReference!('unity-uxml:style:Assets/A.uss')).toBe(true);
    // A bare name must never be claimed — it would put string literals into
    // generic name matching and fabricate edges to same-named C# symbols.
    expect(unityUxmlResolver.claimsReference!('solo-button')).toBe(false);
    expect(unityUxmlResolver.claimsReference!('unity-yaml:script:abc')).toBe(false);
  });
});

describe('unityUxmlResolver.resolve — element names', () => {
  it('resolves a name declared exactly once', () => {
    const target = element('solo-button');
    const ctx = makeContext({ getNodesByName: (n) => (n === 'solo-button' ? [target] : []) });
    expect(unityUxmlResolver.resolve(elementRef('solo-button'), ctx)?.targetNodeId).toBe(target.id);
  });

  it('EMITS NOTHING when the same name is declared in two .uxml files', () => {
    // The load-bearing rule. Uniqueness in the field project is convention,
    // not structure — nothing stops a second screen from declaring `apply`.
    // Picking either one here would be a confident wrong answer.
    const ctx = makeContext({
      getNodesByName: () => [
        element('apply', 'Assets/Game/Presentation/Settings/Settings.uxml', 60),
        element('apply', 'Assets/Game/Presentation/Profile/Profile.uxml', 22),
      ],
    });
    expect(unityUxmlResolver.resolve(elementRef('apply'), ctx)).toBeNull();
  });

  it('EMITS NOTHING when the same name is declared twice in ONE .uxml file', () => {
    const ctx = makeContext({
      getNodesByName: () => [element('apply', MENU, 12), element('apply', MENU, 19)],
    });
    expect(unityUxmlResolver.resolve(elementRef('apply'), ctx)).toBeNull();
  });

  it('emits nothing for a literal that names no element', () => {
    expect(unityUxmlResolver.resolve(elementRef('Horizontal'), makeContext())).toBeNull();
  });

  it('never binds to a same-named node from another language', () => {
    // A scene GameObject named `solo-button` is a `component` node too — the
    // language filter is what keeps them apart.
    const sceneObject = { ...element('solo-button'), language: 'unity_yaml' as const, id: 'component:scene' };
    const ctx = makeContext({ getNodesByName: () => [sceneObject] });
    expect(unityUxmlResolver.resolve(elementRef('solo-button'), ctx)).toBeNull();
  });

  it('ignores an element ref that did not come from C#', () => {
    const ctx = makeContext({ getNodesByName: () => [element('solo-button')] });
    expect(unityUxmlResolver.resolve(elementRef('solo-button', 'uxml'), ctx)).toBeNull();
  });
});

describe('unityUxmlResolver.resolve — style imports', () => {
  const styleRef: UnresolvedRef = {
    fromNodeId: `file:${MENU}`,
    referenceName: 'unity-uxml:style:Assets/Game/Presentation/Menu/Menu.uss',
    referenceKind: 'imports',
    line: 5,
    column: 0,
    filePath: MENU,
    language: 'uxml',
  };

  it('binds an import to the style sheet file node', () => {
    const fileNode: Node = {
      id: 'file:Assets/Game/Presentation/Menu/Menu.uss',
      kind: 'file',
      name: 'Menu.uss',
      qualifiedName: 'Assets/Game/Presentation/Menu/Menu.uss',
      filePath: 'Assets/Game/Presentation/Menu/Menu.uss',
      language: 'uss',
      startLine: 1,
      endLine: 10,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
    const ctx = makeContext({ getNodesInFile: (p) => (p === fileNode.filePath ? [fileNode] : []) });
    expect(unityUxmlResolver.resolve(styleRef, ctx)?.targetNodeId).toBe(fileNode.id);
  });

  it('emits nothing when the sheet is not indexed (a package stylesheet)', () => {
    expect(unityUxmlResolver.resolve(styleRef, makeContext())).toBeNull();
  });
});

describe('unityUxmlResolver.extract — the inverted match', () => {
  const CS = 'Assets/Game/Presentation/Menu/MenuScreen.cs';

  function literals(source: string, filePath = CS): string[] {
    return unityUxmlResolver
      .extract!(filePath, source)
      .references.map((r) => r.referenceName.replace('unity-uxml:element:', ''))
      .sort();
  }

  it('picks up a literal at a Q<T>() site AND one only reachable through a wrapper', () => {
    // The whole reason the match is inverted. A Q-shape scanner sees
    // `solo-button` and misses `interaction-prompt` entirely.
    const source = `
      soloButton = root.Q<Button>("solo-button");
      label = GameHudPanel.Region<Label>("interaction-prompt", this);
    `;
    expect(literals(source)).toEqual(['interaction-prompt', 'solo-button']);
  });

  it('anchors every reference to the C# file node with the literal\'s line', () => {
    const refs = unityUxmlResolver.extract!(CS, '\n\nvar x = root.Q<Button>("solo-button");\n').references;
    expect(refs).toHaveLength(1);
    expect(refs[0]!.fromNodeId).toBe(`file:${CS}`);
    expect(refs[0]!.line).toBe(3);
    expect(refs[0]!.referenceKind).toBe('references');
  });

  it('creates no NODES — candidates outnumber real names by orders of magnitude', () => {
    expect(unityUxmlResolver.extract!(CS, 'var a = "one"; var b = "two";').nodes).toHaveLength(0);
  });

  it('accepts doc-comment mentions as the noise it prefers over silent misses', () => {
    const source = '/// Sets the text of <c>"join-hint"</c> under Steam.\nvoid F() { }';
    expect(literals(source)).toEqual(['join-hint']);
  });

  it('skips literals that cannot be element names, and dedupes the rest', () => {
    const source = `
      Debug.Log("Assets/Game/Menu.uxml");   // path — has dots and slashes
      Debug.Log("player has no team");      // sentence — has spaces
      Debug.Log($"team {i}");               // interpolation braces
      var a = root.Q<Button>("solo-button");
      var b = root.Q<Button>("solo-button"); // same literal twice
    `;
    expect(literals(source)).toEqual(['solo-button']);
  });

  it('does nothing for a non-C# file', () => {
    expect(unityUxmlResolver.extract!(MENU, '<ui:Button name="solo-button" />').references).toHaveLength(0);
  });
});

describe('UXML end-to-end through a real index', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-uxml-e2e-'));
    const write = (rel: string, content: string) => {
      const abs = path.join(tempDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    };

    write('Assets/Game/Presentation/Menu/Menu.uxml', DOC);
    write('Assets/Game/Presentation/Menu/Menu.uss', '.button { color: red; }\n');
    write('Assets/Game/Presentation/UI/GameUI.uss', '.panel { flex-grow: 1; }\n');
    // Reached at a Q site.
    write(
      'Assets/Game/Presentation/Menu/MenuScreen.cs',
      'using UnityEngine.UIElements;\npublic class MenuScreen {\n  Button soloButton;\n  void Bind(VisualElement root) {\n    soloButton = root.Q<Button>("solo-button");\n  }\n}\n'
    );
    // Reached ONLY through a wrapper — the case a Q-site scanner misses.
    write(
      'Assets/Game/Presentation/Menu/MenuTitleHud.cs',
      'using UnityEngine.UIElements;\npublic class MenuTitleHud {\n  void Bind() {\n    var t = Panel.Region<Label>("menu-title", this);\n  }\n}\n'
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
  });

  afterAll(() => {
    cg?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('indexes the UXML document and its named elements', () => {
    const nodes = cg.getNodesInFile('Assets/Game/Presentation/Menu/Menu.uxml');
    expect(nodes.find((n) => n.kind === 'file')?.language).toBe('uxml');
    expect(nodes.filter((n) => n.kind === 'component').map((n) => n.name).sort()).toEqual([
      'menu-panel',
      'menu-scrim',
      'menu-title',
      'offline-group',
      'solo-button',
    ]);
  });

  it('makes the UXML element the answer to a query for its name', () => {
    // The reported symptom: this used to return the C# field and read as a
    // successful lookup while the real definition site was absent.
    const hit = cg
      .searchNodes('solo-button')
      .find((r) => r.node.kind === 'component' && r.node.language === 'uxml');
    expect(hit?.node.filePath).toBe('Assets/Game/Presentation/Menu/Menu.uxml');
  });

  it('connects BOTH the Q-site file and the wrapper-site file to their elements', () => {
    const uxmlNodes = cg.getNodesInFile('Assets/Game/Presentation/Menu/Menu.uxml');
    const solo = uxmlNodes.find((n) => n.name === 'solo-button')!;
    const title = uxmlNodes.find((n) => n.name === 'menu-title')!;

    const callerFiles = (nodeId: string) =>
      cg.getCallers(nodeId).map((c) => c.node.filePath).sort();

    expect(callerFiles(solo.id)).toContain('Assets/Game/Presentation/Menu/MenuScreen.cs');
    expect(callerFiles(title.id)).toContain('Assets/Game/Presentation/Menu/MenuTitleHud.cs');
  });

  it('links the document to both style sheets it imports', () => {
    const fileNode = cg
      .getNodesInFile('Assets/Game/Presentation/Menu/Menu.uxml')
      .find((n) => n.kind === 'file')!;
    const imported = cg
      .getCallees(fileNode.id)
      .filter((c) => c.edge.kind === 'imports')
      .map((c) => c.node.filePath)
      .sort();
    expect(imported).toEqual([
      'Assets/Game/Presentation/Menu/Menu.uss',
      'Assets/Game/Presentation/UI/GameUI.uss',
    ]);
  });
});
