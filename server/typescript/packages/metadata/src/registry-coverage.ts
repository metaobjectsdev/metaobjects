// SP-G Unit 5 — untested-vocabulary coverage report.
//
// Cross-references the REGISTERED metamodel vocabulary (the canonical
// registry-conformance manifest — "what SHOULD be exercised") against the
// conformance FIXTURE corpora ("what IS exercised"), and surfaces every
// registered (type, subType) — and each attr — that NO fixture exercises.
//
// This closes the meta-gap that let SP-C's vocabulary drift hide for weeks: a
// drifted/missing vocabulary member was only caught incidentally, if some
// fixture happened to use it. Making the *untested* set VISIBLE is the
// deliverable. The registry-conformance gate (Unit 1) proves the vocabulary is
// IDENTICAL across ports; this report proves the vocabulary is EXERCISED at all.
//
// Pure + testable: takes the parsed manifest + a set of fixture roots, walks the
// canonical-JSON node graph (nodes keyed `"<type>.<subType>"`, `@attr` inline
// keys, reserved bare keys, nested `children`), and returns the registered /
// exercised / untested sets — all deterministic + sorted.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ATTR_PREFIX,
  RESERVED_KEYS,
  TYPE_SUBTYPE_SEPARATOR,
} from "./shared/structural.js";

// ---------------------------------------------------------------------------
// Manifest shape (a structural subset of fixtures/registry-conformance schema)
// ---------------------------------------------------------------------------

/** One attr in the registry manifest. */
export interface ManifestAttr {
  name: string;
  valueType: string | null;
  required: boolean;
}

/** One registered (type, subType) with its declared attrs. */
export interface ManifestType {
  type: string;
  subType: string;
  attrs: ManifestAttr[];
}

/** The canonical registry manifest (expected-registry.json). */
export interface RegistryManifest {
  types: ManifestType[];
  commonAttrs: ManifestAttr[];
  defaultSubTypes: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Coverage result
// ---------------------------------------------------------------------------

/** Per-subtype attr coverage: which declared attrs no fixture sets. */
export interface UntestedAttrs {
  /** The `"<type>.<subType>"` key. */
  key: string;
  /** Sorted attr names declared on this subtype that NO fixture exercises. */
  untestedAttrs: string[];
}

/** The full coverage report — all collections sorted for determinism. */
export interface CoverageReport {
  /** Total registered `(type, subType)` keys. */
  registeredSubTypeCount: number;
  /** Registered keys at least one fixture exercises. */
  exercisedSubTypeCount: number;
  /** Sorted registered keys NO fixture exercises (the valuable backlog). */
  untestedSubTypes: string[];
  /**
   * Per EXERCISED subtype, the declared attrs no fixture sets. Only includes
   * subtypes that ARE exercised (an untested subtype's attrs are all untested
   * by definition — listing them would be noise). Sorted by key; only entries
   * with a non-empty `untestedAttrs` list are included.
   */
  untestedAttrsByExercisedSubType: UntestedAttrs[];
}

/** The snapshot written to disk — a stable, diffable subset of the report. */
export interface CoverageSnapshot {
  registeredSubTypeCount: number;
  exercisedSubTypeCount: number;
  untestedSubTypes: string[];
  untestedAttrsByExercisedSubType: UntestedAttrs[];
}

// ---------------------------------------------------------------------------
// Fixture-corpus scanning
// ---------------------------------------------------------------------------

/** What a single fixture corpus exercises. */
interface Usage {
  /** Set of `"<type>.<subType>"` keys seen in any fixture node. */
  subTypes: Set<string>;
  /** key → set of attr names (sans `@` prefix) set on a node of that subtype. */
  attrsByKey: Map<string, Set<string>>;
}

function newUsage(): Usage {
  return { subTypes: new Set<string>(), attrsByKey: new Map<string, Set<string>>() };
}

/** Recursively collect every *.json file path under a directory root. */
function collectJsonFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // missing/unreadable dir — skip (a corpus root may not exist)
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile() && entry.endsWith(".json")) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/** True if a node-body key is a `"<type>.<subType>"` wrapper key. */
function isTypeSubTypeKey(key: string): boolean {
  // A wrapper key fuses type + subType with the separator. Reserved structural
  // keys, `@`-attrs, and the JSON `$schema` key are NOT wrapper keys.
  if (key.startsWith(ATTR_PREFIX)) return false;
  if (RESERVED_KEYS.has(key)) return false;
  if (!key.includes(TYPE_SUBTYPE_SEPARATOR)) return false;
  if (key.startsWith("$")) return false;
  // Must be exactly `type.subType` (one separator, two non-empty halves).
  const idx = key.indexOf(TYPE_SUBTYPE_SEPARATOR);
  const type = key.slice(0, idx);
  const subType = key.slice(idx + TYPE_SUBTYPE_SEPARATOR.length);
  return type.length > 0 && subType.length > 0 && !subType.includes(TYPE_SUBTYPE_SEPARATOR);
}

/**
 * Record one node-body: its inline `@attrs` (against the owning wrapper key) and
 * recurse into its children. `body` is the object under a wrapper key.
 */
