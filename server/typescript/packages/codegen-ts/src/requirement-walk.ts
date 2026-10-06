// FR-038 — walking `requirement.*` nodes and projecting them for downstream filters.
//
// WHY A WALK RATHER THAN ctx.matches: the `Generator` contract is entity-shaped —
// `GenContext.entities` is `MetaObject[]` and `filter` is
// `(entity: MetaObject) => boolean` — so a requirement-driven generator cannot use
// it and must walk `loadedRoot` itself. Generalising `Generator` over any node kind
// is the principled fix and is deliberately out of scope: it is a core contract
// change touching every existing generator in five ports.
//
// WHY A PROJECTION rather than the raw node: an application's filter is app-owned
// policy (FR-038 §5), and handing it a `MetaData` would bind adopter code to
// metamodel internals and export the ADR-0039 own-vs-resolving accessor trap. The
// projection is additive — it can grow, but it never hands out the node.

import { createHash } from "node:crypto";
import {
  TYPE_REQUIREMENT,
  REQUIREMENT_SUBTYPE_FUNCTIONAL,
  REQUIREMENT_LINK_FLOOR_LEVEL,
  REQUIREMENT_ATTR_STATEMENT,
  REQUIREMENT_ATTR_COUNTEREXAMPLE,
  REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES,
  resolveClaim,
} from "@metaobjectsdev/metadata";
import type { MetaData, MetaRequirement } from "@metaobjectsdev/metadata";

/** The shape an app's `filter` receives. Never the node itself. */
export interface RequirementView {
  /** "functional" | "architectural" — the check-polarity axis. */
  readonly subType: string;
  /** 1 solution · 2 segment · 3 service · 4 object · 5 member. Undefined on an
   *  unlevelled architectural requirement (the original flat policy form). */
  readonly level: number | undefined;
  readonly status: string | undefined;
  /** Dotted path from the root through nesting ancestors — hierarchy is nesting. */
  readonly path: string;
  /** The EFFECTIVE package: the node's own, else its file's default, else "". */
  readonly package: string;
  /** DISTINCT `type.subType` concerns among the resolved targets. */
  readonly implementedByTypes: readonly string[];
}

export interface ResolvedClaim {
  /** The reference exactly as authored, for the doc comment. */
  readonly ref: string;
  readonly node: MetaData;
  readonly concern: string;
}

export interface WalkedRequirement {
  readonly node: MetaRequirement;
  readonly view: RequirementView;
  readonly targets: readonly ResolvedClaim[];
}

/** `<type>.<subType>` — the key a renderer map is looked up by. */
export function concernOf(node: MetaData): string {
  return `${node.type}.${node.subType}`;
}

/**
 * The concern key for a requirement that resolves NO targets.
 *
 * Doubles as the catch-all renderer key, deliberately: a requirement with nothing
 * to fan out over falls through to whatever the app registered as its default.
 */
export const NO_CONCERN = "*";

/**
 * Depth-first walk of every `requirement.*` node, nested ones included.
 *
 * Unresolvable `@implementedBy` references are skipped rather than thrown on —
 * resolution severity is `meta verify`'s job (it depends on `@status`, which is why
 * it cannot live in the loader), and codegen must not fail a build over a
 * diagnostic another command owns.
 */
export function walkRequirements(root: MetaData): WalkedRequirement[] {
  const out: WalkedRequirement[] = [];

  const visit = (node: MetaData, prefix: string): void => {
    if (node.type !== TYPE_REQUIREMENT) return;
    const path = prefix === "" ? node.name : `${prefix}.${node.name}`;
    const req = node as MetaRequirement;
    // Same referrer-package basis the CLI's checks use, so a bare reference binds
    // package-locally under the ADR-0042 contract.
    const referrerPkg = node.package ?? node.fileDefaultPackage ?? "";

    const targets: ResolvedClaim[] = [];
    for (const ref of req.implementedBy()) {
      const target = resolveClaim(root, ref, referrerPkg);
      if (target === undefined) continue;
      targets.push({ ref, node: target, concern: concernOf(target) });
    }

    out.push({
      node: req,
      view: {
        subType: node.subType,
        level: req.level(),
        status: req.status(),
        path,
        package: referrerPkg,
        implementedByTypes: [...new Set(targets.map((t) => t.concern))],
      },
      targets,
    });

    for (const child of node.children()) visit(child, path);
  };

  for (const child of root.children()) visit(child, "");
  return out;
}

/**
 * Group a requirement's targets by distinct concern — the fan-out unit.
 *
 * One entry per distinct `type.subType`, NOT one per target: a single architectural
 * requirement claimed by 123 entities must emit one stub, not 123, which is the
 * hostile-first-contact outcome FR-038 §10 exists to avoid.
 *
 * A requirement resolving NO targets still yields exactly ONE group. That is not a
 * degenerate case: `REQUIREMENT_LINK_FLOOR_LEVEL` forbids `@implementedBy` below L4,
 * so every L1–L3 requirement resolves nothing — and an application that chooses to
 * cover L3 would otherwise get silence instead of a stub.
 */
