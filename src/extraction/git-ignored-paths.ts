/**
 * Exact matching for the ignored-untracked paths git lists, used by
 * `buildScopeIgnore` (fork-only; see FORK-MAINTENANCE.md).
 *
 * Upstream adds every `git ls-files -o -i --exclude-standard --directory` entry
 * to the `ignore` matcher as its own pattern (#1728). `ignore` tests a path
 * against every pattern, so a repository that keeps many ignored files beside
 * tracked ones pays O(entries) per path: 18,016 entries in one Blender repo
 * turned its 30,473-file scan into 250 s of main-thread work, and the liveness
 * watchdog (#850) killed `index` and the MCP server's startup sync.
 *
 * An entry that has a slash before its trailing one and is plain printable
 * ASCII with no `ignore` syntax compiles to an anchored literal rule
 * (`^a\/b\/$`, case-insensitive by default). It matches when the path, or one of
 * the parent directories `ignore` checks first, equals the entry. Those entries
 * go into a Set; every other entry stays a pattern, so every path gets the same
 * answer as before.
 */
import ignore, { Ignore } from 'ignore';

/** Anything that makes `ignore` read an entry as more than a literal path. */
const NOT_LITERAL = /[^\x20-\x7e]|[*?[\]\\]|^[!#/]/;

/**
 * `ignore`'s default rules are case-insensitive RegExps. For ASCII that folds
 * a-z to A-Z, and no non-ASCII character folds to ASCII, so folding only a-z
 * keeps a path with other characters from ever equalling an ASCII entry.
 */
function foldCase(s: string): string {
  return s.replace(/[a-z]+/g, (m) => m.toUpperCase());
}

/**
 * `rootMatcher` (built with `ignore()`'s default case-insensitive matching) plus
 * the git-listed `entries`, each ending in `/`.
 */
export function withGitIgnoredPaths(rootMatcher: Ignore, entries: Iterable<string>): Pick<Ignore, 'ignores'> {
  const all = [...entries];
  // A `!` entry is a negation that can undo an earlier entry: keep upstream's
  // ordered patterns for the whole list.
  if (all.some((e) => e.startsWith('!'))) {
    for (const e of all) rootMatcher.add(e);
    return rootMatcher;
  }
  const literal: string[] = [];
  const folded = new Set<string>();
  for (const e of all) {
    if (e.indexOf('/') < e.length - 1 && !NOT_LITERAL.test(e)) {
      literal.push(e);
      folded.add(foldCase(e));
    } else {
      rootMatcher.add(e);
    }
  }
  if (folded.size === 0) return rootMatcher;
  let withBackslash: Ignore | null = null;
  return {
    ignores(rel: string): boolean {
      if (rootMatcher.ignores(rel)) return true;
      // `ignore` rewrites `\` to `/` on Windows before matching; let it decide those.
      if (rel.includes('\\')) return (withBackslash ??= ignore().add(literal)).ignores(rel);
      const f = foldCase(rel);
      if (folded.has(f)) return true;
      // The parent directories `ignore` tests, built as it builds them (empty segments dropped).
      const parts = f.split('/').filter(Boolean);
      parts.pop();
      let dir = '';
      for (const part of parts) {
        dir += `${part}/`;
        if (folded.has(dir)) return true;
      }
      return false;
    },
  };
}
