// The `explorer.json` shape: the one data file every explorer view reads.
//
// It is BUILT from port-neutral inputs only (see build.ts), so its fields hold what those
// inputs state and nothing a loader would have to recompute.

/** Bumped when a field changes meaning or is removed; adding a field does not bump it. */
export const EXPLORER_FORMAT = "metaobjects-explorer/1";

/** One metadata node: a top-level node (object, prompt, requirement, …) or any node nested
 *  in one (field, identity, source, view, nested requirement, …). */
export interface ExplorerNode {
  /** `<package>::<name>` for a top-level node (`<name>` with no package), then `.<name>`
   *  per nesting level: `acme::shop::Order`, `acme::shop::Order.total`,
   *  `acme::shop::Shop.Checkout`. A nested node with no name gets `#<index>` instead. */
  id: string;
  type: string;
  subType: string;
  /** "" for a nested node with no name. */
  name: string;
  /** The package of the node's top-level ancestor, "" when it has none. */
  package: string;
  /** Its position among its siblings in the effective tree (0-based): declaration order,
   *  which `nodes` (sorted by id) does not keep. */
  order: number;
  /** The id of the node this one is nested in; absent on a top-level node. */
  parent?: string;
  /** The id `extends` names, as the effective tree spells it. */
  extends?: string;
  abstract?: true;
  isArray?: true;
  /** On a member the effective tree materialized from a super: the id of the object it is
   *  declared on. Read as "same type, name and body as that ancestor's member", so a member
   *  redeclared with a different body is this node's own. */
  inheritedFrom?: string;
  /** Every `@` attribute on the effective node, without the `@`, keys sorted. */
  attrs: Record<string, unknown>;
}

export const EXPLORER_EDGE_KINDS = [
  "extends",
  "references",
  "association",
  "objectRef",
  "payload",
  "reply",
  "contains",
  "implementedBy",
  "supersededBy",
] as const;
export type ExplorerEdgeKind = (typeof EXPLORER_EDGE_KINDS)[number];

/** A typed link between two nodes. Only links whose both ends are nodes are drawn. */
export interface ExplorerEdge {
  kind: ExplorerEdgeKind;
  from: string;
  to: string;
  /** The member that carries the link, when it is not `from` itself: the
   *  `identity.reference`, the `field.object`, the `relationship.*`. */
  via?: string;
}

/** One requirement as `meta verify --format json` judged it (`requirementLedger[]`), with
 *  the node id it has here. */
export interface ExplorerLedgerRow {
  node: string;
  path: string;
  package: string;
  qualifiedPath: string;
  subType: string;
  level?: number;
  status?: string;
  disposition?: string;
  digest: string;
  implementedBy: { ref: string; resolves: boolean; target?: string }[];
  supersededBy?: { ref: string; resolves: boolean; target?: string };
  diagnostics: { code: string; severity: string; source: string }[];
  verdict: string;
}

export interface ExplorerLedger {
  /** `requirementCounts` from the verify payload, verbatim. */
  counts: Record<string, unknown>;
  /** One row per requirement, in the verify payload's (document) order. */
  rows: ExplorerLedgerRow[];
  /** `requirements.rows` from the verify payload, verbatim: every gate and lint finding,
   *  including the ones whose subject is not a requirement (an unclaimed entity). */
  diagnostics: unknown[];
}

export interface ExplorerGeneratedFile {
  /** Project-relative, as the manifest keys it. */
  path: string;
  generatedBy: string;
}

/** The generated files the manifest attributes to one node. */
export interface ExplorerGenerated {
  node: string;
  files: ExplorerGeneratedFile[];
}

export type ExplorerSliceKind = "requirement" | "package" | "prompt";

/** A named node set a view opens on, derived from the model with no authoring. */
export interface ExplorerSlice {
  /** `<kind>:<anchor id or package>`. */
  id: string;
  kind: ExplorerSliceKind;
  /** The requirement, package or prompt the slice is derived from ("" for the root package). */
  anchor: string;
  /** Node ids, sorted. */
  nodes: string[];
}

/** One HTTP route the project mounts for a node, as the run that generated the routes states
 *  it. */
export interface ExplorerRoute {
  node: string;
  method: string;
  /** The mounted path, with the project's `apiPrefix`: `/api/orders/{id}`. */
  path: string;
}

export interface ExplorerJson {
  format: typeof EXPLORER_FORMAT;
  nodes: ExplorerNode[];
  edges: ExplorerEdge[];
  /** Absent without a verify payload, or when the model declares no requirement. */
  ledger?: ExplorerLedger;
  /** Absent without a manifest. */
  generated?: ExplorerGenerated[];
  /** Absent without a routes input. Sorted by node, then path, then method. */
  api?: ExplorerRoute[];
  slices: ExplorerSlice[];
}
