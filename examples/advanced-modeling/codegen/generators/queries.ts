// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/queries.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { queriesFile } from "./codegen/generators/queries.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       Drizzle. Emitted helpers take `db` as a PARAMETER rather than importing
//                a module singleton, so they compose with any caller that already holds a
//                connection — including a server-rendered component. Swap the
//                `write<Verb>Fn` primitives (findById/list/create/update/deleteById) and
//                the `Db` type alias in the copied templates to emit for another query builder.
// use-when:      you want generated typed CRUD finders (find<E>ById, list<E>s, create/update/delete)
//                over Drizzle. Drop it if you hand-write your data access.
// emits:         <target>/<Entity>.queries.ts per source-backed object (any source.rdb kind,
//                incl. read-only projections) — skipped for sourceless objects (incl. every
//                object.value, source-less by value purity) and TPH subtypes (#248 R2).
// customize:     the file's COMPOSITION is `writeQueriesFile` in ../templates/queries-file.ts,
//                and each verb's body a `write<Verb>Fn` in ../templates/queries.ts; `meta eject
//                queries` copied both beside this file. They are OWNED — reorder, drop verbs
//                (e.g. no delete), change the Db type alias, add your own finders there.
// composes-with: entity.ts (imports the table + InsertSchema it emits).

import type { MetaObject } from "@metaobjectsdev/metadata";
import {
  perEntity,
  type Generator,
  type GeneratorFactory,
  servesReadApi,
  DEFAULT_OUTPUT_LAYOUT,
  entityOutputPath,
  effectivePackage,
  isTphSubtype,
  claimModuleNames,
} from "@metaobjectsdev/codegen-ts/engine";
import { renderQueriesFile } from "../templates/queries-file.js";

export interface QueriesFileOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
}

// #248 R2: persistability derives from declared/inherited source, never subtype.
// An object with no source.rdb (of ANY kind) isn't backed by any store — the
// rendered queries module would emit findById/updateById/deleteById against
// Drizzle table/schema exports the entity file never emits for it (value
// objects are subsumed here too: value purity bans sources on them, so no
// loadable value ever has hasAnyRdbSource === true). TPH subtypes emit no
// standalone queries file either — their per-subtype CRUD helpers live in the
// discriminator base's queries file (which targets the single shared table).
// Abstract objects are skipped too (`servesReadApi`): an abstract level has no table of
// its own, only a type-only shape, so a queries module for it cannot compile.
const skipNonQueryable = (e: MetaObject): boolean => servesReadApi(e) && !isTphSubtype(e);

export const queriesFile = function queriesFile(opts?: QueriesFileOpts): Generator {
  const userFilter = opts?.filter;
  const filter: (e: MetaObject) => boolean = userFilter
    ? (e) => skipNonQueryable(e) && userFilter(e)
    : skipNonQueryable;

  const generator: Generator = {
    name: "queries-file",
    // Read by the api reference (`apiDocsFile()`): it documents the query helpers only when
    // a generator in the run writes them.
    provides: { queries: true },
    filter,
    generate: perEntity(async (entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("queries-file: renderContext is required (provided by runGen)");
      }
      claimModuleNames(ctx, entity);
      return {
        path: entityOutputPath(ctx.config.outputLayout ?? DEFAULT_OUTPUT_LAYOUT, effectivePackage(entity), `${entity.name}.queries.ts`),
        content: renderQueriesFile(entity, ctx.renderContext),
      };
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<QueriesFileOpts>;
