# Testing and change guide

## Standard validation

```bash
npm run build
npm test
```

The scripts are defined in [`package.json`](../../package.json). Build compiles TypeScript and copies runtime schema/WASM assets; tests run Vitest in Node over `__tests__/**/*.test.ts`. `npm run test:eval` limits execution to `__tests__/evaluation/`; `npm run eval` builds and invokes the evaluation runner. The test environment disables telemetry and enables the unsafe-Node override only for test subprocesses (`vitest.config.ts`).

No shell validation was performed while generating this wiki. Run relevant commands after changes.

## Test map

The suite is intentionally broad because a graph feature crosses several layers.

| Change area | Start with |
|---|---|
| Generic parser/node/edge capture | `extraction.test.ts`, `function-ref.test.ts`, language-specific extraction tests |
| Cross-file names, imports, aliases, receiver inference | `resolution.test.ts`, `function-ref.test.ts`, `same-name-disambiguation.test.ts` |
| Framework/dynamic behavior | `frameworks.test.ts`, `frameworks-integration.test.ts`, focused suites such as `unity*.test.ts`, `blender.test.ts`, `drupal.test.ts` |
| DB/schema/query performance | `sqlite-backend.test.ts`, `node-sqlite-backend.test.ts`, `db-perf.test.ts`, `db-reopen-on-replace.test.ts` |
| Traversal/retrieval | `graph.test.ts`, `context.test.ts`, `context-ranking.test.ts`, `search-query-parser.test.ts` |
| Index/sync/watching | `index-command.test.ts`, `sync.test.ts`, `watcher.test.ts`, `watch-policy.test.ts`, `concurrent-locking.test.ts` |
| CLI | `cli-*.test.ts`, `status-json.test.ts`, `foundation.test.ts` |
| MCP protocol/lifecycle | `mcp-*.test.ts`, `daemon-*.test.ts`, `proxy-connect.test.ts`, `stdin-teardown.test.ts`, `liveness-watchdog.test.ts` |
| Installers and release paths | `installer*.test.ts`, `install-sh-prune.test.ts`, `upgrade.test.ts`, `prepare-release.test.ts` |
| Privacy/telemetry | `telemetry.test.ts`, `security.test.ts`, `config-secret-redaction.test.ts` |

## Change-oriented workflow

### Storage or query changes

1. Change the new-install schema in [`src/db/schema.sql`](../../src/db/schema.sql).
2. Add a sequential migration in [`src/db/migrations.ts`](../../src/db/migrations.ts).
3. Update typed row conversion and statements in [`src/db/queries.ts`](../../src/db/queries.ts).
4. Test new DB, immediately-prior DB migration, read-only opening, and deletion/duplicate behavior.

Do not rely on a full-index test alone: migrations and read-only operation have distinct contracts.

### Extraction, resolver, or framework changes

1. Begin with a minimal positive fixture and at least one ambiguity/negative fixture.
2. Assert the graph edge, not just an internal helper result.
3. Assert a consumer-level effect (callers/impact/traversal/context) if the relationship is agent-visible.
4. Mark or preserve heuristic/dynamic provenance when the relation is synthesized.
5. Check incremental sync if the new behavior depends on cross-file state or non-source assets.

Review [`architecture/extraction-resolution.md`](../architecture/extraction-resolution.md) before adding a language/framework. Existing design playbooks in [`docs/design/`](../../docs/design/) are especially useful when a change involves callbacks, dynamic dispatch, value references, or resolver debugging.

### CLI/MCP/daemon changes

1. Keep protocol stdout clean; diagnostics must not corrupt stdio JSON-RPC.
2. Exercise direct and daemon/proxy paths, including unavailable daemon fallback.
3. Cover MCP initialization timing, root selection, unindexed-project handling, allowed-tool behavior, and staleness output.
4. Test watcher/lock/parent-process cleanup for lifecycle changes.
5. Preserve the distinction between index installation, agent installation, and agent removal.

### Configuration/privacy/operational changes

1. Apply scope changes to initial scan, sync, and watcher paths.
2. Preserve safe project-root path validation and no-config non-fatal behavior.
3. For telemetry, update `TELEMETRY.md`, client, worker allowlist, and tests together; never introduce a silent new collection field.
4. Validate disabled telemetry makes no connection or state mutation.

## Recent-code context

Recent history in the supplied Git summary emphasizes two practical risk areas:

- **Graph accuracy/support breadth:** Unity asset wiring and its conservative resolver behavior were recently introduced and refined; upstream sync added language support including COBOL, VB.NET, Erlang, Solidity, CUDA, and Terraform.
- **Operational correctness:** a recent fix hardened read-only index opening without writable SQLite sidecars; watchdog/yield, deduplication, and watcher degradation behavior are similarly deliberate safeguards.

Treat these as areas requiring focused regression coverage when touching adjacent code. They explain why the repository favors explicit uncertainty, bounded work, and safe fallback over aggressive linking or background retries.
