// Stateless validation passes for the MetaDataLoader pipeline.
//
// Each function takes a fully-merged MetaData root and returns errors or
// warnings. No loader state is read or written — these are pure functions.
//
// Exported: validateDataGridSortFields, validateFilterableHasIndex,
//           validateOriginPaths, validateDataGridFilterValues,
//           validateFieldObjectStorage  (called by MetaDataLoader.load() in order).
// Private:  _findObject, _findField, _findRelationship,
//           _validateFromPath, _validateViaPath  (helpers, not exported).

import type { MetaData } from "../shared/meta-data.js";
import { ParseError } from "../errors.js";
import { resolvedSource, type ErrorSource } from "../source.js";
import {
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_LAYOUT,
  TYPE_IDENTITY,
  TYPE_ORIGIN,
  TYPE_RELATIONSHIP,
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
import { OBJECT_SUBTYPE_VALUE } from "../core/object/object-constants.js";
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
import { RELATIONSHIP_ATTR_OBJECT_REF } from "../core/relationship/relationship-constants.js";
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

function _validateFromPath(
  fromAttr: string,
  root: MetaData,
  projection: MetaData,
  fieldName: string,
  originSource: ErrorSource,
  errors: ParseError[],
  label: string = "origin.passthrough.@from",
): void {
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
    return;
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
    return;
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
  }
}

function _validateViaPath(
  viaAttr: string,
  root: MetaData,
  projection: MetaData,
  fieldName: string,
  originSource: ErrorSource,
  errors: ParseError[],
): void {
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
    return;
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
    return;
  }
  // FR5d — track the deepest-valid-prefix as we walk. The prefix grows
  // segment-by-segment; on a hop failure the error message names the prefix
  // that DID resolve, so authors can fix multi-hop typos quickly.
  // After the entity lookup above, the deepest valid prefix is just the
  // entity name; each successful relationship hop appends a segment.
  const validSegments: string[] = [entityName];
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
      return;
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
      return;
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
      return;
    }
    validSegments.push(relName);
    currentObj = nextObj;
  }
}

export function validateOriginPaths(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  for (const obj of root.ownChildren().filter((c) => c.type === TYPE_OBJECT)) {
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
          _validateFromPath(from, root, obj, field.name, origin.source, errors);
          const via = origin.ownAttr(ORIGIN_PASSTHROUGH_ATTR_VIA);
          if (typeof via === "string" && via !== "") {
            _validateViaPath(via, root, obj, field.name, origin.source, errors);
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
          _validateFromPath(of_, root, obj, field.name, origin.source, errors, "origin.aggregate.@of");
          const via = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_VIA);
          if (typeof via !== "string" || via === "") {
            errors.push(
              new ParseError(
                `origin.aggregate on ${obj.name}.${field.name}: missing @via (aggregates require a relationship path).`,
                { code: "ERR_INVALID_ORIGIN", source: origin.source },
              ),
            );
            continue;
          }
          _validateViaPath(via, root, obj, field.name, origin.source, errors);
        }
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// @storage cross-attribute validation
//
// Rules:
//   1. @storage requires @objectRef to be present (storage is meaningless
//      without a referenced object type).
//   2. @storage "flattened" requires isArray to be absent or false (cannot
//      flatten a variable-length array into a fixed column set).
//
// Only field.object nodes carry @storage in practice, but the check is applied
// to every field node that has @storage set — matching the permissive "check
// what's there" model used by the other validation passes.
// ---------------------------------------------------------------------------

export function validateFieldObjectStorage(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  for (const obj of root.ownChildren().filter((c) => c.type === TYPE_OBJECT)) {
    for (const field of obj.ownChildren().filter((c) => c.type === TYPE_FIELD)) {
      const storage = field.ownAttr(FIELD_ATTR_STORAGE);
      if (storage === undefined || storage === null) continue;
      const objectRef = field.ownAttr(FIELD_ATTR_OBJECT_REF);
      if (typeof objectRef !== "string" || objectRef.length === 0) {
        errors.push(
          new ParseError(
            `field "${obj.name}.${field.name}" sets @storage but has no @objectRef`,
            { code: "ERR_STORAGE_WITHOUT_OBJECT_REF", source: field.source },
          ),
        );
      }
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
