// buildDocsView(): the docs view of a loaded model (`docs/features/docs-view.md`).
//
// It reads the model the loader already built and resolved, and re-derives none of it:
//
//   ids and pages   from the effective tree (`children()`), walked once in declaration order;
//   inheritance     an effective child whose `parent` is another node is inherited, and that
//                   parent is where it is declared;
//   references      the loader's own resolution (`MetaAttr.resolvedTarget` on every attribute
//                   it treats as a reference, `superData` for `extends`), so a provider's
//                   vocabulary gets its links with no change here;
//   claims          `@implementedBy`, through the resolver the requirement gate uses.
//
// Two optional inputs add what the model does not hold: the `meta verify --format json`
// payload (each requirement's verdict, digest and findings, the counts, the advisories), the
// generation manifest (which file came from which node) and the routes the run mounts.
//
// DETERMINISTIC: the same inputs give the same bytes (`serializeDocsView`), so every port can
// be held to one corpus and the file can sit under a drift gate.

import type { MetaData } from "../shared/meta-data.js";
import type { MetaAttr } from "../core/attr/meta-attr.js";
import type { MetaRequirement } from "../core/requirement/meta-requirement.js";
import { TYPE_FIELD, TYPE_OBJECT, TYPE_REQUIREMENT, TYPE_TEMPLATE } from "../shared/base-types.js";
import { CHILD_REF_SEPARATOR, PACKAGE_SEPARATOR, TYPE_SUBTYPE_SEPARATOR } from "../shared/structural.js";
import { DOC_ATTR_DESCRIPTION, DOC_ATTR_SUMMARY, DOC_ATTR_TITLE } from "../core/documentation/doc-constants.js";
import {
  REQUIREMENT_ATTR_COUNTEREXAMPLE,
  REQUIREMENT_ATTR_STATEMENT,
  REQUIREMENT_LEVEL_OBJECT,
  REQUIREMENT_STATUSES,
  REQUIREMENT_SUBTYPE_ARCHITECTURAL,
  REQUIREMENT_SUBTYPE_FUNCTIONAL,
} from "../core/requirement/requirement-constants.js";
import { effectiveRequirementPackage, resolveClaimTarget, resolveMember } from "../core/requirement/resolve-claim.js";
import { effectivePackageOf, isRefBearingAttr, lookupCanonical, splitChildTail, topLevelNodeOf } from "../naming-refs.js";
import {
  DOCS_VIEW_FORMAT,
  type DocsView,
  type DocsViewAdvisory,
  type DocsViewAttr,
  type DocsViewAttrValue,
  type DocsViewClaim,
  type DocsViewCounts,
  type DocsViewDiagnostic,
  type DocsViewFileGroup,
  type DocsViewLink,
  type DocsViewMember,
  type DocsViewMemberGroup,
  type DocsViewNode,
  type DocsViewPackage,
  type DocsViewRef,
  type DocsViewReferrer,
  type DocsViewRequirement,
  type DocsViewRequirementLink,
  type DocsViewRoute,
  type DocsViewSlice,
  type DocsViewStatusCount,
} from "./types.js";

export interface DocsViewInput {
  /** The loaded, resolved model. */
  root: MetaData;
  /** Parsed `meta verify --format json` output: `requirementLedger`, `requirementCounts` and
   *  `requirements.rows`. Without it the gate's verdicts, counts and findings are absent. */
  verify?: unknown;
  /** The merged entries of `.metaobjects/.gen-state/.hashes/`, `path → { generatedBy,
   *  sourceNode }`. Without it no node lists files. */
  manifest?: unknown;
  /** The routes the run mounts: `[{ node, method, path }]`, `node` a resolution key. */
  routes?: unknown;
}

/** The gate's object-coverage finding: a concrete entity no requirement claims. */
const CODE_OBJECT_UNCLAIMED = "WARN_REQUIREMENT_OBJECT_UNCLAIMED";
const EXTENDS = "extends";

/** Code-unit order: the same in every runtime and locale, unlike `localeCompare`. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The directory of a package's pages. A package segment is an identifier, so `-root` (for
 *  the empty package) cannot be one. */
function docsPackageDir(pkg: string): string {
  return pkg === "" ? "-root" : pkg.split(PACKAGE_SEPARATOR).join("/");
}

/** A page's file stem: the name, unless it would take the package page's `index.html` (on a
 *  case-insensitive file system too). */
