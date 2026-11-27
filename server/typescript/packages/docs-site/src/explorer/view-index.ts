// An in-memory index over one docs view: the lookups every explorer page shares.
//
// It reads the view and nothing else, and it derives nothing the view does not state: it only
// files the view's nodes, members, requirements, claims, files and routes by id so a page can
// find them. Ids, pages, inheritance, references, claims and roll-ups are the view's
// (`buildDocsView` in `@metaobjectsdev/metadata`, built from the loaded model).

import {
  OBJECT_SUBTYPE_ENTITY,
  OBJECT_SUBTYPE_PROJECTION,
  OBJECT_SUBTYPE_REPORT,
  OBJECT_SUBTYPE_VALUE,
  SOURCE_ATTR_KIND,
  SOURCE_ATTR_TABLE,
  SOURCE_ATTR_VIEW,
  SOURCE_KIND_VIEW,
  TEMPLATE_SUBTYPE_PROMPT,
  TYPE_FIELD,
  TYPE_OBJECT,
  TYPE_REQUIREMENT,
  TYPE_SOURCE,
  TYPE_TEMPLATE,
  REQUIREMENT_SUBTYPE_ARCHITECTURAL,
  REQUIREMENT_SUBTYPE_FUNCTIONAL,
  REQUIREMENT_STATUSES,
  REQUIREMENT_STATUS_LIVE,
  REQUIREMENT_STATUS_PARTIAL,
  REQUIREMENT_STATUS_PLANNED,
  REQUIREMENT_STATUS_RETIRED,
} from "@metaobjectsdev/metadata/constants";
import type {
  DocsView,
  DocsViewMember,
  DocsViewNode,
  DocsViewRequirement,
  DocsViewRoute,
  DocsViewSlice,
} from "@metaobjectsdev/metadata";

/** The four declared statuses, in the order every bar and legend draws them: live first, since
 *  it is the claim a reader looks for, and the bar reads left to right as "done". */
export const STATUSES: readonly string[] = [
  REQUIREMENT_STATUS_LIVE,
  REQUIREMENT_STATUS_PARTIAL,
  REQUIREMENT_STATUS_PLANNED,
  REQUIREMENT_STATUS_RETIRED,
].filter((s) => (REQUIREMENT_STATUSES as readonly string[]).includes(s));

/** The glyph for each status, so the colour is never the only signal (§4.2). */
export const STATUS_GLYPH: Readonly<Record<string, string>> = {
  [REQUIREMENT_STATUS_LIVE]: "●",
  [REQUIREMENT_STATUS_PARTIAL]: "◐",
  [REQUIREMENT_STATUS_PLANNED]: "○",
  [REQUIREMENT_STATUS_RETIRED]: "⊘",
};

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A top-level node or a member, filed by id, with its attributes by name. */
export interface PageNode {
  id: string;
  type: string;
  subType: string;
  name: string;
  /** The package of its top-level node. */
  package: string;
  order: number;
  /** The id of the node it is nested in; absent at the top. */
  parent?: string;
  /** Where a link to it lands. */
  path: string;
  /** The anchor its row carries, on a direct member of a top-level node; "" otherwise. */
  anchor: string;
  /** The id `extends` resolved to. */
  extends?: string;
  abstract: boolean;
  isArray: boolean;
  /** The id of the node that declares it, when it is inherited. */
  inheritedFrom?: string;
  /** Every effective attribute's value, by name. */
  attrs: Record<string, unknown>;
  view: DocsViewNode | DocsViewMember;
}

/** One requirement as the pages read it: the view's entry and its place in the tree. */
export interface ReqEntry {
  node: PageNode;
  req: DocsViewRequirement;
  parent?: ReqEntry;
  children: ReqEntry[];
  level?: number;
  status: string;
  /** functional | architectural */
  kind: string;
}

/** A requirement's claim on a model node. */
export interface Claim {
  req: ReqEntry;
  /** The member path when the claim names a member (`Order.reference`), else undefined. */
  member?: string;
}

export type Rollup = Record<string, number>;

/** A link drawn between two top-level nodes on the map, from a reference the view lists. */
export interface ModelEdge {
  /** The attribute that carries it (`objectRef`, `payloadRef`, …), or `extends`. */
  kind: string;
  from: string;
  to: string;
  via?: string;
}

export interface GeneratedFile {
  path: string;
  generatedBy: string;
}

export class ViewIndex {
  readonly view: DocsView;
  readonly byId = new Map<string, PageNode>();
  private readonly kids = new Map<string, PageNode[]>();
  /** Top-level object nodes, by id. */
  readonly objects: PageNode[] = [];
  /** Top-level template nodes, by id. */
  readonly templates: PageNode[] = [];
  /** Top-level nodes of every other type but requirement, each on a generic page. */
  readonly others: PageNode[] = [];
  /** Every requirement, in document order. */
  readonly requirements: ReqEntry[] = [];
  readonly reqById = new Map<string, ReqEntry>();
  readonly topRequirements: ReqEntry[] = [];
  readonly packages: string[];
  private readonly topOf = new Map<string, DocsViewNode>();

