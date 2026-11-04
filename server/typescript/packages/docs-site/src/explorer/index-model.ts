// An in-memory index over one `explorer.json`: the lookups every explorer page shares.
//
// It reads the document and nothing else. A view asks this index; it never walks the loader, so
// what a page shows is exactly what the data spine states (design report §3.1, "views never
// re-derive model facts"). The only arithmetic here is the explorer's own: the roll-up of the
// statuses below a requirement, which §4.2 calls computable and ungated, and which a page shows
// as a separate bar, never as the requirement's colour.

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
} from "@metaobjectsdev/metadata/constants";
import {
  REQUIREMENT_ATTR_LEVEL,
  REQUIREMENT_ATTR_STATUS,
  REQUIREMENT_SUBTYPE_ARCHITECTURAL,
  REQUIREMENT_SUBTYPE_FUNCTIONAL,
  REQUIREMENT_STATUSES,
  REQUIREMENT_STATUS_LIVE,
  REQUIREMENT_STATUS_PARTIAL,
  REQUIREMENT_STATUS_PLANNED,
  REQUIREMENT_STATUS_RETIRED,
} from "@metaobjectsdev/metadata";
import type { ExplorerEdge, ExplorerGeneratedFile, ExplorerJson, ExplorerLedgerRow, ExplorerNode, ExplorerRoute, ExplorerSlice } from "./types.js";

/** The four declared statuses, in the order every bar and legend draws them: live first, since
 *  it is the claim a reader looks for, and the bar reads left to right as "done". */
export const STATUSES: readonly string[] = [
  REQUIREMENT_STATUS_LIVE,
  REQUIREMENT_STATUS_PARTIAL,
  REQUIREMENT_STATUS_PLANNED,
  REQUIREMENT_STATUS_RETIRED,
].filter((s) => (REQUIREMENT_STATUSES as readonly string[]).includes(s));
const STATUS_ORDER = STATUSES;

/** The glyph for each status, so the colour is never the only signal (§4.2). */
export const STATUS_GLYPH: Readonly<Record<string, string>> = {
  [REQUIREMENT_STATUS_LIVE]: "●",
  [REQUIREMENT_STATUS_PARTIAL]: "◐",
  [REQUIREMENT_STATUS_PLANNED]: "○",
  [REQUIREMENT_STATUS_RETIRED]: "⊘",
};

/** Edges drawn between model nodes on the map and the mini-maps. */
export const MODEL_EDGE_KINDS: readonly string[] = ["references", "association", "objectRef", "payload", "reply", "extends"];

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One requirement as the pages read it: the node, its ledger row, its place in the tree. */
export interface ReqEntry {
  node: ExplorerNode;
  row?: ExplorerLedgerRow;
  parent?: ReqEntry;
  children: ReqEntry[];
  level?: number;
  status: string;
  /** functional | architectural */
  kind: string;
}

/** A requirement's claim on a model node, as the ledger resolved it. */
export interface Claim {
  req: ReqEntry;
  /** The member path when the claim names a member (`Order.reference`), else undefined. */
  member?: string;
}

export type Rollup = Record<string, number>;

export class ExplorerIndex {
  readonly doc: ExplorerJson;
  readonly byId = new Map<string, ExplorerNode>();
  private readonly kids = new Map<string, ExplorerNode[]>();
  /** Top-level object nodes (entity, value, projection, report, …), by id. */
  readonly objects: ExplorerNode[] = [];
  /** Top-level template nodes (prompt, output, …), by id. */
  readonly templates: ExplorerNode[] = [];
  /** Every requirement, in document order (the ledger's order when there is one). */
  readonly requirements: ReqEntry[] = [];
  readonly reqById = new Map<string, ReqEntry>();
  /** The top of each requirement tree, in document order. */
  readonly topRequirements: ReqEntry[] = [];
  private readonly claimsOn = new Map<string, Claim[]>();
  private readonly generatedOf = new Map<string, ExplorerGeneratedFile[]>();
  private readonly routesOf = new Map<string, ExplorerRoute[]>();
  readonly packages: string[];

