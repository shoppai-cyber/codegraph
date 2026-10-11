import * as os from 'os';
import { describe, expect, it } from 'vitest';
import { lowerServePriority } from '../src/bin/serve-priority';

describe('lowerServePriority', () => {
  it('asks for below-normal priority on the current process', () => {
    const calls: Array<[number, number]> = [];
    expect(lowerServePriority((pid, priority) => calls.push([pid, priority]))).toBe(true);
    expect(calls).toEqual([[0, os.constants.priority.PRIORITY_BELOW_NORMAL]]);
  });

  it('keeps the server running when the priority cannot be changed', () => {
    expect(lowerServePriority(() => { throw new Error('EPERM'); })).toBe(false);
  });
});
