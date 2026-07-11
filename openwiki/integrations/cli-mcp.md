# CLI, MCP, and agent integrations

## Entry points and intended user flow

The executable source is [`src/bin/codegraph.ts`](../../src/bin/codegraph.ts), built as `dist/bin/codegraph.js`. With no arguments it launches the interactive installer. The normal onboarding separates **agent wiring** from **per-project indexing**:

```text
install CLI → codegraph install → agent MCP configuration
                         ↓
              in each project: codegraph init
                         ↓
           .codegraph/codegraph.db + initial index + watch
```

Key commands include `install`, `uninstall`, `init`, `uninit`, `index`, `sync`, `status`, `query`, `files`, `context`, `callers`, `callees`, `impact`, `affected`, `upgrade`, `telemetry`, and the internal agent entrypoint `serve --mcp`. The CLI loads the heavy library lazily, protects startup with fatal handlers, enforces supported Node versions, and relaunches with WASM runtime flags where necessary.

`init` creates project state and indexes by default. `index` is the full rebuild path; `sync` updates changes. `uninstall` reverses agent configuration but deliberately leaves project indexes in place; `uninit` removes a project’s local index.

## MCP server behavior

MCP code lives in [`src/mcp/`](../../src/mcp/). The server uses stdio JSON-RPC (`transport.ts`, `session.ts`) and is designed to serve coding agents without requiring a hosted source-analysis service.

The main tool is intentionally **`codegraph_explore`**. It combines semantic search, graph relationships/call paths, impact-oriented context, and line-numbered source. Other implemented tools (node/search/callers/callees/impact/files/status) are not exposed by default; `CODEGRAPH_MCP_TOOLS` controls both advertised and executable tool allowlists.

An MCP client may connect without an indexed default root. Tool calls can provide `projectPath` for an already indexed project, including a monorepo subproject. CodeGraph explains how to initialize an unindexed project instead of silently performing a potentially expensive index on the user’s behalf.

### Startup, freshness, and correctness

The server responds to MCP initialization before expensive parser/graph setup so hosts do not time out. A normal initialized project starts a watcher and runs catch-up reconciliation. If changed files are pending, tool output flags the staleness so the agent can read them directly; it does not claim a graph answer is definitively fresh when it is not.

This behavior is part of the product contract, not a display preference. Preserve it when changing startup, querying, or watch flow.

## Daemon and proxy modes

CodeGraph can share work across multiple agent sessions using a detached per-project daemon:

- **Daemon:** owns watcher, database/engine, and socket service.
- **Proxy:** bridges a client’s stdio MCP transport to the daemon socket.
- **Direct mode:** runs a server in the client process when `CODEGRAPH_NO_DAEMON=1`, no usable project/daemon exists, or proxy/daemon startup fails.

Daemon/proxy reliability machinery is spread across `daemon.ts`, `daemon-manager.ts`, `daemon-paths.ts`, `daemon-registry.ts`, `proxy.ts`, `ppid-watchdog.ts`, `liveness-watchdog.ts`, and `stdin-teardown.ts`. It handles canonical project paths, locks/stale locks, reference counting and idle cleanup, parent-process exit, liveness, and direct-mode fallback. Do not replace a failed shared-daemon path with a hard user-visible failure when direct mode can still serve the request.

## Installer and supported agents

[`src/installer/index.ts`](../../src/installer/index.ts) and `src/installer/targets/` discover and configure these targets:

- Claude Code
- Cursor
- Codex CLI
- OpenCode
- Hermes Agent
- Gemini CLI
- Antigravity IDE
- Kiro

`codegraph install` supports interactive selection and `--target auto|all|none|<csv>`, `--location global|local`, `--yes`, `--no-permissions` (Claude-specific), and `--print-config <target>` without writing. The installer must be idempotent and preserve unrelated agent configuration. Uninstall must remove only CodeGraph-owned MCP config, hooks, and permissions.

Claude can receive CodeGraph permission entries plus a `UserPromptSubmit` context hook. MCP initialization supplies server instructions, so installer behavior should not depend on writing a separate instructions document. Target capabilities and location restrictions belong in `src/installer/targets/`; Codex is modeled as global-only.

## Change guidance

- **CLI commands:** retain command supervision, fatal handling, telemetry’s no-failure guarantee, project-root discovery, and clear read-only/write semantics. Add CLI tests for success/error JSON or printed contracts.
- **MCP protocol/tools:** do not write logging or diagnostic content to protocol stdout. Keep tool annotation/allowlist behavior in lockstep with actual dispatch. Test initialization and unindexed/multi-root behavior.
- **Daemon changes:** test socket fallback, stale/recovered state, parent-process shutdown, idle teardown, and liveness; direct mode is a required resilience path.
- **Agent targets:** use target abstraction/config writers, preserve sibling config, and add target-specific idempotency/uninstall cases.

Relevant suites include [`__tests__/mcp-initialize.test.ts`](../../__tests__/mcp-initialize.test.ts), [`mcp-daemon.test.ts`](../../__tests__/mcp-daemon.test.ts), [`mcp-roots.test.ts`](../../__tests__/mcp-roots.test.ts), [`mcp-tool-allowlist.test.ts`](../../__tests__/mcp-tool-allowlist.test.ts), [`mcp-staleness-banner.test.ts`](../../__tests__/mcp-staleness-banner.test.ts), `daemon-*.test.ts`, [`proxy-connect.test.ts`](../../__tests__/proxy-connect.test.ts), and [`installer-targets.test.ts`](../../__tests__/installer-targets.test.ts).
