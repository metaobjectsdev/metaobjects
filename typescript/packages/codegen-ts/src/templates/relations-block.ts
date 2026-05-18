// Relations block template — emits the Drizzle relations() block for one entity.
// Derived from the RelationMap pre-pass (relation-resolver.ts).

import { code, imp, joinCode, type Code } from "ts-poet";
import type { MetaObject } from "@metaobjects/metadata";
import { CARDINALITY_ONE, CARDINALITY_MANY } from "@metaobjects/metadata";
import { type RenderContext, withExt } from "../render-context.js";
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

  const lines: Code[] = entries.map((entry) => renderRelationEntry(entry, ctx, varName));

  return code`export const ${relationsVarName} = ${relationsFn}(${varName}, (${params}) => ({
${joinCode(lines, { on: ",\n", trim: false })}
}));
`;
}

function renderRelationEntry(entry: RelationEntry, ctx: RenderContext, thisVarName: string): Code {
  // Use imp() for cross-entity references so ts-poet tracks and emits the import.
  const targetVarSym = imp(
    `${variableNameFromEntity(entry.targetEntity)}@${withExt(`./${entry.targetEntity}`, ctx.extStyle)}`,
  );

  if (entry.cardinality === CARDINALITY_ONE) {
    const pkInfo = ctx.pkMap.get(entry.targetEntity);
    const targetPkField = pkInfo?.fieldName ?? "id";
    return code`  ${entry.name}: one(${targetVarSym}, { fields: [${thisVarName}.${entry.fkField ?? "id"}], references: [${targetVarSym}.${targetPkField}] })`;
  }
  return code`  ${entry.name}: many(${targetVarSym})`;
}
