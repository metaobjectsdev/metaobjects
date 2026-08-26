// server/typescript/packages/cli/src/commands/upgrade.ts
//
// `meta upgrade` — rewrite what the current loader no longer accepts in this project's
// metadata: RETIRED vocabulary (`retired-vocabulary.ts`) and ATTRIBUTE CONTRADICTIONS —
// pairs of live attributes that may not sit on one node (`attr-contradictions.ts`).
//
// DELIBERATELY NOT `meta migrate`. That command owns DATABASE SCHEMA (ADR-0015) and an
// adopter reading `migrate` expects DDL. Overloading it with a metadata rewrite would make
// the most destructive command in the toolchain ambiguous about what it touches.
//
// IT DOES NOT LOAD THE METADATA, and cannot. Once vocabulary is deregistered, metadata
// carrying it fails the load — which is exactly the state this command exists to repair. So
// it resolves the file SET through `resolveCollection` (the single authority on where
// metadata lives) and hands each file's RAW TEXT to the rewriter. See
// `metadata/src/vocabulary-rewrite.ts` for why that is the only workable shape.
//
// DRY-RUN BY DEFAULT, per this repo's convention for anything that edits committed files.
// `--apply` writes. Refusals exit NON-ZERO even when every mechanical change succeeded, so
// CI cannot mistake a partial upgrade for a finished one.

import { readFile, writeFile } from "node:fs/promises";
import { extname, relative } from "node:path";
import { resolveCollection } from "@metaobjectsdev/sdk";
import { rewriteDocument } from "@metaobjectsdev/metadata";
import { log } from "../lib/log.js";

/** YAML authoring (ADR-0006). Rewritten by the `yaml`-backed arm, loaded on demand below. */
const YAML_EXTENSIONS = new Set([".yaml", ".yml"]);

interface UpgradeFlags {
  apply: boolean;
  maxVersion?: string;
  projectRoot?: string;
}

function parseArgs(argv: string[]): UpgradeFlags {
  const flags: UpgradeFlags = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--apply") flags.apply = true;
    else if (a === "--to") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--to needs a version");
      flags.maxVersion = v;
    } else if (a.startsWith("--to=")) flags.maxVersion = a.slice("--to=".length);
    else if (a === "--help" || a === "-h") throw new Error("__help__");
    else if (!a.startsWith("-")) flags.projectRoot = a;
    else throw new Error(`unknown option: ${a}`);
  }
  return flags;
}

