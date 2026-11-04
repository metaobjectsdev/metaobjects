// The explorer's page models: one function per screen (design report §3.3, S1 to S9, plus the
// API index, the package pages and the prompt index). Each returns the payload its Mustache
// template renders; every string in it is already HTML-escaped, because the renderer's text
// format does not escape.
//
// Every fact a page states is read off the ExplorerIndex, which reads only `explorer.json`. The
// pages add presentation (grouping, ordering, wording) and the explorer checks the gaps page
// labels as such; they never recompute what the loader or the gate decided.

import {
  FIELD_ATTR_COLUMN,
  FIELD_ATTR_DEFAULT,
  FIELD_ATTR_FILTERABLE,
  FIELD_ATTR_MAX_LENGTH,
  FIELD_ATTR_OBJECT_REF,
  FIELD_ATTR_REQUIRED,
  FIELD_ATTR_SORTABLE,
  FIELD_ATTR_VALUES,
  FIELD_SUBTYPE_ENUM,
  IDENTITY_ATTR_FIELDS,
  IDENTITY_REFERENCE_ATTR_REFERENCES,
  OBJECT_REPORT_ATTR_DIMENSIONS,
  OBJECT_REPORT_ATTR_FILTER,
  OBJECT_REPORT_ATTR_FROM,
  OBJECT_REPORT_ATTR_MEASURES,
  OBJECT_REPORT_ATTR_SEGMENT,
  OBJECT_REPORT_ATTR_SPINE,
  ORIGIN_AGGREGATE_ATTR_AGG,
  ORIGIN_AGGREGATE_ATTR_FILTER,
  ORIGIN_AGGREGATE_ATTR_OF,
  ORIGIN_AGGREGATE_ATTR_VIA,
  ORIGIN_COMPUTED_ATTR_EXPR,
  ORIGIN_PASSTHROUGH_ATTR_FROM,
  RELATIONSHIP_ATTR_CARDINALITY,
  RELATIONSHIP_ATTR_OBJECT_REF,
  RELATIONSHIP_ATTR_THROUGH,
  REPORTING_ATTR_AGG,
  REPORTING_ATTR_DEFAULT,
  REPORTING_ATTR_DENOMINATOR,
  REPORTING_ATTR_FILTER,
  REPORTING_ATTR_GRAINS,
  REPORTING_ATTR_NUMERATOR,
  REPORTING_ATTR_OF,
  REPORTING_ATTR_SEGMENT,
  REPORTING_ATTR_VIA,
  TEMPLATE_ATTR_FORMAT,
  TEMPLATE_ATTR_MAX_TOKENS,
  TEMPLATE_ATTR_MODEL,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_PROMPT_STYLE,
  TEMPLATE_ATTR_RESPONSE_FORMAT,
  TEMPLATE_ATTR_RESPONSE_REF,
  TEMPLATE_ATTR_TEXT_REF,
  DOC_ATTR_DESCRIPTION,
  DOC_ATTR_SUMMARY,
  DOC_ATTR_TITLE,
  TYPE_DIMENSION,
  TYPE_FIELD,
  TYPE_IDENTITY,
  TYPE_INDEX,
  TYPE_LAYOUT,
  TYPE_MEASURE,
  TYPE_ORIGIN,
  TYPE_RELATIONSHIP,
  TYPE_REQUIREMENT,
  TYPE_SEGMENT,
} from "@metaobjectsdev/metadata/constants";
import {
  LAYOUT_DATA_GRID_ATTR_COLUMNS,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER,
  LAYOUT_DATA_GRID_ATTR_PAGE_SIZE,
  REQUIREMENT_ATTR_COUNTEREXAMPLE,
  REQUIREMENT_ATTR_DISPOSITION,
  REQUIREMENT_ATTR_STATEMENT,
  REQUIREMENT_ATTR_TRACKED_BY,
  REQUIREMENT_LEVEL_OBJECT,
  REQUIREMENT_LEVEL_SERVICE,
  REQUIREMENT_STATUS_LIVE,
  REQUIREMENT_STATUS_PLANNED,
  REQUIREMENT_STATUSES_WITH_OUTSTANDING_WORK,
  REQUIREMENT_SUBTYPE_ARCHITECTURAL,
  REQUIREMENT_SUBTYPE_FUNCTIONAL,
} from "@metaobjectsdev/metadata";
import type { ExplorerIndex, ReqEntry } from "./index-model.js";
import { STATUSES } from "./index-model.js";
import type { ExplorerNode } from "./types.js";
import {
  dispositionPill,
  esc,
  GATE_SOURCE,
  levelBadge,
  relHref,
  rollupBar,
  statusChip,
  statusGlyph,
  verdictBadge,
} from "./html.js";

// ─── Where every page lives ──────────────────────────────────────────────────────────────────

export const PAGE_OVERVIEW = "index.html";
export const PAGE_MAP = "map.html";
export const PAGE_FEATURES = "requirements/features.html";
export const PAGE_QUALITIES = "requirements/qualities.html";
export const PAGE_MATRIX = "matrix.html";
export const PAGE_TRACE = "trace.html";
export const PAGE_PROMPTS = "prompts.html";
export const PAGE_API = "api.html";
export const PAGE_GAPS = "gaps.html";
export const PAGE_MODEL = "model/index.html";

/** The member types a page gives an anchor, so an L5 link can land on its row. */
const ANCHORED_TYPES = new Set<string>([TYPE_FIELD, TYPE_IDENTITY, TYPE_INDEX, TYPE_RELATIONSHIP, TYPE_DIMENSION, TYPE_MEASURE, TYPE_SEGMENT]);

/** A member row's anchor: `m-<name>` for a field, `m-<type>-<name>` for anything else, since
 *  siblings of different types may share a name. */
const memberAnchor = (n: ExplorerNode): string => (n.type === TYPE_FIELD ? `m-${n.name}` : `m-${n.type}-${n.name}`);

/** The gate codes that report the level and nesting rules (the proof table's "Level rules"). */
const LEVEL_RULE_CODES = new Set(["ERR_REQUIREMENT_BAD_LEVEL", "ERR_REQUIREMENT_LEVEL_NESTING", "ERR_REQUIREMENT_LINK_ABOVE_FLOOR"]);
const CODE_OBJECT_UNCLAIMED = "WARN_REQUIREMENT_OBJECT_UNCLAIMED";

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);

/** The directory of a package's pages. A package segment is an identifier, so `-root` (for
 *  the empty package) cannot be one. */
function pkgDir(pkg: string): string {
  return pkg === "" ? "-root" : pkg.split("::").join("/");
}

/** A page's file stem: the name, unless it would take the package page's `index.html` (on a
 *  case-insensitive file system too). */
function pageStem(name: string): string {
  return name.toLowerCase() === "index" ? `${name}.node` : name;
}

/** A short form of an id for display: the part after the package. */
export function localName(id: string): string {
  const i = id.lastIndexOf("::");
  return i < 0 ? id : id.slice(i + 2);
}

export class Pages {
  constructor(readonly ix: ExplorerIndex) {}

  // ─── Addresses ───────────────────────────────────────────────────────────────

  objectPage(n: ExplorerNode): string {
    return `model/${pkgDir(n.package)}/${pageStem(n.name)}.html`;
  }

  packagePage(pkg: string): string {
    return `model/${pkgDir(pkg)}/index.html`;
  }

  reqPage(r: ReqEntry): string {
    return `requirements/${pkgDir(r.node.package)}/${pageStem(this.reqPath(r))}.html`;
  }

  /** The requirement's dotted path, as every `verify` diagnostic prints it. */
  reqPath(r: ReqEntry): string {
    if (r.row !== undefined) return r.row.path;
    const prefix = r.node.package === "" ? "" : `${r.node.package}::`;
    return r.node.id.startsWith(prefix) ? r.node.id.slice(prefix.length) : r.node.id;
  }

