// Validation pass: enum vocabularies that are ambiguous under `@normalize: strip`.
//
// Code:
//   WARN_ENUM_NORMALIZE_AMBIGUOUS — a field.enum whose @values contains a member
//     equal to the concatenation of two or more OTHER members once normalized.
//
// Why this is a real hazard. `strip` (the DEFAULT normalize mode) upper-cases and
// keeps only [A-Z0-9], so it erases every separator. That is what makes
// "SOCIAL-ATTACK" match the member SOCIAL_ATTACK — the behavior we want. But it
// also means a DELIMITED value collapses into one token, and if that token happens
// to equal another member, the extract engine coerces it successfully:
//
//   values = {READ, WRITE, READWRITE};  input "read|write"  ->  READWRITE
//
// The field is reported EXTRACTED (not MALFORMED) with a plausible, wrong value —
// wrong-and-green, the worst failure mode the engine can produce. A consumer
// branching on field state is misled.
//
// It is detectable from metadata alone, so we warn the author at declaration time
// rather than leaving it to be discovered in production.
//
// WARNING, not error: such a vocabulary is legal and completely unambiguous for
// exact matching — only normalize-based coercion is at risk, and the author may
// have no delimited input at all. The fix, when it matters, is `@normalize: collapse`.
//
// Mode gating: `collapse` folds only [\s_-]+ and `none` folds nothing, so neither
// can merge tokens across a delimiter like "|" — both are skipped.

import type { MetaData } from "../../shared/meta-data.js";
import type { LoaderWarning } from "../../source.js";
import { TYPE_FIELD } from "../../shared/base-types.js";
import { TYPE_OBJECT } from "../../shared/base-types.js";
import {
  FIELD_SUBTYPE_ENUM,
  FIELD_ATTR_VALUES,
  FIELD_ATTR_NORMALIZE,
  NORMALIZE_DEFAULT,
} from "./field-constants.js";

export interface EnumNormalizeAmbiguityResult {
  warnings: LoaderWarning[];
}

/**
 * `strip` normalization: ASCII upper-case, then keep only [A-Z0-9].
 * Mirrors the extract engine's Normalize.STRIP exactly — the two must agree or the
 * guard would warn about collisions the engine does not actually have (and miss
 * ones it does).
 */
function stripNormalize(s: string): string {
  let out = "";
  for (const ch of s.toUpperCase()) {
    if ((ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9")) out += ch;
  }
  return out;
}

/**
 * Word-break: can `target` be segmented into two or more entries of `dict`?
 * Returns the segmentation (the member names, in order) or undefined.
 *
 * Word-break rather than a pairwise scan so a three-way collision (A + B + C == ABC)
 * is caught too. O(len^2 * |dict|) — trivial at vocabulary sizes, and deterministic,
 * which matters because every port must produce the identical warning.
 */
function segmentInto(
  target: string,
  dict: ReadonlyArray<{ member: string; stripped: string }>,
): string[] | undefined {
  const n = target.length;
  // best[i] = the segmentation of target[0..i) with the FEWEST segments, or undefined.
  const best: (string[] | undefined)[] = new Array(n + 1).fill(undefined);
  best[0] = [];
  for (let i = 0; i < n; i++) {
    const prefix = best[i];
    if (prefix === undefined) continue;
    for (const d of dict) {
      const end = i + d.stripped.length;
      if (end > n) continue;
      if (target.startsWith(d.stripped, i)) {
        const cand = [...prefix, d.member];
        const cur = best[end];
        if (cur === undefined || cand.length < cur.length) best[end] = cand;
      }
    }
  }
  const full = best[n];
  // Two or more segments: a single-segment "segmentation" is just another member
  // that strips to the same string, which is a different (duplicate) concern.
  return full !== undefined && full.length >= 2 ? full : undefined;
}

/** Effective `@normalize` for an enum field: own/inherited → owning object → default. */
function effectiveNormalize(field: MetaData): string {
  // ADR-0039: resolving accessor — an enum field that extends an abstract enum must
  // see the super's @normalize, so this must NOT be ownAttrs().
  const own = field.attr(FIELD_ATTR_NORMALIZE);
  if (typeof own === "string") return own;
  const parent = field.parent;
  if (parent !== undefined && parent.type === TYPE_OBJECT) {
    const objMode = parent.attr(FIELD_ATTR_NORMALIZE);
    if (typeof objMode === "string") return objMode;
  }
  return NORMALIZE_DEFAULT;
}

export function validateEnumNormalizeAmbiguity(root: MetaData): EnumNormalizeAmbiguityResult {
  const warnings: LoaderWarning[] = [];

  const visit = (node: MetaData): void => {
    if (node.type === TYPE_FIELD && node.subType === FIELD_SUBTYPE_ENUM) {
      // ADR-0039: own — check the vocabulary DECLARED here. A concrete enum that
      // inherits @values via extends shares the super's member set, which was
      // already checked when the super was declared; warning per declaration keeps
      // one hazard to one warning instead of one per referring field.
      const rawValues = node.ownAttrs().get(FIELD_ATTR_VALUES);
      if (Array.isArray(rawValues) && rawValues.length > 1) {
        if (effectiveNormalize(node) === NORMALIZE_DEFAULT) {
          const entries = rawValues.map((m) => ({ member: String(m), stripped: stripNormalize(String(m)) }));
          for (let i = 0; i < entries.length; i++) {
            const self = entries[i]!;
            if (self.stripped.length === 0) continue; // e.g. "_" — nothing to collide with
            // Exclude the member itself BY INDEX (not by value): two distinct
            // members can strip to the same string, which is a separate concern.
            const others = entries.filter((_, j) => j !== i).filter((e) => e.stripped.length > 0);
            const seg = segmentInto(self.stripped, others);
            if (seg !== undefined) {
              warnings.push({
                code: "WARN_ENUM_NORMALIZE_AMBIGUOUS",
                message:
                  `field.enum "${node.name}" member '${self.member}' is the concatenation of ` +
                  `${seg.map((s) => `'${s}'`).join(" + ")} under @${FIELD_ATTR_NORMALIZE}: ` +
                  `'${NORMALIZE_DEFAULT}' (the default), which erases separators. A delimited ` +
                  `value such as "${seg.map((s) => s.toLowerCase()).join("|")}" would coerce ` +
                  `silently to '${self.member}' and be reported as extracted rather than ` +
                  `malformed. Set @${FIELD_ATTR_NORMALIZE}: 'collapse' on this field if it can ` +
                  `receive delimited input.`,
                source: node.source,
              });
              break; // one warning per declaring node — the first collision is enough to act on
            }
          }
        }
      }
    }
    // ADR-0039: own — a plain structural walk of what each node declares; resolving
    // children() would re-visit inherited nodes at every referring field.
    for (const child of node.ownChildren()) visit(child);
  };

  visit(root);
  return { warnings };
}
