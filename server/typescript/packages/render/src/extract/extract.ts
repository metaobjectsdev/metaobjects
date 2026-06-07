// Public entry point. Runs the staged pipeline; NEVER throws. Mirrors Java Extract.

import {
  Format,
  FieldKind,
  FieldExtraction,
  Tolerance,
  normalizeOptions,
} from "./types.js";
import type { FieldSpec, ExtractOptions, ExtractionOutcome, ExtractSchema } from "./types.js";
import { ExtractionReport } from "./types.js";
import { strip } from "./strip.js";
import { locateJson, locateXml } from "./locate.js";
import { readJson, TRUNCATED, NULL_LITERAL } from "./json-forgiving-reader.js";
import { readXml, readXmlRootless, TEXT_KEY } from "./xml-forgiving-reader.js";
import { coerceValue, scalarCoerce, MALFORMED } from "./coerce.js";

/** The forgiving entry point: extract dirty `text` against `schema`. Never throws. */
export function extract(
  text: string | null | undefined,
  schema: ExtractSchema,
  opts?: Partial<ExtractOptions> | null,
): ExtractionOutcome {
  const o = normalizeOptions(opts);
  const report = new ExtractionReport();
  const data: Record<string, unknown> = {};

  const stripped = strip(text);
  const ci = o.tolerance !== Tolerance.STRICT;

  // XML rootless (opts.rootless): the payload's fields ARE the top-level elements — there is no
  // enclosing root to locate — so parse the whole stripped text's top-level elements directly.
  // Otherwise locate the <rootName> span as before. JSON is unaffected. Mirrors Java Extract.
  let span: string | null;
  let raw: Record<string, unknown>;
  if (schema.format === Format.JSON) {
    span = locateJson(stripped);
    raw = span == null ? {} : readJson(span);
  } else if (o.rootless) {
    span = stripped.length === 0 ? null : stripped;
    raw = span == null ? {} : readXmlRootless(stripped, ci);
  } else {
    span = locateXml(stripped, schema.rootName, ci);
    raw = span == null ? {} : readXml(span, ci);
  }

  if (isEmptyRecord(raw) && (stripped.length === 0 || span == null)) {
    report.markEmpty();
  }

  extractFields(schema.fields, raw, "", data, report, o, ci);
  return { data, report };
}

function extractFields(
  fields: readonly FieldSpec[],
  raw: Record<string, unknown>,
  prefix: string,
  data: Record<string, unknown>,
  report: ExtractionReport,
  o: ExtractOptions,
  ci: boolean,
): void {
  for (const f of fields) {
    const path = prefix.length === 0 ? f.name : `${prefix}.${f.name}`;
    // A @xmlText field reads the element's text body (carried under the #text sentinel when the
    // element also has attributes), not a same-named child element.
    const present = f.textContent === true ? raw[TEXT_KEY] : lookup(raw, f.name, ci);
    if (present === undefined) {
      // FR-011 / Phase B: an absent field with a declared @default fills the value → DEFAULTED
      // (which satisfies a @required field). Generalized to all field kinds: an enum default is
      // its member string as-is; a non-enum default is coerced to the field's kind via the pure
      // scalar coerce (so @default "0" on field.int yields integer 0). A non-coercible non-enum
      // default is treated as no default.
      if (f.defaultValue != null) {
        const coerced =
          f.kind === FieldKind.ENUM ? f.defaultValue : scalarCoerce(f.defaultValue, f);
        if (coerced !== MALFORMED) {
          data[f.name] = coerced;
          report.addCoercion({ fieldPath: path, from: "", to: f.defaultValue, kind: "default" });
          report.set(path, FieldExtraction.DEFAULTED);
          continue;
        }
      }
      report.set(path, f.required ? FieldExtraction.LOST_REQUIRED : FieldExtraction.LOST_OPTIONAL);
      continue;
    }
    if (present === TRUNCATED) {
      // present-but-garbled (empty/cut-off value)
      report.set(path, FieldExtraction.MALFORMED);
      continue;
    }
    if (present === NULL_LITERAL) {
      // The JSON null literal is the caller's explicit "no value": leave the field null
      // (do NOT apply @default — an explicit null is a value, not an omission), matching a
      // standard JSON bind. Without this the bare `null` token leaks as the string "null".
      report.set(path, f.required ? FieldExtraction.LOST_REQUIRED : FieldExtraction.LOST_OPTIONAL);
      continue;
    }
    if (f.array) {
      // An array field: a single non-list value is treated as a one-element array
      // (e.g. a single repeated-XML tag). Each element is coerced/recursed independently.
      const elements: unknown[] = Array.isArray(present) ? present : [present];
      const out: unknown[] = [];
      let anyMalformed = false;
      // Phase B (array-of-enum): an enum element flows through the SAME enum coercion pipeline a
      // scalar enum uses (extractValue → coerceValue → coerceEnum), and is CLASSIFIED per element
      // by indexed path (tags[0], tags[1], …) exactly as a scalar enum: EXTRACTED / DEFAULTED (via
      // @coerceDefault) / MALFORMED. Non-enum scalar arrays keep their existing behavior (raw
      // element list, no per-element states).
      const enumElements = f.kind === FieldKind.ENUM;
      for (let idx = 0; idx < elements.length; idx++) {
        const elemPath = `${path}[${idx}]`;
        const v = extractValue(f, elements[idx], elemPath, report, o, ci);
        if (v === MALFORMED) {
          anyMalformed = true;
          if (enumElements) report.set(elemPath, FieldExtraction.MALFORMED);
        } else {
          out.push(v);
          if (enumElements) report.set(elemPath, classifyCoerced(elemPath, report));
        }
      }
      // Cross-port contract: a MALFORMED array still places its successfully-coerced
      // elements into data (partial extraction), UNLIKE a MALFORMED scalar which is absent.
      data[f.name] = out;
      report.set(path, anyMalformed ? FieldExtraction.MALFORMED : FieldExtraction.EXTRACTED);
      continue;
    }
    if (Array.isArray(present)) {
      // a list where a singular value was expected
      report.set(path, FieldExtraction.MALFORMED);
      continue;
    }
    const v = extractValue(f, present, path, report, o, ci);
    if (v === MALFORMED) {
      report.set(path, FieldExtraction.MALFORMED);
    } else {
      data[f.name] = v;
      // FR-011: a value reached via @coerceDefault (or @default) is DEFAULTED, not EXTRACTED.
      report.set(path, classifyCoerced(path, report));
    }
  }
}

