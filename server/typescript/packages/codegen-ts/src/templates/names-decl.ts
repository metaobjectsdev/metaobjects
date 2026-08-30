/**
 * §A1/§A2 — `<Entity>Names`: the physical database names for one object, as constants a
 * hand-written consumer references instead of a string literal.
 *
 * Shape copied from the FR-009 filter allowlist, which is the same problem (a per-entity
 * name artifact) already solved in all five ports. Deliberately NOT folded into the entity
 * descriptor: four of five ports have no descriptor to extend, and merging in TypeScript
 * alone would make TS the odd port out on the axis this project protects hardest.
 */
import type { ColumnNamingStrategy, MetaObject } from "@metaobjectsdev/metadata";
import { resolveObjectNames } from "../names.js";

export function renderNamesDecl(obj: MetaObject, strategy?: ColumnNamingStrategy): string {
  const n = resolveObjectNames(obj, strategy);
  if (n === undefined) return "";

  // Sorted, so output depends on the model rather than on child order.
  const fieldRows = Object.keys(n.fields).sort().map((k) => {
    const f = n.fields[k];
    if (f === undefined) return "";
    return `    ${k}: { name: ${JSON.stringify(f.name)}, column: ${JSON.stringify(f.column)} },`;
  }).filter((r) => r !== "").join("\n");

  const schemaLine = n.schema === undefined ? "" : `\n  schema: ${JSON.stringify(n.schema)},`;

  return `export const ${obj.name}Names = {
  kind: ${JSON.stringify(n.kind)},
  name: ${JSON.stringify(n.name)},${schemaLine}
  readOnly: ${n.readOnly},
  fields: {
${fieldRows}
  },
} as const;
`;
}
