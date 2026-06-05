export { entityFile, type EntityFileOpts } from "./entity-file.js";
export { queriesFile, type QueriesFileOpts } from "./queries-file.js";
export { callableFile, type CallableFileOpts } from "./callable-file.js";
export { routesFile, type RoutesFileOpts } from "./routes-file.js";
export { routesFileHono, type RoutesFileHonoOpts } from "./routes-file-hono.js";
export { barrel, type BarrelOpts } from "./barrel.js";
/** @deprecated ADR-0021 D1 — neutral artifact owned by `meta docs` (ADR-0020); not part of the recommended `meta gen` suite. */
export { mermaidErDiagram, type MermaidErOptions } from "./mermaid-er.js";
export { promptRender, type PromptRenderOpts } from "./prompt-render-file.js";
export { outputParser, type OutputParserOpts } from "./output-parser-file.js";
export { extractor, type ExtractorOpts } from "./extractor-file.js";
export { outputPrompt, type OutputPromptOpts } from "./output-prompt-file.js";
export { renderHelper, type RenderHelperOpts } from "./render-helper-file.js";
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
