// Public API surface for @metaobjectsdev/codegen-ts.
//
// Architecture: Vite-style plugin model.
// See docs/superpowers/specs/2026-05-12-pluggable-generators-design.md.

export { runGen } from "./runner.js";
export type { RunGenOpts, RunGenResult } from "./runner.js";

export type { Generator, GenContext, EmittedFile, GeneratorFactory } from "./generator.js";
export { perEntity, perPackage, perModel, oncePerRun } from "./generator.js";

// SP-1 declarative Mustache template-codegen — scope walks, neutral data dict,
// output-pattern, and the JSON template-spec the CLI ports reuse.
export { expandOutputPattern } from "./template-codegen/output-pattern.js";
export {
  buildEntityTemplateData,
  buildPackageTemplateData,
  buildModelTemplateData,
} from "./template-codegen/template-data.js";
export type {
  FieldTemplateData,
  EntityTemplateData,
  IdentityTemplateData,
  RelationshipTemplateData,
  PackageTemplateData,
  ModelTemplateData,
} from "./template-codegen/template-data.js";
export { parseTemplateSpec, templateSpecToGenerators } from "./template-codegen/template-spec.js";
export type { TemplateSpecEntry, TemplateSpecFile } from "./template-codegen/template-spec.js";
export type { TemplateScope } from "./generators/template-generator.js";

// ADR-0021 D3 — stable-name generator registry + discoverability surface.
export {
  generatorRegistry,
  listGenerators,
  getGenerator,
} from "./generator-registry.js";
export type { GeneratorRegistryEntry, GeneratorTier } from "./generator-registry.js";

export type { MetaobjectsGenConfig, NormalizedMetaobjectsGenConfig, ResolvedGenConfig, Dialect, ExtStyle, ColumnNamingStrategy, MetaDataTypeProvider, GeneratorSpec, DocsConfig, ResolvedDocsConfig, DocsSurface, ApiSurface, VerifyConfig } from "./metaobjects-config.js";
export { defineConfig, normalizeConfig, resolveGenerators, resolveDocsConfig } from "./metaobjects-config.js";
export { apiLabel } from "./generators/api-label.js";

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
// The UI tier asks THESE — "is there an endpoint?" — never the storage predicates.
export { servesReadApi, servesWriteApi } from "./api-surface.js";
// The DB-free descriptor module the UI tier imports from (see entity-meta-file.ts).
export { renderEntityMetaFile, entityMetaFileName, entityMetaSpecifier } from "./templates/entity-meta-file.js";
// FR-017 TPH helpers — used by the per-framework codegen packages (tanstack,
// react) to dispatch polymorphic/per-subtype emission and skip subtype files.
export { isTphDiscriminatorBase, tphConcreteSubtypes, collectTphSubtypeFields, tphPlan, tphRouteSegment } from "./templates/tph-discriminator.js";
export type { TphPlan, TphSubtypePlan } from "./templates/tph-discriminator.js";
export { isTphSubtype, tphDiscriminatorPin } from "./templates/zod-validators.js";

// ADR-0034 reference-template composition helpers. Promoted to the public engine
// surface so a COPIED reference generator (src/reference/*.ts → consumer's
// codegen/generators/*.ts) imports only `@metaobjectsdev/codegen-ts`, never a
// package-internal relative path. These are the assembly pieces the built-in
// entity/queries composers use; the reference templates relocate that assembly.
export { renderTphDiscriminatorUnion } from "./templates/tph-discriminator.js";
export { hasWritableRdbSource, hasAnyRdbSource } from "./source-detect.js";
export { renderSharedEnumsFile, SHARED_ENUMS_BASENAME } from "./templates/enums-file.js";

// ADR-0034 scaffold-and-own — reader for the copyable reference generators in
// `src/reference/*.ts`. `meta init` uses this to copy them into the consumer's repo.
export { resolveReferenceRoot, readReferenceTemplate, REFERENCE_GENERATOR_NAMES } from "./reference-templates.js";
export type { ReferenceGeneratorName } from "./reference-templates.js";

