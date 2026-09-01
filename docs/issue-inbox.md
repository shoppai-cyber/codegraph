# Passive CodeGraph issue inbox

The issue inbox is a local-only intake path for a reproducible CodeGraph defect. It does not
create GitHub issues, contact a network service, invoke Git, or write to either the CodeGraph
checkout or the diagnosed repository.

## Commands

File one report from an absolute JSON path:

```text
codegraph inbox file --input C:\path\to\report.json
```

The command prints the report's deterministic content ID and the stored report path. A repeated
submission prints that the report is already filed and leaves one stored record.

Print a deterministic JSON summary:

```text
codegraph inbox summary
```

The summary contains the carrier path, the exact deduplicated `reportCount`, and each report's
content ID, title, origin repository, source file, attribution class, and stored report path.
Reports are sorted by content ID, so repeated summary calls produce byte-identical output until
the carrier changes.

## Carrier and privacy boundary

The default per-user carrier is outside the product checkout and the diagnosed repository:

- Windows: `%LOCALAPPDATA%\CodeGraph\issue-inbox`
- macOS: `~/Library/Application Support/CodeGraph/issue-inbox`
- Linux and other Unix-like systems: `$XDG_STATE_HOME/codegraph/issue-inbox`, or
  `~/.local/state/codegraph/issue-inbox` when `XDG_STATE_HOME` is unset

For isolated tests or a deliberately selected local carrier, set `CODEGRAPH_ISSUE_INBOX_DIR` to
an absolute path. The file command refuses a carrier inside `originRepo` or the CodeGraph product
checkout. The override is not a network endpoint and is never interpreted as one.

Only the report JSON is stored. `evidencePointer` is an opaque durable pointer; the inbox does not
open, upload, or resolve it. Filing reads `originRepo` and `filePath` only to verify that the
repository directory exists, the source file is a regular file, and its current SHA-256 matches
`fileHash`.

## Closed input schema

The input is a JSON object with exactly these fields. Unknown fields and missing fields are
rejected:

| Field | Requirement |
|---|---|
| `schemaVersion` | The integer `1`. |
| `title` | Non-empty concise title, at most 200 characters. |
| `originRepo` | Absolute path to an existing directory. |
| `codegraphVersion` | Non-empty version string supplied by the caller. |
| `indexSchemaVersion` | Positive integer supplied by the caller. |
| `command` | Non-empty exact command that reproduced the issue. |
| `filePath` | Absolute path to an existing regular source file. |
| `fileHash` | Lowercase SHA-256 hash of `filePath` at filing time. |
| `expectedBehavior` | Non-empty expected result. |
| `actualBehavior` | Non-empty observed result. |
| `attributionClass` | One of `codegraph`, `origin-repo`, `environment`, or `unknown`. |
| `evidencePointer` | Non-empty durable pointer to the evidence. It is not fetched. |

Example (replace the paths and hash with the actual reproduction):

```json
{
  "schemaVersion": 1,
  "title": "Exact file symbol is not returned",
  "originRepo": "C:\\dev\\repos\\example",
  "codegraphVersion": "1.6.0",
  "indexSchemaVersion": 9,
  "command": "codegraph explore example",
  "filePath": "C:\\dev\\repos\\example\\src\\example.ts",
  "fileHash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "expectedBehavior": "The exact source symbol is returned.",
  "actualBehavior": "The exact source symbol is absent.",
  "attributionClass": "codegraph",
  "evidencePointer": "C:\\dev\\repos\\example\\evidence\\run.txt"
}
```

The input path passed to `--input` must itself be absolute. Hash mismatches and invalid source
paths fail before any report is published.

## Dedupe, atomicity, and concurrency

Each accepted report is canonicalized in the fixed schema field order and identified by the
lowercase SHA-256 of that canonical JSON. It is stored as `reports/<reportId>.json` with no
timestamp, so identical reports have the same bytes and the same identity even when their input
JSON key order differs. The report file contains the input fields plus `reportId`.

Publication writes a uniquely named temporary file in the carrier, flushes it, and renames it into
place. A summary reads only completed `.json` files. Concurrent unique submissions therefore have
different destinations; concurrent identical submissions converge on the same deterministic file,
and a collision is rejected if an existing file does not contain the expected bytes. Temporary
files are removed after publication or failure.

## Local example

```text
codegraph inbox file --input C:\dev\reports\codegraph-issue.json
codegraph inbox summary
```

The origin repository remains untouched. The only durable product of the filing operation is the
validated report under the user-owned issue-inbox carrier.
