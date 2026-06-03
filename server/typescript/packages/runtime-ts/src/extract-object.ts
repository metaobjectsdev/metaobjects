// Phase B (metadata-driven extract) runtime entry point — the TS keystone that turns dirty
// LLM text into a populated, typed object graph.
//
// This is the runtime bridge between the two halves of the standard:
//   • the extract ENGINE (@metaobjectsdev/render: ExtractSchema / FieldSpec / extract) — a
//     zero-core-dependency, descriptor-driven module that parses dirty JSON/XML into a forgiving
//     record/array tree + a ExtractionReport. It knows nothing of the runtime object model.
//   • the Phase A runtime OBJECT MODEL (@metaobjectsdev/metadata: MetaObject.newInstance() +
//     the MetaField get/set SPI + @objectRef) — instantiates the right backing type
//     (ValueObject or a registered/bound class) with the correct back-reference.
//
// Siting. render stays metadata-free (it is a published render package; coupling it to the
// metadata model would regress every render consumer). The metadata-driven bridge therefore lives
// HERE, in @metaobjectsdev/runtime-ts — the lowest package that already depends on metadata and
// that can also take a one-way dependency on render. This mirrors the JVM layering, where the
// extract engine sits in the metadata-free `render` module and the runtime extract bridge lives in
// the `om` runtime module (which depends on BOTH metadata and render). The edges are one-way:
// runtime-ts → render and runtime-ts → metadata; render depends on neither, so there is no cycle.
//
// Reflection-free. Assembly uses MetaObject.newInstance() (the ObjectClassRegistry resolves the
// bound type, else a ValueObject) and the MetaField setValue SPI — no eval / dynamic import.
//
// Never throws. Lost/malformed fields are classified in the report, never raised. Opt into
// strictness with orThrow() (re-exported from @metaobjectsdev/render), which throws a ExtractError
// iff a required field was lost.

import {
  MetaObject,
  MetaField,
  MetaRoot,
  type MetaData,
  PACKAGE_SEPARATOR,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_CLASS,
  FIELD_SUBTYPE_UUID,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_ATTR_REQUIRED,
  FIELD_ATTR_VALUES,
  FIELD_ATTR_ENUM_ALIAS,
  FIELD_ATTR_COERCE_DEFAULT,
  FIELD_ATTR_DEFAULT,
  FIELD_ATTR_NORMALIZE,
  FIELD_ATTR_OBJECT_REF,
  NORMALIZE_DEFAULT,
  type NormalizeMode,
} from "@metaobjectsdev/metadata";

import {
  Format,
  FieldKind,
  scalar,
  enumField,
  enumArray,
  object,
  extractSchema,
  extract,
  type FieldSpec,
  type ExtractOptions,
  type ExtractSchema,
  type ExtractionResult,
} from "@metaobjectsdev/render";

/**
 * Maximum nested-object recursion depth. Mirrors the render OutputFormatRenderer.MAX_NEST_DEPTH
 * (and FR-012) — must stay identical cross-port (Java MetaObjectExtractor.MAX_NEST_DEPTH = 8). At or
 * beyond this depth a nested OBJECT field becomes an opaque STRING leaf instead of recursing.
 */
export const MAX_NEST_DEPTH = 8;

// =============================================================================
// Public API
// =============================================================================

/**
 * Extract `text` into a typed object graph described by `mo`.
 *
 * Pipeline: build a ExtractSchema from `mo` (driven entirely by metadata), run the engine to get
 * a forgiving record/array tree + report, then assemble that tree into a populated object graph.
 *
 * @param mo     the object describing the expected shape (the single source of truth)
 * @param text   the dirty model output
 * @param format JSON (default) or XML — drives the engine's locate/parse
 * @param opts   bounded runtime overrides (aliases/normalizers/onField/tolerance)
 * @returns the assembled object (a ValueObject unless a type is bound for the FQN) + report.
 *          NEVER throws.
 */
export function extractObject(
  mo: MetaObject,
  text: string | null | undefined,
  format: Format = Format.JSON,
  opts?: Partial<ExtractOptions> | null,
): ExtractionResult<object> {
  const schema = extractSchemaFor(mo, format);
  const outcome = extract(text, schema, opts);
  const obj = assemble(mo, outcome.data);
  return { data: obj, report: outcome.report };
}

// =============================================================================
// extractSchemaFor — metadata -> ExtractSchema
// =============================================================================

/**
 * Build a ExtractSchema for `mo` by walking its effective fields and mapping each MetaField to a
 * FieldSpec. Recurses into nested OBJECT fields via `@objectRef`, guarded against cycles/over-depth
 * by an identity visited-set keyed on MetaObject + a depth counter bounded by {@link MAX_NEST_DEPTH}.
 */
export function extractSchemaFor(mo: MetaObject, format: Format = Format.JSON): ExtractSchema {
  return extractSchemaForInner(mo, format, new Set<MetaObject>(), 0);
}

