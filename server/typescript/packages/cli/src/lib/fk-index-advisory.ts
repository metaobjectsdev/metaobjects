// Foreign keys with no index covering their columns — an advisory authoring lint.
//
// `meta migrate` emits a FOREIGN KEY constraint for every enforced `identity.reference`
// and no index on its columns: neither Postgres nor SQLite indexes the referencing side
// of a foreign key. Every join from the parent, and every ON DELETE cascade / set-null /
// restrict check from it, then scans the child table. Generating the index automatically
// would propose a migration to every existing adopter the release it shipped, so this is
// advice, never a gate: it names each such key and says how to declare the index.
//
// Coverage is read off the EXPECTED SCHEMA migrate itself builds (primary key, every
// `identity.secondary`, every `index.lookup`, every `@unique` field), not re-derived from
// the metadata — so "covered" means covered in the DDL migrate would emit. An index covers
// a key when its leading columns are exactly the key's columns, in any order. Expression
// indexes are not counted; partial ones are (bias to under-flagging).

import {
  INDEX_SUBTYPE_LOOKUP,
  TYPE_INDEX,
  TYPE_SUBTYPE_SEPARATOR,
} from "@metaobjectsdev/metadata/constants";
import {
  isMetaObject,
  resolveColumnName,
  type ColumnNamingStrategy,
  type MetaData,
} from "@metaobjectsdev/metadata";
import {
  buildExpectedSchemaWithProvenance,
  qualifiedDbName,
  type Dialect,
  type TableDescriptor,
} from "@metaobjectsdev/migrate-ts";

export interface UnindexedFkFinding {
  /** The metadata file declaring the entity ("" when the loader recorded none). */
  file: string;
  /** `<entity FQN>.<reference name>`. */
  construct: string;
  message: string;
}

export interface UnindexedFkOptions {
  dialect: Dialect;
  columnNamingStrategy: ColumnNamingStrategy;
  /** Skip an entity by FQN — imported (dependency) metadata is not the adopter's to index. */
  skip?: (fqn: string) => boolean;
}

const INDEX_LOOKUP = `${TYPE_INDEX}${TYPE_SUBTYPE_SEPARATOR}${INDEX_SUBTYPE_LOOKUP}`;

function covered(table: TableDescriptor, fkColumns: readonly string[]): boolean {
  const want = new Set(fkColumns);
  const prefixes = [
    table.primaryKey,
    ...table.indexes.filter((i) => i.expr === undefined).map((i) => i.columns),
  ];
  return prefixes.some((cols) =>
    cols.length >= want.size && cols.slice(0, want.size).every((c) => want.has(c)));
}

function pascal(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

export function scanForUnindexedForeignKeys(root: MetaData, opts: UnindexedFkOptions): UnindexedFkFinding[] {
  const { snapshot, provenance } = buildExpectedSchemaWithProvenance(root, {
    dialect: opts.dialect,
    columnNamingStrategy: opts.columnNamingStrategy,
  });
  // ADR-0039: effective children — resolve rather than rely on root being unextended.
  const objectsByFqn = new Map(
    root.children().filter(isMetaObject).map((o) => [o.resolutionKey(), o] as const),
  );

  const out: UnindexedFkFinding[] = [];
  for (const table of snapshot.tables) {
    const fqn = provenance.get(qualifiedDbName(table));
    if (fqn === undefined || opts.skip?.(fqn) === true) continue;
    const entity = objectsByFqn.get(fqn);
    if (entity === undefined) continue;
    const files = "files" in entity.source ? entity.source.files : [];
    // A node a shipped library contributed is the library's design, not the adopter's.
    if (files.some((f) => f.startsWith("library:"))) continue;

    for (const fk of table.foreignKeys) {
      if (covered(table, fk.columns)) continue;
      // Name the key in the author's terms: the reference and its FIELDS, not columns.
      // A TPH subtype's reference folds into its base's table and is not on `entity`;
      // it is then reported by column, which is still enough to act on.
      const ref = entity.referenceIdentities().find((r) => {
        const cols = r.fields.map((f) => {
          const field = entity.fields().find((x) => x.name === f);
          return field !== undefined ? resolveColumnName(field, opts.columnNamingStrategy) : f;
        });
        return cols.length === fk.columns.length && cols.every((c, i) => c === fk.columns[i]);
      });
      const fields = ref !== undefined ? ref.fields : fk.columns;
      const label = ref !== undefined ? `${entity.name}.${ref.name}` : `${entity.name} (${fk.name})`;
      const indexName = `by${fields.map(pascal).join("")}`;
      const fieldList = fields.length === 1 ? fields[0]! : `[${fields.join(", ")}]`;
      out.push({
        file: files[0] ?? "",
        construct: `${fqn}.${ref?.name ?? fk.name}`,
        message:
          `${label}: foreign key (${fields.join(", ")}) → ${fk.refTable} has no index covering it, ` +
          `so joins from ${fk.refTable} and its ON DELETE checks scan ${table.name}. ` +
          `Declare one on ${entity.name}: ${INDEX_LOOKUP}: { name: ${indexName}, fields: ${fieldList} }`,
      });
    }
  }
  return out;
}