  reqLabel(r: ReqEntry): string {
    return str(r.node.attrs[DOC_ATTR_TITLE]) ?? r.node.name;
  }

  /** Where a node id lands: its own page, or its owner's page at the member's row. */
  pageOf(id: string): string | undefined {
    const req = this.ix.reqById.get(id);
    if (req !== undefined) return this.reqPage(req);
    const ownerId = this.ix.ownerOf(id);
    const owner = this.ix.byId.get(ownerId);
    if (owner === undefined || owner.type === TYPE_REQUIREMENT) return undefined;
    const page = this.objectPage(owner);
    if (ownerId === id) return page;
    const member = this.memberOf(ownerId, id);
    return member !== undefined && ANCHORED_TYPES.has(member.type) ? `${page}#${memberAnchor(member)}` : page;
  }

  /** The direct child of `ownerId` that `id` sits in (or is). */
  private memberOf(ownerId: string, id: string): ExplorerNode | undefined {
    let cur = this.ix.byId.get(id);
    while (cur !== undefined && cur.parent !== ownerId) cur = cur.parent !== undefined ? this.ix.byId.get(cur.parent) : undefined;
    return cur;
  }

  kindClass(n: ExplorerNode): string {
    return `k-${this.ix.kindOf(n)}`;
  }

  /** A link to any node, relative to `from`; an unknown id renders as a red "unresolved" chip. */
  link(from: string, id: string, label?: string): string {
    const page = this.pageOf(id);
    const n = this.ix.byId.get(this.ix.ownerOf(id));
    if (page === undefined || n === undefined) return `<span class="chip v-error">${esc(label ?? localName(id))} (unresolved)</span>`;
    const req = this.ix.reqById.get(id);
    const text = label ?? (req !== undefined ? this.reqLabel(req) : id === n.id ? n.name : `${n.name}.${id.slice(n.id.length + 1)}`);
    const cls = req !== undefined ? "" : ` class="${this.kindClass(n)}"`;
    return `<a${cls} href="${esc(relHref(from, page))}">${esc(text)}</a>`;
  }

  reqLink(from: string, r: ReqEntry): string {
    return `<a href="${esc(relHref(from, this.reqPage(r)))}">${esc(this.reqLabel(r))}</a>`;
  }

  description(n: ExplorerNode): string {
    return esc(str(n.attrs[DOC_ATTR_DESCRIPTION]) ?? str(n.attrs[DOC_ATTR_SUMMARY]) ?? "");
  }

  topOf(r: ReqEntry): ReqEntry {
    let t = r;
    while (t.parent !== undefined) t = t.parent;
    return t;
  }

  // ─── S1: What it does ────────────────────────────────────────────────────────

  overview(title: string): Record<string, unknown> {
    const ix = this.ix;
    const from = PAGE_OVERVIEW;
    const stored = ix.storedEntities();
    const abstract = ix.objects.filter((o) => ix.isEntity(o) && o.abstract === true).length;
    const prompts = ix.templates.filter((t) => ix.isPrompt(t));
    const values = ix.objects.filter((o) => ix.kindOf(o) === "value").length;
    const projections = ix.objects.filter((o) => ix.kindOf(o) === "projection").length;
    const reports = ix.objects.filter((o) => ix.kindOf(o) === "report").length;
    const counts = ix.doc.ledger?.counts ?? {};
    const num = (k: string): number | undefined => (typeof counts[k] === "number" ? (counts[k] as number) : undefined);
    const features = ix.requirements.filter((r) => r.kind === REQUIREMENT_SUBTYPE_FUNCTIONAL).length;
    const qualities = ix.requirements.filter((r) => r.kind === REQUIREMENT_SUBTYPE_ARCHITECTURAL).length;
    const tiles: { n: string; l: string; href: string }[] = [];
    tiles.push({ n: `${stored.length}`, l: `stored entities${abstract > 0 ? ` (${abstract} abstract base${abstract === 1 ? "" : "s"})` : ""}`, href: relHref(from, PAGE_MAP) });
    tiles.push({ n: `${prompts.length}`, l: `declared prompt${prompts.length === 1 ? "" : "s"}, ${count(values, "payload or reply type", "payload and reply types")}`, href: relHref(from, PAGE_PROMPTS) });
    if (ix.hasRequirements()) {
      tiles.push({ n: `${num("total") ?? ix.requirements.length}`, l: `requirements: ${count(num("functional") ?? features, "feature")}, ${count(num("architectural") ?? qualities, "quality", "qualities")}`, href: relHref(from, PAGE_FEATURES) });
    } else {
      tiles.push({ n: `${projections + reports}`, l: `read models: ${projections} projection${projections === 1 ? "" : "s"}, ${reports} report${reports === 1 ? "" : "s"}`, href: relHref(from, PAGE_MODEL) });
    }
    const claimed = num("entitiesClaimed");
    const claimTotal = num("entitiesTotal");
    if (claimed !== undefined && claimTotal !== undefined && claimTotal > 0) {
      tiles.push({ n: `${claimed}/${claimTotal}`, l: "entities claimed by a requirement (gate)", href: relHref(from, PAGE_GAPS) });
    } else {
      tiles.push({ n: `${ix.packages.length}`, l: `package${ix.packages.length === 1 ? "" : "s"} in the model`, href: relHref(from, PAGE_MODEL) });
    }
    if (ix.doc.api !== undefined) {
      const routed = ix.objects.filter((o) => ix.routes(o.id).length > 0).length;
      tiles.push({ n: `${routed}`, l: "objects with mounted REST routes", href: relHref(from, PAGE_API) });
    } else {
      tiles.push({ n: "—", l: "REST routes: none recorded by this run", href: relHref(from, PAGE_API) });
    }
    const genFiles = new Set((ix.doc.generated ?? []).flatMap((g) => g.files.map((f) => f.path)));
    tiles.push({
      n: ix.doc.generated !== undefined ? `${genFiles.size}` : "—",
      l: ix.doc.generated !== undefined ? "generated files traced to a node" : "generated files: no manifest read",
      href: relHref(from, PAGE_TRACE),
    });
    const sources = ["the effective model"];
    if (ix.doc.ledger !== undefined) sources.push("the requirement gate's ledger");
    if (ix.doc.generated !== undefined) sources.push("the generation manifest");
    return {
      heading: esc(`What ${title} does`),
      sourcesLine: esc(joinAnd(sources)),
      tiles: tiles.map((t) => ({ n: esc(t.n), l: esc(t.l), href: esc(t.href) })),
      hasRequirements: ix.hasRequirements(),
      featureCards: ix.features().map((r) => this.capCard(from, r)),
      qualityCards: ix.qualities().map((r) => this.capCard(from, r)),
      hasFeatures: ix.features().length > 0,
      hasQualities: ix.qualities().length > 0,
      packageCards: ix.packages.map((p) => this.packageCard(from, p)),
    };
  }

  private capCard(from: string, r: ReqEntry): Record<string, unknown> {
    const below = this.ix.below(r).length;
    const claimed = this.ix.targetsOf(r).length;
    return {
      levelHtml: levelBadge(r),
      linkHtml: this.reqLink(from, r),
      statusHtml: statusChip(r.status),
      verdictHtml: verdictBadge(r),
      statement: esc(str(r.node.attrs[REQUIREMENT_ATTR_STATEMENT]) ?? ""),
      barHtml: rollupBar(this.ix.rollup(r)),
      countsLine: esc(`${below} requirement${below === 1 ? "" : "s"} below · ${claimed} model node${claimed === 1 ? "" : "s"} claimed`),
      children: r.children.map((c) => ({ levelHtml: levelBadge(c), linkHtml: this.reqLink(from, c), glyphHtml: statusGlyph(c.status) })),
      hasChildren: r.children.length > 0,
    };
  }

