import type { Generator } from "./generator.js";

/**
 * Generators that emit a CLIENT UI artifact — a form, a hook, a grid or its columns.
 *
 * Names, not identities, for the same reason `PROMPT_GENERATOR_NAMES` uses names: under
 * ADR-0034 scaffold-and-own an adopter runs their OWN copy, and `meta eject` copies the
 * template verbatim, so the name survives the copy while the object identity does not.
 *
 * This set exists ONLY as a compatibility path for a copy ejected before `emitsUiTier`
 * existed. The marker is the mechanism; a name match makes the run behave as it did
 * before AND says the marker is missing (see {@link warnUnmarkedUiGenerators}), because
 * a page silently disappearing is exactly the kind of degradation that must announce
 * itself.
 */
export const UI_TIER_GENERATOR_NAMES: ReadonlySet<string> = new Set([
  "form-file",
  "tanstack-query",
  "tanstack-grid",
  "tanstack-grid-hook",
  "angular-form",
  "angular-grid",
  "angular-service",
]);

/** Generators in the suite that emit a UI artifact but carry no `emitsUiTier` marker. */
function unmarked(generators: readonly Generator[]): Generator[] {
  return generators.filter(
    (g) => g.emitsUiTier !== true && UI_TIER_GENERATOR_NAMES.has(g.name),
  );
}

/**
 * Does this run emit a client UI tier?
 *
 * The declared marker OR the legacy name. `agent/ui.md` gates on the answer: its own
 * predicate was metadata-only (`servesReadApi`), which says a UI *could* be generated
 * for an object and never that this run generates one — so a project with
 * `generators: []` was handed a confident page naming endpoints nothing serves.
 */
export function runEmitsUiTier(generators: readonly Generator[]): boolean {
  return generators.some((g) => g.emitsUiTier === true) || unmarked(generators).length > 0;
}

/**
 * A generator ejected before `emitsUiTier` existed still emits its tier, so the run is
 * NOT degraded — the name match above keeps `agent/ui.md` emitting. It is warned about
 * anyway: an adopter who renames their copy loses the page with no signal at all, and
 * the one-line fix belongs where the fact is known rather than in a migration note
 * nobody re-reads. Self-extinguishing — adding the marker silences it forever.
 */
export function warnUnmarkedUiGenerators(
  generators: readonly Generator[],
  warn: (msg: string) => void,
): void {
  const stale = unmarked(generators);
  if (stale.length === 0) return;
  const names = stale.map((g) => `'${g.name}'`).join(", ");
  warn(
    `${names} emit${stale.length === 1 ? "s" : ""} a UI artifact but carr${stale.length === 1 ? "ies" : "y"} no ` +
      `'emitsUiTier: true' marker — an owned copy ejected before the marker existed. ` +
      `agent/ui.md still emits (matched by name), but a renamed copy would not: add ` +
      `'emitsUiTier: true' beside 'name:' in your copy, or re-eject it.`,
  );
}

/**
 * Does this run emit the OPT-IN Hono routes surface?
 *
 * Lives beside `runEmitsUiTier` for one reason: both are "aggregate a marker across the
 * suite", and both were being re-derived at the `meta docs` door — which read the RAW
 * config, where a generator wired by stable name (`generators: ["routes-hono"]`, legal
 * under ADR-0021 #1) is a string carrying no marker at all. So `api-docs` omitted the
 * Hono surface for a project that had wired it. One helper, called after the strings are
 * resolved, is what stops the two doors disagreeing again.
 */
export function runEmitsHonoRoutes(generators: readonly Generator[]): boolean {
  return generators.some((g) => g.emitsHonoRoutes === true);
}
