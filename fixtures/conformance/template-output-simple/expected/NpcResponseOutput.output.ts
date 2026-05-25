import { z } from "zod";
import type { NpcResponsePayload } from "./payloads.js";

const NpcResponseOutputSchema = z.object({
    name: z.string(),
    age: z.number().int(),
  });

export type NpcResponseOutputValidationError = z.ZodError;

/**
 * Parse an LLM response into a typed NpcResponsePayload.
 * @throws ZodError on validation failure.
 */
export function parseNpcResponseOutput(text: string): NpcResponsePayload {
  return NpcResponseOutputSchema.parse(JSON.parse(text)) as NpcResponsePayload;
}

/**
 * Parse an LLM response with explicit error handling (Result-style).
 * Does not throw on validation failure.
 */
export function safeParseNpcResponseOutput(
  text: string,
): { success: true; data: NpcResponsePayload } | { success: false; error: NpcResponseOutputValidationError } {
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
    ? { success: true, data: result.data as NpcResponsePayload }
    : { success: false, error: result.error };
}
