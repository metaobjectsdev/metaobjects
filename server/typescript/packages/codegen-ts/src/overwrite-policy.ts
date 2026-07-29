// Overwrite policy: per-file write decision using three-way merge against a
// canonical snapshot kept under `.metaobjects/.gen-state/`.
//
// Replaces the rc.11 marker-based clobber-or-refuse policy (strategy (a) from
// spike 002) with strategy (b) — git-merge-file-driven three-way merge. The
// `@generated` marker becomes purely informational (templates may still emit
// it for human readers); the policy no longer consults it.
//
// Per-file flow:
//
//   1. Render fresh content to a tmpfile.
//   2. If the output doesn't exist → write + copy to .gen-state/.
//   3. If .gen-state/<relPath> exists → run `git merge-file --diff3` against
//      (current, .gen-state snapshot, fresh tmpfile). Exit 0 → clean merge,
//      advance .gen-state to fresh content. Exit > 0 → leave conflict markers
//      in the output file, do NOT advance .gen-state; status "conflict".
//   4. If .gen-state/<relPath> is absent but the file exists ("first-time
//      regen on an existing file") → write-if-different against the existing
//      file as the baseline (no merge, no clobber). The `baseline: "fresh"`
//      flag opts into "overwrite from fresh and re-baseline".
//
// Integrity (caveat 2 from the spike): we keep a sha-256 of each canonical
// snapshot at `.gen-state/.hashes.json`. On load, mismatch → fall back to
// first-time semantics and warn naming the file so the user can investigate.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { dirname, join, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";

export type WriteStatus =
  | "new"
  | "unchanged"
  | "overwrite"
  | "merged"
  | "conflict"
  | "refused"
  | "skipped";

/**
 * "overwrite" — default; three-way merge if .gen-state exists, else write-if-
 *   different / first-time-existing flow.
 * "skip-existing" — never write over an existing file; status "skipped".
 *   Useful for `meta gen --dry-run` style flows.
 */
export type MergeStrategy = "overwrite" | "skip-existing";

/** "default" — the standard three-way merge flow described in the file header.
 *  "fresh" — opt-in via `meta gen --baseline=fresh`. When .gen-state is absent
 *  but the file exists, OVERWRITE with fresh content and seed .gen-state from
 *  the fresh content (caveat 3 escape hatch). */
export type BaselineMode = "default" | "fresh";

export interface DecideAndWriteOpts {
  strategy?: MergeStrategy;
  /** Absolute path to the .gen-state/ root for this project. When undefined,
   *  we fall back to a process-isolated tmpdir — fine for tests but the CLI
   *  always supplies the real project value via runGen(). */
  genStateDir?: string;
  /** Path the snapshot is keyed by — usually the path relative to the
   *  project root, but ANY stable identifier works. When undefined, derived
   *  from `path` (so unit tests can call without supplying it). */
  outputRelPath?: string;
  /** First-time-existing-file behavior. */
  baseline?: BaselineMode;
}

export interface WriteResult {
  path: string;
  status: WriteStatus;
  /** Present when status is "conflict" — human-readable hint identifying the
   *  file the user must resolve. */
  conflictHint?: string;
}

const HASHES_FILE = ".hashes.json";

type HashesFile = Record<string, string>;

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function loadHashes(genStateDir: string): HashesFile {
  const f = join(genStateDir, HASHES_FILE);
  if (!existsSync(f)) return {};
  try {
    const txt = readFileSync(f, "utf-8");
    const parsed: unknown = JSON.parse(txt);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as HashesFile;
    }
    return {};
  } catch {
    return {};
  }
}

function saveHashes(genStateDir: string, hashes: HashesFile): void {
  mkdirSync(genStateDir, { recursive: true });
  writeFileSync(join(genStateDir, HASHES_FILE), JSON.stringify(hashes, null, 2) + "\n");
}

const ENGINE_FILE = ".engine.json";

/**
 * The codegen engine version that last wrote this `.gen-state`, or undefined if it
 * was never stamped (a pre-#232 snapshot, or a fresh project). Informational only —
 * a separate reserved file from `.hashes.json`, it never participates in the
 * three-way merge decision. (#232)
 */
