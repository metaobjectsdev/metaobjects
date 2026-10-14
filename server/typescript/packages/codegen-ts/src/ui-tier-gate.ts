import type { Generator } from "./generator.js";
import { CRUD_VERBS, resolveExpose, type CrudVerb, type ExposeOption, type RoutesExpose } from "./routes-expose.js";

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
 * suite", and both were once re-derived from the RAW config, where a generator wired by
 * stable name (`generators: ["routes-hono"]`, legal under ADR-0021 #1) is a string carrying
 * no marker at all. So `api-docs` omitted the Hono surface for a project that had wired it.
 * One helper, called after the strings are resolved, is what keeps the answer single.
 */
export function runEmitsHonoRoutes(generators: readonly Generator[]): boolean {
  return generators.some((g) => g.emitsHonoRoutes === true);
}

/**
 * The `expose` option of each routes surface the run mounts, for the api reference to apply (a docs
 * page that lists DELETE for a route the adopter does not mount is a lie).
 *
 * Per surface, because the Fastify and Hono routes files are separate generators with their
 * own option: a surface is narrowed only when EVERY generator mounting it carries an `expose`
 * (several on one surface union their verbs), and a surface with none, or one that mounts all
 * five, documents all five. Undefined when no surface is narrowed.
 */
export function runRoutesExpose(generators: readonly Generator[]): RoutesExpose | undefined {
  const rest = surfaceExpose(generators.filter((g) => g.emitsHonoRoutes !== true));
  const restHono = surfaceExpose(generators.filter((g) => g.emitsHonoRoutes === true));
  if (rest === undefined && restHono === undefined) return undefined;
  return { ...(rest !== undefined && { rest }), ...(restHono !== undefined && { restHono }) };
}

function surfaceExpose(generators: readonly Generator[]): ExposeOption | undefined {
  const mounts = generators
    .map((g) => g.mountsRoutes)
    .filter((m): m is NonNullable<typeof m> => m !== undefined);
  if (mounts.length === 0 || mounts.some((m) => m.expose === undefined)) return undefined;
  return (entity) => {
    const union = new Set<CrudVerb>();
    for (const m of mounts) {
      const verbs = resolveExpose(entity, m.expose);
      if (verbs === undefined) return undefined;
      for (const v of verbs) union.add(v);
    }
    return CRUD_VERBS.filter((v) => union.has(v));
  };
}
