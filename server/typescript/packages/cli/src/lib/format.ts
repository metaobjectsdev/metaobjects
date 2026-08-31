import { encode } from "@toon-format/toon";

export type OutputFormat = "toon" | "json" | "text";

const VALID = new Set<OutputFormat>(["toon", "json", "text"]);

/** Valid --format values, for usage messages. */
export const VALID_FORMATS: readonly OutputFormat[] = ["toon", "json", "text"];

/** True iff `flag` is one of the recognized output formats. */
export function isValidFormat(flag: string): flag is OutputFormat {
  return VALID.has(flag as OutputFormat);
}

export function resolveFormat(flag: string | undefined, isTTY: boolean): OutputFormat {
  if (flag && VALID.has(flag as OutputFormat)) return flag as OutputFormat;
  // TTY-aware default: humans at a terminal get text; pipes/agents get TOON.
  return isTTY ? "text" : "toon";
}

export function toonEncode(value: unknown): string {
  return encode(value);
}

/**
 * Put ONE machine-readable document on stdout in the active structured format.
 *
 * Text format writes nothing here — its human rendering is the caller's job, and a
 * command in text mode has already printed it. Callers in a structured format must
 * keep every prose line off stdout (route narration to stderr): a document with a
 * sentence in front of it breaks `| jq` outright. `meta migrate`'s
 * `emitStructuredError` is the same split, made command-locally before this existed.
 */
export function emitStructured(payload: unknown, fmt: OutputFormat): void {
  if (fmt === "json") console.log(JSON.stringify(payload, null, 2));
  else if (fmt === "toon") console.log(toonEncode(payload));
}
