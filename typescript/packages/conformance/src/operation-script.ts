// The script.json schema — operation-script fixtures (spec §2).

import type { NormalizedResult } from "./result.js";

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
