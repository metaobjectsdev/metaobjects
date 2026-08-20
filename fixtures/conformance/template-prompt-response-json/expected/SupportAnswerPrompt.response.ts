import { z } from "zod";
import {
  Format,
  type ExtractOptions,
  type ExtractionResult,
} from "@metaobjectsdev/render";
import type { MetaRoot } from "@metaobjectsdev/metadata";
import { extractObject } from "@metaobjectsdev/runtime-ts";

const SupportAnswerPromptSchema = z.object({
  text: z.string(),
  confidence: z.unknown(),
  note: z.string().optional(),
});

export type SupportAnswerPromptData = z.infer<typeof SupportAnswerPromptSchema>;
export type SupportAnswerPromptValidationError = z.ZodError;

/**
 * Parse an LLM response into a typed SupportAnswerPromptData.
 * @throws ZodError on validation failure.
 */
export function parseSupportAnswerPrompt(text: string): SupportAnswerPromptData {
  return SupportAnswerPromptSchema.parse(JSON.parse(text));
}

/**
 * Parse an LLM response with explicit error handling (Result-style).
 * Does not throw on validation failure.
 */
export function safeParseSupportAnswerPrompt(
  text: string,
): { success: true; data: SupportAnswerPromptData } | { success: false; error: SupportAnswerPromptValidationError } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      success: false,
      error: new z.ZodError([{ code: "custom", path: [], message: `invalid JSON: ${(err as Error).message}` }]),
    };
  }
  const result = SupportAnswerPromptSchema.safeParse(parsed);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, error: result.error };
}


/** Payload value-object name this parser extracts — resolved against a loaded MetaRoot at runtime. */
export const SUPPORTANSWERPROMPT_PAYLOAD_NAME = "SupportAnswer";

/** Best-effort extracted twin of `SupportAnswerPrompt` — every field nullable (null where lost/malformed). */
export interface SupportAnswerPromptExtracted {
  text: string | null;
  confidence: string | null;
  note: string | null;
}

/** Map an assembled ValueObject graph into a typed `SupportAnswerPromptExtracted` mirror. Generated; null-tolerant. */
function fromSupportAnswerPromptExtracted(o: unknown): SupportAnswerPromptExtracted | null {
  if (o == null) return null;
  return {
    text: dlgString(readProp(o, "text")),
    confidence: dlgString(readProp(o, "confidence")),
    note: dlgString(readProp(o, "note")),
  };
}

// ---- runtime-delegating extract helpers (generated) ----

/** Read a property from an assembled backing object, mirroring the MetaField getValue SPI. */
function readProp(o: unknown, name: string): unknown {
  if (o == null) return undefined;
  const vo = o as { get?: (n: string) => unknown };
  if (typeof vo.get === "function") return vo.get(name);
  return (o as Record<string, unknown>)[name];
}

function dlgString(v: unknown): string | null {
  return v == null ? null : String(v);
}

/**
 * Runtime-delegating tolerant best-effort extraction; never throws. FULLY populates
 * nested-object and array-of-object components by delegating to the metadata-driven runtime
 * `extractObject` (which assembles the whole graph reflection-free via the Phase A object
 * model, reading the live metadata directly), then maps the assembled graph into the typed
 * `SupportAnswerPromptExtracted` mirror.
 *
 * @param root a loaded MetaRoot (e.g. `(await new MetaDataLoader().load(...)).root`) that declares
 *             the `SupportAnswer` value-object.
 */
export function extractLenientSupportAnswerPromptWithLoader(
  root: MetaRoot,
  text: string,
  opts?: Partial<ExtractOptions> | null,
): ExtractionResult<SupportAnswerPromptExtracted> {
  const mo = root.findObject(SUPPORTANSWERPROMPT_PAYLOAD_NAME);
  if (mo === undefined) {
    throw new Error(`extractLenientSupportAnswerPromptWithLoader: payload "${SUPPORTANSWERPROMPT_PAYLOAD_NAME}" not found in the supplied MetaRoot`);
  }
  const outcome = extractObject(mo, text, Format.JSON, opts);
  return { data: fromSupportAnswerPromptExtracted(outcome.data), report: outcome.report };
}
