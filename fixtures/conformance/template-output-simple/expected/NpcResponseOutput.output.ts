import { z } from "zod";
import {
  recover,
  recoverSchema,
  Format,
  scalar,
  FieldKind,
  type RecoverSchema,
  type RecoverOptions,
  type RecoveryResult,
  asInt,
  asString,
} from "@metaobjectsdev/render";

const NpcResponseOutputSchema = z.object({
  name: z.string(),
  age: z.number().int(),
});

export type NpcResponseOutputData = z.infer<typeof NpcResponseOutputSchema>;
export type NpcResponseOutputValidationError = z.ZodError;

/**
 * Parse an LLM response into a typed NpcResponseOutputData.
 * @throws ZodError on validation failure.
 */
export function parseNpcResponseOutput(text: string): NpcResponseOutputData {
  return NpcResponseOutputSchema.parse(JSON.parse(text));
}

/**
 * Parse an LLM response with explicit error handling (Result-style).
 * Does not throw on validation failure.
 */
export function safeParseNpcResponseOutput(
  text: string,
): { success: true; data: NpcResponseOutputData } | { success: false; error: NpcResponseOutputValidationError } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      success: false,
      error: new z.ZodError([{ code: "custom", path: [], message: `invalid JSON: ${(err as Error).message}` }]),
    };
  }
  const result = NpcResponseOutputSchema.safeParse(parsed);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, error: result.error };
}

/** Baked recover descriptor for the NpcResponseOutput output. */
const NpcResponseOutputRecoverSchema: RecoverSchema = recoverSchema(Format.JSON, "NpcResponsePayload", [scalar("name", FieldKind.STRING, false), scalar("age", FieldKind.INT, false)]);

/** Best-effort recovered twin of `NpcResponseOutput` — every field nullable (null where lost/malformed). */
export interface NpcResponseOutputRecovered {
  name: string | null;
  age: number | null;
}

/**
 * Tolerant best-effort recovery of a dirty LLM response; never throws. Returns a
 * nullable mirror (`NpcResponseOutputRecovered`) with fields null where lost/malformed,
 * plus the per-field recovery report.
 */
export function recoverNpcResponseOutput(
  text: string,
  opts?: RecoverOptions,
): RecoveryResult<NpcResponseOutputRecovered> {
  const outcome = recover(text, NpcResponseOutputRecoverSchema, opts);
  const d = outcome.data;
  const data: NpcResponseOutputRecovered = { name: asString(d, "name"), age: asInt(d, "age") };
  return { data, report: outcome.report };
}

/**
 * Recovery as a bool gate: `true` when the response was non-empty and no required
 * field was lost. On success, `result` carries the recovered mirror + report.
 */
export function tryRecoverNpcResponseOutput(
  text: string,
): { ok: boolean; result: RecoveryResult<NpcResponseOutputRecovered> } {
  const result = recoverNpcResponseOutput(text);
  const ok = !result.report.isEmpty() && !result.report.hasLostRequired();
  return { ok, result };
}
