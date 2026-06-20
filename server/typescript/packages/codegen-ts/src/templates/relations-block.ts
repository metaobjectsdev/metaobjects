// Relations block template — emits the Drizzle relations() block for one entity.
// Derived from the RelationMap pre-pass (relation-resolver.ts).

import { code, imp, joinCode, type Code } from "ts-poet";
import type { MetaObject } from "@metaobjectsdev/metadata";
import { CARDINALITY_ONE, CARDINALITY_MANY } from "@metaobjectsdev/metadata";
import { type RenderContext } from "../render-context.js";
import { crossEntitySpecifier } from "../import-path.js";
import type { RelationEntry } from "../relation-resolver.js";

/**
 * Render the relations() block for one entity.
 * Returns null if the entity has no relations to emit.
 */
export function renderRelationsBlock(entity: MetaObject, ctx: RenderContext): Code | null {
  const entries = ctx.relationMap.get(entity.name);
  if (!entries || entries.length === 0) return null;

  const varName = ctx.collectionName(entity.name);
  const relationsFn = imp("relations@drizzle-orm");
  const relationsVarName = `${varName}Relations`;

  const hasOne = entries.some((e) => e.cardinality === CARDINALITY_ONE);
  const hasMany = entries.some((e) => e.cardinality === CARDINALITY_MANY);

  const paramParts: string[] = [];
  if (hasOne) paramParts.push("one");
  if (hasMany) paramParts.push("many");
  const params = `{ ${paramParts.join(", ")} }`;

  const thisEntityPackage = entity.package;
  const lines: Code[] = entries.map((entry) =>
    renderRelationEntry(entry, ctx, varName, thisEntityPackage),
  );

  return code`export const ${relationsVarName} = ${relationsFn}(${varName}, (${params}) => ({
${joinCode(lines, { on: ",\n", trim: false })}
}));
`;
}

function renderRelationEntry(
  entry: RelationEntry,
  ctx: RenderContext,
  thisVarName: string,
  thisEntityPackage: string | undefined,
): Code {
  // FR-018 M:N: the source navigates through the junction table, so the Drizzle
  // many() targets the JUNCTION, not the target entity (the relational query API
  // then hops junction → target via the junction's one() sides). The
  // mountM2mRoute the routes generator emits performs the flattened two-stage
  // traversal for the REST contract.
  if (entry.cardinality === CARDINALITY_MANY && entry.junctionEntity !== undefined) {
    const junctionSpec = crossEntitySpecifier(
      ctx.outputLayout,
      thisEntityPackage,
      ctx.packageOf.get(entry.junctionEntity),
      entry.junctionEntity,
      ctx.extStyle,
    );
    const junctionVarSym = imp(`${ctx.collectionName(entry.junctionEntity)}@${junctionSpec}`);
    return code`  ${entry.name}: many(${junctionVarSym})`;
  }

  // Use imp() for cross-entity references so ts-poet tracks and emits the import.
  const targetSpec = crossEntitySpecifier(
    ctx.outputLayout,
    thisEntityPackage,
    ctx.packageOf.get(entry.targetEntity),
    entry.targetEntity,
    ctx.extStyle,
  );
  const targetVarSym = imp(`${ctx.collectionName(entry.targetEntity)}@${targetSpec}`);

  if (entry.cardinality === CARDINALITY_ONE) {
    const pkInfo = ctx.pkMap.get(entry.targetEntity);
    const targetPkField = pkInfo?.fieldName ?? "id";
    return code`  ${entry.name}: one(${targetVarSym}, { fields: [${thisVarName}.${entry.fkField ?? "id"}], references: [${targetVarSym}.${targetPkField}] })`;
  }
  return code`  ${entry.name}: many(${targetVarSym})`;
}