function docsPageStem(name: string): string {
  return name.toLowerCase() === "index" ? `${name}.node` : name;
}

/** A node as walked: where it sits, and the ids and pages it gets. */
interface Walked {
  md: MetaData;
  id: string;
  /** The id before any type qualifier: what a dotted reference spells. */
  plain: string;
  /** The top-level node it sits under (itself, at the top). */
  top: Walked;
  parent: Walked | undefined;
  /** The direct member of `top` it sits in (itself, for a direct member); undefined at the top. */
  direct: Walked | undefined;
  /** The nearest requirement at or above it. */
  requirement: Walked | undefined;
  order: number;
  /** On the walk path that physically holds the node: the one place a reference to the node
   *  resolves to. */
  canonical: boolean;
  /** The node that declares it, when it is inherited through `extends`. */
  declaredOn: MetaData | undefined;
  anchor: string;
  path: string;
  children: Walked[];
  /** Requirement address (dotted requirement names), set on requirements. */
  address: string;
}

class Builder {
  readonly walked: Walked[] = [];
  readonly tops: Walked[] = [];
  readonly byId = new Map<string, Walked>();
  /** Each node instance at its canonical walk position. */
  readonly canonical = new Map<MetaData, Walked>();
  /** Plain path → walked node: the first holder of a plain path under a top-level node that
   *  holds its plain id, whatever order the other nodes of that name are declared in. */
  readonly byPlain = new Map<string, Walked>();
  readonly requirements: Walked[] = [];

  constructor(readonly root: MetaData) {
    this.walk();
  }

  private walk(): void {
    const topLevel = [...this.root.children()];
    const plainOf = (md: MetaData): string => {
      const pkg = effectivePackageOf(md);
      return pkg === "" ? md.name : `${pkg}${PACKAGE_SEPARATOR}${md.name}`;
    };
    // Top-level nodes of different types may share a package and a name (an entity `Lead` and
    // an application's page `Lead`). The object keeps the plain id, since every reference in the
    // model names an object, else the first declared; each other one is qualified by its type.
    const holder = new Map<string, MetaData>();
    for (const md of topLevel) {
      const id = plainOf(md);
      const held = holder.get(id);
      if (held === undefined || (held.type !== TYPE_OBJECT && md.type === TYPE_OBJECT)) holder.set(id, md);
    }
    const seen = new Set<string>();
    const visit = (md: MetaData, index: number, parent: Walked | undefined, reqPrefix: string): void => {
      let id: string;
      let plain: string;
      if (parent === undefined) {
        plain = md.name === "" ? `#${index}` : plainOf(md);
        id = plain;
        const held = holder.get(plain);
        if (md.name !== "" && held !== md && held?.type !== md.type) id = qualified(plain, md);
      } else {
        plain = md.name === "" ? `${parent.plain}#${index}` : `${parent.plain}${CHILD_REF_SEPARATOR}${md.name}`;
        id = md.name === "" ? `${parent.id}#${index}` : `${parent.id}${CHILD_REF_SEPARATOR}${md.name}`;
        // The first sibling of a name keeps the plain id: it is the one a dotted reference
        // resolves to. A later sibling of another type sharing the name is qualified by type.
        if (md.name !== "" && seen.has(id)) id = qualified(id, md);
      }
      if (seen.has(id)) throw new Error(`docs view: two nodes share the id "${id}" — the model names two siblings alike`);
      seen.add(id);
      const isReq = md.type === TYPE_REQUIREMENT;
      const address = isReq ? (reqPrefix === "" ? md.name : `${reqPrefix}${CHILD_REF_SEPARATOR}${md.name}`) : reqPrefix;
      const inherited = parent !== undefined && md.parent !== parent.md;
      const w: Walked = {
        md,
        id,
        plain,
        top: undefined as unknown as Walked,
        parent,
        direct: undefined,
        requirement: undefined,
        order: index,
        canonical: parent === undefined ? true : parent.canonical && !inherited,
        declaredOn: inherited ? md.parent : undefined,
        anchor: "",
        path: "",
        children: [],
        address: isReq ? address : "",
      };
      w.top = parent === undefined ? w : parent.top;
      w.direct = parent === undefined ? undefined : parent.parent === undefined ? w : parent.direct;
      w.requirement = isReq ? w : parent?.requirement;
      if (w.direct === w) w.anchor = memberAnchor(md, index);
      this.walked.push(w);
      this.byId.set(id, w);
      if (w.top.id === w.top.plain && !this.byPlain.has(plain)) this.byPlain.set(plain, w);
      if (w.canonical) this.canonical.set(md, w);
      if (parent === undefined) this.tops.push(w);
      else parent.children.push(w);
      if (isReq) this.requirements.push(w);
      md.children().forEach((c, i) => visit(c, i, w, address));
    };
    topLevel.forEach((md, i) => visit(md, i, undefined, ""));
    for (const w of this.walked) w.path = this.pathOf(w);
  }

