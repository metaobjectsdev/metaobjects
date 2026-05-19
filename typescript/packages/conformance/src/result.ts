// The normalized result vocabulary — the closed set of shapes an `expect`
// (and an adapter's result-normalizer) may produce. See spec §2.

export type NormalizedResult =
  | { names: string[] }
  | { name: string }
  | { absent: true }
  | { scalar: string | number | boolean | null }
  | { subtype: string }
  | { "effective-tree": string }
  | { error: { code: string } };

/** Structural equality over the normalized result vocabulary. */
export function resultsEqual(a: NormalizedResult, b: NormalizedResult): boolean {
  if ("names" in a && "names" in b) {
    return a.names.length === b.names.length
      && a.names.every((n, i) => n === b.names[i]);
  }
  if ("name" in a && "name" in b) return a.name === b.name;
  if ("absent" in a && "absent" in b) return true;
  if ("scalar" in a && "scalar" in b) return a.scalar === b.scalar;
  if ("subtype" in a && "subtype" in b) return a.subtype === b.subtype;
  if ("effective-tree" in a && "effective-tree" in b) {
    return a["effective-tree"] === b["effective-tree"];
  }
  if ("error" in a && "error" in b) return a.error.code === b.error.code;
  return false;
}
