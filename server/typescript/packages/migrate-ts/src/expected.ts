// `@metaobjectsdev/migrate-ts/expected`: the expected schema without the database half.
//
// The package root also exports introspection, apply and replay, which import kysely (a peer
// dependency) when the module loads. A caller that only needs the schema the model implies (the
// prisma-schema generator in `@metaobjectsdev/codegen-ts`) imports this entry instead, so it does
// not need kysely installed. Its import graph is the model walk and nothing that opens a
// connection; keep it that way.

export { buildExpectedSchema, buildExpectedSchemaWithProvenance } from "./expected-schema.js";
export type { BuildExpectedSchemaOptions, ExpectedSchemaWithProvenance, SchemaProvenance } from "./expected-schema.js";
export { qualifiedDbName } from "./qualified-name.js";
export type { SqlType } from "./sql-type.js";
export type {
  CheckDescriptor,
  ColumnDefault,
  ColumnDescriptor,
  FkAction,
  FkDescriptor,
  IndexDescriptor,
  SchemaSnapshot,
  TableDescriptor,
  ViewDescriptor,
} from "./types.js";
