// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/cube-model.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { cubeModel } from "./codegen/generators/cube-model.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       Cube (cube.dev) data-model files. The emitted YAML imports nothing and needs no
//                MetaObjects package at runtime; Cube reads `model/cubes/*.yml` from its own
//                project. Cube lists Postgres and MySQL among its data sources, and those are
//                the two dialects this writes SQL for (`dialect` option, default the config's).
// use-when:      the model declares reporting vocabulary (`dimension.*`, `measure.*`,
//                `segment.filter`, a served `object.report`) and you want it as Cube cubes,
//                joins, dimensions, measures, segments and a rollup per served report. A model
//                that declares none gets no file, even when this is configured.
// emits:         <target>/model/cubes/<Cube>.yml, one per cube: each table-backed entity that
//                declares or inherits reporting vocabulary, each entity a `@via` path reaches,
//                and an alias cube for a join that needs its own copy of an entity.
// customize:     which entities get a cube file (`selected` in `generateCubeFiles`, narrowed
//                further by the `filter` option), where the files land (`cubeFilePath`) and the
//                YAML text (the `renderCubeYaml` call; swap it for your own writer to change the
//                file format). Stays in the package: `buildCubeModel`, which maps the vocabulary
//                to cube specs and raises every refusal (`CubeModelError`), and
//                `renderCubeYaml`, the deterministic YAML writer, both exported from the
//                package root. Replace them only if you mean to stop agreeing with every other
//                consumer of the same model.
// composes-with: nothing. It reads the reporting vocabulary, not another generator's output.
//
// What a cube holds never depends on the run. The build's universe is the whole loaded model
// narrowed by this generator's own `filter`, which is fixed config, so `meta gen Week` and a full
// run write the same bytes for Week.yml. The run's selection (`meta gen <Entity>`, a project's
// `scope`) decides only WHICH files are written: each selected entity's own cube, and every cube
// it reaches through joins, transitively. A reached cube is written because a selected cube
// changes it: a `@via` adds the member it reads to the cube it reaches (`Week.programTitle` adds
// Program's `title`), so leaving that file out would leave a reference to a member the file on
// disk may not have. A run that selects no entity with reporting vocabulary writes nothing and
// raises nothing, under any dialect.
//
// A cube file whose cube is gone is cleaned up. Cube compiles the whole model directory, so a
// stale `<Cube>.yml` left behind by a removed or renamed entity (or a join no longer reached)
// can break the compile for every cube. This generator opts in to the runner's orphan
// reconciliation (`orphanPolicy`) for exactly its own files: the direct `.yml` children of
// `model/cubes/` under its target (`ownsCubeFile`). The runner removes such a file only when a
// previous run wrote it, this run did not re-emit it, and it is byte-identical to what was
// written; a file edited by hand is refused and named, never deleted. The runner does not
// reconcile at all when the run named entities (`meta gen <Entity>`), which is the only per-run
// narrowing `meta gen` has: a project's `scope` is collection config, the same on every run, so
// a changed scope reconciles like any full run (an untouched file the scope no longer selects
// is removed). If you move the files, change `ownsCubeFile` with them (it must describe where
// `cubeFilePath` writes), or delete the `orphanPolicy` line to turn the cleanup off.
//
// Everything below imports ONLY from `@metaobjectsdev/codegen-ts` (the stable engine) and
// `@metaobjectsdev/metadata` (the entity type and the default column naming strategy).

import {
  ERR_CUBE_UNSUPPORTED_DIALECT,
  CubeModelError,
  buildCubeModel,
  hasReportingVocabulary,
  renderCubeYaml,
  type CubeDialect,
  type CubeModel,
  type CubeSpec,
  type EmittedFile,
  type GenContext,
  type Generator,
} from "@metaobjectsdev/codegen-ts";
import { DEFAULT_COLUMN_NAMING_STRATEGY, type MetaObject } from "@metaobjectsdev/metadata";

