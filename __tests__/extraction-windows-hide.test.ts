/**
 * Regression: the ignore-scope git calls must not open console windows on Windows.
 *
 * The MCP daemon is spawned detached (src/mcp/index.ts), so it has no console.
 * A console program it runs without `windowsHide` gets a new, visible console
 * window on Windows, and the watcher refreshes its ignore scope often: the two
 * git calls added for #1728 flashed a `git.exe` window on the desktop each time,
 * for every running daemon. windowsHide is a Windows-only spawn behavior that a
 * test can't observe, so — as in the npm-shim guard (#1092) — the option is
 * asserted instead of the window.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { buildScopeIgnore } from '../src/extraction';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

describe('ignore-scope git calls hide their console (windowsHide)', () => {
  let root: string;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    vi.mocked(execFileSync).mockImplementation(actual.execFileSync);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-test-'));
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'pipe' });
    vi.mocked(execFileSync).mockClear();
  });

  afterEach(() => {
    vi.mocked(execFileSync).mockReset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('passes windowsHide: true on every git call buildScopeIgnore makes', () => {
    buildScopeIgnore(root);
    const gitCalls = vi.mocked(execFileSync).mock.calls.filter(([file]) => file === 'git');
    const argsOf = (call: unknown[]) => (call[1] as string[]).join(' ');

    // Guard against a false pass if the calls move: both #1728 calls must run.
    expect(gitCalls.map(argsOf)).toEqual(expect.arrayContaining([
      expect.stringContaining('config --get core.excludesFile'),
      expect.stringContaining('ls-files -z -o -i --exclude-standard --directory'),
    ]));
    const unhidden = gitCalls
      .filter((call) => (call[2] as { windowsHide?: boolean } | undefined)?.windowsHide !== true)
      .map(argsOf);
    expect(unhidden).toEqual([]);
  });
});
