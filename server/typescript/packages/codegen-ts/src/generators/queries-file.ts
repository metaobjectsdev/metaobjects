import type { MetaObject } from "@metaobjectsdev/metadata";
import { perEntity, type Generator, type GeneratorFactory } from "../generator.js";
import { renderQueriesFile } from "../templates/queries-file.js";
import { isTphSubtype } from "../templates/zod-validators.js";
import { hasAnyRdbSource } from "../source-detect.js";
import { formatTs } from "../format.js";
import { entityOutputPath } from "../import-path.js";

export interface QueriesFileOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
}

// #248 R2: persistability derives from declared/inherited source, never
// subtype. An object with no source.rdb (of ANY kind) isn't backed by any
// store — the rendered queries module would emit findById/updateById/deleteById
// against Drizzle table/schema exports the entity-file generator never emits
// for it. object.value is subsumed here too: value purity (ADR-0028) bans
// sources on values, loader-enforced (ERR_SUBTYPE_RULE_VIOLATION), so no
// loadable value ever has hasAnyRdbSource === true — no separate value check
// needed. Skipping non-source objects is unconditional — the user-supplied
// filter (if any) is applied on top via boolean AND.
//
// FR-017 Tier 2: TPH subtypes are ALSO skipped — they emit no standalone
// queries file. Their per-subtype CRUD helpers live in the discriminator
// base's queries file (which targets the single shared table).
const skipNonQueryable = (e: MetaObject): boolean => hasAnyRdbSource(e) && !isTphSubtype(e);

export const queriesFile = function queriesFile(opts?: QueriesFileOpts): Generator {
  const userFilter = opts?.filter;
  const filter: (e: MetaObject) => boolean = userFilter
    ? (e) => skipNonQueryable(e) && userFilter(e)
    : skipNonQueryable;

  const generator: Generator = {
    name: "queries-file",
    filter,
    generate: perEntity(async (entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("queries-file: renderContext is required (provided by runGen)");
      }
      return {
        path: entityOutputPath(ctx.config.outputLayout ?? "flat", entity.package, `${entity.name}.queries.ts`),
        content: await formatTs(renderQueriesFile(entity, ctx.renderContext)),
      };
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<QueriesFileOpts>;
