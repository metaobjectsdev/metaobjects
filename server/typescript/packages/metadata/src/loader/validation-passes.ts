// Stateless validation passes for the MetaDataLoader pipeline.
//
// Each function takes a fully-merged MetaData root and returns errors or
// warnings. No loader state is read or written — these are pure functions.
//
// Exported: validateDataGridSortFields, validateFilterableHasIndex,
//           validateOriginPaths, validateDerivedFieldProvidability,
//           validateDataGridFilterValues,
//           validateFieldObjectStorage  (called by MetaDataLoader.load() in order).
// Private:  _findObject, _findField, _findRelationship,
//           _validateFromPath, _validateViaPath  (helpers, not exported).

import { TYPE_VALIDATOR, TYPE_SEGMENT } from "../shared/base-types.js";
import {
  CROSS_FIELD_VALIDATOR_SUBTYPES,
  VALIDATOR_ATTR_CONDITION,
  VALIDATOR_ATTR_EQUALS,
  VALIDATOR_ATTR_FIELDS,
  VALIDATOR_ATTR_WHEN,
  VALIDATOR_SUBTYPE_EXACTLY_ONE,
  VALIDATOR_SUBTYPE_AT_LEAST_ONE,
  VALIDATOR_ATTR_MAX,
  VALIDATOR_SUBTYPE_PRESENT_IFF,
  VALIDATOR_SUBTYPE_REQUIRED_WHEN,
} from "../core/validator/validator-constants.js";
import { parseDurationLiteral } from "../core/field/duration-wire.js";
import type { MetaData } from "../shared/meta-data.js";
import type { MetaObject } from "../core/object/meta-object.js";
import { resolveFlattenedMember } from "../core/field/flattened-member.js";
import { resolveFilterPath } from "../core/relationship/filter-path.js";
import { effectiveProjectionFilter } from "../core/object/effective-projection-filter.js";
import type { MetaReferenceIdentity } from "../core/identity/meta-identity.js";
import { contradictionHint, contradictionsFor } from "../attr-contradictions.js";
import { ParseError, type ErrorCode } from "../errors.js";
import { resolveObjectRef, didYouMeanHint, refTarget } from "../naming-refs.js";
import { PACKAGE_SEPARATOR, CHILD_REF_SEPARATOR } from "../shared/structural.js";
import { resolvedSource, type ErrorSource } from "../source.js";
import {
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_LAYOUT,
  TYPE_IDENTITY,
  TYPE_ORIGIN,
  TYPE_RELATIONSHIP,
  TYPE_SOURCE,
  TYPE_TEMPLATE,
  TYPE_INDEX,
} from "../shared/base-types.js";
import {
  INDEX_SUBTYPE_LOOKUP,
  INDEX_ATTR_FIELDS,
} from "../core/index/index-constants.js";
import { IDENTITY_SUBTYPE_SECONDARY, IDENTITY_SUBTYPE_PRIMARY, IDENTITY_ATTR_GENERATION, GENERATION_INCREMENT } from "../core/identity/identity-constants.js";
import type { MetaIdentity } from "../core/identity/meta-identity.js";
import { MetaIndex } from "../core/index/meta-index.js";
import {
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_RESPONSE_REF,
  TEMPLATE_ATTR_REQUIRED_SLOTS,
  TEMPLATE_ATTR_TEXT_REF,
  TEMPLATE_ATTR_KIND,
  TEMPLATE_KIND_EMAIL,
  TEMPLATE_ATTR_SUBJECT_REF,
  TEMPLATE_ATTR_HTML_BODY_REF,
  TEMPLATE_SUBTYPE_OUTPUT,
  TEMPLATE_SUBTYPE_PROMPT,
} from "../template/template-constants.js";
import {
  OBJECT_SUBTYPE_ENTITY,
  OBJECT_SUBTYPE_VALUE,
  OBJECT_SUBTYPE_PROJECTION,
} from "../core/object/object-constants.js";
import { MetaSource } from "../persistence/source/meta-source.js";
import { resolveColumnName, resolveFlattenedColumnName } from "../naming.js";
import { isMetaField, isMetaObject, isMetaRoot } from "../shared/node-guards.js";
import {
  LAYOUT_SUBTYPE_DATA_GRID,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD,
  LAYOUT_DATA_GRID_ATTR_FILTER,
} from "../presentation/layout/layout-constants.js";
import {
  FIELD_ATTR_FILTERABLE,
  FIELD_ATTR_SORTABLE,
  FIELD_ATTR_OBJECT_REF,
  FIELD_ATTR_STORAGE,
  STORAGE_FLATTENED,
  FIELD_ATTR_DEFAULT,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_ENUM,
  FIELD_ATTR_INT_VALUE_MAP,
  FIELD_ATTR_MAX_LENGTH,
  FIELD_ATTR_VALUES,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_MAP,
  FIELD_ATTR_REQUIRED,
  FIELD_ATTR_VALUE_TYPE,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_UUID,
  FIELD_SUBTYPE_DURATION,
} from "../core/field/field-constants.js";
import { FIELD_ATTR_COLUMN, FIELD_ATTR_FLATTENED_COLUMN_PREFIX, FIELD_ATTR_DB_INDEXED, IDENTITY_ATTR_EXPR, IDENTITY_ATTR_SEQUENCE_NAME, IDENTITY_ATTR_SEQUENCE_START } from "../persistence/db/db-constants.js";
import { SOURCE_KIND_VIEW } from "../persistence/source/source-constants.js";
import {
  IDENTITY_ATTR_FIELDS,
  IDENTITY_SUBTYPE_REFERENCE,
  IDENTITY_REFERENCE_ATTR_REFERENCES,
} from "../core/identity/identity-constants.js";
import {
  ORIGIN_SUBTYPE_PASSTHROUGH,
  ORIGIN_SUBTYPE_AGGREGATE,
  ORIGIN_SUBTYPE_COMPUTED,
  ORIGIN_SUBTYPE_FIRST,
  ORIGIN_PASSTHROUGH_ATTR_FROM,
  ORIGIN_PASSTHROUGH_ATTR_VIA,
  ORIGIN_PASSTHROUGH_ATTR_CONVERT,
  ORIGIN_AGGREGATE_ATTR_AGG,
  ORIGIN_AGGREGATE_ATTR_OF,
  ORIGIN_AGGREGATE_ATTR_VIA,
  ORIGIN_AGGREGATE_ATTR_FILTER,
  ORIGIN_ATTR_DISTINCT,
  ORIGIN_ATTR_ORDER_BY,
  ORIGIN_COMPUTED_ATTR_EXPR,
  ORIGIN_FIRST_ATTR_OF,
  ORIGIN_FIRST_ATTR_VIA,
  ORIGIN_FIRST_ATTR_FILTER,
  ORIGIN_ATTR_SEGMENT,
  FILTER_OP_IS_DISTINCT_FROM,
  FILTER_OP_IS_NOT_DISTINCT_FROM,
  CORRELATED_FILTER_OPS,
  FILTER_OPERAND_FIELD,
  AGG_ANY,
  AGG_ALL,
  AGG_COLLECT,
  ASSEMBLY_ORIGIN_SUBTYPES,
  COLUMN_VALUE_AGGREGATES,
} from "../persistence/origin/origin-constants.js";
import {
  EXPR_CASE,
  EXPR_CASE_ELSE,
  EXPR_CASE_OPERAND,
  EXPR_CASE_THEN,
  EXPR_CASE_WHEN,
  EXPR_NOW,
  inferExprType,
  validateExprNode,
  type ExprNode,
} from "../core/attr/meta-attr-expression.js";
import { SORT_ORDER_VALUES } from "../core/query/query-constants.js";
import {
  RELATIONSHIP_ATTR_OBJECT_REF,
  RELATIONSHIP_ATTR_CARDINALITY,
  RELATIONSHIP_ATTR_THROUGH,
  RELATIONSHIP_ATTR_SOURCE_REF_FIELD,
  RELATIONSHIP_ATTR_SYMMETRIC,
  CARDINALITY_ONE,
  CARDINALITY_MANY,
} from "../core/relationship/relationship-constants.js";
import {
  referenceCandidatesFor,
  resolveRelationshipReference,
} from "../core/relationship/resolve-relationship-reference.js";
import type { MetaRoot } from "../shared/meta-root.js";
import type { MetaRelationship } from "../core/relationship/meta-relationship.js";
// Rule (f) runs the REAL M:N derivation so the loader and codegen cannot drift.
import { deriveM2MFields, M2MDerivationError } from "../core/relationship/derive-m2m-fields.js";
import { isReadOnlySource, isWritableSource } from "../shared/node-guards.js";
import {
  FILTER_COMPOSE_OR,
  FILTER_COMPOSE_AND,
  opsForSubType,
  opsForField,
} from "../core/query/query-constants.js";
import {
  REQUIREMENT,
  REQUIREMENT_ATTR_STATUS,
  REQUIREMENT_ATTR_IMPLEMENTED_BY,
  REQUIREMENT_ATTR_SUPERSEDED_BY,
  REQUIREMENT_STATUS_RETIRED,
} from "../core/requirement/requirement-constants.js";
import { findReverseReferenceHops } from "../core/relationship/find-reference.js";

// ---------------------------------------------------------------------------
// Layout dataGrid @defaultSortField validation
// ---------------------------------------------------------------------------