  private packageCard(from: string, pkg: string): Record<string, unknown> {
    const members = [...this.ix.objects, ...this.ix.templates].filter((n) => n.package === pkg);
    const kinds = new Map<string, number>();
    for (const m of members) kinds.set(this.ix.kindOf(m), (kinds.get(this.ix.kindOf(m)) ?? 0) + 1);
    const order = ["entity", "value", "projection", "report", "prompt", "template", "object"];
    const kindLine = order.filter((k) => kinds.has(k)).map((k) => `<span class="kdot k-${k}">●</span> ${kinds.get(k)} ${plural(k, kinds.get(k) ?? 0)}`).join(" · ");
    const shown = members.slice(0, 12);
    return {
      name: esc(pkg === "" ? "(no package)" : pkg),
      href: esc(relHref(from, this.packagePage(pkg))),
      kindLineHtml: kindLine,
      membersHtml: shown.map((m) => this.link(from, m.id)).join(", ") + (members.length > shown.length ? ` <span class="pill">+${members.length - shown.length}</span>` : ""),
    };
  }

  // ─── S2: Model map ───────────────────────────────────────────────────────────

  map(): Record<string, unknown> {
    const ix = this.ix;
    const groups: { label: string; options: { value: string; label: string }[] }[] = [];
    const base = [{ value: "", label: "Whole model" }];
    if (ix.templates.some((t) => ix.isPrompt(t))) base.push({ value: "@prompts", label: "Prompts and their payloads" });
    groups.push({ label: "Model", options: base });
    for (const top of ix.topRequirements) {
      const opts: { value: string; label: string }[] = [];
      for (const r of [top, ...top.children]) {
        const s = ix.slice(`requirement:${r.node.id}`);
        if (s === undefined) continue;
        const depth = r === top ? "" : "  ";
        opts.push({ value: s.id, label: `${depth}${r.level !== undefined ? `L${r.level} ` : ""}${this.reqLabel(r)} (${ix.targetsOf(r).length})` });
      }
      if (opts.length > 0) groups.push({ label: `${top.kind === REQUIREMENT_SUBTYPE_FUNCTIONAL ? "Feature" : "Quality"}: ${this.reqLabel(top)}`, options: opts });
    }
    if (ix.packages.length > 1) groups.push({ label: "Package", options: ix.packages.map((p) => ({ value: `package:${p}`, label: p === "" ? "(no package)" : p })) });
    return {
      sliceGroups: groups.map((g) => ({ label: esc(g.label), options: g.options.map((o) => ({ value: esc(o.value), label: esc(o.label) })) })),
      hasRequirements: ix.hasRequirements(),
    };
  }

  // ─── S3: Object page (entity, value, projection, report) ─────────────────────

  object(n: ExplorerNode): Record<string, unknown> {
    const ix = this.ix;
    const from = this.objectPage(n);
    const kind = ix.kindOf(n);
    const claims = ix.claims(n.id);
    const storage = ix.storage(n.id);
    const storageLine = storage === undefined ? (kind === "value" ? "value object: no storage" : "no source") : `${storage.kind}${storage.name !== undefined ? ` ${storage.name}` : ""}`;
    const fields = ix.fields(n.id).map((f) => this.fieldRow(from, n, f));
    const hasColumn = fields.some((f) => f.column !== "");
    const keys = ix.children(n.id).filter((c) => c.type === TYPE_IDENTITY || c.type === TYPE_INDEX || c.type === TYPE_RELATIONSHIP).map((c) => this.keyRow(from, c));
    const reporting = ix.children(n.id).filter((c) => c.type === TYPE_DIMENSION || c.type === TYPE_MEASURE || c.type === TYPE_SEGMENT).map((c) => this.reportingRow(from, c));
    const layouts = ix.children(n.id).filter((c) => c.type === TYPE_LAYOUT).map((l) => this.layoutRow(l));
    const isUnclaimed = this.unclaimedEntity(n);
    const whyRows = this.whyRows(from, n);
    const usedBy = ix.doc.edges.filter((e) => (e.kind === "payload" || e.kind === "reply") && e.to === n.id).map((e) => this.link(from, e.from));
    const refBy = [...new Set(ix.modelEdges().filter((e) => e.to === n.id && e.kind !== "payload" && e.kind !== "reply").map((e) => e.from))].sort(byCodeUnit).map((id) => this.link(from, id));
    const ext = n.extends !== undefined ? this.link(from, n.extends) : "";
    return {
      id: esc(n.id),
      name: esc(n.name),
      kindLabel: esc(`object.${n.subType}`),
      crumbsHtml: `<a href="${esc(relHref(from, PAGE_MAP))}">Model</a> › <a href="${esc(relHref(from, this.packagePage(n.package)))}">${esc(n.package === "" ? "(no package)" : n.package)}</a> › object.${esc(n.subType)}`,
      isAbstract: n.abstract === true,
      isUnclaimed,
      isReadOnly: storage?.kind === "view",
      kindBadge: esc(kind),
      description: this.description(n),
      storageLine: esc(storageLine),
      extendsHtml: ext,
      whyRows,
      hasWhy: whyRows.length > 0,
      whyEmptyHtml: this.whyEmpty(n),
      fields,
      hasFields: fields.length > 0,
      hasColumn,
      // The L5 column only where the model declares requirements to claim a field.
      showClaims: this.ix.hasRequirements(),
      keys,
      hasKeys: keys.length > 0,
      reporting,
      hasReporting: reporting.length > 0,
      layouts,
      hasLayouts: layouts.length > 0,
      projection: kind === "projection" ? this.projectionBlock(from, n) : undefined,
      report: kind === "report" ? this.reportBlock(from, n) : undefined,
      routes: ix.routes(n.id).map((r) => ({ method: esc(r.method), path: esc(r.path) })),
      hasRoutes: ix.routes(n.id).length > 0,
      routesNote: ix.doc.api === undefined ? "This run recorded no routes." : "No generated routes are mounted for it.",
      usedByHtml: usedBy.join(", "),
      referencedByHtml: refBy.join(", "),
      generated: this.generatedGroups(n.id),
      hasGenerated: ix.generated(n.id).length > 0,
      generatedNote: ix.doc.generated === undefined ? "No generation manifest was read." : "Nothing generated is traced to it.",
      claimCount: claims.length,
    };
  }

  /** A concrete entity that no requirement claims, once any requirement claims anything. That
   *  is the gate's object coverage (`WARN_REQUIREMENT_OBJECT_UNCLAIMED`), which only activates
   *  when the project's requirements claim something. */
  unclaimedEntity(n: ExplorerNode): boolean {
    const ix = this.ix;
    if (!ix.isEntity(n) || n.abstract === true) return false;
    const diags = ix.doc.ledger?.diagnostics ?? [];
    return diags.some((d) => isDiag(d) && d.code === CODE_OBJECT_UNCLAIMED && d.node === n.id);
  }

  private whyRows(from: string, n: ExplorerNode): Record<string, unknown>[] {
    const claims = [...this.ix.claims(n.id)].sort((a, b) => this.ix.requirements.indexOf(a.req) - this.ix.requirements.indexOf(b.req));
    const rows: Record<string, unknown>[] = [];
    let lastTop: ReqEntry | undefined;
    for (const c of claims) {
      const top = this.topOf(c.req);
      rows.push({
        capabilityHtml: top === lastTop ? "" : this.reqLink(from, top),
        reqHtml: this.reqLink(from, c.req),
        statement: esc(str(c.req.node.attrs[REQUIREMENT_ATTR_STATEMENT]) ?? ""),
        levelHtml: levelBadge(c.req),
        statusHtml: statusChip(c.req.status),
        onHtml: c.member !== undefined ? `<code>${esc(c.member)}</code>` : `<span class="sub">whole object</span>`,
      });
      lastTop = top;
    }
    return rows;
  }

  private whyEmpty(n: ExplorerNode): string {
    if (!this.ix.hasRequirements()) return `This model declares no requirements, so nothing states why ${esc(n.name)} exists.`;
    if (this.unclaimedEntity(n)) return `No requirement claims ${esc(n.name)}. The gate reports this as <code>${CODE_OBJECT_UNCLAIMED}</code>.`;
    return `No requirement claims ${esc(n.name)}.`;
  }

