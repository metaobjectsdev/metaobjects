import { createHash } from "node:crypto";
import type { AssembledFile, Stack } from "./types.js";

/** Consumer-relative path of the sidecar manifest that tracks scaffolded files. */
export const AGENT_CONTEXT_MANIFEST_PATH = ".metaobjects/.agent-context.json";

export interface Manifest {
  version: 1;
  servers: string[];
  clients: string[];
  /** consumer-relative path → sha256 of the contents as last scaffolded. */
  files: Record<string, string>;
}

export function hashContents(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export interface ScaffoldDecision {
  /** files to (over)write at their own path: new, or unmodified-since-last-scaffold. */
  writes: { path: string; contents: string }[];
  /** hand-edited files: write the fresh contents to `<path>.new`, leave the original. */
  conflicts: { path: string; newPath: string; contents: string }[];
  /** the manifest to persist after writing. */
  manifest: Manifest;
  /** paths the prior manifest tracked that are no longer assembled (e.g. stack shrank) — reported, never auto-deleted. */
  removed: string[];
}

/**
 * Decide what to write for a (re-)scaffold. Pure: filesystem access is via the
 * `readCurrent` callback (returns the on-disk contents, or undefined if absent).
 * A file is safe to overwrite iff it is absent, or its on-disk hash still equals
 * the hash the prior manifest recorded (i.e. the user hasn't hand-edited it).
 */
export function planScaffold(opts: {
  stack: Stack;
  assembled: AssembledFile[];
  prior: Manifest | undefined;
  readCurrent: (path: string) => string | undefined;
}): ScaffoldDecision {
  const { stack, assembled, prior, readCurrent } = opts;
  const writes: ScaffoldDecision["writes"] = [];
  const conflicts: ScaffoldDecision["conflicts"] = [];
  const files: Record<string, string> = {};

  for (const f of assembled) {
    files[f.path] = hashContents(f.contents);
    const current = readCurrent(f.path);
    if (current === undefined) {
      writes.push({ path: f.path, contents: f.contents });
      continue;
    }
    const priorHash = prior?.files[f.path];
    if (priorHash !== undefined && hashContents(current) === priorHash) {
      writes.push({ path: f.path, contents: f.contents }); // unmodified → refresh to latest
    } else {
      conflicts.push({ path: f.path, newPath: `${f.path}.new`, contents: f.contents });
    }
  }

  const assembledPaths = new Set(assembled.map((f) => f.path));
  const removed = prior ? Object.keys(prior.files).filter((p) => !assembledPaths.has(p)) : [];

  return {
    writes,
    conflicts,
    manifest: { version: 1, servers: stack.servers, clients: stack.clients, files },
    removed,
  };
}
