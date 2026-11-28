export { ObjectManager } from "./object-manager.js";
export type { ObjectManagerOptions, ReadOpts, WriteOpts } from "./object-manager.js";

export type {
  PersistenceDriver, Dialect, Row, PrimitiveValue,
  WhereClause, OrderBy, CompareOp, Operand,
  SelectSpec, CountSpec, InsertSpec, InsertManySpec,
  UpdateSpec, UpdateManySpec, DeleteSpec, DeleteManySpec,
} from "./persistence-driver.js";

export type { Filter, FilterValue, QueryOpts, TransitionGuard } from "./query-builder.js";

export type { FieldViewSpec, EntityViewSpec } from "./view.js";

export { runValidators } from "./validator-runner.js";
export type { ValidationResult, RunValidatorsOpts } from "./validator-runner.js";
export type { ValidationFailure } from "./errors.js";
export {
  RuntimeError,
  ValidationError,
  InvalidKeyError,
  NotFoundError,
  ConstraintViolationError,
  MetadataError,
  UnsafeNameError,
} from "./errors.js";

// FR-010 Phase B — metadata-driven runtime extract. The descriptor-driven extract ENGINE lives in
// the metadata-free @metaobjectsdev/render package; this bridge wires it to the Phase A runtime
// object model (MetaObject.newInstance() + the MetaField SPI), mirroring the JVM `om` siting.
export {
  extractObject,
  extractSchemaFor,
  assemble,
  MAX_NEST_DEPTH,
} from "./extract-object.js";

// LLM call recorder seam + parse-then-persist helper.
// Format is re-exported here so callers of recordLlmCall can import it from a
// single location rather than reaching into @metaobjectsdev/render directly.
export { Format } from "@metaobjectsdev/render";
export { LlmCallDbRecorder, NullRecorder, recordLlmCall, buildLlmCallRow, persistLlmCallRow, truncateRow } from "./llm-recorder.js";
export type { LlmRecorder, LlmCallRow, LlmCallInput, RecordLlmCallOptions, RecordLlmCallResult, LlmCallDbRecorderOpts } from "./llm-recorder.js";

// Constraint-violation mapping for generated write routes — never echoes the query.
export {
  classifyConstraintError,
  withConstraintMapping,
  RedactedDatabaseError,
  type ConstraintKind,
  type ConstraintFailure,
} from "./constraint-errors.js";

// UI-1 — metadata API contract for the browser read-model.
export { META_ROUTE_PATH, META_CONTENT_TYPE, metaJson, META_DOCS_ROUTE_PATH, metaDocsJson, type MetaDocsOptions } from "./meta-endpoint.js";

// The REST standard's list handling, parsed into a port-neutral form before any query library
// sees it (fixtures/list-query-conformance/): every mount and a hand-written transport share it.
export {
  parseListQuery, parseListQueryString, rawQueryOf, searchFields, likePatternToGlob,
  DEFAULT_MAX_IN_LIST, DEFAULT_MAX_NESTING,
  type FilterLeaf, type FilterNode, type FilterScalar, type ListQuery, type ListSearch, type ListSort, type ParseListQueryOpts,
} from "./drizzle-fastify/list-query.js";
export { FilterParseError, parsePageBound, pageLimit, type PageSize } from "./drizzle-fastify/list-params.js";
export type { FilterAllowlist, FilterFieldRule, FilterSubType, FilterValueFormat, SortAllowlist, SortFieldRule } from "./drizzle-fastify/filter-allowlist.js";