export function validateDataGridSortFields(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    // Use children() so inherited fields (via extends:/super:) are
    // visible when validating @defaultSortField references.
    const effective = obj.children();
    const fieldNames = new Set(
      effective.filter((c) => c.type === TYPE_FIELD).map((f) => f.name),
    );
    for (const layout of effective.filter((c) => c.type === TYPE_LAYOUT && c.subType === LAYOUT_SUBTYPE_DATA_GRID)) {
      // ADR-0039: resolving — a layout may inherit its grid attrs via extends.
      const sortField = layout.attr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD);
      if (typeof sortField === "string" && !fieldNames.has(sortField)) {
        errors.push(
          new ParseError(
            `dataGrid layout "${layout.name}" on entity "${obj.name}" has @defaultSortField "${sortField}" ` +
            `but no such field exists on "${obj.name}". Available fields: ${[...fieldNames].join(", ")}`,
            { code: "ERR_BAD_DEFAULT_SORT_FIELD", source: layout.source },
          ),
        );
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// template.* @payloadRef / @requiredSlots validation (FR-004 Plan #3, T2)
//
// Metadata-internal half of `verify` — runs at load time (no provider needed):
//   - @payloadRef resolves to a known object (the payload view-object)
//   - every @requiredSlots entry is a real field on that payload
// The template-text half (every {{var}} resolves to a payload field) needs the
// external template text via a provider, so it lives in the build-time
// `meta verify` step, not here.
// ---------------------------------------------------------------------------

/** Recursively collect all template.* nodes anywhere in the metadata tree. */
function allTemplates(node: MetaData): MetaData[] {
  const out: MetaData[] = [];
  // ADR-0039: own — structural walk over the PHYSICAL declaration tree collecting
  // every declared template.* node (each visited once at its declaration site).
  for (const c of node.ownChildren()) {
    if (c.type === TYPE_TEMPLATE) out.push(c);
    out.push(...allTemplates(c));
  }
  return out;
}

// #210 — a template-level payload target (@payloadRef / @responseRef) is an
// object.value OR a SOURCELESS object.projection. "Sourceless" is the #248
// persistability contract: no declared/inherited source.* child (a concrete
// projection cannot inherit one — ERR_PROJECTION_INHERITED_SOURCE — so for a
// concrete projection this is simply "no own source").
function _isLegalPayloadTarget(obj: MetaData): boolean {
  if (obj.subType === OBJECT_SUBTYPE_VALUE) return true;
  if (obj.subType !== OBJECT_SUBTYPE_PROJECTION) return false;
  // ADR-0039: resolving — a source anywhere in the extends chain binds the
  // projection to a backing store, which disqualifies it as a payload shape.
  return !obj.children().some((c) => c.type === TYPE_SOURCE);
}

// #210 (carried forward from the #219/ADR-0044 adjudication) — NESTED payload
// targets stay value-only: every `field.object @objectRef` reachable from a
// template-level payload target must resolve to an object.value. The
// template-level widen (sourceless projections) deliberately does NOT extend
// to nested targets. Dangling refs are NOT reported here — the registry-derived
// @objectRef resolution check already owns that failure.
// `visited` is shared across the WHOLE pass (all templates), so a bad nested
// target reachable from two templates reports ONCE — matching Java's
// throw-on-first single-error behavior.
function _checkNestedPayloadRefsValueOnly(
  payload: MetaData,
  root: MetaData,
  errors: ParseError[],
  visited: Set<MetaData>,
): void {
  if (visited.has(payload)) return;
  visited.add(payload);
  // ADR-0039: resolving — a payload shape may inherit fields via extends.
  for (const field of payload.children().filter((c) => c.type === TYPE_FIELD)) {
    if (field.subType !== FIELD_SUBTYPE_OBJECT) continue;
    // ADR-0039: resolving — @objectRef may be inherited via extends.
    const ref = field.attr(FIELD_ATTR_OBJECT_REF);
    if (typeof ref !== "string" || ref === "") continue;
    // ADR-0042: a bare ref resolves in the DECLARING owner's package (an
    // inherited field resolves in the package that declared it).
    const owner = field.parent ?? payload;
    const ownerPkg = owner.package ?? owner.fileDefaultPackage ?? "";
    const target = resolveObjectRef(root, ref, ownerPkg).node;
    if (target === undefined) continue; // dangling — reported by the @objectRef resolution check
    if (target.subType !== OBJECT_SUBTYPE_VALUE) {
      errors.push(
        new ParseError(
          `payload '${payload.fqn()}' field '${field.name}' @objectRef '${ref}' resolves to ` +
            `${TYPE_OBJECT}.${target.subType} — a nested payload target must be an object.value ` +
            `(template-level refs may also target a sourceless object.projection, nested refs may not) ` +
            `(#210, ADR-0028, ADR-0044)`,
          { code: "ERR_SUBTYPE_RULE_VIOLATION", source: field.source },
        ),
      );
      continue;
    }
    _checkNestedPayloadRefsValueOnly(target, root, errors, visited);
  }
}

export function validateTemplatePayloadRefs(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  // #210 — one visited set for the whole pass: a payload shared by N templates
  // is walked (and any bad nested target reported) exactly once.
  const nestedVisited = new Set<MetaData>();
  for (const tmpl of allTemplates(root)) {
    // --- @kind / textRef / email part-ref cross-field rules ---
    // template.output is either a document (@kind absent/"document" → @textRef
    // required) or an email (@kind="email" → @subjectRef + @htmlBodyRef required,
    // @textRef unused). template.prompt always requires @textRef (the renderable
    // body). The closed-enum membership of @kind is handled by validateAttrSchema
    // (allowedValues) — here we only enforce the conditional ref presence.
    if (tmpl.subType === TEMPLATE_SUBTYPE_OUTPUT) {
      // ADR-0039: resolving — a template may inherit its refs/attrs via extends.
      const kind = tmpl.attr(TEMPLATE_ATTR_KIND);
      if (kind === TEMPLATE_KIND_EMAIL) {
        // ADR-0039: resolving — a template may inherit @subjectRef via extends.
        if (typeof tmpl.attr(TEMPLATE_ATTR_SUBJECT_REF) !== "string") {
          errors.push(
            new ParseError(
              `template "${tmpl.name}" @kind "email" requires @subjectRef`,
              { code: "ERR_INVALID_TEMPLATE", source: tmpl.source },
            ),
          );
        }
        // ADR-0039: resolving — a template may inherit @htmlBodyRef via extends.
        if (typeof tmpl.attr(TEMPLATE_ATTR_HTML_BODY_REF) !== "string") {
          errors.push(
            new ParseError(
              `template "${tmpl.name}" @kind "email" requires @htmlBodyRef`,
              { code: "ERR_INVALID_TEMPLATE", source: tmpl.source },
            ),
          );
        }
      } else {
        // @kind absent or "document" → require @textRef. (An out-of-enum @kind is
        // separately reported by validateAttrSchema; we still require @textRef so a
        // document is never bodyless.)
          // ADR-0039: resolving — a template may inherit @textRef via extends.
        if (typeof tmpl.attr(TEMPLATE_ATTR_TEXT_REF) !== "string") {
          errors.push(
            new ParseError(
              `template "${tmpl.name}" @kind "document" requires @textRef`,
              { code: "ERR_INVALID_TEMPLATE", source: tmpl.source },
            ),
          );
        }
      }
    } else if (tmpl.subType === TEMPLATE_SUBTYPE_PROMPT) {
      // template.prompt always carries a renderable body via @textRef.
        // ADR-0039: resolving — a template may inherit @textRef via extends.
      if (typeof tmpl.attr(TEMPLATE_ATTR_TEXT_REF) !== "string") {
        errors.push(
          new ParseError(
            `template "${tmpl.name}" requires @textRef`,
            { code: "ERR_INVALID_TEMPLATE", source: tmpl.source },
          ),
        );
      }
    }

    // ADR-0042 — a bare @payloadRef/@responseRef resolves in the template's package.
    const referrerPkg = tmpl.package ?? tmpl.fileDefaultPackage ?? "";
    // ADR-0039: resolving — a template may inherit @payloadRef via extends.
    const payloadRef = tmpl.attr(TEMPLATE_ATTR_PAYLOAD_REF);
    if (typeof payloadRef !== "string") continue; // absence handled by the required-attr schema check
    // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
    // ADR-0042: resolveObjectRef prefers the referrer's own package before a root-level object.
    const payload = resolveObjectRef(root, payloadRef, referrerPkg).node;
    // #210 — a template-level payload target widened to object.value OR a
    // sourceless object.projection (a SOURCED projection stays illegal).
    if (!payload || !_isLegalPayloadTarget(payload)) {
      // FR5d — @payloadRef is a reference; emit format=resolved with
      // referrer=template FQN, target=the unresolved payloadRef string.
      errors.push(
        new ParseError(
          `template "${tmpl.name}" @payloadRef "${payloadRef}" does not resolve to an object.value or sourceless object.projection at root`,
          {
            code: "ERR_INVALID_TEMPLATE",
            source: resolvedSource(tmpl.source, tmpl.fqn(), payloadRef),
          },
        ),
      );
      continue;
    }
    // #210 — nested payload targets stay value-only (see the helper's doctrine).
    _checkNestedPayloadRefsValueOnly(payload, root, errors, nestedVisited);
    // ADR-0039: resolving — a template may inherit @responseRef via extends.
    const responseRef = tmpl.attr(TEMPLATE_ATTR_RESPONSE_REF);
    if (typeof responseRef === "string") {
      // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
      // ADR-0042: resolveObjectRef prefers the referrer's own package before a root-level object.
      const resVo = resolveObjectRef(root, responseRef, referrerPkg).node;
      if (!resVo || !_isLegalPayloadTarget(resVo)) {
        errors.push(
          new ParseError(
            `template "${tmpl.name}" @responseRef "${responseRef}" does not resolve to an object.value or sourceless object.projection at root`,
            { code: "ERR_INVALID_TEMPLATE", source: resolvedSource(tmpl.source, tmpl.fqn(), responseRef) },
          ),
        );
      } else {
        // #210 — the response closure's nested targets stay value-only too.
        _checkNestedPayloadRefsValueOnly(resVo, root, errors, nestedVisited);
      }
    }
    const fieldNames = new Set(
      payload.children().filter((c) => c.type === TYPE_FIELD).map((f) => f.name),
    );
    // ADR-0039: resolving — a template may inherit @requiredSlots via extends.
    const slots = tmpl.attr(TEMPLATE_ATTR_REQUIRED_SLOTS);
    const slotList = Array.isArray(slots) ? slots : typeof slots === "string" ? [slots] : [];
    for (const slot of slotList) {
      if (typeof slot === "string" && !fieldNames.has(slot)) {
        // FR5d — @requiredSlots is a field-on-payload reference; emit
        // format=resolved with referrer=template FQN, target=`payloadRef.slot`
        // (the dotted ref that did not resolve to a payload field).
        errors.push(
          new ParseError(
            `template "${tmpl.name}" @requiredSlots "${slot}" is not a field on payload "${payloadRef}". ` +
            `Available fields: ${[...fieldNames].join(", ")}`,
            {
              code: "ERR_INVALID_TEMPLATE",
              source: resolvedSource(tmpl.source, tmpl.fqn(), `${payloadRef}.${slot}`),
            },
          ),
        );
      }
    }
  }
  return errors;
}

// ADR-0042 — the cross-package ambiguity pass (ERR_AMBIGUOUS_REF) is RETIRED.
// A bare reference now resolves package-locally (referrer's package, else
// root-level) at every ref site via resolveObjectRef / refMatchesObject, so
// cross-package ambiguity is unreachable; an unresolved ref fails closed with
// its per-attr code (ERR_INVALID_RELATIONSHIP / ERR_INVALID_REFERENCE /
// ERR_UNRESOLVED_OBJECT_REF / ERR_INVALID_ORIGIN / ERR_INVALID_TEMPLATE).

// ---------------------------------------------------------------------------
// @filterable without index validation
// ---------------------------------------------------------------------------

export function validateFilterableHasIndex(root: MetaData): string[] {
  const warnings: string[] = [];
  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    // Use children() so inherited fields and identities (via extends:/super:)
    // are included when checking filterable-without-index.
    const effective = obj.children();
    // Build the set of field names that are part of any identity on this object.
    const indexedFieldNames = new Set<string>();
    for (const identity of effective.filter((c) => c.type === TYPE_IDENTITY)) {
      // ADR-0039: resolving — an identity may inherit @fields via extends.
      const fields = identity.attr(IDENTITY_ATTR_FIELDS);
      if (typeof fields === "string") {
        for (const name of fields.split(",")) indexedFieldNames.add(name.trim());
      } else if (Array.isArray(fields)) {
        for (const name of fields) if (typeof name === "string") indexedFieldNames.add(name);
      }
    }

    for (const field of effective.filter((c) => c.type === TYPE_FIELD)) {
      // ADR-0039: resolving — a concrete field may inherit @filterable via extends.
      const filterable = field.attr(FIELD_ATTR_FILTERABLE);
      if (filterable !== true) continue;
      // ADR-0039: resolving — a concrete field may inherit @db.indexed via extends.
      if (field.attr(FIELD_ATTR_DB_INDEXED) === true) continue;
      if (indexedFieldNames.has(field.name)) continue;
      warnings.push(
        `[filterable-without-index] field "${obj.name}.${field.name}" has @filterable: true but is not ` +
        `part of any identity. Filtering on this field will sequential-scan. Add @db.indexed: true ` +
        `to the field (when supported), or remove @filterable: true.`,
      );
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// @filterable on a subtype with no operator band (SP-H Unit9)
// ---------------------------------------------------------------------------
// A field marked @filterable: true whose subtype has NO entry in OPS_BY_SUBTYPE
// (e.g. field.object, or any extension subtype without a declared op band)
// would silently generate a filter type/allowlist with an empty op set — a
// filter route that rejects every request. Error early instead of shipping
// broken codegen. → ERR_FILTERABLE_UNSUPPORTED_SUBTYPE.

export function validateFilterableHasSupportedOps(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    // children() — inherited @filterable fields (via extends:/super:) are visible.
    for (const field of obj.children().filter((c) => c.type === TYPE_FIELD)) {
      // ADR-0039: resolving — a concrete field may inherit @filterable via extends.
      if (field.attr(FIELD_ATTR_FILTERABLE) !== true) continue;

      // #335 Half B — an ARRAY field has no operator band either. Every FR-009
      // operator (eq/ne/gt/gte/lt/lte/in/like/isNull) is a scalar comparison;
      // none applies to a collection column. The allowlist template does not
      // consult isArray and falls through to the "string" band, so this
      // previously emitted a `like` rule against a text[] column — SQL that
      // cannot execute. Same reason as the subtype check below, so same code.
      // ADR-0039: resolvedIsArray(), never the own `isArray` flag.
      if (field.resolvedIsArray()) {
        errors.push(
          new ParseError(
            `Field "${obj.name}.${field.name}" has @filterable: true but is an array ` +
              `(isArray: true). No filter operator applies to a collection column. ` +
              `Remove @filterable from this field.`,
            { code: "ERR_FILTERABLE_UNSUPPORTED_SUBTYPE", source: field.source },
          ),
        );
        continue;
      }

      if (opsForSubType(field.subType).length > 0) continue;
      errors.push(
        new ParseError(
          `Field "${obj.name}.${field.name}" has @filterable: true but its subtype ` +
            `"${field.subType}" has no filter-operator band. Remove @filterable, or use a ` +
            `field subtype that supports filtering (string/enum/uuid/number/currency/date/boolean).`,
          { code: "ERR_FILTERABLE_UNSUPPORTED_SUBTYPE", source: field.source },
        ),
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// @sortable on a subtype or shape that cannot be ordered (#335 Half B)
// ---------------------------------------------------------------------------
// @sortable defaults FROM @filterable, so it is independently set only when
// explicit — and nothing validated it, while @filterable has had a hard error
// since SP-H Unit9. A @sortable JSON or array column emits a sort entry over a
// column no dialect can ORDER BY meaningfully. → ERR_SORTABLE_UNSUPPORTED_SUBTYPE.

export function validateSortableHasSupportedSubtype(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    // children() — inherited @sortable fields (via extends:/super:) are visible.
    for (const field of obj.children().filter((c) => c.type === TYPE_FIELD)) {
      // ADR-0039: resolving — a concrete field may inherit @sortable via extends.
      if (field.attr(FIELD_ATTR_SORTABLE) !== true) continue;
      // ADR-0039: resolvedIsArray(), never the own `isArray` flag.
      const isArray = field.resolvedIsArray();
      if (!isArray && opsForSubType(field.subType).length > 0) continue;
      errors.push(
        new ParseError(
          `Field "${obj.name}.${field.name}" has @sortable: true but ` +
            (isArray
              ? `is an array (isArray: true) — a collection column has no ordering.`
              : `its subtype "${field.subType}" cannot be ordered.`) +
            ` Remove @sortable from this field.`,
          { code: "ERR_SORTABLE_UNSUPPORTED_SUBTYPE", source: field.source },
        ),
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Origin path validation
//
// Walks every projection's fields, finds `origin` (TYPE_ORIGIN) children,
// and validates:
//   - passthrough.@from resolves to an existing entity + field
//   - aggregate.@of resolves to an existing entity + field
//   - .@via paths resolve through real relationships, hopping entity-by-entity
//     using each relationship's @objectRef
//
// Note: @agg vocabulary is validated by validateAttrSchema (A3 pass) via
// allowedValues on the origin.aggregate @agg attr schema — not here.
// ---------------------------------------------------------------------------

function _findObject(root: MetaData, name: string, referrerPkg: string): MetaData | undefined {
  // ADR-0042 package-local resolution — an FQN resolves exactly on its
  // resolution key; a bare name resolves in the referrer's package, else a
  // root-level object. Shares the single resolveObjectRef matcher.
  return resolveObjectRef(root, name, referrerPkg).node;
}

function _findField(obj: MetaData, name: string): MetaData | undefined {
  // Use children() so inherited fields (via extends:/super:) are included.
  return obj.children().find((c) => c.type === TYPE_FIELD && c.name === name);
}

function _findRelationship(obj: MetaData, name: string): MetaData | undefined {
  // Use children() so inherited relationships (via extends:/super:) are included.
  return obj.children().find((c) => c.type === TYPE_RELATIONSHIP && c.name === name);
}

/**
 * Find an `identity.reference` (a forward-FK) by name — the "reference hop"
 * FR-024 allows in a `@via` path. The reference IS the FK (single source of
 * truth for direction + join column via findReferenceBetween), so naming it in
 * `@via` navigates its many-to-one edge without a redundant `relationship.*`.
 * Inherited via extends:/super: — use children().
 */
function _findReference(obj: MetaData, name: string): MetaData | undefined {
  return obj
    .children()
    .find(
      (c) => c.type === TYPE_IDENTITY && c.subType === IDENTITY_SUBTYPE_REFERENCE && c.name === name,
    );
}

/** True for an `identity.reference` node (a `@via` reference hop). */
function _isReferenceHop(hop: MetaData): boolean {
  return hop.type === TYPE_IDENTITY && hop.subType === IDENTITY_SUBTYPE_REFERENCE;
}

/** The target entity a `@via` hop points at: @objectRef (relationship) or @references (reference). */
function _hopTargetName(hop: MetaData): unknown {
  return _isReferenceHop(hop)
    ? hop.attr(IDENTITY_REFERENCE_ATTR_REFERENCES)
    : hop.attr(RELATIONSHIP_ATTR_OBJECT_REF);
}

/** Resolved `Entity.field` reference target: the entity AND the field node.
 *  FR-024 B5 inference needs the entity; the B6 extends/origin agreement
 *  check compares against the field node identity. */
interface ResolvedFromTarget {
  readonly entity: MetaData;
  readonly field: MetaData;
}

/**
 * Validate a passthrough `@from` / aggregate `@of` "Entity.field" reference.
 * Returns the resolved target entity + field on full success (FR-024 B5 —
 * the inference/cardinality stage needs the entity; B6 agreement needs the
 * field), or undefined when any error was pushed (malformed shape / unknown
 * entity / unknown field).
 */
function _validateFromPath(
  fromAttr: string,
  root: MetaData,
  projection: MetaData,
  fieldName: string,
  originSource: ErrorSource,
  errors: ParseError[],
  label: string = "origin.passthrough.@from",
): ResolvedFromTarget | undefined {
  const projectionName = projection.name;
  // FR5d — referrer is `<projection-FQN>::<fieldName>` (the canonical
  // "where the broken reference lives" identifier).
  const referrer = `${projection.fqn()}::${fieldName}`;
  // ADR-0042 — a bare @from/@of head resolves in the projection's package.
  const referrerPkg = projection.package ?? projection.fileDefaultPackage ?? "";
  const dotIdx = fromAttr.indexOf(".");
  if (dotIdx < 1 || dotIdx === fromAttr.length - 1) {
    // Malformed shape (not "Entity.field") — not a reference resolution
    // failure per se, but emit format=resolved with target=the bad string
    // so consumers see the same envelope shape across all FR5d sites.
    errors.push(
      new ParseError(
        `${label} "${fromAttr}" on ${projectionName}.${fieldName}: must be of form "Entity.field".`,
        {
          code: "ERR_INVALID_ORIGIN",
          source: resolvedSource(originSource, referrer, fromAttr),
        },
      ),
    );
    return undefined;
  }
  const entityName = fromAttr.slice(0, dotIdx);
  const targetFieldName = fromAttr.slice(dotIdx + 1);
  const sourceObj = _findObject(root, entityName, referrerPkg);
  if (!sourceObj) {
    // FR5d — entity half of the ref didn't resolve. target = full ref.
    errors.push(
      new ParseError(
        `${label} "${fromAttr}" on ${projectionName}.${fieldName}: no such entity "${entityName}".`,
        {
          code: "ERR_INVALID_ORIGIN",
          source: resolvedSource(originSource, referrer, fromAttr),
        },
      ),
    );
    return undefined;
  }
  // A member of a flattened value object (`Plan.address.city`) is a column of the owning table.
  const sourceField = _findField(sourceObj, targetFieldName)
    ?? resolveFlattenedMember(sourceObj, targetFieldName)?.member;
  if (!sourceField) {
    // FR5d — entity resolved, field on it did not. target = full ref.
    errors.push(
      new ParseError(
        `${label} "${fromAttr}" on ${projectionName}.${fieldName}: no such field "${targetFieldName}" on ${entityName}.`,
        {
          code: "ERR_INVALID_ORIGIN",
          source: resolvedSource(originSource, referrer, fromAttr),
        },
      ),
    );
    return undefined;
  }
  return { entity: sourceObj, field: sourceField };
}

/**
 * The entity an origin.aggregate's or origin.first's `@filter` keys name: the `@of` entity,
 * else the `@via` terminal. Undefined when neither resolves (validateOriginPaths reports why).
 */
export function originFilterEntity(origin: MetaData, root: MetaData): MetaData | undefined {
  const field = origin.parent;
  const projection = field?.parent;
  if (field === undefined || projection === undefined) return undefined;
  // ADR-0039: own — origin.* never inherits (ADR-0029).
  const of_ = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_OF);
  if (typeof of_ === "string" && of_ !== "") return _validateFromPath(of_, root, projection, field.name, origin.source, [])?.entity;
  const via = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_VIA);
  return typeof via === "string" && via !== "" ? _validateViaPath(via, root, projection, field.name, origin.source, [])?.terminal : undefined;
}

/** A fully-walked `@via` path: the relationship hop nodes in path order, and
 *  the TERMINAL entity reached after the last hop. Both fall out of one walk,
 *  so they are returned together — recovering the terminal with a second walk
 *  means maintaining a second copy of the ADR-0042 package-resolution rule.
 *  Shape mirrors `_validateFromPath`'s `ResolvedFromTarget`, which returns a
 *  pair for the same reason. */
interface WalkedViaPath {
  hops: MetaData[];
  terminal: MetaData;
  /** The hops walked BACKWARDS: an identity.reference of the next entity, walked from
   *  the entity it targets, so the hop is to-many — keyed to the hop name the path wrote. */
  reverse: ReadonlyMap<MetaData, string>;
}

/**
 * Validate an explicit `@via` "Entity.rel[.rel...]" path. On full success
 * returns the walked relationship hop nodes (in path order) — FR-024 B5 runs
 * the cardinality checks over them — together with the terminal entity node
 * (#335: a whole-object `@agg:collect` has no `@of` entity, so `@orderBy` keys
 * and value-object members resolve against the terminal instead). Returns
 * undefined when any error was pushed, so `terminal` is defined exactly when
 * `hops` is.
 */
function _validateViaPath(
  viaAttr: string,
  root: MetaData,
  projection: MetaData,
  fieldName: string,
  originSource: ErrorSource,
  errors: ParseError[],
): WalkedViaPath | undefined {
  const projectionName = projection.name;
  // FR5d — referrer is `<projection-FQN>::<fieldName>`.
  const referrer = `${projection.fqn()}::${fieldName}`;
  // ADR-0042 — a bare @via HEAD resolves in the projection's package.
  const referrerPkg = projection.package ?? projection.fileDefaultPackage ?? "";
  const segments = viaAttr.split(".");
  if (segments.length < 2) {
    errors.push(
      new ParseError(
        `origin.@via "${viaAttr}" on ${projectionName}.${fieldName}: must be of form "Entity.relationship[.relationship...]".`,
        {
          code: "ERR_INVALID_ORIGIN",
          source: resolvedSource(originSource, referrer, viaAttr),
        },
      ),
    );
    return undefined;
  }
  const [entityName, ...relSegments] = segments as [string, ...string[]];
  let currentObj = _findObject(root, entityName, referrerPkg);
  if (!currentObj) {
    errors.push(
      new ParseError(
        `origin.@via "${viaAttr}" on ${projectionName}.${fieldName}: no such entity "${entityName}".`,
        {
          code: "ERR_INVALID_ORIGIN",
          source: resolvedSource(originSource, referrer, viaAttr),
        },
      ),
    );
    return undefined;
  }
  // FR5d — track the deepest-valid-prefix as we walk. The prefix grows
  // segment-by-segment; on a hop failure the error message names the prefix
  // that DID resolve, so authors can fix multi-hop typos quickly.
  // After the entity lookup above, the deepest valid prefix is just the
  // entity name; each successful relationship hop appends a segment.
  const validSegments: string[] = [entityName];
  const hops: MetaData[] = [];
  const reverse = new Map<MetaData, string>();
  for (const relName of relSegments) {
    // FR-024: a hop may name a relationship OR a reference-only FK
    // (identity.reference) — the reference IS a navigable many-to-one edge.
    const rel = _findRelationship(currentObj, relName) ?? _findReference(currentObj, relName);
    if (!rel) {
      // A hop may walk an identity.reference BACKWARDS, from the entity it targets to the
      // entity that declares it, named by that entity's collection name (`Patient.consents` for
      // Consent.patient). A declared relationship or reference of the same name wins (above).
      const reversed = findReverseReferenceHops(currentObj as MetaObject, relName, isMetaRoot(root) ? root.objects() : []);
      if (reversed.length === 1) {
        validSegments.push(relName);
        hops.push(reversed[0]!.referenceIdentity);
        reverse.set(reversed[0]!.referenceIdentity, relName);
        currentObj = reversed[0]!.holder;
        continue;
      }
      if (reversed.length > 1) {
        const names = reversed.map((r) => `"${r.referenceIdentity.name}"`).join(", ");
        errors.push(
          new ParseError(
            `origin.@via "${viaAttr}" on ${projectionName}.${fieldName}: the reverse hop "${relName}" from ${currentObj.name} ` +
            `matches ${reversed.length} identity.reference nodes onto it (${names}) — ambiguous. Declare a relationship on ` +
            `${currentObj.name} for this hop, or keep one reference.`,
            {
              code: "ERR_AMBIGUOUS_PATH",
              source: resolvedSource(originSource, referrer, viaAttr),
            },
          ),
        );
        return undefined;
      }
      const prefix = validSegments.join(".");
      errors.push(
        new ParseError(
          `origin.@via "${viaAttr}" on ${projectionName}.${fieldName}: no such relationship or reference "${relName}" on ${currentObj.name}. ` +
          `Deepest valid prefix was "${prefix}".`,
          {
            code: "ERR_INVALID_ORIGIN",
            source: resolvedSource(originSource, referrer, viaAttr),
          },
        ),
      );
      return undefined;
    }
    // ADR-0039: resolving — a relationship/reference may inherit its target via extends.
    // Target entity: @objectRef (relationship) or @references (reference hop).
    const refTarget = _hopTargetName(rel);
    if (typeof refTarget !== "string" || refTarget === "") {
      const missingAttr = _isReferenceHop(rel) ? "@references" : "@objectRef";
      const kind = _isReferenceHop(rel) ? "reference" : "relationship";
      errors.push(
        new ParseError(
          `origin.@via "${viaAttr}" on ${projectionName}.${fieldName}: ${kind} "${relName}" on ${currentObj.name} is missing ${missingAttr}.`,
          {
            code: "ERR_INVALID_ORIGIN",
            source: resolvedSource(originSource, referrer, viaAttr),
          },
        ),
      );
      return undefined;
    }
    // ADR-0042 — the hop target (@objectRef/@references) resolves in the package
    // of the entity that DECLARES the relationship/reference, i.e. currentObj.
    const nextObj = _findObject(
      root,
      refTarget,
      currentObj.package ?? currentObj.fileDefaultPackage ?? "",
    );
    if (!nextObj) {
      // FR5d — relationship's @objectRef points at a missing entity. This
      // is the @objectRef-resolution edge of the via-path walk (the "5th
      // site" in FR5d's scope list for @objectRef references encountered
      // transitively).
      errors.push(
        new ParseError(
          `origin.@via "${viaAttr}" on ${projectionName}.${fieldName}: ${_isReferenceHop(rel) ? "reference" : "relationship"} "${relName}" points to non-existent entity "${refTarget}".`,
          {
            code: "ERR_INVALID_ORIGIN",
            source: resolvedSource(originSource, referrer, refTarget),
          },
        ),
      );
      return undefined;
    }
    validSegments.push(relName);
    hops.push(rel);
    currentObj = nextObj;
  }
  // currentObj is the terminal: every earlier exit returned undefined.
  return { hops, terminal: currentObj, reverse };
}

// ---------------------------------------------------------------------------
// FR-024 B5 — base-entity derivation, single-hop-unique @via inference, and
// origin cardinality checks (spec §5–§6; ADR-0029 decisions 5–6).
// ---------------------------------------------------------------------------

/** A hop's effective @cardinality, or undefined when not declared. A reference
 *  hop (a forward FK) is inherently to-one — a child names the parent it points at. */
function _hopCardinality(rel: MetaData, reverse?: ReadonlyMap<MetaData, string>): string | undefined {
  // A reference walked backwards reaches every row that references the walked-from one.
  if (reverse?.has(rel) === true) return CARDINALITY_MANY;
  if (_isReferenceHop(rel)) return CARDINALITY_ONE;
  const v = rel.attr(RELATIONSHIP_ATTR_CARDINALITY);
  return typeof v === "string" ? v : undefined;
}

/**
 * Derive the BASE entity a no-`@via` origin path anchors at (spec §5):
 *  - an entity (or any non-projection host) is its own base — derived fields
 *    on multi-source entities anchor at the entity itself;
 *  - a projection's base is the owner entity of its EXTENDED identity
 *    (`identity.primary { extends: "Customer.id" }` — declared structurally);
 *  - fallback (no identity): the single distinct entity targeted by the
 *    projection's plain field-`extends` refs; >1 distinct entity →
 *    ERR_AMBIGUOUS_PATH instructing the author to declare an extended
 *    identity; 0 → ERR_INVALID_ORIGIN (no base derivable, cannot infer).
 *
 * Returns undefined when no base is derivable (an error has been pushed).
 */
/**
 * FR-024: the entity NAMED by a node's dotted extends ref — the OWNER part of
 * `<owner>.<child>...` resolved as an object. This differs from
 * `superResolved.parent` when the resolved child is INHERITED: `Product.id`
 * selecting BaseEntity's identity through Product's effective children must
 * anchor `Product` (what the author wrote), never `BaseEntity` (where the
 * child physically lives).
 */
function _refNamedOwner(node: MetaData, root: MetaData, referrerPkg: string): MetaData | undefined {
  const ref = node.superRef;
  if (ref === undefined) return undefined;
  // Owner = everything before the child dot in the FINAL ::-segment (the object
  // the extends anchors at). ADR-0042: resolve it AS AUTHORED — an FQN owner
  // (`acme::Customer`) resolves exactly, a bare owner (`Product`) resolves in
  // the referrer's package. Do NOT strip the package to a bare tail.
  const lastSep = ref.lastIndexOf(PACKAGE_SEPARATOR);
  const segStart = lastSep === -1 ? 0 : lastSep + PACKAGE_SEPARATOR.length;
  const dotInSeg = ref.indexOf(CHILD_REF_SEPARATOR, segStart);
  if (dotInSeg <= segStart) return undefined; // no dotted child owner
  return _findObject(root, ref.slice(0, dotInSeg), referrerPkg);
}

function _deriveBaseEntity(
  obj: MetaData,
  root: MetaData,
  fieldName: string,
  originSource: ErrorSource,
  errors: ParseError[],
): MetaData | undefined {
  if (obj.subType !== OBJECT_SUBTYPE_PROJECTION) return obj;
  // ADR-0042 — a bare extends owner resolves in this projection's package.
  const referrerPkg = obj.package ?? obj.fileDefaultPackage ?? "";

  // 1) The extended identity anchors the base entity (declared, not inferred).
  //    The anchor is the entity NAMED in the ref's owner part — see _refNamedOwner.
  // ADR-0039: own — inspects THIS projection's OWN declared identities to read
  // their extends refs (an inherited identity carries no local superRef to anchor).
  for (const identity of obj.ownChildren().filter((c) => c.type === TYPE_IDENTITY)) {
    const extended = identity.superResolved;
    if (extended !== undefined && extended.type === TYPE_IDENTITY) {
      const named = _refNamedOwner(identity, root, referrerPkg);
      if (named !== undefined) return named;
      const owner = extended.parent;
      if (owner !== undefined && owner.type === TYPE_OBJECT) return owner;
    }
  }

  // 2) Fallback: the single distinct entity targeted by plain field-extends —
  //    again preferring the ref-named owner over the physical declaring ancestor.
  const targets = new Set<MetaData>();
  // ADR-0039: own — inspects THIS projection's OWN declared fields to read their
  // extends refs (an inherited field carries no local superRef to anchor).
  for (const f of obj.ownChildren().filter((c) => c.type === TYPE_FIELD)) {
    const sup = f.superResolved;
    if (sup === undefined) continue;
    const named = _refNamedOwner(f, root, referrerPkg);
    const owner = named ?? sup.parent;
    if (
      owner !== undefined &&
      owner.type === TYPE_OBJECT &&
      owner.subType !== OBJECT_SUBTYPE_VALUE &&
      owner !== obj
    ) {
      targets.add(owner);
    }
  }
  if (targets.size === 1) return [...targets][0];
  // A projection that extends another projection, and anchors nothing of its own, has the
  // base entity its super has (its inherited identity and fields are anchored there).
  const sup = obj.superResolved;
  if (targets.size === 0 && sup !== undefined && sup.type === TYPE_OBJECT && sup.subType === OBJECT_SUBTYPE_PROJECTION) {
    return _deriveBaseEntity(sup, root, fieldName, originSource, errors);
  }
  if (targets.size > 1) {
    const names = [...targets].map((t) => `"${t.name}"`).join(", ");
    errors.push(
      new ParseError(
        `origin on ${obj.name}.${fieldName}: cannot derive the base entity — the projection's fields extend ` +
          `multiple entities (${names}) and no identity extends an entity identity. Declare an extended identity ` +
          `(e.g. identity.primary { name: "id", extends: "<Entity>.<identity>" }) to anchor the base entity (FR-024).`,
        { code: "ERR_AMBIGUOUS_PATH", source: originSource },
      ),
    );
  } else {
    errors.push(
      new ParseError(
        `origin on ${obj.name}.${fieldName}: cannot derive the base entity for @via inference — the projection ` +
          `has no extended identity and no entity-targeted field extends. Declare an extended identity or an explicit @via (FR-024).`,
        { code: "ERR_INVALID_ORIGIN", source: originSource },
      ),
    );
  }
  return undefined;
}

/**
 * True when the `@from`/`@of` target entity IS the host's base relation: the
 * derived base entity itself, or an ancestor on the base's (or the host's)
 * whole-object extends chain — the legacy `Summary extends Program` projection
 * style inherits the base relation from its super, so `Program.title` on it is
 * a base-relation column, not a join.
 */
function _isBaseRelationTarget(target: MetaData, base: MetaData, host: MetaData): boolean {
  for (let cur: MetaData | undefined = base; cur !== undefined; cur = cur.superResolved) {
    if (cur === target) return true;
  }
  for (let cur: MetaData | undefined = host; cur !== undefined; cur = cur.superResolved) {
    if (cur === target) return true;
  }
  return false;
}

/**
 * Single-hop-unique `@via` inference (ADR-0029 decision 5): scan the base
 * entity's EFFECTIVE relationship children for those whose @objectRef resolves
 * to the `@from`/`@of` target entity. Exactly one → the inferred path (the
 * caller proceeds exactly as if `@via` were declared with that relationship).
 * Zero → ERR_INVALID_ORIGIN (cannot infer; multi-hop is always explicit).
 * More than one → ERR_AMBIGUOUS_PATH naming the candidate relationships.
 *
 * Inference stops at single-hop-unique deliberately: the algorithm is part of
 * the cross-port conformance contract; graph search is not trivially portable.
 */
function _inferViaSingleHop(
  base: MetaData,
  targetEntity: MetaData,
  obj: MetaData,
  fieldName: string,
  fromAttr: string,
  label: string,
  originSource: ErrorSource,
  errors: ParseError[],
): MetaData[] | undefined {
  const candidates = base
    .children()
    .filter((c) => c.type === TYPE_RELATIONSHIP)
    .filter((rel) => {
      // ADR-0039: resolving — a relationship may inherit @objectRef via extends.
      // ADR-0059 R7: compare the bound target, never a short name.
      return refTarget(rel, RELATIONSHIP_ATTR_OBJECT_REF) === targetEntity;
    });
  // FR5d — referrer is `<host-FQN>::<fieldName>`, target is the from/of ref
  // whose implicit path could not be resolved.
  const referrer = `${obj.fqn()}::${fieldName}`;
  if (candidates.length === 1) return [candidates[0] as MetaData];
  if (candidates.length === 0) {
    errors.push(
      new ParseError(
        `${label} "${fromAttr}" on ${obj.name}.${fieldName}: no @via and no single-hop relationship from base ` +
          `entity "${base.name}" to "${targetEntity.name}" — cannot infer the path. Declare @via explicitly ` +
          `(multi-hop paths are always explicit; ADR-0029).`,
        {
          code: "ERR_INVALID_ORIGIN",
          source: resolvedSource(originSource, referrer, fromAttr),
        },
      ),
    );
    return undefined;
  }
  const names = candidates.map((r) => `"${r.name}"`).join(", ");
  errors.push(
    new ParseError(
      `${label} "${fromAttr}" on ${obj.name}.${fieldName}: no @via and ${candidates.length} relationships from ` +
        `base entity "${base.name}" to "${targetEntity.name}" (${names}) — ambiguous. Declare @via naming one of them (ADR-0029).`,
      {
        code: "ERR_AMBIGUOUS_PATH",
        source: resolvedSource(originSource, referrer, fromAttr),
      },
    ),
  );
  return undefined;
}

/**
 * ADR-0029 decision 6 — a passthrough via-path must be effectively to-one at
 * EVERY hop. A hop is judged to-many only when it DECLARES `@cardinality:
 * "many"`: @cardinality is an open string at the metamodel level (Java-
 * canonical composite forms exist, and legacy fixtures omit it), so an
 * absent/unknown cardinality is never misjudged.
 */
function _checkPassthroughCardinality(
  hops: readonly MetaData[],
  obj: MetaData,
  fieldName: string,
  originSource: ErrorSource,
  errors: ParseError[],
  reverse?: ReadonlyMap<MetaData, string>,
): void {
  for (const rel of hops) {
    if (_hopCardinality(rel, reverse) === CARDINALITY_MANY) {
      errors.push(
        new ParseError(
          `origin.passthrough on ${obj.name}.${fieldName}: @via hop "${reverse?.get(rel) ?? rel.name}" is to-many ` +
            (reverse?.has(rel)
              ? `(reverse hop over identity.reference "${rel.name}")`
              : `(@cardinality "${CARDINALITY_MANY}")`) +
            ` — a row-multiplying passthrough — you meant aggregate (ADR-0029).`,
          { code: "ERR_ORIGIN_CARDINALITY", source: originSource },
        ),
      );
      return;
    }
  }
}

/**
 * ADR-0029 decision 6 — an aggregate via-path must contain at least one
 * to-many hop. Conservative on the open @cardinality vocabulary: the error
 * fires only when the path is PROVABLY to-one (every hop declares
 * `@cardinality: "one"`); absent/composite cardinalities are not judged.
 */
function _checkAggregateCardinality(
  hops: readonly MetaData[],
  obj: MetaData,
  fieldName: string,
  originSource: ErrorSource,
  errors: ParseError[],
  reverse?: ReadonlyMap<MetaData, string>,
): void {
  if (hops.length === 0) return;
  const provablyToOne = hops.every((rel) => _hopCardinality(rel, reverse) === CARDINALITY_ONE);
  if (provablyToOne) {
    errors.push(
      new ParseError(
        `origin.aggregate on ${obj.name}.${fieldName}: every @via hop is to-one (@cardinality "${CARDINALITY_ONE}") — ` +
          `aggregating over a to-one path — you meant passthrough (ADR-0029).`,
        { code: "ERR_ORIGIN_CARDINALITY", source: originSource },
      ),
    );
  }
}

/**
 * #335 — a whole-object `@agg:collect` projects EXACTLY the declared value
 * object's members, each matched by NAME against the `@via` terminal entity.
 *
 * Two rules, both fail-closed:
 *  - a member with no matching field on the terminal is unresolvable. Failing
 *    OPEN here is how #270 turned a curated value object into the full entity,
 *    invisible in a diff because the metadata still read as curated.
 *  - a matched member must agree on BOTH type axes (#185 type-preserving
 *    doctrine), so a scalar member cannot bind an array field or vice versa.
 *
 * Both refusals carry a whole-object-specific code — ERR_COLLECT_MEMBER_UNRESOLVED
 * for the unmatched member, ERR_COLLECT_WHOLE_OBJECT for the type disagreement.
 * The latter is deliberately NOT the scalar arm's ERR_INVALID_ORIGIN: a loader
 * that still requires @of rejects this metadata with ERR_INVALID_ORIGIN too, so
 * sharing the code would make a corpus fixture pass on a port that implements
 * nothing (the corpus compares only code + source, never message text).
 */
function _checkCollectMembers(
  refTarget: MetaData,
  terminal: MetaData,
  obj: MetaData,
  field: MetaData,
  src: ErrorSource,
  errors: ParseError[],
): void {
  // ADR-0039: resolving — a value object may inherit members via extends, and
  // the terminal entity may inherit fields; own-only would silently skip
  // inherited members, which is exactly the #270 bug class this guards.
  const terminalFields = terminal.children().filter((c) => c.type === TYPE_FIELD);
  for (const member of refTarget.children().filter((c) => c.type === TYPE_FIELD)) {
    const match = terminalFields.find((f) => f.name === member.name);
    if (match === undefined) {
      errors.push(new ParseError(
        `origin.aggregate @agg:collect on ${obj.name}.${field.name}: value-object member ` +
          `'${member.name}' has no matching field on '${terminal.name}' — a whole-object ` +
          `rollup projects exactly the declared members.`,
        { code: "ERR_COLLECT_MEMBER_UNRESOLVED", source: src }));
      continue;
    }
    const memberLabel = _typeLabel(member);
    const matchLabel = _typeLabel(match);
    if (memberLabel !== matchLabel) {
      errors.push(new ParseError(
        `origin.aggregate @agg:collect on ${obj.name}.${field.name}: value-object member ` +
          `'${member.name}' is ${memberLabel} but '${terminal.name}.${match.name}' ` +
          `is ${matchLabel} — a whole-object rollup preserves each member's type.`,
        { code: "ERR_COLLECT_WHOLE_OBJECT", source: src }));
    }
  }
}

/**
 * FR-024 B6 (spec §4; ADR-0029 decision 7) — extends/origin agreement.
 *
 * When a field declares BOTH an entity-nested `extends` (shape lineage) and
 * an `origin.passthrough` @from (data lineage), the two are independent
 * statements that must coincide: the resolved @from target must be THE SAME
 * NODE as the field's resolved extends target — or appear on its extends
 * chain (a projection field extending another projection's field that
 * ultimately extends the entity field still agrees). Host-agnostic: applies
 * on projections, entities, and values (FR-004 payloads may carry both).
 *
 * NOT judged:
 *  - `origin.aggregate` (it computes something new — no passthrough claim);
 *  - an extends whose target is a TOP-LEVEL abstract field (its parent is
 *    not an object) — shape-only reuse makes no lineage claim.
 */
function _checkExtendsOriginAgreement(
  field: MetaData,
  fromField: MetaData,
  fromAttr: string,
  obj: MetaData,
  originSource: ErrorSource,
  errors: ParseError[],
): void {
  const sup = field.superResolved;
  if (sup === undefined || sup.type !== TYPE_FIELD) return;
  const supOwner = sup.parent;
  if (supOwner === undefined || supOwner.type !== TYPE_OBJECT) return;
  for (let cur: MetaData | undefined = sup; cur !== undefined; cur = cur.superResolved) {
    if (cur === fromField) return; // shape lineage and data lineage agree
  }
  // FR5d resolved envelope: referrer = host::field, target = the @from ref.
  errors.push(
    new ParseError(
      `origin.passthrough on ${obj.name}.${field.name}: @from "${fromAttr}" disagrees with the field's extends ` +
        `target "${supOwner.name}.${sup.name}" — extends (shape lineage) and origin.passthrough (data lineage) ` +
        `must point at the same entity field (FR-024).`,
      {
        code: "ERR_EXTENDS_ORIGIN_MISMATCH",
        source: resolvedSource(originSource, `${obj.fqn()}::${field.name}`, fromAttr),
      },
    ),
  );
}

/**
 * #185 — passthrough is type-preserving. A field forwarding another field's
 * value via origin.passthrough must declare the SAME field.<subType> and the
 * same array-ness as its resolved @from source — otherwise the projected type
 * silently diverges from its source (e.g. a field.uuid surfaced as field.string,
 * forcing hand-written String↔UUID bridging). Compares the RESOLVING/effective
 * subType + isArray (ADR-0039), so a field inheriting its shape via `extends`
 * is judged on its effective type.
 *
 * Nullability is deliberately NOT judged: a view over an outer join legitimately
 * widens a NOT NULL source column to nullable, so a nullability check would
 * false-positive on valid projections.
 *
 * Escape hatch: @convert: true on the origin.passthrough acknowledges a
 * deliberate type change and suppresses the error (it does NOT emit a cast —
 * the consumer owns any coercion; real converting projections are #159's
 * origin.expression). Host-agnostic (projections, entities, values, and the
 * FR-015 stored-proc parameter refs the retired ERR_PARAMETER_REF_PASSTHROUGH_
 * TYPE_MISMATCH used to cover).
 */
/**
 * Both type axes in one comparable token. Subtype names never contain "[]", so
 * equal labels ⇔ same subType AND same array-ness. Nullability is deliberately
 * NOT judged — an outer-join view legitimately widens NOT NULL.
 * ADR-0039: resolvedIsArray(), never the own `isArray` flag — a field may
 * inherit its array-ness via extends.
 */
function _typeLabel(field: MetaData): string {
  return `field.${field.subType}${field.resolvedIsArray() ? "[]" : ""}`;
}

function _checkPassthroughType(
  field: MetaData,
  fromField: MetaData,
  fromAttr: string,
  convert: boolean,
  obj: MetaData,
  originSource: ErrorSource,
  errors: ParseError[],
): void {
  if (convert) return; // deliberate type change acknowledged
  const declared = _typeLabel(field);
  const source = _typeLabel(fromField);
  if (declared === source) return;
  errors.push(
    new ParseError(
      `origin.passthrough on ${obj.name}.${field.name}: field is ${declared} but its @from source ` +
        `"${fromAttr}" is ${source} — a passthrough forwards the value unchanged, so the types must ` +
        `match. Declare ${source}, or set @convert: true to acknowledge a deliberate type change.`,
      {
        code: "ERR_PASSTHROUGH_TYPE_MISMATCH",
        source: resolvedSource(originSource, `${obj.fqn()}::${field.name}`, fromAttr),
      },
    ),
  );
}

/**
 * #195 — validate `@orderBy` keys ('field[:asc|desc]') resolve against the
 * RELATED entity's effective fields (the entity reached via `@via`/`@of`), and
 * that any direction suffix is `asc`/`desc`. Null placement is pinned (nulls-last)
 * and carries no vocabulary. Shared by `@agg:collect` (element order) and
 * `origin.first` (row selection). A missing related entity means a prior error
 * already fired — skip silently.
 *
 * `code` lets the whole-object `@agg:collect` arm report ERR_COLLECT_WHOLE_OBJECT
 * instead; it defaults to ERR_INVALID_ORIGIN so the scalar `@of` and `origin.first`
 * call sites keep their existing envelope byte-for-byte.
 */
function _validateOrderByKeys(
  orderBy: unknown,
  relatedEntity: MetaData | undefined,
  obj: MetaData,
  fieldName: string,
  label: string,
  originSource: ErrorSource,
  errors: ParseError[],
  code: ErrorCode = "ERR_INVALID_ORIGIN",
): void {
  if (!Array.isArray(orderBy) || relatedEntity === undefined) return;
  for (const raw of orderBy) {
    if (typeof raw !== "string") continue;
    const colonIdx = raw.indexOf(":");
    const key = colonIdx === -1 ? raw : raw.slice(0, colonIdx);
    const dir = colonIdx === -1 ? undefined : raw.slice(colonIdx + 1);
    // ADR-0039: resolving — an ordering key may target an inherited field.
    const target = relatedEntity.children().find((f) => f.type === TYPE_FIELD && f.name === key);
    if (target === undefined) {
      errors.push(
        new ParseError(
          `${label} on ${obj.name}.${fieldName}: @orderBy key "${raw}" — no such field "${key}" on ${relatedEntity.name}.`,
          { code, source: originSource },
        ),
      );
    } else if (dir !== undefined && !(SORT_ORDER_VALUES as readonly string[]).includes(dir)) {
      errors.push(
        new ParseError(
          `${label} on ${obj.name}.${fieldName}: @orderBy key "${raw}" — direction must be one of ${SORT_ORDER_VALUES.join("|")}.`,
          { code, source: originSource },
        ),
      );
    }
  }
}

export function validateOriginPaths(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    // FR-024 B5: object.value hosts are EXEMPT from @via inference and
    // cardinality checks — a value's origin.passthrough is FR-015 parameter
    // lineage (values are constructed, never assembled; spec §7), not an
    // assembly path. Their @from refs are still resolution-validated.
    // #210: the assembly origins (aggregate/computed/collection/first) are
    // rejected outright on a value host (ERR_SUBTYPE_RULE_VIOLATION below).
    const isValueHost = obj.subType === OBJECT_SUBTYPE_VALUE;
    // ADR-0039: own — origin validation operates on the OWN-declared field+origin
    // layer (the established cross-port contract; origin.* never inherits, ADR-0029).
    for (const field of obj.ownChildren().filter((c) => c.type === TYPE_FIELD)) {
      for (const origin of field.ownChildren().filter((c) => c.type === TYPE_ORIGIN)) {
        // #210 — assembly origins live on projections. A value-hosted field may
        // not carry origin.aggregate / origin.computed / origin.first:
        // a value is constructed — by a caller or by embedding —
        // never assembled from a backing store. origin.passthrough STAYS legal
        // on a value (FR-015 parameter lineage; the B5 exemption below).
        if (
          isValueHost &&
          (ASSEMBLY_ORIGIN_SUBTYPES as readonly string[]).includes(origin.subType)
        ) {
          errors.push(
            new ParseError(
              `value object '${obj.fqn()}' field '${field.name}' hosts origin.${origin.subType} — ` +
                `assembly origins (${ASSEMBLY_ORIGIN_SUBTYPES.join(", ")}) live on object.projection; ` +
                `a value is constructed by a caller or by embedding, never assembled from a backing ` +
                `store. Re-host this field on a sourceless object.projection; origin.passthrough ` +
                `(FR-015 parameter lineage) remains legal on a value (#210, ADR-0028)`,
              { code: "ERR_SUBTYPE_RULE_VIOLATION", source: origin.source },
            ),
          );
          continue;
        }
        if (origin.subType === ORIGIN_SUBTYPE_PASSTHROUGH) {
          // ADR-0039: own — origin.* never inherits (ADR-0029).
          const from = origin.ownAttr(ORIGIN_PASSTHROUGH_ATTR_FROM);
          if (typeof from !== "string" || from === "") {
            // Missing-attr (not a reference resolution failure) — keep the
            // node's own source envelope (json/yaml/merged).
            errors.push(
              new ParseError(
                `origin.passthrough on ${obj.name}.${field.name}: missing @from.`,
                { code: "ERR_INVALID_ORIGIN", source: origin.source },
              ),
            );
            continue;
          }
          const fromTarget = _validateFromPath(from, root, obj, field.name, origin.source, errors);
          // FR-024 B6 — extends/origin agreement (host-agnostic; runs whether
          // @via is explicit, inferred, or a base-relation column).
          if (fromTarget !== undefined) {
            _checkExtendsOriginAgreement(field, fromTarget.field, from, obj, origin.source, errors);
            // #185 — passthrough is type-preserving unless @convert acknowledges a change.
            // ADR-0039: own — origin.* never inherits (ADR-0029).
            const convert = origin.ownAttr(ORIGIN_PASSTHROUGH_ATTR_CONVERT) === true;
            _checkPassthroughType(field, fromTarget.field, from, convert, obj, origin.source, errors);
          }
          // ADR-0039: own — origin.* never inherits (ADR-0029).
          const via = origin.ownAttr(ORIGIN_PASSTHROUGH_ATTR_VIA);
          if (typeof via === "string" && via !== "") {
            const walked = _validateViaPath(via, root, obj, field.name, origin.source, errors);
            if (walked !== undefined) {
              _checkPassthroughCardinality(walked.hops, obj, field.name, origin.source, errors, walked.reverse);
            }
          } else if (fromTarget !== undefined && !isValueHost) {
            // FR-024 §6 — no @via: derive the base entity; a @from targeting
            // the base relation itself is a plain base column (no checks);
            // otherwise infer the single-hop-unique path and gate cardinality.
            const base = _deriveBaseEntity(obj, root, field.name, origin.source, errors);
            if (base !== undefined && !_isBaseRelationTarget(fromTarget.entity, base, obj)) {
              const hops = _inferViaSingleHop(
                base, fromTarget.entity, obj, field.name, from,
                "origin.passthrough.@from", origin.source, errors,
              );
              if (hops !== undefined) {
                _checkPassthroughCardinality(hops, obj, field.name, origin.source, errors);
              }
            }
          }
        } else if (origin.subType === ORIGIN_SUBTYPE_AGGREGATE) {
          // ADR-0039: own — origin.* never inherits (ADR-0029).
          const src = origin.source;
          const agg = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_AGG);
          const of_ = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_OF);
          const ofPresent = typeof of_ === "string" && of_ !== "";
          const hasFilter = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_FILTER) !== undefined;
          const hasDistinct = origin.ownAttr(ORIGIN_ATTR_DISTINCT) !== undefined;
          const orderBy = origin.ownAttr(ORIGIN_ATTR_ORDER_BY);
          const hasOrderBy = orderBy !== undefined;
          const isPredicate = agg === AGG_ANY || agg === AGG_ALL;
          const isCollect = agg === AGG_COLLECT;

          // --- #195 field-shape rules ---
          // collect ⇒ the carrying field is an array (it produces a list); every
          // other @agg reduces to a scalar (the inverse rule closes a latent hole).
          if (isCollect && !field.resolvedIsArray()) {
            errors.push(new ParseError(
              `origin.aggregate @agg:collect on ${obj.name}.${field.name}: the carrying field must be isArray:true (collect produces a list).`,
              { code: "ERR_INVALID_ORIGIN", source: src }));
          } else if (!isCollect && field.resolvedIsArray()) {
            errors.push(new ParseError(
              `origin.aggregate @agg:${String(agg)} on ${obj.name}.${field.name}: a non-collect aggregate reduces to a scalar — the field must be isArray:false.`,
              { code: "ERR_INVALID_ORIGIN", source: src }));
          }
          // any/all yield a boolean.
          if (isPredicate && field.subType !== FIELD_SUBTYPE_BOOLEAN) {
            errors.push(new ParseError(
              `origin.aggregate @agg:${String(agg)} on ${obj.name}.${field.name}: a predicate quantifier yields a boolean — the field must be field.boolean.`,
              { code: "ERR_INVALID_ORIGIN", source: src }));
          }

          // --- #195 attr-presence rules ---
          if (hasDistinct && !isCollect) {
            errors.push(new ParseError(
              `origin.aggregate on ${obj.name}.${field.name}: @distinct is valid only on @agg:collect.`,
              { code: "ERR_INVALID_ORIGIN", source: src }));
          }
          if (hasOrderBy && !isCollect) {
            errors.push(new ParseError(
              `origin.aggregate on ${obj.name}.${field.name}: @orderBy is valid only on @agg:collect.`,
              { code: "ERR_INVALID_ORIGIN", source: src }));
          }
          if (isCollect && hasDistinct && hasOrderBy) {
            errors.push(new ParseError(
              `origin.aggregate @agg:collect on ${obj.name}.${field.name}: @orderBy and @distinct are mutually exclusive — a distinct collect uses value-ascending order (explicit element order is meaningful only without dedupe).`,
              { code: "ERR_INVALID_ORIGIN", source: src }));
          }

          if (isPredicate) {
            // --- any/all: @filter REQUIRED, @of FORBIDDEN, @via REQUIRED (no @of
            // to infer the path from) + must be to-many. ---
            if (!hasFilter) {
              errors.push(new ParseError(
                `origin.aggregate @agg:${String(agg)} on ${obj.name}.${field.name}: a predicate quantifier requires @filter (the quantified predicate); "does any related row exist" is @agg:count.`,
                { code: "ERR_INVALID_ORIGIN", source: src }));
            }
            if (ofPresent) {
              errors.push(new ParseError(
                `origin.aggregate @agg:${String(agg)} on ${obj.name}.${field.name}: @of is forbidden — a quantifier ranges over rows, not a column (the predicate is @filter).`,
                { code: "ERR_INVALID_ORIGIN", source: src }));
            }
            const via = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_VIA);
            if (typeof via !== "string" || via === "") {
              errors.push(new ParseError(
                `origin.aggregate @agg:${String(agg)} on ${obj.name}.${field.name}: requires an explicit @via (a quantifier has no @of to infer the path from).`,
                { code: "ERR_INVALID_ORIGIN", source: src }));
            } else {
              const walked = _validateViaPath(via, root, obj, field.name, src, errors);
              if (walked !== undefined) _checkAggregateCardinality(walked.hops, obj, field.name, src, errors, walked.reverse);
            }
            continue;
          }

          // --- @of: REQUIRED for count/sum/avg/min/max; OPTIONAL for collect ---
          // #335 — an @of-absent collect is a WHOLE-OBJECT rollup: collect the
          // related rows as an array of the field's declared @objectRef value
          // object rather than an array of one scalar column.
          if (!ofPresent) {
            if (!isCollect) {
              errors.push(new ParseError(
                `origin.aggregate on ${obj.name}.${field.name}: missing @of.`,
                { code: "ERR_INVALID_ORIGIN", source: src }));
              continue;
            }
            // Whole-object rollup. The carrying field must be a field.object
            // naming a value object, and @via must be explicit (there is no @of
            // entity to infer the single-hop relation from).
            // ADR-0039: resolving — @objectRef may be inherited via extends.
            const objectRef = field.attr(FIELD_ATTR_OBJECT_REF);
            if (field.subType !== FIELD_SUBTYPE_OBJECT || typeof objectRef !== "string" || objectRef === "") {
              errors.push(new ParseError(
                `origin.aggregate @agg:collect on ${obj.name}.${field.name}: @of is omitted, so this is a ` +
                  `whole-object rollup — the carrying field must be a field.object declaring @objectRef ` +
                  `(add @of to collect a single column instead).`,
                { code: "ERR_COLLECT_WHOLE_OBJECT", source: src }));
              continue;
            }
            // #210's value-only rule is PAYLOAD-scoped and never reaches a
            // projection-hosted field, so this branch enforces it itself.
            // Without it an @objectRef to an entity silently rolls up the FULL
            // entity — the #270 shape, this time baked into DDL.
            // ADR-0042 — a bare @objectRef resolves in the DECLARING owner's
            // package (an inherited field resolves in the package that
            // declared it) — same rule _checkNestedPayloadRefsValueOnly uses.
            const refOwner = field.parent ?? obj;
            const refPkg = refOwner.package ?? refOwner.fileDefaultPackage ?? "";
            const refTarget = resolveObjectRef(root, objectRef, refPkg).node;
            if (refTarget !== undefined && refTarget.subType !== OBJECT_SUBTYPE_VALUE) {
              errors.push(new ParseError(
                `origin.aggregate @agg:collect on ${obj.name}.${field.name}: @objectRef '${objectRef}' ` +
                  `resolves to ${TYPE_OBJECT}.${refTarget.subType} — a whole-object rollup must target an ` +
                  `object.value (#210, ADR-0028).`,
                { code: "ERR_SUBTYPE_RULE_VIOLATION", source: src }));
              continue;
            }
            // ADR-0039: own — origin.* never inherits (ADR-0029).
            const viaAttr = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_VIA);
            if (typeof viaAttr !== "string" || viaAttr === "") {
              errors.push(new ParseError(
                `origin.aggregate @agg:collect on ${obj.name}.${field.name}: @via is required on a ` +
                  `whole-object rollup — there is no @of entity to infer the relationship from.`,
                { code: "ERR_COLLECT_WHOLE_OBJECT", source: src }));
              continue;
            }
            // @distinct is refused on the object form. It is NOT an engine limit
            // (both engines dedupe JSON objects); it is a guaranteed no-op
            // whenever the value object carries the entity's primary key, which
            // is the common case, and a silent no-op is worse than a refusal.
            if (hasDistinct) {
              errors.push(new ParseError(
                `origin.aggregate @agg:collect on ${obj.name}.${field.name}: @distinct is not supported on a ` +
                  `whole-object rollup (it is a no-op whenever the value object carries the primary key).`,
                { code: "ERR_COLLECT_WHOLE_OBJECT", source: src }));
              continue;
            }
            // One walk yields both the hops (cardinality) and the terminal
            // entity (@orderBy keys, member resolution). An invalid @via
            // (e.g. single-segment "A") returns undefined having already
            // pushed its own error, so everything downstream is skipped and
            // no second, misleadingly-scoped error is emitted.
            const via = _validateViaPath(viaAttr, root, obj, field.name, src, errors);
            if (via !== undefined) {
              _checkAggregateCardinality(via.hops, obj, field.name, src, errors, via.reverse);
              // @orderBy keys resolve against the @via TERMINAL entity, not @of.
              _validateOrderByKeys(orderBy, via.terminal, obj, field.name, "origin.aggregate @agg:collect", src, errors,
                "ERR_COLLECT_WHOLE_OBJECT");
              if (refTarget !== undefined) {
                _checkCollectMembers(refTarget, via.terminal, obj, field, src, errors);
              }
            }
            continue;
          }
          // NOTE (FR-024 B6): NO extends/origin agreement check on aggregates —
          // an aggregate computes something new (count/sum/…); spec §4 defines
          // agreement for passthrough only.
          const ofTarget = _validateFromPath(of_, root, obj, field.name, src, errors, "origin.aggregate.@of");
          // A sum/avg/min/max reduces ONE column. A value-object field is several columns
          // (flattened) or a document (jsonb), so there is no column to reduce, and summing
          // a Money-shaped value across rows would add amounts in different currencies.
          if (
            ofTarget !== undefined &&
            (COLUMN_VALUE_AGGREGATES as readonly unknown[]).includes(agg) &&
            // ADR-0039: resolving — @objectRef may be inherited via extends.
            (ofTarget.field.subType === FIELD_SUBTYPE_OBJECT || ofTarget.field.attr(FIELD_ATTR_OBJECT_REF) !== undefined)
          ) {
            errors.push(new ParseError(
              `origin.aggregate @agg:${String(agg)} on ${obj.name}.${field.name}: @of "${of_}" is a value-object ` +
                `field (field.${ofTarget.field.subType}), which has no single column to aggregate. Aggregate a ` +
                `scalar field instead: model the amount as its own field (and group by its currency).`,
              { code: "ERR_INVALID_ORIGIN", source: resolvedSource(src, `${obj.fqn()}::${field.name}`, of_) }));
          }
          // #195 — collect preserves the element type: the array field's own subType
          // must equal the @of column's subType (the #185 doctrine on the element).
          if (isCollect && ofTarget !== undefined && field.subType !== ofTarget.field.subType) {
            errors.push(new ParseError(
              `origin.aggregate @agg:collect on ${obj.name}.${field.name}: field element type field.${field.subType} does not match the @of column type field.${ofTarget.field.subType} — collect preserves the element type.`,
              { code: "ERR_INVALID_ORIGIN", source: src }));
          }
          // @orderBy keys (collect only, non-distinct) resolve against the @of entity.
          if (isCollect && hasOrderBy && !hasDistinct) {
            _validateOrderByKeys(orderBy, ofTarget?.entity, obj, field.name, "origin.aggregate @agg:collect", src, errors);
          }
          // ADR-0039: own — origin.* never inherits (ADR-0029).
          const via = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_VIA);
          if (typeof via === "string" && via !== "") {
            const walked = _validateViaPath(via, root, obj, field.name, src, errors);
            if (walked !== undefined) {
              _checkAggregateCardinality(walked.hops, obj, field.name, src, errors, walked.reverse);
            }
            continue;
          }
          // FR-024 §6 — no @via on an aggregate: inference applies only when
          // @of targets a non-base entity; an aggregate over the base relation
          // itself still requires an explicit path. (A value host never reaches
          // here — the #210 assembly-origin check above already rejected it.)
          if (ofTarget === undefined) continue; // @of did not resolve — no inference to attempt
          const base = _deriveBaseEntity(obj, root, field.name, src, errors);
          if (base === undefined) continue; // base underivable — error already pushed
          if (_isBaseRelationTarget(ofTarget.entity, base, obj)) {
            errors.push(
              new ParseError(
                `origin.aggregate on ${obj.name}.${field.name}: missing @via (aggregates require a relationship path).`,
                { code: "ERR_INVALID_ORIGIN", source: src },
              ),
            );
            continue;
          }
          const hops = _inferViaSingleHop(
            base, ofTarget.entity, obj, field.name, of_,
            "origin.aggregate.@of", src, errors,
          );
          if (hops !== undefined) {
            _checkAggregateCardinality(hops, obj, field.name, src, errors);
          }
        } else if (origin.subType === ORIGIN_SUBTYPE_COMPUTED) {
          // #195 — a row-level expression over the base entity's OWN fields. No
          // @via/@of (strict scoping already rejects them as ERR_UNKNOWN_ATTR).
          const src = origin.source;
          const expr = origin.ownAttr(ORIGIN_COMPUTED_ATTR_EXPR);
          if (typeof expr !== "object" || expr === null) continue; // schema requires @expr (ERR_MISSING_REQUIRED_ATTR)
          // Structural grammar (fail-closed unknown node) is validated HERE, not in
          // the attr class, so every port validates the closed grammar identically
          // (the other ports store @expr verbatim; C#/Python/Java mirror this pass).
          const structural = validateExprNode(expr as ExprNode);
          if (structural.length > 0) {
            for (const m of structural) {
              errors.push(new ParseError(
                `origin.computed on ${obj.name}.${field.name}: ${m}`,
                { code: "ERR_UNKNOWN_EXPR_NODE", source: src }));
            }
            continue;
          }
          // Type inference against the base entity's EFFECTIVE fields (ADR-0039).
          const base = _deriveBaseEntity(obj, root, field.name, src, errors);
          if (base === undefined) continue;
          // A ref names one of the projection's own fields first (a
          // passthrough — joined or not —, an origin.first or another origin.computed), else a base
          // field. Never itself, never an aggregate (it would need the grouped row).
          const ownOriginOf = (name: string): MetaData | undefined =>
            // ADR-0039: own — origin.* never inherits (ADR-0029), so a field's origin is declared on it.
            obj.children().find((f) => f.type === TYPE_FIELD && f.name === name)?.ownChildren().find((c) => c.type === TYPE_ORIGIN);
          const resolveField = (name: string): string | undefined => {
            if (obj !== base && name !== field.name) {
              const own = obj.children().find((f) => f.type === TYPE_FIELD && f.name === name);
              const ownOrigin = ownOriginOf(name);
              if (own !== undefined && ownOrigin?.subType !== ORIGIN_SUBTYPE_AGGREGATE) return own.subType;
              if (own !== undefined) return undefined;
            }
            return base.children().find((f) => f.type === TYPE_FIELD && f.name === name)?.subType;
          };
          // A sibling computed ref is inlined by the view, so the refs must not lead back here.
          const computedRefs = (name: string): string[] => {
            const o = ownOriginOf(name);
            // ADR-0039: own — origin.* never inherits (ADR-0029), so @expr is declared on the origin.
            return o?.subType === ORIGIN_SUBTYPE_COMPUTED
              ? expressionFieldRefs(o.ownAttr(ORIGIN_COMPUTED_ATTR_EXPR)).filter((r) => r !== name)
              : [];
          };
          const reach = (start: string): Set<string> => {
            const seen = new Set<string>();
            const pending = computedRefs(start);
            for (let r = pending.pop(); r !== undefined; r = pending.pop()) {
              if (!seen.has(r)) pending.push(...computedRefs(r));
              seen.add(r);
            }
            return seen;
          };
          const reached = obj !== base ? reach(field.name) : new Set<string>();
          if (reached.has(field.name)) {
            // One error per cycle, on its first-declared member.
            const first = obj.children().find((f) => f.type === TYPE_FIELD && reached.has(f.name) && reach(f.name).has(field.name));
            if (first?.name === field.name) {
              errors.push(new ParseError(
                `origin.computed on ${obj.name}.${field.name}: @expr refers back to this field through other computed fields; a view cannot inline a cycle.`,
                { code: "ERR_INVALID_ORIGIN", source: src }));
            }
            continue;
          }
          const inferred = inferExprType(expr as ExprNode, resolveField);
          if (inferred.errors.length > 0) {
            for (const m of inferred.errors) {
              errors.push(new ParseError(
                `origin.computed on ${obj.name}.${field.name}: ${m}`,
                { code: "ERR_INVALID_ORIGIN", source: src }));
            }
            continue;
          }
          if (inferred.type !== undefined && inferred.type !== field.subType) {
            errors.push(new ParseError(
              `origin.computed on ${obj.name}.${field.name}: @expr infers field.${inferred.type} but the field is declared field.${field.subType} — a computed column's type is derived from its expression and must match (no @convert escape).`,
              { code: "ERR_COMPUTED_TYPE_MISMATCH", source: src }));
          }
        } else if (origin.subType === ORIGIN_SUBTYPE_FIRST) {
          // #195 — pick one related row by @orderBy along @via, project @of.
          const src = origin.source;
          const of_ = origin.ownAttr(ORIGIN_FIRST_ATTR_OF);
          const ofPresent = typeof of_ === "string" && of_ !== "";
          if (!ofPresent) {
            errors.push(new ParseError(
              `origin.first on ${obj.name}.${field.name}: missing @of.`,
              { code: "ERR_INVALID_ORIGIN", source: src }));
            continue;
          }
          // The carrying field must NOT be @required — an empty related set (after
          // @filter) selects no row, so the value is null. ADR-0039: resolving.
          if (field.attr(FIELD_ATTR_REQUIRED) === true) {
            errors.push(new ParseError(
              `origin.first on ${obj.name}.${field.name}: the field must not be @required — an empty related set (after @filter) yields null.`,
              { code: "ERR_INVALID_ORIGIN", source: src }));
          }
          const ofTarget = _validateFromPath(of_, root, obj, field.name, src, errors, "origin.first.@of");
          // #185 type-preservation: first projects the @of column unchanged, so the
          // field's subType must equal the @of column's subType (first is scalar).
          if (ofTarget !== undefined && field.subType !== ofTarget.field.subType) {
            errors.push(new ParseError(
              `origin.first on ${obj.name}.${field.name}: field field.${field.subType} does not match the @of column field.${ofTarget.field.subType} — first projects the column unchanged, so the types must match.`,
              { code: "ERR_INVALID_ORIGIN", source: src }));
          }
          // @via — explicit (validated + cardinality) or single-hop-unique inferred.
          const via = origin.ownAttr(ORIGIN_FIRST_ATTR_VIA);
          if (typeof via === "string" && via !== "") {
            const walked = _validateViaPath(via, root, obj, field.name, src, errors);
            if (walked !== undefined) _checkAggregateCardinality(walked.hops, obj, field.name, src, errors, walked.reverse);
          } else if (ofTarget !== undefined) {
            // (A value host never reaches here — the #210 assembly-origin
            // check above already rejected origin.first on a value.)
            const base = _deriveBaseEntity(obj, root, field.name, src, errors);
            if (base !== undefined && !_isBaseRelationTarget(ofTarget.entity, base, obj)) {
              const hops = _inferViaSingleHop(
                base, ofTarget.entity, obj, field.name, of_,
                "origin.first.@of", src, errors);
              if (hops !== undefined) _checkAggregateCardinality(hops, obj, field.name, src, errors);
            }
          }
          // @orderBy keys resolve against the related (@of) entity.
          _validateOrderByKeys(
            origin.ownAttr(ORIGIN_ATTR_ORDER_BY), ofTarget?.entity,
            obj, field.name, "origin.first", src, errors);
        }
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// FR-024 B6 — derived-field providability (spec §7 population doctrine).
//
// An object.ENTITY field carrying any origin.* child is derived (read-only):
// it does not exist on the writable table — something must PROVIDE it on
// read. The spec §7 multi-source pattern is a writable table-primary source
// plus a read-only-kind source (view / materializedView / storedProc /
// tableFunction, e.g. @role "replica") that carries the derived fields.
// An entity whose only sources are writable kinds — or that has no source at
// all — cannot provide an origin-bearing field → ERR_DERIVED_FIELD_NO_READ_SOURCE
// on that field (plain node-source envelope).
//
// Exemptions:
//  - object.projection — the projection's own source/wire IS the provider;
//  - object.value — FR-015 lineage; values are constructed, never populated.
//
// The rule reads "at least one read-only-kind source, any role". Since the
// B4b hard cutover (ERR_ENTITY_PRIMARY_SOURCE_READONLY makes a read-only-kind
// PRIMARY illegal on entities), the only loadable satisfying shape is the
// strict one — a non-primary-role read-only source (the §7 multi-source
// pattern: table primary + view replica).
//
// Sources are scanned on the EFFECTIVE child view (children()) so an entity
// inheriting its sources from an abstract base is judged by what it actually
// has; fields + origins use the own view, mirroring validateOriginPaths.
// ---------------------------------------------------------------------------

export function validateDerivedFieldProvidability(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  const reached = projectionReachedEntityFields(root);
  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root
    .children()
    .filter((c) => c.type === TYPE_OBJECT && c.subType === OBJECT_SUBTYPE_ENTITY)) {
    const hasReadCapableSource = obj
      .children()
      .filter((c) => c.type === TYPE_SOURCE)
      .some((s) => (s as MetaSource).isReadOnly());
    if (hasReadCapableSource) continue;
    // ADR-0039: own — origin-bearing fields are validated on the OWN-declared
    // layer (mirrors validateOriginPaths; origin.* never inherits, ADR-0029).
    for (const field of obj.ownChildren().filter((c) => c.type === TYPE_FIELD)) {
      const origin = field.ownChildren().find((c) => c.type === TYPE_ORIGIN);
      if (origin === undefined) continue;
      // A derived field a projection reaches (its @filter or a passthrough
      // @from) is lowered inline there, so it needs no read source. Only the inlinable origins.
      if ((origin.subType === ORIGIN_SUBTYPE_FIRST || origin.subType === ORIGIN_SUBTYPE_COMPUTED)
        && reached.has(field)) continue;
      errors.push(
        new ParseError(
          `derived field "${obj.name}.${field.name}" carries an origin.* but entity "${obj.name}" declares no ` +
            `read-capable source — derived fields do not exist on the writable table. Declare a read-only source ` +
            `(e.g. source.rdb @kind "view" @role "replica") to provide it, move the field to an object.projection (FR-024 §7), ` +
            `or reach it from a projection's @filter or @from (an origin.first or origin.computed is then inlined there).`,
          { code: "ERR_DERIVED_FIELD_NO_READ_SOURCE", source: field.source },
        ),
      );
    }
  }
  return errors;
}


// ---------------------------------------------------------------------------
// The entity fields projections REACH without outputting them: a
// projection @filter key naming a base field or a to-one path, and a passthrough @from. A
// derived field reached this way is lowered inline where it is reached.
// ---------------------------------------------------------------------------

/** Every entity field node some projection's @filter key or passthrough @from names. */
export function projectionReachedEntityFields(root: MetaData): Set<MetaData> {
  const reached = new Set<MetaData>();
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT && c.subType === OBJECT_SUBTYPE_PROJECTION)) {
    const silent: ParseError[] = [];
    const base = _deriveBaseEntity(obj, root, "@filter", obj.source, silent);
    // The effective filter — an extender reaches what its supers' filters name, too.
    const filter = effectiveProjectionFilter(obj);
    if (base !== undefined && base !== obj) {
      for (const key of filterKeys(filter)) {
        const path = resolveFilterPath(base as MetaObject, key);
        if (path !== undefined && typeof path !== "string") reached.add(path.field);
        else if (path === undefined) {
          const f = base.children().find((c) => c.type === TYPE_FIELD && c.name === key);
          if (f !== undefined) reached.add(f);
        }
      }
    }
    // ADR-0039: resolving — inherited fields carry their own origins.
    for (const field of obj.children().filter((c) => c.type === TYPE_FIELD)) {
      for (const origin of field.ownChildren().filter((c) => c.type === TYPE_ORIGIN && c.subType === ORIGIN_SUBTYPE_PASSTHROUGH)) {
        const from = origin.ownAttr(ORIGIN_PASSTHROUGH_ATTR_FROM);
        if (typeof from !== "string") continue;
        const target = _validateFromPath(from, root, obj, field.name, origin.source, silent);
        if (target !== undefined) reached.add(target.field);
      }
    }
  }
  return reached;
}

/**
 * Origin segments and correlated filters, on every origin.first / origin.aggregate:
 *   - `@segment` names a segment.filter declared on the related entity (the @of entity, else
 *     the @via terminal) — ERR_INVALID_ORIGIN otherwise;
 *   - an `@filter` operand `{ field: "<name>" }` names a field of the base row (the projection's
 *     base entity, or the entity hosting the field), with an op that compares two columns;
 *     the null-safe ops take only such an operand — ERR_BAD_ATTR_FILTER otherwise.
 */
export function validateOriginSegmentsAndCorrelation(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT
    && (c.subType === OBJECT_SUBTYPE_PROJECTION || c.subType === OBJECT_SUBTYPE_ENTITY))) {
    for (const field of obj.ownChildren().filter((c) => c.type === TYPE_FIELD)) {
      for (const origin of field.ownChildren().filter((c) => c.type === TYPE_ORIGIN
        && (c.subType === ORIGIN_SUBTYPE_FIRST || c.subType === ORIGIN_SUBTYPE_AGGREGATE))) {
        const where = `origin.${origin.subType} on ${obj.name}.${field.name}`;
        const segment = origin.ownAttr(ORIGIN_ATTR_SEGMENT);
        if (typeof segment === "string") {
          const related = originRelatedEntity(origin, obj, root);
          if (related !== undefined && !related.children().some((c) => c.type === TYPE_SEGMENT && c.name === segment)) {
            errors.push(new ParseError(
              `${where}: @segment "${segment}" is not a segment declared on "${related.name}", the entity whose rows it scopes.`,
              { code: "ERR_INVALID_ORIGIN", source: origin.source },
            ));
          }
        }
        const filter = origin.ownAttr(ORIGIN_FIRST_ATTR_FILTER);
        if (filter === undefined) continue;
        const silent: ParseError[] = [];
        const base = _deriveBaseEntity(obj, root, field.name, origin.source, silent);
        if (base === undefined) continue;
        checkCorrelatedOperands(filter, base, where, origin.source, errors);
      }
    }
  }
  return errors;
}

