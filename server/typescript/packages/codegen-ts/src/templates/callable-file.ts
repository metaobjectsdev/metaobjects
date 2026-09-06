// FR-015 — render a typed wrapper function for an entity backed by a stored
// procedure or table function. One generated file per callable entity:
//
//   import { sql } from "drizzle-orm";
//   import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
//   import type { PhaseSummaryArgs } from "./PhaseSummaryArgs.js";
//   import { PhaseSummarySchema, type PhaseSummary } from "./PhaseSummary.js";
//
//   export async function callPhaseSummary(
//     db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
//     args: PhaseSummaryArgs,
//   ): Promise<PhaseSummary[]> {
//     const r = await db.execute(
//       sql`SELECT * FROM fn_phase_summary(${args.caseId}, ${args.asOfDate})`,
//     );
//     return r.rows.map((row) => PhaseSummarySchema.parse(row));
//   }
//
// Zero-argument procs (no @parameterRef) emit a no-args version that drops the
// `args` parameter and calls `fn_x()`.

import {
  primaryRdbSource,
  type MetaObject,
  type MetaSource,
  isMetaSource,
  SOURCE_ATTR_PARAMETER_REF,
  SOURCE_KIND_STORED_PROC,
  SOURCE_KIND_TABLE_FUNCTION,
  TYPE_FIELD,
  TYPE_SOURCE,
  OBJECT_SUBTYPE_VALUE,
} from "@metaobjectsdev/metadata";
import { GENERATED_HEADER } from "../constants.js";
import { crossEntitySpecifier } from "../import-path.js";
import { resolveObjectNames } from "../names.js";
import type { RenderContext } from "../render-context.js";

const CALLABLE_KINDS: ReadonlySet<string> = new Set([
  SOURCE_KIND_STORED_PROC,
  SOURCE_KIND_TABLE_FUNCTION,
]);

/** Return true when this entity is backed by a callable source (stored
 *  procedure or table function). Used by the generator factory to filter. */
export function isCallableEntity(entity: MetaObject): boolean {
  const src = callableSource(entity);
  return src !== undefined;
}

function callableSource(entity: MetaObject): MetaSource | undefined {
  // ADR-0039: resolving — an entity may inherit its callable source.rdb via extends.
  for (const child of entity.children()) {
    if (child.type !== TYPE_SOURCE) continue;
    // isMetaSource, not `instanceof`: a split @metaobjectsdev/metadata tree would
    // make the class check false and silently emit no callable wrapper.
    if (!isMetaSource(child)) continue;
    if (CALLABLE_KINDS.has(child.effectiveKind)) return child;
  }
  return undefined;
}

/** Render the full file content for an entity's callable wrapper. Caller
 *  is responsible for formatting (prettier / biome) and writing to disk.
 *
 *  `ctx` is optional only so the pre-existing callers that render a wrapper in isolation
 *  keep compiling; with it absent the physical name is spelled literally, which is the
 *  same documented fallback as running with `namesFile()` out of the suite. */