  constructor(view: DocsView) {
    this.view = view;
    for (const n of view.nodes) {
      const top = this.file(n, n.package, undefined);
      this.topOf.set(n.id, n);
      for (const g of n.memberGroups) for (const m of g.members) this.fileMember(m, n.package, top.id);
      if (n.type === TYPE_OBJECT) this.objects.push(top);
      else if (n.type === TYPE_TEMPLATE) this.templates.push(top);
      else if (n.type !== TYPE_REQUIREMENT) this.others.push(top);
    }
    for (const list of this.kids.values()) list.sort((a, b) => a.order - b.order || byCodeUnit(a.id, b.id));
    this.packages = view.packages.map((p) => p.name);
    for (const r of view.requirements) {
      const node = this.byId.get(r.id);
      if (node === undefined) continue;
      const parent = r.parent !== null ? this.reqById.get(r.parent.id) : undefined;
      const entry: ReqEntry = {
        node,
        req: r,
        ...(parent !== undefined ? { parent } : {}),
        children: [],
        ...(r.level !== null ? { level: r.level } : {}),
        status: r.status,
        kind: r.subType,
      };
      this.requirements.push(entry);
      this.reqById.set(r.id, entry);
      if (parent !== undefined) parent.children.push(entry);
      else this.topRequirements.push(entry);
    }
  }

  private file(v: DocsViewNode | DocsViewMember, pkg: string, parent: string | undefined): PageNode {
    const attrs: Record<string, unknown> = {};
    for (const a of v.attrs) attrs[a.name] = a.value;
    const declaredOn = "declaredOn" in v ? v.declaredOn : null;
    const n: PageNode = {
      id: v.id,
      type: v.type,
      subType: v.subType,
      name: v.name,
      package: pkg,
      order: v.order,
      ...(parent !== undefined ? { parent } : {}),
      path: v.path,
      anchor: "anchor" in v ? v.anchor : "",
      ...(v.extends !== null && !v.extends.unresolved ? { extends: v.extends.id } : {}),
      abstract: v.abstract,
      isArray: "isArray" in v ? v.isArray : false,
      ...(declaredOn !== null && !declaredOn.unresolved ? { inheritedFrom: declaredOn.id } : {}),
      attrs,
      view: v,
    };
    this.byId.set(n.id, n);
    if (parent !== undefined) this.kids.set(parent, [...(this.kids.get(parent) ?? []), n]);
    return n;
  }

  private fileMember(m: DocsViewMember, pkg: string, parent: string): void {
    this.file(m, pkg, parent);
    for (const g of m.memberGroups) for (const c of g.members) this.fileMember(c, pkg, m.id);
  }

  /** Direct children of a node, in declaration order. */
  children(id: string): PageNode[] {
    return this.kids.get(id) ?? [];
  }

  /** The top-level node a node sits under (itself at the top). */
  ownerOf(id: string): string {
    let cur = this.byId.get(id);
    while (cur?.parent !== undefined) cur = this.byId.get(cur.parent);
    return cur?.id ?? id;
  }

  /** The view's entry for a top-level node. */
  top(id: string): DocsViewNode | undefined {
    return this.topOf.get(id);
  }

  fields(id: string): PageNode[] {
    return this.children(id).filter((c) => c.type === TYPE_FIELD);
  }

  /** The node's `source.*` child, when it declares one. */
  source(id: string): PageNode | undefined {
    return this.children(id).find((c) => c.type === TYPE_SOURCE);
  }

  /** `table x`, `view v_x`, or undefined: what the source declares, never a derived name. */
  storage(id: string): { kind: "table" | "view"; name?: string } | undefined {
    const s = this.source(id);
    if (s === undefined) return undefined;
    const view = s.attrs[SOURCE_ATTR_VIEW];
    const table = s.attrs[SOURCE_ATTR_TABLE];
    const isView = s.attrs[SOURCE_ATTR_KIND] === SOURCE_KIND_VIEW || typeof view === "string";
    const name = typeof view === "string" ? view : typeof table === "string" ? table : undefined;
    return { kind: isView ? "view" : "table", ...(name !== undefined ? { name } : {}) };
  }

  isEntity(n: PageNode): boolean {
    return n.type === TYPE_OBJECT && n.subType === OBJECT_SUBTYPE_ENTITY;
  }

  isPrompt(n: PageNode): boolean {
    return n.type === TYPE_TEMPLATE && n.subType === TEMPLATE_SUBTYPE_PROMPT;
  }

