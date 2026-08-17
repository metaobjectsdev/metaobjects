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

import { TYPE_REQUIREMENT, resolveClaim } from "@metaobjectsdev/metadata";
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
  /** DISTINCT `type.subType` concerns among the resolved targets. */
  readonly implementedByTypes: readonly string[];
}

export interface ResolvedTarget {
  /** The reference exactly as authored, for the doc comment. */
  readonly ref: string;
  readonly node: MetaData;
  readonly concern: string;
}

export interface WalkedRequirement {
  readonly node: MetaRequirement;
  readonly view: RequirementView;
  readonly targets: readonly ResolvedTarget[];
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

    const targets: ResolvedTarget[] = [];
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
export function groupByConcern(w: WalkedRequirement): Map<string, ResolvedTarget[]> {
  const groups = new Map<string, ResolvedTarget[]>();
  for (const t of w.targets) {
    const existing = groups.get(t.concern);
    if (existing === undefined) groups.set(t.concern, [t]);
    else existing.push(t);
  }
  if (groups.size === 0) groups.set(NO_CONCERN, []);
  return groups;
}