  private fieldRow(from: string, owner: ExplorerNode, f: ExplorerNode): { [k: string]: unknown; column: string } {
    const ref = str(f.attrs[FIELD_ATTR_OBJECT_REF]);
    const values = f.subType === FIELD_SUBTYPE_ENUM ? strs(f.attrs[FIELD_ATTR_VALUES]) : [];
    const flags: string[] = [];
    if (f.attrs[FIELD_ATTR_REQUIRED] === true) flags.push("required");
    if (f.attrs[FIELD_ATTR_FILTERABLE] === true) flags.push("filterable");
    if (f.attrs[FIELD_ATTR_SORTABLE] === true) flags.push("sortable");
    if (f.attrs[FIELD_ATTR_MAX_LENGTH] !== undefined) flags.push(`max ${String(f.attrs[FIELD_ATTR_MAX_LENGTH])}`);
    if (f.attrs[FIELD_ATTR_DEFAULT] !== undefined) flags.push(`default ${fmt(f.attrs[FIELD_ATTR_DEFAULT])}`);
    if (this.ix.children(f.id).some((c) => c.type === TYPE_ORIGIN)) flags.push("derived");
    const claims = this.ix.claims(owner.id).filter((c) => c.member !== undefined && c.member.split(".")[0] === f.name);
    return {
      anchor: esc(memberAnchor(f)),
      name: esc(f.name),
      inheritedHtml: f.inheritedFrom !== undefined ? `<span class="pill" title="declared on ${esc(f.inheritedFrom)}">inherited</span>` : "",
      type: esc(`${f.subType}${f.isArray === true ? "[]" : ""}`),
      refHtml: ref !== undefined ? ` → ${this.link(from, ref)}` : "",
      valuesHtml: values.length > 0 ? `<div class="vals">${values.map(esc).join(" | ")}</div>` : "",
      column: esc(str(f.attrs[FIELD_ATTR_COLUMN]) ?? ""),
      flagsHtml: flags.map((x) => `<span class="pill">${esc(x)}</span>`).join(""),
      claimsHtml: claims.map((c) => `<a class="g-${esc(c.req.status)}" href="${esc(relHref(from, this.reqPage(c.req)))}">${statusGlyph(c.req.status)} ${esc(this.reqLabel(c.req))}</a>`).join("<br>"),
    };
  }

  private keyRow(from: string, c: ExplorerNode): Record<string, unknown> {
    const fields = strs(c.attrs[IDENTITY_ATTR_FIELDS]);
    const target = str(c.attrs[IDENTITY_REFERENCE_ATTR_REFERENCES]) ?? str(c.attrs[RELATIONSHIP_ATTR_OBJECT_REF]);
    const through = str(c.attrs[RELATIONSHIP_ATTR_THROUGH]);
    const card = str(c.attrs[RELATIONSHIP_ATTR_CARDINALITY]);
    const shape = c.type === TYPE_RELATIONSHIP ? [card, through !== undefined ? `through ${localName(through)}` : undefined].filter((x) => x !== undefined).join(", ") : `(${fields.join(", ")})`;
    return {
      anchor: esc(memberAnchor(c)),
      kind: esc(`${c.type}.${c.subType}`),
      name: esc(c.name),
      inheritedHtml: c.inheritedFrom !== undefined ? `<span class="pill">inherited</span>` : "",
      shape: esc(shape),
      targetHtml: target !== undefined ? `→ ${this.link(from, target)}` : "",
    };
  }

  private reportingRow(from: string, c: ExplorerNode): Record<string, unknown> {
    const a = c.attrs;
    const parts: string[] = [];
    const agg = str(a[REPORTING_ATTR_AGG]);
    const of = strs(a[REPORTING_ATTR_OF]);
    if (agg !== undefined) parts.push(`${esc(agg)}(${of.map((o) => this.link(from, o, localName(o))).join(", ")})`);
    else if (of.length > 0) parts.push(`of ${of.map((o) => this.link(from, o, localName(o))).join(", ")}`);
    const num = str(a[REPORTING_ATTR_NUMERATOR]);
    const den = str(a[REPORTING_ATTR_DENOMINATOR]);
    if (num !== undefined && den !== undefined) parts.push(`<code>${esc(num)}</code> ÷ <code>${esc(den)}</code>`);
    const via = str(a[REPORTING_ATTR_VIA]);
    if (via !== undefined) parts.push(`via <code>${esc(localName(via))}</code>`);
    const grains = strs(a[REPORTING_ATTR_GRAINS]);
    if (grains.length > 0) parts.push(`grains ${grains.map((g) => `<code>${esc(g)}</code>`).join(" ")}`);
    const seg = str(a[REPORTING_ATTR_SEGMENT]);
    if (seg !== undefined) parts.push(`segment <code>${esc(seg)}</code>`);
    if (a[REPORTING_ATTR_FILTER] !== undefined) parts.push(`filter <code>${esc(fmt(a[REPORTING_ATTR_FILTER]))}</code>`);
    if (a[REPORTING_ATTR_DEFAULT] !== undefined) parts.push(`default <code>${esc(fmt(a[REPORTING_ATTR_DEFAULT]))}</code>`);
    return { anchor: esc(memberAnchor(c)), kind: esc(`${c.type}.${c.subType}`), name: esc(c.name), definitionHtml: parts.join(" · ") };
  }

  private layoutRow(l: ExplorerNode): Record<string, unknown> {
    const parts: string[] = [];
    const cols = strs(l.attrs[LAYOUT_DATA_GRID_ATTR_COLUMNS]);
    if (cols.length > 0) parts.push(`columns ${cols.map((c) => `<code>${esc(c)}</code>`).join(", ")}`);
    const sort = str(l.attrs[LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD]);
    if (sort !== undefined) parts.push(`sorted by <code>${esc(sort)}</code>${str(l.attrs[LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER]) !== undefined ? ` ${esc(str(l.attrs[LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER]))}` : ""}`);
    if (typeof l.attrs[LAYOUT_DATA_GRID_ATTR_PAGE_SIZE] === "number") parts.push(`${l.attrs[LAYOUT_DATA_GRID_ATTR_PAGE_SIZE]} per page`);
    return { kind: esc(`${l.type}.${l.subType}`), name: esc(l.name), detailHtml: parts.join(", ") };
  }

  private projectionBlock(from: string, n: ExplorerNode): Record<string, unknown> {
    const ix = this.ix;
    const rows: Record<string, unknown>[] = [];
    const bases = new Set<string>();
    for (const f of ix.fields(n.id)) {
      if (f.extends !== undefined) bases.add(ix.ownerOf(f.extends));
      for (const o of ix.children(f.id).filter((c) => c.type === TYPE_ORIGIN)) {
        const def = this.originDefinition(from, o);
        const src = str(o.attrs[ORIGIN_PASSTHROUGH_ATTR_FROM]);
        if (src !== undefined && ix.byId.has(src)) bases.add(ix.ownerOf(src));
        rows.push({ field: esc(f.name), origin: esc(`origin.${o.subType}`), definitionHtml: def });
      }
    }
    return {
      basesHtml: [...bases].filter((b) => b !== n.id).sort(byCodeUnit).map((b) => this.link(from, b)).join(", "),
      origins: rows,
      hasOrigins: rows.length > 0,
    };
  }

