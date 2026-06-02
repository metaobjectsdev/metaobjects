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
