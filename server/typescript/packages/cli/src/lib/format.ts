import { encode } from "@toon-format/toon";

export type OutputFormat = "toon" | "json" | "text";

const VALID = new Set<OutputFormat>(["toon", "json", "text"]);

export function resolveFormat(flag: string | undefined, isTTY: boolean): OutputFormat {
  if (flag && VALID.has(flag as OutputFormat)) return flag as OutputFormat;
  // TTY-aware default: humans at a terminal get text; pipes/agents get TOON.
  return isTTY ? "text" : "toon";
}

export function toonEncode(value: unknown): string {
  return encode(value);
}
