// Public API surface for @metaobjectsdev/codegen-ts.
//
// Architecture: Vite-style plugin model.
// See docs/superpowers/specs/2026-05-12-pluggable-generators-design.md.

export { runGen } from "./runner.js";
export type { RunGenOpts, RunGenResult } from "./runner.js";

export type { Generator, GenContext, EmittedFile, GeneratorFactory } from "./generator.js";
export { perEntity, oncePerRun } from "./generator.js";

export type { MetaobjectsGenConfig, NormalizedMetaobjectsGenConfig, ResolvedGenConfig, Dialect, ExtStyle, ColumnNamingStrategy, MetaDataTypeProvider } from "./metaobjects-config.js";
export { defineConfig, normalizeConfig } from "./metaobjects-config.js";

export type { ColumnSpec, DefaultExpr } from "./column-mapper.js";
export { mapColumnType } from "./column-mapper.js";

export type { PkInfo } from "./pk-resolver.js";
export { buildPkMap } from "./pk-resolver.js";

export type { RelationEntry, RelationMap } from "./relation-resolver.js";
export { buildRelationMap } from "./relation-resolver.js";

export type { RenderContext } from "./render-context.js";
export { makeRenderContext } from "./render-context.js";

export type {
  WriteStatus,
  WriteResult,
  MergeStrategy,
  BaselineMode,
  DecideAndWriteOpts,
} from "./overwrite-policy.js";
export { decideAndWrite, GitMissingError } from "./overwrite-policy.js";

export { CodegenError } from "./errors.js";
export { GENERATED_HEADER, EXTRA_SUFFIX, DEFAULT_OUT_DIR } from "./constants.js";

export { formatTs } from "./format.js";

export { pluralize, columnNameFromField, tableNameFromEntity, viewNameFromProjection } from "./naming.js";

export { packageToPath, entityOutputPath, crossEntitySpecifier, barrelEntrySpecifier, relativeModuleSpecifier, entityModuleSpecifier, siblingSpecifier, barrelModuleSpecifier } from "./import-path.js";
export type { OutputLayout, ResolvedTarget } from "./import-path.js";

export { isProjection, isWriteThrough } from "./projection/projection-detector.js";
export { isAbstract, emitsInstanceArtifacts, emitsWriteArtifacts } from "./instance-artifacts.js";
export { extractViewSpec } from "./projection/extract-view-spec.js";
export type { ExtractContext } from "./projection/extract-view-spec.js";
export { emitViewDdl } from "./projection/view-ddl-emit.js";
export type { EmitOptions as ViewDdlEmitOptions } from "./projection/view-ddl-emit.js";
export type { JoinNode, JoinTree, SelectColumn, SelectSpec, ViewSpec } from "./projection/view-spec.js";
// Prompt construction (FR-004): typed payload + render-handle codegen.
export { generatePayloadInterfaces, generatePayloadInterfacesBatch, generateRenderHandle } from "./payload-codegen.js";

// Template-driven codegen (rc.12). Factory + framework Provider for adopters
// who want to wire their own templateGenerator instances. The default
// docsFile() uses this internally.
export {
  templateGenerator,
  type TemplateGeneratorOpts,
  type TemplateWalkResult,
  type TemplateFormat,
} from "./generators/template-generator.js";
export {
  FileSystemProvider,
  ProviderChain,
  frameworkTemplatesProvider,
  projectProvider,
} from "./render-engine/framework-provider.js";
export type {
  EntityDocData,
  StorageFieldDoc,
  IdentityDoc,
  RelationshipDoc,
  UsedByDoc,
  ConstraintRow,
} from "./generators/docs-data.js";
export { buildEntityDocData } from "./generators/docs-data-builder.js";
export type { TemplateDocData, TemplateOutputPart } from "./generators/template-doc-data.js";
export { buildTemplateDocData } from "./generators/template-doc-builder.js";
