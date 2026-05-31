export { ObjectManager } from "./object-manager.js";
export type { ObjectManagerOptions, ReadOpts, WriteOpts } from "./object-manager.js";

export type {
  PersistenceDriver, Dialect, Row, PrimitiveValue,
  WhereClause, OrderBy,
  SelectSpec, CountSpec, InsertSpec, InsertManySpec,
  UpdateSpec, UpdateManySpec, DeleteSpec, DeleteManySpec,
} from "./persistence-driver.js";

export type { Filter, FilterValue, QueryOpts } from "./query-builder.js";

export type { FieldViewSpec, EntityViewSpec } from "./view.js";

export type { ValidationResult } from "./validator-runner.js";
export type { ValidationFailure } from "./errors.js";
export {
  RuntimeError,
  ValidationError,
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