export function groupByConcern(w: WalkedRequirement): Map<string, ResolvedClaim[]> {
  const groups = new Map<string, ResolvedClaim[]>();
  for (const t of w.targets) {
    const existing = groups.get(t.concern);
    if (existing === undefined) groups.set(t.concern, [t]);
    else existing.push(t);
  }
  if (groups.size === 0) groups.set(NO_CONCERN, []);
  return groups;
}

// ---------------------------------------------------------------------------
// Test identity, digest and grain.
//
// Everything below is the part of the generator that every language port copies
// and a shared corpus pins: which tests a ledger yields, what each is called, and
// a fingerprint of the claim it tests. It lives here, beside the walk, rather than
// in the generator, because an application that owns its generator (`meta eject
// requirement-tests`) still imports these from the package: an owned copy changes
// how a test is WRITTEN, and keeps agreeing with every other tool about which
// tests exist.
// ---------------------------------------------------------------------------

const REQUIREMENT_TEST_GRAINS = ["concern", "member"] as const;

/**
 * The fan-out unit: what one generated test stands for.
 *
 * - `concern` (default): one test per distinct `<type>.<subType>` a requirement claims.
 * - `member`: one test per distinct `@implementedBy` reference that resolves.
 */
export type RequirementTestGrain = (typeof REQUIREMENT_TEST_GRAINS)[number];

/**
 * Refuse anything that is not a grain.
 *
 * The type alone does not hold: `metaobjects.config.ts` is loaded without a typecheck,
 * so a typo arrives here as a plain string. Letting it through picks a grain by
 * accident — and not even one grain, since each place that branches on it would fall
 * to its own default. Called wherever a grain enters: the identity functions below and
 * the generator, built-in or owned.
 */
export function assertRequirementTestGrain(grain: unknown): asserts grain is RequirementTestGrain {
  if (!(REQUIREMENT_TEST_GRAINS as readonly unknown[]).includes(grain)) {
    throw new Error(
      `unknown requirement-test grain ${JSON.stringify(grain)}: expected ` +
        `${REQUIREMENT_TEST_GRAINS.map((g) => JSON.stringify(g)).join(" or ")}.`,
    );
  }
}

/** One generated test. The same record in every language port. */
export interface RequirementTestIdentity {
  /** The requirement's effective package. */
  readonly package: string;
  /** The requirement's dotted path, without the package. */
  readonly path: string;
  /** `<type>.<subType>` under the `concern` grain, the reference exactly as authored
   *  under `member`, and `*` for a requirement that resolves no target. */
  readonly unit: string;
  /** `<qualified address> [<unit>]` — unique per test. */
  readonly id: string;
  /** An identifier-safe spelling of `id`, for ports that bind a test to a function. */
  readonly witnessKey: string;
  readonly status: string | undefined;
  /** Why the test is skipped, or null when the requirement claims the capability
   *  works right now. */
  readonly skip: "planned" | "retired" | null;
  /** `requirementDigest` of the requirement — the same for each of its tests. */
  readonly digest: string;
}

/**
 * RECOMMENDATION, not a rule: functional requirements at or below the link floor.
 *
 * Architectural requirements are excluded by default because `verify`'s
 * universality check already proves them structurally, so a test there is usually
 * redundant — usually, not never, which is exactly why this is overridable.
 */
export function defaultRequirementTestFilter(r: RequirementView): boolean {
  return (
    r.subType === REQUIREMENT_SUBTYPE_FUNCTIONAL &&
    (r.level ?? 0) >= REQUIREMENT_LINK_FLOOR_LEVEL
  );
}

const DIGEST_VERSION = "requirement-digest/v1";

/** `<name> <byte length>\n<value>\n` — length-prefixed, so no value can be confused
 *  with the field that follows it, whatever it contains. */
function digestField(name: string, value: string): string {
  return `${name} ${Buffer.byteLength(value, "utf8")}\n${value}\n`;
}

/**
 * A fingerprint of the CLAIM: lowercase hex SHA-256 over the requirement's subtype,
 * level, status, statement, counterexample and `@implementedBy` list.
 *
 * It answers "did the claim change", not "did the entry move": the name, the package,
 * the title, the notes, the disposition, the tracking references and nested
 * requirements are all left out, so renaming or annotating an entry does not disturb
 * a test written against it, and rewording what it asserts does.
 */
