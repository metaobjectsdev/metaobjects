/**
 * §A1/§A2 — `<Entity>Names`: the physical database names for one object, as constants a
 * hand-written consumer references instead of a string literal.
 *
 * Shape copied from the FR-009 filter allowlist, which is the same problem (a per-entity
 * name artifact) already solved in all five ports. Deliberately NOT folded into the entity
 * descriptor: four of five ports have no descriptor to extend, and merging in TypeScript
 * alone would make TS the odd port out on the axis this project protects hardest.
 *
 * An artifact whose object EXTENDS another one that has an artifact of its own spreads it
 * rather than restating what it inherits — "extend from the parent, do not redo all the
 * names". Two shapes, decided structurally:
 *
 *   - the object declares its OWN source: spread only the super's `fields`, because the
 *     physical name, kind, schema and read-only-ness are this object's own. Spreading the
 *     whole super here would leak its `schema` onto a child that declares none.
 *   - the object INHERITS its source (a TPH subtype sharing its base's single table):
 *     spread the WHOLE super, so the table name is stated once, on the base.
 */
import type { ColumnNamingStrategy, MetaObject } from "@metaobjectsdev/metadata";
import { GENERATED_HEADER } from "../constants.js";
import { resolveObjectNames, resolveSuperFragmentNames, type ObjectNames } from "../names.js";

export interface NamesDeclOpts {
  readonly strategy?: ColumnNamingStrategy | undefined;
  /**
   * Module specifier for the super's names module (e.g. `"./BaseEntity.names"`), when this
   * artifact extends one. Computed by the CALLER, which is the only place that knows the
   * project's output layout and extension style. Omitted ⇒ the flat shape: every inherited
   * column restated, which is what an ejected reference template that has not been updated
   * still produces. Correct, just not deduplicated.
   */
  readonly superSpecifier?: string | undefined;
  /**
   * Render the FRAGMENT form — an abstract base that a sourced object extends, carrying
   * columns and no physical name. See `resolveSuperFragmentNames`.
   */
  readonly fragment?: boolean | undefined;
}

/** Back-compat: the second argument was the naming strategy, and an ejected copy still passes it. */
function normalize(opts?: ColumnNamingStrategy | NamesDeclOpts): NamesDeclOpts {
  return typeof opts === "string" || opts === undefined ? { strategy: opts } : opts;
}

export function renderNamesDecl(
  obj: MetaObject,
  opts?: ColumnNamingStrategy | NamesDeclOpts,
): string {
  const o = normalize(opts);
  const n: ObjectNames | undefined = o.fragment === true
    ? resolveSuperFragmentNames(obj, o.strategy)
    : resolveObjectNames(obj, o.strategy);
  if (n === undefined) return "";

  const superSym = n.superNames === undefined || o.superSpecifier === undefined
    ? undefined
    : `${n.superNames.name}Names`;

  // Without a super to spread, the artifact must declare EVERY field it describes — a
  // consumer looks a column up by field name and an inherited one has to be there.
  const rows = superSym === undefined ? n.fields : n.ownFields;
  // Sorted, so output depends on the model rather than on child order.
  const fieldRows = Object.keys(rows).sort().map((k) => {
    const f = rows[k];
    if (f === undefined) return "";
    return `    ${k}: { name: ${JSON.stringify(f.name)}, column: ${JSON.stringify(f.column)} },`;
  }).filter((r) => r !== "").join("\n");

  const header =
    `// ${GENERATED_HEADER} — DO NOT EDIT.\n` +
    `// Source metadata: ${obj.name}\n` +
    (superSym === undefined ? "" : `import { ${superSym} } from ${JSON.stringify(o.superSpecifier)};\n\n`);

  const fieldsBlock =
    `  fields: {\n${superSym === undefined ? "" : `    ...${superSym}.fields,\n`}${fieldRows}\n  },`;

  // A fragment has no source, so no kind/name/schema/readOnly — and must never acquire one.
  if (o.fragment === true) {
    return `${header}export const ${obj.name}Names = {
${superSym === undefined ? "" : `  ...${superSym},\n`}${fieldsBlock}
} as const;
`;
  }

  // Structural, not an equality test on the resolved strings: does this object declare a
  // source, or is it using its parent's? See ObjectNames.inheritsSource.
  if (superSym !== undefined && n.inheritsSource) {
    return `${header}export const ${obj.name}Names = {
  ...${superSym},
${fieldsBlock}
} as const;
`;
  }

  const schemaLine = n.schema === undefined ? "" : `\n  schema: ${JSON.stringify(n.schema)},`;
  return `${header}export const ${obj.name}Names = {
  kind: ${JSON.stringify(n.kind)},
  name: ${JSON.stringify(n.name)},${schemaLine}
  readOnly: ${n.readOnly},
${fieldsBlock}
} as const;
`;
}
