import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
// bin/meta.ts, NOT src/index.ts — the latter is a module with nothing at module
// scope, so running it exits 0 having written nothing, which reads like success.
const CLI = resolve(REPO_ROOT, "server/typescript/packages/cli/bin/meta.ts");

export function captureTranscript(argv: string[], cwd: string):
  { text: string; exitCode: number } {
  const r = spawnSync("bun", [CLI, ...argv], { cwd, encoding: "utf8" });
  return { text: `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd(), exitCode: r.status ?? 1 };
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