export async function upgradeCommand(args: string[], cwd: string): Promise<number> {
  let flags: UpgradeFlags;
  try {
    flags = parseArgs(args);
  } catch (err) {
    if ((err as Error).message === "__help__") {
      log.info(
        "meta upgrade [<project>] [--to <version>] [--apply]\n\n" +
          "  Rewrites metadata the current loader no longer accepts, in JSON and YAML alike:\n" +
          "  retired vocabulary, and pairs of live attributes that may no longer sit together.\n" +
          "  Previews by default; --apply writes.\n" +
          "  Changes needing a human decision are REFUSED and listed with their guide.\n\n" +
          "  Exit: 0 clean · 1 refusals remain · 2 bad usage · 3 some files could not be read.",
      );
      return 0;
    }
    log.error((err as Error).message);
    return 2;
  }

  const projectRoot = flags.projectRoot ?? cwd;

  let files: readonly string[];
  try {
    files = (await resolveCollection(projectRoot)).files;
  } catch (err) {
    log.error((err as Error).message);
    return 1;
  }

  let totalChanges = 0;
  let totalRefusals = 0;
  let filesChanged = 0;
  let checked = 0;
  // Files we could not READ AT ALL. Distinct from "checked and clean" in every report and in
  // the exit code — conflating them is the whole of #339.
  const notChecked: string[] = [];

  // The YAML arm carries the `yaml` package, so it lives behind its own subpath and is
  // loaded only when the estate actually contains YAML. Importing it eagerly would pull a
  // Node-only dependency into every `meta` invocation.
  const hasYaml = files.some((f) => YAML_EXTENSIONS.has(extname(f).toLowerCase()));
  const rewriteYaml = hasYaml
    ? (await import("@metaobjectsdev/metadata/vocabulary-rewrite-yaml")).rewriteYamlDocument
    : undefined;

  const opts = flags.maxVersion !== undefined ? { maxVersion: flags.maxVersion } : {};

  for (const file of files) {
    const rel = relative(projectRoot, file);
    const before = await readFile(file, "utf8");

    let r;
    if (YAML_EXTENSIONS.has(extname(file).toLowerCase())) {
      const y = rewriteYaml?.(before, opts);
      // A document that does not parse was not examined, and must never be counted as clean.
      if (y === undefined || y.unparseable) {
        notChecked.push(rel);
        continue;
      }
      r = y;
    } else {
      r = rewriteDocument(before, opts);
    }
    checked++;
    if (r.changes.length === 0 && r.refusals.length === 0) continue;

    log.info(`\n${rel}`);
    for (const c of r.changes) log.info(`  ${c.line}: @${c.from} → ${c.to}`);
    for (const f of r.refusals) {
      log.warn(
        `  ${f.line}: ${f.subject}${f.value !== undefined ? `: ${f.value}` : ""} — needs a decision. ` +
          `Retired in ${f.since}. ${f.migration !== undefined ? `See ${f.migration}` : f.why}`,
      );
    }

    totalChanges += r.changes.length;
    totalRefusals += r.refusals.length;
    if (r.changes.length > 0) {
      filesChanged++;
      if (flags.apply) await writeFile(file, r.text, "utf8");
    }
  }

  log.info("");
  if (notChecked.length > 0) {
    log.warn(
      `${notChecked.length} file(s) could not be parsed and were NOT checked — fix these ` +
        `first, then re-run:\n  ${notChecked.join("\n  ")}`,
    );
  }

  // Every conclusion states how many files it is a conclusion ABOUT. A bare "nothing found"
  // read on its own says the estate is clean, and it is the last line, so it is the one that
  // sticks — on the estate that reported this, it was the opposite of the truth.
  //
  // It says "nothing to rewrite", not "your metadata loads": this command knows about retired
  // vocabulary and attribute contradictions, and nothing else. `meta verify` owns the verdict.
  const scope = `${checked} file(s) checked${notChecked.length > 0 ? `, ${notChecked.length} NOT checked` : ""}`;

  if (totalChanges === 0 && totalRefusals === 0) {
    log.info(`meta upgrade — nothing to rewrite (${scope}).`);
  } else if (totalChanges === 0) {
    // Refusals only. Reporting "rewrote 0 declarations", or advertising `--apply`, both
    // promise an action guaranteed to change nothing and bury the fact that the remaining
    // work is entirely human.
    log.info("meta upgrade — nothing here can be rewritten automatically.");
  } else if (flags.apply) {
    log.info(`meta upgrade — rewrote ${totalChanges} declaration(s) across ${filesChanged} file(s).`);
  } else {
    log.info(
      `meta upgrade — ${totalChanges} declaration(s) in ${filesChanged} file(s) can be rewritten. ` +
        `Re-run with --apply to write.`,
    );
  }

  // Non-zero while ANY refusal stands, applied or not. A partial upgrade that exited 0 would
  // let CI record the migration as done while metadata still fails to load.
  if (totalRefusals > 0) {
    log.error(
      `${totalRefusals} declaration(s) need a human decision and were left untouched — ` +
        `see the guides listed above.`,
    );
    return 1;
  }

  // "I could not look" gets its OWN code. It used to share exit 1 with "work remains", so a
  // script could not tell an estate needing decisions from one the tool never opened — and
  // an adopter whose whole estate was skipped got a failure exit next to a message saying
  // nothing was found.
  if (notChecked.length > 0) return 3;
  return 0;
}
