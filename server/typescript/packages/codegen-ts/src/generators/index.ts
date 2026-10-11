// Built-in generator factories — the public home of every stock generator.
//
// Importing a factory from here runs the generator AS SHIPPED: nothing to copy, and an
// upgrade of the package is how its fixes arrive. `meta eject <name>` is the other path —
// it copies the reference template into `codegen/generators/` so the adopter can change
// what it emits (ADR-0034, Amendment 5). Both are supported; neither is deprecated.
//
// `entityFile`, `queriesFile`, `routesFile` and `barrel` were exported here, deprecated,
// and REMOVED at 1.0 so that an owned copy was the only path. 1.1 restored them: an
// adopter who changes nothing about a generator should not have to carry a copy of it
// that falls behind the reference. The byte-identity gate
// (`test/reference-byte-identical.test.ts`) holds each reference template to the factory
// of the same name exported here, so the two paths start from the same output.
//
// Which entries have a reference copy is declared once, in `REFERENCE_GENERATOR_NAMES`
// (reference-templates.ts); `meta gen --list` marks every other entry `package-only` —
// today that is `template`, the Mustache primitive, which has no emit logic of its own,
// and `requirements` and `agent-docs`, which do not ship a reference template yet.
//
// `docsFile` and `apiDocsFile` are exported here as the generators `meta docs` runs; they
// need no wiring. An ejected copy of either is listed in `docs: { generators: [...] }`, and
// `meta docs` then runs the copy (Amendment 7).
// See spec/decisions/ADR-0034-codegen-scaffold-and-own.md.

export { entityFile, type EntityFileOpts } from "./entity-file.js";
export { queriesFile, type QueriesFileOpts } from "./queries-file.js";
export { routesFile, type RoutesFileOpts } from "./routes-file.js";
export { barrel, type BarrelOpts } from "./barrel.js";

export { callableFile, type CallableFileOpts } from "./callable-file.js";
export { routesFileHono, type RoutesFileHonoOpts } from "./routes-file-hono.js";
export { namesFile } from "./names-file.js";
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
// FR-023 §4.3 — the publisher's flattened shared-model artifact + manifest generator.
// The three tool-file constants are re-exported alongside it purely so a `cli`
// test can assert they stay byte-equal to sdk's canonical copies (see that
// module's own comment for why codegen-ts can't just import sdk directly).
export {
  sharedModelFile,
  type SharedModelFileOpts,
  MANIFEST_FILE as SHARED_MODEL_MANIFEST_FILE,
  ARTIFACT_SUFFIX as SHARED_MODEL_ARTIFACT_SUFFIX,
  INTEGRITY_PREFIX as SHARED_MODEL_INTEGRITY_PREFIX,
} from "./shared-model-file.js";
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

// FR-044 Plan 4 — the Cube exporter: Cube data-model files (model/cubes/*.yml and, for a served
// @spine report, model/views/*.yml) for the reporting vocabulary. A reference helper; its pure stages are exported from the package root.
export { cubeModel, type CubeModelGeneratorOptions } from "./cube-model.js";
