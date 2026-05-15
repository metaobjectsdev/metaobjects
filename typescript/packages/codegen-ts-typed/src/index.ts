// @metaobjects/codegen-ts-typed — typed-view codegen POC.

export type { Generator, GenContext, EmittedFile } from "./generator.js";
export type { RenderContext, ExtStyle } from "./render-context.js";
export { withExt } from "./render-context.js";
export { mapColumnType } from "./column-mapper.js";
export type { ColumnSpec, DefaultExpr } from "./column-mapper.js";
export { buildPkMap } from "./pk-resolver.js";
export type { PkInfo } from "./pk-resolver.js";
export { buildRelationMap } from "./relation-resolver.js";
export type { RelationEntry, RelationMap } from "./relation-resolver.js";
export { renderDrizzleSchema } from "./templates/drizzle-schema.js";
export { renderRelationsBlock } from "./templates/relations-block.js";
export {
  renderFindByIdFn, renderListFn, renderCreateFn, renderUpdateFn, renderDeleteByIdFn,
} from "./templates/queries.js";
export { renderEntityFile } from "./templates/entity-file.js";