  private pathOf(w: Walked): string {
    if (w.requirement !== undefined) {
      const r = w.requirement;
      return `requirements/${docsPackageDir(effectivePackageOf(r.top.md))}/${docsPageStem(r.address)}.html`;
    }
    const top = w.top;
    const qualifier = `[${top.md.type}${TYPE_SUBTYPE_SEPARATOR}${top.md.subType}]`;
    const typed = top.id.endsWith(qualifier) ? `.${top.md.type}-${top.md.subType}` : "";
    const page = `model/${docsPackageDir(effectivePackageOf(top.md))}/${docsPageStem(top.md.name)}${typed}.html`;
    return w.direct === undefined ? page : `${page}#${w.direct.anchor}`;
  }

  link(w: Walked): DocsViewLink {
    const req = w.requirement === w ? w : undefined;
    const label =
      req !== undefined
        ? str(w.md.attr(DOC_ATTR_TITLE)) || w.md.name
        : w === w.top
          ? w.md.name
          : `${w.top.md.name}${w.id.slice(w.top.id.length)}`;
    return { label, id: w.id, path: w.path, kind: `${w.md.type}${TYPE_SUBTYPE_SEPARATOR}${w.md.subType}`, unresolved: false };
  }

  linkTo(md: MetaData | undefined, text: string): DocsViewLink {
    const w = md === undefined ? undefined : this.canonical.get(md);
    return w !== undefined ? this.link(w) : unresolved(text);
  }

  /** The link a reference value lands on: the owner's row for the member its dotted tail
   *  names (the owner's own row of an inherited member, as a claim lands), else the owner the
   *  loader bound. */
  refLink(owner: MetaData | undefined, value: string): DocsViewLink {
    if (owner === undefined) return unresolved(value);
    const exact = value.includes(CHILD_REF_SEPARATOR) ? lookupCanonical(this.root, value) : undefined;
    if (exact === undefined) return this.linkTo(owner, value);
    if (topLevelNodeOf(exact) === owner) return this.linkTo(exact, value);
    const row = this.byPlain.get(`${owner.resolutionKey()}${splitChildTail(value).tail}`);
    return row !== undefined ? this.link(row) : this.linkTo(owner, value);
  }
}

/** A member's id after its top-level node's: `email`, `items.price`, or `#3` with no name. */
function memberPath(w: Walked): string {
  const rest = w.id.slice(w.top.id.length);
  return rest.startsWith(CHILD_REF_SEPARATOR) ? rest.slice(CHILD_REF_SEPARATOR.length) : rest;
}

function qualified(id: string, md: MetaData): string {
  return `${id}[${md.type}${TYPE_SUBTYPE_SEPARATOR}${md.subType}]`;
}

/** A direct member's anchor: `m-<name>` for a field, `m-<type>-<name>` for anything else (siblings
 *  of different types may share a name), `m-<type>-<order>` for one with no name. */
function memberAnchor(md: MetaData, order: number): string {
  if (md.name === "") return `m-${md.type}-${order}`;
  return md.type === TYPE_FIELD ? `m-${md.name}` : `m-${md.type}-${md.name}`;
}

function unresolved(text: string): DocsViewLink {
  return { label: text, id: "", path: "", kind: "", unresolved: true };
}

/** The attribute node that declares `name` for `md`: its own, else the nearest `extends`
 *  ancestor's — where the loader recorded what the reference resolved to. */
function declaringAttr(md: MetaData, name: string): MetaAttr | undefined {
  const seen = new Set<MetaData>();
  for (let n: MetaData | undefined = md; n !== undefined && !seen.has(n); n = n.superData) {
    seen.add(n);
    // ADR-0039: own — locating the layer that declares the attr, walking the super chain.
    const a = n.ownMetaAttr(name);
    if (a !== undefined) return a;
  }
  return undefined;
}

