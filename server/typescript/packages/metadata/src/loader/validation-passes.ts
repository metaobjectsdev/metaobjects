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
} from "../shared/base-types.js";
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
import {
  LAYOUT_SUBTYPE_DATA_GRID,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD,
  LAYOUT_DATA_GRID_ATTR_FILTER,
} from "../presentation/layout/layout-constants.js";
import {
  FIELD_ATTR_FILTERABLE,
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
} from "../core/field/field-constants.js";
import { FIELD_ATTR_DB_INDEXED } from "../persistence/db/db-constants.js";
import { IDENTITY_ATTR_FIELDS } from "../core/identity/identity-constants.js";
import {
  ORIGIN_SUBTYPE_PASSTHROUGH,
  ORIGIN_SUBTYPE_AGGREGATE,
  ORIGIN_PASSTHROUGH_ATTR_FROM,
  ORIGIN_PASSTHROUGH_ATTR_VIA,
  ORIGIN_AGGREGATE_ATTR_OF,
  ORIGIN_AGGREGATE_ATTR_VIA,
} from "../persistence/origin/origin-constants.js";
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
} from "../core/query/query-constants.js";

// ---------------------------------------------------------------------------
// Layout dataGrid @defaultSortField validation
// ---------------------------------------------------------------------------

export function validateDataGridSortFields(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  for (const obj of root.ownChildren().filter((c) => c.type === TYPE_OBJECT)) {
    // Use children() so inherited fields (via extends:/super:) are
    // visible when validating @defaultSortField references.
    const effective = obj.children();
    const fieldNames = new Set(
      effective.filter((c) => c.type === TYPE_FIELD).map((f) => f.name),
    );
    for (const layout of effective.filter((c) => c.type === TYPE_LAYOUT && c.subType === LAYOUT_SUBTYPE_DATA_GRID)) {
      const sortField = layout.ownAttr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD);
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
  for (const c of node.ownChildren()) {
    if (c.type === TYPE_TEMPLATE) out.push(c);
    out.push(...allTemplates(c));
  }
  return out;
}

export function validateTemplatePayloadRefs(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  for (const tmpl of allTemplates(root)) {
    // --- @kind / textRef / email part-ref cross-field rules ---
    // template.output is either a document (@kind absent/"document" → @textRef
    // required) or an email (@kind="email" → @subjectRef + @htmlBodyRef required,
    // @textRef unused). template.prompt always requires @textRef (the renderable
    // body). The closed-enum membership of @kind is handled by validateAttrSchema
    // (allowedValues) — here we only enforce the conditional ref presence.
    if (tmpl.subType === TEMPLATE_SUBTYPE_OUTPUT) {
      const kind = tmpl.ownAttr(TEMPLATE_ATTR_KIND);
      if (kind === TEMPLATE_KIND_EMAIL) {
        if (typeof tmpl.ownAttr(TEMPLATE_ATTR_SUBJECT_REF) !== "string") {
          errors.push(
            new ParseError(
              `template "${tmpl.name}" @kind "email" requires @subjectRef`,
              { code: "ERR_INVALID_TEMPLATE", source: tmpl.source },
            ),
          );
        }
        if (typeof tmpl.ownAttr(TEMPLATE_ATTR_HTML_BODY_REF) !== "string") {
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
        if (typeof tmpl.ownAttr(TEMPLATE_ATTR_TEXT_REF) !== "string") {
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
      if (typeof tmpl.ownAttr(TEMPLATE_ATTR_TEXT_REF) !== "string") {
        errors.push(
          new ParseError(
            `template "${tmpl.name}" requires @textRef`,
            { code: "ERR_INVALID_TEMPLATE", source: tmpl.source },
          ),
        );
      }
    }

    const payloadRef = tmpl.ownAttr(TEMPLATE_ATTR_PAYLOAD_REF);
    if (typeof payloadRef !== "string") continue; // absence handled by the required-attr schema check
    const payload = root.ownChildren().find((c) => c.type === TYPE_OBJECT && c.name === payloadRef);
    if (!payload || payload.subType !== OBJECT_SUBTYPE_VALUE) {
      // FR5d — @payloadRef is a reference; emit format=resolved with
      // referrer=template FQN, target=the unresolved payloadRef string.
      errors.push(
        new ParseError(
          `template "${tmpl.name}" @payloadRef "${payloadRef}" does not resolve to an object.value at root`,
          {
            code: "ERR_INVALID_TEMPLATE",
            source: resolvedSource(tmpl.source, tmpl.fqn(), payloadRef),
          },
        ),
      );
      continue;
    }
    const responseRef = tmpl.ownAttr(TEMPLATE_ATTR_RESPONSE_REF);
    if (typeof responseRef === "string") {
      const resVo = root.ownChildren().find((c) => c.type === TYPE_OBJECT && c.name === responseRef);
      if (!resVo || resVo.subType !== OBJECT_SUBTYPE_VALUE) {
        errors.push(
          new ParseError(
            `template "${tmpl.name}" @responseRef "${responseRef}" does not resolve to an object.value at root`,
            { code: "ERR_INVALID_TEMPLATE", source: resolvedSource(tmpl.source, tmpl.fqn(), responseRef) },
          ),
        );
      }
    }
    const fieldNames = new Set(
      payload.children().filter((c) => c.type === TYPE_FIELD).map((f) => f.name),
    );
    const slots = tmpl.ownAttr(TEMPLATE_ATTR_REQUIRED_SLOTS);
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

// ---------------------------------------------------------------------------
// @filterable without index validation
// ---------------------------------------------------------------------------

export function validateFilterableHasIndex(root: MetaData): string[] {
  const warnings: string[] = [];
  for (const obj of root.ownChildren().filter((c) => c.type === TYPE_OBJECT)) {
    // Use children() so inherited fields and identities (via extends:/super:)
    // are included when checking filterable-without-index.
    const effective = obj.children();
    // Build the set of field names that are part of any identity on this object.
    const indexedFieldNames = new Set<string>();
    for (const identity of effective.filter((c) => c.type === TYPE_IDENTITY)) {
      const fields = identity.ownAttr(IDENTITY_ATTR_FIELDS);
      if (typeof fields === "string") {
        for (const name of fields.split(",")) indexedFieldNames.add(name.trim());
      } else if (Array.isArray(fields)) {
        for (const name of fields) if (typeof name === "string") indexedFieldNames.add(name);
      }
    }

    for (const field of effective.filter((c) => c.type === TYPE_FIELD)) {
      const filterable = field.ownAttr(FIELD_ATTR_FILTERABLE);
      if (filterable !== true) continue;
      if (field.ownAttr(FIELD_ATTR_DB_INDEXED) === true) continue;
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
  for (const obj of root.ownChildren().filter((c) => c.type === TYPE_OBJECT)) {
    // children() — inherited @filterable fields (via extends:/super:) are visible.
    for (const field of obj.children().filter((c) => c.type === TYPE_FIELD)) {
      if (field.ownAttr(FIELD_ATTR_FILTERABLE) !== true) continue;
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

function _findObject(root: MetaData, name: string): MetaData | undefined {
  return root.ownChildren().find((c) => c.type === TYPE_OBJECT && c.name === name);
}

function _findField(obj: MetaData, name: string): MetaData | undefined {
  // Use children() so inherited fields (via extends:/super:) are included.
  return obj.children().find((c) => c.type === TYPE_FIELD && c.name === name);
}

function _findRelationship(obj: MetaData, name: string): MetaData | undefined {
  // Use children() so inherited relationships (via extends:/super:) are included.
  return obj.children().find((c) => c.type === TYPE_RELATIONSHIP && c.name === name);
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
  const sourceObj = _findObject(root, entityName);
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

/**
 * Validate an explicit `@via` "Entity.rel[.rel...]" path. Returns the walked
 * relationship hop nodes (in path order) on full success — FR-024 B5 runs the
 * cardinality checks over them — or undefined when any error was pushed.
 */
function _validateViaPath(
  viaAttr: string,
  root: MetaData,
  projection: MetaData,
  fieldName: string,
  originSource: ErrorSource,
  errors: ParseError[],
): MetaData[] | undefined {
  const projectionName = projection.name;
  // FR5d — referrer is `<projection-FQN>::<fieldName>`.
  const referrer = `${projection.fqn()}::${fieldName}`;
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
  let currentObj = _findObject(root, entityName);
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
    const rel = _findRelationship(currentObj, relName);
    if (!rel) {
      const prefix = validSegments.join(".");
      errors.push(
        new ParseError(
          `origin.@via "${viaAttr}" on ${projectionName}.${fieldName}: no such relationship "${relName}" on ${currentObj.name}. ` +
          `Deepest valid prefix was "${prefix}".`,
          {
            code: "ERR_INVALID_ORIGIN",
            source: resolvedSource(originSource, referrer, viaAttr),
          },
        ),
      );
      return undefined;
    }
    const refTarget = rel.ownAttr(RELATIONSHIP_ATTR_OBJECT_REF);
    if (typeof refTarget !== "string" || refTarget === "") {
      errors.push(
        new ParseError(
          `origin.@via "${viaAttr}" on ${projectionName}.${fieldName}: relationship "${relName}" on ${currentObj.name} is missing @objectRef.`,
          {
            code: "ERR_INVALID_ORIGIN",
            source: resolvedSource(originSource, referrer, viaAttr),
          },
        ),
      );
      return undefined;
    }
    const nextObj = _findObject(root, refTarget);
    if (!nextObj) {
      // FR5d — relationship's @objectRef points at a missing entity. This
      // is the @objectRef-resolution edge of the via-path walk (the "5th
      // site" in FR5d's scope list for @objectRef references encountered
      // transitively).
      errors.push(
        new ParseError(
          `origin.@via "${viaAttr}" on ${projectionName}.${fieldName}: relationship "${relName}" points to non-existent entity "${refTarget}".`,
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
  return hops;
}

// ---------------------------------------------------------------------------
// FR-024 B5 — base-entity derivation, single-hop-unique @via inference, and
// origin cardinality checks (spec §5–§6; ADR-0029 decisions 5–6).
// ---------------------------------------------------------------------------

/** A hop relationship's effective @cardinality, or undefined when not declared. */
function _hopCardinality(rel: MetaData): string | undefined {
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
function _refNamedOwner(node: MetaData, root: MetaData): MetaData | undefined {
  const ref = node.superRef;
  if (ref === undefined) return undefined;
  const lastSep = ref.lastIndexOf("::");
  const tail = lastSep === -1 ? ref : ref.slice(lastSep + 2);
  const dot = tail.indexOf(".");
  if (dot <= 0) return undefined;
  return _findObject(root, tail.slice(0, dot));
}

function _deriveBaseEntity(
  obj: MetaData,
  root: MetaData,
  fieldName: string,
  originSource: ErrorSource,
  errors: ParseError[],
): MetaData | undefined {
  if (obj.subType !== OBJECT_SUBTYPE_PROJECTION) return obj;

  // 1) The extended identity anchors the base entity (declared, not inferred).
  //    The anchor is the entity NAMED in the ref's owner part — see _refNamedOwner.
  for (const identity of obj.ownChildren().filter((c) => c.type === TYPE_IDENTITY)) {
    const extended = identity.superResolved;
    if (extended !== undefined && extended.type === TYPE_IDENTITY) {
      const named = _refNamedOwner(identity, root);
      if (named !== undefined) return named;
      const owner = extended.parent;
      if (owner !== undefined && owner.type === TYPE_OBJECT) return owner;
    }
  }

  // 2) Fallback: the single distinct entity targeted by plain field-extends —
  //    again preferring the ref-named owner over the physical declaring ancestor.
  const targets = new Set<MetaData>();
  for (const f of obj.ownChildren().filter((c) => c.type === TYPE_FIELD)) {
    const sup = f.superResolved;
    if (sup === undefined) continue;
    const named = _refNamedOwner(f, root);
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
      const ref = rel.ownAttr(RELATIONSHIP_ATTR_OBJECT_REF);
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

export function validateOriginPaths(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  for (const obj of root.ownChildren().filter((c) => c.type === TYPE_OBJECT)) {
    // FR-024 B5: object.value hosts are EXEMPT from @via inference and
    // cardinality checks — a value's origin.passthrough is FR-015 parameter
    // lineage (values are constructed, never assembled; spec §7), not an
    // assembly path. Their @from refs are still resolution-validated.
    const isValueHost = obj.subType === OBJECT_SUBTYPE_VALUE;
    for (const field of obj.ownChildren().filter((c) => c.type === TYPE_FIELD)) {
      for (const origin of field.ownChildren().filter((c) => c.type === TYPE_ORIGIN)) {
        if (origin.subType === ORIGIN_SUBTYPE_PASSTHROUGH) {
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
          }
          const via = origin.ownAttr(ORIGIN_PASSTHROUGH_ATTR_VIA);
          if (typeof via === "string" && via !== "") {
            const hops = _validateViaPath(via, root, obj, field.name, origin.source, errors);
            if (hops !== undefined) {
              _checkPassthroughCardinality(hops, obj, field.name, origin.source, errors);
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
          const of_ = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_OF);
          if (typeof of_ !== "string" || of_ === "") {
            errors.push(
              new ParseError(
                `origin.aggregate on ${obj.name}.${field.name}: missing @of.`,
                { code: "ERR_INVALID_ORIGIN", source: origin.source },
              ),
            );
            continue;
          }
          // NOTE (FR-024 B6): NO extends/origin agreement check on aggregates —
          // an aggregate computes something new (count/sum/…); spec §4 defines
          // agreement for passthrough only.
          const ofTarget = _validateFromPath(of_, root, obj, field.name, origin.source, errors, "origin.aggregate.@of");
          const via = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_VIA);
          if (typeof via === "string" && via !== "") {
            const hops = _validateViaPath(via, root, obj, field.name, origin.source, errors);
            if (hops !== undefined) {
              _checkAggregateCardinality(hops, obj, field.name, origin.source, errors);
            }
            continue;
          }
          // FR-024 §6 — no @via on an aggregate: inference applies only when
          // @of targets a non-base entity from a non-value host; an aggregate
          // over the base relation itself still requires an explicit path.
          if (ofTarget === undefined) continue; // @of did not resolve — no inference to attempt
          if (isValueHost) {
            errors.push(
              new ParseError(
                `origin.aggregate on ${obj.name}.${field.name}: missing @via (aggregates require a relationship path).`,
                { code: "ERR_INVALID_ORIGIN", source: origin.source },
              ),
            );
            continue;
          }
          const base = _deriveBaseEntity(obj, root, field.name, origin.source, errors);
          if (base === undefined) continue; // base underivable — error already pushed
          if (_isBaseRelationTarget(ofTarget.entity, base, obj)) {
            errors.push(
              new ParseError(
                `origin.aggregate on ${obj.name}.${field.name}: missing @via (aggregates require a relationship path).`,
                { code: "ERR_INVALID_ORIGIN", source: origin.source },
              ),
            );
            continue;
          }
          const hops = _inferViaSingleHop(
            base, ofTarget.entity, obj, field.name, of_,
            "origin.aggregate.@of", origin.source, errors,
          );
          if (hops !== undefined) {
            _checkAggregateCardinality(hops, obj, field.name, origin.source, errors);
          }
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
  for (const obj of root
    .ownChildren()
    .filter((c) => c.type === TYPE_OBJECT && c.subType === OBJECT_SUBTYPE_ENTITY)) {
    const hasReadCapableSource = obj
      .children()
      .filter((c) => c.type === TYPE_SOURCE)
      .some((s) => (s as MetaSource).isReadOnly());
    if (hasReadCapableSource) continue;
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
  for (const obj of root.ownChildren().filter((c) => c.type === TYPE_OBJECT)) {
    for (const field of obj.ownChildren().filter((c) => c.type === TYPE_FIELD)) {
      const objectRef = field.ownAttr(FIELD_ATTR_OBJECT_REF);
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

      const storage = field.ownAttr(FIELD_ATTR_STORAGE);
      if (storage === undefined || storage === null) continue;
      if (storage === STORAGE_FLATTENED && field.isArray === true) {
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
  for (const obj of root.ownChildren().filter((c) => c.type === TYPE_OBJECT)) {
    const effective = obj.children();
    const allow = new Map<string, readonly string[]>();
    for (const f of effective.filter((c) => c.type === TYPE_FIELD)) {
      if (f.ownAttr(FIELD_ATTR_FILTERABLE) === true) {
        allow.set(f.name, opsForSubType(f.subType));
      }
    }
    for (const layout of effective.filter(
      (c) => c.type === TYPE_LAYOUT && c.subType === LAYOUT_SUBTYPE_DATA_GRID,
    )) {
      const filter = layout.ownAttr(LAYOUT_DATA_GRID_ATTR_FILTER);
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
  for (const obj of root.ownChildren().filter((c) => c.type === TYPE_OBJECT)) {
    for (const rel of obj.ownChildren().filter((c) => c.type === TYPE_RELATIONSHIP)) {
      const through = rel.ownAttr(RELATIONSHIP_ATTR_THROUGH);
      const sourceRefField = rel.ownAttr(RELATIONSHIP_ATTR_SOURCE_REF_FIELD);
      const symmetric = rel.ownAttr(RELATIONSHIP_ATTR_SYMMETRIC) === true;
      const cardinality = rel.ownAttr(RELATIONSHIP_ATTR_CARDINALITY);
      const objectRef = rel.ownAttr(RELATIONSHIP_ATTR_OBJECT_REF);

      const hasThrough = typeof through === "string" && through !== "";
      const hasSourceRefField = typeof sourceRefField === "string" && sourceRefField !== "";
      const isMany = cardinality === CARDINALITY_MANY;
      const isM2M = hasThrough && isMany;

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
      const isSelfJoin = typeof objectRef === "string" && stripPackage(objectRef) === obj.name;
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
      const junction = _findObject(root, through as string);
      if (!junction) {
        errors.push(
          new ParseError(
            `relationship "${obj.name}.${rel.name}" @${RELATIONSHIP_ATTR_THROUGH} "${through}" does not resolve to an entity.`,
            { code: "ERR_INVALID_RELATIONSHIP", source: resolvedSource(rel.source, `${obj.fqn()}::${rel.name}`, String(through)) },
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
