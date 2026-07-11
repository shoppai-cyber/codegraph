# CodeGraph: repository guide

CodeGraph is a TypeScript/Node.js, local-first code-intelligence product. It indexes a project into a SQLite semantic graph, resolves relationships across source files and supported frameworks, and exposes focused context and graph analysis through a CLI, an MCP server, and a small library API. The product goal is to give coding agents direct, bounded context instead of making them reconstruct structure with repeated file searches.

The published package is `@colbymchenry/codegraph`; its `codegraph` executable is built from [`src/bin/codegraph.ts`](../src/bin/codegraph.ts). Node.js 20–24 is supported (`package.json`); the CLI deliberately blocks Node 25 by default because large tree-sitter WASM grammars can crash there.

## Start here

- **[Architecture and graph lifecycle](architecture/graph-lifecycle.md)** — project state, full index/sync pipeline, SQLite model, retrieval, and concurrency/freshness invariants.
- **[Extraction and resolution](architecture/extraction-resolution.md)** — parser pipeline, language/framework behavior, and how static and heuristic relationships are produced.
- **[CLI, MCP, and integrations](integrations/cli-mcp.md)** — user and agent entrypoints, background daemon behavior, supported agent installers, and exposed tools.
- **[Configuration, operations, and telemetry](operations/configuration-operations.md)** — per-project configuration, watchers, read-only behavior, privacy contract, packaging, and failure-oriented guidance.
- **[Testing and change guide](testing/change-guide.md)** — validation commands, test organization, and the relevant suites for common changes.

## Repository map

| Area | Responsibility | Start with |
|---|---|---|
| `src/index.ts` | `CodeGraph` facade; wires storage, indexing, resolution, traversal, context, locking, and watching | `CodeGraph.init`, `open`, `indexAll`, `sync` |
| `src/extraction/` | File discovery, grammar loading, worker-based tree-sitter extraction, and specialized extractors | `index.ts`, `tree-sitter.ts`, `grammars.ts` |
| `src/resolution/` | Turns unresolved references into cross-file edges; framework and dynamic-dispatch synthesis | `index.ts`, `frameworks/index.ts` |
| `src/db/` | SQLite adapter, schema/migrations, typed query layer | `schema.sql`, `migrations.ts`, `queries.ts` |
| `src/graph/`, `src/context/`, `src/search/` | Traversal, search/ranking, and compact source-context assembly | `traversal.ts`, `context/index.ts` |
| `src/mcp/`, `src/installer/`, `src/bin/` | Agent-facing MCP server/daemon, agent configuration, and CLI | `mcp/index.ts`, `mcp/tools.ts`, `bin/codegraph.ts` |
| `src/sync/` | File watching, sync policy, worktree checks, optional git hooks | `watcher.ts`, `watch-policy.ts` |
| `src/telemetry/`, `telemetry-worker/` | Anonymous telemetry client and allowlisted ingestion worker | `TELEMETRY.md`, `telemetry-worker/src/index.ts` |
| `__tests__/` | Vitest unit, integration, CLI, MCP, framework, and evaluation coverage | `extraction.test.ts`, `resolution.test.ts`, `frameworks-integration.test.ts` |

The repository also contains substantial primary documentation: [`README.md`](../README.md) is the product/install guide; [`TELEMETRY.md`](../TELEMETRY.md) is the public collection contract; [`docs/design/`](../docs/design/) records implementation playbooks; and [`CHANGELOG.md`](../CHANGELOG.md) captures recent support expansion and reliability fixes.

## Local development

```bash
npm install
npm run build
npm test
```

`npm run build` compiles TypeScript and copies `src/db/schema.sql` plus parser WASM files to `dist/`. `npm test` runs Vitest over `__tests__/**/*.test.ts`; `npm run test:eval` limits execution to evaluations. The test configuration disables telemetry and permits the CLI runtime guard override only for tests (`vitest.config.ts`).

For a built local CLI:

```bash
npm run cli -- --help
```

Do not treat a build as an index-quality check. Changes to extraction, resolution, query ranking, watcher behavior, MCP lifecycle, or installers need targeted tests in addition to the build; see the [change guide](testing/change-guide.md).

## Product flow

1. A user installs the CLI and runs `codegraph install` to connect supported coding agents through MCP.
2. In each target project, `codegraph init` creates `.codegraph/` and builds the local SQLite index.
3. Extraction writes files, symbols, immediate edges, and unresolved references. Resolution then adds cross-file, framework-aware, and explicitly marked heuristic relationships.
4. A watcher normally keeps the graph synchronized. The MCP server answers agent questions from graph search/traversal plus bounded source blocks; it signals stale files rather than silently claiming complete freshness.

The current changelog shows why reliability constraints are prominent: recent work added Unity asset wiring, Terraform/OpenTofu and several language extractors, tightened edge deduplication, made read-only queries workable in constrained environments, and added cooperative yielding/watch degradation for large or troublesome repositories. See [`CHANGELOG.md`](../CHANGELOG.md) and the focused pages for durable behavior rather than relying on release prose alone.
