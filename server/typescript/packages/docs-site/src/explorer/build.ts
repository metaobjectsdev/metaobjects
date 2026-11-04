// The `explorer.json` builder — the data spine every explorer page reads.
//
// PORT-NEUTRAL INPUT, on purpose. It reads three documents and never the loader:
//
//   model     the EFFECTIVE canonical JSON (`meta export --effective`): inheritance and
//             overlays already resolved, references already in their canonical spelling.
//   verify    the `meta verify --format json` payload: the requirement ledger rows, each
//             link as the gate resolved it, the counts and the findings.
//   manifest  `.metaobjects/.gen-state/.hashes.json`: which generated file came from which
//             node, where the port records it.
//
// Every port already has a canonical serializer and writes the same manifest, so a Java, C#
// or Python project can feed this without the Node CLI knowing its providers. The builder
// therefore resolves nothing the inputs have not resolved: an `@implementedBy` link becomes
// an edge only because the verify row names its target, never by a name match here.
//
// DETERMINISTIC: the same three inputs give the same bytes (`serializeExplorer`), so the
// file can sit under a drift gate.

import {
  ATTR_PREFIX,
  FIELD_ATTR_OBJECT_REF,
  IDENTITY_REFERENCE_ATTR_REFERENCES,
  IDENTITY_SUBTYPE_REFERENCE,
  PACKAGE_SEPARATOR,
  CHILD_REF_SEPARATOR,
  RELATIONSHIP_ATTR_OBJECT_REF,
  RESERVED_KEY_ABSTRACT,
  RESERVED_KEY_CHILDREN,
  RESERVED_KEY_EXTENDS,
  RESERVED_KEY_IS_ARRAY,
  RESERVED_KEY_NAME,
  RESERVED_KEY_PACKAGE,
  SUBTYPE_ROOT,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_RESPONSE_REF,
  TYPE_FIELD,
  TYPE_IDENTITY,
  TYPE_METADATA,
  TYPE_RELATIONSHIP,
  TYPE_REQUIREMENT,
  TYPE_SUBTYPE_SEPARATOR,
  TYPE_TEMPLATE,
} from "@metaobjectsdev/metadata/constants";
import {
  EXPLORER_FORMAT,
  type ExplorerEdge,
  type ExplorerEdgeKind,
  type ExplorerGenerated,
  type ExplorerJson,
  type ExplorerLedger,
  type ExplorerLedgerRow,
  type ExplorerNode,
  type ExplorerRoute,
  type ExplorerSlice,
} from "./types.js";

export interface ExplorerInput {
  /** Parsed `meta export --effective` output (or any port's effective canonical JSON). */
  model: unknown;
  /** Parsed `meta verify --format json` output. Without it there is no ledger and no
   *  `implementedBy` / `supersededBy` edge. */
  verify?: unknown;
  /** Parsed `.metaobjects/.gen-state/.hashes.json`. Without it there is no `generated`. */
  manifest?: unknown;
  /** The routes the project mounts: `[{ node, method, path }]`, one per route, `node` a node
   *  id. A route whose node is not in the model is dropped. Without it there is no `api`. */
  routes?: unknown;
}

const ROOT_KEY = `${TYPE_METADATA}${TYPE_SUBTYPE_SEPARATOR}${SUBTYPE_ROOT}`;

/** Code-unit order: the same in every runtime and locale, unlike `localeCompare`. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One `{ "<type>.<subType>": body }` element of a `children` array. */
interface RawChild {
  type: string;
  subType: string;
  body: Record<string, unknown>;
}

function rawChildren(body: Record<string, unknown>): RawChild[] {
  const list = body[RESERVED_KEY_CHILDREN];
  if (!Array.isArray(list)) return [];
  const out: RawChild[] = [];
  for (const el of list) {
    if (!isRecord(el)) continue;
    const keys = Object.keys(el);
    if (keys.length !== 1) continue;
    const key = keys[0] as string;
    const inner = el[key];
    if (!isRecord(inner)) continue;
    const sep = key.indexOf(TYPE_SUBTYPE_SEPARATOR);
    out.push({
      type: sep === -1 ? key : key.slice(0, sep),
      subType: sep === -1 ? "" : key.slice(sep + 1),
      body: inner,
    });
  }
  return out;
}