/** A value with every object's keys in code-unit order, as the canonical serializer writes
 *  them: a map attribute's key order must not depend on a port's map type. */
function canonicalValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalValue);
  if (!isRecord(v)) return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort(byCodeUnit)) out[k] = canonicalValue(v[k]);
  return out;
}

function textOf(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v) ?? "";
}

/** A node's effective attributes, by name, each value linked where the loader resolved it. */
function attrsOf(b: Builder, md: MetaData): { attrs: DocsViewAttr[]; refs: { attr: string; target: DocsViewLink }[] } {
  const attrs: DocsViewAttr[] = [];
  const refs: { attr: string; target: DocsViewLink }[] = [];
  const map = md.attrs();
  for (const name of [...map.keys()].sort(byCodeUnit)) {
    const value = canonicalValue(map.get(name));
    const isRef = isRefBearingAttr(md, name);
    const resolved = isRef ? declaringAttr(md, name)?.resolvedTarget : undefined;
    const values: DocsViewAttrValue[] = [];
    if (typeof value === "string") {
      const link = isRef ? b.refLink(Array.isArray(resolved) ? undefined : (resolved as MetaData | undefined), value) : null;
      values.push({ text: value, link });
      if (link !== null && !link.unresolved) refs.push({ attr: name, target: link });
    } else if (Array.isArray(value) && value.every((x) => typeof x === "string")) {
      (value as string[]).forEach((item, i) => {
        const owner = Array.isArray(resolved) ? (resolved as readonly (MetaData | undefined)[])[i] : undefined;
        const link = isRef ? b.refLink(owner, item) : null;
        values.push({ text: item, link });
        if (link !== null && !link.unresolved) refs.push({ attr: name, target: link });
      });
    } else {
      values.push({ text: textOf(value), link: null });
    }
    attrs.push({ name, value: value ?? null, values });
  }
  return { attrs, refs };
}

function groupMembers(members: DocsViewMember[]): DocsViewMemberGroup[] {
  const groups = new Map<string, DocsViewMemberGroup>();
  for (const m of members) {
    let g = groups.get(m.type);
    if (g === undefined) {
      g = { type: m.type, count: 0, members: [] };
      groups.set(m.type, g);
    }
    g.count++;
    g.members.push(m);
  }
  return [...groups.values()];
}

function statusCounts(statuses: readonly string[]): DocsViewStatusCount[] {
  return REQUIREMENT_STATUSES.map((status) => ({ status, count: statuses.filter((s) => s === status).length }));
}

/** Split `@implementedBy`'s `owner.member.path` after the package: the gate's own split. */
function splitMemberRef(ref: string): { owner: string; path: string[] } {
  const pkgEnd = ref.lastIndexOf(PACKAGE_SEPARATOR);
  const from = pkgEnd === -1 ? 0 : pkgEnd + PACKAGE_SEPARATOR.length;
  const dot = ref.indexOf(CHILD_REF_SEPARATOR, from);
  if (dot === -1) return { owner: ref, path: [] };
  return { owner: ref.slice(0, dot), path: ref.slice(dot + 1).split(CHILD_REF_SEPARATOR) };
}

interface LedgerRow {
  qualifiedPath: string;
  digest: string;
  verdict: string;
  diagnostics: DocsViewDiagnostic[];
  supersededBy: { ref: string; resolves: boolean; target: string } | undefined;
}

function ledgerRows(verify: unknown): Map<string, LedgerRow[]> | undefined {
  if (!isRecord(verify) || !Array.isArray(verify.requirementLedger)) return undefined;
  const out = new Map<string, LedgerRow[]>();
  for (const raw of verify.requirementLedger) {
    if (!isRecord(raw) || typeof raw.qualifiedPath !== "string") continue;
    const sup = isRecord(raw.supersededBy) && typeof raw.supersededBy.ref === "string" ? raw.supersededBy : undefined;
    const row: LedgerRow = {
      qualifiedPath: raw.qualifiedPath,
      digest: str(raw.digest),
      verdict: str(raw.verdict),
      diagnostics: Array.isArray(raw.diagnostics)
        ? raw.diagnostics.filter(isRecord).map((d) => ({ code: str(d.code), severity: str(d.severity), source: str(d.source), message: str(d.message) }))
        : [],
      supersededBy: sup !== undefined ? { ref: str(sup.ref), resolves: sup.resolves === true, target: str(sup.target) } : undefined,
    };
    out.set(row.qualifiedPath, [...(out.get(row.qualifiedPath) ?? []), row]);
  }
  return out;
}