function visitBody(body: unknown, ownerKey: string, usage: Usage): void {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return;
  const obj = body as Record<string, unknown>;

  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith(ATTR_PREFIX)) {
      // An inline attr on this node. Strip the prefix → the logical attr name.
      const attrName = k.slice(ATTR_PREFIX.length);
      let set = usage.attrsByKey.get(ownerKey);
      if (!set) {
        set = new Set<string>();
        usage.attrsByKey.set(ownerKey, set);
      }
      set.add(attrName);
    } else if (k === "children") {
      visitNodeList(v, usage);
    }
    // Reserved bare keys (name/package/extends/value/...) are not attrs — skip.
    // (`value` may hold nested arbitrary data, not metamodel nodes — skip it.)
  }
}

/** Visit an array of wrapper-keyed nodes (the `children` list, or a root list). */
function visitNodeList(list: unknown, usage: Usage): void {
  if (!Array.isArray(list)) return;
  for (const item of list) {
    visitNode(item, usage);
  }
}

/**
 * Visit one wrapper-keyed node object: `{ "<type>.<subType>": { ...body } }`.
 * A single object may carry multiple wrapper keys; handle each.
 */
function visitNode(node: unknown, usage: Usage): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return;
  const obj = node as Record<string, unknown>;
  for (const [key, body] of Object.entries(obj)) {
    if (isTypeSubTypeKey(key)) {
      usage.subTypes.add(key);
      visitBody(body, key, usage);
    } else if (key === "children") {
      // Some corpora nest a bare `children` list at a level without a wrapper.
      visitNodeList(body, usage);
    }
  }
}

/**
 * Parse one fixture JSON document and fold its vocabulary usage into `usage`.
 * The document root is the metadata.root wrapper (or, defensively, an array or
 * a bare node). Robust to non-metadata JSON (e.g. CAPABILITIES.json) — such a
 * doc simply contributes no wrapper keys.
 */
function scanDocument(text: string, usage: Usage): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return; // not JSON / malformed — contributes nothing
  }
  if (Array.isArray(parsed)) {
    visitNodeList(parsed, usage);
  } else {
    visitNode(parsed, usage);
  }
}

/** Scan a set of corpus roots, unioning vocabulary usage across all of them. */
export function scanFixtureUsage(roots: readonly string[]): Usage {
  const usage = newUsage();
  for (const root of roots) {
    for (const file of collectJsonFiles(root)) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      scanDocument(text, usage);
    }
  }
  return usage;
}

// ---------------------------------------------------------------------------
// Coverage computation
// ---------------------------------------------------------------------------

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compute the untested-vocabulary coverage report.
 *
 * @param manifest the parsed registry manifest (the registered vocabulary)
 * @param roots    fixture-corpus directory roots to scan for usage
 */
export function computeCoverage(
  manifest: RegistryManifest,
  roots: readonly string[],
): CoverageReport {
  const usage = scanFixtureUsage(roots);

  const registeredKeys = manifest.types.map(
    (t) => `${t.type}${TYPE_SUBTYPE_SEPARATOR}${t.subType}`,
  );

  const untestedSubTypes = registeredKeys
    .filter((key) => !usage.subTypes.has(key))
    .sort(compareStrings);

  const exercisedSubTypeCount = registeredKeys.length - untestedSubTypes.length;

  // Per EXERCISED subtype, which declared attrs no fixture sets.
  const untestedAttrsByExercisedSubType: UntestedAttrs[] = [];
  for (const t of manifest.types) {
    const key = `${t.type}${TYPE_SUBTYPE_SEPARATOR}${t.subType}`;
    if (!usage.subTypes.has(key)) continue; // skip untested subtypes (all-untested by definition)
    if (t.attrs.length === 0) continue;
    const seen = usage.attrsByKey.get(key) ?? new Set<string>();
    const untestedAttrs = t.attrs
      .map((a) => a.name)
      .filter((name) => !seen.has(name))
      .sort(compareStrings);
    if (untestedAttrs.length > 0) {
      untestedAttrsByExercisedSubType.push({ key, untestedAttrs });
    }
  }
  untestedAttrsByExercisedSubType.sort((a, b) => compareStrings(a.key, b.key));

  return {
    registeredSubTypeCount: registeredKeys.length,
    exercisedSubTypeCount,
    untestedSubTypes,
    untestedAttrsByExercisedSubType,
  };
}

/** Project a report into the stable, diffable snapshot shape. */
export function toSnapshot(report: CoverageReport): CoverageSnapshot {
  return {
    registeredSubTypeCount: report.registeredSubTypeCount,
    exercisedSubTypeCount: report.exercisedSubTypeCount,
    untestedSubTypes: report.untestedSubTypes,
    untestedAttrsByExercisedSubType: report.untestedAttrsByExercisedSubType,
  };
}