  private originDefinition(from: string, o: ExplorerNode): string {
    const a = o.attrs;
    const ref = (v: unknown): string => {
      const s = str(v);
      return s === undefined ? "" : this.ix.byId.has(s) ? this.link(from, s, localName(s)) : `<code>${esc(localName(s))}</code>`;
    };
    const parts: string[] = [];
    const agg = str(a[ORIGIN_AGGREGATE_ATTR_AGG]);
    if (agg !== undefined) parts.push(`${esc(agg)}(${ref(a[ORIGIN_AGGREGATE_ATTR_OF])})`);
    else if (a[ORIGIN_AGGREGATE_ATTR_OF] !== undefined) parts.push(`of ${ref(a[ORIGIN_AGGREGATE_ATTR_OF])}`);
    if (a[ORIGIN_PASSTHROUGH_ATTR_FROM] !== undefined) parts.push(`from ${ref(a[ORIGIN_PASSTHROUGH_ATTR_FROM])}`);
    if (a[ORIGIN_AGGREGATE_ATTR_VIA] !== undefined) parts.push(`via <code>${esc(localName(String(a[ORIGIN_AGGREGATE_ATTR_VIA])))}</code>`);
    if (a[ORIGIN_COMPUTED_ATTR_EXPR] !== undefined) parts.push(`<code>${esc(fmt(a[ORIGIN_COMPUTED_ATTR_EXPR]))}</code>`);
    if (a[ORIGIN_AGGREGATE_ATTR_FILTER] !== undefined) parts.push(`filter <code>${esc(fmt(a[ORIGIN_AGGREGATE_ATTR_FILTER]))}</code>`);
    return parts.join(" · ");
  }

  private reportBlock(from: string, n: ExplorerNode): Record<string, unknown> {
    const a = n.attrs;
    const fromId = str(a[OBJECT_REPORT_ATTR_FROM]);
    const resolve = (name: string, kindType: string): string => {
      const candidates = [fromId !== undefined ? `${fromId}.${name}` : undefined, `${n.package === "" ? "" : `${n.package}::`}${name}`].filter((x): x is string => x !== undefined);
      const hit = candidates.find((c) => this.ix.byId.get(c)?.type === kindType || (this.ix.byId.has(c) && name.includes(".")));
      return hit !== undefined ? this.link(from, hit, name) : `<code>${esc(name)}</code>`;
    };
    const spine = str(a[OBJECT_REPORT_ATTR_SPINE]);
    return {
      fromHtml: fromId !== undefined ? this.link(from, fromId) : "",
      spineHtml: spine !== undefined ? `<code>${esc(spine)}</code>` : "",
      dimensionsHtml: strs(a[OBJECT_REPORT_ATTR_DIMENSIONS]).map((d) => resolve(d, TYPE_DIMENSION)).join(", "),
      measuresHtml: strs(a[OBJECT_REPORT_ATTR_MEASURES]).map((m) => resolve(m, TYPE_MEASURE)).join(", "),
      segmentHtml: strs(a[OBJECT_REPORT_ATTR_SEGMENT]).map((s) => resolve(s, TYPE_SEGMENT)).join(", "),
      filterHtml: a[OBJECT_REPORT_ATTR_FILTER] !== undefined ? `<code>${esc(fmt(a[OBJECT_REPORT_ATTR_FILTER]))}</code>` : "",
    };
  }

  private generatedGroups(id: string): Record<string, unknown>[] {
    const groups = new Map<string, string[]>();
    for (const f of this.ix.generated(id)) groups.set(f.generatedBy, [...(groups.get(f.generatedBy) ?? []), f.path]);
    return [...groups.keys()].sort(byCodeUnit).map((g) => ({ generator: esc(g), files: (groups.get(g) ?? []).map((p) => esc(p)) }));
  }

  // ─── S4: Prompt (and other template) page ────────────────────────────────────

  prompt(n: ExplorerNode, text: string | undefined): Record<string, unknown> {
    const ix = this.ix;
    const from = this.objectPage(n);
    const payloadId = str(n.attrs[TEMPLATE_ATTR_PAYLOAD_REF]);
    const replyId = str(n.attrs[TEMPLATE_ATTR_RESPONSE_REF]);
    const vars = text !== undefined ? templateVariables(text) : undefined;
    const payload = payloadId !== undefined ? ix.byId.get(payloadId) : undefined;
    const reply = replyId !== undefined ? ix.byId.get(replyId) : undefined;
    const payloadRows = payload !== undefined ? ix.fields(payload.id).map((f) => ({
      name: esc(f.name),
      requiredHtml: f.attrs[FIELD_ATTR_REQUIRED] === true ? `<span class="pill">required</span>` : "",
      type: esc(`${f.subType}${f.isArray === true ? "[]" : ""}`),
      refHtml: str(f.attrs[FIELD_ATTR_OBJECT_REF]) !== undefined ? ` → ${this.link(from, str(f.attrs[FIELD_ATTR_OBJECT_REF])!)}` : "",
      usedHtml: vars === undefined ? `<span class="sub">text not read</span>` : vars.has(f.name) ? "yes" : `<span class="chip v-warn">no</span>`,
    })) : [];
    const replyRows = reply !== undefined ? ix.fields(reply.id).map((f) => ({
      name: esc(f.name),
      type: esc(`${f.subType}${f.isArray === true ? "[]" : ""}`),
      valuesHtml: f.subType === FIELD_SUBTYPE_ENUM ? `<div class="vals">${strs(f.attrs[FIELD_ATTR_VALUES]).map(esc).join(" | ")}</div>` : "",
    })) : [];
    const textRef = str(n.attrs[TEMPLATE_ATTR_TEXT_REF]) ?? "";
    const lines = text !== undefined ? text.replace(/\n$/, "").split("\n").length : 0;
    const attrs = [TEMPLATE_ATTR_FORMAT, TEMPLATE_ATTR_RESPONSE_FORMAT, TEMPLATE_ATTR_PROMPT_STYLE, TEMPLATE_ATTR_MODEL, TEMPLATE_ATTR_MAX_TOKENS]
      .filter((k) => n.attrs[k] !== undefined)
      .map((k) => `<span class="pill">@${esc(k)} ${esc(fmt(n.attrs[k]))}</span>`)
      .join("");
    const claimed = ix.claims(n.id);
    const whyRows = this.whyRows(from, n);
    return {
      name: esc(n.name),
      kindLabel: esc(`template.${n.subType}`),
      crumbsHtml: `<a href="${esc(relHref(from, PAGE_PROMPTS))}">Prompts</a> › <a href="${esc(relHref(from, this.packagePage(n.package)))}">${esc(n.package === "" ? "(no package)" : n.package)}</a> › template.${esc(n.subType)}`,
      isUnclaimed: ix.hasClaims() && claimed.length === 0,
      description: this.description(n),
      attrsHtml: attrs,
      payloadHtml: payload !== undefined ? this.link(from, payload.id) : "none",
      payloadRows,
      hasPayload: payload !== undefined,
      replyHtml: reply !== undefined ? this.link(from, reply.id) : "none",
      replyRows,
      hasReply: reply !== undefined,
      textRef: esc(textRef),
      textMeta: esc(text !== undefined ? `${textRef}.mustache · ${lines} line${lines === 1 ? "" : "s"}${str(n.attrs[TEMPLATE_ATTR_FORMAT]) !== undefined ? ` · ${str(n.attrs[TEMPLATE_ATTR_FORMAT])}` : ""}` : `${textRef}.mustache`),
      textHtml: text !== undefined ? highlightVariables(text) : "",
      hasText: text !== undefined,
      generated: this.generatedGroups(n.id),
      hasGenerated: ix.generated(n.id).length > 0,
      generatedNote: ix.doc.generated === undefined ? "No generation manifest was read." : "Nothing generated is traced to it.",
      whyRows,
      hasWhy: whyRows.length > 0,
      whyEmptyHtml: ix.hasRequirements() ? `No requirement claims ${esc(n.name)}. The gate counts entity coverage only, so this shows here and on the gaps page, not in <code>meta verify</code>.` : `This model declares no requirements.`,
    };
  }

  // ─── Prompt index ────────────────────────────────────────────────────────────

