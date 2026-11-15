// server/typescript/packages/cli/src/lib/gen-skip.ts
//
// ADR-0062 — when `meta gen` may skip rendering, and how a skipped run is reported.
import type { GenFlags } from "./args.js";
import { skippedSection } from "./advisory.js";
import { log } from "./log.js";

type Format = "toon" | "json" | "text";

/** True when a `meta gen` run with these flags writes, and so may skip. */
export function genMaySkip(flags: GenFlags): boolean {
  return !flags.dryRun && !flags.list && !flags.probe && !flags.force;
}

const SKIP_SUMMARY = "nothing changed since the last meta gen, so nothing was rendered or written";
const SKIP_HELP = "meta gen --force regenerates everything";

/** Print the skipped run in the requested format. */
export async function reportGenSkip(fmt: Format, recorded: number): Promise<void> {
  if (fmt === "text") {
    log.info(`meta gen — ${SKIP_SUMMARY} (${recorded} generated file(s) up to date). ${SKIP_HELP}.`);
    return;
  }
  // The same document shape a run prints, so a reader parsing it needs no second schema.
  const doc = {
    gen: [] as { file: string; status: string }[],
    summary: SKIP_SUMMARY,
    help: [SKIP_HELP],
    antiPatterns: skippedSection("not run: nothing changed since the last meta gen"),
    skipped: true,
    upToDate: recorded,
  };
  if (fmt === "json") log.info(JSON.stringify(doc, null, 2));
  else {
    const { toonEncode } = await import("./format.js");
    log.info(toonEncode(doc));
  }
}
