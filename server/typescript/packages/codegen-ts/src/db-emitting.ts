// Which objects make a project a DATABASE project — and therefore require a `dialect`.
//
// THIS IS THE ONE ANSWER, and it is hoisted here because two commands need it and a second
// copy would be a second answer. `runGen` throws when a model emits database code and the
// config declares no dialect (see `missingDialectMessage`), and it throws BEFORE
// `normalizeConfig` fills its defaults on purpose: `DEFAULT_DIALECT` is INERT, existing
// only so a value-object-only project need not name one. A DB project that forgot it gets
// a named error rather than silently-defaulted output — "a Postgres project quietly
// emitting sqlite", as the runner's own comment puts it.
//
// `meta docs` needs the same answer for `agent/schema.md`. Reading `?? DEFAULT_DIALECT`
// there instead would document a sqlite schema for a project `meta gen` refuses to build
// — asserting an answer the toolchain never gave.

import type { MetaObject } from "@metaobjectsdev/metadata";
import { hasAnyRdbSource } from "./source-detect.js";

/** The concrete objects a run would emit database code for. Empty ⇒ no dialect needed. */
export function dbEmittingObjects(entities: readonly MetaObject[]): MetaObject[] {
  return entities.filter((e) => !e.isAbstract && hasAnyRdbSource(e));
}

/** The one wording for "this model needs a dialect and the config has none". */
export function missingDialectMessage(dbEmitting: readonly MetaObject[]): string {
  const names = dbEmitting.map((e) => e.name).join(", ");
  return (
    `codegen config is missing dialect — required because this model ` +
    `generates database code for: ${names}. Set dialect in ` +
    `metaobjects.config.ts. (A model of only value objects and/or sourceless projections may omit it.)`
  );
}
