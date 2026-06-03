// Public API surface for @metaobjectsdev/codegen-ts.
//
// Architecture: Vite-style plugin model.
// See docs/superpowers/specs/2026-05-12-pluggable-generators-design.md.

export { runGen } from "./runner.js";
export type { RunGenOpts, RunGenResult } from "./runner.js";

export type { Generator, GenContext, EmittedFile, GeneratorFactory } from "./generator.js";
export { perEntity, oncePerRun } from "./generator.js";

// ADR-0021 D3 — stable-name generator registry + discoverability surface.
export {
  generatorRegistry,
  listGenerators,
  getGenerator,
} from "./generator-registry.js";
export type { GeneratorRegistryEntry, GeneratorTier } from "./generator-registry.js";

export type { MetaobjectsGenConfig, NormalizedMetaobjectsGenConfig, ResolvedGenConfig, Dialect, ExtStyle, ColumnNamingStrategy, MetaDataTypeProvider, GeneratorSpec } from "./metaobjects-config.js";
export { defineConfig, normalizeConfig, resolveGenerators } from "./metaobjects-config.js";

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
export { GENERATED_HEADER, EXTRA_SUFFIX, DEFAULT_OUT_DIR, CODEGEN_ATTR_EMIT_TANSTACK, CODEGEN_ATTR_EMIT_GRID, CODEGEN_ATTR_EMIT_FORM, CODEGEN_ATTR_EMIT_ROUTES } from "./constants.js";

export { formatTs } from "./format.js";

export { pluralize, columnNameFromField, tableNameFromEntity, viewNameFromProjection } from "./naming.js";

export { packageToPath, entityOutputPath, crossEntitySpecifier, barrelEntrySpecifier, relativeModuleSpecifier, entityModuleSpecifier, siblingSpecifier, barrelModuleSpecifier } from "./import-path.js";
export type { OutputLayout, ResolvedTarget } from "./import-path.js";
export {
  docPageOutputPath,
  docPageHref,
  docPageNode,
  effectivePackage,
  assertNoDuplicateDocPaths,
} from "./docs-paths.js";
export type { DocPageNode, DocPagePlacement } from "./docs-paths.js";

export { isProjection, isWriteThrough } from "./projection/projection-detector.js";
export { isAbstract, emitsInstanceArtifacts, emitsWriteArtifacts } from "./instance-artifacts.js";
// FR-017 TPH helpers — used by the per-framework codegen packages (tanstack,
// react) to dispatch polymorphic/per-subtype emission and skip subtype files.
export { isTphDiscriminatorBase, tphConcreteSubtypes, collectTphSubtypeFields, tphPlan, tphRouteSegment } from "./templates/tph-discriminator.js";
export type { TphPlan, TphSubtypePlan } from "./templates/tph-discriminator.js";
export { isTphSubtype, tphDiscriminatorPin } from "./templates/zod-validators.js";
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
