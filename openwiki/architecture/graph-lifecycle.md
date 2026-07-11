# Architecture: graph lifecycle and retrieval

## Purpose and layers

[`src/index.ts`](../../src/index.ts) exports the main `CodeGraph` facade and is the best starting point for runtime changes. It composes a single database/query layer with:

- `ExtractionOrchestrator` for scans, parsing, and persistence;
- `ReferenceResolver` for cross-file relationship resolution;
- `GraphQueryManager` and `GraphTraverser` for graph queries;
- `ContextBuilder` for agent-ready source context; and
- `FileWatcher` for automatic incremental synchronization.

All of these are rebuilt together by `wireLayers()` when a database handle changes. That matters when a long-lived process detects that the SQLite file was replaced: continuing to use an old handle can point at an unlinked file on POSIX.

```text
source files
  → extraction and initial storage
  → unresolved references
  → resolution / framework synthesis
  → SQLite graph
  → search + traversal
  → bounded source context / CLI or MCP response
```

## Project state and persistence

Each indexed project owns `<project>/.codegraph/codegraph.db`. [`src/directory.ts`](../../src/directory.ts) validates the data-directory override and rejects values that could escape the project root. A project is initialized only when both the directory and database exist; callers can resolve an initialized ancestor project rather than requiring the current directory to be the root.

SQLite storage is defined in [`src/db/schema.sql`](../../src/db/schema.sql), with upgrades in [`src/db/migrations.ts`](../../src/db/migrations.ts) and typed access in [`src/db/queries.ts`](../../src/db/queries.ts).

| Store | Meaning |
|---|---|
| `files` | Indexed source path, hash, language, file metadata, and extraction errors |
| `nodes` | Symbols with kind, qualified name, source span, signature, visibility, and flags |
| `edges` | Directed, typed node relationships with location, optional metadata, and optional provenance |
| `unresolved_refs` | Extraction-time references waiting for a global resolution pass |
| `nodes_fts` | FTS5 mirror for names, qualified names, docstrings, and signatures |
| `name_segment_vocab` | Materialized identifier-word lookup used by graph-derived prompt matching; stale candidates are re-verified |
| `project_metadata` | Package/extraction provenance and other project-level metadata |

Node writes maintain FTS through triggers. Edge identity is unique on source, target, kind, and normalized line/column, so duplicate extraction or synthesis passes cannot inflate graph results. Preserve this schema-level constraint when adding edge producers.

### Read/write modes and migrations

`CodeGraph.open()` supports read-only access. A read-only open must not run migrations, write WAL sidecars, checkpoints, or other storage mutation; an old database must be opened writable once to migrate. The CLI’s recent read-only behavior is deliberate so query commands work in restrictive agent sandboxes. Storage changes require **both** a fresh-schema update and a sequential migration; update row mapping/prepared statements too.

## Indexing and synchronization

### Full index

`CodeGraph.indexAll()` serializes writers with an in-process `Mutex` and a filesystem `FileLock`, then:

1. clears advisory identifier-segment vocabulary;
2. scans and extracts all in-scope source files;
3. reruns framework detection after files exist and performs cross-file post-extraction work;
4. resolves deferred references in batches, followed by inherited/conformance and deferred-member passes;
5. performs best-effort SQLite optimization/checkpointing;
6. recalculates graph counts and records extraction/package metadata; and
7. releases the cross-process lock in all cases.

Full indexing is the canonical refresh path and is intentionally distinct from `sync`: only a full index stamps the extraction version.

### Incremental sync and watch freshness

`CodeGraph.sync()` uses the same locks but reconciles added, changed, and removed files. It limits resolution to changed file paths when possible, then runs the same secondary resolution passes and best-effort database maintenance. A sync can lazily repair an empty segment vocabulary left by an older index.

[`src/sync/watcher.ts`](../../src/sync/watcher.ts) debounces changes into `sync()` calls. Pending paths are retained until a relevant sync succeeds; this intentionally favors a stale warning over a falsely fresh answer. Watch scope must remain identical to index scope: recognized extensions, built-in exclusions, `.gitignore`, `codegraph.json` inclusion/exclusion, and every CodeGraph state directory all need equivalent treatment.

Platform policy in [`src/sync/watch-policy.ts`](../../src/sync/watch-policy.ts): macOS/Windows use a recursive watcher; Linux watches directories subject to a cap; WSL paths under `/mnt/<drive>` default to no watcher because recursive watch reliability/performance is poor. Repeated lock contention or sync failures causes explicit degradation rather than infinite background retry.

## Search, traversal, and context assembly

`GraphTraverser` in [`src/graph/traversal.ts`](../../src/graph/traversal.ts) performs bounded BFS/DFS with direction, node/edge filters, depth, start-node inclusion, and a node limit. BFS prioritizes containment and call relationships. Deduplicate at both node-enqueue and edge-identity levels: a symbol may be reachable through multiple paths or have several relationship kinds to the same target.

`ContextBuilder` in [`src/context/index.ts`](../../src/context/index.ts) converts an agent task into compact evidence:

1. extracts likely identifier terms from natural-language text;
2. searches direct definitions and full text;
3. merges/reranks candidate roots;
4. traverses relevant nearby graph structure;
5. reads validated in-root source spans; and
6. formats Markdown, JSON, or structured context.

Defaults are intentionally conservative: 20 nodes, 5 source blocks, 1,500 characters per block, three search seeds, and traversal depth one. High-value result kinds exclude low-information import/export nodes by default. Changes to ranking or traversal must retain hard output budgets and path-within-root validation.

## Change checklist

- **Storage:** change `schema.sql`, add migration, adjust `queries.ts`, and test fresh plus migrated databases.
- **Index/resolution ordering:** framework detection depends on populated files; do not move post-extraction resolution before extraction completes.
- **Writer safety:** retain both in-process and cross-process locking around graph mutation.
- **Deletion/duplicates:** respect foreign-key cascades, FTS triggers, and edge uniqueness; do not add raw ad-hoc writes.
- **Sync/watch changes:** cover adds, modifications, deletion, failure/retry/degrade behavior, and no-git fallback.
- **Retrieval:** test bounds, parallel/direct edges, directionality, root ranking, and source-root safety.

Relevant tests: [`__tests__/graph.test.ts`](../../__tests__/graph.test.ts), [`__tests__/context.test.ts`](../../__tests__/context.test.ts), [`__tests__/context-ranking.test.ts`](../../__tests__/context-ranking.test.ts), [`__tests__/sync.test.ts`](../../__tests__/sync.test.ts), [`__tests__/watcher.test.ts`](../../__tests__/watcher.test.ts), [`__tests__/db-reopen-on-replace.test.ts`](../../__tests__/db-reopen-on-replace.test.ts), and [`__tests__/unsafe-index-root.test.ts`](../../__tests__/unsafe-index-root.test.ts).
