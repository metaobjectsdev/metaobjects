// FR-044 Plan 4 — cubeModel(), the cube-model reference generator: the reporting vocabulary
// (dimension.*, measure.*, segment.filter, served object.report) as Cube data-model files, one
// `model/cubes/<Cube>.yml` per cube under the target's outDir. The two stages are pure and live
// in src/cube/: buildCubeModel (contract Tables A to G) and renderCubeYaml (Table H's bytes).
// This file only wires them into `meta gen`.
//
// What a cube holds never depends on the run. The build's universe is the whole loaded model
// narrowed by the generator's own `filter`, which is fixed config, so `meta gen Week` and a full
// run write the same bytes for Week.yml. The run's selection (`meta gen <Entity>`, `scope`)
// decides only WHICH files are written: each selected entity's own cube, and every cube it
// reaches through joins, transitively. A reached cube is written because a selected cube changes
// it: a `@via` adds the member it reads to the cube it reaches (`Week.programTitle` adds
// Program's `title`), so leaving that file out would leave a reference to a member the file on
// disk may not have. A run that selects no entity with reporting vocabulary writes nothing and
// raises nothing, under any dialect.
//
// Opt-in, and a reference helper (ADR-0034 Amendment 3): the files import nothing.

import { DEFAULT_COLUMN_NAMING_STRATEGY, type MetaObject } from "@metaobjectsdev/metadata";
import type { EmittedFile, GenContext, Generator } from "../generator.js";
import { buildCubeModel, hasReportingVocabulary } from "../cube/build-cube-model.js";
import { CubeModelError, ERR_CUBE_UNSUPPORTED_DIALECT } from "../cube/cube-errors.js";
import type { CubeDialect, CubeModel, CubeSpec } from "../cube/cube-model-spec.js";
import { renderCubeYaml } from "../cube/cube-yaml.js";

export interface CubeModelGeneratorOptions {
  /** The SQL dialect of the database Cube reads. Default: the codegen config's `dialect`. */
  readonly dialect?: CubeDialect;
  /**
   * Which entities the Cube model covers, ANDed with Table A. It is the build's universe, so an
   * entity it excludes has no cube and adds no member to a cube it would reach.
   */
  readonly filter?: (obj: MetaObject) => boolean;
  /** Named output target: the files land at `model/cubes/<Cube>.yml` under its outDir. */
  readonly target?: string;
}

/** The generator's name, as diagnostics and the catalog print it. */
export const CUBE_MODEL_GENERATOR_NAME = "cube-model";

/** Where a cube's file lands, relative to the target's outDir (Table A). */
const CUBE_FILE_DIR = "model/cubes";

/** The dialects the exporter writes Cube SQL for (open question 3). */
const CUBE_DIALECTS: readonly CubeDialect[] = ["postgres", "mysql"];

/** How many entities the dialect refusal names before it counts the rest. */
const NAMED_IN_MESSAGE = 3;

/** `model/cubes/<Cube>.yml`. */
export function cubeFilePath(cube: string): string {
  return `${CUBE_FILE_DIR}/${cube}.yml`;
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
  // Cube views (a @spine report, Task 10) have no renderer yet; none is built until they do.
  if (model.views.length > 0) throw new Error("cube-model: the model holds Cube views, which this generator does not write yet.");
  return reachedCubes(model, selected.map((o) => o.name)).map((cube) => ({
    path: cubeFilePath(cube.name),
    content: renderCubeYaml(cube),
  }));
}

/**
 * The cube-model generator: one Cube data-model file per cube, `model/cubes/<Cube>.yml`, for the
 * reporting vocabulary of the loaded model. Throws `CubeModelError` for what Cube cannot be given
 * (contract Tables C, E, F and G), and `ERR_CUBE_UNSUPPORTED_DIALECT` when the dialect is neither
 * postgres nor mysql and the run would write a cube.
 */
export function cubeModel(options: CubeModelGeneratorOptions = {}): Generator {
  const generator: Generator = {
    name: CUBE_MODEL_GENERATOR_NAME,
    generate: (ctx) => generateCubeFiles(ctx, options),
  };
  if (options.filter !== undefined) generator.filter = options.filter;
  if (options.target !== undefined) generator.target = options.target;
  return generator;
}
