// The docs view of a run (`docs/features/docs-view.md`): built from the model the run already
// loaded, the requirement ledger the caller computed (`ctx.requirementLedger`), the files the
// run generated (`ctx.runOutput`) and the routes it mounts. The explorer site and the template
// generator's `docsView` data both read it, so a page sees the same facts whichever renders it.

import { buildDocsView, type DocsView } from "@metaobjectsdev/metadata";
import type { GenContext } from "./generator.js";
import { buildApiModelForRun } from "./generators/api-model.js";

/** A route the run mounts, keyed by its node's resolution key: the docs view's `routes` input. */
interface RunRoute {
  node: string;
  method: string;
  path: string;
}

/** The routes the run mounts, as the api reference states them (`METHOD /path` per symbol). */
function runRoutes(ctx: GenContext): RunRoute[] {
  const routes: RunRoute[] = [];
  for (const unit of buildApiModelForRun(ctx).units) {
    const node = unit.package !== undefined && unit.package !== "" ? `${unit.package}::${unit.node}` : unit.node;
    for (const sym of unit.symbols) {
      if (sym.kind !== "rest") continue;
      const space = sym.name.indexOf(" ");
      if (space < 0) continue;
      routes.push({ node, method: sym.name.slice(0, space), path: sym.name.slice(space + 1) });
    }
  }
  return routes;
}

/** The docs view of this run. `who` prefixes the warning when the ledger cannot be built. */
export function runDocsView(ctx: GenContext, who: string): DocsView {
  // The manifest's shape (path → generatedBy, sourceNode), from the files this run wrote: a
  // fresh clone builds the same view as the machine that last generated. Only a generator
  // marked `readsRunOutput` is handed the run's files; without them no node lists files.
  const runFiles = ctx.runOutput?.();
  const manifest: Record<string, { generatedBy: string; sourceNode?: string }> = {};
  for (const f of runFiles ?? []) {
    manifest[f.path] = { generatedBy: f.generatedBy, ...(f.sourceNode !== undefined && { sourceNode: f.sourceNode }) };
  }
  // The ledger is the requirement gate's; a gate that throws leaves the section out (as a
  // missing verify input does) rather than failing the whole run in the docs step.
  let ledger: unknown;
  try {
    ledger = ctx.requirementLedger?.();
  } catch (err) {
    ctx.warn(`${who}: the requirement ledger could not be built, so the docs show none: ${err instanceof Error ? err.message : String(err)}`);
  }
  // No route at all means this run recorded none (no routes generator, or REST off), which the
  // view says as such; an empty list would claim the run mounted nothing.
  const routes = runRoutes(ctx);
  return buildDocsView({
    root: ctx.loadedRoot,
    ...(ledger !== undefined && { verify: ledger }),
    ...(runFiles !== undefined && { manifest }),
    ...(routes.length > 0 && { routes }),
  });
}
