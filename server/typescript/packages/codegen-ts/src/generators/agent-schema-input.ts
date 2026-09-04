// The `agent/schema.md` surface's INPUT contract — the physical schema, supplied by
// whoever owns it.
//
// codegen-ts does not compute any of this and must not. The expected schema, the
// dialect SQL type of a column, and the qualified name a table is keyed by are all
// `@metaobjectsdev/migrate-ts`'s answers: it builds the snapshot the diff compares, it
// renders the DDL, and its `qualifiedDbName` is the one key three separate suppression
// sets already agree on. Re-deriving any of them here would give an adopter a page
// describing a schema the tool does not produce — and the disagreement would be
// invisible, because a documentation page looks authoritative and nothing compares it
// to the migration.
//
// So the surface takes the schema as an ARGUMENT, with the resolvers injected. The
// types below are structural on purpose: `migrate-ts`'s own `SchemaSnapshot`,
// `TableDescriptor` and `ColumnDescriptor` satisfy them without codegen-ts taking a
// dependency on that package (it has none today, and the docs surface is not a reason
// to add one — `meta docs` in the CLI depends on both and is where they meet).
//
// ABSENT INPUT IS A SUPPORTED STATE, not a failure. `meta docs` runs without a gen
// config, and a project with no dialect has no physical schema to describe; the surface
// then emits nothing rather than a page full of unknowns.

/** A canonical SQL type as `migrate-ts` models it. Opaque here — only `columnType` reads it. */
export interface SchemaColumnLike {
  readonly name: string;
  readonly nullable: boolean;
  readonly default?: { readonly kind: "literal" | "expr"; readonly value: string } | undefined;
  readonly identity?: "increment" | "uuid" | undefined;
  /** Threaded from the field's `@description` — the business semantics beside the column. */
  readonly description?: string | undefined;
}

export interface SchemaIndexLike {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly where?: string | undefined;
  readonly expr?: string | undefined;
  readonly using?: string | undefined;
}

export interface SchemaFkLike {
  readonly name: string;
  readonly columns: readonly string[];
  readonly refTable: string;
  readonly refColumns: readonly string[];
  readonly onDelete?: string | undefined;
  readonly onUpdate?: string | undefined;
}

export interface SchemaCheckLike {
  readonly name: string;
  readonly expression: string;
}

export interface SchemaTableLike {
  readonly name: string;
  readonly schema?: string | undefined;
  readonly columns: readonly SchemaColumnLike[];
  readonly indexes: readonly SchemaIndexLike[];
  readonly foreignKeys: readonly SchemaFkLike[];
  readonly checks: readonly SchemaCheckLike[];
  readonly primaryKey: readonly string[];
  /** Threaded from the entity's `@description`. */
  readonly description?: string | undefined;
}

export interface SchemaViewLike {
  readonly name: string;
  readonly schema?: string | undefined;
  readonly columns?: readonly { readonly name: string }[] | undefined;
}

/**
 * Everything `agent/schema.md` renders from, plus the two resolvers it refuses to own.
 */
export interface AgentSchemaInput {
  /** `postgres` | `sqlite` | `d1` — named on the page so a reader knows which SQL they are reading. */
  readonly dialect: string;
  readonly tables: readonly SchemaTableLike[];
  readonly views: readonly SchemaViewLike[];
  /** Qualified physical name → the declaring object's `resolutionKey()`. */
  readonly provenance: ReadonlyMap<string, string>;
  /** `migrate-ts`'s `columnTypeSql`, bound to `dialect`. */
  readonly columnType: (column: SchemaColumnLike) => string;
  /** `migrate-ts`'s `qualifiedDbName` — the ONE key the provenance map is built with. */
  readonly qualify: (obj: { name: string; schema?: string | undefined }) => string;
}
