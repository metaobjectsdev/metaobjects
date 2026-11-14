// Declared API surface constants (ADR-0030, ADR-0063) — type names, subtypes and
// attribute keys for `api.*`, `operation.*` and `binding.*`.
//
// The type-name constants live in shared/base-types.ts beside every other base type
// and are re-exported here so a consumer has one import site.

import { TYPE_API, TYPE_BINDING, TYPE_OPERATION } from "../../shared/base-types.js";

export { TYPE_API, TYPE_BINDING, TYPE_OPERATION };

// ---------------------------------------------------------------------------
// Subtypes
// ---------------------------------------------------------------------------

/** A request/response surface whose children are operations. The axis is the
 *  interaction model, never the protocol (ADR-0030). */
export const API_SUBTYPE_OPERATIONAL = "operational";
export const API_SUBTYPES = [API_SUBTYPE_OPERATIONAL] as const;
export type ApiSubType = (typeof API_SUBTYPES)[number];

/** Changes state; takes an `object.value`. */
export const OPERATION_SUBTYPE_COMMAND = "command";
/** Reads; returns a projection, entity or value. */
export const OPERATION_SUBTYPE_QUERY = "query";
export const OPERATION_SUBTYPES = [OPERATION_SUBTYPE_COMMAND, OPERATION_SUBTYPE_QUERY] as const;
export type OperationSubType = (typeof OPERATION_SUBTYPES)[number];

/** The HTTP binding of an operation (overrides the derived method and path). */
export const BINDING_SUBTYPE_REST = "rest";
export const BINDING_SUBTYPES = [BINDING_SUBTYPE_REST] as const;
export type BindingSubType = (typeof BINDING_SUBTYPES)[number];

// ---------------------------------------------------------------------------
// Attrs on operation.* (and @permission / @public on transition.* too)
// ---------------------------------------------------------------------------

/** FQN of the `object.value` an operation takes. */
export const OPERATION_ATTR_INPUT_REF = "inputRef";
/** FQN of the projection, entity or value an operation returns. */
export const OPERATION_ATTR_OUTPUT_REF = "outputRef";
/** The target entity, declared only when it cannot be derived. */
export const OPERATION_ATTR_OBJECT_REF = "objectRef";
/** The lifecycle moves a command may make (names of the target's transitions). */
export const OPERATION_ATTR_TRANSITIONS = "transitions";
/** The permission name the shell asks the policy about. */
export const OPERATION_ATTR_PERMISSION = "permission";
/** The shell calls no permission check. */
export const OPERATION_ATTR_PUBLIC = "public";
/** The business error codes a command body may return. */
export const OPERATION_ATTR_ERRORS = "errors";
/** A query returns a list. */
export const OPERATION_ATTR_MANY = "many";

// ---------------------------------------------------------------------------
// Attrs on binding.rest
// ---------------------------------------------------------------------------

export const BINDING_ATTR_METHOD = "method";
export const BINDING_ATTR_PATH = "path";
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Names a declared operation or a transition may not take: they are the derived CRUD
 *  verbs of the same service (ERR_TRANSITION_NAME_COLLISION). */
export const RESERVED_OPERATION_NAMES = ["create", "get", "list", "update", "delete"] as const;

/** A declared business error code: lower snake case. */
export const BUSINESS_ERROR_CODE_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/** Wire error codes an operation's route answers on its own, so a body may not declare them
 *  in @errors (O5): the enforcing shell's codes (ADR-0063 §6) and the API contract's generic
 *  ones (docs/features/api-contract.md). A body returning one would be indistinguishable on the
 *  wire from the shell or the transport answering. */
export const RESERVED_ERROR_CODES = [
  "not_found",
  "forbidden",
  "invalid_transition",
  "transition_condition_failed",
  "state_managed",
  "validation",
  "invalid_json",
  "invalid_id",
  "method_not_allowed",
  "constraint_violation",
  "internal",
] as const;
