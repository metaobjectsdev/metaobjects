// `meta verify --codegen` — the codegen-drift gate (ADR-0021 D2).
//
// Regenerates the configured codegen into a throwaway temp directory and DIFFs
// the freshly-generated file tree against the committed output (the config's
// outDir / per-target outDirs). Any difference — a file present in one tree but
// not the other, or differing content — is drift: either "metadata changed but
// `meta gen` wasn't re-run" or "a generated file was hand-edited". Reuses the
// exact same `runGen` pipeline `meta gen` uses, so the comparison is faithful.
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
import { runGen } from "@metaobjectsdev/codegen-ts";
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
          if (a !== b) {
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
