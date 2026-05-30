export { render, type RenderOptions } from "./render.js";
export { type Provider, InMemoryProvider } from "./provider.js";
export { ESCAPERS, type RenderFormat } from "./escapers.js";
export {
  verify,
  ERR_VAR_NOT_ON_PAYLOAD,
  ERR_PARTIAL_UNRESOLVED,
  ERR_REQUIRED_SLOT_UNUSED,
  ERR_OUTPUT_TAG_MISSING,
  type PayloadField,
  type VerifyError,
  type VerifyOptions,
} from "./verify.js";

// FR-010 tolerant recover engine (Tier-2 forgiving parser).
export { recover } from "./recover/recover.js";
export {
  Format,
  FieldKind,
  FieldRecovery,
  Tolerance,
  RecoveryReport,
  scalar,
  enumField,
  range,
  object,
  recoverSchema,
  defaults,
  type FieldSpec,
  type RecoverSchema,
  type RecoverOptions,
  type RecoverOutcome,
  type RecoveryResult,
  type Coercion,
  type OnField,
} from "./recover/types.js";
export {
  asString,
  asInt,
  asLong,
  asDouble,
  asBool,
  asStringList,
} from "./recover/recover-map.js";
