// FR-044 Plan 4 — cubeModel(), the cube-model reference generator: the reporting vocabulary
// (dimension.*, measure.*, segment.filter, served object.report) as Cube data-model files, one
// `model/cubes/<Cube>.yml` per cube and one `model/views/<Report>.yml` per served `@spine` report
// under the target's outDir. The two stages are pure and live in src/cube/: buildCubeModel
// (contract Tables A to G) and renderCubeYaml / renderCubeViewYaml (Table H's bytes). This file
// only wires them into `meta gen`.
//
// What a cube holds never depends on the run. The build's universe is the whole loaded model
// narrowed by the generator's own `filter`, which is fixed config, so `meta gen Week` and a full
// run write the same bytes for Week.yml. The run's selection (`meta gen <Entity>`, `scope`)
// decides only WHICH files are written: each selected entity's own cube, and every cube it
// reaches through joins, transitively. A reached cube is written because a selected cube changes
// it: a `@via` adds the member it reads to the cube it reaches (`Week.programTitle` adds
// Program's `title`), so leaving that file out would leave a reference to a member the file on
// disk may not have. A view is written when every cube its join paths name is written: it reads
// them, and nothing else. A run that selects no entity with reporting vocabulary writes nothing
// and raises nothing, under any dialect.
//
// A cube or view file whose cube or view is gone is cleaned up. Cube compiles the whole model directory, so a
// stale `<Cube>.yml` left behind by a removed or renamed entity (or a join no longer reached) can
// break the compile for every cube. The generator opts in to the runner's orphan reconciliation
// (`orphanPolicy`) for exactly its own files: the direct `.yml` children of `model/cubes/` and
// `model/views/` under its target. The runner removes such a file only when a previous run wrote it, this run did not
// re-emit it, and it is byte-identical to what was written; a file edited by hand is refused and
// named, never deleted. The runner does not reconcile at all when the run named entities
// (`meta gen <Entity>`), which is the only per-run narrowing `meta gen` has: a project's `scope`
// is collection config, the same on every run, so a changed scope reconciles like any full run.
//
// Opt-in, and a reference helper (ADR-0034 Amendment 3): the files import nothing.

import { DEFAULT_COLUMN_NAMING_STRATEGY, type MetaObject } from "@metaobjectsdev/metadata";
import type { EmittedFile, GenContext, Generator } from "../generator.js";
import { buildCubeModel, hasReportingVocabulary } from "../cube/build-cube-model.js";
import { CubeModelError, ERR_CUBE_UNSUPPORTED_DIALECT } from "../cube/cube-errors.js";
import {
  CUBE_MODEL_GENERATOR_NAME,
  JOIN_PATH_SEPARATOR,
  type CubeDialect,
  type CubeModel,
  type CubeSpec,
} from "../cube/cube-model-spec.js";
import { renderCubeViewYaml, renderCubeYaml } from "../cube/cube-yaml.js";

export interface CubeModelGeneratorOptions {
  /** The SQL dialect of the database Cube reads. Default: the codegen config's `dialect`. */
  readonly dialect?: CubeDialect;
  /**
   * Which entities the Cube model covers, ANDed with Table A. It is the build's universe, so an
   * entity it excludes gets no cube of its own (no measures, segments or rollups) and its
   * dimensions add no member to a cube they would reach. If another cube's `@via` reaches an
   * excluded entity, it is still written, as a join-target cube, unless every hop onto it goes
   * through an alias cube.
   */
  readonly filter?: (obj: MetaObject) => boolean;
  /** Named output target: the files land at `model/cubes/<Cube>.yml` and `model/views/<View>.yml` under its outDir. */
  readonly target?: string;
}

/** Where a cube's file lands, relative to the target's outDir (Table A). */
const CUBE_FILE_DIR = "model/cubes";

/** Where a view's file lands (a served `@spine` report), relative to the target's outDir. */
const VIEW_FILE_DIR = "model/views";

/** The dialects the exporter writes Cube SQL for (open question 3). */
const CUBE_DIALECTS: readonly CubeDialect[] = ["postgres", "mysql"];

/** How many entities the dialect refusal names before it counts the rest. */
const NAMED_IN_MESSAGE = 3;

/** `model/cubes/<Cube>.yml`. */
export function cubeFilePath(cube: string): string {
  return `${CUBE_FILE_DIR}/${cube}.yml`;
}

/** `model/views/<View>.yml`. */
export function viewFilePath(view: string): string {
  return `${VIEW_FILE_DIR}/${view}.yml`;
}

/**
 * The orphan namespace: a direct `.yml` child of `model/cubes/` or `model/views/`, relative to the
 * target's outDir and `/`-separated. Narrow on purpose, because the predicate is the blast radius
 * of the cleanup. Only paths a previous run recorded are ever tested against it, so a hand-written
 * cube or view beside the generated ones is not at risk.
 */