/** The entity whose rows an origin.first / origin.aggregate spans: its @of entity, else its @via terminal. */
function originRelatedEntity(origin: MetaData, obj: MetaData, root: MetaData): MetaData | undefined {
  const of_ = origin.ownAttr(ORIGIN_FIRST_ATTR_OF);
  const referrerPkg = obj.package ?? obj.fileDefaultPackage ?? "";
  if (typeof of_ === "string" && of_.lastIndexOf(".") > 0) {
    const owner = resolveObjectRef(root, of_.slice(0, of_.lastIndexOf(".")), referrerPkg).node;
    return owner;
  }
  const via = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_VIA);
  if (typeof via !== "string") return undefined;
  const [head, ...hops] = via.split(".");
  let current = resolveObjectRef(root, head ?? "", referrerPkg).node;
  for (const hop of hops) {
    if (current === undefined) return undefined;
    const rel = current.children().find((c) => (c.type === TYPE_RELATIONSHIP || c.type === TYPE_IDENTITY) && c.name === hop);
    current = rel === undefined
      ? findReverseReferenceHops(current as MetaObject, hop, isMetaRoot(root) ? root.objects() : [])[0]?.holder
      : refTarget(rel, rel.type === TYPE_RELATIONSHIP ? RELATIONSHIP_ATTR_OBJECT_REF : IDENTITY_REFERENCE_ATTR_REFERENCES);
  }
  return current;
}

