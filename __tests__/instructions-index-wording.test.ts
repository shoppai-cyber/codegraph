/**
 * Fork-local: an unindexed repository is indexed, one job at a time
 * (the user, 2026-10-01). The installed instructions block and the CLI's
 * "no index" error must not tell agents to skip CodeGraph or to leave
 * indexing to the user.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CODEGRAPH_INSTRUCTIONS_BLOCK } from '../src/installer/instructions-template';

describe('index-missing wording', () => {
  it('instructions block asks for the index, one indexing job at a time', () => {
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).not.toMatch(/skip CodeGraph entirely/);
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).not.toMatch(/indexing is the user's decision/);
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toMatch(/create the index before relying on it/);
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toMatch(/one CodeGraph indexing job/);
  });

  it('CLI no-index errors no longer forbid indexing', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'bin', 'codegraph.ts'), 'utf8');
    expect(src).not.toMatch(/do not run it yourself/);
    expect(src.match(/one CodeGraph indexing job on the host at a time/g)?.length).toBe(2);
  });

  it('MCP server instructions and not-indexed error no longer forbid indexing', () => {
    const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp', p), 'utf8');
    const instructions = read('server-instructions.ts');
    const tools = read('tools.ts');
    expect(instructions).not.toMatch(/Indexing is the user's decision/);
    expect(instructions.match(/one CodeGraph indexing job on the host at a time/g)?.length).toBe(2);
    expect(tools).not.toMatch(/Indexing is the user's decision/);
    expect(tools).toMatch(/one CodeGraph indexing job on the host at a time/);
  });
});