  prompts(): Record<string, unknown> {
    const from = PAGE_PROMPTS;
    const rows = this.ix.templates.map((p) => {
      const payload = str(p.attrs[TEMPLATE_ATTR_PAYLOAD_REF]);
      const reply = str(p.attrs[TEMPLATE_ATTR_RESPONSE_REF]);
      const claims = this.ix.claims(p.id);
      return {
        linkHtml: this.link(from, p.id),
        kind: esc(`template.${p.subType}`),
        description: this.description(p),
        payloadHtml: payload !== undefined ? this.link(from, payload) : `<span class="sub">none</span>`,
        replyHtml: reply !== undefined ? this.link(from, reply) : `<span class="sub">none (outbound only)</span>`,
        claimsHtml: claims.length > 0 ? claims.map((c) => statusChip(c.req.status)).join("") : this.ix.hasClaims() ? `<span class="chip v-unclaimed">unclaimed</span>` : `<span class="sub">—</span>`,
      };
    });
    return { rows, hasRows: rows.length > 0 };
  }

  // ─── S5: Requirements tree ───────────────────────────────────────────────────

  requirements(kind: string, page: string): Record<string, unknown> {
    const tops = this.ix.topRequirements.filter((r) => r.kind === kind);
    const treeHtml = tops.length > 0 ? `<ul>${tops.map((r) => this.treeNode(page, r)).join("")}</ul>` : "";
    return {
      isFeatures: kind === REQUIREMENT_SUBTYPE_FUNCTIONAL,
      featuresHref: esc(relHref(page, PAGE_FEATURES)),
      qualitiesHref: esc(relHref(page, PAGE_QUALITIES)),
      featureCount: this.ix.requirements.filter((r) => r.kind === REQUIREMENT_SUBTYPE_FUNCTIONAL).length,
      qualityCount: this.ix.requirements.filter((r) => r.kind === REQUIREMENT_SUBTYPE_ARCHITECTURAL).length,
      treeHtml,
      hasTree: tops.length > 0,
      emptyNote: kind === REQUIREMENT_SUBTYPE_FUNCTIONAL ? "No requirement.functional is declared." : "No requirement.architectural is declared.",
    };
  }

  private treeNode(from: string, r: ReqEntry): string {
    const links = (r.row?.implementedBy ?? []).map((l) => {
      if (l.target !== undefined && this.ix.byId.has(l.target)) return `<span class="chip">${this.link(from, l.target, l.ref)}</span>`;
      return r.status === REQUIREMENT_STATUS_PLANNED
        ? `<span class="chip s-planned" title="dangling, allowed on planned">${esc(l.ref)} (not yet)</span>`
        : `<span class="chip v-error" title="ERR_REQUIREMENT_DANGLING_REF">${esc(l.ref)} (dangling)</span>`;
    });
    const bar = r.children.length > 0 ? `<span class="minibar">${rollupBar(this.ix.rollup(r))}</span>` : "";
    const row = `<div class="row" id="r-${esc(this.reqPath(r))}">${levelBadge(r)}${this.reqLink(from, r)} ${statusChip(r.status)}${dispositionPill(r)}${verdictBadge(r)}${bar}${links.join("")}<div class="stmt">${esc(str(r.node.attrs[REQUIREMENT_ATTR_STATEMENT]) ?? "")}</div></div>`;
    return `<li>${row}${r.children.length > 0 ? `<ul>${r.children.map((c) => this.treeNode(from, c)).join("")}</ul>` : ""}</li>`;
  }

  // ─── S6: Requirement page ────────────────────────────────────────────────────

  requirement(r: ReqEntry): Record<string, unknown> {
    const ix = this.ix;
    const from = this.reqPage(r);
    const chain: ReqEntry[] = [];
    for (let x: ReqEntry | undefined = r; x !== undefined; x = x.parent) chain.unshift(x);
    const tab = r.kind === REQUIREMENT_SUBTYPE_FUNCTIONAL ? { href: PAGE_FEATURES, label: "Features" } : { href: PAGE_QUALITIES, label: "Qualities" };
    const row = r.row;
    const links = row?.implementedBy ?? [];
    const linkRows = links.map((l) => {
      const target = l.target !== undefined ? ix.byId.get(l.target) : undefined;
      return {
        refHtml: target !== undefined ? this.link(from, target.id, l.ref) : `<code>${esc(l.ref)}</code>`,
        kind: esc(target !== undefined ? `${target.type}.${target.subType}` : ""),
        resolvesHtml: l.resolves
          ? `<span class="chip s-live">resolves</span>`
          : r.status === REQUIREMENT_STATUS_PLANNED
            ? `<span class="chip s-planned">not yet (allowed on planned)</span>`
            : `<span class="chip v-error">dangling</span>`,
      };
    });
    const findings = (row?.diagnostics ?? []).filter((d) => d.source === GATE_SOURCE);
    const advisories = (row?.diagnostics ?? []).filter((d) => d.source !== GATE_SOURCE);
    const levelFinding = row?.diagnostics.some((d) => LEVEL_RULE_CODES.has(d.code)) ?? false;
    const testable = r.kind === REQUIREMENT_SUBTYPE_FUNCTIONAL && (r.level ?? 0) >= REQUIREMENT_LEVEL_OBJECT;
    const linksOk = links.length === 0 ? "none" : links.every((l) => l.resolves) ? "yes" : "no";
    const below = ix.below(r);
    const slice = ix.slice(`requirement:${r.node.id}`);
    let traceStart: ReqEntry | undefined = r;
    while (traceStart !== undefined && (traceStart.level ?? 0) > REQUIREMENT_LEVEL_SERVICE) traceStart = traceStart.parent;
    const tracked = strs(r.node.attrs[REQUIREMENT_ATTR_TRACKED_BY]);
    const desc = this.description(r.node);
    return {
      crumbsHtml: `<a href="${esc(relHref(from, tab.href))}">${tab.label}</a> › ${chain.map((x) => (x === r ? esc(this.reqLabel(x)) : this.reqLink(from, x))).join(" › ")}`,
      levelHtml: levelBadge(r),
      name: esc(this.reqLabel(r)),
      statusHtml: statusChip(r.status),
      dispositionHtml: dispositionPill(r),
      verdictHtml: verdictBadge(r),
      address: esc(`${row?.qualifiedPath ?? r.node.id} · requirement.${r.kind}`),
      statement: esc(str(r.node.attrs[REQUIREMENT_ATTR_STATEMENT]) ?? ""),
      counterexample: esc(str(r.node.attrs[REQUIREMENT_ATTR_COUNTEREXAMPLE]) ?? ""),
      description: desc,
      hasDescription: desc !== "",
      linkRows,
      hasLinks: linkRows.length > 0,
      linksEmpty: r.level !== undefined && r.level < REQUIREMENT_LEVEL_OBJECT ? "Levels 1 to 3 never name the model." : "Names nothing.",
      belowCount: below.length,
      childCount: r.children.length,
      deeper: below.length > r.children.length,
      hasBelow: r.children.length > 0,
      belowBarHtml: rollupBar(ix.rollup(r)),
      children: r.children.map((c) => ({ levelHtml: levelBadge(c), linkHtml: this.reqLink(from, c), statusHtml: statusChip(c.status) })),
      sliceHref: slice !== undefined ? esc(`${relHref(from, PAGE_MAP)}?slice=${encodeURIComponent(slice.id)}`) : "",
      traceHref: traceStart !== undefined ? esc(`${relHref(from, PAGE_TRACE)}?start=${encodeURIComponent(traceStart.node.id)}`) : "",
      proof: [
        { what: "Loads", verdictHtml: `<span class="chip s-live">yes</span>`, how: "The loader enforces the closed <code>@status</code> enum and the required statement and counterexample." },
        {
          what: "Links resolve",
          verdictHtml: linksOk === "none" ? `<span class="chip">no links</span>` : linksOk === "yes" ? `<span class="chip s-live">yes</span>` : `<span class="chip v-error">no</span>`,
          how: "<code>ERR_REQUIREMENT_DANGLING_REF</code> fails the build on live or partial; a planned entry may point ahead.",
        },
        { what: "Level rules", verdictHtml: levelFinding ? `<span class="chip v-error">no</span>` : `<span class="chip s-live">yes</span>`, how: "Nesting agrees with level, and links sit only at L4 and L5." },
        {
          what: "Gate findings",
          verdictHtml: findings.length > 0 ? `<span class="chip v-warn">${findings.length}</span>` : row !== undefined ? `<span class="chip s-live">none</span>` : `<span class="chip">not read</span>`,
          how: findings.length > 0 ? findings.map((d) => `<code>${esc(d.code)}</code> ${esc(d.message)}`).join("<br>") : row !== undefined ? "Nothing reported for this entry." : "This build read no <code>meta verify</code> output.",
        },
        {
          what: "Authoring advisories",
          verdictHtml: row !== undefined ? `<span class="chip">${advisories.length}</span>` : `<span class="chip">not read</span>`,
          how: advisories.length > 0
            ? advisories.map((d) => `<code>${esc(d.code)}</code> ${esc(d.message)}`).join("<br>")
            : row !== undefined ? "None. The authoring lint never fails a build." : "This build read no <code>meta verify</code> output.",
        },
        {
          what: "Test exists",
          verdictHtml: testable ? `<span class="chip">by generator</span>` : `<span class="chip">not by default</span>`,
          how: testable
            ? "The stock <code>requirement-tests</code> generator writes a test for this entry, and the codegen drift gate holds the test set to the ledger."
            : "The stock <code>requirement-tests</code> generator selects functional L4 and L5 entries only.",
        },
        { what: "Test passes", verdictHtml: `<span class="chip">not read</span>`, how: "<code>verify</code> never reads test results, so nothing here is coloured by one." },
        { what: "Status is true", verdictHtml: `<span class="chip">unprovable</span>`, how: "No gate can prove the status. The colour is the author's claim, held to referential integrity." },
      ].map((p) => ({ what: esc(p.what), verdictHtml: p.verdictHtml, howHtml: p.how })),
      trackedHtml: tracked.map((t) => `<code>${esc(t)}</code>`).join(" "),
      digest: esc(row?.digest ?? ""),
    };
  }

