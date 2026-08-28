// `meta verify --codegen` — the codegen-drift gate (ADR-0021 D2).
//
// Regenerates the configured codegen into a throwaway temp directory and DIFFs
// the freshly-generated file tree against the committed output (the config's
// outDir / per-target outDirs). Reuses the exact same `runGen` pipeline `meta gen`
// uses, so the comparison is faithful.
//
// A DIFFERENCE IS NOT AUTOMATICALLY DRIFT. This gate used to treat "metadata
// changed but `meta gen` wasn't re-run" and "a generated file was hand-edited" as
// one verdict. Only the first is drift; the second is the documented workflow —
// `meta gen` three-way-merges hand edits and reports "merged", and the product
// says in as many words that anything inside a generated file is fair game to
// edit. Convicting both made the gate unusable for anyone who took that offer,
// and its printed remedy was a LOOP: running `meta gen` merges the edit back in,
// so the next run failed identically. Requirement-test stubs were the worst case,
// being worthless until hand-edited.
//
// The discriminator is `.gen-state/.hashes.json`, which records what the GENERATOR
// WROTE rather than what the file became, and is the committed half of `.gen-state`
// precisely so this is answerable on a machine that did not generate the output.
// When a fresh regen hashes to what we recorded writing, the generator's
// contribution is current and the on-disk difference is a preserved hand edit.
// Design: spec/design-docs/2026-08-27-codegen-drift-hand-edits-design.md
//
// Faithfulness note: generated content can embed import paths computed RELATIVE
// to a target's outDir (and between targets). To keep the regen byte-identical
// to the committed output, each outDir is remapped into the temp tree at the
// SAME path it has relative to the project root — preserving the inter-target
// layout. `importBase` (a stable string, not a path) is untouched.

import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { runGen, contentHash, readGeneratedHash } from "@metaobjectsdev/codegen-ts";
import type { MetaobjectsGenConfig } from "@metaobjectsdev/codegen-ts";
import type { MetaData } from "@metaobjectsdev/metadata";

/** Per-target config as carried on MetaobjectsGenConfig (TargetConfig isn't
 *  re-exported from the package index, so derive it from the config type). */
type TargetConfig = NonNullable<MetaobjectsGenConfig["targets"]>[string];

export interface CodegenDriftResult {
  /** True when the committed output matches a fresh regen exactly. */
  clean: boolean;
  /** Project-relative paths that differ (changed / missing / extra), sorted. */
  driftedFiles: string[];
  /** Human-readable, one-line-per-file drift summary. */
  lines: string[];
  /** Set when the gate could not run (e.g. no outDir to compare against). */
  error?: string;
}

/** Collect the committed outDirs declared by the config (default + per-target),
 *  resolved against `projectRoot` — a relative outDir (the common, portable,
 *  `meta init`-scaffolded shape) must resolve against the project the CLI's
 *  `--cwd` flag says to run as, not the ambient process.cwd() (which differs
 *  whenever `verify --codegen` runs from outside the target project, e.g. a
 *  test suite or a CI job invoking the CLI against another directory). */
function committedOutDirs(config: MetaobjectsGenConfig, projectRoot: string): string[] {
  const dirs = new Set<string>();
  if (typeof config.outDir === "string" && config.outDir.length > 0) {
    dirs.add(resolve(projectRoot, config.outDir));
  }
  for (const t of Object.values(config.targets ?? {})) {
    if (t.outDir && t.outDir.length > 0) dirs.add(resolve(projectRoot, t.outDir));
  }
  return [...dirs];
}

/** Recursively list files under `dir` as paths relative to `dir` (POSIX-ish). */
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

/**
 * Run codegen into a temp tree and diff it against the committed output.
 *
 * @param config   the loaded metaobjects config (provides outDir/targets).
 * @param metadata the loaded MetaRoot (same object `meta gen` would use).
 * @param projectRoot absolute project root (committed outDirs are keyed off it).
 * @param scope    the SAME output-scope predicate `meta gen` used to produce the
 *   committed output (Task 12b / design §7 open question 3). A `verify --codegen`
 *   that regenerates unscoped while the committed output was scoped would read
 *   every out-of-scope entity as drift — regen would try to emit it, but it was
 *   never committed because the `meta gen` that produced the committed tree
 *   never emitted it either. Undefined ⇒ everything is in scope (byte-identical
 *   to a project with no `scope` declared).
 */
