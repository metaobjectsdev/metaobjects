// The docs view: one port-neutral document per build, the facts every documentation page reads.
//
// Built from the LOADED, RESOLVED model (see build.ts), it holds facts only: no HTML, no
// Markdown, no sentences. Where a page has to choose, the view gives it a boolean or a count.
// Every key is always present (an absent fact is "", false, 0, [] or null), and the key order
// below is the order on disk, so every port writes the same bytes for the same model. The
// contract is `docs/features/docs-view.md`, pinned by `fixtures/explorer-conformance/`.

/** Bumped when a field changes meaning or is removed. */
export const DOCS_VIEW_FORMAT = "metaobjects-docs-view/1";

/** A pointer to a node of the view, or to a reference that did not resolve. */
export interface DocsViewLink {
  /** What a page prints for the target: a top-level node's name, a requirement's title (else
   *  its name), `<owner name>.<member path>` for a member. The text as written when
   *  unresolved. */
  label: string;
  /** The target's id; "" when unresolved. */
  id: string;
  /** The site-relative page the target lands on, with `#<anchor>` for a member; "" when
   *  unresolved. */
  path: string;
  /** `<type>.<subType>` of the target; "" when unresolved. */
  kind: string;
  unresolved: boolean;
}

/** One value of an attribute: its text, and the node it names when the loader resolved it. */
export interface DocsViewAttrValue {
  text: string;
  /** Set only on an attribute the loader resolves as a reference. */
  link: DocsViewLink | null;
}

export interface DocsViewAttr {
  /** Without the `@`. */
  name: string;
  /** The effective value, as the canonical JSON states it (an object's keys in code-unit order). */
  value: unknown;
  /** One per element of a list of strings; otherwise one, a string verbatim or any other value
   *  as compact JSON. */
  values: DocsViewAttrValue[];
}

/** A reference the loader resolved, from this node or one of its members. */
export interface DocsViewRef {
  /** The attribute that carries it, without the `@`, or `extends`. */
  attr: string;
  /** The member that carries it; null when the node itself does. */
  via: DocsViewLink | null;
  target: DocsViewLink;
}

/** A reference into this node or one of its members, from another top-level node. */
export interface DocsViewReferrer {
  attr: string;
  /** The top-level node the reference sits in. */
  from: DocsViewLink;
  via: DocsViewLink | null;
  target: DocsViewLink;
}

/** A requirement's `@implementedBy` link onto this node or one of its members. */
export interface DocsViewClaim {
  requirement: DocsViewLink;
  /** The dotted member path below the top-level node; "" for the whole node. */
  member: string;
  status: string;
  level: number | null;
}

export interface DocsViewFileGroup {
  generatedBy: string;
  /** Project-relative, sorted. */
  paths: string[];
}

export interface DocsViewRoute {
  method: string;
  /** The mounted path, with the project's `apiPrefix`. */
  path: string;
}

/** The members of one type (every subtype of it), in declaration order. Groups are ordered by
 *  their first member's declaration. */
export interface DocsViewMemberGroup {
  type: string;
  count: number;
  members: DocsViewMember[];
}

/** A node nested in a top-level node, at any depth. */
export interface DocsViewMember {
  id: string;
  name: string;
  type: string;
  subType: string;
  /** Its position among its siblings in the effective tree (0-based). */
  order: number;
  /** On a direct member of a top-level node, the id its row carries; "" deeper down. */
  anchor: string;
  /** Where a link to it lands. */
  path: string;
  abstract: boolean;
  isArray: boolean;
  extends: DocsViewLink | null;
  /** When the member is inherited through `extends`: the node that declares it. */
  declaredOn: DocsViewLink | null;
  attrs: DocsViewAttr[];
  /** The references its own attributes and `extends` carry. */
  refs: DocsViewRef[];
  /** The claims on it or on anything nested in it. */
  claims: DocsViewClaim[];
  memberGroups: DocsViewMemberGroup[];
}

export interface DocsViewNodeCounts {
  members: number;
  refs: number;
  referencedBy: number;
  claims: number;
  files: number;
  routes: number;
}