  constructor(doc: ExplorerJson) {
    this.doc = doc;
    for (const n of doc.nodes) this.byId.set(n.id, n);
    for (const n of doc.nodes) {
      if (n.parent === undefined) continue;
      const list = this.kids.get(n.parent) ?? [];
      list.push(n);
      this.kids.set(n.parent, list);
    }
    for (const list of this.kids.values()) list.sort((a, b) => a.order - b.order || byCodeUnit(a.id, b.id));
    for (const n of doc.nodes) {
      if (n.parent !== undefined) continue;
      if (n.type === TYPE_OBJECT) this.objects.push(n);
      else if (n.type === TYPE_TEMPLATE) this.templates.push(n);
    }
    this.packages = [...new Set(doc.nodes.filter((n) => n.parent === undefined).map((n) => n.package))].sort(byCodeUnit);
    this.indexRequirements();
    for (const e of doc.edges) {
      if (e.kind !== "implementedBy") continue;
      const req = this.reqById.get(e.from);
      if (req === undefined) continue;
      const owner = this.ownerOf(e.to);
      const member = owner === e.to ? undefined : e.to.slice(owner.length + 1);
      const list = this.claimsOn.get(owner) ?? [];
      list.push({ req, ...(member !== undefined ? { member } : {}) });
      this.claimsOn.set(owner, list);
    }
    for (const g of doc.generated ?? []) this.generatedOf.set(g.node, g.files);
    for (const r of doc.api ?? []) {
      const list = this.routesOf.get(r.node) ?? [];
      list.push(r);
      this.routesOf.set(r.node, list);
    }
  }

  private indexRequirements(): void {
    const rows = new Map((this.doc.ledger?.rows ?? []).map((r) => [r.node, r] as const));
    const reqNodes = this.doc.nodes.filter((n) => n.type === TYPE_REQUIREMENT);
    // Document order: the ledger's when there is one (the verify payload walks the model in
    // declaration order), else each node's sibling order under its parent.
    const ledgerOrder = new Map((this.doc.ledger?.rows ?? []).map((r, i) => [r.node, i] as const));
    const depthFirst: ExplorerNode[] = [];
    const visit = (n: ExplorerNode): void => {
      depthFirst.push(n);
      for (const c of this.children(n.id)) if (c.type === TYPE_REQUIREMENT) visit(c);
    };
    const tops = reqNodes
      .filter((n) => n.parent === undefined || this.byId.get(n.parent)?.type !== TYPE_REQUIREMENT)
      .sort((a, b) => (ledgerOrder.get(a.id) ?? Infinity) - (ledgerOrder.get(b.id) ?? Infinity) || a.order - b.order || byCodeUnit(a.id, b.id));
    for (const t of tops) visit(t);
    for (const n of depthFirst) {
      const row = rows.get(n.id);
      const level = typeof n.attrs[REQUIREMENT_ATTR_LEVEL] === "number" ? (n.attrs[REQUIREMENT_ATTR_LEVEL] as number) : row?.level;
      const status = typeof n.attrs[REQUIREMENT_ATTR_STATUS] === "string" ? (n.attrs[REQUIREMENT_ATTR_STATUS] as string) : (row?.status ?? "");
      const parent = n.parent !== undefined ? this.reqById.get(n.parent) : undefined;
      const entry: ReqEntry = {
        node: n,
        ...(row !== undefined ? { row } : {}),
        ...(parent !== undefined ? { parent } : {}),
        children: [],
        ...(level !== undefined ? { level } : {}),
        status,
        kind: n.subType,
      };
      this.requirements.push(entry);
      this.reqById.set(n.id, entry);
      if (parent !== undefined) parent.children.push(entry);
      else this.topRequirements.push(entry);
    }
  }

  /** Direct children of a node, in declaration order. */
  children(id: string): ExplorerNode[] {
    return this.kids.get(id) ?? [];
  }

  /** The top-level node a node sits under (itself at the top). */
  ownerOf(id: string): string {
    let cur = this.byId.get(id);
    while (cur?.parent !== undefined) cur = this.byId.get(cur.parent);
    return cur?.id ?? id;
  }

  fields(id: string): ExplorerNode[] {
    return this.children(id).filter((c) => c.type === TYPE_FIELD);
  }

