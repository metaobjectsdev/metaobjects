// Built-in generator factories.
//
// ADR-0034 scaffold-and-own — `entityFile`, `queriesFile`, `routesFile` and `barrel` were
// exported here and DEPRECATED; 1.0 REMOVED them (ADR-0035 A3, `docs/1.0-readiness.md` G2,
// `docs/features/migrations/0.x-to-1.0.md` §11). Own a copy instead: `meta init` scaffolds
// them into `codegen/generators/*.ts` and `meta eject <name>` copies one at any time. They
// remain in this directory as the engine's internal composers and as the oracle the
// byte-identity gate holds each reference template to — they are no longer public API.
//
// The factories BELOW are not deprecated and this subpath is their supported public home:
// the prompt/output tier (`promptRender`, `outputParser`, `outputPrompt`, `extractor`,
// `renderHelper`, `traceHelperFile`) is upstream-owned and has no ownable copy — the CLI's
// own prompt-gate warning names this import path — and `routesFileHono` / `namesFile` /
// `callableFile` are stock generators a consumer wires directly.
// See spec/decisions/ADR-0034-codegen-scaffold-and-own.md.

export { callableFile, type CallableFileOpts } from "./callable-file.js";
export { routesFileHono, type RoutesFileHonoOpts } from "./routes-file-hono.js";
export { namesFile } from "./names-file.js";
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
// The `agent` docs surface — internal engine of `meta docs --agent`, like docsFile()
// and apiDocsFile(). Not a `meta gen` config generator.
export { agentDocsFile, type AgentDocsFileOpts } from "./agent-docs-file.js";
export type {
  AgentSchemaInput,
  SchemaColumnLike,
  SchemaTableLike,
  SchemaViewLike,
} from "./agent-schema-input.js";
export type { RequirementRow } from "./requirements-view.js";
export type {
  RequirementTestsOpts,
  RequirementTestRenderer,
} from "./requirement-tests.js";
