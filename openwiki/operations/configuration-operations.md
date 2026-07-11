# Configuration, operations, and privacy

## Per-project configuration

A project can commit `codegraph.json` at its root. Its loader is [`src/project-config.ts`](../../src/project-config.ts). The supported fields are:

| Field | Use |
|---|---|
| `extensions` | Map a custom extension to an existing supported language; user mappings override built-ins. |
| `includeIgnored` | Gitignore-style patterns that explicitly include otherwise ignored embedded repositories. |
| `exclude` | Gitignore-style patterns that keep paths out of the graph even when Git tracks them. |

Configuration parsing is intentionally non-fatal: missing/malformed files or bad individual entries fall back to defaults and emit warnings. Patterns are rooted relative to the indexed project. Scope changes matter for full indexing, sync, and watch; reindex after changing scope to guarantee existing graph content reflects the new policy.

## Index scope, watchers, and large repositories

The indexer avoids dependencies, generated/build output, caches, and vendor trees by default. This is a graph-quality and operational decision: pulling in third-party or generated source makes search and relationship results noisier while consuming parser/database budget. `.gitignore` is respected by default; ignored nested repositories need explicit `includeIgnored` opt-in.

File watching is enabled by default after an MCP/index lifecycle starts. Platform policy lives in [`src/sync/watch-policy.ts`](../../src/sync/watch-policy.ts); watcher implementation is [`src/sync/watcher.ts`](../../src/sync/watcher.ts). Notable constraints:

- Windows/macOS use recursive watching; Linux has per-directory watcher limits.
- WSL paths under `/mnt/<drive>` default to no watcher due to poor recursive-watch behavior.
- Pending modifications remain visible until sync succeeds.
- Persistent lock contention, watch exhaustion, or repeated sync failure degrades/halts auto-sync explicitly instead of silently retrying forever.

For very large repositories, preserve worker recycle/parse timeout behavior and cooperative yields in scanning/reconciliation/resolution. These prevent a healthy but slow index from being mistaken for a stalled daemon by liveness watchdogs.

## Runtime and packaging

`package.json` defines a CommonJS TypeScript package with a Node 20–24 engine range. Build steps compile TypeScript and copy the SQLite schema plus tree-sitter WASM grammars into `dist/`; those assets are runtime dependencies, not optional developer files. The product has standalone shell/PowerShell installers (`install.sh`, `install.ps1`) as well as npm installation.

The CLI’s Node guard blocks Node 25 by default because tree-sitter grammar compilation can hit a V8/WASM failure; `CODEGRAPH_ALLOW_UNSAFE_NODE` is an intentional override. Tests set it only so child-process tests can run on contributors’ Node versions. Do not remove the user-facing guard merely to simplify tests.

## Telemetry: separate from local analysis

Source analysis is local-first: project graph data is stored in local SQLite. CodeGraph also has an **anonymous, opt-out usage telemetry** system; its complete public contract is [`TELEMETRY.md`](../../TELEMETRY.md), with implementation in [`src/telemetry/`](../../src/telemetry/) and a public ingestion worker in [`telemetry-worker/`](../../telemetry-worker/).

Telemetry resolution order is:

1. `DO_NOT_TRACK` disables it;
2. `CODEGRAPH_TELEMETRY=0|1` overrides per environment;
3. persisted user choice in `~/.codegraph/telemetry.json` applies;
4. otherwise it defaults on.

Users can run `codegraph telemetry off`, `on`, or `status`. Installer consent is a visible, one-time default-on choice; when the installer was bypassed, the first actual send emits a notice. Disabled means no recording, no connection, no opt-out ping, and deletion of queued unsent data.

The documented allowlist limits data to a random machine UUID, CodeGraph/runtime platform metadata, coarse index language/count/duration buckets, install/uninstall target/scope events, and locally aggregated daily command/MCP usage counts. It does **not** include source, paths, repository identity, symbols, queries, prompt text, IP, usernames, hostnames, email, environment values, or per-call event streams. The Cloudflare worker validates allowed event properties, strips unknown values, does not process IPs, rate-limits, and forwards sanitized events asynchronously. Client sends are bounded/fire-and-forget, and must never interfere with MCP responses or write to protocol stdout.

Telemetry schema changes require synchronized changes to the documentation, client, worker validation, and tests; see [`docs/design/telemetry.md`](../../docs/design/telemetry.md).

## Operational change checklist

- Make path/config behavior work under project-root validation and in multi-project daemon processes.
- Keep extraction and watcher scope decisions exactly aligned.
- Preserve a usable read-only path for inspection commands and avoid implicit write/migration side effects.
- Treat auto-sync failure state as user-visible freshness information, not a reason to return silently stale results.
- For telemetry, retain the allowlist and “off means off” properties; no new field should be sent before it is documented and worker-validated.

Targeted tests include [`__tests__/watch-policy.test.ts`](../../__tests__/watch-policy.test.ts), [`watcher.test.ts`](../../__tests__/watcher.test.ts), [`exclude-config.test.ts`](../../__tests__/exclude-config.test.ts), [`include-ignored-config.test.ts`](../../__tests__/include-ignored-config.test.ts), [`config-secret-redaction.test.ts`](../../__tests__/config-secret-redaction.test.ts), [`telemetry.test.ts`](../../__tests__/telemetry.test.ts), and [`wasm-runtime-flags.test.ts`](../../__tests__/wasm-runtime-flags.test.ts).