  /** The kind a page and the map name a top-level node by. */
  kindOf(n: PageNode): "entity" | "value" | "projection" | "report" | "prompt" | "template" | "object" | "other" {
    if (n.type === TYPE_TEMPLATE) return n.subType === TEMPLATE_SUBTYPE_PROMPT ? "prompt" : "template";
    if (n.type !== TYPE_OBJECT) return "other";
    if (n.subType === OBJECT_SUBTYPE_ENTITY) return "entity";
    if (n.subType === OBJECT_SUBTYPE_VALUE) return "value";
    if (n.subType === OBJECT_SUBTYPE_PROJECTION) return "projection";
    if (n.subType === OBJECT_SUBTYPE_REPORT) return "report";
    return "object";
  }

  /** Concrete stored entities: `object.entity`, not abstract. */
  storedEntities(): PageNode[] {
    return this.objects.filter((o) => this.isEntity(o) && !o.abstract);
  }

  claims(id: string): Claim[] {
    const v = this.byId.get(id)?.view;
    if (v === undefined) return [];
    return v.claims.flatMap((c) => {
      const req = this.reqById.get(c.requirement.id);
      return req === undefined ? [] : [{ req, ...(c.member !== "" ? { member: c.member } : {}) }];
    });
  }

  generated(id: string): GeneratedFile[] {
    return (this.topOf.get(id)?.files ?? []).flatMap((g) => g.paths.map((path) => ({ path, generatedBy: g.generatedBy })));
  }

  routes(id: string): DocsViewRoute[] {
    return this.topOf.get(id)?.routes ?? [];
  }

  hasRequirements(): boolean {
    return this.requirements.length > 0;
  }

  /** Whether any requirement claims anything: object coverage only means something then. */
  hasClaims(): boolean {
    return this.view.counts.claims > 0;
  }

  /** The requirement and every requirement below it, depth first. */
  subtree(r: ReqEntry): ReqEntry[] {
    const out: ReqEntry[] = [];
    const walk = (x: ReqEntry): void => {
      out.push(x);
      for (const c of x.children) walk(c);
    };
    walk(r);
    return out;
  }

  below(r: ReqEntry): ReqEntry[] {
    return this.subtree(r).slice(1);
  }

  /** The view's roll-up of the statuses below, by status. */
  rollup(r: ReqEntry): Rollup {
    const c: Rollup = {};
    for (const s of r.req.rollup) if (s.count > 0) c[s.status] = s.count;
    return c;
  }

  /** The top-level nodes the subtree claims (sorted). */
  targetsOf(r: ReqEntry): string[] {
    return r.req.targets.map((t) => t.id);
  }

  /** The node ids an `@implementedBy` of the requirement resolves to. */
  linkTargets(r: ReqEntry): string[] {
    return r.req.implementedBy.filter((l) => l.resolves && this.byId.has(l.target.id)).map((l) => l.target.id);
  }

  /** The L1 feature (functional top) with the most claims on a node, by document order on a tie. */
  featureOf(id: string): ReqEntry | undefined {
    const count = new Map<ReqEntry, number>();
    for (const c of this.claims(id)) {
      let top = c.req;
      while (top.parent !== undefined) top = top.parent;
      if (top.kind !== REQUIREMENT_SUBTYPE_FUNCTIONAL) continue;
      count.set(top, (count.get(top) ?? 0) + 1);
    }
    let best: ReqEntry | undefined;
    for (const t of this.features()) {
      const n = count.get(t) ?? 0;
      if (n > 0 && (best === undefined || n > (count.get(best) ?? 0))) best = t;
    }
    return best;
  }

  features(): ReqEntry[] {
    return this.topRequirements.filter((r) => r.kind === REQUIREMENT_SUBTYPE_FUNCTIONAL);
  }

  qualities(): ReqEntry[] {
    return this.topRequirements.filter((r) => r.kind === REQUIREMENT_SUBTYPE_ARCHITECTURAL);
  }

  /** The best declared status among a node's claims, or "unclaimed". */
  claimStatus(id: string): string {
    const cl = this.claims(id);
    if (cl.length === 0) return "unclaimed";
    for (const s of STATUSES) if (cl.some((c) => c.req.status === s)) return s;
    return "unclaimed";
  }

  /** The references between two top-level nodes, one per (kind, from, to): a member's
   *  reference is drawn from its top-level node. Requirements are left out. */
  modelEdges(): ModelEdge[] {
    const out: ModelEdge[] = [];
    const seen = new Set<string>();
    for (const n of this.view.nodes) {
      if (n.type === TYPE_REQUIREMENT) continue;
      for (const r of n.refs) {
        const to = this.ownerOf(r.target.id);
        const b = this.byId.get(to);
        if (to === n.id || b === undefined || b.type === TYPE_REQUIREMENT) continue;
        const key = `${r.attr}\u0000${n.id}\u0000${to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind: r.attr, from: n.id, to, ...(r.via !== null ? { via: r.via.id } : {}) });
      }
    }
    return out.sort((a, b) => byCodeUnit(`${a.kind}\u0000${a.from}\u0000${a.to}`, `${b.kind}\u0000${b.from}\u0000${b.to}`));
  }

  slice(id: string): DocsViewSlice | undefined {
    return this.view.slices.find((s) => s.id === id);
  }
}