  // ─── S7: Matrix ──────────────────────────────────────────────────────────────

  matrix(): Record<string, unknown> {
    const ix = this.ix;
    const from = PAGE_MATRIX;
    // Stored entities and prompts, plus anything else a row claims (an abstract base a policy
    // names), so no claim lands outside the grid.
    const claimed = ix.requirements.flatMap((r) => (r.row?.implementedBy ?? []).flatMap((l) => (l.target !== undefined ? [ix.ownerOf(l.target)] : [])));
    const colSet = new Set([...ix.storedEntities(), ...ix.templates.filter((t) => ix.isPrompt(t))].map((n) => n.id));
    for (const id of claimed) if (ix.byId.get(id)?.parent === undefined && ix.byId.get(id)?.type !== TYPE_REQUIREMENT) colSet.add(id);
    const cols = [...colSet].map((id) => ix.byId.get(id)!).sort(
      (a, b) => ix.claims(b.id).length - ix.claims(a.id).length || byCodeUnit(a.name, b.name) || byCodeUnit(a.id, b.id),
    );
    const head = `<tr><th class="col corner"></th>${cols.map((o) => `<th class="col${ix.claims(o.id).length === 0 ? " unc" : ""}"><div>${this.link(from, o.id)}</div></th>`).join("")}</tr>`;
    const rows: string[] = [];
    for (const top of ix.topRequirements) {
      const leaves = ix.subtree(top).filter((x) => (x.row?.implementedBy.length ?? 0) > 0);
      if (leaves.length === 0) continue;
      rows.push(`<tr class="grp"><td class="rh">${top.kind === REQUIREMENT_SUBTYPE_FUNCTIONAL ? "Feature" : "Quality"}: ${this.reqLink(from, top)}</td>${cols.map(() => `<td class="c"></td>`).join("")}</tr>`);
      for (const r of leaves) {
        const tg = new Set((r.row?.implementedBy ?? []).filter((l) => l.target !== undefined).map((l) => ix.ownerOf(l.target!)));
        const label = this.reqPath(r).split(".").slice(1).join(".") || this.reqLabel(r);
        rows.push(
          `<tr><td class="rh" title="${esc(str(r.node.attrs[REQUIREMENT_ATTR_STATEMENT]) ?? "")}">${levelBadge(r)}<a href="${esc(relHref(from, this.reqPage(r)))}">${esc(label)}</a></td>${cols
            .map((o) => (tg.has(o.id) ? `<td class="c ${esc(r.status)}" title="${esc(o.name)} ← ${esc(this.reqPath(r))} (${esc(r.status)})">${statusGlyph(r.status)}</td>` : `<td class="c"></td>`))
            .join("")}</tr>`,
        );
      }
    }
    return { tableHtml: rows.length > 0 ? `<table><thead>${head}</thead><tbody>${rows.join("")}</tbody></table>` : "", hasRows: rows.length > 0, hasRequirements: ix.hasRequirements() };
  }

  // ─── S8: Trace ───────────────────────────────────────────────────────────────

  trace(): Record<string, unknown> {
    const starts = this.ix.requirements.filter((r) => r.level !== undefined && r.level <= REQUIREMENT_LEVEL_SERVICE);
    const fallback = starts.length === 0 ? this.ix.topRequirements : [];
    return {
      options: [...starts, ...fallback].map((r) => ({ value: esc(r.node.id), label: esc(`${"  ".repeat(Math.max(0, (r.level ?? 1) - 1))}${r.level !== undefined ? `L${r.level} ` : ""}${this.reqLabel(r)}`) })),
      hasStarts: starts.length + fallback.length > 0,
      hasUsage: false,
    };
  }

  // ─── S9: Gaps ────────────────────────────────────────────────────────────────

