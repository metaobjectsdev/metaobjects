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

import type { MetaData } from "../shared/meta-data.js";
import type { MetaObject } from "../core/object/meta-object.js";
import type { MetaReferenceIdentity } from "../core/identity/meta-identity.js";
import { ParseError } from "../errors.js";
import { resolveObjectRef, didYouMeanHint } from "../naming-refs.js";
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
import { IDENTITY_SUBTYPE_SECONDARY } from "../core/identity/identity-constants.js";
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
  OBJECT_PROJECTION_ATTR_FILTER,
} from "../core/object/object-constants.js";
import { MetaSource } from "../persistence/source/meta-source.js";
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
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_MAP,
  FIELD_ATTR_REQUIRED,
  FIELD_ATTR_VALUE_TYPE,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_UUID,
} from "../core/field/field-constants.js";
import { FIELD_ATTR_DB_INDEXED, IDENTITY_ATTR_EXPR } from "../persistence/db/db-constants.js";
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
  AGG_ANY,
  AGG_ALL,
  AGG_COLLECT,
  ASSEMBLY_ORIGIN_SUBTYPES,
} from "../persistence/origin/origin-constants.js";
import {
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
import { stripPackage } from "../naming.js";
import {
  FILTER_COMPOSE_OR,
  FILTER_COMPOSE_AND,
  opsForSubType,
  opsForField,
} from "../core/query/query-constants.js";

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
  const sourceField = _findField(sourceObj, targetFieldName);
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

/** A fully-walked `@via` path: the relationship hop nodes in path order, and
 *  the TERMINAL entity reached after the last hop. Both fall out of one walk,
 *  so they are returned together — recovering the terminal with a second walk
 *  means maintaining a second copy of the ADR-0042 package-resolution rule.
 *  Shape mirrors `_validateFromPath`'s `ResolvedFromTarget`, which returns a
 *  pair for the same reason. */
interface WalkedViaPath {
  hops: MetaData[];
  terminal: MetaData;
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
  for (const relName of relSegments) {
    // FR-024: a hop may name a relationship OR a reference-only FK
    // (identity.reference) — the reference IS a navigable many-to-one edge.
    const rel = _findRelationship(currentObj, relName) ?? _findReference(currentObj, relName);
    if (!rel) {
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
  return { hops, terminal: currentObj };
}

// ---------------------------------------------------------------------------
// FR-024 B5 — base-entity derivation, single-hop-unique @via inference, and
// origin cardinality checks (spec §5–§6; ADR-0029 decisions 5–6).
// ---------------------------------------------------------------------------

/** A hop's effective @cardinality, or undefined when not declared. A reference
 *  hop (a forward FK) is inherently to-one — a child names the parent it points at. */
function _hopCardinality(rel: MetaData): string | undefined {
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
      const ref = rel.attr(RELATIONSHIP_ATTR_OBJECT_REF);
      return typeof ref === "string" && stripPackage(ref) === targetEntity.name;
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
): void {
  for (const rel of hops) {
    if (_hopCardinality(rel) === CARDINALITY_MANY) {
      errors.push(
        new ParseError(
          `origin.passthrough on ${obj.name}.${fieldName}: @via hop "${rel.name}" is to-many ` +
            `(@cardinality "${CARDINALITY_MANY}") — a row-multiplying passthrough — you meant aggregate (ADR-0029).`,
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
): void {
  if (hops.length === 0) return;
  const provablyToOne = hops.every((rel) => _hopCardinality(rel) === CARDINALITY_ONE);
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
 * Reuses ERR_INVALID_ORIGIN for the type disagreement rather than minting a
 * second code — it is the same "types disagree" shape the scalar arm reports.
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
        { code: "ERR_INVALID_ORIGIN", source: src }));
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
 */
function _validateOrderByKeys(
  orderBy: unknown,
  relatedEntity: MetaData | undefined,
  obj: MetaData,
  fieldName: string,
  label: string,
  originSource: ErrorSource,
  errors: ParseError[],
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
          { code: "ERR_INVALID_ORIGIN", source: originSource },
        ),
      );
    } else if (dir !== undefined && !(SORT_ORDER_VALUES as readonly string[]).includes(dir)) {
      errors.push(
        new ParseError(
          `${label} on ${obj.name}.${fieldName}: @orderBy key "${raw}" — direction must be one of ${SORT_ORDER_VALUES.join("|")}.`,
          { code: "ERR_INVALID_ORIGIN", source: originSource },
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
              _checkPassthroughCardinality(walked.hops, obj, field.name, origin.source, errors);
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
              if (walked !== undefined) _checkAggregateCardinality(walked.hops, obj, field.name, src, errors);
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
                { code: "ERR_INVALID_ORIGIN", source: src }));
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
                { code: "ERR_INVALID_ORIGIN", source: src }));
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
                { code: "ERR_INVALID_ORIGIN", source: src }));
              continue;
            }
            // One walk yields both the hops (cardinality) and the terminal
            // entity (@orderBy keys, member resolution). An invalid @via
            // (e.g. single-segment "A") returns undefined having already
            // pushed its own error, so everything downstream is skipped and
            // no second, misleadingly-scoped error is emitted.
            const via = _validateViaPath(viaAttr, root, obj, field.name, src, errors);
            if (via !== undefined) {
              _checkAggregateCardinality(via.hops, obj, field.name, src, errors);
              // @orderBy keys resolve against the @via TERMINAL entity, not @of.
              _validateOrderByKeys(orderBy, via.terminal, obj, field.name, "origin.aggregate @agg:collect", src, errors);
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
              _checkAggregateCardinality(walked.hops, obj, field.name, src, errors);
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
          const resolveField = (name: string): string | undefined =>
            base.children().find((f) => f.type === TYPE_FIELD && f.name === name)?.subType;
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
            if (walked !== undefined) _checkAggregateCardinality(walked.hops, obj, field.name, src, errors);
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
      if (!field.ownChildren().some((c) => c.type === TYPE_ORIGIN)) continue;
      errors.push(
        new ParseError(
          `derived field "${obj.name}.${field.name}" carries an origin.* but entity "${obj.name}" declares no ` +
            `read-capable source — derived fields do not exist on the writable table. Declare a read-only source ` +
            `(e.g. source.rdb @kind "view" @role "replica") to provide it, or move the field to an object.projection (FR-024 §7).`,
          { code: "ERR_DERIVED_FIELD_NO_READ_SOURCE", source: field.source },
        ),
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// field.object + @storage cross-attribute validation
//
// Rules (ADR-0013):
//   1. A field.object ALWAYS requires @objectRef. A field.object models a typed
//      nested value; without @objectRef it is "an oxymoron at the logical layer".
//      Genuinely open/untyped JSON uses the physical @dbColumnType: jsonb escape
//      hatch on field.string, NOT a bare object. → ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF.
//      (This rule subsumes the legacy @storage-without-@objectRef check —
//      @storage is only meaningful on a field.object, so the missing-@objectRef
//      situation now always reports this single, clearer error. One error per
//      node: when @objectRef is absent we skip the flattened/array check below.)
//   2. @storage "flattened" requires isArray to be absent or false (cannot
//      flatten a variable-length array into a fixed column set).
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
            `field.object "${obj.name}.${field.name}" has no @objectRef; a field.object requires @objectRef. For an open/untyped JSON map use @dbColumnType: jsonb on a field.string instead of a bare object.`,
            { code: "ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF", source: field.source },
          ),
        );
        continue;
      }

      // ADR-0039: resolving — @storage and array-ness may be inherited via extends.
      const storage = field.attr(FIELD_ATTR_STORAGE);
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
//   (d) @through / @sourceRefField / @symmetric are invalid on a non-M:N
//       relationship (@cardinality != "many", or no @through) → ERR_INVALID_RELATIONSHIP.
//
// Own-relationships only: a relationship is validated on the entity that declares
// it (matching the own-attrs policy of the other passes).
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
  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    // ADR-0042 — a bare @through resolves in the declaring entity's package.
    const referrerPkg = obj.package ?? obj.fileDefaultPackage ?? "";
    // ADR-0039: own — a relationship is validated on the entity that DECLARES it
    // (the M:N slim-vocabulary rules apply to own-declared relationships; its
    // inheritable attrs are read resolving below).
    for (const rel of obj.ownChildren().filter((c) => c.type === TYPE_RELATIONSHIP)) {
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
              `relationship "${obj.name}.${rel.name}" sets @${RELATIONSHIP_ATTR_THROUGH} but is not a M:N ` +
                `relationship (requires @${RELATIONSHIP_ATTR_CARDINALITY}: "${CARDINALITY_MANY}").`,
              { code: "ERR_INVALID_RELATIONSHIP", source: rel.source },
            ),
          );
        }
        if (hasSourceRefField) {
          errors.push(
            new ParseError(
              `relationship "${obj.name}.${rel.name}" sets @${RELATIONSHIP_ATTR_SOURCE_REF_FIELD} but is not a M:N relationship.`,
              { code: "ERR_INVALID_RELATIONSHIP", source: rel.source },
            ),
          );
        }
        if (symmetric) {
          errors.push(
            new ParseError(
              `relationship "${obj.name}.${rel.name}" sets @${RELATIONSHIP_ATTR_SYMMETRIC} but is not a M:N relationship.`,
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
            `relationship "${obj.name}.${rel.name}" sets both @${RELATIONSHIP_ATTR_SYMMETRIC} and ` +
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
        typeof objectRef === "string" && resolveObjectRef(root, objectRef, referrerPkg).node === obj;
      if (symmetric && !isSelfJoin) {
        errors.push(
          new ParseError(
            `relationship "${obj.name}.${rel.name}" sets @${RELATIONSHIP_ATTR_SYMMETRIC} but @${RELATIONSHIP_ATTR_OBJECT_REF} ` +
              `"${String(objectRef)}" is not the declaring entity "${obj.name}"; @${RELATIONSHIP_ATTR_SYMMETRIC} is self-join-only.`,
            { code: "ERR_BAD_ATTR_VALUE", source: rel.source },
          ),
        );
      }

      // Rule (c): @through must name an entity declaring exactly two identity.reference children.
      const junction = _findObject(root, through as string, referrerPkg);
      if (!junction) {
        errors.push(
          new ParseError(
            `relationship "${obj.name}.${rel.name}" @${RELATIONSHIP_ATTR_THROUGH} "${through}" does not resolve to an entity.${didYouMeanHint(root, String(through))}`,
            { code: "ERR_INVALID_RELATIONSHIP", source: resolvedSource(rel.source, `${obj.fqn()}::${rel.name}`, String(through)) },
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
            `relationship "${obj.name}.${rel.name}" @${RELATIONSHIP_ATTR_THROUGH} "${through}" resolves to ` +
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
            `relationship "${obj.name}.${rel.name}" @${RELATIONSHIP_ATTR_THROUGH} "${through}" must declare exactly two ` +
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
              `relationship "${obj.name}.${rel.name}" @${RELATIONSHIP_ATTR_SOURCE_REF_FIELD} "${sourceRefField}" does not match ` +
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
      if (hasFieldsAttr && hasExpr) {
        errors.push(
          new ParseError(
            `${label} "${node.name}" on "${obj.name}" declares BOTH ` +
              `@${INDEX_ATTR_FIELDS} and @${IDENTITY_ATTR_EXPR}; they are the two ` +
              `mutually exclusive ways to key an index. @${IDENTITY_ATTR_EXPR} is used ` +
              `INSTEAD of @${INDEX_ATTR_FIELDS} — drop one. ` +
              `(Declaring both previously loaded but silently discarded ` +
              `@${INDEX_ATTR_FIELDS}.)`,
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
}

export function validateProjectionFilter(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root
    .children()
    .filter((c) => c.type === TYPE_OBJECT && c.subType === OBJECT_SUBTYPE_PROJECTION)) {
    // ADR-0039: own — the @filter is declared locally on this projection.
    const filter = obj.ownAttr(OBJECT_PROJECTION_ATTR_FILTER);
    // Non-object shapes are rejected by the attr schema check (FilterAttr.validateValue).
    if (typeof filter !== "object" || filter === null || Array.isArray(filter)) continue;

    // Classify the projection's OWN fields (the declared set IS the exposure —
    // FR-024/ADR-0028): aggregate-derived-ness + the op-band legal for the field's
    // declared subType. origin.* never inherits (ADR-0029), so the origin reads
    // below are own (category 4).
    const fields = new Map<string, ProjectionFilterField>();
    for (const f of obj.ownChildren().filter((c) => c.type === TYPE_FIELD)) {
      const origin = f.ownChildren().find((c) => c.type === TYPE_ORIGIN);
      const derived =
        origin !== undefined &&
        origin.subType !== ORIGIN_SUBTYPE_PASSTHROUGH &&
        origin.subType !== ORIGIN_SUBTYPE_COMPUTED;
      // opsForField, not opsForSubType — an int-backed field.enum (@intValueMap)
      // stores as an integer, so `like` is not in its band.
      fields.set(f.name, { derived, ops: opsForField(f) });
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
    if (field === undefined) {
      err(
        `projection "${projectionName}" @filter references "${key}", which is not a declared field of the ` +
          `projection. A view-level @filter may only reference the projection's own declared fields.`,
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
