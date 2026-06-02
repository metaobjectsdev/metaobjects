// FR-015 — render a typed wrapper function for an entity backed by a stored
// procedure or table function. One generated file per callable entity:
//
//   import { sql } from "drizzle-orm";
//   import type { NodePgDatabase } from "drizzle-orm/node-postgres";
//   import type { PhaseSummaryArgs } from "./PhaseSummaryArgs.js";
//   import { PhaseSummarySchema, type PhaseSummary } from "./PhaseSummary.js";
//
//   export async function callPhaseSummary(
//     db: NodePgDatabase,
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
  type MetaObject,
  MetaSource,
  SOURCE_ATTR_PARAMETER_REF,
  SOURCE_KIND_STORED_PROC,
  SOURCE_KIND_TABLE_FUNCTION,
  TYPE_FIELD,
  TYPE_SOURCE,
  OBJECT_SUBTYPE_VALUE,
} from "@metaobjectsdev/metadata";
import { GENERATED_HEADER } from "../constants.js";

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
  for (const child of entity.ownChildren()) {
    if (child.type !== TYPE_SOURCE) continue;
    if (!(child instanceof MetaSource)) continue;
    if (CALLABLE_KINDS.has(child.effectiveKind)) return child;
  }
  return undefined;
}

/** Render the full file content for an entity's callable wrapper. Caller
 *  is responsible for formatting (prettier / biome) and writing to disk. */
export function renderCallableFile(entity: MetaObject): string {
  const source = callableSource(entity);
  if (source === undefined) {
    throw new Error(
      `renderCallableFile: entity "${entity.name}" has no source.rdb with @kind: "storedProc" or "tableFunction"`,
    );
  }

  const procName = source.physicalName;
  const argsRef = source.ownAttr(SOURCE_ATTR_PARAMETER_REF);
  const argsObjectName = typeof argsRef === "string" && argsRef !== "" ? argsRef : undefined;

  // Resolve the parameter value-object (when set) — same root as the entity.
  const root = entity.root();
  const argsObject =
    argsObjectName !== undefined
      ? (root.ownChildren().find(
          (c) =>
            c.subType === OBJECT_SUBTYPE_VALUE && c.name === argsObjectName,
        ) as MetaObject | undefined)
      : undefined;

  // Build the parameter list for the SQL call site. Declaration order = arg
  // order. Empty when argsObject is undefined (zero-arg proc).
  const paramFieldNames: string[] = argsObject
    ? argsObject.ownChildren()
        .filter((c) => c.type === TYPE_FIELD)
        .map((f) => f.name)
    : [];

  const sqlArgList = paramFieldNames.length === 0
    ? ""
    : paramFieldNames.map((n) => `\${args.${n}}`).join(", ");

  const fnName = `call${entity.name}`;
  const projectionType = entity.name;
  const projectionSchemaName = `${entity.name}Schema`;

  // Imports: entity (Zod schema + type) + drizzle sql + the args value-object
  // when applicable.
  const argsImport = argsObject
    ? `import type { ${argsObjectName} } from "./${argsObjectName}.js";\n`
    : "";

  const signature = argsObject
    ? `db: NodePgDatabase, args: ${argsObjectName}`
    : `db: NodePgDatabase`;

  return `// ${GENERATED_HEADER}
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
${argsImport}import { ${projectionSchemaName}, type ${projectionType} } from "./${entity.name}.js";

/**
 * FR-015: typed wrapper around the \`${procName}\` ${source.effectiveKind === SOURCE_KIND_STORED_PROC ? "stored procedure" : "table function"}.
 * Drizzle passes a parameterised SELECT — args bind in declaration order from
 * the @parameterRef value-object${argsObject ? `, here ${argsObjectName}` : ""}.
 */
export async function ${fnName}(${signature}): Promise<${projectionType}[]> {
  const r = await db.execute(
    sql\`SELECT * FROM ${procName}(${sqlArgList})\`,
  );
  return r.rows.map((row) => ${projectionSchemaName}.parse(row as unknown));
}
`;
}
