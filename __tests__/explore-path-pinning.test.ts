/**
 * End-to-end gate for query-path pinning + the segment-vocab supplement +
 * variable seeding, on the bug that motivated all three: an agent named a
 * SvelteKit route file by exact path plus behavior words ("scrollToBottom,
 * onscroll, atBottom tracking") and got back neither the file's scroll code
 * nor the file itself at full weight — the bracketed path was tokenizer
 * shrapnel (`runId` seeded as a named symbol, every sibling `+page` admitted)
 * and the camelCase scroll symbols were FTS-opaque.
 *
 * The fixture mirrors that shape in plain TS (bracket/paren directories are
 * the crux, not the language): a target file under
 * `src/routes/m/projects/[id]/runs/[runId]/` holding `feedAtBottom` /
 * `handleFeedScroll` / `pinFeedIfNearBottom`, a decoy chat-window page under
 * a `(protected)` route group, and a runs-store decoy defining `runId` and
 * `Scope` — the two symbols that headlined the original junk blast radius.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

const FIXTURE = 'explore-path-pinning';
const TARGET = 'src/routes/m/projects/[id]/runs/[runId]/+page.ts';
const DECOY_CHAT = 'src/routes/(protected)/chat-window/+page.ts';

let dir: string;
let cg: CodeGraph;

async function explore(query: string): Promise<string> {
  const res = await new ToolHandler(cg).execute('codegraph_explore', { query });
  return res.content?.[0]?.text ?? '';
}

/** The response renders a source section for `file`. */
const hasSection = (response: string, file: string): boolean =>
  response.includes('**`' + file + '`');

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-path-pin-'));
  fs.cpSync(path.join(__dirname, 'fixtures', FIXTURE), dir, { recursive: true });
  fs.rmSync(path.join(dir, '.codegraph'), { recursive: true, force: true });
  cg = CodeGraph.initSync(dir);
  await cg.indexAll();
}, 180_000);