function checkCorrelatedOperands(filter: unknown, base: MetaData, where: string, source: ErrorSource, errors: ParseError[]): void {
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) return;
  for (const [key, clause] of Object.entries(filter as Record<string, unknown>)) {
    if (key === FILTER_COMPOSE_AND || key === FILTER_COMPOSE_OR) {
      if (Array.isArray(clause)) for (const sub of clause) checkCorrelatedOperands(sub, base, where, source, errors);
      continue;
    }
    if (typeof clause !== "object" || clause === null || Array.isArray(clause)) continue;
    for (const [op, value] of Object.entries(clause as Record<string, unknown>)) {
      const isOperand = typeof value === "object" && value !== null && !Array.isArray(value) && FILTER_OPERAND_FIELD in value;
      const nullSafe = op === FILTER_OP_IS_DISTINCT_FROM || op === FILTER_OP_IS_NOT_DISTINCT_FROM;
      if (!isOperand) {
        if (nullSafe) {
          errors.push(new ParseError(
            `${where}: @filter on "${key}" uses "${op}", which compares with a base-row field: write { ${op}: { ${FILTER_OPERAND_FIELD}: "<base field>" } }.`,
            { code: "ERR_BAD_ATTR_FILTER", source },
          ));
        }
        continue;
      }
      const name = (value as Record<string, unknown>)[FILTER_OPERAND_FIELD];
      if (!CORRELATED_FILTER_OPS.includes(op)) {
        errors.push(new ParseError(
          `${where}: @filter on "${key}" compares with a base-row field using "${op}"; a correlated operand takes ${CORRELATED_FILTER_OPS.join(", ")}.`,
          { code: "ERR_BAD_ATTR_FILTER", source },
        ));
      } else if (typeof name !== "string" || !base.children().some((c) => c.type === TYPE_FIELD && c.name === name)) {
        errors.push(new ParseError(
          `${where}: @filter on "${key}" names base-row field "${String(name)}", which "${base.name}" does not declare.`,
          { code: "ERR_BAD_ATTR_FILTER", source },
        ));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Cross-field validators (comparison / requiredWhen / presentIff / atLeastOne / exactlyOne),
// which the database enforces as CHECKs:
//   - exactlyOne @fields names two or more fields (ERR_BAD_ATTR_VALUE): one is a required field;
//   - every field a @condition expression names is a field of the owning entity
//     (ERR_BAD_ATTR_VALUE), so the CHECK it renders to references a real column;
//   - a requiredWhen / presentIff @equals gating a field.duration is an ISO-8601 duration
//     (ERR_BAD_ATTR_VALUE), the form its CHECK literal is built from.
// Read RESOLVING (ADR-0039): an entity's validators and fields include inherited ones.
// ---------------------------------------------------------------------------

/** Every node of an attr.expression tree, root first. */
function expressionNodes(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (typeof node !== "object" || node === null) return out;
  const n = node as Record<string, unknown>;
  out.push(n);
  for (const key of ["left", "right", "arg", EXPR_CASE_OPERAND, EXPR_CASE_ELSE]) expressionNodes(n[key], out);
  if (Array.isArray(n["args"])) for (const a of n["args"] as unknown[]) expressionNodes(a, out);
  if (Array.isArray(n[EXPR_CASE])) {
    for (const arm of n[EXPR_CASE] as unknown[]) {
      if (typeof arm === "object" && arm !== null) {
        expressionNodes((arm as Record<string, unknown>)[EXPR_CASE_WHEN], out);
        expressionNodes((arm as Record<string, unknown>)[EXPR_CASE_THEN], out);
      }
    }
  }
  return out;
}

/** The field names an attr.expression tree references. */
function expressionFieldRefs(node: unknown): string[] {
  return expressionNodes(node).flatMap((n) => (typeof n["field"] === "string" ? [n["field"]] : []));
}

/** What a literal compared with a field.duration must be. */
const DURATION_LITERAL_FORM = "an ISO-8601 duration (such as PT1H30M; no years or months)";

/** Field subtypes whose values a condition compares with a number literal. */
const _CONDITION_NUMBER_SUBTYPES = new Set<string>([
  FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL, FIELD_SUBTYPE_CURRENCY,
]);

/**
 * Why a cross-field validator's `@condition` cannot become a CHECK guard, or undefined when it
 * can. Its names are already known to be fields. The rule, the same in every port:
 *  - it types cleanly (the origin.computed inference) and its root is boolean, since a CHECK
 *    negates it;
 *  - a literal compared with a field is of that field's kind (a boolean for field.boolean, a
 *    number for a numeric field, a string otherwise) and, for field.enum, one of its @values,
 *    for field.duration, an ISO-8601 duration;
 *  - no comparison has a null literal: `x = NULL` is never true, so use isNull / isNotNull.
 */
function conditionProblem(condition: unknown, obj: MetaObject): string | undefined {
  const unrenderable = expressionNodes(condition).find((n) => EXPR_CASE in n || EXPR_NOW in n);
  if (unrenderable !== undefined) {
    return `is not a valid expression: a condition takes no '${EXPR_CASE in unrenderable ? EXPR_CASE : EXPR_NOW}' node, since a CHECK can hold neither a CASE nor the current time.`;
  }
  const fields = new Map(obj.fields().map((f) => [f.name, f] as const));
  const inferred = inferExprType(condition as ExprNode, (name) => fields.get(name)?.subType);
  if (inferred.errors.length > 0) return `is not a valid expression: ${inferred.errors.join("; ")}.`;
  if (inferred.type !== FIELD_SUBTYPE_BOOLEAN) {
    return `must be a boolean expression (a comparison, a null test, or and / or / not of them), not a field.${String(inferred.type)}.`;
  }
  let problem: string | undefined;
  const visit = (node: unknown): void => {
    if (problem !== undefined || typeof node !== "object" || node === null) return;
    const n = node as Record<string, unknown>;
    if (n["left"] !== undefined && n["right"] !== undefined) {
      for (const [a, b] of [[n["left"], n["right"]], [n["right"], n["left"]]] as const) {
        const lit = a as Record<string, unknown>;
        const ref = b as Record<string, unknown>;
        if (!("value" in lit)) continue;
        if (lit["value"] === null) {
          problem = `compares with null, which is never true: use isNull or isNotNull.`;
          return;
        }
        const field = typeof ref["field"] === "string" ? fields.get(ref["field"]) : undefined;
        if (field === undefined) continue;
        const value = lit["value"];
        const kind = field.subType === FIELD_SUBTYPE_BOOLEAN ? "boolean"
          : _CONDITION_NUMBER_SUBTYPES.has(field.subType) ? "number" : "string";
        if (typeof value !== kind) {
          problem = `compares "${field.name}" (field.${field.subType}) with ${JSON.stringify(value)}; it needs a ${kind}.`;
          return;
        }
        const members = field.subType === FIELD_SUBTYPE_ENUM ? field.attr(FIELD_ATTR_VALUES) : undefined;
        if (Array.isArray(members) && !members.map(String).includes(String(value))) {
          problem = `compares "${field.name}" with ${JSON.stringify(value)}, which is not one of its @values (${members.join(", ")}).`;
          return;
        }
        if (field.subType === FIELD_SUBTYPE_DURATION && parseDurationLiteral(value as string) === undefined) {
          problem = `compares "${field.name}" with ${JSON.stringify(value)}, which is not ${DURATION_LITERAL_FORM}.`;
          return;
        }
      }
    }
    for (const key of ["left", "right", "arg"]) visit(n[key]);
    if (Array.isArray(n["args"])) for (const a of n["args"]) visit(a);
  };
  visit(condition);
  return problem;
}

export function validateCrossFieldValidators(root: MetaData, strict = false): ParseError[] {
  const errors: ParseError[] = [];
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    const fieldNames = new Set((obj as MetaObject).fields().map((f) => f.name));
    // ADR-0039: own — each validator is checked where it is declared.
    for (const v of obj.ownChildren()) {
      if (v.type !== TYPE_VALIDATOR || !CROSS_FIELD_VALIDATOR_SUBTYPES.includes(v.subType)) continue;
      // validator.atLeastOne takes no @max (1.3.0): "exactly one of these fields" is
      // validator.exactlyOne. A strict load already refuses the unregistered attr; this refuses it
      // under the default (non-strict) load too, where it would otherwise be kept and ignored —
      // silently a weaker constraint than its author wrote.
      // ADR-0039: own — the attr is checked on the validator that declares it.
      if (v.subType === VALIDATOR_SUBTYPE_AT_LEAST_ONE && v.ownAttr(VALIDATOR_ATTR_MAX) !== undefined) {
        if (strict) continue;  // the attr-schema pass already refused it
        errors.push(new ParseError(
          `validator.atLeastOne "${obj.name}.${v.name}" carries @max, which atLeastOne does not take. ` +
          `For "exactly one of these fields", declare validator.exactlyOne instead; for "at least one", remove @max.`,
          { code: "ERR_UNKNOWN_ATTR", source: v.source },
        ));
        continue;
      }
      if (v.subType === VALIDATOR_SUBTYPE_EXACTLY_ONE) {
        const fields = [v.attr(VALIDATOR_ATTR_FIELDS)].flat().filter((f) => typeof f === "string");
        if (fields.length < 2) {
          errors.push(new ParseError(
            `validator.exactlyOne "${obj.name}.${v.name}" @fields names ${fields.length} field${fields.length === 1 ? "" : "s"}; ` +
            `it needs two or more. For one field, make that field required.`,
            { code: "ERR_BAD_ATTR_VALUE", source: v.source },
          ));
          continue;
        }
      }
      if (v.subType === VALIDATOR_SUBTYPE_REQUIRED_WHEN || v.subType === VALIDATOR_SUBTYPE_PRESENT_IFF) {
        const when = (obj as MetaObject).fields().find((f) => f.name === v.attr(VALIDATOR_ATTR_WHEN));
        const equals = v.attr(VALIDATOR_ATTR_EQUALS);
        if (when?.subType === FIELD_SUBTYPE_DURATION && (typeof equals !== "string" || parseDurationLiteral(equals) === undefined)) {
          errors.push(new ParseError(
            `validator.${v.subType} "${obj.name}.${v.name}" @equals ${JSON.stringify(equals)} gates field.duration ` +
            `"${when.name}"; it needs ${DURATION_LITERAL_FORM}.`,
            { code: "ERR_BAD_ATTR_VALUE", source: v.source },
          ));
          continue;
        }
      }
      const condition = v.attr(VALIDATOR_ATTR_CONDITION);
      if (condition !== undefined) {
        const label = `validator.${v.subType} "${obj.name}.${v.name}" @condition`;
        const unknown = [...new Set(expressionFieldRefs(condition))].filter((f) => !fieldNames.has(f)).sort();
        if (unknown.length > 0) {
          errors.push(new ParseError(
            `${label} names ${unknown.map((f) => `"${f}"`).join(", ")}, ` +
            `which ${unknown.length === 1 ? "is not a field" : "are not fields"} of "${obj.name}".`,
            { code: "ERR_BAD_ATTR_VALUE", source: v.source },
          ));
          continue;
        }
        const problem = conditionProblem(condition, obj as MetaObject);
        if (problem !== undefined) {
          errors.push(new ParseError(`${label} ${problem}`, { code: "ERR_BAD_ATTR_VALUE", source: v.source }));
        }
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// identity.primary @sequenceStart / @sequenceName describe the sequence an @generation
// "increment" key draws from. On any other generation there is no sequence, so either one
// is refused (ERR_SEQUENCE_WITHOUT_INCREMENT) rather than silently ignored. Read RESOLVING
// (ADR-0039), reported on the identity that declares one of them.
// ---------------------------------------------------------------------------

/** The largest value a field.int key (a 32-bit integer column) can hold. */
const SEQUENCE_INT_MAX = 2147483647;

export function validateIdentitySequence(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    for (const id of obj.ownChildren()) {
      if (id.type !== TYPE_IDENTITY || id.subType !== IDENTITY_SUBTYPE_PRIMARY) continue;
      const declared = [IDENTITY_ATTR_SEQUENCE_START, IDENTITY_ATTR_SEQUENCE_NAME].filter((a) => id.ownAttr(a) !== undefined);
      if (declared.length === 0) continue;
      if (id.attr(IDENTITY_ATTR_GENERATION) === GENERATION_INCREMENT) {
        const start = id.attr(IDENTITY_ATTR_SEQUENCE_START);
        if (typeof start === "number") {
          // The key field's own range bounds the start (Postgres refuses the sequence
          // otherwise, at apply time): 1 to the largest value of a field.int / field.long.
          const keyName = [id.attr(IDENTITY_ATTR_FIELDS)].flat()[0];
          const key = (obj as MetaObject).fields().find((f) => f.name === keyName);
          const max = key?.subType === FIELD_SUBTYPE_INT ? SEQUENCE_INT_MAX : undefined;
          if (start < 1 || (max !== undefined && start > max)) {
            errors.push(new ParseError(
              `identity.primary "${obj.name}.${id.name}" @sequenceStart ${start} is out of range for its key ` +
              `"${String(keyName)}"${key !== undefined ? ` (field.${key.subType})` : ""}: it must be at least 1` +
              `${max !== undefined ? ` and at most ${max}` : ""}.`,
              { code: "ERR_SEQUENCE_START_OUT_OF_RANGE", source: id.source },
            ));
          }
        }
        continue;
      }
      const generation = id.attr(IDENTITY_ATTR_GENERATION);
      const shown = typeof generation === "string" ? `"${generation}"` : "not set";
      errors.push(new ParseError(
        `identity.primary "${obj.name}.${id.name}" sets ${declared.map((a) => `@${a}`).join(" and ")}, but its @generation is ${shown}; ` +
        `only an @generation "increment" key draws from a sequence. Set @generation "increment", or remove ${declared.map((a) => `@${a}`).join(" and ")}.`,
        { code: "ERR_SEQUENCE_WITHOUT_INCREMENT", source: id.source },
      ));
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// field.enum @maxLength — the column length of a string-stored enum:
//   1. every member of @values fits in it (ERR_ENUM_VALUE_EXCEEDS_MAX_LENGTH), the
//      longest offender named;
//   2. it is refused beside @intValueMap (ERR_ENUM_MAX_LENGTH_WITH_INT_VALUE_MAP): an
//      int-stored enum's column is an integer, so a length would change nothing.
// Read RESOLVING (ADR-0039: all three may be inherited through extends), and reported on
// the node that DECLARES one of them, so an enum that only inherits them is not
// reported a second time. Every field.enum in the tree is checked, root-level abstract
// enums included. The project default (enums.maxLength) is not this pass's: the loader
// does not see the project config; resolveEnumMaxLength refuses an overflow of it.
// ---------------------------------------------------------------------------

export function validateEnumMaxLength(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  const visit = (node: MetaData): void => {
    // ADR-0039: own children — every node is visited once, where it is declared.
    for (const child of node.ownChildren()) {
      if (child.type === TYPE_FIELD && child.subType === FIELD_SUBTYPE_ENUM) checkEnum(child);
      if (child.type !== TYPE_FIELD) visit(child);
    }
  };
  const checkEnum = (field: MetaData): void => {
    const declares = [FIELD_ATTR_MAX_LENGTH, FIELD_ATTR_VALUES, FIELD_ATTR_INT_VALUE_MAP]
      .some((a) => field.ownAttr(a) !== undefined);
    const maxLength = field.attr(FIELD_ATTR_MAX_LENGTH);
    if (!declares || typeof maxLength !== "number") return;
    const owner = field.parent;
    const label = owner !== undefined && owner.type === TYPE_OBJECT ? `${owner.name}.${field.name}` : field.name;
    if (field.attr(FIELD_ATTR_INT_VALUE_MAP) !== undefined) {
      errors.push(new ParseError(
        `field.enum "${label}" sets @maxLength ${maxLength} and @intValueMap; an @intValueMap enum is stored as an integer, so a column length does not apply. Remove @maxLength.`,
        { code: "ERR_ENUM_MAX_LENGTH_WITH_INT_VALUE_MAP", source: field.source },
      ));
      return;
    }
    const values = field.attr(FIELD_ATTR_VALUES);
    const tooLong = (Array.isArray(values) ? values : [])
      .filter((v): v is string => typeof v === "string" && v.length > maxLength)
      .sort((a, b) => b.length - a.length);
    if (tooLong.length > 0) {
      errors.push(new ParseError(
        `field.enum "${label}" @maxLength ${maxLength} is shorter than its member "${tooLong[0]}" (${tooLong[0]!.length} characters). Raise @maxLength to at least ${tooLong[0]!.length}, or shorten the member.`,
        { code: "ERR_ENUM_VALUE_EXCEEDS_MAX_LENGTH", source: field.source },
      ));
    }
  };
  visit(root);
  return errors;
}

// ---------------------------------------------------------------------------
// field.object + @storage cross-attribute validation
//
// Rules (ADR-0013):
//   1. A field.object ALWAYS requires @objectRef. A field.object models a typed
//      nested value; without @objectRef it is "an oxymoron at the logical layer".
//      → ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF. The MESSAGE states the whole ladder,
//      not just the last rung: a known key set is an object.value the field
//      @objectRefs; dynamic keys over a known value type are a field.map; only a
//      bag no reader pins a key in is @dbColumnType: jsonb on a field.string.
//      Naming the escape hatch alone — which this error did until now — is what
//      taught adopters to reach for the bag by default, and it is the mechanism
//      behind every untyped-jsonb column an adoption audit finds.
//      (This rule subsumes the legacy @storage-without-@objectRef check —
//      @storage is only meaningful on a field.object, so the missing-@objectRef
//      situation now always reports this single, clearer error. One error per
//      node: when @objectRef is absent we skip the flattened/array check below.)
//   2. @storage "flattened" requires isArray to be absent or false (cannot
//      flatten a variable-length array into a fixed column set).
//   3. @flattenedColumnPrefix requires @storage "flattened" (ERR_FLATTENED_COLUMN_PREFIX_WITHOUT_FLATTENED_STORAGE):
//      no other storage gives the members columns of their own to prefix.
// ---------------------------------------------------------------------------

export function validateFieldObjectStorage(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    // ADR-0039: own — the concrete field is an OWN child of this object; its
    // inheritable attrs (@objectRef/@storage) are read resolving below.
    for (const field of obj.ownChildren().filter((c) => c.type === TYPE_FIELD)) {
      // ADR-0039: resolving — a concrete field.object may inherit @objectRef from
      // an abstract base via extends; reading own-only would wrongly reject it.
      const objectRef = field.attr(FIELD_ATTR_OBJECT_REF);
      const hasObjectRef = typeof objectRef === "string" && objectRef.length > 0;

      if (field.subType === FIELD_SUBTYPE_OBJECT && !hasObjectRef) {
        // A field.object with no @objectRef is rejected outright; reporting any
        // further @storage error on the same node would be redundant.
        errors.push(
          new ParseError(
            `field.object "${obj.name}.${field.name}" has no @objectRef; a field.object models a typed nested value and requires one. Take the first of these that fits: a known key set → declare an object.value and point @objectRef at it; dynamic keys over a known value type → field.map with @objectRef (a value object) or @valueType (a scalar); a genuinely open bag no reader pins a key in → @dbColumnType: jsonb on a field.string.`,
            { code: "ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF", source: field.source },
          ),
        );
        continue;
      }

      // ADR-0039: resolving — @storage and array-ness may be inherited via extends.
      const storage = field.attr(FIELD_ATTR_STORAGE);
      // @flattenedColumnPrefix names the columns a flattened value object adds to the owning table.
      // Under any other storage (absent is jsonb) there are no such columns, so the prefix
      // would change nothing: refuse it rather than ignore it silently.
      if (field.attr(FIELD_ATTR_FLATTENED_COLUMN_PREFIX) !== undefined && storage !== STORAGE_FLATTENED) {
        errors.push(
          new ParseError(
            `field.object "${obj.name}.${field.name}" sets @flattenedColumnPrefix, but its @storage is ${storage === undefined || storage === null ? "not set (jsonb)" : `"${String(storage)}"`}; only a @storage "flattened" value object puts its members' columns in the owning table. Set @storage "flattened", or remove @flattenedColumnPrefix.`,
            { code: "ERR_FLATTENED_COLUMN_PREFIX_WITHOUT_FLATTENED_STORAGE", source: field.source },
          ),
        );
      }
      if (storage === undefined || storage === null) continue;
      if (storage === STORAGE_FLATTENED && field.resolvedIsArray()) {
        errors.push(
          new ParseError(
            `field "${obj.name}.${field.name}" sets @storage "flattened" with isArray=true; flattened storage requires a single nested value`,
            { code: "ERR_STORAGE_FLATTENED_ARRAY", source: field.source },
          ),
        );
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// field.map value-type validation
//
// A field.map is an open-keyed map (Record<string,V> / dict[str,V]) stored in a
// single jsonb column. Keys are always strings. The value type is set by EXACTLY
// ONE of @valueType (a scalar value subtype) or @objectRef (a value-object). This
// pass enforces that exactly-one-of rule and that @valueType (when set) names a
// known scalar subtype. Cross-port parity: Java validateFieldMap, Python
// _validate_field_map, C# ValidateFieldMap.
// ---------------------------------------------------------------------------

const _MAP_SCALAR_VALUE_SUBTYPES = new Set<string>([
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_UUID,
]);

export function validateFieldMap(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    // ADR-0039: own — the concrete field is an OWN child; its inheritable attrs
    // (@valueType/@objectRef) are read resolving below.
    for (const field of obj.ownChildren().filter((c) => c.type === TYPE_FIELD)) {
      if (field.subType !== FIELD_SUBTYPE_MAP) continue;

      // ADR-0039: resolving — @valueType / @objectRef may be inherited via extends.
      const valueType = field.attr(FIELD_ATTR_VALUE_TYPE);
      const hasValueType = typeof valueType === "string" && valueType.length > 0;
      const objectRef = field.attr(FIELD_ATTR_OBJECT_REF);
      const hasObjectRef = typeof objectRef === "string" && objectRef.length > 0;

      if (hasValueType === hasObjectRef) {
        errors.push(
          new ParseError(
            `field.map "${obj.name}.${field.name}" must set exactly one of @valueType (a scalar value subtype) or @objectRef (a value-object); ${
              hasValueType ? "both are set" : "neither is set"
            }`,
            { code: "ERR_BAD_ATTR_VALUE", source: field.source },
          ),
        );
        continue;
      }

      if (hasValueType && !_MAP_SCALAR_VALUE_SUBTYPES.has(valueType as string)) {
        errors.push(
          new ParseError(
            `field.map "${obj.name}.${field.name}" has @valueType "${valueType}" which is not a scalar value subtype (string/int/long/double/float/decimal/boolean/date/time/timestamp/uuid). For a value-object-valued map use @objectRef instead.`,
            { code: "ERR_BAD_ATTR_VALUE", source: field.source },
          ),
        );
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Per-type @default coercibility validation (Phase B — generalized @default)
//
// The @default attr is registered on the field base, so any field subtype may
// declare it. Its value must coerce to the field's type (cross-port parity with
// Java ValidationPhase.validateFieldDefaults, Python _validate_field_defaults,
// C# ValidateFieldDefaults):
//   - int / long / currency        → ASCII integer parse (or finite decimal that
//                                     truncates — matches the engine's Coerce INT/LONG fallback)
//   - double / float / decimal      → finite-number parse (ASCII)
//   - boolean                       → exactly "true" | "false"
//   - enum                          → member of @values (handled by attr-schema-validate
//                                     Check 5; SKIPPED here to avoid double-emit)
//   - string / date / time / object / others → any value allowed
// A violation emits ERR_BAD_ATTR_VALUE on the field node's source.
//
// Own-only: validates @default declared on THIS node (ownAttr), matching the
// @values / FR-011 own-attr passes. Numeric gates are ASCII-only — they reject
// "1_000" separators, "0x.."/radix literals, and unicode digits (JS Number()
// would accept some of these). This mirrors Java's Long.parseLong / Double.parseDouble
// strictness exactly.
//
// The @default value is type-preserved by the parser (a JSON true/false → boolean,
// a JSON number → number, a JSON string → string), so it is stringified to the
// canonical form before the per-type gate (lower-case bool, plain number).
// ---------------------------------------------------------------------------

const _INT_DEFAULT_SUBTYPES = new Set<string>([
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_CURRENCY,
]);
const _NUM_DEFAULT_SUBTYPES = new Set<string>([
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL,
]);

// ASCII-only integer: optional sign, then digits. No separators, radix, unicode.
const _ASCII_INT = /^[+-]?\d+$/;
// ASCII-only decimal: optional sign, digits with optional fraction/exponent.
// No separators, no hex, no Infinity/NaN.
const _ASCII_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Canonical string form of a type-preserved @default value (lower-case bool, plain number). */
function _stringifyDefault(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** ASCII integer, or a finite ASCII decimal that truncates to an integer (Java parsesAsLong parity). */
function _parsesAsLong(s: string): boolean {
  const t = s.trim();
  if (_ASCII_INT.test(t)) return true;
  // accept a finite decimal that truncates to an integer value
  return _ASCII_NUMBER.test(t) && Number.isFinite(Number(t));
}

/** Finite ASCII number (Java parsesAsFiniteNumber parity). */
function _parsesAsFiniteNumber(s: string): boolean {
  const t = s.trim();
  return _ASCII_NUMBER.test(t) && Number.isFinite(Number(t));
}

export function validateFieldDefaults(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  _walkFieldDefaults(root, errors);
  return errors;
}

function _walkFieldDefaults(node: MetaData, errors: ParseError[]): void {
  if (node.type === TYPE_FIELD && node.subType !== FIELD_SUBTYPE_ENUM) {
    // Enum @default membership is validated by attr-schema-validate Check 5.
    // ADR-0039: own — validates the @default declared on THIS node (matches the
    // @values / FR-011 own-attr passes; an inherited default was gated on its parent).
    const raw = node.ownAttr(FIELD_ATTR_DEFAULT);
    if (raw !== undefined && raw !== null && !Array.isArray(raw) && typeof raw !== "object") {
      const def = _stringifyDefault(raw as string | number | boolean);
      const sub = node.subType;
      let ok: boolean;
      if (_INT_DEFAULT_SUBTYPES.has(sub)) ok = _parsesAsLong(def);
      else if (_NUM_DEFAULT_SUBTYPES.has(sub)) ok = _parsesAsFiniteNumber(def);
      else if (sub === FIELD_SUBTYPE_BOOLEAN) ok = def === "true" || def === "false";
      else ok = true; // string / date / time / object / others — any value allowed
      if (!ok) {
        errors.push(
          new ParseError(
            `field.${sub} "${node.name}" @${FIELD_ATTR_DEFAULT} "${def}" is not coercible to the field's type`,
            { code: "ERR_BAD_ATTR_VALUE", source: node.source },
          ),
        );
      }
    }
  }
  // ADR-0039: own — structural walk visiting every physical node once at its site.
  for (const child of node.ownChildren()) _walkFieldDefaults(child, errors);
}

// ---------------------------------------------------------------------------
// Layout dataGrid @filter value validation
//
// Runs after extends: resolution (so inherited @filterable fields are visible)
// and after parse-time desugaring (so every clause is canonical { op: value }).
// Builds the allowlist from @filterable fields using OPS_BY_SUBTYPE, then checks
// every filtered field is filterable and every op is allowed for its subtype.
// ---------------------------------------------------------------------------

export function validateDataGridFilterValues(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    const effective = obj.children();
    const allow = new Map<string, readonly string[]>();
    for (const f of effective.filter((c) => c.type === TYPE_FIELD)) {
      // ADR-0039: resolving — a concrete field may inherit @filterable via extends.
      if (f.attr(FIELD_ATTR_FILTERABLE) === true) {
        // opsForField, not opsForSubType — an int-backed field.enum (@intValueMap)
        // stores as an integer, so `like` is not in its band.
        allow.set(f.name, opsForField(f));
      }
    }
    for (const layout of effective.filter(
      (c) => c.type === TYPE_LAYOUT && c.subType === LAYOUT_SUBTYPE_DATA_GRID,
    )) {
      // ADR-0039: resolving — a layout may inherit @filter via extends.
      const filter = layout.attr(LAYOUT_DATA_GRID_ATTR_FILTER);
      // Type errors (e.g. legacy string form) are reported by validateAttrSchema.
      if (typeof filter !== "object" || filter === null || Array.isArray(filter)) continue;
      checkFilterClauses(filter as Record<string, unknown>, allow, obj.name, layout.name, layout.source, errors);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// FR-017 — M:N relationship validation (slim vocabulary)
//
// Deferred-resolution validation (runs after all files load + extends:
// resolution, like origin paths), enforcing the cross-port M:N contract:
//
//   (a) @symmetric:true is valid only on a self-join (@objectRef == declaring
//       entity). Otherwise ERR_BAD_ATTR_VALUE.
//   (b) @symmetric and @sourceRefField are mutually exclusive → ERR_BAD_ATTR_VALUE.
//   (c) When @through is present: the named entity must exist and declare exactly
//       two identity.reference children; @sourceRefField (if present) must match
//       one of those references' FK fields → ERR_INVALID_RELATIONSHIP.
//   (d) @through / @symmetric are invalid on a non-M:N relationship
//       (@cardinality != "many", or no @through) → ERR_INVALID_RELATIONSHIP.
//       @sourceRefField is also invalid there, EXCEPT on @cardinality: "one"
//       (#368: it then names which of several identity.reference nodes onto
//       the same target the relationship navigates).
//
// ADR-0039: resolving, not own-only (#368 fix round 3) — every rule above
// validates a property of the relationship's OWN declaration (its attrs,
// plus for rule (c) the @through target resolved against the root), so a
// relationship inherited via extends must be validated wherever it's
// visible, or a child entity that only SEES the relationship through
// inheritance could carry a violation no pass ever examines. That makes an
// inherited, UNMODIFIED relationship visited once per inheriting entity —
// checked once below (keyed on the relationship node's own identity), not
// once per entity, using the DECLARING entity (rel.parent) rather than
// whichever entity's effective view got there first for every piece of
// context a rule reads (message text, @through's package per ADR-0042, rule
// (a)'s self-join comparison). That keeps each check's result independent of
// which entity triggered it, which is what makes "checked once" both
// sufficient and correct. An override replaces the node in place
// (MetaData._effectiveChildren), so it is never the same object as what it
// overrides and is never skipped against it — a genuinely different
// declaration is always independently checked.
// ---------------------------------------------------------------------------

// The junction's reference view: the validator and the runtime/codegen FK
// derivation (deriveM2MFields) MUST agree on which references count. Both use
// the EFFECTIVE view (own + inherited via extends) via referenceIdentities(),
// so a junction defined through `extends` is treated identically here and at
// resolution time. (For a junction with no extends, effective == own.)
function _junctionReferences(junction: MetaData): MetaReferenceIdentity[] {
  return (junction as MetaObject).referenceIdentities();
}

/** FK field names declared by a junction's effective identity.reference children. */
function _junctionReferenceFkFields(junction: MetaData): string[] {
  const out: string[] = [];
  for (const ref of _junctionReferences(junction)) {
    const first = ref.fields[0];
    if (first) out.push(first);
  }
  return out;
}

function _countJunctionReferences(junction: MetaData): number {
  return _junctionReferences(junction).length;
}

export function validateRelationships(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  // #368 fix round 3 — the outer loop below is now resolving (obj.relationships()),
  // so a relationship inherited unmodified by N entities is reached N times. Its
  // own attrs never change based on who inherits it, so re-validating it more
  // than once would report the identical finding N times — pure noise. Checked
  // is keyed on the relationship NODE's own object identity: MetaData._effectiveChildren
  // reuses the super's child object in place for an unmodified inherited child,
  // so the same physical declaration IS the same object everywhere it's visible,
  // while an override replaces it with a genuinely different object (correctly
  // NOT skipped — a distinct declaration is a distinct finding).
  const checked = new Set<MetaData>();
  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    // ADR-0039: resolving — see the header comment above: rule (d) (like rule
    // (e)) must see a relationship inherited via extends, not just this
    // entity's own declarations. `checked` absorbs the resulting revisits.
    for (const rel of (obj as MetaObject).relationships()) {
      if (checked.has(rel)) continue;
      checked.add(rel);

      // Every rule below validates a property of the relationship's OWN
      // declaration (its attrs, plus for rule (c) the @through target), so
      // context — the entity name in messages, the package a bare @through
      // resolves in (ADR-0042), and rule (a)'s self-join comparison — is
      // always the entity that DECLARES `rel` (rel.parent), never `obj` (the
      // entity whose effective view happened to reach it first). This keeps
      // the check's result independent of iteration order/inheritance depth,
      // which is what makes checking each node exactly once correct.
      const declaringEntity = rel.parent ?? obj;
      const referrerPkg = declaringEntity.package ?? declaringEntity.fileDefaultPackage ?? "";

      // ADR-0039: resolving — a relationship may inherit its M:N attrs via extends.
      const through = rel.attr(RELATIONSHIP_ATTR_THROUGH);
      const sourceRefField = rel.attr(RELATIONSHIP_ATTR_SOURCE_REF_FIELD);
      const symmetric = rel.attr(RELATIONSHIP_ATTR_SYMMETRIC) === true;
      const cardinality = rel.attr(RELATIONSHIP_ATTR_CARDINALITY);
      const objectRef = rel.attr(RELATIONSHIP_ATTR_OBJECT_REF);

      const hasThrough = typeof through === "string" && through !== "";
      const hasSourceRefField = typeof sourceRefField === "string" && sourceRefField !== "";
      const isMany = cardinality === CARDINALITY_MANY;
      const isM2M = hasThrough && isMany;

      // NOTE: @objectRef existence resolution moved to the validation registry
      // (defaultValidationRegistry → a declarative reference descriptor). The M:N
      // slim-vocabulary rules below stay here for now (Phase 3 migrates them too).

      // Rule (d): M:N-only attrs on a non-M:N relationship.
      if (!isM2M) {
        if (hasThrough) {
          errors.push(
            new ParseError(
              `relationship "${declaringEntity.name}.${rel.name}" sets @${RELATIONSHIP_ATTR_THROUGH} but is not a M:N ` +
                `relationship (requires @${RELATIONSHIP_ATTR_CARDINALITY}: "${CARDINALITY_MANY}").`,
              { code: "ERR_INVALID_RELATIONSHIP", source: rel.source },
            ),
          );
        }
        // #368: @sourceRefField also disambiguates a `@cardinality: one`
        // relationship when the entity holds more than one identity.reference
        // onto the same target. Only the M:N *junction* reading is rejected
        // here; rule (e) — validateOneSideReferenceResolution, below in this
        // file — checks that it names a real local reference.
        if (hasSourceRefField && cardinality !== CARDINALITY_ONE) {
          errors.push(
            new ParseError(
              `relationship "${declaringEntity.name}.${rel.name}" sets @${RELATIONSHIP_ATTR_SOURCE_REF_FIELD} but is neither a M:N ` +
                `relationship (requires @${RELATIONSHIP_ATTR_THROUGH} with @${RELATIONSHIP_ATTR_CARDINALITY}: "${CARDINALITY_MANY}") ` +
                `nor a @${RELATIONSHIP_ATTR_CARDINALITY}: "${CARDINALITY_ONE}" relationship.`,
              { code: "ERR_INVALID_RELATIONSHIP", source: rel.source },
            ),
          );
        }
        if (symmetric) {
          errors.push(
            new ParseError(
              `relationship "${declaringEntity.name}.${rel.name}" sets @${RELATIONSHIP_ATTR_SYMMETRIC} but is not a M:N relationship.`,
              { code: "ERR_INVALID_RELATIONSHIP", source: rel.source },
            ),
          );
        }
        continue;
      }

      // Rule (b): @symmetric and @sourceRefField are mutually exclusive.
      if (symmetric && hasSourceRefField) {
        errors.push(
          new ParseError(
            `relationship "${declaringEntity.name}.${rel.name}" sets both @${RELATIONSHIP_ATTR_SYMMETRIC} and ` +
              `@${RELATIONSHIP_ATTR_SOURCE_REF_FIELD}; they are mutually exclusive.`,
            { code: "ERR_BAD_ATTR_VALUE", source: rel.source },
          ),
        );
      }

      // Rule (a): @symmetric is valid only on a self-join (@objectRef == declaring entity).
      // ADR-0042: resolve @objectRef and compare NODE IDENTITY — a bare "Widget"
      // in this package is self, but an FQN "other::Widget" (a different same-short-
      // name entity) is NOT (comparing stripped short names would misclassify it).
      const isSelfJoin =
        typeof objectRef === "string" &&
        resolveObjectRef(root, objectRef, referrerPkg).node === declaringEntity;
      if (symmetric && !isSelfJoin) {
        errors.push(
          new ParseError(
            `relationship "${declaringEntity.name}.${rel.name}" sets @${RELATIONSHIP_ATTR_SYMMETRIC} but @${RELATIONSHIP_ATTR_OBJECT_REF} ` +
              `"${String(objectRef)}" is not the declaring entity "${declaringEntity.name}"; @${RELATIONSHIP_ATTR_SYMMETRIC} is self-join-only.`,
            { code: "ERR_BAD_ATTR_VALUE", source: rel.source },
          ),
        );
      }

      // Rule (c): @through must name an entity declaring exactly two identity.reference children.
      const junction = _findObject(root, through as string, referrerPkg);
      if (!junction) {
        errors.push(
          new ParseError(
            `relationship "${declaringEntity.name}.${rel.name}" @${RELATIONSHIP_ATTR_THROUGH} "${through}" does not resolve to an entity.${didYouMeanHint(root, String(through))}`,
            { code: "ERR_INVALID_RELATIONSHIP", source: resolvedSource(rel.source, `${declaringEntity.fqn()}::${rel.name}`, String(through)) },
          ),
        );
        continue;
      }
      // A junction is a physical join table — it MUST be an object.entity. ADR-0046
      // lets a value carry navigation-only references, so value-purity no longer
      // implicitly guarantees a two-reference junction is an entity; assert it here.
      // (A value/projection has no table to join through.)
      if (junction.subType !== OBJECT_SUBTYPE_ENTITY) {
        errors.push(
          new ParseError(
            `relationship "${declaringEntity.name}.${rel.name}" @${RELATIONSHIP_ATTR_THROUGH} "${through}" resolves to ` +
              `${junction.type}.${junction.subType}, not an entity — a junction is a persisted join table ` +
              `and must be object.entity.`,
            { code: "ERR_INVALID_RELATIONSHIP", source: rel.source },
          ),
        );
        continue;
      }
      const refCount = _countJunctionReferences(junction);
      if (refCount !== 2) {
        errors.push(
          new ParseError(
            `relationship "${declaringEntity.name}.${rel.name}" @${RELATIONSHIP_ATTR_THROUGH} "${through}" must declare exactly two ` +
              `identity.reference children (one per FK side); found ${refCount}.`,
            { code: "ERR_INVALID_RELATIONSHIP", source: rel.source },
          ),
        );
        continue;
      }
      // @sourceRefField (if present) must match one of the junction's reference FK fields.
      if (hasSourceRefField) {
        const fkFields = _junctionReferenceFkFields(junction);
        if (!fkFields.includes(sourceRefField as string)) {
          errors.push(
            new ParseError(
              `relationship "${declaringEntity.name}.${rel.name}" @${RELATIONSHIP_ATTR_SOURCE_REF_FIELD} "${sourceRefField}" does not match ` +
                `any identity.reference FK field on junction "${through}". Available: ${fkFields.join(", ") || "(none)"}.`,
              { code: "ERR_INVALID_RELATIONSHIP", source: rel.source },
            ),
          );
        }
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Rule (e) — #368: a `@cardinality: one` relationship must resolve to exactly
// one identity.reference. Two references onto the same target are
// indistinguishable from the relationship's @objectRef alone, so the resolver
// would silently emit the first one's FK column. ADR-0029 §5: a second path
// is a load error naming the candidates.
//
// Registered alongside validateRelationships (the M:N slim-vocabulary pass,
// above) — same deferred-resolution timing (after all files load + extends
// resolution).
//
// Scope differs deliberately from rule (d) — in SUBJECT, not in which
// relationships each pass walks (both walk the EFFECTIVE set; rule (d) is
// no longer own-scoped, or an M:N declaration reached only via extends
// would go unchecked). Rule (d) validates attrs that travel with the
// relationship's OWN declaration (@through/@symmetric/@sourceRefField), so
// it checks each declaration EXACTLY ONCE — deduped by node identity, and
// reported against the entity that declares it — because those attrs don't
// change meaning depending on who inherits the relationship. Rule (e)
// instead validates whether THIS entity's reference set resolves the
// relationship uniquely, which is a property of the EFFECTIVE entity, not of
// wherever the relationship happens to be declared. A child entity that
// extends a clean parent and adds a second identity.reference onto the same
// target makes an INHERITED relationship ambiguous on the child even though
// the parent (and the relationship's own declaration) are untouched — own-
// scoping this pass would leave that case unchecked, and codegen/runtime
// (which resolve against the effective entity) would silently drop the
// relation (#368 fix round 2). If a parent and a child are both genuinely
// ambiguous, both are reported — two entities are broken, not one error
// duplicated.
// ---------------------------------------------------------------------------

export function validateOneSideReferenceResolution(root: MetaRoot): ParseError[] {
  const errors: ParseError[] = [];
  for (const obj of root.objects()) {
    // ADR-0039: resolving — see the scope note above: rule (e) checks THIS
    // entity's effective reference set against every relationship it can see,
    // including one only inherited via extends.
    for (const rel of obj.relationships()) {
      // ADR-0039: resolving — @cardinality/@objectRef may be inherited via extends.
      if (rel.attr(RELATIONSHIP_ATTR_CARDINALITY) !== CARDINALITY_ONE) continue;
      const objectRef = rel.attr(RELATIONSHIP_ATTR_OBJECT_REF);
      if (typeof objectRef !== "string" || objectRef === "") continue;

      // ADR-0059 R7: match references by the bound target node. An unresolved
      // @objectRef is reported by its own pass.
      const targetNode = refTarget(rel, RELATIONSHIP_ATTR_OBJECT_REF);
      if (targetNode === undefined) continue;
      const candidates = referenceCandidatesFor(obj, targetNode);

      const sourceRefField = rel.attr(RELATIONSHIP_ATTR_SOURCE_REF_FIELD);
      const declared = typeof sourceRefField === "string" && sourceRefField !== ""
        ? sourceRefField
        : undefined;

      if (declared !== undefined) {
        // A declared @sourceRefField short-circuits the ladder at ANY
        // candidate count — checked independently of resolveRelationshipReference,
        // whose step 1 ("exactly one candidate -> that one") would otherwise
        // silently return the lone candidate even when it disagrees with the
        // declared field. The author named a specific FK; it must exist,
        // whether there are zero, one, or many candidates.
        const matchesDeclared = candidates.some((c) => c.fields[0] === declared);
        if (matchesDeclared) continue;
        errors.push(
          new ParseError(
            `relationship "${obj.name}.${rel.name}" sets @${RELATIONSHIP_ATTR_SOURCE_REF_FIELD} ` +
              `"${declared}", which names no identity.reference targeting "${objectRef}". ` +
              `Candidates: ${formatReferenceCandidates(candidates)}.`,
            { code: "ERR_INVALID_RELATIONSHIP", source: rel.source },
          ),
        );
        continue;
      }

      // No @sourceRefField declared: ambiguity only exists with 2+ candidates —
      // resolveRelationshipReference's name-pairing step (ladder step 3) decides.
      if (candidates.length <= 1) continue;
      const resolved = resolveRelationshipReference(obj, rel.name, targetNode);
      if (resolved) continue;

      errors.push(
        new ParseError(
          `relationship "${obj.name}.${rel.name}" is ambiguous: "${obj.name}" declares ` +
            `${candidates.length} identity.reference nodes targeting "${objectRef}" and the ` +
            `relationship name does not pair with exactly one. Candidates: ${formatReferenceCandidates(candidates)}. ` +
            `Set @${RELATIONSHIP_ATTR_SOURCE_REF_FIELD} to the FK field this relationship navigates.`,
          { code: "ERR_INVALID_RELATIONSHIP", source: rel.source },
        ),
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Rule (f) — a M:N junction must PAIR: one identity.reference resolving to the
// navigating entity, one to the @objectRef target.
//
// Rule (d) already checks that the junction declares exactly TWO references. It
// never checked WHAT they point at, so a junction whose two references name some
// other pair of entities loaded perfectly clean and then failed — differently —
// in every port's codegen: TypeScript and C# warned and emitted no traversal
// route (the endpoint simply 404s, with nothing in the build output a CI gate
// would fail on), while Java, Kotlin and Python threw and failed the build. One
// input, five contracts, and the quiet arm is the dangerous one.
//
// The check belongs HERE because the model is what is wrong, and because a
// loader error is the only answer every port already agrees on. Both codegen
// branches become unreachable for a model that loaded.
//
// It runs the REAL derivation (deriveM2MFields) rather than reimplementing the
// pairing, so the loader and the FK derivation cannot drift apart — the same
// reason _junctionReferences above shares referenceIdentities() with codegen. A
// parallel check would be a second opinion, and the defect class being closed
// here is precisely "two parts of the pipeline disagree".
//
// SCOPE mirrors codegen's own iteration exactly (relation-resolver.ts): every
// CONCRETE, non-projection object crossed with its EFFECTIVE relationships.
// That is not incidental —
//   * per (entity, relationship), NOT deduped by declaration like rule (d):
//     pairing is a property of the NAVIGATING entity. deriveM2MFields accepts a
//     junction reference naming either the declaring entity or the navigating
//     one, so an inherited M:N can pair from one subtype and not another, and
//     checking the declaration alone would both miss that and reject models
//     codegen accepts.
//   * abstract levels are skipped because their own declarations do not file —
//     an abstract base's FK reaches a table only through a concrete descendant,
//     whose own walk reaches this same relationship.
//   * projections are skipped because they never emit a relations() block.
// Widening past that set would fail builds codegen never had a problem with.
// ---------------------------------------------------------------------------

/** codegen-ts's isProjection, reproduced here: that module is not reachable from
 * the loader, and the two source guards it is built from live in this package.
 * ADR-0039: own — projection-ness is the entity's OWN declared source @kind. */
function isProjectionObject(obj: MetaObject): boolean {
  const own = obj.ownChildren();
  return own.some(isReadOnlySource) && !own.some(isWritableSource);
}

export function validateM2MJunctionPairing(root: MetaRoot): ParseError[] {
  const errors: ParseError[] = [];
  for (const obj of root.objects()) {
    if (obj.isAbstract === true) continue;
    if (isProjectionObject(obj)) continue;
    // ADR-0039: resolving — an M:N relationship may be reached only via extends.
    for (const rel of obj.relationships()) {
      if (rel.attr(RELATIONSHIP_ATTR_CARDINALITY) !== CARDINALITY_MANY) continue;
      if (rel.attr(RELATIONSHIP_ATTR_THROUGH) === undefined) continue;
      try {
        deriveM2MFields(rel, obj, root);
      } catch (err) {
        if (!(err instanceof M2MDerivationError)) throw err;
        // Rule (d) reports the malformed-junction cases it owns (missing
        // @through, unresolvable @through, a reference count other than two, an
        // @sourceRefField matching no FK) against the DECLARING entity, and the
        // derivation re-checks them. Reporting them again here — once per
        // concrete subtype — would bury the pairing finding under duplicates of
        // a diagnosis the author already has, so those are left to rule (d) and
        // this rule speaks only where it is the sole witness.
        if (isJunctionShapeErrorOwnedByRuleD(rel, root)) continue;
        errors.push(
          new ParseError(
            `relationship "${obj.name}.${rel.name}" cannot be resolved through its ` +
              `@${RELATIONSHIP_ATTR_THROUGH} junction: ${err.message}. Without a reference to ` +
              `"${obj.name}" the junction rows cannot be filtered to this entity, so no ` +
              `traversal is derivable.`,
            { code: "ERR_INVALID_RELATIONSHIP", source: rel.source },
          ),
        );
      }
    }
  }
  return errors;
}

/**
 * True when the derivation's failure is one rule (d) already reports — a
 * junction that is missing, unresolvable, or does not declare exactly two
 * identity.reference children. Keyed on the SHAPE rather than on the message
 * text: matching strings would make this silently stop de-duplicating the first
 * time a message is reworded, and a gate keyed to prose breaks on the rewrite.
 */
function isJunctionShapeErrorOwnedByRuleD(rel: MetaRelationship, root: MetaRoot): boolean {
  const through = rel.attr(RELATIONSHIP_ATTR_THROUGH);
  if (typeof through !== "string" || through === "") return true;
  // Resolve exactly as rule (d) and deriveM2MFields do — ADR-0042 via the single
  // resolveObjectRef matcher, referred from the DECLARING entity's package. A
  // second resolution rule here is what made this helper disagree with the
  // derivation and emit rule (d)'s finding a second time.
  const declaring = rel.parent;
  const referrerPkg = declaring?.package ?? declaring?.fileDefaultPackage ?? "";
  const junction = _findObject(root, through, referrerPkg) as MetaObject | undefined;
  if (junction === undefined) return true;
  if (junction.subType !== OBJECT_SUBTYPE_ENTITY) return true;
  if (_countJunctionReferences(junction) !== 2) return true;
  const sourceRefField = rel.attr(RELATIONSHIP_ATTR_SOURCE_REF_FIELD);
  if (typeof sourceRefField === "string" && sourceRefField !== "") {
    if (!_junctionReferenceFkFields(junction).includes(sourceRefField)) return true;
  }
  return false;
}

/**
 * Render a candidate reference as `name(fkField)`, or `name(fieldA, fieldB)`
 * for a composite reference — so two composite references sharing a first
 * column (e.g. both starting `tenantId`) still print distinguishably.
 *
 * NOTE: this is display only. Matching (both here and in
 * resolveRelationshipReference) still keys on `fields[0]` alone — a
 * composite reference cannot actually be disambiguated by @sourceRefField.
 * That's a documented limitation, not fixed by this rendering change.
 */
function formatReferenceCandidates(candidates: readonly MetaReferenceIdentity[]): string {
  return candidates.map((c) => `${c.name}(${c.fields.join(", ")})`).join(", ");
}

// NOTE: identity.reference @references resolution moved to the validation registry
// (defaultValidationRegistry → a declarative reference descriptor with dottedFieldPath).

// ---------------------------------------------------------------------------
// Index-key resolution for index.lookup AND identity.secondary (#342)
//
// An index declares its key EXACTLY ONE of two ways: plain columns (@fields) or
// a key expression (@expr, e.g. `lower(email)` / `(payload->>'device_id')`).
// The registry has always said so — @expr is described as "Used INSTEAD of
// @fields" — and `migrate-ts` has always implemented it that way
// (`columns: expr ? [] : cols`, expected-schema.ts). Only the LOADER disagreed,
// requiring @fields unconditionally, which made an expression index
// unreachable: omitting @fields failed to load, and the one spelling that DID
// load (@fields AND @expr) had its @fields silently discarded by the engine.
//
// So the two rules below are one rule — the key is @fields XOR @expr:
//   - NEITHER: nothing declares the key.
//   - BOTH: contradictory, and previously half-honored. Rejected rather than
//     given a precedence rule, because an accepted-but-half-ignored declaration
//     is exactly the silent-wrong-output the sealed strict registry exists to
//     prevent (cf. ERR_SQL_BODY_WITH_UNMANAGED — @sql vs @unmanaged is the same
//     "two mutually exclusive non-default states of one axis" shape).
//
// Applies to identity.secondary too: per ADR-0040 uniqueness lives in the TYPE,
// so identity.secondary IS a unique index and keys itself identically. Both
// carry @expr from the same db provider, and migrate-ts branches on @expr for
// both — the loader was the only tier treating them differently.
//
// ADR-0039: children() / MetaIndex.fields() — never own* — so a field inherited
// via extends still resolves.
// ---------------------------------------------------------------------------

export function validateIndexLookupFields(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    // Effective (resolved) field names — includes inherited fields via extends.
    const effectiveFieldNames = new Set(
      obj.children().filter((c) => c.type === TYPE_FIELD).map((f) => f.name),
    );
    const keyed = obj.children().filter(
      (c) =>
        (c.type === TYPE_INDEX && c.subType === INDEX_SUBTYPE_LOOKUP) ||
        (c.type === TYPE_IDENTITY && c.subType === IDENTITY_SUBTYPE_SECONDARY),
    );
    for (const node of keyed) {
      const label = `${node.type}.${node.subType}`;
      // PRESENCE vs CONTENT are two different questions here, and conflating them
      // is a bug in both directions:
      //
      //   - The CONTRADICTION check needs PRESENCE. `@fields: []` alongside @expr
      //     is still a declaration of both, and keying it on non-emptiness let the
      //     total-discard spelling load clean while `@fields: ["x"]` + @expr was
      //     refused — the rule missing exactly the case it exists to catch.
      //   - The KEY-RESOLUTION check needs normalized CONTENT, via the guarded
      //     accessor. Reading the raw attr with a cast meant a scalar `@fields: 5`
      //     threw an uncaught TypeError out of load() in TS while the other three
      //     ports reported a clean error.
      //
      // The guarded accessor is the fix for the second and the OBSTACLE for the
      // first — it collapses absent, scalar and explicit `[]` to the same `[]` —
      // so the two questions are asked separately and never routed through one
      // predicate. ADR-0039: both reads resolve through extends.
      const hasFieldsAttr = node.attr(IDENTITY_ATTR_FIELDS) !== undefined;
      // MetaIndex.fields() / MetaIdentity.fields are the same guarded read
      // (`Array.isArray(f) ? f : []`); never re-hand-roll it.
      const fields =
        node instanceof MetaIndex ? node.fields() : (node as MetaIdentity).fields;
      const exprRaw = node.attr(IDENTITY_ATTR_EXPR);
      const hasExpr = typeof exprRaw === "string" && exprRaw.trim().length > 0;

      // Rule 1a: exactly one of @fields / @expr may be DECLARED.
      //
      // The closing sentence comes from `attr-contradictions.ts`, which is also what
      // `meta upgrade` rewrites from — so the fix an adopter is TOLD about and the edit
      // the tool MAKES are one statement, and a change to either moves both. #337 is the
      // reason it names the command at all: an adopter shown only that their metadata is
      // invalid concludes the tool has a bug, because nothing points at the way out.
      if (hasFieldsAttr && hasExpr) {
        const contradiction = contradictionsFor(label).find(
          (c) => c.drop === INDEX_ATTR_FIELDS && c.keep === IDENTITY_ATTR_EXPR,
        );
        errors.push(
          new ParseError(
            // The site states WHICH node broke the rule; the table states the RULE and the
            // fix. Splitting it that way is what keeps one copy of each.
            `${label} "${node.name}" on "${obj.name}" declares BOTH ` +
              `@${INDEX_ATTR_FIELDS} and @${IDENTITY_ATTR_EXPR}: ` +
              (contradiction === undefined
                ? `@${IDENTITY_ATTR_EXPR} is used INSTEAD of @${INDEX_ATTR_FIELDS} — drop one.`
                : contradictionHint(contradiction)),
            { code: "ERR_INVALID_INDEX", source: node.source },
          ),
        );
        continue;
      }

      // Rule 1b: whichever is declared must actually supply a key.
      if (fields.length === 0 && !hasExpr) {
        errors.push(
          new ParseError(
            `${label} "${node.name}" on "${obj.name}" declares no key: ` +
              `it must have @${INDEX_ATTR_FIELDS} (one or more columns) or ` +
              `@${IDENTITY_ATTR_EXPR} (a key expression)`,
            { code: "ERR_INVALID_INDEX", source: node.source },
          ),
        );
        continue;
      }
      // Rule 2: every named field must resolve against the entity's effective field set.
      // An expression index has no @fields to resolve — @expr is raw SQL over the
      // physical columns, deliberately not parsed here (ADR-0023 keeps the grammar
      // closed only where the loader owns it).
      for (const fieldName of fields) {
        if (!effectiveFieldNames.has(fieldName)) {
          errors.push(
            new ParseError(
              `${label} "${node.name}" on "${obj.name}" references field "${fieldName}" ` +
                `which does not exist on "${obj.name}". ` +
                `Available fields: ${[...effectiveFieldNames].join(", ") || "(none)"}`,
              { code: "ERR_INVALID_INDEX", source: node.source },
            ),
          );
        }
      }
    }
  }
  return errors;
}

function checkFilterClauses(
  filter: Record<string, unknown>,
  allow: Map<string, readonly string[]>,
  entityName: string,
  layoutName: string,
  layoutSource: ErrorSource,
  errors: ParseError[],
): void {
  for (const [key, clause] of Object.entries(filter)) {
    if (key === FILTER_COMPOSE_OR || key === FILTER_COMPOSE_AND) {
      if (Array.isArray(clause)) {
        for (const sub of clause) {
          if (typeof sub === "object" && sub !== null && !Array.isArray(sub)) {
            checkFilterClauses(sub as Record<string, unknown>, allow, entityName, layoutName, layoutSource, errors);
          }
        }
      }
      continue;
    }
    const allowedOps = allow.get(key);
    if (allowedOps === undefined) {
      errors.push(
        new ParseError(
          `dataGrid layout "${layoutName}" on entity "${entityName}" has @filter over ` +
            `non-filterable field "${key}". Filterable fields: ${[...allow.keys()].join(", ") || "(none)"}`,
          { code: "ERR_BAD_ATTR_FILTER", source: layoutSource },
        ),
      );
      continue;
    }
    // After parse-time desugaring (FilterAttr.desugar), every non-composition field clause
    // is canonical { op: value } — a bare scalar should not reach here; the object guard is defensive.
    if (typeof clause === "object" && clause !== null && !Array.isArray(clause)) {
      for (const op of Object.keys(clause)) {
        if (!allowedOps.includes(op)) {
          errors.push(
            new ParseError(
              `dataGrid layout "${layoutName}" on entity "${entityName}" @filter uses disallowed ` +
                `op "${key}.${op}". Allowed ops for "${key}": ${allowedOps.join(", ")}`,
              { code: "ERR_BAD_ATTR_FILTER", source: layoutSource },
            ),
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// #207 — projection row-scope @filter (view-level WHERE) reference validation
//
// A projection's @filter (a portable attr.filter object) scopes which rows the
// derived view returns. Its field refs must name the projection's OWN declared
// fields, and each must be ADDRESSABLE in a WHERE:
//   - a plain (extends-bound / no-origin) or origin.passthrough or origin.computed
//     field → addressable (a base/joined column, or an inlined row-level expression).
//   - an aggregate-derived field (origin.aggregate — count/sum/…/any/all/collect —
//     or origin.first) → NOT addressable: a WHERE runs before
//     aggregation, so it cannot see an aggregate (post-aggregate filtering is HAVING,
//     a separate later extension). Fail-closed → ERR_BAD_ATTR_FILTER.
//   - a ref naming no declared field → dangling → ERR_BAD_ATTR_FILTER.
//
// Own-attrs only: the @filter is declared locally, and is registered on
// object.projection alone — a write-through entity read-view (object.entity,
// isWriteThrough) can never carry one, so filtered replicas (which would break
// read-your-writes totality) are excluded by construction (v1 scope).
// ---------------------------------------------------------------------------

/** A projection field addressable by a @filter: its aggregate-derived-ness + its
 *  op-band (by declared subType). Mirrors the dataGrid allowlist shape. */
interface ProjectionFilterField {
  readonly derived: boolean;
  readonly ops: readonly string[];
  /** The path already failed to resolve, and said why. */
  readonly reported?: boolean;
}

/**
 * An entity field a projection @filter reaches (on the base, or through a path) cannot be
 * filtered when it is an aggregate: a WHERE runs before any grouping. Its own stored column, an
 * origin.computed or an origin.first (a correlated scalar subquery) are WHERE-legal (entity-derived).
 */
function entityFieldAggregates(f: MetaData): boolean {
  // ADR-0039: own — origin.* never inherits (ADR-0029).
  const origin = f.ownChildren().find((c) => c.type === TYPE_ORIGIN);
  return origin !== undefined && origin.subType === ORIGIN_SUBTYPE_AGGREGATE;
}

/** Every field key of a (desugared) filter, through and/or. */
function filterKeys(filter: unknown, out: string[] = []): string[] {
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) return out;
  for (const [key, val] of Object.entries(filter as Record<string, unknown>)) {
    if (key === FILTER_COMPOSE_AND || key === FILTER_COMPOSE_OR) {
      if (Array.isArray(val)) for (const sub of val) filterKeys(sub, out);
    } else out.push(key);
  }
  return out;
}

export function validateProjectionFilter(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root
    .children()
    .filter((c) => c.type === TYPE_OBJECT && c.subType === OBJECT_SUBTYPE_PROJECTION)) {
    // The EFFECTIVE @filter — every level of an extends chain, supers first, ANDed — is
    // what the view applies, so it is what is checked (an inherited gate is checked against
    // the extender's fields too).
    const filter = effectiveProjectionFilter(obj);
    // Non-object shapes are rejected by the attr schema check (FilterAttr.validateValue).
    if (typeof filter !== "object" || filter === null || Array.isArray(filter)) continue;

    // Classify the projection's EFFECTIVE fields (the declared set IS the exposure —
    // FR-024/ADR-0028): aggregate-derived-ness + the op-band legal for the field's
    // declared subType. ADR-0039: resolving — a field inherited from a super projection is
    // a column of this view and carries its own origin child, read own below.
    const fields = new Map<string, ProjectionFilterField>();
    for (const f of obj.children().filter((c) => c.type === TYPE_FIELD)) {
      const origin = f.ownChildren().find((c) => c.type === TYPE_ORIGIN);
      const derived =
        origin !== undefined &&
        origin.subType !== ORIGIN_SUBTYPE_PASSTHROUGH &&
        origin.subType !== ORIGIN_SUBTYPE_COMPUTED;
      // opsForField, not opsForSubType — an int-backed field.enum (@intValueMap)
      // stores as an integer, so `like` is not in its band.
      fields.set(f.name, { derived, ops: opsForField(f) });
    }
    // A field of the BASE entity the view does not output is filterable too (a WHERE reads
    // the base row); a projection field of the same name wins. No base, no fallback: the
    // origin passes report why one cannot be derived.
    const base = _deriveBaseEntity(obj, root, "@filter", obj.source, []);
    if (base !== undefined && base !== obj) {
      for (const f of base.children().filter((c) => c.type === TYPE_FIELD)) {
        if (!fields.has(f.name)) fields.set(f.name, { derived: entityFieldAggregates(f), ops: opsForField(f) });
      }
      // A key that is a PATH of to-one hops from the base, then a
      // field of the entity reached (`caseId.status`). Not output; the view joins what it walks.
      for (const key of filterKeys(filter)) {
        if (fields.has(key)) continue;
        const path = resolveFilterPath(base as MetaObject, key);
        if (path === undefined) continue;
        if (typeof path === "string") {
          errors.push(new ParseError(
            `projection "${obj.name}" @filter path "${key}" does not resolve: ${path}.`,
            { code: "ERR_BAD_ATTR_FILTER", source: obj.source },
          ));
          fields.set(key, { derived: false, ops: [], reported: true });
          continue;
        }
        fields.set(key, { derived: entityFieldAggregates(path.field), ops: opsForField(path.field) });
      }
    }
    checkProjectionFilterRefs(filter as Record<string, unknown>, fields, obj.name, obj.source, errors);
  }
  return errors;
}

// Validates a projection @filter fail-closed at load — mirrors the dataGrid sibling
// checkFilterClauses (which validates both field refs AND ops). A malformation that
// slips through here lowers to a silently-wrong or no WHERE, or crashes `meta migrate`
// / emits invalid CREATE VIEW SQL, so every branch that isn't a valid clause errors.
function checkProjectionFilterRefs(
  filter: Record<string, unknown>,
  fields: ReadonlyMap<string, ProjectionFilterField>,
  projectionName: string,
  source: ErrorSource,
  errors: ParseError[],
): void {
  const err = (message: string): void => {
    errors.push(new ParseError(message, { code: "ERR_BAD_ATTR_FILTER", source }));
  };
  for (const [key, clause] of Object.entries(filter)) {
    if (key === FILTER_COMPOSE_OR || key === FILTER_COMPOSE_AND) {
      // Fail-closed: a compose key MUST hold an ARRAY of sub-clause objects. A non-array
      // (a common object-vs-array authoring slip, e.g. `and: { … }`) would otherwise
      // collapse to no WHERE at lowering — a soft-delete filter silently returning every
      // row. Reject it, and any non-object element, here.
      if (!Array.isArray(clause)) {
        err(`projection "${projectionName}" @filter "${key}" must be an array of sub-clauses.`);
        continue;
      }
      for (const sub of clause) {
        if (typeof sub === "object" && sub !== null && !Array.isArray(sub)) {
          checkProjectionFilterRefs(sub as Record<string, unknown>, fields, projectionName, source, errors);
        } else {
          err(`projection "${projectionName}" @filter "${key}" contains a non-object sub-clause.`);
        }
      }
      continue;
    }
    const field = fields.get(key);
    if (field?.reported === true) continue;
    if (field === undefined) {
      err(
        `projection "${projectionName}" @filter references "${key}", which is not a declared field of the ` +
          `projection or of its base entity. A view-level @filter may only reference those fields.`,
      );
      continue;
    }
    if (field.derived) {
      err(
        `projection "${projectionName}" @filter references "${key}", an aggregate-derived field. A view-level ` +
          `WHERE runs before aggregation, so it cannot filter on an aggregate (post-aggregate filtering is a ` +
          `separate HAVING extension). Filter on a passthrough or computed field instead.`,
      );
      continue;
    }
    // After parse-time desugaring (FilterAttr.desugar) every field clause is a canonical
    // { op: value } object; a non-object or empty op-set would silently drop the predicate.
    if (typeof clause !== "object" || clause === null || Array.isArray(clause)) {
      err(`projection "${projectionName}" @filter on "${key}" must be an { op: value } object.`);
      continue;
    }
    const ops = Object.keys(clause as Record<string, unknown>);
    if (ops.length === 0) {
      err(`projection "${projectionName}" @filter on "${key}" declares no operator.`);
      continue;
    }
    // Every op must be legal for the field's subType — an unknown op (e.g. a typo
    // `contains`) or a subtype-illegal op (e.g. `like` on a boolean) would otherwise
    // crash the view synthesizer or emit invalid SQL at CREATE VIEW.
    for (const op of ops) {
      if (!field.ops.includes(op)) {
        err(
          `projection "${projectionName}" @filter on "${key}" uses op "${op}", which is not allowed for its ` +
            `type. Allowed ops: ${field.ops.join(", ") || "(none)"}.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// FR-039 — a retired requirement's link vocabulary
//
// Two rules, and the first is the whole structural point of the FR.
//
//   1. `@status: retired` may NOT carry `@implementedBy`. Not exempt from the
//      dangling-reference check — REFUSED. 0.24.0 removed the previous retired
//      vocabulary because `verify` was SILENT on dangling refs for it, hiding 29
//      unresolvable references across 14 entries in one estate while reporting
//      zero. That silence was a deliberate EXEMPTION, so the fix was diagnosed as
//      "delete the vocabulary". Forbidding the attribute makes the bug class
//      UNREACHABLE instead: a retired capability has no implementation by
//      definition, so its references cannot dangle because they cannot exist.
//
//   2. `@supersededBy` is legal ONLY on `retired`. It names what REPLACED a
//      withdrawn capability; on a live one there is nothing to have replaced it.
//      Resolution of the reference itself is `verify`'s job (it owns every other
//      @implementedBy-style resolution) — the loader owns the shape.
//
// Runs in every port. The requirement gate runs in every port's `verify` since
// ADR-0057 (when this rule was written it ran only in the TS CLI), yet the rule
// stays in the loader: a shape the loader refuses is unreachable in every port
// and in every program that loads the model, whether or not anyone runs `verify`.
//
// ADR-0039: children()/attr() throughout — never own* — so a requirement that
// inherits its status through `extends` is judged on its EFFECTIVE status.
// ---------------------------------------------------------------------------

export function validateRetiredRequirementLinks(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];

  const walk = (node: MetaData): void => {
    for (const child of node.children()) {
      if (child.type === REQUIREMENT) {
        const status = child.attr(REQUIREMENT_ATTR_STATUS);
        const isRetired = status === REQUIREMENT_STATUS_RETIRED;

        if (isRetired && child.attr(REQUIREMENT_ATTR_IMPLEMENTED_BY) !== undefined) {
          errors.push(
            new ParseError(
              `requirement.${child.subType} "${child.name}" is @status: ` +
                `${REQUIREMENT_STATUS_RETIRED} and declares @${REQUIREMENT_ATTR_IMPLEMENTED_BY}. ` +
                `A retired capability has no implementation — that is what retiring it means. ` +
                `Delete the attribute; if the nodes are still there, the capability is not retired. ` +
                `What used to implement it belongs in \`notes\`, and what REPLACED it in ` +
                `@${REQUIREMENT_ATTR_SUPERSEDED_BY}.`,
              { code: "ERR_REQUIREMENT_RETIRED_HAS_IMPLEMENTORS", source: child.source },
            ),
          );
        }

        if (!isRetired && child.attr(REQUIREMENT_ATTR_SUPERSEDED_BY) !== undefined) {
          errors.push(
            new ParseError(
              `requirement.${child.subType} "${child.name}" declares ` +
                `@${REQUIREMENT_ATTR_SUPERSEDED_BY} but its @${REQUIREMENT_ATTR_STATUS} is ` +
                `"${status ?? "(absent)"}". That attribute names the requirement which REPLACED a ` +
                `withdrawn one, so it is legal only on @${REQUIREMENT_ATTR_STATUS}: ` +
                `${REQUIREMENT_STATUS_RETIRED}.`,
              { code: "ERR_REQUIREMENT_SUPERSEDED_BY_NOT_RETIRED", source: child.source },
            ),
          );
        }
      }
      // Hierarchy IS nesting, so a retired requirement can sit at any depth.
      walk(child);
    }
  };

  walk(root);
  return errors;
}

// ---------------------------------------------------------------------------
// Physical column-name collisions
//
// Two fields of one stored object that resolve to the SAME physical column
// (`userId` + `userID` both snake_case to `user_id`; or two fields sharing an
// explicit @column) silently produce a duplicate column. Only the RESOLVED name
// is compared, through the single door `resolveColumnName`, so an explicit @column
// override, an inherited field and the project's column strategy are all honoured.
// Scope: a concrete object that declares at least one source (a source-less
// object generates nothing); derived fields (origin.*) are not columns of this table
// and are skipped. A `field.object @storage "flattened"` has no column of its own: each
// member of its value object is a column, named by `resolveFlattenedColumnName` exactly
// as migrate creates it, so two embeddings with one `@flattenedColumnPrefix` (or a `""`
// prefix beside a field of the member's name) collide here. Any other field.object is
// one jsonb column under its own resolved name.
// ADR-0039: effective fields, so an inherited field collides like an own one.
// Exempt: an object whose every source is read-only and at least one is a
// `source.rdb @kind: view` with an `@sql` body. The author's SQL defines that view's
// columns and the fields only READ them, so two fields on one column create no
// duplicate column and nothing can be written. A derived view (no `@sql`) emits a
// select list from its fields, and an object with a writable source has a real table
// whose columns MetaObjects creates; both stay checked.
// ---------------------------------------------------------------------------

function readsThroughSqlView(obj: MetaData): boolean {
  const sources = obj.children().filter((c): c is MetaSource => c instanceof MetaSource);
  return (
    sources.every((s) => s.isReadOnly()) &&
    sources.some((s) => s.effectiveKind === SOURCE_KIND_VIEW && s.sqlBody !== undefined)
  );
}

function hasExplicitColumn(field: MetaData): boolean {
  const col = field.attr(FIELD_ATTR_COLUMN);
  return typeof col === "string" && col !== "";
}

/** One physical column a field contributes to its object's table. */
interface PhysicalColumn {
  readonly column: string;
  /** `street`, or `shipTo.street` for a member of a flattened value object. */
  readonly label: string;
  /** The field that names it: the field itself, or the flattened value object's member. */
  readonly named: MetaData;
  /** Set for a flattened member: the embedding field.object. */
  readonly embedding?: MetaData;
}

function physicalColumnsOf(field: MetaData): PhysicalColumn[] {
  // ADR-0039: resolving — @storage and @objectRef may be inherited via extends.
  if (field.subType === FIELD_SUBTYPE_OBJECT && field.attr(FIELD_ATTR_STORAGE) === STORAGE_FLATTENED) {
    const target = refTarget(field, FIELD_ATTR_OBJECT_REF);
    if (target === undefined || !isMetaObject(target)) return [];
    // Every member, as migrate's flattenObjectField expands it.
    return target.fields().map((member) => ({
      column: resolveFlattenedColumnName(field, member),
      label: `${field.name}.${member.name}`,
      named: member,
      embedding: field,
    }));
  }
  return [{ column: resolveColumnName(field), label: field.name, named: field }];
}

function collisionHint(a: PhysicalColumn, b: PhysicalColumn): string {
  if (a.embedding !== undefined || b.embedding !== undefined) {
    return "Give one flattened field a different @flattenedColumnPrefix, or rename one field.";
  }
  return hasExplicitColumn(a.named) && hasExplicitColumn(b.named)
    ? "Rename one field, or point one @column at a different column."
    : "Rename one field, or give one an explicit @column so the two columns differ.";
}

export function validateColumnNameCollisions(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    if (obj.isAbstract) continue;
    if (!obj.children().some((c) => c.type === TYPE_SOURCE)) continue;
    if (readsThroughSqlView(obj)) continue;
    const seen = new Map<string, PhysicalColumn>();
    for (const field of obj.children()) {
      if (!isMetaField(field) || field.isDerived()) continue;
      for (const col of physicalColumnsOf(field)) {
        const first = seen.get(col.column);
        if (first === undefined) {
          seen.set(col.column, col);
          continue;
        }
        errors.push(
          new ParseError(
            `fields "${first.label}" and "${col.label}" on "${obj.name}" both resolve to physical column ` +
              `"${col.column}". ` +
              collisionHint(first, col),
            { code: "ERR_COLUMN_NAME_COLLISION", source: field.source },
          ),
        );
      }
    }
  }
  return errors;
}
