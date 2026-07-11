# Extraction and relationship resolution

## What this domain does

CodeGraph’s graph is useful only if source syntax becomes stable symbols and relationships can cross file, language, and framework boundaries. Extraction and resolution are intentionally separate:

- **Extraction** records files, nodes, direct syntax-derived edges, and unresolved references.
- **Resolution** runs after indexing has a project-wide view and converts resolvable references into graph edges.
- **Framework and callback synthesis** adds selected relationships that ordinary syntax cannot prove directly. These relationships should carry provenance/metadata so consumers do not mistake them for plain AST edges.

The current product supports a broad language set through tree-sitter grammars and custom extractors. The authoritative supported-language behavior is code in [`src/extraction/grammars.ts`](../../src/extraction/grammars.ts) and the extraction tests—not a hand-maintained list in this wiki.

## Extraction pipeline

[`src/extraction/index.ts`](../../src/extraction/index.ts) owns scanning, scope decisions, worker scheduling, parsing, and writes. [`tree-sitter.ts`](../../src/extraction/tree-sitter.ts) is the large shared syntax extractor; specialized modules cover formats or language structures that need additional handling, including Vue/Svelte/Astro/Razor/Liquid templates, CFML, MyBatis, Delphi forms, and Unity YAML assets.

Important operational behavior:

- Source discovery honors language recognition, `.gitignore`, built-in noise exclusions, and project config.
- A 1 MB file-size limit avoids spending the WASM parser budget on generated/minified/vendor blobs; generated detection supplements directory exclusions.
- Parsing runs in worker threads. A per-file timeout prevents one broken parser/WASM execution from freezing the index; workers are recycled because WASM linear memory does not shrink.
- Parsing and reconciliation cooperatively yield in long operations so daemon/MCP watchdogs can distinguish slow progress from a wedge.
- Extraction progress phases are `scanning`, `parsing`, `storing`, and `resolving`.

### Scope is a product-quality boundary

`DEFAULT_IGNORE_DIRS` in `src/extraction/index.ts` deliberately excludes dependencies, build output, caches, test coverage, and common vendor directories so the graph describes a project’s code rather than noise. Generic directories likely to hold first-party source are deliberately not globally excluded. Android resource subtrees get special treatment because huge non-code XML trees otherwise dominate scanning without yielding symbols.

[`src/project-config.ts`](../../src/project-config.ts) reads the optional committed `codegraph.json`:

```json
{
  "extensions": { ".dota_lua": "lua" },
  "includeIgnored": ["embedded-repo/"],
  "exclude": ["static/vendor/"]
}
```

Custom extensions overlay built-ins; `includeIgnored` explicitly opts ignored nested repositories back in; `exclude` removes paths even if tracked. Invalid/missing config degrades to defaults with warnings rather than breaking an index. Any scope feature must be implemented consistently in full scan, incremental reconcile, and watching.

## Resolution strategies

[`src/resolution/index.ts`](../../src/resolution/index.ts) coordinates multiple conservative strategies:

- name and qualified-name matching;
- import, re-export, include, module, workspace-package, and configured path-alias resolution;
- receiver/type inference for calls where a local, parameter, property, or initializer establishes a type;
- inheritance/conformance and deferred chained-call passes;
- callback and function-reference synthesis; and
- framework-specific resolvers selected by detected project/framework signals.

The resolver explicitly filters standard-library/built-in names and bounds caches (`CODEGRAPH_RESOLVER_CACHE_SIZE` can tune the shared cache limit). It performs cooperative yielding to protect the process liveness contract during dense, expensive reference batches.

Resolution must prefer an absent edge over a confidently wrong edge. This is visible in recent functionality such as Unity asset linking, Terraform module/provider relationships, Erlang behavior dispatch, and typed receiver inference: targets that are dynamic, ambiguous, external to the project, or insufficiently corroborated remain visible boundaries instead of invented links. The product changelog is useful context for these precision gates: [`CHANGELOG.md`](../../CHANGELOG.md).

## Framework and non-source assets

Framework resolvers live in [`src/resolution/frameworks/`](../../src/resolution/frameworks/). The directory includes application/framework behavior for React, Vue, Svelte, Astro, NestJS, Express, Laravel, Drupal, Java/Spring-like systems, Go, Rust/Cargo, React Native/Expo, Unity, Blender, Terraform, Swift/Objective-C, and more. `frameworks/index.ts` detects and invokes the applicable subset.

Unity has two linked pieces:

- [`src/extraction/unity-asset-extractor.ts`](../../src/extraction/unity-asset-extractor.ts) indexes Unity scenes, prefabs, and assets; and
- [`src/resolution/frameworks/unity-assets.ts`](../../src/resolution/frameworks/unity-assets.ts) links scripts, GameObjects, serialized references, prefab instances, and conservative UnityEvent targets.

Do not assume every extractor emits only language source symbols. Some source-adjacent formats are deliberately first-class because they express runtime wiring that agents need for impact and flow questions.

## How to make safe changes

### Add or change a language/extractor

1. Locate extension/language detection in `grammars.ts`; update grammar assets only when a compatible parser exists.
2. Decide whether the generic tree-sitter extractor is enough or whether a focused extractor is necessary.
3. Capture stable node IDs/names, source spans, direct references, and relevant node metadata. Avoid guessing cross-file targets during parsing.
4. Add representative syntax and negative cases to extraction tests. Large fixtures generally belong in the targeted language suite rather than an unrelated generic test.
5. Confirm file discovery, custom extension mapping, and watcher behavior recognize the new file type.

### Add a resolver/synthesizer

1. Preserve the extraction → global resolution → secondary/deferred-pass order.
2. Define the evidence needed to emit an edge, its edge kind, and whether it is heuristic/dynamic provenance.
3. Bound fan-out, cache expensive lookups, and yield during scans; one common symbol should not create unbounded work.
4. Test full end-to-end behavior: extracted reference → resolved edge → callers/impact/context result, including ambiguity and external-target negatives.
5. If behavior is framework-specific, detect the framework conservatively so unrelated projects do not receive false edges.

## Tests and diagnostics

The broad regression suites are [`__tests__/extraction.test.ts`](../../__tests__/extraction.test.ts), [`__tests__/resolution.test.ts`](../../__tests__/resolution.test.ts), and [`__tests__/frameworks-integration.test.ts`](../../__tests__/frameworks-integration.test.ts). Focused examples include [`unity-assets.test.ts`](../../__tests__/unity-assets.test.ts), [`unity.test.ts`](../../__tests__/unity.test.ts), [`terraform`-related framework tests](../../__tests__/frameworks.test.ts), callback/function-reference suites, and language/framework-specific tests named throughout `__tests__/`.

For difficult resolver work, consult existing design playbooks before changing behavior: [`docs/design/framework-resolver-debugging.md`](../../docs/design/framework-resolver-debugging.md), [`docs/design/callback-edge-synthesis.md`](../../docs/design/callback-edge-synthesis.md), and [`docs/design/value-reference-edges.md`](../../docs/design/value-reference-edges.md). They are deeper investigations; this page is the architectural map.
