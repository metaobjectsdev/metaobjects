// ADR-0034 scaffold-and-own — these built-in generator factories remain the engine's
// internal composers, but importing them from `@metaobjectsdev/codegen-ts/generators`
// into a consumer's `metaobjects.config.ts` is DEPRECATED. The recommended path is to
// own copyable reference templates in your repo (`meta init` scaffolds them into
// `codegen/generators/*.ts`) and import those locally. This package export will be
// removed in a future major. See spec/decisions/ADR-0034-codegen-scaffold-and-own.md.

/** @deprecated ADR-0034 — own a copy instead: `import { entityFile } from "./codegen/generators/entity"` (scaffolded by `meta init`). */
export { entityFile, type EntityFileOpts } from "./entity-file.js";
/** @deprecated ADR-0034 — own a copy instead: `import { queriesFile } from "./codegen/generators/queries"` (scaffolded by `meta init`). */
export { queriesFile, type QueriesFileOpts } from "./queries-file.js";
export { callableFile, type CallableFileOpts } from "./callable-file.js";
/** @deprecated ADR-0034 — own a copy instead: `import { routesFile } from "./codegen/generators/routes"` (scaffolded by `meta init`). */
export { routesFile, type RoutesFileOpts } from "./routes-file.js";
export { routesFileHono, type RoutesFileHonoOpts } from "./routes-file-hono.js";
/** @deprecated ADR-0034 — own a copy instead: `import { barrel } from "./codegen/generators/barrel"` (scaffolded by `meta init`). */
export { barrel, type BarrelOpts } from "./barrel.js";
/** @deprecated ADR-0021 D1 — neutral artifact owned by `meta docs` (ADR-0020); not part of the recommended `meta gen` suite. */
export { mermaidErDiagram, type MermaidErOptions } from "./mermaid-er.js";
export { promptRender, type PromptRenderOpts } from "./prompt-render-file.js";
export { outputParser, type OutputParserOpts } from "./output-parser-file.js";
export { extractor, type ExtractorOpts } from "./extractor-file.js";
export { outputPrompt, type OutputPromptOpts } from "./output-prompt-file.js";
export { renderHelper, type RenderHelperOpts } from "./render-helper-file.js";
/** @deprecated ADR-0025 — `meta docs` is the single docs door; `apiDocsFile` stays as the internal engine of its api surface, not a `meta gen` config generator. */
export { apiDocsFile, type ApiDocsFileOpts } from "./api-docs-file.js";
/** @deprecated ADR-0021 D1 — `meta docs` is the single docs door; `docsFile` stays as its internal engine, not a `meta gen` config generator. */
export { docsFile, type DocsFileOpts } from "./docs-file.js";
export {
  templateGenerator,
  type TemplateGeneratorOpts,
  type TemplateWalkResult,
  type TemplateFormat,
} from "./template-generator.js";
export { traceHelperFile, type TraceHelperOpts } from "./trace-helper-file.js";
export type {
  EntityDocData,
  StorageFieldDoc,
  IdentityDoc,
  RelationshipDoc,
  UsedByDoc,
  ConstraintRow,
} from "./docs-data.js";
export { buildEntityDocData } from "./docs-data-builder.js";
export type { TemplateDocData, TemplateOutputPart } from "./template-doc-data.js";
export { buildTemplateDocData } from "./template-doc-builder.js";

// FR-038 — requirement-derived test stubs. The factory is a convenience; the
// primitives beside it are the real escape hatch, so an app needing different
// behaviour composes its own generator instead of filing an issue here.
export { requirementTests } from "./requirement-tests.js";
export { requirementsFile } from "./requirements-file.js";
export type { RequirementRow } from "./requirements-view.js";
export type {
  RequirementTestsOpts,
  RequirementTestRenderer,
} from "./requirement-tests.js";