/** Build the docs view of a loaded model. A missing or malformed optional input only leaves
 *  its part out. */
export function buildDocsView(input: DocsViewInput): DocsView {
  const b = new Builder(input.root);
  const ledger = ledgerRows(input.verify);
  const hasVerify = ledger !== undefined;

  // ── Requirements: claims first, since nodes and members list them. ──
  const claimsOn = new Map<Walked, DocsViewClaim[]>();
  const reqLinks = new Map<Walked, DocsViewRequirementLink[]>();
  const reqTargets = new Map<Walked, Walked[]>();
  for (const r of b.requirements) {
    const req = r.md as MetaRequirement;
    const referrerPkg = effectiveRequirementPackage(req);
    const links: DocsViewRequirementLink[] = [];
    const targets: Walked[] = [];
    for (const ref of req.implementedBy()) {
      const { owner, path } = splitMemberRef(ref);
      const node = resolveClaimTarget(b.root, owner, referrerPkg);
      const member = node !== undefined && path.length > 0 ? resolveMember(node, path) : node;
      const key = node === undefined ? "" : path.length === 0 ? node.resolutionKey() : `${node.resolutionKey()}${CHILD_REF_SEPARATOR}${path.join(CHILD_REF_SEPARATOR)}`;
      const w = member !== undefined ? b.byPlain.get(key) : undefined;
      if (w === undefined) {
        links.push({ ref, resolves: false, target: unresolved(ref) });
        continue;
      }
      links.push({ ref, resolves: true, target: b.link(w) });
      targets.push(w);
      const claim: DocsViewClaim = {
        requirement: b.link(r),
        member: w === w.top ? "" : memberPath(w),
        status: str(req.status()),
        level: req.level() ?? null,
      };
      // The claim is on the top-level node and on every member down to the one it names.
      for (let x: Walked | undefined = w; x !== undefined; x = x.parent) claimsOn.set(x, [...(claimsOn.get(x) ?? []), claim]);
    }
    reqLinks.set(r, links);
    reqTargets.set(r, targets);
  }

  // ── Files and routes. ──
  const filesOf = new Map<Walked, Map<string, string[]>>();
  if (isRecord(input.manifest)) {
    for (const [path, entry] of Object.entries(input.manifest)) {
      if (!isRecord(entry) || typeof entry.sourceNode !== "string") continue;
      const w = b.byPlain.get(entry.sourceNode);
      if (w === undefined) continue;
      const by = filesOf.get(w.top) ?? new Map<string, string[]>();
      const gen = str(entry.generatedBy);
      by.set(gen, [...(by.get(gen) ?? []), path]);
      filesOf.set(w.top, by);
    }
  }
  const routesOf = new Map<Walked, Map<string, DocsViewRoute>>();
  if (Array.isArray(input.routes)) {
    for (const r of input.routes) {
      if (!isRecord(r) || typeof r.node !== "string" || typeof r.method !== "string" || typeof r.path !== "string") continue;
      const w = b.byPlain.get(r.node);
      if (w === undefined) continue;
      const route = { method: r.method.toUpperCase(), path: r.path };
      const m = routesOf.get(w.top) ?? new Map<string, DocsViewRoute>();
      m.set(`${route.path}\u0000${route.method}`, route);
      routesOf.set(w.top, m);
    }
  }

  // ── Advisories. ──
  const advisories: DocsViewAdvisory[] = [];
  if (hasVerify && isRecord(input.verify) && isRecord(input.verify.requirements) && Array.isArray(input.verify.requirements.rows)) {
    for (const d of input.verify.requirements.rows) {
      if (!isRecord(d)) continue;
      const node = str(d.node);
      const subject = node === "" ? null : b.byPlain.has(node) ? b.link(b.byPlain.get(node)!.top) : unresolved(node);
      advisories.push({ code: str(d.code), path: str(d.path), subject, severity: str(d.severity), source: str(d.source), message: str(d.message) });
    }
  }
  const unclaimedIds = new Set(advisories.filter((a) => a.code === CODE_OBJECT_UNCLAIMED && a.subject !== null).map((a) => a.subject!.id));

  // ── Members and references. ──
  const refsFrom = new Map<Walked, DocsViewRef[]>();
  const member = (w: Walked): DocsViewMember => {
    const { attrs, refs } = attrsOf(b, w.md);
    const ext = w.md.superData !== undefined || w.md.superRef !== undefined ? b.linkTo(w.md.superData, w.md.superRef ?? "") : null;
    const own: DocsViewRef[] = [
      ...(ext !== null && !ext.unresolved ? [{ attr: EXTENDS, via: b.link(w), target: ext }] : []),
      ...refs.map((r) => ({ attr: r.attr, via: b.link(w), target: r.target })),
    ];
    refsFrom.set(w, own);
    return {
      id: w.id,
      name: w.md.name,
      type: w.md.type,
      subType: w.md.subType,
      order: w.order,
      anchor: w.anchor,
      path: w.path,
      abstract: w.md.isAbstract === true,
      isArray: w.md.resolvedIsArray(),
      extends: ext,
      declaredOn: w.declaredOn !== undefined ? b.linkTo(w.declaredOn, w.declaredOn.name) : null,
      attrs,
      refs: own,
      claims: claimsOn.get(w) ?? [],
      memberGroups: groupMembers(w.children.map(member)),
    };
  };

  const nodes: DocsViewNode[] = [];
  const nodeRefs = new Map<Walked, DocsViewRef[]>();
  for (const t of b.tops) {
    const { attrs, refs } = attrsOf(b, t.md);
    const ext = t.md.superData !== undefined || t.md.superRef !== undefined ? b.linkTo(t.md.superData, t.md.superRef ?? "") : null;
    const memberGroups = groupMembers(t.children.map(member));
    const all: DocsViewRef[] = [
      ...(ext !== null && !ext.unresolved ? [{ attr: EXTENDS, via: null, target: ext }] : []),
      ...refs.map((r) => ({ attr: r.attr, via: null, target: r.target })),
    ];
    const below = (w: Walked): void => {
      for (const c of w.children) {
        all.push(...(refsFrom.get(c) ?? []));
        below(c);
      }
    };
    below(t);
    nodeRefs.set(t, all);
    const files: DocsViewFileGroup[] = [...(filesOf.get(t) ?? new Map<string, string[]>()).entries()]
      .sort(([a], [b2]) => byCodeUnit(a, b2))
      .map(([generatedBy, paths]) => ({ generatedBy, paths: [...paths].sort(byCodeUnit) }));
    const routes = [...(routesOf.get(t) ?? new Map<string, DocsViewRoute>()).entries()].sort(([a], [b2]) => byCodeUnit(a, b2)).map(([, r]) => r);
    nodes.push({
      id: t.id,
      name: t.md.name,
      package: effectivePackageOf(t.md),
      type: t.md.type,
      subType: t.md.subType,
      order: t.order,
      path: t.path,
      title: str(t.md.attr(DOC_ATTR_TITLE)),
      description: str(t.md.attr(DOC_ATTR_DESCRIPTION)),
      summary: str(t.md.attr(DOC_ATTR_SUMMARY)),
      abstract: t.md.isAbstract === true,
      extends: ext,
      attrs,
      memberGroups,
      refs: all,
      referencedBy: [],
      claims: claimsOn.get(t) ?? [],
      files,
      routes,
      unclaimed: unclaimedIds.has(t.id),
      counts: { members: t.children.length, refs: all.length, referencedBy: 0, claims: (claimsOn.get(t) ?? []).length, files: files.reduce((a, g) => a + g.paths.length, 0), routes: routes.length },
    });
  }

  // referencedBy: every reference into a top-level node (or a member of it) from another one.
  const nodeById = new Map(nodes.map((n) => [n.id, n] as const));
  const incoming = new Map<string, Map<string, DocsViewReferrer>>();
  for (const t of b.tops) {
    for (const r of nodeRefs.get(t) ?? []) {
      const target = b.byId.get(r.target.id);
      if (target === undefined || target.top === t) continue;
      const referrer: DocsViewReferrer = { attr: r.attr, from: b.link(t), via: r.via, target: r.target };
      const key = [t.id, r.attr, r.via?.id ?? "", r.target.id].join("\u0000");
      const m = incoming.get(target.top.id) ?? new Map<string, DocsViewReferrer>();
      m.set(key, referrer);
      incoming.set(target.top.id, m);
    }
  }
  for (const [id, m] of incoming) {
    const n = nodeById.get(id);
    if (n === undefined) continue;
    n.referencedBy = [...m.entries()].sort(([a], [b2]) => byCodeUnit(a, b2)).map(([, r]) => r);
    n.counts.referencedBy = n.referencedBy.length;
  }
  nodes.sort((a, c) => byCodeUnit(a.id, c.id));

  // ── The requirement list, flat, in document order. ──
  const reqChildren = new Map<Walked, Walked[]>();
  const reqParent = (r: Walked): Walked | undefined => r.parent?.requirement;
  for (const r of b.requirements) {
    const p = reqParent(r);
    if (p !== undefined) reqChildren.set(p, [...(reqChildren.get(p) ?? []), r]);
  }
  const subtree = (r: Walked): Walked[] => [r, ...(reqChildren.get(r) ?? []).flatMap(subtree)];
  const requirements: DocsViewRequirement[] = b.requirements.map((r) => {
    const req = r.md as MetaRequirement;
    const pkg = effectiveRequirementPackage(req);
    const qualifiedPath = pkg === "" ? r.address : `${pkg}${PACKAGE_SEPARATOR}${r.address}`;
    const row = ledger?.get(qualifiedPath)?.shift();
    const chain: Walked[] = [];
    for (let p = reqParent(r); p !== undefined; p = reqParent(p)) chain.unshift(p);
    const sub = subtree(r);
    const linked = sub.filter((x) => {
      const level = (x.md as MetaRequirement).level();
      return (level ?? 0) >= REQUIREMENT_LEVEL_OBJECT || (level === undefined && (x.md as MetaRequirement).implementedBy().length > 0);
    });
    const counted = linked.length > 0 ? linked : [r];
    const statuses = counted.map((x) => str((x.md as MetaRequirement).status())).filter((s) => s !== "");
    const targets = [...new Map(sub.flatMap((x) => reqTargets.get(x) ?? []).map((w) => [w.top.id, w.top] as const)).values()].sort((a, c) => byCodeUnit(a.id, c.id));
    const children = reqChildren.get(r) ?? [];
    const sup = row?.supersededBy;
    const supTarget = sup?.target !== undefined && sup.target !== "" ? b.requirements.find((x) => {
      const p = effectiveRequirementPackage(x.md);
      return (p === "" ? x.address : `${p}${PACKAGE_SEPARATOR}${x.address}`) === sup.target;
    }) : undefined;
    return {
      id: r.id,
      name: r.md.name,
      label: b.link(r).label,
      path: r.path,
      address: r.address,
      package: pkg,
      qualifiedPath,
      subType: r.md.subType,
      level: req.level() ?? null,
      status: str(req.status()),
      disposition: str(req.disposition()),
      statement: str(req.attr(REQUIREMENT_ATTR_STATEMENT)),
      counterexample: str(req.attr(REQUIREMENT_ATTR_COUNTEREXAMPLE)),
      title: str(req.attr(DOC_ATTR_TITLE)),
      description: str(req.attr(DOC_ATTR_DESCRIPTION)),
      trackedBy: req.trackedBy(),
      depth: chain.length,
      parent: chain.length > 0 ? b.link(chain[chain.length - 1]!) : null,
      breadcrumbs: chain.map((x) => b.link(x)),
      children: children.map((x) => b.link(x)),
      implementedBy: reqLinks.get(r) ?? [],
      supersededBy: sup === undefined ? null : { ref: sup.ref, resolves: sup.resolves, target: supTarget !== undefined ? b.link(supTarget) : unresolved(sup.ref) },
      inLedger: row !== undefined,
      verdict: row?.verdict ?? "",
      digest: row?.digest ?? "",
      diagnostics: row?.diagnostics ?? [],
      rollup: statusCounts(statuses),
      rollupTotal: statuses.length,
      belowCount: sub.length - 1,
      childCount: children.length,
      targets: targets.map((w) => b.link(w)),
      targetCount: targets.length,
    };
  });

  // ── Packages, counts, slices. ──
  const packages: DocsViewPackage[] = [...new Set(nodes.map((n) => n.package))].sort(byCodeUnit).map((name) => {
    const inPkg = nodes.filter((n) => n.package === name);
    const groups = new Map<string, { type: string; subType: string; count: number; nodes: DocsViewLink[] }>();
    for (const n of inPkg) {
      const key = `${n.type}${TYPE_SUBTYPE_SEPARATOR}${n.subType}`;
      const g = groups.get(key) ?? { type: n.type, subType: n.subType, count: 0, nodes: [] };
      g.count++;
      g.nodes.push(b.link(b.byId.get(n.id)!));
      groups.set(key, g);
    }
    return { name, count: inPkg.length, groups: [...groups.entries()].sort(([a], [c]) => byCodeUnit(a, c)).map(([, g]) => g) };
  });

  const verify = isRecord(input.verify) ? input.verify : undefined;
  const vc = verify !== undefined && isRecord(verify.requirementCounts) ? verify.requirementCounts : undefined;
  const num = (k: string): number | undefined => (vc !== undefined && typeof vc[k] === "number" ? (vc[k] as number) : undefined);
  const allFiles = new Set(nodes.flatMap((n) => n.files.flatMap((g) => g.paths)));
  const counts: DocsViewCounts = {
    nodes: nodes.length,
    packages: packages.length,
    requirements: requirements.length,
    functional: requirements.filter((r) => r.subType === REQUIREMENT_SUBTYPE_FUNCTIONAL).length,
    architectural: requirements.filter((r) => r.subType === REQUIREMENT_SUBTYPE_ARCHITECTURAL).length,
    byStatus: statusCounts(requirements.map((r) => r.status)),
    claims: requirements.reduce((a, r) => a + r.implementedBy.filter((l) => l.resolves).length, 0),
    files: allFiles.size,
    routes: nodes.reduce((a, n) => a + n.routes.length, 0),
    undecided: num("undecided") ?? 0,
    coverageMeasured: num("entitiesTotal") !== undefined,
    entitiesClaimed: num("entitiesClaimed") ?? 0,
    entitiesTotal: num("entitiesTotal") ?? 0,
  };

  return {
    format: DOCS_VIEW_FORMAT,
    sources: { requirements: hasVerify, files: isRecord(input.manifest), routes: Array.isArray(input.routes) },
    counts,
    packages,
    nodes,
    requirements,
    advisories,
    slices: slicesOf(b, nodes, requirements),
  };
}