export function renderCallableFile(entity: MetaObject, ctx?: RenderContext): string {
  // Run the primary-source DIVERGENCE refusal before resolving a physical name.
  // `callableSource` selects by @kind with NO role filter, so it is a THIRD door into
  // "what relation does this object name" — and it is reached by `callableFile()` alone,
  // with no table-name resolver anywhere on the path. Without this an object whose
  // @role: primary sources disagree emitted a wrapper bound to the inherited parent's
  // procedure, on a model every other tier refuses. A refusal that depends on which
  // generators ran is not a refusal.
  //
  // The SELECTION below is deliberately unchanged: divergence is about the NAME, while
  // this function additionally asks "which source is callable?". Same shape as
  // MetaObject.dbTable and the JVM/C# findPrimaryWritableSource.
  primaryRdbSource(entity);
  const source = callableSource(entity);
  if (source === undefined) {
    throw new Error(
      `renderCallableFile: entity "${entity.name}" has no source.rdb with @kind: "storedProc" or "tableFunction"`,
    );
  }

  const procName = source.physicalName;
  // ADR-0039: resolving — a source may inherit @parameterRef via extends.
  const argsRef = source.attr(SOURCE_ATTR_PARAMETER_REF);
  const argsObjectName = typeof argsRef === "string" && argsRef !== "" ? argsRef : undefined;

  // Resolve the parameter value-object (when set) — same root as the entity.
  const root = entity.root();
  // ADR-0039: resolving — root has no super (children()==ownChildren()).
  const argsObject =
    argsObjectName !== undefined
      ? (root.children().find(
          (c) =>
            c.subType === OBJECT_SUBTYPE_VALUE && c.name === argsObjectName,
        ) as MetaObject | undefined)
      : undefined;

  // Build the parameter list for the SQL call site. Declaration order = arg
  // order. Empty when argsObject is undefined (zero-arg proc).
  // ADR-0039: resolving — a value object may inherit fields via extends (shape reuse).
  const paramFieldNames: string[] = argsObject
    ? argsObject.children()
        .filter((c) => c.type === TYPE_FIELD)
        .map((f) => f.name)
    : [];

  const sqlArgList = paramFieldNames.length === 0
    ? ""
    : paramFieldNames.map((n) => `\${args.${n}}`).join(", ");

  // §A6 — reference `<Entity>Names.sources.primary.proc` rather than spelling the
  // procedure a SECOND time.
  // This file is a raw string template rather than ts-poet, so the import is composed here
  // instead of through `imp`; `crossEntitySpecifier` is the same helper `namesRef` uses, so
  // the specifier (and its extension style) cannot drift from every other generator's.
  const namesConst =
    ctx !== undefined && ctx.includeNames &&
    resolveObjectNames(entity, ctx.columnNamingStrategy) !== undefined
      ? `${entity.name}Names`
      : undefined;
  const namesImport = namesConst === undefined
    ? ""
    : `import { ${namesConst} } from "${crossEntitySpecifier(
        ctx!.selfTarget.outputLayout, entity.package, entity.package,
        `${entity.name}.names`, ctx!.extStyle,
      )}";\n`;
  // The identifier must stay an IDENTIFIER. A bare interpolation into drizzle's `sql` tag
  // binds a PARAMETER, so `sql`SELECT * FROM ${Names.sources.primary.proc}(…)`` would send the procedure
  // name as a query argument and produce SQL that cannot execute. `sql.raw` splices text.
  // `sql.identifier` is deliberately not used: it quotes, which changes the statement.
  const procNameExpr = namesConst === undefined
    ? procName
    : `\${${"sql.raw"}(${namesConst}.name)}`;

  const fnName = `call${entity.name}`;
  const projectionType = entity.name;
  const projectionSchemaName = `${entity.name}Schema`;

  // Imports: entity (Zod schema + type) + drizzle sql + the args value-object
  // when applicable.
  const argsImport = argsObject
    ? `import type { ${argsObjectName} } from "./${argsObjectName}.js";\n`
    : "";

  // The `db` parameter type carries the same open-type-argument rule as the queries
  // file's `Db` alias (see templates/queries-file.ts `dbTypeBlock`): `PgDatabase` is the
  // base every PG driver extends, and the schema parameter stays at Drizzle's own bound
  // `Record<string, unknown>` — NOT its `Record<string, never>` default, which rejects the
  // idiomatic `drizzle(client, { schema })` db with TS2345 and makes this callable
  // uninvokable. Uncompilable generated code is indistinguishable from unused generated
  // code, so this parameter must never be narrowed back.
  const signature = argsObject
    ? `db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>, args: ${argsObjectName}`
    : `db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>`;

  return `// ${GENERATED_HEADER}
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
${namesImport}${argsImport}import { ${projectionSchemaName}, type ${projectionType} } from "./${entity.name}.js";

/**
 * FR-015: typed wrapper around the ${source.effectiveKind === SOURCE_KIND_STORED_PROC ? "stored procedure" : "table function"} named by
 * \`${namesConst === undefined ? procName : `${namesConst}.name`}\`.
 * Drizzle passes a parameterised SELECT — args bind in declaration order from
 * the @parameterRef value-object${argsObject ? `, here ${argsObjectName}` : ""}.
 */
export async function ${fnName}(${signature}): Promise<${projectionType}[]> {
  const r = await db.execute(
    sql\`SELECT * FROM ${procNameExpr}(${sqlArgList})\`,
  );
  return r.rows.map((row) => ${projectionSchemaName}.parse(row as unknown));
}
`;
}
