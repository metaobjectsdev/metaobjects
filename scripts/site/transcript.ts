import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
// bin/meta.ts, NOT src/index.ts — the latter is a module with nothing at module
// scope, so running it exits 0 having written nothing, which reads like success.
const CLI = resolve(REPO_ROOT, "server/typescript/packages/cli/bin/meta.ts");

export interface Capture {
  text: string;
  exitCode: number;
  /** The signal that killed the CLI, if one did. */
  signal: NodeJS.Signals | null;
  /** Set when the CLI could not be spawned at all. */
  error: Error | undefined;
}

export function captureTranscript(argv: string[], cwd: string): Capture {
  const r = spawnSync("bun", [CLI, ...argv], { cwd, encoding: "utf8" });
  return {
    text: `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd(),
    exitCode: r.status ?? 1,
    signal: r.signal,
    error: r.error,
  };
}

/**
 * Why a capture did not RUN, or null when it did. A CLI that was killed, failed to
 * spawn, or exited non-zero having written nothing produced no transcript at all;
 * reading that as "the diagnostic changed" (or as a real verify failure) blames the
 * fixture for what the machine did.
 */
export function captureFailure(r: Capture): string | null {
  if (r.error) {
    const errno = (r.error as NodeJS.ErrnoException).code ?? r.error.message;
    return `the CLI failed to spawn (${errno}); the capture did not run`;
  }
  if (r.signal) return `the CLI was killed by ${r.signal}; the capture did not run`;
  if (r.exitCode !== 0 && r.text === "") {
    return `the CLI exited ${r.exitCode} with no output; the capture did not run`;
  }
  return null;
}

/**
 * ONE predicate, boundary-free, used by BOTH this and the payload's final sweep.
 *
 * Requiring a preceding boundary (`(^|[\s"'(])`) misses `file:///home/…`,
 * `--cwd=/home/…` and `[/home/…`; and two different predicates means the weaker one
 * runs first while the stronger one never sees what it was written for.
 */
export const HOME_PATH = /(?:\/(?:home|Users)\/|[A-Za-z]:\\Users\\)[^\s"')]+/;

/**
 * Raw CLI output carries absolute paths. This repository is PUBLIC and the payload
 * publishes to a public site, so a leaked home path would breach hygiene at the exact
 * moment nothing is watching. Repo paths become repo-relative; anything else absolute
 * and user-rooted is FATAL, never silently redacted — a redaction would hide that the
 * capture reached outside the repo at all.
 */
export function normalizeTranscript(text: string, repoRoot: string): string {
  const out = text
    .split(repoRoot + "/").join("")
    .split(repoRoot).join(".")
    // Durations would make the payload churn on every build.
    .replace(/\b\d+(\.\d+)?\s?(ms|s)\b/g, "<time>");
  const leak = HOME_PATH.exec(out);
  if (leak) {
    throw new Error(`absolute home path in transcript: ${leak[0]} — refusing to publish it`);
  }
  return out;
}