function attrsOf(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(body).sort(byCodeUnit)) {
    if (key.startsWith(ATTR_PREFIX)) out[key.slice(ATTR_PREFIX.length)] = body[key];
  }
  return out;
}

function stringAttr(body: Record<string, unknown>, name: string): string | undefined {
  const v = body[`${ATTR_PREFIX}${name}`];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** A node as walked, before it is written out: its id, its raw body and its top-level owner. */
interface Walked {
  node: ExplorerNode;
  body: Record<string, unknown>;
  /** The id of the top-level node this one sits under (itself, at the top). */
  owner: string;
}

function walkModel(model: unknown): Walked[] {
  if (!isRecord(model) || !isRecord(model[ROOT_KEY])) {
    throw new Error(`explorer: the model is not canonical metadata JSON — expected one "${ROOT_KEY}" object`);
  }
  const root = model[ROOT_KEY] as Record<string, unknown>;
  const rootPkg = typeof root[RESERVED_KEY_PACKAGE] === "string" ? (root[RESERVED_KEY_PACKAGE] as string) : "";
  const out: Walked[] = [];
  const seen = new Set<string>();

  const visit = (child: RawChild, index: number, parent: Walked | undefined): void => {
    const name = typeof child.body[RESERVED_KEY_NAME] === "string" ? (child.body[RESERVED_KEY_NAME] as string) : "";
    let pkg: string;
    let id: string;
    if (parent === undefined) {
      const own = child.body[RESERVED_KEY_PACKAGE];
      pkg = typeof own === "string" ? own : rootPkg;
      id = pkg === "" ? name : `${pkg}${PACKAGE_SEPARATOR}${name}`;
    } else {
      pkg = parent.node.package;
      id = name === "" ? `${parent.node.id}#${index}` : `${parent.node.id}${CHILD_REF_SEPARATOR}${name}`;
      // The first sibling of a name keeps the plain id: it is the one a dotted reference
      // resolves to. A later sibling of another type sharing the name is qualified by type.
      if (name !== "" && seen.has(id)) id = `${id}[${child.type}${TYPE_SUBTYPE_SEPARATOR}${child.subType}]`;
    }
    if (seen.has(id)) {
      throw new Error(`explorer: two nodes share the id "${id}" — the model names two siblings alike`);
    }
    seen.add(id);
    const ext = child.body[RESERVED_KEY_EXTENDS];
    const node: ExplorerNode = {
      id,
      type: child.type,
      subType: child.subType,
      name,
      package: pkg,
      order: index,
      ...(parent !== undefined ? { parent: parent.node.id } : {}),
      ...(typeof ext === "string" && ext !== "" ? { extends: nodeIdOf(ext) } : {}),
      ...(child.body[RESERVED_KEY_ABSTRACT] === true ? { abstract: true as const } : {}),
      ...(child.body[RESERVED_KEY_IS_ARRAY] === true ? { isArray: true as const } : {}),
      attrs: attrsOf(child.body),
    };
    const walked: Walked = { node, body: child.body, owner: parent === undefined ? id : parent.owner };
    out.push(walked);
    rawChildren(child.body).forEach((c, i) => visit(c, i, walked));
  };

  rawChildren(root).forEach((c, i) => visit(c, i, undefined));
  return out;
}

/** A canonical reference spells a root-level target `::Name`; the node's id is `Name`. */
function nodeIdOf(ref: string): string {
  return ref.startsWith(PACKAGE_SEPARATOR) ? ref.slice(PACKAGE_SEPARATOR.length) : ref;
}

/**
 * Mark the members a top-level node's effective tree inherited: a direct child whose type,
 * name and body equal a direct child of an ancestor named through `extends`. The id recorded
 * is the TOPMOST such ancestor — where the member is declared.
 */
function markInherited(walked: Walked[], byId: Map<string, Walked>): void {
  const childKey = (w: Walked): string => `${w.node.type}${TYPE_SUBTYPE_SEPARATOR}${w.node.subType}:${w.node.name}`;
  const directChildren = new Map<string, Map<string, Walked>>();
  for (const w of walked) {
    if (w.node.parent === undefined || w.node.name === "") continue;
    const m = directChildren.get(w.node.parent) ?? new Map<string, Walked>();
    m.set(childKey(w), w);
    directChildren.set(w.node.parent, m);
  }
  for (const w of walked) {
    if (w.node.parent !== undefined || w.node.extends === undefined) continue;
    const members = directChildren.get(w.node.id);
    if (members === undefined) continue;
    for (const [key, member] of members) {
      const body = JSON.stringify(member.body);
      let declaredOn: string | undefined;
      const visited = new Set<string>([w.node.id]);
      let cur = byId.get(w.node.extends);
      while (cur !== undefined && !visited.has(cur.node.id)) {
        visited.add(cur.node.id);
        const same = directChildren.get(cur.node.id)?.get(key);
        if (same === undefined || JSON.stringify(same.body) !== body) break;
        declaredOn = cur.node.id;
        cur = cur.node.extends === undefined ? undefined : byId.get(cur.node.extends);
      }
      if (declaredOn !== undefined) member.node.inheritedFrom = declaredOn;
    }
  }
}

function modelEdges(walked: Walked[], byId: Map<string, Walked>): ExplorerEdge[] {
  const edges: ExplorerEdge[] = [];
  const add = (kind: ExplorerEdgeKind, from: string, to: string | undefined, via?: string): void => {
    if (to === undefined) return;
    const target = nodeIdOf(to);
    if (!byId.has(from) || !byId.has(target)) return;
    edges.push({ kind, from, to: target, ...(via !== undefined && via !== from ? { via } : {}) });
  };
  for (const w of walked) {
    const { node, body, owner } = w;
    if (node.extends !== undefined) add("extends", node.id, node.extends);
    if (node.type === TYPE_IDENTITY && node.subType === IDENTITY_SUBTYPE_REFERENCE) {
      add("references", owner, stringAttr(body, IDENTITY_REFERENCE_ATTR_REFERENCES), node.id);
    }
    if (node.type === TYPE_FIELD) add("objectRef", owner, stringAttr(body, FIELD_ATTR_OBJECT_REF), node.id);
    if (node.type === TYPE_RELATIONSHIP) add("association", owner, stringAttr(body, RELATIONSHIP_ATTR_OBJECT_REF), node.id);
    if (node.type === TYPE_TEMPLATE) {
      add("payload", node.id, stringAttr(body, TEMPLATE_ATTR_PAYLOAD_REF));
      add("reply", node.id, stringAttr(body, TEMPLATE_ATTR_RESPONSE_REF));
    }
    if (node.type === TYPE_REQUIREMENT && node.parent !== undefined && byId.get(node.parent)?.node.type === TYPE_REQUIREMENT) {
      add("contains", node.parent, node.id);
    }
  }
  return edges;
}

function asLinks(v: unknown): { ref: string; resolves: boolean; target?: string }[] {
  if (!Array.isArray(v)) return [];
  return v.map(asLink).filter((l): l is NonNullable<typeof l> => l !== undefined);
}

function asLink(v: unknown): { ref: string; resolves: boolean; target?: string } | undefined {
  if (!isRecord(v) || typeof v.ref !== "string") return undefined;
  return {
    ref: v.ref,
    resolves: v.resolves === true,
    ...(typeof v.target === "string" ? { target: v.target } : {}),
  };
}

function ledgerFrom(verify: unknown, byId: Map<string, Walked>, edges: ExplorerEdge[]): ExplorerLedger | undefined {
  if (!isRecord(verify) || !Array.isArray(verify.requirementLedger)) return undefined;
  const rows: ExplorerLedgerRow[] = [];
  for (const raw of verify.requirementLedger) {
    if (!isRecord(raw) || typeof raw.qualifiedPath !== "string" || typeof raw.path !== "string") continue;
    const node = raw.qualifiedPath;
    const implementedBy = asLinks(raw.implementedBy);
    const supersededBy = asLink(raw.supersededBy);
    const diagnostics = Array.isArray(raw.diagnostics)
      ? raw.diagnostics.filter(isRecord).map((d) => ({
          code: String(d.code ?? ""),
          severity: String(d.severity ?? ""),
          source: String(d.source ?? ""),
          message: String(d.message ?? ""),
        }))
      : [];
    rows.push({
      node,
      path: raw.path,
      package: typeof raw.package === "string" ? raw.package : "",
      qualifiedPath: raw.qualifiedPath,
      subType: typeof raw.subType === "string" ? raw.subType : "",
      ...(typeof raw.level === "number" ? { level: raw.level } : {}),
      ...(typeof raw.status === "string" ? { status: raw.status } : {}),
      ...(typeof raw.disposition === "string" ? { disposition: raw.disposition } : {}),
      digest: typeof raw.digest === "string" ? raw.digest : "",
      implementedBy,
      ...(supersededBy !== undefined ? { supersededBy } : {}),
      diagnostics,
      verdict: typeof raw.verdict === "string" ? raw.verdict : "",
    });
    if (byId.has(node)) {
      for (const link of implementedBy) {
        if (link.target !== undefined && byId.has(link.target)) edges.push({ kind: "implementedBy", from: node, to: link.target });
      }
      if (supersededBy?.target !== undefined && byId.has(supersededBy.target)) {
        edges.push({ kind: "supersededBy", from: node, to: supersededBy.target });
      }
    }
  }
  const requirements = verify.requirements;
  return {
    counts: isRecord(verify.requirementCounts) ? verify.requirementCounts : {},
    rows,
    diagnostics: isRecord(requirements) && Array.isArray(requirements.rows) ? requirements.rows : [],
  };
}

function generatedFrom(manifest: unknown): ExplorerGenerated[] | undefined {
  if (!isRecord(manifest)) return undefined;
  const byNode = new Map<string, { path: string; generatedBy: string }[]>();
  for (const [path, entry] of Object.entries(manifest)) {
    if (!isRecord(entry) || typeof entry.sourceNode !== "string") continue;
    const by = typeof entry.generatedBy === "string" ? entry.generatedBy : "";
    const list = byNode.get(entry.sourceNode) ?? [];
    list.push({ path, generatedBy: by });
    byNode.set(entry.sourceNode, list);
  }
  return [...byNode.keys()].sort(byCodeUnit).map((node) => ({
    node,
    files: (byNode.get(node) ?? []).sort((a, b) => byCodeUnit(a.path, b.path)),
  }));
}

function routesFrom(routes: unknown, byId: Map<string, Walked>): ExplorerRoute[] | undefined {
  if (!Array.isArray(routes)) return undefined;
  const seen = new Map<string, ExplorerRoute>();
  for (const r of routes) {
    if (!isRecord(r) || typeof r.node !== "string" || typeof r.method !== "string" || typeof r.path !== "string") continue;
    if (!byId.has(r.node)) continue;
    const route: ExplorerRoute = { node: r.node, method: r.method.toUpperCase(), path: r.path };
    seen.set(`${route.node}\u0000${route.path}\u0000${route.method}`, route);
  }
  return [...seen.keys()].sort(byCodeUnit).map((k) => seen.get(k) as ExplorerRoute);
}

function derivedSlices(walked: Walked[], byId: Map<string, Walked>, edges: ExplorerEdge[]): ExplorerSlice[] {
  const slices: ExplorerSlice[] = [];
  const ownerOf = (id: string): string => byId.get(id)?.owner ?? id;
  const sorted = (s: Set<string>): string[] => [...s].sort(byCodeUnit);

  // Per package: its top-level nodes.
  const packages = new Map<string, Set<string>>();
  for (const w of walked) {
    if (w.node.parent !== undefined) continue;
    const set = packages.get(w.node.package) ?? new Set<string>();
    set.add(w.node.id);
    packages.set(w.node.package, set);
  }
  for (const [pkg, ids] of packages) slices.push({ id: `package:${pkg}`, kind: "package", anchor: pkg, nodes: sorted(ids) });

  // Per requirement subtree, for every requirement with nested requirements: the subtree,
  // each node it claims, and the object owning a claimed member.
  const containsFrom = new Map<string, string[]>();
  const claimsFrom = new Map<string, string[]>();
  for (const e of edges) {
    const target = e.kind === "contains" ? containsFrom : e.kind === "implementedBy" ? claimsFrom : undefined;
    if (target === undefined) continue;
    const list = target.get(e.from) ?? [];
    list.push(e.to);
    target.set(e.from, list);
  }
  for (const w of walked) {
    if (w.node.type !== TYPE_REQUIREMENT || !containsFrom.has(w.node.id)) continue;
    const set = new Set<string>();
    const stack = [w.node.id];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (set.has(id)) continue;
      set.add(id);
      for (const t of claimsFrom.get(id) ?? []) {
        set.add(t);
        set.add(ownerOf(t));
      }
      stack.push(...(containsFrom.get(id) ?? []));
    }
    slices.push({ id: `requirement:${w.node.id}`, kind: "requirement", anchor: w.node.id, nodes: sorted(set) });
  }

  // Per prompt: the prompt, its payload and its reply.
  for (const w of walked) {
    if (w.node.type !== TYPE_TEMPLATE || w.node.parent !== undefined) continue;
    const set = new Set<string>([w.node.id]);
    for (const e of edges) if (e.from === w.node.id && (e.kind === "payload" || e.kind === "reply")) set.add(e.to);
    slices.push({ id: `prompt:${w.node.id}`, kind: "prompt", anchor: w.node.id, nodes: sorted(set) });
  }

  return slices.sort((a, b) => byCodeUnit(a.id, b.id));
}