  /** The node's `source.*` child, when it declares one. */
  source(id: string): ExplorerNode | undefined {
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

  isEntity(n: ExplorerNode): boolean {
    return n.type === TYPE_OBJECT && n.subType === OBJECT_SUBTYPE_ENTITY;
  }

  isPrompt(n: ExplorerNode): boolean {
    return n.type === TYPE_TEMPLATE && n.subType === TEMPLATE_SUBTYPE_PROMPT;
  }

  /** The kind a page and the map name a top-level node by. */
  kindOf(n: ExplorerNode): "entity" | "value" | "projection" | "report" | "prompt" | "template" | "object" {
    if (n.type === TYPE_TEMPLATE) return n.subType === TEMPLATE_SUBTYPE_PROMPT ? "prompt" : "template";
    if (n.subType === OBJECT_SUBTYPE_ENTITY) return "entity";
    if (n.subType === OBJECT_SUBTYPE_VALUE) return "value";
    if (n.subType === OBJECT_SUBTYPE_PROJECTION) return "projection";
    if (n.subType === OBJECT_SUBTYPE_REPORT) return "report";
    return "object";
  }

  /** Concrete stored entities: `object.entity`, not abstract. */
  storedEntities(): ExplorerNode[] {
    return this.objects.filter((o) => this.isEntity(o) && o.abstract !== true);
  }

  claims(id: string): Claim[] {
    return this.claimsOn.get(id) ?? [];
  }

  generated(id: string): ExplorerGeneratedFile[] {
    return this.generatedOf.get(id) ?? [];
  }

  routes(id: string): ExplorerRoute[] {
    return this.routesOf.get(id) ?? [];
  }

  hasRequirements(): boolean {
    return this.requirements.length > 0;
  }

  /** Whether any requirement claims anything: object coverage only means something then. */
  hasClaims(): boolean {
    return this.claimsOn.size > 0;
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

  /** The declared statuses of the entries below that name the model (L4, L5, or a flat
   *  architectural policy with links), counted. A leaf counts itself. */
  rollup(r: ReqEntry): Rollup {
    const linked = this.subtree(r).filter((x) => (x.level ?? 0) >= 4 || (x.level === undefined && (x.row?.implementedBy.length ?? 0) > 0));
    const counted = linked.length > 0 ? linked : [r];
    const c: Rollup = {};
    for (const x of counted) if (x.status !== "") c[x.status] = (c[x.status] ?? 0) + 1;
    return c;
  }

  /** The model nodes the subtree claims (owners, deduplicated, sorted). */
  targetsOf(r: ReqEntry): string[] {
    const set = new Set<string>();
    for (const x of this.subtree(r)) {
      for (const l of x.row?.implementedBy ?? []) if (l.target !== undefined && this.byId.has(l.target)) set.add(this.ownerOf(l.target));
    }
    return [...set].sort(byCodeUnit);
  }

  /** The ledger's gate verdict for a requirement: "error" | "warn" | "clean" | "". */
  verdict(r: ReqEntry): string {
    return r.row?.verdict ?? "";
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
    for (const s of STATUS_ORDER) if (cl.some((c) => c.req.status === s)) return s;
    return "unclaimed";
  }

  /** Model edges between two top-level nodes (a member's edge is drawn from its owner). */
  modelEdges(): ExplorerEdge[] {
    const out: ExplorerEdge[] = [];
    const seen = new Set<string>();
    for (const e of this.doc.edges) {
      if (!MODEL_EDGE_KINDS.includes(e.kind)) continue;
      const from = this.ownerOf(e.from);
      const to = this.ownerOf(e.to);
      if (from === to) continue;
      const a = this.byId.get(from);
      const b = this.byId.get(to);
      if (a === undefined || b === undefined) continue;
      if (a.type === TYPE_REQUIREMENT || b.type === TYPE_REQUIREMENT) continue;
      const key = `${e.kind}\u0000${from}\u0000${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: e.kind, from, to, ...(e.via !== undefined ? { via: e.via } : {}) });
    }
    return out;
  }

  slice(id: string): ExplorerSlice | undefined {
    return this.doc.slices.find((s) => s.id === id);
  }
}