export function ownsCubeFile(relPathInTarget: string): boolean {
  if (!relPathInTarget.endsWith(".yml")) return false;
  return [CUBE_FILE_DIR, VIEW_FILE_DIR].some((dir) => {
    const prefix = `${dir}/`;
    return relPathInTarget.startsWith(prefix) && !relPathInTarget.slice(prefix.length).includes("/");
  });
}

function isCubeDialect(dialect: string): dialect is CubeDialect {
  return (CUBE_DIALECTS as readonly string[]).includes(dialect);
}

function unsupportedDialect(dialect: string, fromOption: boolean, entities: readonly MetaObject[]): CubeModelError {
  const source = fromOption ? "the generator's dialect option" : "the codegen config's dialect";
  const named = entities.slice(0, NAMED_IN_MESSAGE).map((o) => `'${o.resolutionKey()}'`);
  const more = entities.length - named.length;
  const which = more > 0 ? `${named.join(", ")} and ${String(more)} more` : named.join(", ");
  return new CubeModelError(
    ERR_CUBE_UNSUPPORTED_DIALECT,
    `cube-model would write cubes for ${which} in ${source}, '${dialect}', and it writes Cube SQL only for ` +
      `postgres and mysql: Cube lists Postgres and MySQL among its data sources, and those are the dialects ` +
      `this exporter quotes and casts for. Pass the dialect of the database Cube reads to the generator: ` +
      `cubeModel({ dialect: "postgres" }) or cubeModel({ dialect: "mysql" }).`,
  );
}

/** The cubes named `roots` and every cube their joins reach, transitively, in model order. */
function reachedCubes(model: CubeModel, roots: readonly string[]): CubeSpec[] {
  const byName = new Map(model.cubes.map((c) => [c.name, c]));
  const reached = new Set<string>();
  const visit = (name: string): void => {
    if (reached.has(name)) return;
    if (!byName.has(name)) throw new Error(`cube-model: the built model has no cube '${name}'.`);
    reached.add(name);
    for (const join of byName.get(name)!.joins) visit(join.name);
  };
  for (const name of roots) visit(name);
  return model.cubes.filter((c) => reached.has(c.name));
}

function generateCubeFiles(ctx: GenContext, options: CubeModelGeneratorOptions): EmittedFile[] {
  // The run's selection, narrowed by the filter, keeping the entities that are their own cube
  // (Table A); a cube is named after its entity. A report is never selected itself: its rollup
  // rides with its @from cube.
  const selected = ctx.entities.filter((o) => ctx.matches(o) && hasReportingVocabulary(o));
  if (selected.length === 0) return [];

  const dialect = options.dialect ?? ctx.config.dialect;
  if (!isCubeDialect(dialect)) throw unsupportedDialect(dialect, options.dialect !== undefined, selected);

  const model = buildCubeModel(ctx.loadedRoot, {
    dialect,
    columnNamingStrategy: ctx.renderContext?.columnNamingStrategy ?? DEFAULT_COLUMN_NAMING_STRATEGY,
    // The generator's own filter, never the run's selection: see the header.
    matches: ctx.matches,
  });
  const cubes = reachedCubes(model, selected.map((o) => o.name));
  const written = new Set(cubes.map((c) => c.name));
  // A view reads the cubes its join paths name (Cube's dotted join-path syntax), so it is written
  // when all of them are.
  const views = model.views.filter((v) => v.cubes.every((c) => c.joinPath.split(JOIN_PATH_SEPARATOR).every((name) => written.has(name))));
  return [
    ...cubes.map((cube) => ({ path: cubeFilePath(cube.name), content: renderCubeYaml(cube) })),
    ...views.map((view) => ({ path: viewFilePath(view.name), content: renderCubeViewYaml(view) })),
  ];
}

/**
 * The cube-model generator: one Cube data-model file per cube, `model/cubes/<Cube>.yml`, and one
 * per served `@spine` report's view, `model/views/<Report>.yml`, for the reporting vocabulary of
 * the loaded model. Throws `CubeModelError` for what Cube cannot be given
 * (contract Tables C, E, F and G), and `ERR_CUBE_UNSUPPORTED_DIALECT` when the dialect is neither
 * postgres nor mysql and the run would write a cube.
 */
export function cubeModel(options: CubeModelGeneratorOptions = {}): Generator {
  const generator: Generator = {
    name: CUBE_MODEL_GENERATOR_NAME,
    generate: (ctx) => generateCubeFiles(ctx, options),
    orphanPolicy: { owns: ownsCubeFile },
  };
  if (options.filter !== undefined) generator.filter = options.filter;
  if (options.target !== undefined) generator.target = options.target;
  return generator;
}
