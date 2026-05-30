// FR-011: enum-variant normalization for the Coerce stage.
// ASCII-only by design: enum members are ASCII identifiers, so a pure [A-Za-z0-9]
// transform is byte-identical across ports and sidesteps locale case-folding (Turkish-İ).
// Mode comes from the @normalize attr (none|collapse|strip; default strip).

export type NormalizeMode = "none" | "collapse" | "strip";

/** ASCII-only enum normalization. Pure [A-Za-z0-9] transform → byte-identical cross-port. */
export function normalizeEnum(s: string, mode: NormalizeMode): string {
  if (mode === "none") return s;
  const up = asciiUpper(s.trim());
  if (mode === "collapse") return up.replace(/[\s_-]+/g, "_");
  return up.replace(/[^A-Z0-9]/g, ""); // strip
}

function asciiUpper(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 97 && c <= 122 ? String.fromCharCode(c - 32) : s[i];
  }
  return out;
}
