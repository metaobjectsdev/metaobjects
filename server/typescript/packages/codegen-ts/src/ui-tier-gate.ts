import type { Generator } from "./generator.js";
import { tphDiscriminatorBase } from "./tph.js";
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
 * own option: several generators on one surface union their verbs, and a generator with no
 * `expose` mounts all five. A generator's own `filter` removes the entities it rejects, so an
 * entity no generator on the surface accepts is documented with no routes. Undefined when no
 * generator on any surface carries an `expose` or a `filter`.
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
  if (mounts.length === 0 || mounts.some((m) => m.expose === undefined && m.filter === undefined)) return undefined;
  return (entity) => {
    // A TPH subtype has no routes file of its own: its mounts live in the base's file, so the
    // base is the entity the generator's `filter` and `expose` were applied to.
    const mounted = tphDiscriminatorBase(entity) ?? entity;
    const union = new Set<CrudVerb>();
    for (const m of mounts) {
      // An entity the generator's own `filter` rejects is mounted by that generator nowhere.
      if (m.filter !== undefined && !m.filter(mounted)) continue;
      for (const v of resolveExpose(mounted, m.expose) ?? CRUD_VERBS) union.add(v);
    }
    return CRUD_VERBS.filter((v) => union.has(v));
  };
}

/**
 * A routes generator ejected before `mountsRoutes` existed still mounts its routes, but the api
 * reference cannot see its `expose` or `filter` and documents all five verbs for every entity.
 * Warned about when the run writes an api reference, by name for the same reason as
 * {@link warnUnmarkedUiGenerators}; adding the marker silences it.
 */
export function warnUnmarkedRoutesGenerators(
  generators: readonly Generator[],
  warn: (msg: string) => void,
): void {
  if (!generators.some((g) => g.emitsApiDocs !== undefined)) return;
  const stale = generators.filter(
    (g) => (g.name === "routes-file" || g.name === "routes-file-hono") && g.mountsRoutes === undefined,
  );
  if (stale.length === 0) return;
  const names = stale.map((g) => `'${g.name}'`).join(", ");
  warn(
    `${names} mount${stale.length === 1 ? "s" : ""} routes but carr${stale.length === 1 ? "ies" : "y"} no ` +
      `'mountsRoutes' marker — an owned copy ejected before the marker existed. The api reference ` +
      `lists every verb for every entity whatever its 'expose' or 'filter' says: add ` +
      `'mountsRoutes: opts?.expose !== undefined ? { expose: opts.expose } : {}' beside 'name:' in your ` +
      `copy (and 'filter' likewise), or re-eject it with 'meta eject routes --force'.`,
  );
}