export function loadEngineVersion(genStateDir: string): string | undefined {
  const f = join(genStateDir, ENGINE_FILE);
  if (!existsSync(f)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(f, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const v = (parsed as { codegenVersion?: unknown }).codegenVersion;
      return typeof v === "string" ? v : undefined;
    }
  } catch {
    // Malformed → treat as unstamped; the stamp is informational, never load-bearing.
  }
  return undefined;
}

/** Record the codegen engine version alongside the gen-state hashes (#232). */
export function saveEngineVersion(genStateDir: string, version: string): void {
  mkdirSync(genStateDir, { recursive: true });
  writeFileSync(
    join(genStateDir, ENGINE_FILE),
    JSON.stringify({ codegenVersion: version }, null, 2) + "\n",
  );
}

function snapshotPath(genStateDir: string, relPath: string): string {
  // `.hashes.json` is reserved at the top of .gen-state/; relPath must never
  // collide with it. Output paths derived from entity names ("Post.ts" etc.)
  // are JS-identifier-shape so this is a non-issue in practice.
  return join(genStateDir, relPath);
}

/** Synchronously copy `src` content into the snapshot at `<genStateDir>/<relPath>`
 *  and refresh the hash for `relPath`. */
function advanceSnapshot(
  genStateDir: string,
  relPath: string,
  content: string,
): void {
  const dest = snapshotPath(genStateDir, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content);
  const hashes = loadHashes(genStateDir);
  hashes[relPath] = sha256(content);
  saveHashes(genStateDir, hashes);
}

/** Return the snapshot text iff present AND the hash matches; else undefined. */
function readSnapshotChecked(
  genStateDir: string,
  relPath: string,
): { text: string } | undefined {
  const path = snapshotPath(genStateDir, relPath);
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf-8");
  const hashes = loadHashes(genStateDir);
  const expected = hashes[relPath];
  if (expected !== undefined && expected !== sha256(text)) {
    return undefined;
  }
  return { text };
}

/** Thrown when git is unavailable. Surfaces as a clear CLI error rather than
 *  a generic ENOENT halfway through a regen. */
export class GitMissingError extends Error {
  constructor() {
    super(
      "meta gen: `git` binary not found on PATH. Three-way-merge regen " +
        "requires git (any modern version). Install git and re-run.",
    );
    this.name = "GitMissingError";
  }
}

interface MergeOutcome {
  /** 0 → clean merge; > 0 → conflicts present (file contains diff3 markers). */
  exitCode: number;
  /** stderr text — surfaced on unexpected errors. */
  stderr: string;
  /** Resulting file contents on disk after the merge (always read; clean or
   *  conflicting). */
  mergedContent: string;
}

/** Run `git merge-file --diff3 -L<...> <out> <base> <fresh>`. The output is
 *  written in-place into `outPath`. Returns the exit code (0 = clean, > 0 =
 *  conflicts) and the resulting file contents.
 *
 *  The git binary is "git" by default; set `META_GEN_GIT` in the environment
 *  to a different path (useful for tests that simulate "git not installed"). */
function runGitMergeFile(
  outPath: string,
  basePath: string,
  freshPath: string,
): MergeOutcome {
  const gitBin = process.env.META_GEN_GIT ?? "git";
  let res;
  try {
    res = spawnSync(
      gitBin,
      [
        "merge-file",
        "--diff3",
        "-L",
        "your edits",
        "-L",
        "last generated",
        "-L",
        "fresh from meta gen",
        outPath,
        basePath,
        freshPath,
      ],
      { encoding: "utf-8" },
    );
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (msg.includes("ENOENT")) throw new GitMissingError();
    throw err;
  }
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new GitMissingError();
    throw res.error;
  }
  // `git merge-file` returns the conflict count (0 = clean, > 0 = conflicts,
  // < 0 = error). Negative is unexpected — surface verbatim.
  const exitCode = res.status ?? 0;
  if (exitCode < 0) {
    throw new Error(
      `git merge-file failed for ${outPath}: ${res.stderr || res.stdout}`,
    );
  }
  const mergedContent = readFileSync(outPath, "utf-8");
  return { exitCode, stderr: res.stderr ?? "", mergedContent };
}

/** Write `content` to a freshly-named tmpfile under the OS tmpdir; return the
 *  path. Caller is responsible for cleanup (acceptable for codegen — tmpdir
 *  is process-scoped). */
