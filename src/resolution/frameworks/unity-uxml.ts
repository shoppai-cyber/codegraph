import { Node } from '../../types';
import { FrameworkResolver, FrameworkExtractionResult, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';

/**
 * Unity UI Toolkit — binds C# string literals to the UXML elements they name,
 * and `<Style src="…">` imports to the style sheet they pull in.
 *
 * ## Why literals, and not `Q<T>("…")` call sites
 *
 * The obvious rule — "a string inside `root.Q<T>(…)` names an element" — is
 * the one that silently fails. Measured on the field project: of 33 element
 * names reached from C#, **two are never written at a `Q<T>("literal")` site
 * at all**. They pass through a wrapper:
 *
 * ```csharp
 * public static T Region<T>(string name, Object context = null) where T : VisualElement
 *     => Root.Q<T>(name);                       // GameHudPanel.cs
 * ...
 * label = GameHudPanel.Region<Label>("interaction-prompt", this);   // the literal lives HERE
 * ```
 *
 * A scanner keyed on the `Q` shape gets 31 of 33 and says nothing about the
 * other two. That wrapper is not an oddity — it is what a shared panel grows
 * the moment it has a second consumer, so the ratio gets *worse* as a project
 * matures. Chasing wrapper signatures is unbounded.
 *
 * So the match is INVERTED: any string literal in C# is a candidate, and the
 * DECLARED UXML NAME SET decides. That set is small, closed, and already in
 * the graph by resolve time. The failure mode flips from silent-miss to
 * visible-noise — a spurious edge from a doc comment that happens to quote an
 * element name is harmless and self-evident, while a missing wrapper call is
 * invisible. Comments are deliberately NOT stripped for the same reason.
 *
 * ## Emit nothing on ambiguity — the load-bearing rule
 *
 * Name-only resolution is only correct because a name that is NOT unique
 * across the project resolves to NOTHING. On the field project all 39
 * declared names happen to be unique, but that is a naming *convention* (some
 * panels prefix, `Settings.uxml` uses bare `apply`/`cancel`); nothing enforces
 * it and UXML has no namespace. Without this rule the first collision starts
 * manufacturing confident wrong edges — the exact failure class this feature
 * exists to remove. It would make the tool worse than not having it.
 *
 * Two elements sharing a name (in one document or across documents) therefore
 * produce no edge at all, and that is the intended outcome, not a gap. The
 * scoping alternative — walking `PanelRenderer` → `VisualTreeAsset` GUIDs to
 * bind a query to the one document its panel loaded — buys zero additional
 * edges today and stays optional as long as ambiguity emits nothing.
 */

/** `<Style src="…">` targets, project-relative. Written by `UxmlExtractor`. */
const STYLE_REF_PREFIX = 'unity-uxml:style:';

/** A C# string literal that might name a UXML element. */
const ELEMENT_REF_PREFIX = 'unity-uxml:element:';

/**
 * Shape a string literal must have to be a candidate element name. Not a
 * precision filter — the declared-name set is what decides. This only keeps
 * obvious non-names (paths, sentences, format strings, log messages) from
 * becoming references that would be constructed and dropped by the million on
 * a large repo.
 *
 * Deliberately does NOT require kebab-case: `Settings.uxml` names two of its
 * elements `apply` and `cancel`, and keying on the hyphen convention would
 * reintroduce exactly the structural assumption this resolver refuses to make.
 */
const CANDIDATE_LITERAL_RE = /"([A-Za-z_][A-Za-z0-9_-]{1,63})"/g;

/**
 * Cap on distinct candidate literals taken from one C# file. A generated or
 * table-driven file can carry thousands; past this point the file is not the
 * kind of code that queries a UI element by name.
 */
const MAX_CANDIDATES_PER_FILE = 400;

function resolved(ref: UnresolvedRef, target: Node): ResolvedRef {
  return { original: ref, targetNodeId: target.id, confidence: 1, resolvedBy: 'framework' };
}

/**
 * The one UXML element declared under `name`, or null when zero or more than
 * one exists. The `> 1` branch is the emit-nothing-on-ambiguity rule; it is
 * the reason name-only resolution is safe, so it must never become
 * "return the first".
 */
function uniqueElement(name: string, context: ResolutionContext): Node | null {
  const matches = context
    .getNodesByName(name)
    .filter((n) => n.kind === 'component' && n.language === 'uxml');
  return matches.length === 1 ? matches[0]! : null;
}

function resolveStyleImport(ref: UnresolvedRef, path: string, context: ResolutionContext): ResolvedRef | null {
  const fileNode = context.getNodesInFile(path).find((n) => n.kind === 'file');
  return fileNode ? resolved(ref, fileNode) : null;
}

export const unityUxmlResolver: FrameworkResolver = {
  name: 'unity-uxml',
  languages: ['csharp', 'uxml'],

  /**
   * Project-level gate, called once at startup: a project with no `.uxml` file
   * never runs the C# literal scan or any of this resolver's work.
   */
  detect(context: ResolutionContext): boolean {
    return context.getAllFiles().some((f) => f.endsWith('.uxml'));
  },

  claimsReference(name: string): boolean {
    return name.startsWith(ELEMENT_REF_PREFIX) || name.startsWith(STYLE_REF_PREFIX);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const name = ref.referenceName;
    if (name.startsWith(STYLE_REF_PREFIX)) {
      if (ref.language !== 'uxml') return null;
      return resolveStyleImport(ref, name.slice(STYLE_REF_PREFIX.length), context);
    }
    if (name.startsWith(ELEMENT_REF_PREFIX)) {
      if (ref.language !== 'csharp') return null;
      const element = uniqueElement(name.slice(ELEMENT_REF_PREFIX.length), context);
      return element ? resolved(ref, element) : null;
    }
    return null;
  },

  /**
   * Emit one candidate reference per distinct string literal in a C# file,
   * anchored to the file's own node.
   *
   * No nodes are created here on purpose. A `route`-style node per candidate
   * would be the richer output (it carries its own line), but candidates are
   * emitted before the declared-name set is knowable, so the overwhelming
   * majority resolve to nothing — and unlike a reference, a node persists
   * whether or not it resolved. That trade is node explosion for line
   * precision, and the budget rule wins. The edge still carries the literal's
   * line, so the call site is not lost.
   */
  extract(filePath: string, content: string): FrameworkExtractionResult {
    const result: FrameworkExtractionResult = { nodes: [], references: [] };
    if (!filePath.endsWith('.cs')) return result;

    const seen = new Set<string>();
    // Line index built lazily and shared by every candidate in the file.
    let lineStarts: number[] | null = null;
    const lineAt = (offset: number): number => {
      if (!lineStarts) {
        const starts = [0];
        for (let i = 0; i < content.length; i++) {
          if (content.charCodeAt(i) === 10) starts.push(i + 1);
        }
        lineStarts = starts;
      }
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid]! <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };

    CANDIDATE_LITERAL_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CANDIDATE_LITERAL_RE.exec(content)) !== null) {
      const literal = match[1]!;
      if (seen.has(literal)) continue;
      if (seen.size >= MAX_CANDIDATES_PER_FILE) break;
      seen.add(literal);
      result.references.push({
        fromNodeId: `file:${filePath}`,
        referenceName: `${ELEMENT_REF_PREFIX}${literal}`,
        referenceKind: 'references',
        line: lineAt(match.index),
        column: 0,
        filePath,
        language: 'csharp',
      });
    }
    return result;
  },
};