function slicesOf(b: Builder, nodes: DocsViewNode[], requirements: DocsViewRequirement[]): DocsViewSlice[] {
  const slices: DocsViewSlice[] = [];
  const sorted = (s: Iterable<string>): string[] => [...new Set(s)].sort(byCodeUnit);
  for (const pkg of sorted(nodes.map((n) => n.package))) {
    slices.push({ id: `package:${pkg}`, kind: "package", anchor: pkg, nodes: sorted(nodes.filter((n) => n.package === pkg).map((n) => n.id)) });
  }
  // A requirement with requirements below it: the subtree, each node it claims, and the
  // top-level node holding a claimed member.
  const byId = new Map(requirements.map((r) => [r.id, r] as const));
  for (const r of requirements) {
    if (r.childCount === 0) continue;
    const ids: string[] = [];
    const visit = (x: DocsViewRequirement): void => {
      ids.push(x.id);
      for (const l of x.implementedBy) {
        if (!l.resolves) continue;
        ids.push(l.target.id);
        const w = b.byId.get(l.target.id);
        if (w !== undefined) ids.push(w.top.id);
      }
      for (const c of x.children) {
        const child = byId.get(c.id);
        if (child !== undefined) visit(child);
      }
    };
    visit(r);
    slices.push({ id: `requirement:${r.id}`, kind: "requirement", anchor: r.id, nodes: sorted(ids) });
  }
  // A template: itself and what its own attributes reference.
  for (const n of nodes) {
    if (n.type !== TYPE_TEMPLATE) continue;
    const ids = [n.id, ...n.refs.filter((r) => r.via === null).map((r) => b.byId.get(r.target.id)?.top.id ?? r.target.id)];
    slices.push({ id: `prompt:${n.id}`, kind: "prompt", anchor: n.id, nodes: sorted(ids) });
  }
  return slices.sort((a, c) => byCodeUnit(a.id, c.id));
}

/** The file's bytes: two-space JSON and one trailing newline. */
export function serializeDocsView(view: DocsView): string {
  return JSON.stringify(view, null, 2) + "\n";
}