  gaps(): Record<string, unknown> {
    const ix = this.ix;
    const from = PAGE_GAPS;
    const cards: Record<string, unknown>[] = [];
    const card = (title: string, count: number | string, source: string, why: string, bodyHtml: string): void => {
      cards.push({ title: esc(title), count: esc(String(count)), source: esc(source), isGate: source === "meta verify", whyHtml: why, bodyHtml });
    };
    if (ix.doc.ledger !== undefined) {
      // Each requirement's own findings come from its ledger row, which the gate scoped to that
      // node; the flat list contributes only the findings with no requirement subject.
      const findingsOf = (gate: boolean): { req?: ReqEntry; d: { code: string; severity: string; message: string } }[] => [
        ...ix.requirements.flatMap((req) => (req.row?.diagnostics ?? []).filter((d) => (d.source === GATE_SOURCE) === gate).map((d) => ({ req, d }))),
        ...(ix.doc.ledger?.diagnostics ?? []).filter((d): d is Diag => isDiag(d) && d.path === "" && (d.source === GATE_SOURCE) === gate).map((d) => ({ d })),
      ];
      const table = (rows: ReturnType<typeof findingsOf>, chip: (severity: string) => string): string =>
        rows.length === 0
          ? `<div class="sub">None.</div>`
          : `<table>${rows.map(({ req, d }) => `<tr><td><span class="${chip(d.severity)}">${esc(d.code)}</span></td><td>${req !== undefined ? this.reqLink(from, req) : ""}<div class="sub small">${esc(d.message)}</div></td></tr>`).join("")}</table>`;
      const gate = findingsOf(true);
      card("Gate findings", gate.length, "meta verify", "Printed by every run of the requirement gate.", table(gate, (sev) => `chip v-${sev === "error" ? "error" : "warn"}`));
      const advisories = findingsOf(false);
      card("Authoring advisories", advisories.length, "authoring lint", "Printed beside the gate's findings, and never able to fail a build.", table(advisories, () => "chip"));
      const unclaimed = ix.storedEntities().filter((e) => this.unclaimedEntity(e));
      card("Entities no requirement claims", unclaimed.length, "meta verify", "The gate's coverage warning. Each is a capability nobody has written down.", unclaimed.length > 0 ? unclaimed.map((e) => this.link(from, e.id)).join(", ") : `<div class="sub">None.</div>`);
      const outstanding = (r: ReqEntry): boolean => (REQUIREMENT_STATUSES_WITH_OUTSTANDING_WORK as readonly string[]).includes(r.status);
      const undecided = ix.requirements.filter((r) => outstanding(r) && r.node.attrs[REQUIREMENT_ATTR_DISPOSITION] === undefined && !ix.below(r).some(outstanding));
      const counted = ix.doc.ledger.counts["undecided"];
      card("Undecided gaps", typeof counted === "number" ? counted : "—", "meta verify", "A partial or planned entry with no <code>@disposition</code> and no outstanding work below it: a gap nobody has ruled on. A roll-up parent is left out, since a ruling on it settles nothing. The gate counts these.", list(undecided.map((r) => `${levelBadge(r)}${this.reqLink(from, r)} ${statusChip(r.status)}`)));
    }
    if (ix.hasRequirements()) {
      const behind = ix.requirements.filter((r) => r.status === REQUIREMENT_STATUS_PLANNED && ix.below(r).some((x) => x.status === REQUIREMENT_STATUS_LIVE));
      card("Planned, with live work below", behind.length, "explorer check", "L1 to L3 status is written by hand and never rolled up. Either the parent should say partial, or it is right and its children are ahead of it.", list(behind.map((r) => `${levelBadge(r)}${this.reqLink(from, r)} ${statusChip(r.status)} <span class="minibar">${rollupBar(ix.rollup(r))}</span>`)));
      const prompts = ix.templates.filter((t) => ix.isPrompt(t) && ix.claims(t.id).length === 0);
      card("Prompts no requirement claims", prompts.length, "explorer check", "The gate counts entity coverage only. An L4 may claim a prompt.", prompts.length > 0 ? prompts.map((p) => this.link(from, p.id)).join(", ") : `<div class="sub">None.</div>`);
    }
    card("Generated modules nothing imports", "—", "explorer check", "Needs a scan of hand-written imports, which this build does not run.", `<div class="sub">Not scanned.</div>`);
    const implied = ix.storedEntities().flatMap((e) => {
      const declared = new Set(ix.children(e.id).filter((c) => c.type === TYPE_IDENTITY && c.attrs[IDENTITY_REFERENCE_ATTR_REFERENCES] !== undefined).flatMap((c) => strs(c.attrs[IDENTITY_ATTR_FIELDS])));
      return ix.fields(e.id).filter((f) => /[a-z]Id$/.test(f.name) && !declared.has(f.name));
    });
    card("Fields that look like references but are not declared", implied.length, "explorer check", "A field named like a foreign key with no <code>identity.reference</code>: the database does not enforce it and the map draws no line. Some are deliberate.", list(implied.map((f) => `${this.link(from, f.id)} <span class="sub">${esc(f.subType)}</span>`)));
    if (ix.templates.length > 0) {
      const unused = this.unusedPayload();
      card("Payload fields the prompt text never uses", unused === undefined ? "—" : unused.length, "explorer check", "The template gate fails a variable the payload lacks; this is the other direction, payload bloat. Nested sections are not followed, so treat each as a lead.", unused === undefined ? `<div class="sub">No prompt text was read.</div>` : list(unused.map(({ p, f }) => `${this.link(from, p.id)}: ${this.link(from, f.id, f.name)}`)));
    }
    return { cards };
  }

  /** Set by the site builder: prompt id → text, for the gaps page's payload check. */
  texts = new Map<string, string>();

  private unusedPayload(): { p: ExplorerNode; f: ExplorerNode }[] | undefined {
    const out: { p: ExplorerNode; f: ExplorerNode }[] = [];
    let read = false;
    for (const p of this.ix.templates) {
      const text = this.texts.get(p.id);
      const payload = str(p.attrs[TEMPLATE_ATTR_PAYLOAD_REF]);
      if (text === undefined || payload === undefined) continue;
      read = true;
      const vars = templateVariables(text);
      for (const f of this.ix.fields(payload)) if (!vars.has(f.name)) out.push({ p, f });
    }
    return read ? out : undefined;
  }

  // ─── API index ───────────────────────────────────────────────────────────────

  api(): Record<string, unknown> {
    const ix = this.ix;
    const from = PAGE_API;
    const groups = ix.objects.filter((o) => ix.routes(o.id).length > 0).map((o) => ({
      linkHtml: this.link(from, o.id),
      kind: esc(ix.kindOf(o)),
      isReadOnly: ix.storage(o.id)?.kind === "view",
      routes: ix.routes(o.id).map((r) => ({ method: esc(r.method), methodClass: esc(r.method.toLowerCase()), path: esc(r.path) })),
    }));
    const total = groups.reduce((a, g) => a + g.routes.length, 0);
    return {
      groups,
      hasGroups: groups.length > 0,
      recorded: ix.doc.api !== undefined,
      summary: esc(`${total} route${total === 1 ? "" : "s"} on ${groups.length} object${groups.length === 1 ? "" : "s"}`),
    };
  }

  // ─── Model index and package pages ───────────────────────────────────────────

  model(): Record<string, unknown> {
    return { packageCards: this.ix.packages.map((p) => this.packageCard(PAGE_MODEL, p)) };
  }

  packageIndex(pkg: string): Record<string, unknown> {
    const ix = this.ix;
    const from = this.packagePage(pkg);
    const rows = [...ix.objects, ...ix.templates].filter((n) => n.package === pkg).map((n) => {
      const s = ix.storage(n.id);
      const st = ix.claimStatus(n.id);
      return {
        linkHtml: this.link(from, n.id),
        kind: esc(`${n.type}.${n.subType}`),
        abstractHtml: n.abstract === true ? `<span class="pill">abstract</span>` : "",
        storage: esc(s === undefined ? "" : `${s.kind}${s.name !== undefined ? ` ${s.name}` : ""}`),
        fieldCount: ix.fields(n.id).length,
        statusHtml: st === "unclaimed" ? (this.unclaimedEntity(n) ? `<span class="chip v-unclaimed">unclaimed</span>` : "") : statusChip(st),
        description: this.description(n),
      };
    });
    return { name: esc(pkg === "" ? "(no package)" : pkg), crumbsHtml: `<a href="${esc(relHref(from, PAGE_MODEL))}">Model</a> › ${esc(pkg === "" ? "(no package)" : pkg)}`, rows };
  }
}

// ─── Small helpers ───────────────────────────────────────────────────────────────────────────

interface Diag {
  code: string;
  path: string;
  severity: string;
  source?: string;
  /** The entity an object-coverage finding is about; "" or absent otherwise. */
  node?: string;
  message: string;
}

function isDiag(d: unknown): d is Diag {
  if (typeof d !== "object" || d === null) return false;
  const r = d as Record<string, unknown>;
  return typeof r["code"] === "string" && typeof r["path"] === "string" && typeof r["message"] === "string" && typeof r["severity"] === "string";
}

function list(items: string[]): string {
  return items.length === 0 ? `<div class="sub">None.</div>` : `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
}

function fmt(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

function joinAnd(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function plural(kind: string, n: number): string {
  if (n === 1) return kind;
  return kind === "entity" ? "entities" : `${kind}s`;
}

const TAG = /\{\{\s*([#^/&{]?)\s*([A-Za-z_][\w.]*)\s*\}?\}\}/g;

/** The first path segment of every variable a Mustache text names (`{{a.b}}`, `{{#a}}`). */
export function templateVariables(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(TAG)) if (m[1] !== "/") out.add(m[2]!.split(".")[0]!);
  return out;
}

/** The text, escaped, with every tag picked out. */
export function highlightVariables(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(/\{\{[^}]*\}?\}\}/g)) {
    out += esc(text.slice(last, m.index));
    out += `<b class="var">${esc(m[0])}</b>`;
    last = m.index! + m[0].length;
  }
  return out + esc(text.slice(last));
}

export { STATUSES };
