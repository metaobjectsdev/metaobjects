// Overwrite policy: drives the per-file write decision based on the @generated header.
// Per design §8 — read-only generated files; refuse to clobber hand-written code.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { GENERATED_HEADER } from "./constants.js";

export type WriteStatus = "new" | "overwrite" | "refused" | "skipped";
export type MergeStrategy = "overwrite" | "skip-existing";

export interface WriteResult {
  path: string;
  status: WriteStatus;
}

export function decideAndWrite(
  path: string,
  content: string,
  strategy: MergeStrategy = "overwrite",
): WriteResult {
  // 'skip-existing' only skips overwrites, not new files.
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return { path, status: "new" };
  }

  const current = readFileSync(path, "utf-8");
  if (!current.includes(GENERATED_HEADER)) {
    return { path, status: "refused" };
  }

  if (strategy === "skip-existing") {
    return { path, status: "skipped" };
  }

  writeFileSync(path, content);
  return { path, status: "overwrite" };
}
