/**
 * §A2/§A3 — the ONE place a data name is resolved for a generator run.
 *
 * Both the names artifact (namesFile) and the entity generator that consumes it call this,
 * so the constant and the binding it describes cannot be produced by different resolvers or
 * different arguments. That is the whole rule; a name computed twice is a name that can
 * disagree with itself.
 */
import {
  isMetaSource,
  resolveColumnName,
  resolveTableName,
  resolveTableSchema,
  type ColumnNamingStrategy,
  type MetaObject,
  type MetaSource,
  SOURCE_ROLE_PRIMARY,
} from "@metaobjectsdev/metadata";

export interface FieldNames { readonly name: string; readonly column: string; }

export interface ObjectNames {
  /** The `source.rdb @kind` value — `table` | `view` | `materializedView` | … */
  readonly kind: string;
  /** The PHYSICAL name. Not necessarily a table: resolveTableName delegates to
   *  source.physicalName for every @kind, so this can be a view or a proc. */
  readonly name: string;
  readonly schema?: string;
  readonly readOnly: boolean;
  readonly fields: Readonly<Record<string, FieldNames>>;
}

export function resolveObjectNames(
  obj: MetaObject,
  strategy?: ColumnNamingStrategy,
): ObjectNames | undefined {
  // #248: an object participates in the database iff it declares (or inherits) a primary
  // source. Never gate on the object subtype. ADR-0039: resolving children().
  //
  // isMetaSource, not `instanceof` — two physical copies of @metaobjectsdev/metadata in
  // one process give the class and the instance different identities, and the failure is
  // SILENT: the entity reads as "not backed by any store" and emits nothing.
  const source = obj.children().find(
    (c): c is MetaSource => isMetaSource(c) && c.role === SOURCE_ROLE_PRIMARY,
  );
  if (source === undefined) return undefined;

  const fields: Record<string, FieldNames> = {};
  // ADR-0039: fields() is the RESOLVING accessor — inherited fields must appear, and an
  // inherited @column must resolve, or the constant disagrees with the DDL.
  for (const f of obj.fields()) {
    fields[f.name] = { name: f.name, column: resolveColumnName(f, strategy) };
  }

  const schema = resolveTableSchema(obj);
  return {
    // `effectiveKind`, NOT a `kind` property — MetaSource exposes the @kind value through
    // that accessor, defaulting to "table" per ADR-0007 Rule 3, and resolving it through
    // `extends` so an inherited source's @kind is seen.
    kind: source.effectiveKind,
    name: resolveTableName(obj),
    ...(schema === undefined ? {} : { schema }),
    // Derived from the source's OWN logic, never a hand-rolled kind list here — a second
    // list would drift from the loader's the first time a read-only kind is added.
    readOnly: source.isReadOnly(),
    fields,
  };
}
