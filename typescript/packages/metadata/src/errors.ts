// Typed error classes for the metadata parser.

/** Stable, language-neutral error codes — mirrors fixtures/conformance/ERROR-CODES.json. */
export const ERROR_CODES = [
  "ERR_TOP_LEVEL_NOT_OBJECT",
  "ERR_UNKNOWN_TYPE",
  "ERR_UNKNOWN_SUBTYPE",
  "ERR_MISSING_SUBTYPE",
  "ERR_DUPLICATE_NAME",
  "ERR_UNRESOLVED_SUPER",
  "ERR_INVALID_SUBTYPE_CHILD",
  "ERR_UNKNOWN_ATTR",
  "ERR_BAD_ATTR_VALUE",
  "ERR_BAD_DEFAULT_SORT_FIELD",
  "ERR_PROVIDER_DEPENDENCY_CYCLE",
  "ERR_PROVIDER_MISSING_DEPENDENCY",
  "ERR_PROVIDER_ATTR_CONFLICT",
  "ERR_MALFORMED_JSON",
  "ERR_MISSING_REQUIRED_ATTR",
  "ERR_SUBTYPE_RULE_VIOLATION",
  "ERR_OVERLAY_NO_TARGET",
  "ERR_MALFORMED_YAML",
  "ERR_INVALID_ORIGIN",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class ParseError extends Error {
  readonly source: string | undefined;
  readonly path: string | undefined; // logical path within the JSON, e.g. "metadata.children[2].field"
  readonly code: ErrorCode | undefined;

  constructor(
    message: string,
    opts?: { source?: string; path?: string; code?: ErrorCode },
  ) {
    super(message);
    this.name = "ParseError";
    this.source = opts?.source;
    this.path = opts?.path;
    this.code = opts?.code;
  }
}

/**
 * Error class for metamodel-level errors that are not parse errors — e.g.
 * provider composition failures (dependency cycles, missing dependencies,
 * attribute conflicts). Carries the same stable `.code` field as ParseError
 * for cross-language conformance.
 */
export class MetaModelError extends Error {
  readonly code: ErrorCode | undefined;

  constructor(message: string, opts?: { code?: ErrorCode }) {
    super(message);
    this.name = "MetaModelError";
    this.code = opts?.code;
  }
}
