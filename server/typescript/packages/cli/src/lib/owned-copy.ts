// How an OWNED generator copy compares to the reference template this CLI ships.
//
// ADR-0034 hands an adopter a file and then never speaks about it again, so `meta
// eject` and `meta eject --list` are the only places that condition is ever observable.
// The first version of this compared BYTES and counted lines the copy had that the
// reference did not. On a project that runs its own formatter over the code it owns —
// which is most of them, and it is the whole point that these are ordinary files in
// their repo — that answer is useless: every copy reads DIFFERS forever, and the count
// is dominated by re-wrapping and import sorting rather than by anything anyone wrote.
// One adopter estate had all of its owned copies reporting double-digit differences
// while being, in content, exactly the reference.
//
// So the comparison is made on a CANONICAL form instead, and the verdict grew a third
// value — `reformatted`, meaning "same content, your layout". The canonical form is
// produced by re-formatting both sides through the SAME formatter, deliberately at
// `lineWidth: 1` so every construct explodes onto its own line, then sorting those
// lines. That composition is what makes it survive each way a formatter rewrites a
// file without changing it:
//
//   indentation, wrapping, quote style, semicolons  → the formatter normalizes them
//   trailing commas                                 → `trailingCommas: "none"` + the
//                                                     per-line strip below (reordering
//                                                     a list moves which member is last)
//   import statement AND specifier order            → exploded one per line, then sorted
//
// The cost is deliberate and stated: sorting lines also makes the comparison blind to
// a pure REORDERING of real code. That is the right trade for a report line whose job
// is "have you fallen behind upstream" — a reorder with no content change is not
// staleness — and every message that carries this verdict also prints the `diff`
// command, which is not blind to anything.
//
// Fail-safe: if the formatter is unavailable or rejects the input (an adopter's copy is
// theirs and may not even parse), canonicalization degrades to trimmed raw lines. The
// verdict then reads `differs` where it might have read `reformatted` — the pre-existing
// behaviour, never a false `reformatted`.
import { Biome, Distribution } from "@biomejs/js-api";

export type OwnedVerdict =
  /** Byte-for-byte the reference. */
  | "identical"
  /** Same content, different layout — a formatter ran over it, nothing else. */
  | "reformatted"
  /** Genuine content difference: your edits, upstream's, or both. */
  | "differs";

export interface OwnedComparison {
  verdict: OwnedVerdict;
  /** Canonical lines the COPY has that the reference does not — your edits, and what
   *  `--force` would destroy. */
  localOnly: number;
  /** Canonical lines the REFERENCE has that the copy does not — how far behind it is. */
  referenceOnly: number;
}

// One instance, created lazily and shared. Cache the PROMISE so concurrent first calls
// (--list compares every owned copy) share one in-flight create rather than racing.
let _biome: Promise<Biome | undefined> | undefined;

function getBiome(): Promise<Biome | undefined> {
  if (!_biome) {
    _biome = Biome.create({ distribution: Distribution.NODE })
      .then((biome) => {
        biome.applyConfiguration({
          formatter: { enabled: true, indentStyle: "space", indentWidth: 2, lineWidth: 1 },
          javascript: { formatter: { quoteStyle: "double", semicolons: "always", trailingCommas: "none" } },
        });
        return biome;
      })
      // A comparison is a REPORT LINE. If the formatter cannot start, say less — never
      // fail the command the adopter actually ran.
      .catch(() => undefined);
  }
  return _biome;
}

/** The canonical line multiset of one file, sorted. Exported for the tests that pin
 *  each formatter-insensitivity claim above against real reformatted input. */
export async function canonicalLines(src: string): Promise<string[]> {
  let text = src;
  const biome = await getBiome();
  if (biome !== undefined) {
    try {
      const result = biome.formatContent(src, { filePath: "in-memory.ts" });
      if (result.diagnostics.length === 0) text = result.content;
    } catch {
      /* keep the raw text — see the fail-safe note above */
    }
  }
  return text
    .split("\n")
    // The trailing-comma strip is per LINE and only meaningful because every construct
    // is already on its own line: reordering an import list changes which specifier is
    // last, and only the last one lacks a comma.
    .map((l) => l.trim().replace(/,$/, ""))
    .filter((l) => l !== "")
    .sort();
}

/** How many members of `a` are not in `b`, counting duplicates. */
function countMissing(a: string[], b: string[]): number {
  const remaining = new Map<string, number>();
  for (const l of b) remaining.set(l, (remaining.get(l) ?? 0) + 1);
  let missing = 0;
  for (const l of a) {
    const n = remaining.get(l) ?? 0;
    if (n > 0) remaining.set(l, n - 1);
    else missing++;
  }
  return missing;
}

export async function compareOwnedCopy(owned: string, reference: string): Promise<OwnedComparison> {
  if (owned === reference) return { verdict: "identical", localOnly: 0, referenceOnly: 0 };
  const [a, b] = await Promise.all([canonicalLines(owned), canonicalLines(reference)]);
  const localOnly = countMissing(a, b);
  const referenceOnly = countMissing(b, a);
  return {
    verdict: localOnly === 0 && referenceOnly === 0 ? "reformatted" : "differs",
    localOnly,
    referenceOnly,
  };
}
