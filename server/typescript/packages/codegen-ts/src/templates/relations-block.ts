// Relations block template — emits the Drizzle relations() block for one entity.
// Derived from the RelationMap pre-pass (relation-resolver.ts).

import { code, imp, joinCode, type Code } from "ts-poet";
import type { MetaObject } from "@metaobjectsdev/metadata";
import { CARDINALITY_ONE, CARDINALITY_MANY } from "@metaobjectsdev/metadata";
import { type RenderContext } from "../render-context.js";
import { crossEntitySpecifier } from "../import-path.js";
import { variableNameFromEntity } from "../naming.js";
import type { RelationEntry } from "../relation-resolver.js";

/**
 * Render the relations() block for one entity.
 * Returns null if the entity has no relations to emit.
 */
export function renderRelationsBlock(entity: MetaObject, ctx: RenderContext): Code | null {
  const entries = ctx.relationMap.get(entity.name);
  if (!entries || entries.length === 0) return null;

  const varName = variableNameFromEntity(entity.name);
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
  // Use imp() for cross-entity references so ts-poet tracks and emits the import.
  const targetSpec = crossEntitySpecifier(
    ctx.outputLayout,
    thisEntityPackage,
    ctx.packageOf.get(entry.targetEntity),
    entry.targetEntity,
    ctx.extStyle,
  );
  const targetVarSym = imp(`${variableNameFromEntity(entry.targetEntity)}@${targetSpec}`);

  if (entry.cardinality === CARDINALITY_ONE) {
    const pkInfo = ctx.pkMap.get(entry.targetEntity);
    const targetPkField = pkInfo?.fieldName ?? "id";
    return code`  ${entry.name}: one(${targetVarSym}, { fields: [${thisVarName}.${entry.fkField ?? "id"}], references: [${targetVarSym}.${targetPkField}] })`;
  }
  return code`  ${entry.name}: many(${targetVarSym})`;
}
