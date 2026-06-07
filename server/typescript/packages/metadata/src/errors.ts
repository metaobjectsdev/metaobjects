// Typed error classes for the metadata parser.

import type { ErrorSource, LoaderError, NodeContext } from "./source.js";

/** Stable, language-neutral error codes — mirrors fixtures/conformance/ERROR-CODES.json. */
// NOTE: The following codes are forward-declared (no emitting site in the current
// TS parser/loader — the condition is not yet detected):
//   - ERR_DUPLICATE_NAME: parser silently reuses existing same-name nodes (find-or-create).
//   - ERR_MISSING_SUBTYPE: missing subType is resolved to the registry default, never an error.
//   - ERR_INVALID_SUBTYPE_CHILD: no child-rule validation pass exists yet.
// Cross-language conformance consumers should not expect these codes from the TS adapter.
//
// FR-004 build-time `verify` codes (ERR_VAR_NOT_ON_PAYLOAD, ERR_PARTIAL_UNRESOLVED,
// ERR_REQUIRED_SLOT_UNUSED, ERR_OUTPUT_TAG_MISSING) are emitted by `meta verify` / the
// zero-core-dependency @metaobjectsdev/render engine — NOT by the loader. They are
// registered here (and in fixtures/conformance/ERROR-CODES.json) only to keep the code
// vocabulary single-sourced across languages; render re-declares them locally to avoid
// importing this package.
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
  "ERR_PROVIDER_DUPLICATE_ID",
  "ERR_PROVIDER_MISSING_DEPENDENCY",
  "ERR_PROVIDER_ATTR_CONFLICT",
  "ERR_MALFORMED_JSON",
  "ERR_MISSING_REQUIRED_ATTR",
  "ERR_SUBTYPE_RULE_VIOLATION",
  "ERR_OVERLAY_NO_TARGET",
  "ERR_MALFORMED_YAML",
  "ERR_INVALID_ORIGIN",
  "ERR_INVALID_TEMPLATE",
  // FR-017 — M:N relationship validation (slim vocabulary): @through must name a
  // junction declaring two identity.reference children; @sourceRefField must match
  // one of them; M:N attrs are invalid on a 1:N (@cardinality:one / no @through).
  "ERR_INVALID_RELATIONSHIP",
  "ERR_VAR_NOT_ON_PAYLOAD",
  "ERR_PARTIAL_UNRESOLVED",
  "ERR_REQUIRED_SLOT_UNUSED",
  "ERR_OUTPUT_TAG_MISSING",
  "ERR_BAD_ATTR_FILTER",
  "ERR_STORAGE_FLATTENED_ARRAY",
  "ERR_STORAGE_WITHOUT_OBJECT_REF",
  // ADR-0013 — a field.object REQUIRES @objectRef (open/untyped JSON uses
  // the physical @dbColumnType: jsonb escape hatch on field.string instead).
  "ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF",
  // Source v2 (ADR-0007) error codes — enforcement added during the source-v2 rollout.
  "ERR_RESERVED_ATTR",
  "ERR_SOURCE_NO_PRIMARY",
  "ERR_SOURCE_MULTIPLE_PRIMARY",
  // FR-016 / ADR-0018 — per-kind physical-name alias validation on source.rdb.
  "ERR_PHYSICAL_NAME_KIND_MISMATCH",
  "ERR_PHYSICAL_NAME_MULTIPLE",
  // FR-013 — field-level @readOnly cross-attribute validation.
  "ERR_READONLY_ASSIGNED_PRIMARY",
  "ERR_READONLY_DOWNGRADE",
  // FR-015 — source.rdb @parameterRef typed-input validation.
  "ERR_PARAMETER_REF_UNRESOLVED",
  "ERR_PARAMETER_REF_NOT_VALUE_OBJECT",
  "ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND",
  "ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH",
  // FR-014 — TPH discriminator cross-attribute validation.
  "ERR_DISCRIMINATOR_FIELD_NOT_FOUND",
  "ERR_DISCRIMINATOR_VALUE_DUPLICATE",
  "ERR_DISCRIMINATOR_VALUE_MISSING",
  "ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH",
  // ADR-0006 D2 — YAML type-coercion guard. Emitted by every port's YAML
  // loader when a coerced scalar mismatches the schema-declared type.
  "ERR_YAML_COERCION",
  // FR5c — multi-file overlay merge produced a conflicting attribute value:
  // two contributors set the same @attr to different non-empty values.
  "ERR_MERGE_CONFLICT",
  // SP-H Unit9 — @filterable: true on a field subtype with no filter-operator
  // band (e.g. field.object). Would silently generate an empty-ops filter.
  "ERR_FILTERABLE_UNSUPPORTED_SUBTYPE",
  // ADR-0023 — a registration was attempted against a registry sealed after its
  // agreed metamodel-provider bootstrap. Codegen cannot invent metamodel attrs.
  "ERR_REGISTRY_SEALED",
  "ERR_UNKNOWN",
] as const;

/** Warning codes — same envelope shape as errors but advisory. */
export const WARNING_CODES = [
  // FR5c — two contributors declared the same node identically (no semantic
  // change). Emitted at the overlay-merge boundary.
  "WARN_DUPLICATE_DECLARATION",
  // Pre-FR5c legacy: parser/validator messages still surface as plain
  // strings; wrapped at the loader boundary into the envelope shape with
  // this code. Retired as those sites are migrated to envelopes.
  "WARN_LEGACY",
  // FR-016 / ADR-0018 — pre-1.0 legacy @table spelling on a non-table @kind.
  // Loader accepts; canonical-serializer rewrites to the kind-matching alias.
  "WARN_LEGACY_PHYSICAL_NAME_ALIAS",
  // FR-013 — @readOnly on a field child of object.value. The persistence
  // implication does not apply to value-objects; the attr is retained for
  // language-specific record/struct treatment (e.g. Kotlin `val` vs `var`).
  "WARN_READONLY_VALUE_OBJECT",
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Loader error carrying the ADR-0009 LoaderError envelope.
 *
 * Public shape (FR5a):
 *   new ParseError(message, { code, source, suggestions?, fixture?, node? })
 *
 * - `code` and `source` are required.
 * - `source` is the ErrorSource discriminated union (json/yaml/merged/resolved/
 *   database/code) — the same envelope every cross-language port emits.
 * - `suggestions[]`, `fixture`, `node` are optional per ADR-0009 §RECOMMENDED;
 *   FR5a does not populate them, FR5b–FR5e may.
 *
 * Legacy fields (`path?: string`, `source?: string`) were superseded by the
 * envelope's `jsonPath` and `files` and have been dropped — see CHANGELOG.
 */
export class ParseError extends Error implements LoaderError {
  readonly code: ErrorCode;
  readonly source: ErrorSource;
  readonly suggestions?: string[];
  readonly fixture?: string;
  readonly node?: NodeContext;

  constructor(
    message: string,
    opts: {
      code: ErrorCode;
      source: ErrorSource;
      suggestions?: string[];
      fixture?: string;
      node?: NodeContext;
    },
  ) {
    super(message);
    this.name = "ParseError";
    this.code = opts.code;
    this.source = opts.source;
    // exactOptionalPropertyTypes: only assign when defined.
    if (opts.suggestions !== undefined) {
      (this as { suggestions?: string[] }).suggestions = opts.suggestions;
    }
    if (opts.fixture !== undefined) {
      (this as { fixture?: string }).fixture = opts.fixture;
    }
    if (opts.node !== undefined) {
      (this as { node?: NodeContext }).node = opts.node;
    }
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
