import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';

/**
 * Standalone extractors for Unity UI Toolkit markup: `.uxml` (UXML documents)
 * and `.uss` (style sheets).
 *
 * WHY THIS EXISTS. `root.Q<Button>("solo-button")` in C# addresses an element
 * declared in a `.uxml` file. Before this, those files were not indexed at all,
 * so the definition site was absent from the graph — and worse than absent:
 * `codegraph query "solo-button"` returned the C# *field* that holds the
 * element, which reads as a successful lookup while the real definition is
 * missing. Renaming either side fails silently at runtime and neither
 * `callers` nor `impact` could see the coupling.
 *
 * WHAT IS EMITTED (Phase 1 — see
 * `docs/design/unity-uxml-uss-indexing-plan.md`):
 *
 * - a `file` node for every UXML document and every USS sheet;
 * - a `component` node for every element carrying a `name=` attribute — the
 *   same kind the Unity scene/prefab extractor uses for GameObjects, so no
 *   `NodeKind` append is needed (the kind list is the native kernel's wire
 *   contract; not touching it keeps this feature free of shared-contract
 *   risk);
 * - `contains` edges down the *named* hierarchy: file → outermost named
 *   element, named ancestor → named descendant. Unnamed layout wrappers are
 *   transparent — they are skipped over, not represented;
 * - an `imports` `UnresolvedReference` per `<Style src="…">` / `<Template
 *   src="…">`, carrying the src resolved to a project-relative path
 *   (`unity-uxml:style:<path>`). The `unity-uxml` framework resolver binds it
 *   to that file's node.
 *
 * NODE-EXPLOSION BUDGET. A UXML tree is mostly layout; a HUD can be hundreds
 * of elements deep. **Only elements with a `name=` attribute get a node** —
 * precisely the ones `Q(name)` can address. Everything else is structure and
 * costs nothing. (Same discipline the scene extractor applies to decoration
 * subtrees.)
 *
 * NO TREE-SITTER GRAMMAR. UXML is a small, fixed, hand-authored schema and we
 * need four attributes out of it (`name`, `class`, `src`, `template`). A
 * targeted scanner — the shape `DfmExtractor` and `UnityAssetExtractor`
 * already use — ships no new wasm asset and cannot regress the kernel.
 *
 * EMIT-NOTHING POLICY. Content that is not a UXML document yields an empty
 * result (not even a file node); a `<Style>` whose src cannot be turned into a
 * project-relative path yields no ref; a parse failure drops everything for
 * the file. A missed edge beats a fabricated one.
 */

/**
 * `<Style src="…">` / `<Template src="…">` targets, as a project-relative path.
 * The `unity-uxml` resolver claims this prefix — keep the two in sync (the
 * `unity-yaml:` prefixes are duplicated between extractor and resolver the
 * same way).
 */
const STYLE_REF_PREFIX = 'unity-uxml:style:';

/**
 * Tags that are directives rather than elements. Their `name=` is a template
 * ALIAS, not an element name — `<ui:Template name="Row" src="Row.uxml"/>`
 * declares the alias that a later `<ui:Instance template="Row"/>` uses. Naming
 * a node after it would put a non-addressable name into the graph, which is
 * exactly the confidently-wrong answer this feature removes.
 */
const DIRECTIVE_TAGS = new Set(['Style', 'Template']);

/**
 * Hard cap on nodes from a single document. A hand-authored screen declares
 * tens of names; anything in the thousands is generated or malformed, and the
 * budget rule matters more than completeness there.
 */
const MAX_NAMED_ELEMENTS = 2000;

