// Filter type template — emits <Entity>Filter type with subtype-gated operators.
// String fields get eq/ne/in/like; numbers get eq/ne/gt/gte/lt/lte/in; booleans get eq/isNull only;
// datetimes get eq/ne/gt/gte/lt/lte/in.

import { code, type Code } from "ts-poet";
import { MetaField, MetaObject } from "@metaobjectsdev/metadata";
import {
  FIELD_ATTR_FILTERABLE,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  opsForSubType,
} from "@metaobjectsdev/metadata";
import { isSortableField } from "./filter-shared.js";

// VALUE-type classification only (distinct from the OPERATOR band, which comes from
// opsForSubType). decimal is deliberately NOT here: its operator band stays NUMERIC
// (eq/ne/gt/gte/lt/lte/in/isNull, see OPS_BY_SUBTYPE) but its VALUE type is `string`,
// matching the entity field representation (exact decimal string, not lossy number).
const NUMBER_VALUE_SUBTYPES = new Set<string>([
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
]);

/** Maps a field subtype to its TS VALUE type name for operator union codegen. */
function tsNameFor(fieldSubType: string): string {
  if (fieldSubType === FIELD_SUBTYPE_BOOLEAN) return "boolean";
  if (NUMBER_VALUE_SUBTYPES.has(fieldSubType)) return "number";
  return "string";
}

function renderFieldUnion(field: MetaField): string {
  const ops = opsForSubType(field.subType);
  const tsName = tsNameFor(field.subType);
  const opEntries = ops.map((op) => {
    if (op === "in") return `in?: ${tsName}[]`;
    if (op === "isNull") return `isNull?: boolean`;
    if (op === "like") return `like?: string`;
    return `${op}?: ${tsName}`;
  });
  return `${tsName} | { ${opEntries.join("; ")} }`;
}

export function renderFilterType(entity: MetaObject): Code {
  // fields() returns effective fields, so inherited fields (from extends:/super:) are included in filter types.
  const allFields = entity.fields();
  const filterableFieldsList = allFields.filter((c) => c.ownAttr(FIELD_ATTR_FILTERABLE) === true);
  // Sort union uses isSortableField — same predicate as renderSortAllowlist to prevent
  // client/server mismatches (@filterable: true + @sortable: false must be excluded from both).
  const sortFieldNames = allFields.filter(isSortableField).map((f) => `"${f.name}"`);

  const fieldLines: string[] = [];
  for (const f of filterableFieldsList) {
    fieldLines.push(`  ${f.name}?: ${renderFieldUnion(f)};`);
  }

  if (fieldLines.length === 0 && sortFieldNames.length === 0) {
    return code`
export type ${entity.name}Filter = {
  limit?: number;
  offset?: number;
  sort?: string;
  or?: ${entity.name}Filter[];
  and?: ${entity.name}Filter[];
};
`;
  }

  const sortType =
    sortFieldNames.length === 0
      ? `string`
      : (() => {
          const sortUnion = sortFieldNames.join(" | ");
          return `\`\${${sortUnion}}:\${"asc" | "desc"}\` | ${sortUnion}`;
        })();

  return code`
export type ${entity.name}Filter = {
  limit?: number;
  offset?: number;
  sort?: ${sortType};
${fieldLines.join("\n")}
  or?: ${entity.name}Filter[];
  and?: ${entity.name}Filter[];
};
`;
}
