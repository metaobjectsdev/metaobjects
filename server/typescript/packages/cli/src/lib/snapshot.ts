// Path + diff helpers for `meta prompt-snapshot`. Pure (no I/O, no metadata) so
// they unit-test trivially; the command does the filesystem work.

import { join } from "node:path";

export interface SnapshotPaths {
  /** The per-template snapshot directory: <cwd>/.metaobjects/snapshots/<name>. */
  dir: string;
  /** The committed fixture payload (author-owned input). */
  payloadPath: string;
  /** The golden rendered output (tool-managed, byte-exact). */
  snapPath: string;
}

export function snapshotPaths(cwd: string, templateName: string): SnapshotPaths {
  const dir = join(cwd, ".metaobjects", "snapshots", templateName);
  return {
    dir,
    payloadPath: join(dir, "payload.json"),
    snapPath: join(dir, "output.snap"),
  };
}

// A compact line diff: trim the common leading/trailing lines, then show the
// differing middle as `- <expected>` followed by `+ <actual>`. Enough to make
// drift reviewable in CI output without pulling in a diff dependency.
export function unifiedDiff(expected: string, actual: string): string {
  const e = expected.split("\n");
  const a = actual.split("\n");

  let pre = 0;
  while (pre < e.length && pre < a.length && e[pre] === a[pre]) pre++;

  let suf = 0;
  while (
    suf < e.length - pre &&
    suf < a.length - pre &&
    e[e.length - 1 - suf] === a[a.length - 1 - suf]
  ) {
    suf++;
  }

  const eMid = e.slice(pre, e.length - suf);
  const aMid = a.slice(pre, a.length - suf);

  const out: string[] = [`@@ line ${pre + 1} @@`];
  for (const line of eMid) out.push(`- ${line}`);
  for (const line of aMid) out.push(`+ ${line}`);
  return out.join("\n");
}
