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
import { relative } from "node:path";
import { resolveCollection } from "@metaobjectsdev/sdk";
import { rewriteDocument, type RewriteResult } from "@metaobjectsdev/metadata";
import { log } from "../lib/log.js";

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

/**
 * The node type a document's keys belong to.
 *
 * Retirements are TYPE-SCOPED — `@unique` is retired on `identity.secondary` and live on a
 * field — so the rewriter needs a scope per occurrence, not per file. A metadata file holds
 * many types, so we run the rewriter once per type key present in the text. Cheap, and it
 * keeps the scoping decision in one place (the map) rather than smeared across a parser we
 * deliberately do not have.
 */
function typeKeysIn(text: string): string[] {
  const keys = new Set<string>();
  const re = /"([a-z]+)\.([A-Za-z*]+)"\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) keys.add(`${m[1]}.${m[2]}`);
  return [...keys];
}

/** Run every type scope present in the document, threading the text through each pass. */
function rewriteAllScopes(text: string, maxVersion: string | undefined): RewriteResult {
  const changes: RewriteResult["changes"][number][] = [];
  const refusals: RewriteResult["refusals"][number][] = [];
  let current = text;
  for (const typeKeyHint of typeKeysIn(text)) {
    const r = rewriteDocument(current, {
      typeKeyHint,
      ...(maxVersion !== undefined ? { maxVersion } : {}),
    });
    current = r.text;
    changes.push(...r.changes);
    refusals.push(...r.refusals);
  }
  return { text: current, changes, refusals };
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

  for (const file of files) {
    const before = await readFile(file, "utf8");
    const r = rewriteAllScopes(before, flags.maxVersion);
    if (r.changes.length === 0 && r.refusals.length === 0) continue;

    const rel = relative(projectRoot, file);
    log.info(`\n${rel}`);
    for (const c of r.changes) log.info(`  ${c.line}: @${c.from} → ${c.to}`);
    for (const f of r.refusals) {
      log.warn(
        `  ${f.line}: @${f.attr}${f.value !== undefined ? `: ${f.value}` : ""} — needs a decision. ` +
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
  if (totalChanges === 0 && totalRefusals === 0) {
    log.info("meta upgrade — no retired vocabulary found.");
    return 0;
  }

  if (flags.apply) {
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
  return 0;
}