// ts-poet composition primitives, re-exported from THIS package's own ts-poet
// instance. The ADR-0034 owned/scaffolded generators MUST import these from here
// rather than from a bare "ts-poet": ts-poet recognizes nested Code/Import
// placeholders by `instanceof`, so a Code built by this package's render*
// primitives is only recognized by a `code`/`joinCode` from the SAME physical
// ts-poet copy. With a globally-installed or linked CLI, the project tree and the
// CLI tree each hold their own ts-poet, and a bare project-side import split the
// class identity — every cross-boundary section was then stringified standalone
// with its own import header (duplicate `import { eq } from "drizzle-orm"`,
// TS2300 on the adopter's first tsc). Gated by
// cli/test/gen-split-tree-single-import.test.ts.
export { code, imp, joinCode } from "ts-poet";
export type { Code } from "ts-poet";

export {
  renderFindByIdFn,
  renderListFn,
  renderCreateFn,
  renderUpdateFn,
  renderDeleteByIdFn,
  renderReverseFinderFns,
  reverseFksFor,
  getPkInfo,
} from "./templates/queries.js";

// Built-in template render functions — the composition seam for adopters who
// want to call a built-in template, then post-process / append to its output
// from their own Generator (added to `generators: [...]`) WITHOUT forking the
// template. Mirrors the `renderZodValidators` export. Each is also reachable via
// a dedicated subpath (e.g. `@metaobjectsdev/codegen-ts/templates/entity-file`).
export { renderEntityFile } from "./templates/entity-file.js";
export type { RenderEntityFileOpts } from "./templates/entity-file.js";
export { renderZodValidators } from "./templates/zod-validators.js";
export { renderDrizzleSchema } from "./templates/drizzle-schema.js";
export {
  renderInferredTypes,
  renderEnumTypeAliases,
  renderValueObjectInterface,
  enumUnionAliasName,
  enumUnionString,
} from "./templates/inferred-types.js";
export { renderBarrel } from "./templates/barrel.js";
export type { BarrelEntry } from "./templates/barrel.js";
export { renderFilterType } from "./templates/filter-type.js";
export { renderFilterAllowlist, renderSortAllowlist } from "./templates/filter-allowlist.js";
export { renderEntityConstants, resourcePath } from "./templates/entity-constants.js";
export { renderQueriesFile } from "./templates/queries-file.js";
export { renderRoutesFile } from "./templates/routes-file.js";
export { renderValueObjectFile } from "./templates/value-object-file.js";
export { renderProjectionDecl } from "./templates/projection-decl.js";
export type { ProjectionDeclOpts } from "./templates/projection-decl.js";
export { extractViewSpec } from "./projection/extract-view-spec.js";
export type { ExtractContext } from "./projection/extract-view-spec.js";
export { emitViewDdl } from "./projection/view-ddl-emit.js";
export type { EmitOptions as ViewDdlEmitOptions } from "./projection/view-ddl-emit.js";
export { buildProjectionViews } from "./projection/build-projection-views.js";
export type { ExpectedView, BuildProjectionViewsOptions } from "./projection/build-projection-views.js";
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

// FR-038 — requirement-derived test stubs.
//
// Both the factory AND its primitives are exported deliberately. Scaffold-and-own
// means the application owns its generator file, but that is only a real escape
// hatch if it can compose one from parts — otherwise an app needing one different
// behaviour must reimplement the requirement walk, and reimplementing it badly is
// worse than the bug report this is meant to avoid.
export { requirementTests } from "./generators/requirement-tests.js";
export type {
  RequirementTestsOpts,
  RequirementTestRenderer,
} from "./generators/requirement-tests.js";
export {
  walkRequirements,
  groupByConcern,
  concernOf,
  NO_CONCERN,
} from "./requirement-walk.js";
export type {
  RequirementView,
  ResolvedClaim,
  WalkedRequirement,
} from "./requirement-walk.js";
export { renderRequirementTest } from "./templates/requirement-test.js";
export type { RequirementTestArgs } from "./templates/requirement-test.js";
