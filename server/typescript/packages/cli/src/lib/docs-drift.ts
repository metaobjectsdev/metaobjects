// `meta verify --docs` — the docs-drift gate.
//
// It runs `meta docs` into a throwaway temp directory and diffs what that produces
// against the committed docs tree. Same shape as `--codegen`, pointed at `docs.outDir`,
// and it exists because nothing checked the docs tree at all: `--codegen` regenerates only
// the config's `outDir`/`targets`, so a model could move and every committed page keep
// describing the previous one indefinitely, with every gate green.
//
// IT CALLS THE DOCS COMMAND, NOT A REIMPLEMENTATION OF IT. The gate and the door must not
// be two answers to "what are the docs" — that is the defect this whole surface is meant to
// prevent, and it would be embarrassing to introduce it in the checker.
//
// TWO DELIBERATE DIFFERENCES FROM `--codegen`, both in the direction of not convicting the
// innocent:
//
//   1. NO HAND-EDIT PRESERVATION, so a byte difference IS drift. Docs pages are read, never
//      imported: there is no three-way merge, nothing records what was written, and the
//      documented workflow never invites an edit inside one. `--codegen` needs
//      `.gen-state/.hashes.json` to tell a preserved hand edit from stale output; here
//      there is no such offer to honour.
//
//   2. IT NEVER REPORTS A FILE AS EXTRA. `docs.outDir` defaults to `./docs`, which in a
//      real repository is full of hand-written documentation — this repository's own
//      `docs/` holds a hundred such files. `--codegen` can convict a committed-but-not-
//      regenerated file because `.gen-state` proves the generator wrote it; the docs
//      surfaces record nothing, so the same branch here would fail every project that
//      keeps a README beside its generated pages. That is precisely the jurisdiction
//      mistake `--codegen`'s orphan branch was corrected for in 0.24.3, and repeating it
//      with no manifest to appeal to would be worse.
//
//      The cost is stated rather than hidden: a page for an entity that was DELETED stays
//      committed and this gate stays green. What it does catch is the far more common
//      case — a page whose content no longer matches the model, or a page a regen would
//      now emit and nobody committed.

import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { docsCommand } from "../commands/docs.js";

export interface DocsDriftResult {
  /** True when every page a fresh `meta docs` would write is committed and identical. */
  clean: boolean;
  /** Docs-dir-relative paths that differ (changed or missing), sorted. */
  driftedFiles: string[];
  /** Human-readable, one line per file. */
  lines: string[];
  /** How many pages the fresh run produced — the denominator of a passing report. */
  checked: number;
  /** Set when the gate could not run at all. */
  error?: string;
}

/** Recursively list files under `dir`, relative to it. */
function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full));
    }
  };
  walk(dir);
  return out;
}

export interface ComputeDocsDriftArgs {
  /** Absolute project root — what `meta docs` would be pointed at. */
  projectRoot: string;
  /** The committed docs directory, already resolved (the project's `docs.outDir`). */
  docsDir: string;
  /** Process cwd to hand the docs command, for parity with a direct invocation. */
  cwd: string;
}

/**
 * Regenerate the docs into a temp tree and diff it against the committed one.
 *
 * A non-zero exit from the docs command is returned as `error` rather than as drift: a run
 * that could not produce the pages has not shown that the committed ones are wrong, and
 * reporting it as drift would send a reader to edit files that are probably fine.
 */
export async function computeDocsDrift(args: ComputeDocsDriftArgs): Promise<DocsDriftResult> {
  const root = isAbsolute(args.projectRoot) ? args.projectRoot : resolve(args.projectRoot);
  const docsDir = isAbsolute(args.docsDir) ? args.docsDir : resolve(root, args.docsDir);

  const tempRoot = mkdtempSync(join(tmpdir(), "meta-verify-docs-"));
  try {
    // NO `<project-root>` POSITIONAL, deliberately. Passing one is not the same command:
    // an explicit path PINS the source set to that directory's own sources (#327), while a
    // bare run discovers the project by walking up. The committed pages were produced by
    // whatever the user actually ran, and a bare run is what `meta docs` means by default —
    // so the gate reproduces that and takes its project root from `cwd`, the way the docs
    // command itself does. A gate that resolved a different source set would report pages
    // as drifted that a plain regeneration would reproduce exactly.
    //
    // `--out` IS passed, because the whole point is to write somewhere else; everything
    // else — layout, surfaces, api surfaces, base URL — still resolves from the project's
    // own config.
    const exit = await docsCommand(["--out", tempRoot], args.cwd, { silent: true });
    if (exit !== 0) {
      return {
        clean: false,
        driftedFiles: [],
        lines: [],
        checked: 0,
        error:
          `verify --docs: 'meta docs' exited ${exit}, so the committed pages could not be ` +
          `compared against a fresh run. Fix that first — the error is above.`,
      };
    }

    const fresh = listFiles(tempRoot).sort();
    if (fresh.length === 0) {
      return {
        clean: false,
        driftedFiles: [],
        lines: [],
        checked: 0,
        error:
          "verify --docs: a fresh 'meta docs' produced no pages, so there is nothing to " +
          "compare. Check that this project declares metadata the docs surfaces cover.",
      };
    }

    const driftedFiles: string[] = [];
    const lines: string[] = [];
    for (const rel of fresh) {
      const committedPath = join(docsDir, rel);
      if (!existsSync(committedPath)) {
        driftedFiles.push(rel);
        lines.push(`+ ${rel} (a fresh 'meta docs' emits it; not committed)`);
        continue;
      }
      const a = readFileSync(committedPath, "utf8");
      const b = readFileSync(join(tempRoot, rel), "utf8");
      if (a !== b) {
        driftedFiles.push(rel);
        lines.push(`~ ${rel} (committed content differs from a fresh 'meta docs')`);
      }
    }
    return { clean: driftedFiles.length === 0, driftedFiles, lines, checked: fresh.length };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
