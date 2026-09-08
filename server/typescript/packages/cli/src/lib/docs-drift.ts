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
//   2. IT REPORTS A FILE AS EXTRA ONLY WHERE IT OWNS THE DIRECTORY. `docs.outDir` is a
//      directory an adopter chooses, and it may well be one full of hand-written
//      documentation — this repository's own `docs/` holds a hundred such files. (The
//      default moved to `./docs/generated` for exactly that reason: defaulting into the
//      most-owned directory name in the ecosystem contradicted this paragraph.) Its
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
import { join, relative, resolve, isAbsolute } from "node:path";
import { docsCommand } from "../commands/docs.js";
import { gitIgnored } from "./git-ignore.js";
import { toPosix } from "./rel-posix.js";

export interface DocsDriftResult {
  /** True when every page a fresh `meta docs` would write is committed and identical. */
  clean: boolean;
  /** Docs-dir-relative paths that differ — changed, missing, or (under `agent/`) committed
   *  when a fresh run no longer emits them. Sorted. */
  driftedFiles: string[];
  /** Human-readable, one line per file. */
  lines: string[];
  /** The denominator both the passing and the failing report divide by: the pages a fresh
   *  run produced, plus any committed page under `agent/` it no longer emits, MINUS the
   *  git-ignored ones. A pure function of (fresh set, repository ignore rules) — never of
   *  which files happen to be on this machine's disk. */
  checked: number;
  /** How many pages a fresh run emits that the project git-ignores, so did not check.
   *  Reported on BOTH the passing and the failing line: a gate that quietly checked two
   *  of 589 pages and said "no drift" would be indistinguishable from one that checked
   *  everything. */
  ignored: number;
  /** Why the ignore rules could not be consulted, when they could not be. Undefined means
   *  they were. The gate then falls back to checking EVERY page a fresh run emits — the
   *  pre-existing behaviour — and says so rather than degrading silently. */
  ignoreReason?: string | undefined;
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
  const normalized = toPosix(rel);
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
        ignored: 0,
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
        ignored: 0,
        error:
          "verify --docs: a fresh 'meta docs' produced no pages, so there is nothing to " +
          "compare. Check that this project declares metadata the docs surfaces cover.",
      };
    }

    // Committed-but-not-regenerated, inside the directories this command owns.
    const freshSet = new Set(fresh);
    const ownedOrphans = listFiles(docsDir)
      .filter((rel) => !freshSet.has(rel) && isOurs(docsDir, rel))
      .sort();

    // A page the project deliberately does not commit is not drift.
    //
    // `docs.outDir` is a directory, not a namespace MetaObjects owns — the same
    // jurisdiction ruling 0.24.3 made for `verify --codegen`. But `--codegen` could key
    // on `.gen-state/.hashes.json`, a record of what the generator WROTE, and `meta
    // docs` keeps no such manifest. What it can ask instead is what the PROJECT says:
    // a page under `docs.outDir` that git reports ignored is one the project has
    // declared it does not commit.
    //
    // This is not a guess about intent, it is the project's own statement of it. And it
    // cannot be used to hide a file the project actually tracks: git never reports a
    // TRACKED path as ignored, whatever pattern matches it, so a committed page is
    // always compared.
    //
    // The exemption is computed over the FRESH set by NAME, present on disk or not.
    // That is what makes the verdict machine-independent: a developer box that has run
    // `meta docs` locally has all 589 pages on disk and a CI runner has two, and both
    // must report the same denominator. Deciding per-file-existence would have made
    // `checked` a property of the machine.
    //
    // Without it: an estate generating three surfaces and committing 2 files of 589 —
    // gitignoring the rest with a comment explaining they are a derived view of
    // metadata that is already the source of truth — was told it had 588 drifted pages,
    // of which exactly ONE was real.
    const ignoreCandidates = [...fresh, ...ownedOrphans];
    // honourGlobalExcludes: false — this verdict must be a property of the repository.
    // A gate that passes for the author and fails in CI because of a personal ignore
    // file is worse than no gate.
    const ignoreLookup = gitIgnored(docsDir, ignoreCandidates, {
      honourGlobalExcludes: false,
    });
    const ignored: ReadonlySet<string> =
      "ignored" in ignoreLookup ? ignoreLookup.ignored : new Set<string>();
    const ignoreReason: string | undefined =
      "unavailable" in ignoreLookup ? ignoreLookup.unavailable : undefined;
    const isIgnored = (rel: string): boolean => ignored.has(toPosix(rel));

    const toCheck = fresh.filter((rel) => !isIgnored(rel));
    const orphans = ownedOrphans.filter((rel) => !isIgnored(rel));
    // BOTH halves. `ignoreCandidates` above tests fresh pages AND owned orphans, so an
    // ignored orphan is dropped from the check exactly like an ignored fresh page — but
    // counting only the fresh half reported a number SMALLER than the work actually
    // skipped. That is the `verify --templates` denominator mistake in miniature (a line
    // describing work the command did not do), which is the very thing the orphan loop
    // below is written to avoid; the two must be consistent about the same set.
    const ignoredCount =
      fresh.length - toCheck.length + (ownedOrphans.length - orphans.length);

    // A gate asked to check pages that could check NONE must not answer "no drift".
    if (toCheck.length === 0 && orphans.length === 0) {
      return {
        clean: false,
        driftedFiles: [],
        lines: [],
        checked: 0,
        ignored: ignoredCount,
        ignoreReason,
        error:
          `verify --docs: a fresh 'meta docs' produced ${fresh.length} page(s) and every ` +
          `one of them is git-ignored, so there is nothing to compare. Commit the pages ` +
          `you want checked, or run without --docs.`,
      };
    }

    const driftedFiles: string[] = [];
    const lines: string[] = [];
    for (const rel of toCheck) {
      const committedPath = join(docsDir, rel);
      if (!existsSync(committedPath)) {
        driftedFiles.push(rel);
        // When the rules could not be consulted the last clause would be a claim we
        // have not checked, so it is dropped rather than asserted.
        lines.push(
          ignoreReason === undefined
            ? `+ ${rel} (a fresh 'meta docs' emits it; not committed, not git-ignored)`
            : `+ ${rel} (a fresh 'meta docs' emits it; not committed)`,
        );
        continue;
      }
      const a = readFileSync(committedPath, "utf8");
      const b = readFileSync(join(tempRoot, rel), "utf8");
      if (a !== b) {
        driftedFiles.push(rel);
        lines.push(`~ ${rel} (committed content differs from a fresh 'meta docs')`);
      }
    }
    // Counted into `checked` as well as `driftedFiles` so the failing line and the
    // passing line keep dividing by the same set — the `verify --templates` mistake,
    // where a red run and a green run reported different denominators for one project.
    for (const rel of orphans) {
      driftedFiles.push(rel);
      lines.push(`- ${rel} (committed; a fresh 'meta docs' no longer emits it)`);
    }
    return {
      clean: driftedFiles.length === 0,
      driftedFiles: driftedFiles.sort(),
      lines,
      checked: toCheck.length + orphans.length,
      ignored: ignoredCount,
      ignoreReason,
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
