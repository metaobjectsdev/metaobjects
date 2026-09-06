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
import { PHYSICAL_NAME_ATTR_BY_KIND, primaryRdbSource } from "@metaobjectsdev/metadata";

/** The physical-name alias keys, in the metamodel's own order. */
const PHYSICAL_NAME_ALIASES = [...PHYSICAL_NAME_ATTR_BY_KIND.values()] as const;
import {
  resolveObjectNames, resolveSuperFragmentNames,
  type FieldNames, type KeyNames, type ObjectNames, type SourceNames,
} from "../names.js";

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
  // `fragment` says "this is an ANCESTOR render" — emit even though the walk reached this
  // object by climbing rather than by matching. It does NOT say which shape to render, and
  // it must not: a caller that hardcodes `true` is correct for an abstract base with
  // columns and no table, and wrong for the other ancestor this walk reaches — a TPH BASE
  // under `meta gen --entities <Subtype>`, which owns the shared table. Rendered as a
  // fragment it emits no source at all while the subtype still spreads it.
  //
  // Derived HERE rather than at the call site because the call sites are plural and one of
  // them is EJECTED: `src/reference/names.ts` is copied into an adopter's repo by
  // `meta init` and thereafter owned by them. Deciding it in the engine makes every copy
  // already on disk correct without an edit, and leaves no caller able to get it wrong.
  const n: ObjectNames | undefined = o.fragment === true && primaryRdbSource(obj) === undefined
    ? resolveSuperFragmentNames(obj, o.strategy)
    : resolveObjectNames(obj, o.strategy);
  if (n === undefined) return "";

  const superSym = n.superNames === undefined || o.superSpecifier === undefined
    ? undefined
    : `${n.superNames.name}Names`;

  const q = (v: string): string => JSON.stringify(v);
  // A key is emitted bare only when it is a valid identifier. Field names always are;
  // an index name is author-chosen and routinely is not (`uq_cust_email` is, `2fa-idx`
  // is not), so quoting is decided per key rather than per collection — an unquoted
  // non-identifier key is a file that does not parse.
  const key = (k: string): string => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : q(k));

  /**
   * One `name`-keyed collection — `fields`, `identities`, `indexes`.
   *
   * With a super to spread, only what THIS object declares is emitted and the rest is
   * reached through the parent's artifact, so a physical name is stated once. Without one,
   * every member must be here: a consumer looks a column up by field name and an inherited
   * miss falls back to a literal, which is the defect the artifact exists to remove.
   *
   * The collection key is always emitted, even when empty, because a child spreads
   * `...Super.identities` unconditionally.
   */
  const collection = (
    label: string,
    all: Readonly<Record<string, unknown>>,
    own: Readonly<Record<string, unknown>>,
    render: (v: never) => string,
  ): string => {
    const rows = superSym === undefined ? all : own;
    const body = Object.keys(rows).sort()
      .map((k) => `    ${key(k)}: ${render(rows[k] as never)},`)
      .join("\n");
    const spread = superSym === undefined ? "" : `    ...${superSym}.${label},\n`;
    if (spread === "" && body === "") return `  ${label}: {},`;
    return `  ${label}: {\n${spread}${body}${body === "" ? "" : "\n"}  },`;
  };

  const fieldsBlock = collection("fields", n.fields, n.ownFields,
    (f: FieldNames) => `{ name: ${q(f.name)}, column: ${q(f.column)} }`);

  // `type` and `subType` on every entry, because the artifact mirrors the metadata tree
  // and because on these two collections the subType is the only thing that says whether
  // an index is unique — ADR-0040 put that in the type rather than in an attribute.
  const renderKey = (k: KeyNames): string =>
    `{ type: ${q(k.type)}, subType: ${q(k.subType)}, name: ${q(k.name)}` +
    (k.index === undefined ? " }" : `, index: ${q(k.index)} }`);
  const identitiesBlock = collection("identities", n.identities, n.ownIdentities, renderKey);
  const indexesBlock = collection("indexes", n.indexes, n.ownIndexes, renderKey);

  const header =
    `// ${GENERATED_HEADER} — DO NOT EDIT.\n` +
    `// Source metadata: ${obj.name}\n` +
    (superSym === undefined ? "" : `import { ${superSym} } from ${q(o.superSpecifier as string)};\n\n`);

  // The object's own identity. `name` is the METAMODEL name — it held the physical name
  // until 0.25.0, and that key changing meaning without changing shape is the one thing
  // here a hand-written consumer adopts without a compile error.
  const identity =
    `  type: ${q(n.type)},\n` +
    `  subType: ${q(n.subType)},\n` +
    `  name: ${q(n.name)},\n`;

  /** One source, under its role. The physical name sits under the alias for its `@kind`. */
  const renderSource = (role: string, src: SourceNames): string => {
    const parts = [`type: ${q(src.type)}`, `subType: ${q(src.subType)}`, `kind: ${q(src.kind)}`];
    if (src.schema !== undefined) parts.push(`schema: ${q(src.schema)}`);
    for (const alias of PHYSICAL_NAME_ALIASES) {
      const v = src[alias as keyof SourceNames];
      if (typeof v === "string") parts.push(`${alias}: ${q(v)}`);
    }
    return `    ${key(role)}: { ${parts.join(", ")} },`;
  };

  // A fragment declares no source and must never acquire one; a TPH subtype INHERITS its
  // base's, so it spreads rather than restating — structural (the two resolve to the SAME
  // node), never an equality test on the resolved strings.
  const sourceRows = Object.keys(n.ownSources).sort()
    .map((role) => renderSource(role, n.ownSources[role] as SourceNames)).join("\n");
  const spreadSources = superSym !== undefined && n.inheritsSource ? `    ...${superSym}.sources,\n` : "";
  const sourcesBlock =
    spreadSources === "" && sourceRows === ""
      ? "  sources: {},"
      : `  sources: {\n${spreadSources}${sourceRows}${sourceRows === "" ? "" : "\n"}  },`;

  return `${header}export const ${obj.name}Names = {
${identity}${sourcesBlock}
${fieldsBlock}
${identitiesBlock}
${indexesBlock}
} as const;
`;
}