/**
 * FR-011: classify a successfully-coerced field. DEFAULTED when its terminal (last-logged)
 * coercion for this path is a default-class fallback; EXTRACTED otherwise. Nested objects
 * (which log no coercion of their own) classify as EXTRACTED.
 */
function classifyCoerced(path: string, report: ExtractionReport): FieldExtraction {
  let terminalKind: string | null = null;
  for (const c of report.coercions()) if (c.fieldPath === path) terminalKind = c.kind;
  return terminalKind === "coerceDefault" || terminalKind === "default"
    ? FieldExtraction.DEFAULTED
    : FieldExtraction.EXTRACTED;
}

/** Coerce one (non-array) element: nested-object recursion or scalar coercion. Returns MALFORMED on failure. */
function extractValue(
  f: FieldSpec,
  present: unknown,
  path: string,
  report: ExtractionReport,
  o: ExtractOptions,
  ci: boolean,
): unknown | typeof MALFORMED {
  if (present === NULL_LITERAL) {
    // A JSON null array element (e.g. [1, null, 3]) carries no value → drop it as malformed
    // rather than letting the sentinel stringify.
    return MALFORMED;
  }
  if (f.kind === FieldKind.OBJECT) {
    if (f.nested != null && isPlainObject(present)) {
      const nestedData: Record<string, unknown> = {};
      extractFields(f.nested.fields, present as Record<string, unknown>, path, nestedData, report, o, ci);
      return nestedData;
    }
    return MALFORMED; // object expected but scalar/non-map present
  }
  // A text element that also carried XML attributes is represented by readXml as a record with
  // the body under TEXT_KEY. A scalar field reads that text (attributes ignored for scalars —
  // preserving pre-attribute-support behaviour).
  if (isPlainObject(present) && Object.prototype.hasOwnProperty.call(present, TEXT_KEY)) {
    present = (present as Record<string, unknown>)[TEXT_KEY];
  }
  const rawStr = typeof present === "string" ? present : stringifyScalar(present);
  return coerceValue(rawStr, f, o, path, report);
}

/** Case-folding lookup honoring tolerance. Returns `undefined` for absent (mirrors Java null). */
function lookup(raw: Record<string, unknown>, name: string, ci: boolean): unknown {
  if (Object.prototype.hasOwnProperty.call(raw, name)) return raw[name];
  if (ci) {
    const lower = name.toLowerCase();
    for (const k of Object.keys(raw)) if (k.toLowerCase() === lower) return raw[k];
  }
  return undefined;
}

function isPlainObject(o: unknown): boolean {
  return typeof o === "object" && o !== null && !Array.isArray(o);
}

function isEmptyRecord(o: Record<string, unknown>): boolean {
  return Object.keys(o).length === 0;
}

/** Mirror Java String.valueOf for non-string forgiving-reader scalars. */
function stringifyScalar(v: unknown): string {
  return String(v);
}
