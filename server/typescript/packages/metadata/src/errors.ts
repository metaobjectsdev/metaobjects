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
  // FR-024 (ADR-0029) — a dotted `Entity.child` extends ref resolved to a node
  // whose type or subtype does not match the extending node's. Dotted-only.
  "ERR_EXTENDS_TARGET_MISMATCH",
  // FR-024 — an identity.* node has no name. Identities are named,
  // author-chosen (e.g. "id"), so the dotted by-name extends form can
  // address them.
  "ERR_IDENTITY_NAME_REQUIRED",
  // A `type.subType` declared with `maxOccurs` (e.g. identity.primary,
  // maxOccurs:1) appears more times than allowed under one parent.
  "ERR_TOO_MANY_OCCURRENCES",
  // FR-024 — an identity.* on an object.projection lacks `extends`; a
  // projection identity is a pass-through of an entity identity.
  "ERR_PROJECTION_IDENTITY_NOT_EXTENDED",
  // FR-024 — identity key correspondence broken: an extended-identity field
  // has no local pass-through field extending it, or an explicit @fields
  // disagrees with the computed pass-through key.
  "ERR_IDENTITY_KEY_MISMATCH",
  // FR-024 (ADR-0028) — a source.* on an object.projection has a writable
  // @kind (table, or @kind omitted which defaults to table). Projections are
  // derived read-only representations; their sources must be read-only kinds.
  "ERR_PROJECTION_SOURCE_WRITABLE",
  "ERR_INVALID_SUBTYPE_CHILD",
  // FR-033 — a STRUCTURAL child (field/identity/source/validator/… — not an
  // attr) is placed under a parent whose registered childRules do not admit it
  // (the structural analogue of ERR_UNKNOWN_ATTR). Enforced in validate()
  // against the merged wildcard-match semantics; a NO-OP under today's wildcard
  // childRules (the rail strict per-subtype rules will use in S1). Strict-load
  // only. Detail names the parent, the child, and which placement was rejected.
  "ERR_CHILD_NOT_ALLOWED",
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
  // FR-024 (ADR-0029 decision 5) — an implicit (omitted-@via) origin path is
  // ambiguous: more than one single-hop relationship leads from the base
  // entity to the @from/@of entity (the error names the candidates), or a
  // projection's base entity cannot be derived because its fields extend
  // multiple entities and no extended identity anchors the base.
  "ERR_AMBIGUOUS_PATH",
  // FR-024 (ADR-0029 decision 6) — origin cardinality contract broken: a
  // passthrough @via path crosses a to-many hop (row-multiplying — you meant
  // aggregate), or an aggregate @via path is to-one at every hop (you meant
  // passthrough). Checked on explicit AND inferred paths.
  "ERR_ORIGIN_CARDINALITY",
  // FR-024 (ADR-0029 decision 7) — a field declares BOTH an entity-nested
  // `extends` (shape lineage) and an `origin.passthrough` @from (data lineage)
  // and they disagree: the resolved @from target is not the field's resolved
  // extends target (nor anywhere on its extends chain). Host-agnostic
  // (projections, entities, values). Aggregates are never judged (they
  // compute something new); a top-level abstract extends target is never
  // judged (shape-only reuse makes no lineage claim).
  "ERR_EXTENDS_ORIGIN_MISMATCH",
  // #185 — a field carrying origin.passthrough @from declares a field.<subType>
  // or array-ness differing from its resolved source field. A passthrough
  // forwards the value unchanged, so its type must be identical. Host-agnostic
  // (projections, entities, values, stored-proc parameter refs). Nullability is
  // NOT judged (an outer-join view legitimately widens NOT NULL → nullable).
  // Opt out of a deliberate type change with @convert: true (acknowledgement
  // only — no generated cast; real conversion is origin.expression, #159).
  "ERR_PASSTHROUGH_TYPE_MISMATCH",
  // FR-024 (spec §7) — an object.entity field carrying an origin.* child is
  // derived (read-only), so the entity must declare at least one source with
  // a read-only @kind (view/materializedView/storedProc/tableFunction) to
  // provide it. Table-only (or source-less) entities with derived fields
  // error. Projections and object.value hosts are exempt. Until the Phase-E
  // B4b cutover removes view-PRIMARY entities, a read-only-kind PRIMARY
  // source also counts as providable (legacy spelling).
  "ERR_DERIVED_FIELD_NO_READ_SOURCE",
  "ERR_ENTITY_PRIMARY_SOURCE_READONLY",
  "ERR_INVALID_TEMPLATE",
  // FR-017 — M:N relationship validation (slim vocabulary): @through must name a
  // junction declaring two identity.reference children; @sourceRefField must match
  // one of them; M:N attrs are invalid on a 1:N (@cardinality:one / no @through).
  "ERR_INVALID_RELATIONSHIP",
  // identity.reference @references names an FK target that does not resolve to any
  // object in the loaded tree (a dangling cross-reference between metadata).
  "ERR_INVALID_REFERENCE",
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
  // ADR-0042 — a field.object / field.map @objectRef does not resolve to any
  // object in the loaded tree (a dangling target). Bare refs resolve
  // package-locally (referrer's package, else root-level); FQN refs resolve
  // exactly — a bare cross-package ref no longer binds elsewhere.
  "ERR_UNRESOLVED_OBJECT_REF",
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
  // FR-032 (ADR-0032) — a ref-bearing attr (extends/@objectRef/@references/
  // origin @from/@of/@via/@parameterRef/@payloadRef/@responseRef) in CANONICAL
  // JSON used a relative authoring form (leading `::` or `..::`). Canonical JSON
  // is the self-contained interchange form: every ref MUST be fully-qualified.
  // Relative navigation is YAML-only (the desugar expands it via expandRef).
  "ERR_RELATIVE_REF_IN_CANONICAL",
  // FR-033 — a provider set's merged metamodel constraint graph is contradictory.
  // Surfaced by validateConstraints (constraint-validate.ts) at registry compose:
  // dangling ref / unsatisfiable required child / bad cardinality / closed-set
  // clash / required-child cycle / conflicting attr redefinition. The detail names
  // which of the six checks fired and the offending type(s).
  "ERR_INVALID_METAMODEL_CONSTRAINT",
  // index.lookup field-resolution: @fields is empty or names a field that does
  // not exist on the owning entity's effective (resolved via extends) field set.
  "ERR_INVALID_INDEX",
  // #195 — origin.computed @expr: the expression tree's inferred root type does
  // not equal the carrying field's declared field.<subType>. A computed column's
  // type is DERIVED from its expression, never asserted (no @convert escape),
  // so a mismatch is a hard load error (sibling of ERR_PASSTHROUGH_TYPE_MISMATCH).
  "ERR_COMPUTED_TYPE_MISMATCH",
  // #195 — origin.computed @expr contains a node whose kind/op/fn is not in the
  // closed expression grammar (ADR-0023 fail-closed). Detail names the bad token.
  "ERR_UNKNOWN_EXPR_NODE",
  // #208 — a source.rdb declares BOTH @sql (author-supplied body) and
  // @unmanaged (DDL owned elsewhere). The two markers are the mutually
  // exclusive non-default states of one "who owns this DDL" axis.
  "ERR_SQL_BODY_WITH_UNMANAGED",
  // #208 — a source.rdb declares @sql with a writable @kind ("table", the
  // default). A hand-written CREATE TABLE would bypass the column-diff
  // machinery; tables are fully modeled or @unmanaged, never opaque-bodied.
  "ERR_SQL_BODY_ON_WRITABLE_KIND",
  // #208 — a host object whose read source carries @sql also declares an
  // origin.*-bearing (derived) field, or (on object.projection) an @filter —
  // two sources of truth for the same body (the synthesized derivation/WHERE
  // vs. the author's verbatim SQL). Fail-closed.
  "ERR_ORIGIN_UNDER_SQL_BODY",
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
  // #208 — a host object whose source carries @unmanaged also declares an
  // origin.*-bearing (derived) field. Deliberate asymmetry with
  // ERR_ORIGIN_UNDER_SQL_BODY: @unmanaged acts on nothing (the tool never
  // touches the object's DDL), so a documented-but-unacted-on lineage is
  // benign — a WARN preserves the matview symmetry and lets an author
  // document lineage for future in-process evaluation (#211).
  "WARN_ORIGIN_UNDER_UNMANAGED",
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
  // Widened from the core ErrorCode union so a DOWNSTREAM provider's validator can emit its
  // own codes (LoaderError.code is `string`; the envelope compares codes as strings). Known
  // core codes still surface in editor suggestions via the `string & {}` idiom.
  readonly code: ErrorCode | (string & {});
  readonly source: ErrorSource;
  readonly suggestions?: string[];
  readonly fixture?: string;
  readonly node?: NodeContext;

  constructor(
    message: string,
    opts: {
      code: ErrorCode | (string & {});
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