export function requirementDigest(node: MetaRequirement): string {
  // attr() RESOLVES in TypeScript (ADR-0039): the digest is over the effective claim.
  const prose = (name: string): string => {
    const v = node.attr(name);
    return typeof v === "string" ? v.replace(/\r\n?/g, "\n") : "";
  };
  const level = node.level();
  const refs = node.implementedBy();
  const text =
    `${DIGEST_VERSION}\n` +
    digestField("subType", node.subType) +
    digestField("level", level === undefined ? "" : String(level)) +
    digestField("status", node.status() ?? "") +
    digestField("statement", prose(REQUIREMENT_ATTR_STATEMENT)) +
    digestField("counterexample", prose(REQUIREMENT_ATTR_COUNTEREXAMPLE)) +
    `implementedBy ${refs.length}\n` +
    refs.map((r) => digestField("ref", r)).join("");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Every maximal run of characters outside `[A-Za-z0-9]` becomes one `_`. */
const mangle = (s: string): string => s.replace(/[^A-Za-z0-9]+/g, "_");

/**
 * An identifier-safe key for one test: `req_<address>`, then `__<unit>` unless the
 * requirement resolves no target.
 *
 * Mangling is lossy — `Orders.Recorded` and `Orders_Recorded` give one key — which is
 * what `witnessKeyCollisions` exists to report.
 */
export function witnessKeyOf(qualifiedAddress: string, unit: string): string {
  const base = `req_${mangle(qualifiedAddress)}`;
  return unit === NO_CONCERN ? base : `${base}__${mangle(unit)}`;
}

/**
 * A requirement's targets, grouped by fan-out unit under the given grain — one entry
 * per test, in first-seen order.
 *
 * Under `member` a reference authored twice is one test, and the bare and qualified
 * spellings of one node are two: the unit is the reference as written, not what it
 * resolves to. In both grains a requirement resolving NO targets still yields
 * exactly one entry, keyed `NO_CONCERN` (see `groupByConcern`).
 */
export function requirementTestUnits(
  w: WalkedRequirement,
  grain: RequirementTestGrain = "concern",
): Map<string, ResolvedClaim[]> {
  assertRequirementTestGrain(grain);
  if (grain === "concern") return groupByConcern(w);
  const units = new Map<string, ResolvedClaim[]>();
  for (const t of w.targets) {
    if (!units.has(t.ref)) units.set(t.ref, [t]);
  }
  if (units.size === 0) units.set(NO_CONCERN, []);
  return units;
}

/** The identity of the one test `unit` stands for (a key of `requirementTestUnits`). */
export function requirementTestIdentity(
  w: WalkedRequirement,
  unit: string,
): RequirementTestIdentity {
  const { path, status } = w.view;
  const pkg = w.view.package;
  const address = pkg === "" ? path : `${pkg}::${path}`;
  // Derived from the loader's status list rather than naming the two skipped statuses:
  // a status that does not claim the capability works right now is skipped by
  // construction, so a status added later cannot be left failing by omission.
  const skips =
    status !== undefined &&
    !(REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES as readonly string[]).includes(status);
  return {
    package: pkg,
    path,
    unit,
    id: `${address} [${unit}]`,
    witnessKey: witnessKeyOf(address, unit),
    status,
    skip: skips ? (status as "planned" | "retired") : null,
    digest: requirementDigest(w.node),
  };
}

// Code units, never localeCompare: a collation differs between machines and between
// language ports, and these orders are pinned by a corpus all five ports run.
const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every test the generator would emit, sorted by id. */
export function requirementTestIdentities(
  root: MetaData,
  opts: { grain?: RequirementTestGrain; filter?: (r: RequirementView) => boolean } = {},
): RequirementTestIdentity[] {
  const filter = opts.filter ?? defaultRequirementTestFilter;
  // Checked here as well as per requirement, so a bad grain is refused even over a
  // ledger the filter empties — the answer must not depend on what the model holds.
  const grain = opts.grain ?? "concern";
  assertRequirementTestGrain(grain);
  const out: RequirementTestIdentity[] = [];
  for (const walked of walkRequirements(root)) {
    if (!filter(walked.view)) continue;
    for (const unit of requirementTestUnits(walked, grain).keys()) {
      out.push(requirementTestIdentity(walked, unit));
    }
  }
  return out.sort((a, b) => compareCodeUnits(a.id, b.id));
}

/** Pairs of ids that share a witnessKey, each pair and the list sorted. */
export function witnessKeyCollisions(
  tests: readonly RequirementTestIdentity[],
): [string, string][] {
  const byKey = new Map<string, string[]>();
  for (const t of tests) {
    const ids = byKey.get(t.witnessKey);
    if (ids === undefined) byKey.set(t.witnessKey, [t.id]);
    else ids.push(t.id);
  }
  const pairs: [string, string][] = [];
  for (const ids of byKey.values()) {
    const sorted = [...ids].sort(compareCodeUnits);
    for (const [i, first] of sorted.entries()) {
      for (const second of sorted.slice(i + 1)) pairs.push([first, second]);
    }
  }
  return pairs.sort((a, b) => compareCodeUnits(a[0], b[0]) || compareCodeUnits(a[1], b[1]));
}
