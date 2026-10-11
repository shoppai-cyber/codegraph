import * as os from 'os';

/**
 * Lower the stdio MCP server to below-normal CPU priority.
 *
 * Every agent session starts its own `serve --mcp` process, each with a file
 * watcher. Measured 2026-10-11 on a Windows host: 26 of them ran at Normal
 * priority alongside the user's terminal agents, two having used 8,159 s and
 * 5,304 s of CPU. Below normal keeps queries quick while interactive work
 * wins the CPU. A background daemon runs this same command, so it lowers
 * itself; the liveness watchdog is spawned after this call and inherits
 * below-normal on Windows. Failure is ignored: a server at Normal priority
 * still works.
 *
 * Returns true when the priority was lowered.
 */
export function lowerServePriority(
  setPriority: (pid: number, priority: number) => void = os.setPriority,
): boolean {
  try {
    setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
    return true;
  } catch {
    return false;
  }
}
