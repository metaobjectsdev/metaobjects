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
//   2. IT REPORTS A FILE AS EXTRA ONLY WHERE IT OWNS THE DIRECTORY. `docs.outDir`
//      defaults to `./docs`, which in a real repository is full of hand-written
//      documentation — this repository's own `docs/` holds a hundred such files. Its
//      `api/` subtree is not ours either: on a multi-port project those pages are written
//      by the OTHER port's docs command (`mvn metaobjects:docs`, `metaobjects docs`,
//      `dotnet meta docs`), which this gate never runs, so a fresh run here legitimately
//      emits none of them. `--codegen` can convict a committed-but-not-regenerated file
//      because `.gen-state` proves the generator wrote it; over the docs root there is no
//      such manifest, and convicting anyway is precisely the jurisdiction mistake
//      `--codegen`'s orphan branch was corrected for in 0.24.3.
//
//      `agent/` IS ours, and there the ownership question has an answer on disk: the Node
//      `meta docs` command is the only thing that writes that directory (its name is not
//      configurable), and every page it writes opens with the `@generated` marker. That
//      marker is the proof `--codegen` has to consult `.gen-state` for, so BOTH conditions
//      are required — under `agent/` AND carrying the marker. A hand-written note dropped
//      in `agent/` carries no marker and is left alone, exactly as one in the docs root is.
//
//      It matters because the schema page is SKIPPED rather than failed when the expected
//      schema cannot be built or no dialect is declared — so without this, a committed
//      `agent/schema.md` describing the previous schema passed the gate on exactly the
//      change it most needs to flag.
//
//      The residual cost is stated rather than hidden: outside `agent/`, a page for an
//      entity that was DELETED stays committed and this gate stays green.

import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute, sep } from "node:path";
import { docsCommand } from "../commands/docs.js";

export interface DocsDriftResult {
  /** True when every page a fresh `meta docs` would write is committed and identical. */
  clean: boolean;
  /** Docs-dir-relative paths that differ — changed, missing, or (under `agent/`) committed
   *  when a fresh run no longer emits them. Sorted. */
  driftedFiles: string[];
  /** Human-readable, one line per file. */
  lines: string[];
  /** The denominator both the passing and the failing report divide by: the pages a fresh
   *  run produced, plus any committed page under `agent/` it no longer emits. */
  checked: number;
  /** Set when the gate could not run at all. */
  error?: string;
}

/**
 * Recursively list files under `dir`, relative to it.
 *
 * `lstatSync`, NOT `statSync`, and symlinks are SKIPPED. This walks the committed docs
 * tree as well as the fresh one now, and a real repository's `docs/` may hold a symlink to
 * a build output that is absent on CI — `statSync` follows it and throws `ENOENT`, which
 * the caller reports as "regeneration failed", blaming the fresh run for a dangling link
 * in the committed tree. A directory symlink would also let the walk recurse without
 * bound. Nothing MetaObjects writes is a symlink, so skipping them cannot hide a page of
 * ours; a symlinked page is somebody else's file, which this gate does not judge anyway.
 */
function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full);
      else out.push(relative(dir, full));
    }
  };
  walk(dir);
  return out;
}

/**
 * Docs-root-relative prefixes the Node `meta docs` command owns outright — the only
 * places a committed page that a fresh run does not emit is drift rather than somebody
 * else's file. `agent` is fixed (it is not a configurable subdirectory), which is what
 * makes the claim checkable; `api` deliberately is NOT here, because its subdirectory IS
 * configurable and on a multi-port project another port's docs command writes it.
 */
const OWNED_PREFIXES = ["agent/"] as const;

/** The marker every generated docs page opens with — the on-disk ownership proof. */
const GENERATED_MARKER = "@generated";

/**
 * True when this committed file is one WE wrote: under a directory this command owns, and
 * carrying the generated marker in its opening lines. Both halves are load-bearing — the
 * prefix keeps another port's `api/` pages out of jurisdiction, the marker keeps a
 * hand-written note inside `agent/` out of it.
 */
function isOurs(docsDir: string, rel: string): boolean {
  const normalized = rel.split(sep).join("/");
  if (!OWNED_PREFIXES.some((p) => normalized.startsWith(p))) return false;
  try {
    return readFileSync(join(docsDir, rel), "utf8")
      .split("\n", 3)
      .some((line) => line.includes(GENERATED_MARKER));
  } catch {
    // Unreadable is not proof of ownership, and this gate never convicts without it.
    return false;
  }
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
    // Committed-but-not-regenerated, inside the directories this command owns. Counted
    // into `checked` as well as `driftedFiles` so the failing line and the passing line
    // keep dividing by the same set — the `verify --templates` mistake, where a red run
    // and a green run reported different denominators for the same project.
    const freshSet = new Set(fresh);
    const orphans = listFiles(docsDir)
      .filter((rel) => !freshSet.has(rel) && isOurs(docsDir, rel))
      .sort();
    for (const rel of orphans) {
      driftedFiles.push(rel);
      lines.push(`- ${rel} (committed; a fresh 'meta docs' no longer emits it)`);
    }
    return {
      clean: driftedFiles.length === 0,
      driftedFiles: driftedFiles.sort(),
      lines,
      checked: fresh.length + orphans.length,
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