export async function computeCodegenDrift(
  config: MetaobjectsGenConfig,
  metadata: MetaData,
  projectRoot: string,
  scope?: (fqn: string) => boolean,
): Promise<CodegenDriftResult> {
  const root = isAbsolute(projectRoot) ? projectRoot : resolve(projectRoot);

  // The PROJECT's snapshot manifest, never the temp one built below — that temp
  // manifest only describes the regen that just ran, so it can say nothing about
  // what `meta gen` last wrote here. Same default location runner.ts derives.
  const projectGenStateDir = join(root, ".metaobjects", ".gen-state");

  const committedDirs = committedOutDirs(config, root);
  if (committedDirs.length === 0) {
    return {
      clean: false,
      driftedFiles: [],
      lines: [],
      error:
        "verify --codegen: no outDir configured — cannot locate the committed " +
        "generated output to diff against. Set 'outDir' (and/or per-target " +
        "outDir) in metaobjects.config.ts.",
    };
  }

  // Build a temp tree that mirrors each outDir at its project-relative path, so
  // relative import paths in generated content come out identical.
  const tempRoot = mkdtempSync(join(tmpdir(), "meta-verify-codegen-"));
  try {
    const tempFor = (committed: string): string => {
      const rel = relative(root, committed);
      // If a committed outDir lives outside the project root, fall back to a
      // flattened, collision-safe slot under the temp root. (Relative-import
      // fidelity for out-of-tree targets isn't guaranteed, but the diff is
      // still meaningful per-file.)
      const safeRel = rel.startsWith("..") || isAbsolute(rel)
        ? committed.replace(/[^A-Za-z0-9]+/g, "_")
        : rel;
      return join(tempRoot, safeRel);
    };

    // Remap the config so runGen writes into the temp mirror instead of the
    // committed output. Default outDir + each named target's outDir are
    // rewritten — resolved against `root` (see committedOutDirs above), not
    // the ambient process.cwd(), so this stays correct under `--cwd`.
    const remappedTargets: Record<string, TargetConfig> = {};
    for (const [name, t] of Object.entries(config.targets ?? {})) {
      remappedTargets[name] = { ...t, outDir: tempFor(resolve(root, t.outDir)) };
    }
    const tempConfig: MetaobjectsGenConfig = {
      ...config,
      outDir: tempFor(resolve(root, config.outDir)),
      ...(config.targets !== undefined ? { targets: remappedTargets } : {}),
    };

    // runGen is called with `projectRoot: tempRoot` below (so relative outDir
    // remapping stays correct — see the module doc). Some generators resolve
    // ancillary project-relative input at generation time rather than through
    // `config` — namely the template-output codegen family (e.g. render-helper,
    // via codegen-ts's `projectProvider(ctx.projectRoot)`), which reads a
    // `<projectRoot>/templates/` dir to build-time-verify each referenced
    // mustache. Mirror it into the temp root so that lookup succeeds the same
    // way it does for `meta gen` against the real project root — otherwise
    // every project using those generators would spuriously fail `--codegen`
    // with an "unresolved" template error that has nothing to do with drift.
    const projectTemplatesDir = join(root, "templates");
    if (existsSync(projectTemplatesDir)) {
      cpSync(projectTemplatesDir, join(tempRoot, "templates"), { recursive: true });
    }

    // Generate fresh into the temp tree. "overwrite" + "fresh" + a temp
    // gen-state dir guarantees every file is written (no merge/skip), so the
    // temp tree is the canonical "what gen would produce right now".
    await runGen({
      config: tempConfig,
      metadata,
      projectRoot: tempRoot,
      genStateDir: join(tempRoot, ".gen-state"),
      mergeStrategy: "overwrite",
      baseline: "fresh",
      ...(scope !== undefined ? { scope } : {}),
    });

    // Diff each committed outDir against its temp mirror.
    const driftedFiles = new Set<string>();
    const lines: string[] = [];
    for (const committed of committedDirs) {
      const fresh = tempFor(committed);
      const committedFiles = new Set(listFiles(committed));
      const freshFiles = new Set(listFiles(fresh));
      const all = new Set([...committedFiles, ...freshFiles]);
      for (const rel of [...all].sort()) {
        const relKey = relative(root, join(committed, rel));
        const inCommitted = committedFiles.has(rel);
        const inFresh = freshFiles.has(rel);
        if (inCommitted && !inFresh) {
          driftedFiles.add(relKey);
          lines.push(`- ${relKey} (committed but regen would not emit it)`);
        } else if (!inCommitted && inFresh) {
          driftedFiles.add(relKey);
          lines.push(`+ ${relKey} (regen would emit it; not committed — run 'meta gen')`);
        } else {
          const a = readFileSync(join(committed, rel), "utf8");
          const b = readFileSync(join(fresh, rel), "utf8");
          // Not `a !== b` alone: that convicts the hand edit `meta gen` preserved.
          // The question this gate can honestly answer is "is the GENERATED
          // contribution current?", and the recorded hash answers exactly it.
          // FAILS CLOSED, matching `isPristineGenerated`: with no recorded hash
          // nothing is proven, so the old byte verdict stands.
          if (a !== b && readGeneratedHash(projectGenStateDir, relKey) !== contentHash(b)) {
            driftedFiles.add(relKey);
            lines.push(`~ ${relKey} (committed content differs from a fresh regen)`);
          }
        }
      }
    }

    const sorted = [...driftedFiles].sort();
    return { clean: sorted.length === 0, driftedFiles: sorted, lines };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