function extractSchemaForInner(
  mo: MetaObject,
  format: Format,
  visited: Set<MetaObject>,
  depth: number,
): ExtractSchema {
  visited.add(mo);
  const fields: FieldSpec[] = mo.fields().map((f) => fieldSpecFor(f, mo, format, visited, depth));
  visited.delete(mo);
  // rootName is the simple (short) name; the engine's XML locate uses it as the root tag.
  return extractSchema(format, mo.name, fields);
}

function fieldSpecFor(
  field: MetaField,
  owner: MetaObject,
  format: Format,
  visited: Set<MetaObject>,
  depth: number,
): FieldSpec {
  const name = field.name;
  const required = isRequired(field);

  // --- Enum (scalar or array) ----------------------------------------------
  if (field.subType === FIELD_SUBTYPE_ENUM) {
    const values = enumValues(field);
    const aliases = enumAliases(field);
    const cd = ownAttrString(field, FIELD_ATTR_COERCE_DEFAULT);
    const dv = ownAttrString(field, FIELD_ATTR_DEFAULT);
    const normalize = resolveNormalize(field, owner);
    const build = field.isArray === true ? enumArray : enumField;
    return build(name, required, values, aliases, cd, normalize, dv);
  }

  // --- Nested object (single or array) --------------------------------------
  if (field.subType === FIELD_SUBTYPE_OBJECT || field.objectRef !== undefined) {
    const ref = resolveObjectRef(field);
    const cyclicOrDeep = ref === undefined || visited.has(ref) || depth + 1 >= MAX_NEST_DEPTH;
    if (cyclicOrDeep) {
      // Opaque leaf — never recurse into a cycle / past the depth bound.
      return scalar(name, FieldKind.STRING, required);
    }
    const nested = extractSchemaForInner(ref, format, visited, depth + 1);
    return object(name, required, field.isArray === true, nested);
  }

  // --- Scalar (carry generalized @default) ----------------------------------
  const kind = scalarKind(field.subType);
  const dv = ownAttrString(field, FIELD_ATTR_DEFAULT);
  if (field.isArray === true) {
    // Scalar array: the engine coerces each element; no per-element default fill.
    return scalarArray(name, kind, required);
  }
  return scalar(name, kind, required, dv);
}

// =============================================================================
// assemble — extracted record/array tree -> object graph
// =============================================================================

/**
 * Assemble a extracted `Record<string, unknown>` (the engine's forgiving tree) into a populated
 * object graph described by `mo`.
 *
 * `mo.newInstance()` yields the bound type (or a ValueObject) with the back-ref already set. Each
 * field's value is written via the MetaField setValue SPI:
 *   • scalar / enum / scalar-array / enum-array → setValue (engine already coerced; arrays arrive
 *     as a list);
 *   • OBJECT non-array → recursively assemble the child record, then setValue;
 *   • OBJECT array → recursively assemble each element record into a list, then setValue.
 *
 * Cycle/depth-guarded identically to extractSchemaFor. NEVER throws on lost/malformed data — those
 * were classified in the report during the engine pass.
 */
export function assemble(mo: MetaObject, data: Record<string, unknown> | null | undefined): object {
  return assembleInner(mo, data, new Set<MetaObject>(), 0);
}

function assembleInner(
  mo: MetaObject,
  data: Record<string, unknown> | null | undefined,
  visited: Set<MetaObject>,
  depth: number,
): object {
  const o = mo.newInstance();
  if (data == null) {
    return o;
  }
  visited.add(mo);
  for (const field of mo.fields()) {
    const name = field.name;
    const value = data[name];

    const isObjectField = field.subType === FIELD_SUBTYPE_OBJECT || field.objectRef !== undefined;
    // Enum fields are string-backed scalars/arrays — treat them as scalar assignment.
    if (!isObjectField || field.subType === FIELD_SUBTYPE_ENUM) {
      // scalar / enum / scalar-array / enum-array: the engine already coerced the value.
      if (value !== undefined && value !== null) {
        field.setValue(o, value);
      }
      continue;
    }

    // Nested object — guard cycles/depth (mirror the schema guard).
    const ref = resolveObjectRef(field);
    const cyclicOrDeep = ref === undefined || visited.has(ref) || depth + 1 >= MAX_NEST_DEPTH;

    if (field.isArray === true) {
      // Array-of-objects: map each element record -> assembled child.
      if (Array.isArray(value)) {
        const children: object[] = [];
        for (const elem of value) {
          if (!cyclicOrDeep && isPlainObject(elem)) {
            children.push(assembleInner(ref!, elem as Record<string, unknown>, visited, depth + 1));
          }
        }
        field.setValue(o, children);
      }
      // absent array stays absent (the engine reports it).
    } else {
      // Single object.
      if (!cyclicOrDeep && isPlainObject(value)) {
        const child = assembleInner(ref!, value as Record<string, unknown>, visited, depth + 1);
        field.setValue(o, child);
      }
      // else leave unset.
    }
  }
  visited.delete(mo);
  return o;
}

