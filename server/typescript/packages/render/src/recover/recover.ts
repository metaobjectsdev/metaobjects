// Public entry point. Runs the staged pipeline; NEVER throws. Mirrors Java Recover.

import {
  Format,
  FieldKind,
  FieldRecovery,
  Tolerance,
  normalizeOptions,
} from "./types.js";
import type { FieldSpec, RecoverOptions, RecoverOutcome, RecoverSchema } from "./types.js";
import { RecoveryReport } from "./types.js";
import { strip } from "./strip.js";
import { locateJson, locateXml } from "./locate.js";
import { readJson, TRUNCATED } from "./json-forgiving-reader.js";
import { readXml } from "./xml-forgiving-reader.js";
import { coerceValue, MALFORMED } from "./coerce.js";

/** The forgiving entry point: recover dirty `text` against `schema`. Never throws. */
export function recover(
  text: string | null | undefined,
  schema: RecoverSchema,
  opts?: Partial<RecoverOptions> | null,
): RecoverOutcome {
  const o = normalizeOptions(opts);
  const report = new RecoveryReport();
  const data: Record<string, unknown> = {};

  const stripped = strip(text);
  const ci = o.tolerance !== Tolerance.STRICT;

  const span =
    schema.format === Format.JSON ? locateJson(stripped) : locateXml(stripped, schema.rootName, ci);

  let raw: Record<string, unknown>;
  if (span == null) {
    raw = {};
  } else if (schema.format === Format.JSON) {
    raw = readJson(span);
  } else {
    raw = readXml(span, ci);
  }

  if (isEmptyRecord(raw) && (stripped.length === 0 || span == null)) {
    report.markEmpty();
  }

  extract(schema.fields, raw, "", data, report, o, ci);
  return { data, report };
}

function extract(
  fields: readonly FieldSpec[],
  raw: Record<string, unknown>,
  prefix: string,
  data: Record<string, unknown>,
  report: RecoveryReport,
  o: RecoverOptions,
  ci: boolean,
): void {
  for (const f of fields) {
    const path = prefix.length === 0 ? f.name : `${prefix}.${f.name}`;
    const present = lookup(raw, f.name, ci);
    if (present === undefined) {
      report.set(path, f.required ? FieldRecovery.LOST_REQUIRED : FieldRecovery.LOST_OPTIONAL);
      continue;
    }
    if (present === TRUNCATED) {
      // present-but-garbled (empty/cut-off value)
      report.set(path, FieldRecovery.MALFORMED);
      continue;
    }
    if (f.array) {
      // An array field: a single non-list value is treated as a one-element array
      // (e.g. a single repeated-XML tag). Each element is coerced/recursed independently.
      const elements: unknown[] = Array.isArray(present) ? present : [present];
      const out: unknown[] = [];
      let anyMalformed = false;
      for (let idx = 0; idx < elements.length; idx++) {
        const v = extractValue(f, elements[idx], `${path}[${idx}]`, report, o, ci);
        if (v === MALFORMED) anyMalformed = true;
        else out.push(v);
      }
      // Cross-port contract: a MALFORMED array still places its successfully-coerced
      // elements into data (partial recovery), UNLIKE a MALFORMED scalar which is absent.
      data[f.name] = out;
      report.set(path, anyMalformed ? FieldRecovery.MALFORMED : FieldRecovery.RECOVERED);
      continue;
    }
    if (Array.isArray(present)) {
      // a list where a singular value was expected
      report.set(path, FieldRecovery.MALFORMED);
      continue;
    }
    const v = extractValue(f, present, path, report, o, ci);
    if (v === MALFORMED) {
      report.set(path, FieldRecovery.MALFORMED);
    } else {
      data[f.name] = v;
      report.set(path, FieldRecovery.RECOVERED);
    }
  }
}

/** Coerce one (non-array) element: nested-object recursion or scalar coercion. Returns MALFORMED on failure. */
function extractValue(
  f: FieldSpec,
  present: unknown,
  path: string,
  report: RecoveryReport,
  o: RecoverOptions,
  ci: boolean,
): unknown | typeof MALFORMED {
  if (f.kind === FieldKind.OBJECT) {
    if (f.nested != null && isPlainObject(present)) {
      const nestedData: Record<string, unknown> = {};
      extract(f.nested.fields, present as Record<string, unknown>, path, nestedData, report, o, ci);
      return nestedData;
    }
    return MALFORMED; // object expected but scalar/non-map present
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
