import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const ATTRIBUTION_CLASSES = ['codegraph', 'origin-repo', 'environment', 'unknown'] as const;

type AttributionClass = (typeof ATTRIBUTION_CLASSES)[number];

interface IssueReportInput {
  schemaVersion: 1;
  title: string;
  originRepo: string;
  codegraphVersion: string;
  indexSchemaVersion: number;
  command: string;
  filePath: string;
  fileHash: string;
  expectedBehavior: string;
  actualBehavior: string;
  attributionClass: AttributionClass;
  evidencePointer: string;
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

interface Fixture {
  root: string;
  originRepo: string;
  carrier: string;
  sourcePath: string;
  evidencePath: string;
}

function makeTempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-issue-inbox-${label}-`));
}

function sha256(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeFixture(): Fixture {
  const root = makeTempDir('fixture');
  const originRepo = path.join(root, 'origin-repo');
  const carrier = path.join(root, 'carrier');
  const sourcePath = path.join(originRepo, 'src', 'example.ts');
  const evidencePath = path.join(originRepo, 'evidence', 'run.txt');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(sourcePath, 'export function example(): string { return "ok"; }\n');
  fs.writeFileSync(evidencePath, 'captured source evidence\n');
  return { root, originRepo, carrier, sourcePath, evidencePath };
}

function makeReport(fixture: Fixture, title = 'Example report'): IssueReportInput {
  return {
    schemaVersion: 1,
    title,
    originRepo: fixture.originRepo,
    codegraphVersion: '1.6.0',
    indexSchemaVersion: 9,
    command: 'codegraph explore example',
    filePath: fixture.sourcePath,
    fileHash: sha256(fixture.sourcePath),
    expectedBehavior: 'The source symbol is returned by CodeGraph.',
    actualBehavior: 'The source symbol is absent from the result.',
    attributionClass: 'codegraph',
    evidencePointer: fixture.evidencePath,
  };
}

function writeInput(fixture: Fixture, report: Record<string, unknown>, name = 'report.json'): string {
  const inputPath = path.join(fixture.root, name);
  fs.writeFileSync(inputPath, JSON.stringify(report, null, 2) + '\n');
  return inputPath;
}

function runCodegraph(args: string[], cwd: string, carrier: string): CliResult {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEGRAPH_NO_DAEMON: '1',
      CODEGRAPH_ISSUE_INBOX_DIR: carrier,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function spawnCodegraph(args: string[], cwd: string, carrier: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: {
        ...process.env,
        CODEGRAPH_NO_DAEMON: '1',
        CODEGRAPH_ISSUE_INBOX_DIR: carrier,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => resolve({ status: null, stdout, stderr, error }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function parseSummary(result: CliResult): {
  carrier: string;
  reportCount: number;
  reports: Array<Record<string, string>>;
} {
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout) as {
    carrier: string;
    reportCount: number;
    reports: Array<Record<string, string>>;
  };
}

function reportFiles(carrier: string): string[] {
  const reportsDir = path.join(carrier, 'reports');
  if (!fs.existsSync(reportsDir)) return [];
  return fs.readdirSync(reportsDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(reportsDir, name));
}

describe('passive CodeGraph issue inbox', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  it('files a valid provenance-bound report and returns its isolated location', () => {
    const inputPath = writeInput(fixture, makeReport(fixture));
    const filed = runCodegraph(['inbox', 'file', '--input', inputPath], fixture.originRepo, fixture.carrier);

    expect(filed.status, filed.stderr).toBe(0);
    expect(filed.stdout).toMatch(/Filed issue report/);
    const summary = parseSummary(runCodegraph(['inbox', 'summary'], fixture.originRepo, fixture.carrier));
    expect(summary.reportCount).toBe(1);
    expect(summary.carrier).toBe(path.resolve(fixture.carrier));
    expect(summary.reports[0]).toMatchObject({
      originRepo: fixture.originRepo,
      filePath: fixture.sourcePath,
      title: 'Example report',
      attributionClass: 'codegraph',
    });
    expect(fs.existsSync(summary.reports[0]!.reportPath)).toBe(true);
  });

  it('rejects an unknown field in the closed input schema', () => {
    const input = { ...makeReport(fixture), extra: 'not allowed' };
    const filed = runCodegraph(
      ['inbox', 'file', '--input', writeInput(fixture, input)],
      fixture.originRepo,
      fixture.carrier,
    );

    expect(filed.status).not.toBe(0);
    expect(filed.stderr).toMatch(/unknown field.*extra/i);
    expect(parseSummary(runCodegraph(['inbox', 'summary'], fixture.originRepo, fixture.carrier)).reportCount).toBe(0);
  });

  it('rejects a missing required provenance field', () => {
    const input = makeReport(fixture) as unknown as Record<string, unknown>;
    delete input.evidencePointer;
    const filed = runCodegraph(
      ['inbox', 'file', '--input', writeInput(fixture, input)],
      fixture.originRepo,
      fixture.carrier,
    );

    expect(filed.status).not.toBe(0);
    expect(filed.stderr).toMatch(/evidencePointer.*required/i);
  });

  it('rejects a nonexistent source path', () => {
    const input = makeReport(fixture) as unknown as Record<string, unknown>;
    input.filePath = path.join(fixture.originRepo, 'missing.ts');
    const filed = runCodegraph(
      ['inbox', 'file', '--input', writeInput(fixture, input)],
      fixture.originRepo,
      fixture.carrier,
    );

    expect(filed.status).not.toBe(0);
    expect(filed.stderr).toMatch(/filePath.*does not exist/i);
  });

  it('rejects a non-absolute source path', () => {
    const input = makeReport(fixture) as unknown as Record<string, unknown>;
    input.filePath = 'src/example.ts';
    const filed = runCodegraph(
      ['inbox', 'file', '--input', writeInput(fixture, input)],
      fixture.originRepo,
      fixture.carrier,
    );

    expect(filed.status).not.toBe(0);
    expect(filed.stderr).toMatch(/filePath.*absolute/i);
  });

  it('rejects a source hash mismatch', () => {
    const input = { ...makeReport(fixture), fileHash: '0'.repeat(64) };
    const filed = runCodegraph(
      ['inbox', 'file', '--input', writeInput(fixture, input)],
      fixture.originRepo,
      fixture.carrier,
    );

    expect(filed.status).not.toBe(0);
    expect(filed.stderr).toMatch(/fileHash.*does not match/i);
  });

  it('rejects an invalid attribution class', () => {
    const input = { ...makeReport(fixture), attributionClass: 'guessing' };
    const filed = runCodegraph(
      ['inbox', 'file', '--input', writeInput(fixture, input)],
      fixture.originRepo,
      fixture.carrier,
    );

    expect(filed.status).not.toBe(0);
    expect(filed.stderr).toMatch(/attributionClass.*codegraph.*origin-repo.*environment.*unknown/i);
  });

  it('deduplicates repeated identical reports by deterministic content identity', () => {
    const inputPath = writeInput(fixture, makeReport(fixture));
    const first = runCodegraph(['inbox', 'file', '--input', inputPath], fixture.originRepo, fixture.carrier);
    const second = runCodegraph(['inbox', 'file', '--input', inputPath], fixture.originRepo, fixture.carrier);

    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toMatch(/already filed|duplicate/i);
    expect(parseSummary(runCodegraph(['inbox', 'summary'], fixture.originRepo, fixture.carrier)).reportCount).toBe(1);
    expect(reportFiles(fixture.carrier)).toHaveLength(1);
  });

  it('files concurrent unique submissions without corrupting or inflating records', async () => {
    const inputs = Array.from({ length: 4 }, (_, index) => writeInput(
      fixture,
      makeReport(fixture, `Concurrent report ${index}`),
      `report-${index}.json`,
    ));
    const results = await Promise.all(inputs.flatMap((inputPath) => [
      spawnCodegraph(['inbox', 'file', '--input', inputPath], fixture.originRepo, fixture.carrier),
      spawnCodegraph(['inbox', 'file', '--input', inputPath], fixture.originRepo, fixture.carrier),
    ]));

    expect(results.every((result) => result.status === 0), results.map((r) => r.stderr || r.stdout).join('\n')).toBe(true);
    const summary = parseSummary(runCodegraph(['inbox', 'summary'], fixture.originRepo, fixture.carrier));
    expect(summary.reportCount).toBe(4);
    expect(reportFiles(fixture.carrier)).toHaveLength(4);
    for (const file of reportFiles(fixture.carrier)) {
      expect(() => JSON.parse(fs.readFileSync(file, 'utf8'))).not.toThrow();
    }
    expect(fs.readdirSync(path.join(fixture.carrier, 'reports')).some((name) => name.includes('.tmp.'))).toBe(false);
  });

  it('returns a byte-deterministic summary with exact report locations', () => {
    for (let index = 0; index < 2; index += 1) {
      const inputPath = writeInput(fixture, makeReport(fixture, `Summary report ${index}`), `summary-${index}.json`);
      const filed = runCodegraph(['inbox', 'file', '--input', inputPath], fixture.originRepo, fixture.carrier);
      expect(filed.status, filed.stderr).toBe(0);
    }

    const first = runCodegraph(['inbox', 'summary'], fixture.originRepo, fixture.carrier);
    const second = runCodegraph(['inbox', 'summary'], fixture.originRepo, fixture.carrier);
    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(first.stdout).toBe(second.stdout);
    const summary = parseSummary(first);
    expect(summary.reportCount).toBe(2);
    expect(summary.reports.map((report) => report.reportPath)).toEqual(
      [...summary.reports.map((report) => report.reportPath)].sort(),
    );
    expect(summary.reports.every((report) => path.isAbsolute(report.reportPath!))).toBe(true);
  });

  it('does not dirty the product or origin Git worktrees while filing', () => {
    spawnSync('git', ['init', '--quiet'], { cwd: fixture.originRepo, stdio: 'ignore' });
    const productBefore = spawnSync('git', ['status', '--short'], { cwd: process.cwd(), encoding: 'utf8' }).stdout;
    const originBefore = spawnSync('git', ['status', '--short'], { cwd: fixture.originRepo, encoding: 'utf8' }).stdout;
    const inputPath = writeInput(fixture, makeReport(fixture));

    const filed = runCodegraph(['inbox', 'file', '--input', inputPath], fixture.originRepo, fixture.carrier);
    expect(filed.status, filed.stderr).toBe(0);

    const productAfter = spawnSync('git', ['status', '--short'], { cwd: process.cwd(), encoding: 'utf8' }).stdout;
    const originAfter = spawnSync('git', ['status', '--short'], { cwd: fixture.originRepo, encoding: 'utf8' }).stdout;
    expect(productAfter).toBe(productBefore);
    expect(originAfter).toBe(originBefore);
    const summary = parseSummary(runCodegraph(['inbox', 'summary'], fixture.originRepo, fixture.carrier));
    expect(path.resolve(summary.carrier)).not.toContain(path.resolve(fixture.originRepo));
    expect(path.resolve(summary.carrier)).not.toContain(path.resolve(process.cwd()));
  });
});
