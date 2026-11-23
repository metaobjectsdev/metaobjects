// Relations block template — emits the Drizzle relations() block for one entity.
// Derived from the RelationMap pre-pass (relation-resolver.ts).

import type { Code } from "../poet.js";
import { TsWriter } from "../writer/ts-writer.js";
import type { MetaObject } from "@metaobjectsdev/metadata";
import { CARDINALITY_ONE, CARDINALITY_MANY } from "@metaobjectsdev/metadata";
import { type RenderContext } from "../render-context.js";
import { crossEntitySpecifier } from "../import-path.js";
import type { RelationEntry } from "../relation-resolver.js";
import { effectivePackage } from "../docs-paths.js";
import { tphStorageObject } from "../tph.js";
import { pkInfoOf } from "../pk-resolver.js";

/**
 * Render the relations() block for one entity.
 * Returns null if the entity has no relations to emit.
 */
export function renderRelationsBlock(entity: MetaObject, ctx: RenderContext): Code | null {
  const w = new TsWriter();
  return writeRelationsBlock(w, entity, ctx) ? w.toCode() : null;
}

/** Write the relations() block into `w`; false, with nothing written, when there is none. */
export function writeRelationsBlock(w: TsWriter, entity: MetaObject, ctx: RenderContext): boolean {
  const entries = ctx.relationMap.get(entity.name);
  if (!entries || entries.length === 0) return false;

  const varName = ctx.collectionName(entity.name);
  const relationsFn = w.use("relations", "drizzle-orm");
  const relationsVarName = `${varName}Relations`;

  const hasOne = entries.some((e) => e.cardinality === CARDINALITY_ONE);
  const hasMany = entries.some((e) => e.cardinality === CARDINALITY_MANY);

  const paramParts: string[] = [];
  if (hasOne) paramParts.push("one");
  if (hasMany) paramParts.push("many");
  const params = `{ ${paramParts.join(", ")} }`;

  const thisEntityPackage = effectivePackage(entity);
  w.blank();
  w.block(`export const ${relationsVarName} = ${relationsFn}(${varName}, (${params}) => ({`, () => {
    for (const entry of entries) {
      w.line(relationEntry(w, entry, ctx, entity, varName, thisEntityPackage), ",");
    }
  }, "}));");
  return true;
}

function relationEntry(
  w: TsWriter,
  entry: RelationEntry,
  ctx: RenderContext,
  thisEntity: MetaObject,
  thisVarName: string,
  thisEntityPackage: string | undefined,
): string {
  // FR-018 M:N: the source navigates through the junction table, so the Drizzle
  // many() targets the JUNCTION, not the target entity (the relational query API
  // then hops junction → target via the junction's one() sides). The
  // mountM2mRoute the routes generator emits performs the flattened two-stage
  // traversal for the REST contract.
  if (entry.cardinality === CARDINALITY_MANY && entry.junctionEntity !== undefined && entry.junction !== undefined) {
    const junctionSpec = crossEntitySpecifier(
      ctx.outputLayout,
      thisEntityPackage,
      effectivePackage(entry.junction),
      entry.junctionEntity,
      ctx.extStyle,
    );
    return `${entry.name}: many(${w.use(ctx.collectionName(entry.junctionEntity), junctionSpec)})`;
  }

  // Bind to the table that stores the target's rows: a TPH subtype's module has no
  // table const, so a navigation onto `Carrier` binds `parties` from `Party`.
  const targetTable = tphStorageObject(entry.target);
  const targetTableEntity = targetTable.name;
  // A navigation onto this entity's OWN table (`Order.parent`, or a TPH base onto one of
  // its subtypes) names the local const: importing it from this very module clashes with
  // its declaration (TS2440). Otherwise the writer collects the cross-entity import.
  const targetVar = targetTable === thisEntity
    ? thisVarName
    : w.use(ctx.collectionName(targetTableEntity), crossEntitySpecifier(
      ctx.outputLayout,
      thisEntityPackage,
      effectivePackage(targetTable),
      targetTableEntity,
      ctx.extStyle,
    ));

  if (entry.cardinality === CARDINALITY_ONE) {
    const pkInfo = pkInfoOf(targetTable);
    const targetPkField = pkInfo?.fieldName ?? "id";
    return `${entry.name}: one(${targetVar}, { fields: [${thisVarName}.${entry.fkField ?? "id"}], references: [${targetVar}.${targetPkField}] })`;
  }
  return `${entry.name}: many(${targetVar})`;
}
