// server/typescript/packages/cli/src/commands/upgrade.ts
//
// `meta upgrade` — rewrite retired vocabulary in this project's metadata.
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

/** Authoring formats the rewriter cannot edit — see `vocabulary-rewrite.ts` for why. */
const UNREWRITABLE_EXTENSIONS = new Set([".yaml", ".yml"]);

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
          "  Rewrites retired metadata vocabulary. Previews by default; --apply writes.\n" +
          "  Retirements needing a human decision are REFUSED and listed with their guide.",
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
  const skipped: string[] = [];

  for (const file of files) {
    const rel = relative(projectRoot, file);

    // A file we cannot rewrite is NAMED, never passed over. Silently skipping it is the
    // failure this command exists to prevent: the adopter runs the documented migration,
    // reads "no retired vocabulary found", and ships metadata that does not load.
    if (UNREWRITABLE_EXTENSIONS.has(extname(file).toLowerCase())) {
      skipped.push(rel);
      continue;
    }

    const before = await readFile(file, "utf8");
    const r = rewriteDocument(before, {
      ...(flags.maxVersion !== undefined ? { maxVersion: flags.maxVersion } : {}),
    });
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
  if (skipped.length > 0) {
    log.warn(
      `${skipped.length} YAML file(s) cannot be rewritten automatically and were NOT ` +
        `checked — migrate them by hand:\n  ${skipped.join("\n  ")}`,
    );
  }

  if (totalChanges === 0 && totalRefusals === 0) {
    log.info(
      skipped.length > 0
        ? "meta upgrade — no retired vocabulary found in the JSON metadata."
        : "meta upgrade — no retired vocabulary found.",
    );
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
  // let CI record the migration as done while metadata still fails to load. A file we could
  // not read at all counts the same way, for the same reason.
  if (totalRefusals > 0) {
    log.error(
      `${totalRefusals} declaration(s) need a human decision and were left untouched — ` +
        `see the guides listed above.`,
    );
    return 1;
  }
  return skipped.length > 0 ? 1 : 0;
}