/** Serialize a snapshot as byte-stable JSON (2-space indent, trailing newline). */
export function emitSnapshot(snapshot: CoverageSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Monotonic ratchet (Wave 4a)
// ---------------------------------------------------------------------------
//
// The committed snapshot (coverage-report.json) is a BASELINE, not an exact
// expectation. The ratchet hard-fails only when coverage REGRESSES — never when
// it improves. Coverage regresses when a registered (type, subType) or an attr
// on an exercised subtype that the baseline considered EXERCISED becomes
// UNEXERCISED, i.e. a NEW item appears in an untested set that wasn't there
// before. Adding an exercising fixture (an item LEAVES an untested set) is an
// improvement and is always allowed.
//
// Comparison granularity is SET-based, not count-based: an integer-only check
// would let a regression hide behind a simultaneous improvement (untested count
// stays flat while one item is newly exercised and a different one regresses).
// We compare the untested SETS directly so each individual regression is named.

/** One named coverage regression — an item that became unexercised. */
export interface CoverageRegression {
  /** "subtype" — a registered (type, subType) no longer exercised; or "attr". */
  kind: "subtype" | "attr";
  /** The `"<type>.<subType>"` key that regressed. */
  key: string;
  /** For an attr regression: the attr name that became untested (else undefined). */
  attr?: string;
}

/** The ratchet verdict: ok=true when live coverage is no worse than baseline. */
export interface RatchetResult {
  ok: boolean;
  /** Every named regression (empty when ok). Sorted for determinism. */
  regressions: CoverageRegression[];
}

function sortedUnique(items: readonly string[]): string[] {
  return [...new Set(items)].sort(compareStrings);
}

/**
 * Compare a live coverage snapshot against a committed baseline and report any
 * REGRESSION (an item the baseline had exercised that the live run no longer
 * exercises). Improvements (items that left an untested set) are NOT regressions.
 *
 * - subtype regression: a key in `live.untestedSubTypes` not in baseline's set.
 * - attr regression: an attr in a live subtype's `untestedAttrs` not in the
 *   baseline's untested-attrs set for that SAME key. (A subtype that newly became
 *   untested is reported once as a subtype regression — its attrs are not double-
 *   reported, since an untested subtype has no per-attr entry by construction.)
 */
export function checkRatchet(
  baseline: CoverageSnapshot,
  live: CoverageSnapshot,
): RatchetResult {
  const baselineUntestedSubTypes = new Set(baseline.untestedSubTypes);
  const liveUntestedSubTypes = sortedUnique(live.untestedSubTypes);

  const regressions: CoverageRegression[] = [];

  // Subtype regressions: a NEW untested subtype (was exercised in the baseline).
  for (const key of liveUntestedSubTypes) {
    if (!baselineUntestedSubTypes.has(key)) {
      regressions.push({ kind: "subtype", key });
    }
  }

  // Attr regressions: for each EXERCISED subtype (it carries a per-attr entry),
  // any attr now untested that the baseline did not list as untested for that key.
  const baselineAttrsByKey = new Map<string, Set<string>>();
  for (const entry of baseline.untestedAttrsByExercisedSubType) {
    baselineAttrsByKey.set(entry.key, new Set(entry.untestedAttrs));
  }
  for (const entry of live.untestedAttrsByExercisedSubType) {
    // If the whole subtype regressed, it's already reported above — don't also
    // attribute its attrs (it has no per-attr baseline entry by construction).
    if (
      !baselineUntestedSubTypes.has(entry.key) &&
      liveUntestedSubTypes.includes(entry.key)
    ) {
      continue;
    }
    const baselineUntested = baselineAttrsByKey.get(entry.key) ?? new Set<string>();
    for (const attr of sortedUnique(entry.untestedAttrs)) {
      if (!baselineUntested.has(attr)) {
        regressions.push({ kind: "attr", key: entry.key, attr });
      }
    }
  }

  regressions.sort((a, b) => {
    const byKind = compareStrings(a.kind, b.kind);
    if (byKind !== 0) return byKind;
    const byKey = compareStrings(a.key, b.key);
    if (byKey !== 0) return byKey;
    return compareStrings(a.attr ?? "", b.attr ?? "");
  });

  return { ok: regressions.length === 0, regressions };
}

/** Render the regressions into an actionable, human-readable failure message. */
export function formatRatchetFailure(result: RatchetResult): string {
  const lines: string[] = [
    "Registry coverage REGRESSED — a previously-exercised vocabulary member is no",
    "longer exercised by any conformance fixture (monotonic-ratchet violation):",
    "",
  ];
  for (const r of result.regressions) {
    if (r.kind === "subtype") {
      lines.push(`  - subtype  ${r.key}  (no fixture exercises it anymore)`);
    } else {
      lines.push(`  - attr     ${r.key} @${r.attr}  (no fixture sets it anymore)`);
    }
  }
  lines.push(
    "",
    "Fix: add a conformance fixture that exercises the listed member(s). Only if",
    "the member was LEGITIMATELY removed from the vocabulary (a justified change)",
    "should you regenerate the baseline:",
    "  cd server/typescript",
    "  MO_UPDATE_COVERAGE_SNAPSHOT=1 bun test packages/metadata/test/registry-coverage.test.ts",
  );
  return lines.join("\n");
}