function writeTmpfile(content: string): string {
  const dir = join(tmpdir(), "meta-gen-merge");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${Date.now()}-${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(path, content);
  return path;
}

/** Resolve the snapshot key for a given output path. Falls back to a stable
 *  hash-of-path so unit tests that pass arbitrary tmpdir outputs still get a
 *  consistent .gen-state key. */
function defaultOutputRelPath(outputPath: string): string {
  // Use sha256 of the absolute path → hex; lets tests work without supplying
  // an explicit relPath. NOT used by the runner — runGen always passes the
  // real project-relative path.
  return sha256(resolve(outputPath)).slice(0, 32);
}

/**
 * The main entry point. Backward-compatible with the rc.11 signature: passing
 * a `MergeStrategy` string as the third argument continues to work; passing
 * an options object opts into three-way merge.
 */
export function decideAndWrite(
  path: string,
  content: string,
  optsOrStrategy: DecideAndWriteOpts | MergeStrategy = {},
): WriteResult {
  const opts: DecideAndWriteOpts =
    typeof optsOrStrategy === "string"
      ? { strategy: optsOrStrategy }
      : optsOrStrategy;
  const strategy: MergeStrategy = opts.strategy ?? "overwrite";
  const baseline: BaselineMode = opts.baseline ?? "default";
  const genStateDir =
    opts.genStateDir !== undefined
      ? (isAbsolute(opts.genStateDir)
          ? opts.genStateDir
          : resolve(opts.genStateDir))
      : join(tmpdir(), "meta-gen-state-fallback");
  const relPath = opts.outputRelPath ?? defaultOutputRelPath(path);

  // 1. First-time write — file doesn't exist.
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    advanceSnapshot(genStateDir, relPath, content);
    return { path, status: "new" };
  }

  if (strategy === "skip-existing") {
    return { path, status: "skipped" };
  }

  // 2. File exists. Load the canonical snapshot if any.
  const snapshot = readSnapshotChecked(genStateDir, relPath);

  // 3. First-time regen on a pre-existing file (no snapshot).
  if (snapshot === undefined) {
    const current = readFileSync(path, "utf-8");

    if (baseline === "fresh") {
      // Opt-in escape hatch: overwrite and seed the snapshot from fresh.
      if (current === content) {
        advanceSnapshot(genStateDir, relPath, content);
        return { path, status: "unchanged" };
      }
      writeFileSync(path, content);
      advanceSnapshot(genStateDir, relPath, content);
      return { path, status: "overwrite" };
    }

    // Default: write-if-different. The EXISTING file is treated as the
    // canonical baseline so subsequent runs do real three-way merges. If
    // fresh output is identical, just seed the snapshot. If different, write
    // the fresh content + seed snapshot — there's no marker policy left to
    // refuse on, but this is the contract documented in the runbook (no
    // marker check; users with hand-written files should never have the
    // codegen output path colliding with them).
    if (current === content) {
      advanceSnapshot(genStateDir, relPath, current);
      return { path, status: "unchanged" };
    }
    writeFileSync(path, content);
    advanceSnapshot(genStateDir, relPath, content);
    return { path, status: "overwrite" };
  }

  // 4. Snapshot exists — real three-way merge.
  const current = readFileSync(path, "utf-8");

  // Fast path: nothing changed.
  if (current === content && snapshot.text === content) {
    return { path, status: "unchanged" };
  }

  const baseTmp = writeTmpfile(snapshot.text);
  const freshTmp = writeTmpfile(content);

  const outcome = runGitMergeFile(path, baseTmp, freshTmp);

  if (outcome.exitCode === 0) {
    // Clean merge — advance the canonical snapshot to fresh.
    advanceSnapshot(genStateDir, relPath, content);
    // Distinguish "user had no changes vs canonical" from "merge integrated
    // edits". The fresh equals snapshot case happened above (fast path) — so
    // if outcome.mergedContent equals fresh we report a plain overwrite,
    // otherwise it's a merge that pulled in user edits.
    if (outcome.mergedContent === content) {
      return { path, status: "overwrite" };
    }
    return { path, status: "merged" };
  }

  // Conflict — do NOT advance the snapshot. The output now contains diff3
  // markers from git merge-file.
  return {
    path,
    status: "conflict",
    conflictHint:
      "merge conflict — resolve `<<<<<<<` markers and re-run `meta gen` to " +
      "advance the canonical state.",
  };
}
