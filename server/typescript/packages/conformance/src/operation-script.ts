// The script.json schema — operation-script fixtures (spec §2).

import type { NormalizedResult } from "./result.js";

/**
 * One entry in the post-FR5a expected-errors.json envelope. `source` is the
 * minimum cross-port-asserted shape (ADR-0009): `format`, `files`, `jsonPath`.
 * Other envelope fields (suggestions, fixture, node, yamlPosition, ...) are
 * RECOMMENDED-only and not enforced by the cross-port harness.
 */
export interface ExpectedErrorSource {
  readonly format: string;
  readonly files: readonly string[];
  readonly jsonPath?: string;
}

export interface ExpectedError {
  readonly code: string;
  /** Present in the FR5a envelope shape; absent in legacy `[{code}]` form. */
  readonly source?: ExpectedErrorSource;
}

export interface ExpectedErrorsEnvelope {
  readonly errors: readonly ExpectedError[];
  readonly warnings: readonly unknown[];
  /** True when the file used the legacy `[{code}]` array shape (no source). */
  readonly legacy: boolean;
}

function parseSource(raw: unknown, i: number): ExpectedErrorSource | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`expected-errors.json entry ${i}: 'source' is not an object`);
  }
  const r = raw as Record<string, unknown>;
  const { format, files, jsonPath } = r;
  if (typeof format !== "string") {
    throw new Error(`expected-errors.json entry ${i}: 'source.format' must be a string`);
  }
  if (!Array.isArray(files) || !files.every((f) => typeof f === "string")) {
    throw new Error(`expected-errors.json entry ${i}: 'source.files' must be a string[]`);
  }
  if (jsonPath !== undefined && typeof jsonPath !== "string") {
    throw new Error(`expected-errors.json entry ${i}: 'source.jsonPath' must be a string`);
  }
  const out: ExpectedErrorSource = jsonPath !== undefined
    ? { format, files: files as string[], jsonPath }
    : { format, files: files as string[] };
  return out;
}

/**
 * Parse + validate a parsed expected-errors.json value.
 *
 * Accepts both shapes:
 *  - **Legacy** (`[{code}]`) — pre-FR5a; no source assertion.
 *  - **FR5a envelope** (`{ errors: [{code, source}], warnings: [] }`) —
 *    ADR-0009 shape; source asserted by the cross-port harness.
 *
 * Throws a clear Error if `raw` matches neither shape. Mirrors the validation
 * style of `parseOperationScript`.
 */
export function parseExpectedErrors(raw: unknown): ExpectedErrorsEnvelope {
  // Legacy shape — plain array of `{code}`.
  if (Array.isArray(raw)) {
    const errors = raw.map((item, i): ExpectedError => {
      if (typeof item !== "object" || item === null) {
        throw new Error(`expected-errors.json entry ${i} is not an object`);
      }
      const { code } = item as Record<string, unknown>;
      if (typeof code !== "string") {
        throw new Error(`expected-errors.json entry ${i} missing string 'code' field`);
      }
      return { code };
    });
    return { errors, warnings: [], legacy: true };
  }
  // FR5a envelope shape — `{ errors: [...], warnings: [...] }`.
  if (typeof raw !== "object" || raw === null) {
    throw new Error("expected-errors.json must be either an array (legacy) or an object with 'errors'");
  }
  const env = raw as Record<string, unknown>;
  const rawErrors = env.errors;
  if (!Array.isArray(rawErrors)) {
    throw new Error("expected-errors.json: 'errors' must be an array");
  }
  const errors = rawErrors.map((item, i): ExpectedError => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`expected-errors.json entry ${i} is not an object`);
    }
    const r = item as Record<string, unknown>;
    if (typeof r.code !== "string") {
      throw new Error(`expected-errors.json entry ${i} missing string 'code' field`);
    }
    const source = parseSource(r.source, i);
    return source !== undefined ? { code: r.code, source } : { code: r.code };
  });
  const warnings = Array.isArray(env.warnings) ? env.warnings : [];
  return { errors, warnings, legacy: false };
}

/** capability-id grammar: `<type>.<capability>`, both kebab-case. */
const CAPABILITY_ID = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

export interface Operation {
  /** Path segments `type:name` (or `type[subType]` for nameless nodes). */
  readonly navigate: string[];
  /** A capability-id. */
  readonly invoke: string;
  /** Optional flat map of scalar arguments. */
  readonly args?: Record<string, string | number | boolean>;
  /** The expected normalized result. */
  readonly expect: NormalizedResult;
}

export interface OperationScript {
  readonly operations: Operation[];
}

/** Parse + validate a parsed script.json object. Throws on a malformed script. */
export function parseOperationScript(raw: unknown): OperationScript {
  if (typeof raw !== "object" || raw === null || !("operations" in raw)) {
    throw new Error("script.json must be an object with an 'operations' key");
  }
  const ops = (raw as { operations: unknown }).operations;
  if (!Array.isArray(ops)) throw new Error("script.json 'operations' must be an array");

  const operations = ops.map((op, i) => {
    if (typeof op !== "object" || op === null) {
      throw new Error(`operation ${i} is not an object`);
    }
    const o = op as Record<string, unknown>;
    if (!Array.isArray(o.navigate)) throw new Error(`operation ${i}: 'navigate' must be an array`);
    if (typeof o.invoke !== "string") throw new Error(`operation ${i}: 'invoke' is required`);
    if (!CAPABILITY_ID.test(o.invoke)) {
      throw new Error(`operation ${i}: malformed capability-id '${o.invoke}'`);
    }
    if (typeof o.expect !== "object" || o.expect === null) {
      throw new Error(`operation ${i}: 'expect' is required`);
    }
    const base = {
      navigate: o.navigate as string[],
      invoke: o.invoke,
      expect: o.expect as NormalizedResult,
    } satisfies Omit<Operation, "args">;
    if (o.args !== undefined) {
      return { ...base, args: o.args as NonNullable<Operation["args"]> } satisfies Operation;
    }
    return base satisfies Operation;
  });
  return { operations };
}
