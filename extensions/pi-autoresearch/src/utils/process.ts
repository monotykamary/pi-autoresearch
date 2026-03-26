/**
 * Process management and file utilities
 */

import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

/** Kill a process tree (best effort, tries process group first) */
export function killTree(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have already exited
    }
  }
}

/** Lazy temp file allocator — returns the same path on subsequent calls */
export function createTempFileAllocator(): () => string {
  let p: string | undefined;
  return () => {
    if (!p) {
      const id = randomBytes(8).toString("hex");
      p = path.join(tmpdir(), `pi-experiment-${id}.log`);
    }
    return p;
  };
}
