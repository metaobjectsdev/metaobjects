// server/typescript/packages/codegen-ts/src/generators/requirements-view.ts
//
// The projected row the `requirements` docs surface renders from.
//
// Design: docs/superpowers/specs/2026-08-21-requirements-doc-surface-design.md
//
// PROJECTS OVER `walkRequirements()`, NEVER RE-WALKS. That walk already resolves the
// depth-first traversal, the dotted `path` (hierarchy IS nesting), and the
// `@implementedBy` targets, and it is what `requirementTests()` is built on. Sharing it
// means the doc view and the generated stubs agree about what the ledger contains by
// construction; two walks kept in step by hand is exactly the drift this surface exists
// to remove.
//
// `notes` IS DELIBERATELY ABSENT FROM THIS TYPE, not merely unread. `documentation.json`
// charters it internal-only, never emitted to a user-facing doc surface, and the
// original ask this design replaced wanted a "stripper" for precisely this. A renderer
// cannot leak a field the projection never carries — which is a stronger guarantee than
// asking every renderer to remember.
//
// RESOLVING ACCESSORS ONLY (ADR-0039). Every read below goes through MetaRequirement's
// resolving accessors or the resolving `attr()`, so a requirement that `extends` an
// abstract parent inherits its `@level` / `@status` / statement rather than projecting
// them as undefined. No `own*()` call belongs in this file.

import {
  DOC_ATTR_DESCRIPTION,
  DOC_ATTR_TITLE,
  REQUIREMENT_ATTR_STATEMENT,
  REQUIREMENT_ATTR_COUNTEREXAMPLE,
} from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { walkRequirements } from "../requirement-walk.js";

/** One requirement, projected for rendering. Ordered depth-first, declaration order. */
export interface RequirementRow {
  /** Dotted child-name path from the root — the same address every other node uses. */
  readonly path: string;
  /** 0 for a root-level requirement. Derived from `path`, so it cannot disagree with it. */
  readonly depth: number;
  /**
   * The entry's LABEL, where the author wrote one. `spec/capability-ledger.md` charters
   * `title` on a requirement by name — "`name` is an identifier, this is what an index
   * shows" — so a surface that projects the address and drops the label renders an index
   * the charter already described differently. The address stays the primary key; this
   * rides beside it, never in place of it.
   */
  readonly title: string | undefined;
  /** "functional" | "architectural" — the check-polarity axis. */
  readonly subType: string;
  /** Undefined on an unlevelled architectural requirement (the flat policy form). */
  readonly level: number | undefined;
  readonly status: string | undefined;
  readonly disposition: string | undefined;
  readonly trackedBy: readonly string[];
  readonly statement: string | undefined;
  readonly counterexample: string | undefined;
  /** Chartered user-facing. `notes` has no counterpart here, by design. */
  readonly description: string | undefined;
  /** `@implementedBy` exactly as authored — provenance a reader can grep for. */
  readonly implementedBy: readonly string[];
  /** DISTINCT `type.subType` concerns among the targets that actually resolved. */
  readonly claimedConcerns: readonly string[];
}

/** Reads a resolving string attr, normalising "declared but empty" to undefined so a
 *  renderer has one absent-case to handle rather than two. */
function stringAttr(node: MetaData, name: string): string | undefined {
  // `attr()` is the RESOLVING accessor in TypeScript (ADR-0039). Note the cross-port
  // naming inversion this repo records: Python's `attr()` is own-only, TS's resolves.
  const raw = node.attr(name);
  if (typeof raw !== "string") return undefined;
  return raw.length > 0 ? raw : undefined;
}

/**
 * Project every `requirement.*` node — nested ones included — into render-ready rows.
 *
 * Returns `[]` for a model declaring no requirements, which is what lets the surface
 * emit NOTHING rather than an empty page, and is in turn what makes turning the surface
 * on by default a no-op for every project without a ledger.
 */
export function requirementRows(root: MetaData): RequirementRow[] {
  return walkRequirements(root).map((walked) => {
    const { node, view, targets } = walked;
    return {
      path: view.path,
      // Derived rather than threaded: a separately-tracked depth could drift from the
      // path that renders beside it, and there is only one right answer.
      depth: view.path.split(".").length - 1,
      title: stringAttr(node, DOC_ATTR_TITLE),
      subType: view.subType,
      level: view.level,
      status: view.status,
      disposition: node.disposition(),
      trackedBy: node.trackedBy(),
      statement: stringAttr(node, REQUIREMENT_ATTR_STATEMENT),
      counterexample: stringAttr(node, REQUIREMENT_ATTR_COUNTEREXAMPLE),
      description: stringAttr(node, DOC_ATTR_DESCRIPTION),
      implementedBy: node.implementedBy(),
      claimedConcerns: [...new Set(targets.map((t) => t.concern))],
    };
  });
}