/** A top-level node of any type. */
export interface DocsViewNode {
  id: string;
  name: string;
  package: string;
  type: string;
  subType: string;
  /** Its position among the top-level nodes, in declaration order (0-based). */
  order: number;
  /** Its page. */
  path: string;
  title: string;
  description: string;
  summary: string;
  abstract: boolean;
  extends: DocsViewLink | null;
  attrs: DocsViewAttr[];
  memberGroups: DocsViewMemberGroup[];
  /** Every reference from it or any of its members, in walk order. */
  refs: DocsViewRef[];
  referencedBy: DocsViewReferrer[];
  claims: DocsViewClaim[];
  files: DocsViewFileGroup[];
  routes: DocsViewRoute[];
  /** The requirement gate reports that no requirement claims this entity. */
  unclaimed: boolean;
  counts: DocsViewNodeCounts;
}

export interface DocsViewStatusCount {
  status: string;
  count: number;
}

export interface DocsViewRequirementLink {
  /** As authored. */
  ref: string;
  resolves: boolean;
  /** Unresolved when `resolves` is false. */
  target: DocsViewLink;
}

export interface DocsViewDiagnostic {
  code: string;
  severity: string;
  /** "gate" can fail the build; "lint" never can. */
  source: string;
  message: string;
}

/** One requirement, at any depth, in document order. */
export interface DocsViewRequirement {
  id: string;
  name: string;
  label: string;
  /** Its page. */
  path: string;
  /** The dotted path of requirement names every `verify` diagnostic prints. */
  address: string;
  package: string;
  /** `<package>::<address>`, or the address with no package. */
  qualifiedPath: string;
  subType: string;
  level: number | null;
  status: string;
  disposition: string;
  statement: string;
  counterexample: string;
  title: string;
  description: string;
  trackedBy: string[];
  /** The number of requirements above it. */
  depth: number;
  parent: DocsViewLink | null;
  /** The requirements above it, outermost first. */
  breadcrumbs: DocsViewLink[];
  children: DocsViewLink[];
  implementedBy: DocsViewRequirementLink[];
  /** As the gate resolved it; null without one, or without a verify payload. */
  supersededBy: DocsViewRequirementLink | null;
  /** The verify payload carried a ledger row for it. */
  inLedger: boolean;
  /** "clean" | "warn" | "error", from the gate; "" without a ledger row. */
  verdict: string;
  digest: string;
  diagnostics: DocsViewDiagnostic[];
  /** The declared statuses of the requirements below that name the model (level 4 or 5, or no
   *  level and an `@implementedBy`), each status with its count. A requirement with none such
   *  below counts itself. */
  rollup: DocsViewStatusCount[];
  rollupTotal: number;
  belowCount: number;
  childCount: number;
  /** The top-level nodes it and the requirements below it claim, sorted by id. */
  targets: DocsViewLink[];
  targetCount: number;
}

export interface DocsViewTypeGroup {
  type: string;
  subType: string;
  count: number;
  nodes: DocsViewLink[];
}

export interface DocsViewPackage {
  /** "" for nodes with no package. */
  name: string;
  count: number;
  groups: DocsViewTypeGroup[];
}

export interface DocsViewCounts {
  nodes: number;
  packages: number;
  requirements: number;
  functional: number;
  architectural: number;
  byStatus: DocsViewStatusCount[];
  claims: number;
  files: number;
  routes: number;
  /** From the verify payload; 0 without one. */
  undecided: number;
  /** The gate measured entity coverage. */
  coverageMeasured: boolean;
  entitiesClaimed: number;
  entitiesTotal: number;
}

/** Which optional inputs the build read. */
export interface DocsViewSources {
  requirements: boolean;
  files: boolean;
  routes: boolean;
}

/** One finding `meta verify` reported. */
export interface DocsViewAdvisory {
  code: string;
  /** The requirement's address; "" when the subject is not a requirement. */
  path: string;
  /** The node the finding is about when it is not a requirement. */
  subject: DocsViewLink | null;
  severity: string;
  source: string;
  message: string;
}

export type DocsViewSliceKind = "package" | "prompt" | "requirement";

/** A named set of nodes the map opens on. */
export interface DocsViewSlice {
  /** `<kind>:<anchor>`. */
  id: string;
  kind: DocsViewSliceKind;
  /** The package, prompt id or requirement id it is derived from. */
  anchor: string;
  /** Node ids, sorted. */
  nodes: string[];
}

export interface DocsView {
  format: typeof DOCS_VIEW_FORMAT;
  sources: DocsViewSources;
  counts: DocsViewCounts;
  packages: DocsViewPackage[];
  /** Every top-level node, sorted by id. */
  nodes: DocsViewNode[];
  requirements: DocsViewRequirement[];
  advisories: DocsViewAdvisory[];
  slices: DocsViewSlice[];
}
