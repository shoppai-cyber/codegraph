/**
 * `codegraph affected` test-file detection.
 *
 * The command used to carry its OWN test-file patterns, shadowing the shared
 * `isTestFile` helper in `src/search/query-utils.ts`. The local copy was
 * case-sensitive (`/\/tests?\//`) and had no filename rule, so the very common
 * .NET/Unity layout `Assets/Game/Tests/PlayerNetworkDriverTests.cs` missed
 * twice over — `/Tests/` never matched, and nothing matched the `Tests.cs`
 * CamelCase suffix. `affected` then reported "no test files affected", which is
 * a *confident false negative* about test coverage: worse than an error,
 * because it reads as a successful answer.
 *
 * The default case now delegates to the shared helper (which lowercases the
 * path AND knows CamelCase suffixes/dirs). `--filter` is unchanged, and the
 * one rule the shared helper lacks — `e2e/` directories — is preserved
 * explicitly, since dropping it would trade one false negative for another.
 *
 * Exercised end-to-end against the built binary, like cli-affected-paths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function affected(cwd: string, args: string[]): string[] {
  const out = execFileSync(process.execPath, [BIN, 'affected', ...args, '--quiet', '-p', cwd], {
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('codegraph affected — test-file detection', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-affected-detect-'));

    // Unity-shaped layout: a capital `Tests/` dir AND a CamelCase `Tests.ts`
    // suffix, neither of which the old local patterns matched.
    write(tempDir, 'Assets/Game/Runtime/playerNetworkDriver.ts',
      'export function applyTeam(n: number){ return n; }\n');
    write(tempDir, 'Assets/Game/Tests/PlayerNetworkDriverTests.ts',
      "import { applyTeam } from '../Runtime/playerNetworkDriver';\ntest('t', () => applyTeam(1));\n");

    // e2e/ — matched by the OLD local patterns and NOT by the shared helper.
    write(tempDir, 'packages/app/src/checkout.ts',
      'export function checkout(){ return true; }\n');
    write(tempDir, 'packages/app/e2e/smoke.ts',
      "import { checkout } from '../src/checkout';\ncheckout();\n");

    // The literal path from the field report, so the reported string itself is
    // covered even though .cs dependency edges are not what's under test here.
    write(tempDir, 'Assets/Game/Tests/PlayerNetworkDriverTests.cs',
      'public class PlayerNetworkDriverTests { public void Passes() { } }\n');

    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds a CamelCase Tests/ dependent without needing --filter', () => {
    expect(affected(tempDir, ['Assets/Game/Runtime/playerNetworkDriver.ts']))
      .toEqual(['Assets/Game/Tests/PlayerNetworkDriverTests.ts']);
  });

  it('classifies the reported .cs path as a test file', () => {
    // `affected` echoes an input that is itself a test file. Before the fix
    // this printed nothing at all.
    expect(affected(tempDir, ['Assets/Game/Tests/PlayerNetworkDriverTests.cs']))
      .toEqual(['Assets/Game/Tests/PlayerNetworkDriverTests.cs']);
  });

  it('still detects e2e/ directories', () => {
    expect(affected(tempDir, ['packages/app/src/checkout.ts']))
      .toEqual(['packages/app/e2e/smoke.ts']);
  });

  it('--filter still overrides detection entirely', () => {
    // A filter that matches nothing must suppress the default detection,
    // not fall back to it.
    expect(affected(tempDir, ['Assets/Game/Runtime/playerNetworkDriver.ts', '-f', 'nope/**/*.ts']))
      .toEqual([]);
    // ...and a filter that matches still works.
    expect(affected(tempDir, ['Assets/Game/Runtime/playerNetworkDriver.ts', '-f', '**/*Tests.ts']))
      .toEqual(['Assets/Game/Tests/PlayerNetworkDriverTests.ts']);
  });
});