afterAll(() => {
  cg?.destroy();
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('fixture shape — if this rots, the gates below mean nothing', () => {
  it('indexes the bracketed-path target with its scroll symbols', () => {
    const names = cg.getNodesInFile(TARGET).map((n) => n.name);
    expect(names).toContain('feedAtBottom');
    expect(names).toContain('handleFeedScroll');
    expect(names).toContain('pinFeedIfNearBottom');
  });
});

describe('path pinning (fix 1)', () => {
  it('a pure-path query renders the named file and says it was pinned', async () => {
    const out = await explore(TARGET);
    expect(hasSection(out, TARGET)).toBe(true);
    expect(out).toContain('pinned from the query');
  });

  it('the original bug-shaped query renders the pinned file, not path shrapnel', async () => {
    const out = await explore(
      `run page auto-scroll to bottom logic in ${TARGET} — scrollToBottom, onscroll, atBottom tracking`,
    );
    expect(hasSection(out, TARGET)).toBe(true);
    // The path fragments must not seed: `runId` (runs-store decoy) and the
    // bracketed segment's namesakes headlined the original junk blast radius.
    const blast = out.split('**Relationships**')[0]!;
    expect(blast).not.toMatch(/`runId` \(src\/lib\/runs-store\.ts/);
    // The chat decoy MAY render — it genuinely holds scroll-pinning code the
    // segment supplement now finds — but the pinned file must rank first.
    // (Pre-fix, `+page`/`runs` shrapnel admitted the siblings ABOVE the named
    // file and the envelope truncated it.)
    const decoyAt = out.indexOf('**`' + DECOY_CHAT + '`');
    const targetAt = out.indexOf('**`' + TARGET + '`');
    expect(targetAt).toBeGreaterThan(-1);
    if (decoyAt !== -1) expect(targetAt).toBeLessThan(decoyAt);
  });

  it('an unresolvable path is reported, not silently dropped', async () => {
    const out = await explore('crash in src/routes/gone/missing-page.ts on load');
    expect(out).toContain('No indexed file uniquely matches');
    expect(out).toContain('src/routes/gone/missing-page.ts');
  });

  it('fails closed when every explicitly named source basename is unavailable', async () => {
    const out = await explore(
      'In the exact current files test_gn_roof_flat_top.py and probe_k3_semantic_output.py, ' +
      'show feedAtBottom, handleFeedScroll, and runId. Do not substitute indexed snapshots.',
    );

    expect(out).toContain('No indexed file uniquely matches');
    expect(out).toContain('test_gn_roof_flat_top.py');
    expect(out).toContain('probe_k3_semantic_output.py');
    expect(out).not.toContain('**Flow**');
    expect(out).not.toContain('**Dataflow**');
    expect(out).not.toContain('**Blast radius');
    expect(out).not.toContain('**Source Code**');
  });

  it('fails closed for an unavailable Windows path', async () => {
    const out = await explore(
      String.raw`In exact file C:\repo\tests\test_missing_helper.py show feedAtBottom and runId`,
    );

    expect(out).toContain('No indexed file uniquely matches');
    expect(out).toContain('C:/repo/tests/test_missing_helper.py');
    expect(out).not.toContain('**Source Code**');
  });

  it('fails closed for exact missing files when the index contains zero files', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-empty-path-pin-'));
    const emptyCg = CodeGraph.initSync(emptyDir);
    try {
      await emptyCg.indexAll();
      const result = await new ToolHandler(emptyCg).execute('codegraph_explore', {
        query: String.raw`In exact files test_missing_helper.py and C:\repo\tests\probe_missing.py show fixtures`,
      });
      const out = result.content?.[0]?.text ?? '';

      expect(out).toContain('No indexed file uniquely matches');
      expect(out).toContain('test_missing_helper.py');
      expect(out).toContain('C:/repo/tests/probe_missing.py');
      expect(out).not.toContain('**Flow**');
      expect(out).not.toContain('**Dataflow**');
      expect(out).not.toContain('**Blast radius');
      expect(out).not.toContain('**Source Code**');
    } finally {
      emptyCg.destroy();
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('keeps a present exact file and identifies a missing source basename', async () => {
    const out = await explore(
      `In the exact current files ${TARGET} and test_missing_helper.py show feedAtBottom and handleFeedScroll`,
    );

    expect(hasSection(out, TARGET)).toBe(true);
    expect(out).toContain('No indexed file uniquely matches');
    expect(out).toContain('test_missing_helper.py');
    expect(hasSection(out, DECOY_CHAT)).toBe(false);
  });
});

describe('extension-less kebab basenames (the amnisphere gap)', () => {
  const KEBAB_TARGET = 'src/lib/background-image-table.ts';

  it('a bare kebab basename — no slash, no extension — pins and renders its file', async () => {
    // Pre-fix this query never opened the path gate; FTS shredded the token
    // into `background`/`image`/`table` and served the fragment decoy instead.
    const out = await explore('background-image-table Source column');
    expect(hasSection(out, KEBAB_TARGET)).toBe(true);
    expect(out).toContain('pinned from the query');
  });

  it('kebab prose that names no file is not reported as an unresolved path', async () => {
    const out = await explore('how does cross-call dedup interact with feed scroll pinning');
    expect(out).not.toContain('No indexed file uniquely matches');
  });
});

describe('segment supplement + variable seeding (fixes 2–3)', () => {
  it('word-level scroll terms reach the camelCase scroll code without a path', async () => {
    const out = await explore('feed auto-scroll to bottom pinning behavior');
    expect(hasSection(out, TARGET)).toBe(true);
  });

  it('a camel infix naming only $state-style variables still finds their file', async () => {
    const out = await explore('where does the atBottom flag get reset');
    expect(hasSection(out, TARGET)).toBe(true);
  });
});
