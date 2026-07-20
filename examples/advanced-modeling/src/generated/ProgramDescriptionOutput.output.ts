import { z } from "zod";

const ProgramDescriptionOutputSchema = z.object({
  title: z.string(),
  summary: z.string(),
  authorName: z.string(),
  lessonCount: z.number().int(),
});

export type ProgramDescriptionOutputData = z.infer<typeof ProgramDescriptionOutputSchema>;
export type ProgramDescriptionOutputValidationError = z.ZodError;

/**
 * Parse an LLM response into a typed ProgramDescriptionOutputData.
 * @throws ZodError on validation failure.
 */
export function parseProgramDescriptionOutput(text: string): ProgramDescriptionOutputData {
  return ProgramDescriptionOutputSchema.parse(JSON.parse(text));
}

/**
 * Parse an LLM response with explicit error handling (Result-style).
 * Does not throw on validation failure.
 */
export function safeParseProgramDescriptionOutput(
  text: string,
): { success: true; data: ProgramDescriptionOutputData } | { success: false; error: ProgramDescriptionOutputValidationError } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      success: false,
      error: new z.ZodError([{ code: "custom", path: [], message: `invalid JSON: ${(err as Error).message}` }]),
    };
  }
  const result = ProgramDescriptionOutputSchema.safeParse(parsed);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, error: result.error };
}
