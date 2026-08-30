import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('codegraph_explore pinned-file flow', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pinned-flow-'));
    const snapshotsDir = path.join(testDir, 'snapshots');
    fs.mkdirSync(snapshotsDir, { recursive: true });
    for (let index = 0; index < 60; index++) {
      fs.writeFileSync(
        path.join(snapshotsDir, `snapshot_${String(index).padStart(2, '0')}.py`),
        `def shared_leaf(value):\n    return value + ${index}\n\n` +
          `def shared_middle(value):\n    return shared_leaf(value)\n\n` +
          `def shared_root(value):\n    return shared_middle(value)\n`,
      );
    }
    fs.writeFileSync(
      path.join(testDir, 'rung3b.grove.py'),
      `def skel_collapse(value):\n    return value\n\n` +
        `def solve(value):\n    return skel_collapse(value)\n\n` +
        `def roof(value):\n    return solve(value)\n\n` +
        `def skel_cap_emit(value):\n    return value\n\n` +
        `def pinned_only(value):\n    return value\n`,
    );
    fs.writeFileSync(
      path.join(testDir, 'rung3b-k1-trace.grove.py'),
      `def zone(value):\n    return value\n\n` +
        `def flow(value):\n    return zone(value)\n\n` +
        `def show(value):\n    return flow(value)\n\n` +
        `def solve(value):\n    return value\n\n` +
        `def roof(value):\n    return solve(value)\n\n` +
        `def skel_cap_emit(value):\n    return value\n`,
    );
    fs.writeFileSync(
      path.join(testDir, 'rung3b_eavez_decoupled.grove.py'),
      `def solve(value):\n    return value\n\n` +
        `def roof(value):\n    return solve(value)\n\n` +
        `def skel_cap_emit(value):\n    return value\n`,
    );
    fs.writeFileSync(
      path.join(testDir, 'entry.py'),
      `from external import ExternalHelper\n\n` +
        `def current_root(value):\n    return ExternalHelper(value)\n`,
    );
    fs.writeFileSync(
      path.join(testDir, 'consumer.py'),
      `from rung3b.grove import pinned_only\n\n` +
        `def pinned_consumer(value):\n    return pinned_only(value)\n`,
    );
    fs.writeFileSync(
      path.join(testDir, 'external.py'),
      `def finalize_result(value):\n    return value\n\n` +
        `def ExternalHelper(value):\n    return finalize_result(value)\n`,
    );
    cg = CodeGraph.initSync(testDir);
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    cg?.destroy();
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('keeps qualified flow symbols in the pinned file beyond the fuzzy-search cap', async () => {
    const exactPath = 'snapshots/snapshot_59.py';
    const result = await handler.execute('codegraph_explore', {
      query:
        `${exactPath} snapshot_59.shared_root ` +
        'snapshot_59.shared_middle snapshot_59.shared_leaf',
      maxFiles: 4,
    });
    const text = result.content?.[0]?.text ?? '';
    const flow = text.split('> Full source for these symbols is below')[0] ?? '';

    expect(flow).toContain(`shared_root (${exactPath}:7)`);
    expect(flow).toContain(`calls @${exactPath}:8`);
    expect(flow).toContain(`shared_middle (${exactPath}:4)`);
    expect(flow).toContain(`calls @${exactPath}:5`);
    expect(flow).toContain(`shared_leaf (${exactPath}:1)`);
    expect(flow).not.toContain('snapshot_00.py');
  });

  it('confines natural-language flow selection to an explicitly pinned file', async () => {
    const exactPath = 'rung3b.grove.py';
    const result = await handler.execute('codegraph_explore', {
      query:
        `In ${exactPath} show the exact roof to solve to skel_collapse dependency ` +
        'and tuple flow, including zone ownership. Do not substitute a same-named group from another file.',
      maxFiles: 6,
    });
    const text = result.content?.[0]?.text ?? '';
    const flow = text.split('> Full source for these symbols is below')[0] ?? '';

    expect(flow).toContain(`roof (${exactPath}:7)`);
    expect(flow).toContain(`calls @${exactPath}:8`);
    expect(flow).toContain(`solve (${exactPath}:4)`);
    expect(flow).toContain(`calls @${exactPath}:5`);
    expect(flow).toContain(`skel_collapse (${exactPath}:1)`);
    expect(flow).not.toContain('rung3b-k1-trace.grove.py');
  });

  it('keeps explicitly named precise cross-file dependencies available', async () => {
    const result = await handler.execute('codegraph_explore', {
      query: 'In entry.py show current_root ExternalHelper finalize_result',
      maxFiles: 4,
    });
    const text = result.content?.[0]?.text ?? '';
    const flow = text.split('> Full source for these symbols is below')[0] ?? '';

    expect(flow).toContain('current_root (entry.py:3)');
    expect(flow).toContain('ExternalHelper (external.py:4)');
    expect(flow).toContain('finalize_result (external.py:1)');
  });

  it('does not render same-named snapshot sources when an exact file is pinned', async () => {
    const result = await handler.execute('codegraph_explore', {
      query:
        'In exact file rung3b.grove.py trace the current public FlatTop and MaxRise inputs ' +
        'through roof and solve to stop-time selection and skel_cap_emit. Show the owning ' +
        'Repeat Zone and tuple bindings. Do not substitute any same-named group from another file.',
      maxFiles: 4,
    });
    const text = result.content?.[0]?.text ?? '';
    const source = text.split('**Source Code**')[1] ?? '';

    expect(source).toContain('**`rung3b.grove.py`**');
    expect(source).not.toContain('**`rung3b-k1-trace.grove.py`**');
    expect(source).not.toContain('**`rung3b_eavez_decoupled.grove.py`**');
  });

  it('keeps exact-file blast radius free of snapshot symbols but retains connected callers', async () => {
    const result = await handler.execute('codegraph_explore', {
      query:
        'In exact file rung3b.grove.py trace solve, skel_cap_emit, and pinned_only and show ' +
        'the caller inventory. Do not substitute any same-named group from another file.',
      maxFiles: 4,
    });
    const text = result.content?.[0]?.text ?? '';
    const blast = (
      text.split('**Blast radius — what depends on these (update/verify before editing)**')[1] ?? ''
    ).split('**Source Code**')[0] ?? '';

    expect(blast).toContain('`consumer.py`');
    expect(blast).not.toContain('rung3b-k1-trace.grove.py');
    expect(blast).not.toContain('rung3b_eavez_decoupled.grove.py');
  });

  it('does not select an unrelated precise off-file flow under an exact pin', async () => {
    const result = await handler.execute('codegraph_explore', {
      query: 'In rung3b.grove.py Show Flow Zone',
      maxFiles: 4,
    });
    const text = result.content?.[0]?.text ?? '';

    expect(text).not.toContain('1. show (rung3b-k1-trace.grove.py:7)');
    expect(text).not.toContain('2. flow (rung3b-k1-trace.grove.py:4)');
    expect(text).not.toContain('3. zone (rung3b-k1-trace.grove.py:1)');
  });
});
