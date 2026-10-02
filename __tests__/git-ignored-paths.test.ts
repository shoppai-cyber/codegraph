/**
 * `withGitIgnoredPaths` (fork-only, src/extraction/git-ignored-paths.ts).
 *
 * `buildScopeIgnore` seeds every ignored-untracked entry git lists (#1728).
 * Upstream added each one to the `ignore` matcher as a pattern, which made a
 * check O(entries); one Blender repo's 18,016 entries turned its scan into
 * 250 s of main-thread work. These tests hold the replacement to the same
 * answer as upstream's matcher for every path, and to O(depth) cost.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildDefaultIgnore } from '../src/extraction';
import { withGitIgnoredPaths } from '../src/extraction/git-ignored-paths';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-git-ignored-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** Upstream's matcher: every entry added to the root matcher as a pattern. */
function upstream(entries: string[]) {
  const ig = buildDefaultIgnore(root);
  for (const e of entries) ig.add(e);
  return ig;
}

function ours(entries: string[]) {
  return withGitIgnoredPaths(buildDefaultIgnore(root), entries);
}

function expectSameAnswers(entries: string[], paths: string[]) {
  const theirs = upstream(entries);
  const mine = ours(entries);
  for (const p of paths) expect(mine.ignores(p), p).toBe(theirs.ignores(p));
}

/** Deterministic PRNG (mulberry32) so a failure reproduces. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('withGitIgnoredPaths', () => {
  it('gives upstream\'s answer for literal, case-variant, syntax and odd-separator paths', () => {
    const entries = [
      'gate/runs/r1/',
      'gate/runs/r2/cap/',
      'gate/runs/r3/stderr.bin/', // a file entry, as listGitIgnoredDirectories writes it
      'Gate/Mixed/Case/',
      'build/', // one segment: gitignore matches it at any depth
      'odd/[x]/',
      'odd/a*b/',
      'odd/q?/',
      'odd/back\\slash/',
      '#hash/dir/',
      '/lead/dir/',
      'sp ace/dir/',
      'ünï/dir/',
      'tab\there/x/',
    ];
    const paths = [
      'src/a.ts', 'gate/runs/r1/x.ts', 'GATE/RUNS/R1/X.TS', 'gate/runs/r1/', 'gate/runs/r1',
      'gate/runs/r10/x.ts', 'gate/runs/r2/cap/deep/y.py', 'gate/runs/r2/x.ts',
      'gate/runs/r3/stderr.bin', 'gate/runs/r3/stderr.bin/', 'gate/mixed/case/z.ts',
      'pkg/build/x.ts', 'build/x.ts', 'odd/x/f.ts', 'odd/[x]/f.ts', 'odd/aZZb/f.ts', 'odd/q1/f.ts',
      'odd/back\\slash/f.ts', 'odd/back/slash/f.ts', '#hash/dir/f.ts', 'lead/dir/f.ts',
      'sp ace/dir/f.ts', 'ünï/dir/f.ts', 'ÜNÏ/dir/f.ts', 'tab\there/x/f.ts',
      'gate\\runs\\r1\\x.ts', 'gate//runs/r1/x.ts', 'gate/runs//r1/x.ts',
      'node_modules/p/i.js', 'x/node_modules/p/i.js',
    ];
    expectSameAnswers(entries, paths);
    // Not vacuous: both answers occur.
    const mine = ours(entries);
    expect(mine.ignores('gate/runs/r1/x.ts')).toBe(true);
    expect(mine.ignores('GATE/RUNS/R1/X.TS')).toBe(true);
    expect(mine.ignores('pkg/build/x.ts')).toBe(true);
    expect(mine.ignores('gate/runs/r10/x.ts')).toBe(false);
    expect(mine.ignores('gate/runs/r3/stderr.bin')).toBe(false);
    expect(mine.ignores('src/a.ts')).toBe(false);
  });

  it('keeps upstream\'s ordered patterns when an entry is a negation', () => {
    // A directory named `!a` reads as `!a/b/`, which un-ignores `a/b/`.
    expectSameAnswers(['a/b/', '!a/b/', 'c/d/'], ['a/b/x.ts', 'a/b/', '!a/b/x.ts', 'c/d/x.ts', 'e.ts']);
  });

  it('gives upstream\'s answer on randomized entries and paths', () => {
    const next = rng(1728);
    const segments = ['a', 'B', 'c1', 'gate', 'Runs', 'build', 'x.bin', 'ü', 'q?', '[z]', 's p', '#h', 'a*', 'D.E'];
    const pick = () => segments[Math.floor(next() * segments.length)];
    const join = (n: number, sep: () => string) => {
      let s = pick();
      for (let i = 1; i < n; i++) s += sep() + pick();
      return s;
    };
    const entries = Array.from({ length: 300 }, () => `${join(1 + Math.floor(next() * 4), () => '/')}/`);
    const sep = () => {
      const r = next();
      return r < 0.85 ? '/' : r < 0.95 ? '\\' : '//';
    };
    const paths = Array.from({ length: 3000 }, () => {
      const p = join(1 + Math.floor(next() * 6), sep);
      return next() < 0.3 ? `${p}/` : p;
    });
    expectSameAnswers(entries, paths);
  });

  it('checks 30,000 paths against 18,000 literal entries quickly, with upstream\'s answers', () => {
    // The Blender shape: ignored capture files beside tracked receipts in the same run directories.
    const entries = Array.from(
      { length: 18_000 },
      (_, i) => `gate/runs/run-${i % 600}/attempts/attempt-${i}/capture/stderr.bin/`,
    );
    entries.push('gate/runs/run-7/scratch/');
    const paths = Array.from({ length: 30_000 }, (_, i) =>
      i % 3 === 0 ? `src/mod-${i % 97}/file-${i}.py` : `gate/runs/run-${i % 600}/attempts/attempt-${i}/receipt.json`,
    );
    paths.push('gate/runs/run-7/scratch/note.py');

    const mine = ours(entries);
    const started = Date.now();
    const ignored = paths.filter((p) => mine.ignores(p));
    const elapsed = Date.now() - started;
    expect(ignored).toEqual(['gate/runs/run-7/scratch/note.py']);
    // Upstream's per-pattern matcher needs minutes for this; O(depth) needs milliseconds.
    expect(elapsed).toBeLessThan(5_000);

    const theirs = upstream(entries);
    for (const p of [...paths.slice(0, 40), 'gate/runs/run-7/scratch/note.py']) {
      expect(mine.ignores(p), p).toBe(theirs.ignores(p));
    }
  }, 60_000);
});
