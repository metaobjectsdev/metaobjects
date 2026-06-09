import { z } from "zod";
import {
  Format,
  type ExtractOptions,
  type ExtractionResult,
} from "@metaobjectsdev/render";
import type { MetaRoot } from "@metaobjectsdev/metadata";
import { extractObject } from "@metaobjectsdev/runtime-ts";

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


/** Payload value-object name this parser extracts — resolved against a loaded MetaRoot at runtime. */
export const NPCRESPONSEOUTPUT_PAYLOAD_NAME = "NpcResponsePayload";

/** Best-effort extracted twin of `NpcResponseOutput` — every field nullable (null where lost/malformed). */
export interface NpcResponseOutputExtracted {
  name: string | null;
  age: number | null;
}

/** Map an assembled ValueObject graph into a typed `NpcResponseOutputExtracted` mirror. Generated; null-tolerant. */
function fromNpcResponseOutputExtracted(o: unknown): NpcResponseOutputExtracted | null {
  if (o == null) return null;
  return {
    name: dlgString(readProp(o, "name")),
    age: dlgInt(readProp(o, "age")),
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

function dlgInt(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Runtime-delegating tolerant best-effort extraction; never throws. FULLY populates
 * nested-object and array-of-object components by delegating to the metadata-driven runtime
 * `extractObject` (which assembles the whole graph reflection-free via the Phase A object
 * model, reading the live metadata directly), then maps the assembled graph into the typed
 * `NpcResponseOutputExtracted` mirror.
 *
 * @param root a loaded MetaRoot (e.g. `(await new MetaDataLoader().load(...)).root`) that declares
 *             the `NpcResponsePayload` value-object.
 */
export function extractLenientNpcResponseOutputWithLoader(
  root: MetaRoot,
  text: string,
  opts?: Partial<ExtractOptions> | null,
): ExtractionResult<NpcResponseOutputExtracted> {
  const mo = root.findObject(NPCRESPONSEOUTPUT_PAYLOAD_NAME);
  if (mo === undefined) {
    throw new Error(`extractLenientNpcResponseOutputWithLoader: payload "${NPCRESPONSEOUTPUT_PAYLOAD_NAME}" not found in the supplied MetaRoot`);
  }
  const outcome = extractObject(mo, text, Format.JSON, opts);
  return { data: fromNpcResponseOutputExtracted(outcome.data), report: outcome.report };
}