/** `<tag …>`, `</tag>`, or `<tag … />`, with `>` inside quoted values ignored. */
const TAG_RE = /<(\/?)([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

/** `key="value"` / `key='value'` inside a tag's attribute run. */
const ATTR_RE = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** A UXML document's root element, in any namespace prefix (`<ui:UXML …>`). */
const UXML_ROOT_RE = /<(?:[A-Za-z_][\w.-]*:)?UXML[\s/>]/;

interface OpenElement {
  tagName: string;
  /** The node this element produced, if it was named; null for layout wrappers. */
  node: Node | null;
}

/** Strip XML comments, preserving byte offsets and line breaks so every
 *  reported line stays correct. A UXML file's own comments routinely contain
 *  markup examples (`<Style>`), which would otherwise become phantom nodes. */
function blankComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Local name of a possibly namespace-prefixed tag: `ui:Button` → `Button`. */
function localName(tagName: string): string {
  const colon = tagName.lastIndexOf(':');
  return colon === -1 ? tagName : tagName.slice(colon + 1);
}

function parseAttributes(attrText: string): Map<string, string> {
  const out = new Map<string, string>();
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(attrText)) !== null) {
    const key = m[1]!;
    if (!out.has(key)) out.set(key, m[2] ?? m[3] ?? '');
  }
  return out;
}

function dirname(filePath: string): string {
  const idx = filePath.replace(/\\/g, '/').lastIndexOf('/');
  return idx === -1 ? '' : filePath.replace(/\\/g, '/').slice(0, idx);
}

/**
 * Turn a `<Style src>` value into a project-relative path.
 *
 * Unity accepts three forms: a path relative to the declaring document, an
 * absolute-from-project-root path, and a `project://database/…` URI (what UI
 * Builder writes). Anything else — an http URL, a GUID-only reference — is not
 * a path we can resolve, and yields nothing rather than a guess.
 */