const edgeKey = (e: ExplorerEdge): string => `${e.kind}\u0000${e.from}\u0000${e.to}\u0000${e.via ?? ""}`;

/** Build `explorer.json` from the port-neutral inputs. Throws when `model` is not canonical
 *  metadata JSON; a missing or malformed `verify` / `manifest` only leaves its part out. */
export function buildExplorer(input: ExplorerInput): ExplorerJson {
  const walked = walkModel(input.model);
  const byId = new Map(walked.map((w) => [w.node.id, w] as const));
  markInherited(walked, byId);
  const edges = modelEdges(walked, byId);
  const ledger = input.verify !== undefined ? ledgerFrom(input.verify, byId, edges) : undefined;
  const generated = input.manifest !== undefined ? generatedFrom(input.manifest) : undefined;
  const api = input.routes !== undefined ? routesFrom(input.routes, byId) : undefined;

  // One edge per (kind, from, to, via): an object can reach one target twice through two
  // members, which is two edges, but never the same edge twice.
  const unique = new Map<string, ExplorerEdge>();
  for (const e of edges) unique.set(edgeKey(e), e);
  const sortedEdges = [...unique].sort(([a], [b]) => byCodeUnit(a, b)).map(([, e]) => e);

  return {
    format: EXPLORER_FORMAT,
    nodes: walked.map((w) => w.node).sort((a, b) => byCodeUnit(a.id, b.id)),
    edges: sortedEdges,
    ...(ledger !== undefined ? { ledger } : {}),
    ...(generated !== undefined ? { generated } : {}),
    ...(api !== undefined ? { api } : {}),
    slices: derivedSlices(walked, byId, sortedEdges),
  };
}

/** The file's bytes: two-space JSON and one trailing newline. */
export function serializeExplorer(explorer: ExplorerJson): string {
  return JSON.stringify(explorer, null, 2) + "\n";
}
