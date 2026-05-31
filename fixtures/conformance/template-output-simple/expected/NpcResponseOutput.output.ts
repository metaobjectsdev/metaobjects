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
import type { MetaRoot } from "@metaobjectsdev/metadata";
import { recoverObject } from "@metaobjectsdev/runtime-ts";

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
 * Self-contained tolerant best-effort recovery of a dirty LLM response; never throws.
 * Returns a nullable mirror (`NpcResponseOutputRecovered`) with fields null where lost/malformed,
 * plus the per-field recovery report. Does NOT populate nested-object / array-of-object
 * components (those stay null — the historical FR-010 gap). For full nested recovery, use
 * `recoverNpcResponseOutputWithLoader(root, text)`, which delegates to the runtime recover.
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


/** Payload value-object name this parser recovers — resolved against a loaded MetaRoot at runtime. */
export const NPCRESPONSEOUTPUT_PAYLOAD_NAME = "NpcResponsePayload";

/** Map an assembled ValueObject graph into a typed `NpcResponseOutputRecovered` mirror. Generated; null-tolerant. */
function fromNpcResponseOutputRecovered(o: unknown): NpcResponseOutputRecovered | null {
  if (o == null) return null;
  return {
    name: dlgString(readProp(o, "name")),
    age: dlgInt(readProp(o, "age")),
  };
}

// ---- runtime-delegating recover helpers (generated) ----

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
 * Runtime-delegating tolerant recovery; never throws. Unlike `recoverNpcResponseOutput(text)`, this FULLY
 * populates nested-object and array-of-object components by delegating to the metadata-driven
 * runtime `recoverObject` (which assembles the whole graph reflection-free via the Phase A object
 * model), then maps the assembled graph into the typed `NpcResponseOutputRecovered` mirror.
 *
 * @param root a loaded MetaRoot (e.g. `(await new MetaDataLoader().load(...)).root`) that declares
 *             the `NpcResponsePayload` value-object.
 */
export function recoverNpcResponseOutputWithLoader(
  root: MetaRoot,
  text: string,
  opts?: Partial<RecoverOptions> | null,
): RecoveryResult<NpcResponseOutputRecovered> {
  const mo = root.findObject(NPCRESPONSEOUTPUT_PAYLOAD_NAME);
  if (mo === undefined) {
    throw new Error(`recoverNpcResponseOutputWithLoader: payload "${NPCRESPONSEOUTPUT_PAYLOAD_NAME}" not found in the supplied MetaRoot`);
  }
  const outcome = recoverObject(mo, text, Format.JSON, opts);
  return { data: fromNpcResponseOutputRecovered(outcome.data), report: outcome.report };
}