export function resolveStyleSrc(src: string, uxmlPath: string): string | null {
  let raw = src.trim();
  if (!raw) return null;
  // UI Builder's URI form; the query string carries the guid, which we ignore
  // (the path is authoritative and the guid map would only re-derive it).
  const uri = raw.match(/^project:\/\/database\/(.+?)(?:\?.*)?$/);
  // The URI form is already rooted at the project — joining it to the
  // document's directory would bury it (`.../Menu/Assets/Game/UI/GameUI.uss`).
  let fromProjectRoot = false;
  if (uri) {
    raw = uri[1]!;
    fromProjectRoot = true;
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return null; // http(s):// etc.

  raw = raw.replace(/\\/g, '/');
  if (raw.startsWith('/')) {
    raw = raw.slice(1);
    fromProjectRoot = true;
  }
  const segments = (fromProjectRoot ? raw : `${dirname(uxmlPath)}/${raw}`).split('/');

  const stack: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      // Escaping the project root is not a path we can name — emit nothing.
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  return stack.length > 0 ? stack.join('/') : null;
}

abstract class UiToolkitExtractor {
  protected nodes: Node[] = [];
  protected edges: Edge[] = [];
  protected unresolvedReferences: UnresolvedReference[] = [];
  protected errors: ExtractionError[] = [];
  private lineStarts: number[] | null = null;

  constructor(
    protected filePath: string,
    protected source: string
  ) {}

  protected abstract get language(): 'uxml' | 'uss';
  protected abstract run(): void;
  /** Whether the content is the kind of document this extractor claims. */
  protected abstract accepts(): boolean;

  extract(): ExtractionResult {
    const startTime = Date.now();
    try {
      if (this.accepts()) this.run();
    } catch (error) {
      // A parse failure must never fabricate; drop everything for this file.
      this.nodes = [];
      this.edges = [];
      this.unresolvedReferences = [];
      this.errors.push({
        message: `Unity UI Toolkit extraction error: ${
          error instanceof Error ? error.message : String(error)
        }`,
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

  /** 1-based line for a source offset, via a single precomputed index. */
  protected lineAt(offset: number): number {
    if (!this.lineStarts) {
      const starts = [0];
      for (let i = 0; i < this.source.length; i++) {
        if (this.source.charCodeAt(i) === 10) starts.push(i + 1);
      }
      this.lineStarts = starts;
    }
    const starts = this.lineStarts;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  protected createFileNode(): Node {
    const lines = this.source.split(/\r?\n/);
    const fileNode: Node = {
      // Matches the id every other extractor (and the native kernel) gives a
      // file node — `file:<path>`. The framework resolver's C#-side references
      // are anchored to exactly this id, so it must not drift.
      id: `file:${this.filePath}`,
      kind: 'file',
      name: this.filePath.split(/[\\/]/).pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: this.language,
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(fileNode);
    return fileNode;
  }
}

export class UxmlExtractor extends UiToolkitExtractor {
  protected get language(): 'uxml' {
    return 'uxml';
  }

  protected accepts(): boolean {
    return UXML_ROOT_RE.test(this.source);
  }

  protected run(): void {
    const fileNode = this.createFileNode();
    const body = blankComments(this.source);
    const stack: OpenElement[] = [];
    let named = 0;

    TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TAG_RE.exec(body)) !== null) {
      const isClose = match[1] === '/';
      const tagName = match[2]!;
      const attrText = match[3] ?? '';
      const selfClosing = /\/\s*$/.test(attrText);

      if (isClose) {
        // Close the nearest matching open tag. A stray close tag (or one the
        // scanner cannot pair because the document is malformed) is ignored
        // rather than allowed to unwind unrelated elements.
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i]!.tagName !== tagName) continue;
          const node = stack[i]!.node;
          if (node) node.endLine = this.lineAt(match.index);
          stack.length = i;
          break;
        }
        continue;
      }

      const line = this.lineAt(match.index);
      const attrs = parseAttributes(attrText);
      const local = localName(tagName);

      if (DIRECTIVE_TAGS.has(local)) {
        // `name=` here is a template alias, never an addressable element.
        const src = attrs.get('src') ?? attrs.get('path');
        if (src) {
          const resolved = resolveStyleSrc(src, this.filePath);
          if (resolved) {
            this.unresolvedReferences.push({
              fromNodeId: fileNode.id,
              referenceName: `${STYLE_REF_PREFIX}${resolved}`,
              referenceKind: 'imports',
              line,
              column: 0,
            });
          }
        }
        if (!selfClosing) stack.push({ tagName, node: null });
        continue;
      }

      const name = attrs.get('name');
      let node: Node | null = null;
      if (name && name.trim() !== '' && named < MAX_NAMED_ELEMENTS) {
        named++;
        node = this.elementNode(name.trim(), tagName, attrs, line);
        this.nodes.push(node);
        // Parent is the nearest NAMED ancestor — unnamed layout wrappers are
        // transparent, so the hierarchy the graph shows is the one an author
        // can actually address.
        const parent = this.nearestNamed(stack) ?? fileNode;
        this.edges.push({ source: parent.id, target: node.id, kind: 'contains', line });
      }

      if (!selfClosing) stack.push({ tagName, node });
    }
  }

  private nearestNamed(stack: OpenElement[]): Node | null {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i]!.node) return stack[i]!.node;
    }
    return null;
  }

  private elementNode(name: string, tagName: string, attrs: Map<string, string>, line: number): Node {
    const classes = attrs.get('class');
    const text = attrs.get('text');
    const docParts: string[] = [];
    if (classes) docParts.push(`class=${classes}`);
    if (text) docParts.push(`text=${JSON.stringify(text)}`);
    return {
      // Line-qualified so two same-named elements in one document stay two
      // distinct nodes (the resolver then sees the ambiguity and emits
      // nothing, which is the intended outcome).
      id: `component:uxml:${this.filePath}:${line}:${name}`,
      kind: 'component',
      name,
      qualifiedName: `${this.filePath}#${name}`,
      filePath: this.filePath,
      language: 'uxml',
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: 0,
      signature: tagName,
      docstring: docParts.length > 0 ? docParts.join(' ') : undefined,
      updatedAt: Date.now(),
    };
  }
}

/**
 * USS style sheets. Phase 1 indexes the FILE only, so a `<Style src="…">`
 * import has something to point at and the sheet shows up in `files`/`status`.
 * Selector-rule extraction is Phase 2 — it is the only part of this feature
 * that would need a `NodeKind` append, and it answers a different question
 * ("what styles this?"), so it is judged on its own evidence.
 */
export class UssExtractor extends UiToolkitExtractor {
  protected get language(): 'uss' {
    return 'uss';
  }

  protected accepts(): boolean {
    return true;
  }

  protected run(): void {
    this.createFileNode();
  }
}