export interface CubeModelGeneratorOptions {
  /** The SQL dialect of the database Cube reads. Default: the codegen config's `dialect`. */
  readonly dialect?: CubeDialect;
  /**
   * Which entities the Cube model covers, ANDed with the reporting-vocabulary gate. It is the
   * build's universe, so an entity it excludes gets no cube of its own (no measures, segments or
   * rollups) and its dimensions add no member to a cube they would reach. If another cube's
   * `@via` reaches an excluded entity, it is still written, as a join-target cube.
   */
  readonly filter?: (obj: MetaObject) => boolean;
  /** Named output target: the files land at `model/cubes/<Cube>.yml` under its outDir. */
  readonly target?: string;
}

/** The generator's name, as diagnostics and the catalog print it. */
const GENERATOR_NAME = "cube-model";

/** Where a cube's file lands, relative to the target's outDir. */
const CUBE_FILE_DIR = "model/cubes";

/** The dialects the Cube SQL is written for. */
const CUBE_DIALECTS: readonly CubeDialect[] = ["postgres", "mysql"];

/** How many entities the dialect refusal names before it counts the rest. */
const NAMED_IN_MESSAGE = 3;

/** `model/cubes/<Cube>.yml`. */
function cubeFilePath(cube: string): string {
  return `${CUBE_FILE_DIR}/${cube}.yml`;
}

/**
 * The orphan namespace: a direct `.yml` child of `model/cubes/`, relative to the target's outDir
 * and `/`-separated. Keep it narrow, because the predicate is the blast radius of the cleanup.
 * Only paths a previous run recorded are ever tested against it, so a hand-written cube beside
 * the generated ones is not at risk.
 */
function ownsCubeFile(relPathInTarget: string): boolean {
  const prefix = `${CUBE_FILE_DIR}/`;
  if (!relPathInTarget.startsWith(prefix) || !relPathInTarget.endsWith(".yml")) return false;
  return !relPathInTarget.slice(prefix.length).includes("/");
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
    `cube-model would write cubes for ${which} in ${source}, '${dialect}', and it writes Cube SQL only for postgres and mysql: Cube lists Postgres and MySQL among its data sources, and those are the dialects this exporter quotes and casts for. Pass the dialect of the database Cube reads to the generator: cubeModel({ dialect: "postgres" }) or cubeModel({ dialect: "mysql" }).`,
  );
}

/** The cubes named `roots` and every cube their joins reach, transitively, in model order. */
function reachedCubes(model: CubeModel, roots: readonly string[]): CubeSpec[] {
  const byName = new Map(model.cubes.map((c) => [c.name, c]));
  const reached = new Set<string>();
  const visit = (name: string): void => {
    if (reached.has(name)) return;
    const cube = byName.get(name);
    if (cube === undefined) throw new Error(`cube-model: the built model has no cube '${name}'.`);
    reached.add(name);
    for (const join of cube.joins) visit(join.name);
  };
  for (const name of roots) visit(name);
  return model.cubes.filter((c) => reached.has(c.name));
}

function generateCubeFiles(ctx: GenContext, options: CubeModelGeneratorOptions): EmittedFile[] {
  // The run's selection, narrowed by the filter, keeping the entities that are their own cube;
  // a cube is named after its entity. A report is never selected itself: its rollup rides with
  // its @from cube.
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
  // Cube views (a @spine report) have no renderer yet; none is built until they do.
  if (model.views.length > 0) throw new Error("cube-model: the model holds Cube views, which this generator does not write yet.");
  return reachedCubes(model, selected.map((o) => o.name)).map((cube) => ({
    path: cubeFilePath(cube.name),
    content: renderCubeYaml(cube),
  }));
}

/**
 * The cube-model generator: one Cube data-model file per cube, `model/cubes/<Cube>.yml`, for the
 * reporting vocabulary of the loaded model. Throws `CubeModelError` for what Cube cannot be given,
 * and `ERR_CUBE_UNSUPPORTED_DIALECT` when the dialect is neither postgres nor mysql and the run
 * would write a cube.
 */
export function cubeModel(options: CubeModelGeneratorOptions = {}): Generator {
  const generator: Generator = {
    name: GENERATOR_NAME,
    generate: (ctx) => generateCubeFiles(ctx, options),
    orphanPolicy: { owns: ownsCubeFile },
  };
  if (options.filter !== undefined) generator.filter = options.filter;
  if (options.target !== undefined) generator.target = options.target;
  return generator;
}
