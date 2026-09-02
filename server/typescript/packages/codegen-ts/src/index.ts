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
// The committed half of `.gen-state`. Exported for `verify --codegen`, which needs
// the same "is this still exactly what the generator wrote?" evidence the write path
// uses — without it the gate cannot tell a preserved hand edit from stale output.
// `listGeneratedPaths` answers the sibling question — WHICH paths we have ever
// written — which is how the gate scopes itself to its own output instead of
// convicting every stranger's file that happens to sit in the same directory.
export { contentHash, readGeneratedHash, listGeneratedPaths } from "./overwrite-policy.js";

export { CodegenError } from "./errors.js";
export { GENERATED_HEADER, DEFAULT_OUT_DIR, RETIRED_CODEGEN_ATTRS, type RetiredCodegenAttr } from "./constants.js";
export { warnRetiredCodegenAttrs } from "./retired-codegen-attrs.js";

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
// #356 — every emitter selects a field's view by the SURFACE it renders, never by
// declaration position. An owned generator (FR-040) composing the render layer must
// use this too, or it reinstates the order-dependence in its own copy.
export { viewForContext, VIEW_CONTEXT_FORM, VIEW_CONTEXT_GRID } from "./view-context.js";
// The DB-free descriptor module the UI tier imports from (see entity-meta-file.ts).
export { renderEntityMetaFile, entityMetaFileName, entityMetaSpecifier } from "./templates/entity-meta-file.js";
// FR-017 TPH helpers — used by the per-framework codegen packages (tanstack,
// react) to dispatch polymorphic/per-subtype emission and skip subtype files.
export { isTphDiscriminatorBase, tphConcreteSubtypes, collectTphSubtypeFields, tphPlan, tphRouteSegment } from "./templates/tph-discriminator.js";
export type { TphPlan, TphSubtypePlan } from "./templates/tph-discriminator.js";
export { isTphSubtype, tphDiscriminatorPin } from "./templates/zod-validators.js";

// The ONE sortability rule. It builds the server-side `<Entity>SortAllowlist` and the
// client-side sort union, and it is public so a UI-tier generator (a data-grid column
// emitter, say) marks a column sortable by ASKING the server's rule rather than
// reimplementing its three branches out of tree. A hand-copied predicate is how the
// grid came to offer headers the allowlist rejects (#352/#354).
export { isSortableField, sortableFields } from "./templates/filter-shared.js";

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
export { resolveReferenceRoot, readReferenceTemplate, REFERENCE_GENERATOR_NAMES, makeReferenceReader } from "./reference-templates.js";
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
// #348 — which CRUD verbs a generated routes file mounts. Public because an OWNED
// routes generator (ADR-0034) composes the same render call and needs the same option.
export { CRUD_VERBS, resolveExpose, intersectExpose, exposeLine } from "./routes-expose.js";
export type { CrudVerb, ExposeOption } from "./routes-expose.js";
export { renderRoutesFile } from "./templates/routes-file.js";
export { renderRoutesFileHono } from "./templates/routes-file-hono.js";
export { renderValueObjectFile } from "./templates/value-object-file.js";
export { renderNamesDecl } from "./templates/names-decl.js";
export {
  resolveObjectNames,
  namesRef,
  namesConstArg,
  physicalNameExpr,
  columnExpr,
  type ObjectNames,
  type FieldNames,
} from "./names.js";
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
export { requirementsFile } from "./generators/requirements-file.js";
export type { RequirementRow } from "./generators/requirements-view.js";
// The projection itself, not just its type: it is the authority on WHICH doc slots a
// requirement surface actually renders, and `meta verify`'s authoring lint tells an
// author that `summary` is invisible while `title` is the entry's label. Both halves of
// that claim need to be checkable against the projection rather than asserted in prose.
export { requirementRows } from "./generators/requirements-view.js";
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

// FR-038 §8 — deletion integrity. Pure decision logic: which no-longer-generated
// files may be removed, and which were hand-edited and must be refused instead.
// `OrphanPolicy` is the Generator field an app sets to opt in; `sweepOrphans` is
// the filesystem binding, exported so an app composing its own generator can
// reconcile the same way the runner does instead of hand-rolling the walk.
export { reconcileOrphans, refusedOrphanMessage } from "./reconcile-orphans.js";
export type {
  OrphanDecision,
  ReconcileOrphansArgs,
  OrphanPolicy,
} from "./reconcile-orphans.js";
export { sweepOrphans } from "./orphan-sweep.js";
export type {
  OrphanJob,
  SweepOrphansArgs,
  SweepOrphansResult,
} from "./orphan-sweep.js";

// FR-040 §6.4 — the client-component directive for generated CLIENT artifacts.
// Public so an OWNED generator applies it the same way the built-ins do.
export { withClientDirective, CLIENT_DIRECTIVE } from "./client-directive.js";