// =============================================================================
// Field-spec helpers (mirror codegen-ts fr010-field-mapping + the Java reader)
// =============================================================================

/** A scalar-array FieldSpec: scalar() builds array:false, so set array:true explicitly. */
function scalarArray(name: string, kind: FieldKind, required: boolean): FieldSpec {
  return { ...scalar(name, kind, required), array: true };
}

/** The engine FieldKind for a scalar field subtype. Unknown subtypes fall back to STRING. */
function scalarKind(subType: string): FieldKind {
  switch (subType) {
    case FIELD_SUBTYPE_STRING:
    case FIELD_SUBTYPE_CLASS:
    case FIELD_SUBTYPE_UUID:
    case FIELD_SUBTYPE_DATE:
    case FIELD_SUBTYPE_TIME:
    case FIELD_SUBTYPE_TIMESTAMP:
    // decimal's wire form is an exact decimal STRING (parsing it as a float would be
    // lossy) — matching the codegen sibling (fr010-field-mapping) + C# runtime extract.
    case FIELD_SUBTYPE_DECIMAL:
      return FieldKind.STRING;
    case FIELD_SUBTYPE_INT:
      return FieldKind.INT;
    case FIELD_SUBTYPE_LONG:
    case FIELD_SUBTYPE_CURRENCY:
      return FieldKind.LONG;
    case FIELD_SUBTYPE_DOUBLE:
    case FIELD_SUBTYPE_FLOAT:
      return FieldKind.DOUBLE;
    case FIELD_SUBTYPE_BOOLEAN:
      return FieldKind.BOOLEAN;
    default:
      return FieldKind.STRING;
  }
}

/** True iff `@required` is explicitly true (or the string "true"). */
function isRequired(field: MetaField): boolean {
  const v = field.ownAttr(FIELD_ATTR_REQUIRED);
  if (v === true) return true;
  return typeof v === "string" && v.toLowerCase() === "true";
}

/** The string members of an enum field's `@values` attr (empty when absent). */
function enumValues(field: MetaField): string[] {
  const v = field.ownAttr(FIELD_ATTR_VALUES);
  if (Array.isArray(v)) return v.map((e) => String(e));
  return [];
}

/** The `@enumAlias` map (an object literal) of an enum field, or {} when absent/empty. */
function enumAliases(field: MetaField): Record<string, string> {
  const raw = field.ownAttr(FIELD_ATTR_ENUM_ALIAS);
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(raw as Record<string, unknown>)) {
    if (val != null) out[k] = String(val);
  }
  return out;
}

/**
 * Resolve the enum normalization mode: field-level `@normalize`, else the owning object's
 * `@normalize`, else the global NORMALIZE_DEFAULT ("strip"). Mirrors the cross-port resolution.
 */
function resolveNormalize(field: MetaField, owner: MetaObject | null): NormalizeMode {
  const fieldMode = normalizeAttrOf(field);
  if (fieldMode != null) return fieldMode;
  const objMode = owner == null ? null : normalizeAttrOf(owner);
  if (objMode != null) return objMode;
  return NORMALIZE_DEFAULT;
}

function normalizeAttrOf(node: MetaData): NormalizeMode | null {
  const v = node.ownAttr(FIELD_ATTR_NORMALIZE);
  return typeof v === "string" && v.length > 0 ? (v as NormalizeMode) : null;
}

/** The own (non-inherited) string value of an attr on a node, or null when absent/empty. */
function ownAttrString(node: MetaData, attr: string): string | null {
  const v = node.ownAttr(attr);
  if (typeof v === "string") return v.length > 0 ? v : null;
  return v == null ? null : String(v);
}

/**
 * Resolve a field's `@objectRef` FQN to its MetaObject by walking to the tree root and looking it
 * up. The objectRef may be a bare name or a `pkg::Name` FQN; we try the value as-is, then the short
 * name after the last package separator. Returns undefined when unresolvable (→ opaque-leaf guard).
 */
function resolveObjectRef(field: MetaField): MetaObject | undefined {
  const ref = ownAttrString(field, FIELD_ATTR_OBJECT_REF) ?? field.objectRef;
  if (ref === undefined || ref === null) return undefined;
  const root = field.root();
  if (!(root instanceof MetaRoot)) return undefined;
  const direct = root.findObject(ref);
  if (direct !== undefined) return direct;
  const sep = ref.lastIndexOf(PACKAGE_SEPARATOR);
  if (sep >= 0) {
    const short = ref.slice(sep + PACKAGE_SEPARATOR.length);
    return root.findObject(short);
  }
  return undefined;
}

function isPlainObject(o: unknown): boolean {
  return typeof o === "object" && o !== null && !Array.isArray(o);
}
