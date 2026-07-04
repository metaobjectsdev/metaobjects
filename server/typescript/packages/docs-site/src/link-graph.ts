import type { MetaData, MetaObject, MetaRelationship } from "@metaobjectsdev/metadata";
import { deriveM2MFields, stripPackage } from "@metaobjectsdev/metadata";
import { type LoadedModel, treeOf } from "./load";

export interface DocNode { kind: "object" | "prompt" | "output"; name: string; pkg: string; pkgPath: string; href: string; node: MetaData; tree: string; }
export interface Ref {
  from: string; to: string; via: string;
  kind: "field" | "fk" | "extends" | "payload" | "relationship" | "origin";
  cardinality?: "one" | "many" | undefined;
  through?: string | undefined;         // junction FQN (M:N)
  sourceJoinField?: string | undefined; // junction source FK (M:N)
  targetJoinField?: string | undefined; // junction target FK (M:N)
  symmetric?: boolean | undefined;      // undirected self-join (M:N)
  onDelete?: string | undefined;        // referential action
  subtype?: string | undefined;         // association / aggregation / composition
}
export interface OriginRef { field: string; from: string; via: string; }

export function pkgOf(node: MetaData): string {
  return (node.package ?? (node as { fileDefaultPackage?: string }).fileDefaultPackage ?? "");
}
export function fqnOf(node: MetaData): string {
  const p = pkgOf(node);
  return p ? `${p}::${node.name}` : node.name;
}

export class LinkGraph {
  private _nodes = new Map<string, DocNode>();
  private _from = new Map<string, Ref[]>();
  private _to = new Map<string, Ref[]>();
  private _extBy = new Map<string, DocNode[]>();
  private _origins = new Map<string, OriginRef[]>();

  constructor(model: LoadedModel) {
    for (const o of model.root.ownChildren()) {
      let kind: DocNode["kind"] | undefined;
      if (o.type === "object") kind = "object";
      else if (o.type === "template") kind = o.subType === "prompt" ? "prompt" : "output";
      if (!kind) continue;
      const pkg = pkgOf(o);
      const pkgPath = pkg.split("::").join("/");
      this._nodes.set(fqnOf(o), {
        kind, name: o.name, pkg, pkgPath,
        href: `${pkgPath}/${o.name}.html`, node: o, tree: treeOf(o, model),
      });
    }
    const addRef = (r: Ref) => {
      (this._from.get(r.from) ?? this._from.set(r.from, []).get(r.from)!).push(r);
      (this._to.get(r.to) ?? this._to.set(r.to, []).get(r.to)!).push(r);
    };
    const resolveRef = (raw: string, ctxPkg: string): string | undefined => {
      const cand = raw.includes("::") ? raw : `${ctxPkg}::${raw}`;
      return this._nodes.has(cand) ? cand : (this._nodes.has(raw) ? raw : undefined);
    };
    // M:N through-junction edge. Derives the junction FK fields via the metadata
    // SSOT (deriveM2MFields) — hetero, directed (@sourceRefField), or symmetric
    // (@symmetric). On a derivation failure (ambiguous self-join) the edge is
    // SKIPPED — generation never fails.
    const addM2mEdge = (from: string, to: string, rel: MetaRelationship, obj: MetaObject, ctxPkg: string, onDelete: string | undefined, subtype: string | undefined): void => {
      const through = rel.through ? (resolveRef(rel.through, ctxPkg) ?? rel.through) : undefined;
      let sourceJoinField: string | undefined, targetJoinField: string | undefined;
      try {
        const f = deriveM2MFields(rel, obj, model.root);
        sourceJoinField = f.sourceField;
        targetJoinField = f.targetField;
      } catch {
        return;  // ambiguous junction — skip the logical edge (the two FK edges still show)
      }
      addRef({ from, to, via: rel.name, kind: "relationship", cardinality: "many", through, sourceJoinField, targetJoinField, symmetric: rel.symmetric, onDelete, subtype });
    };
    for (const dn of this._nodes.values()) {
      const fqn = fqnOf(dn.node);
      if (dn.kind === "object") {
        for (const f of dn.node.childrenOfType("field")) {
          const ref = f.attr("objectRef");
          if (typeof ref === "string") {
            const to = resolveRef(ref, dn.pkg);
            if (to) addRef({ from: fqn, to, via: f.name, kind: "field" });
          }
        }
        // dn.node is typed MetaData; the enclosing dn.kind === "object" guard
        // guarantees it is a MetaObject at runtime. The `unknown` bridge is needed
        // because MetaData does not structurally narrow to MetaObject for tsc.
        const obj = dn.node as unknown as MetaObject;
        // Relationship edges FIRST, so we can suppress the bare FK edge a belongs-to
        // relationship supersedes. Dedupe is keyed by `${targetFqn}::${fkField}`
        // (a string, robust to node-instance identity) — the FK loop skips any
        // reference whose (target, first-field) a belongs-to relationship covered.
        const coveredFk = new Set<string>();
        for (const rel of obj.relationships()) {
          const objectRef = rel.objectRef;
          if (typeof objectRef !== "string") continue;
          const to = resolveRef(objectRef, dn.pkg);
          if (!to) continue;
          const cardinality = rel.cardinality === "many" ? "many" : rel.cardinality === "one" ? "one" : undefined;
          const onDelete = rel.onDelete;
          const subtype = rel.subType;
          if (cardinality === "many" && rel.through !== undefined) {
            addM2mEdge(fqn, to, rel, obj, dn.pkg, onDelete, subtype);   // Task 3 helper
            continue;
          }
          // belongs-to (1:N, one) — find the matching identity.reference to dedupe (mirrors
          // relation-resolver: first reference whose target matches, package-stripped).
          const target = stripPackage(objectRef);
          const match = obj.referenceIdentities().find((r) => stripPackage(r.targetEntity ?? "") === target);
          const fkField = match?.fields?.[0];
          if (fkField) coveredFk.add(`${to}::${fkField}`);
          addRef({ from: fqn, to, via: rel.name, kind: "relationship", cardinality, onDelete, subtype });
        }
        for (const id of dn.node.childrenOfType("identity")) {
          if (id.subType !== "reference") continue;
          const ref = id.attr("references");
          if (typeof ref === "string") {
            const to = resolveRef(ref, dn.pkg);
            if (to) {
              const fieldsValue = id.attr("fields") ?? id.name;
              const firstField = Array.isArray(fieldsValue) ? String(fieldsValue[0] ?? "") : String(fieldsValue);
              if (coveredFk.has(`${to}::${firstField}`)) continue;   // superseded by a relationship edge
              const via = Array.isArray(fieldsValue) ? fieldsValue.join(", ") : String(fieldsValue);
              addRef({ from: fqn, to, via, kind: "fk" });
            }
          }
        }
        for (const f of dn.node.childrenOfType("field")) {
          for (const org of f.childrenOfType("origin")) {
            const from = String(org.attr("from") ?? ""), via = String(org.attr("via") ?? "");
            (this._origins.get(fqn) ?? this._origins.set(fqn, []).get(fqn)!).push({ field: f.name, from, via });
            // connect a projection to its source object so it is not orphaned on diagrams:
            // `from` is "pkg::Entity.field" — strip the trailing ".field" to get the source object ref.
            const dot = from.lastIndexOf(".");
            const srcRef = dot > 0 ? from.slice(0, dot) : "";
            const to = srcRef ? resolveRef(srcRef, dn.pkg) : undefined;
            if (to && to !== fqn) addRef({ from: fqn, to, via: `${f.name} (origin)`, kind: "origin" });
          }
        }
        const sup = dn.node.superResolved;
        if (sup) {
          const supFqn = fqnOf(sup);
          addRef({ from: fqn, to: supFqn, via: "extends", kind: "extends" });
          (this._extBy.get(supFqn) ?? this._extBy.set(supFqn, []).get(supFqn)!).push(dn);
        }
      } else {
        const p = dn.node.attr("payloadRef");
        if (typeof p === "string") {
          const to = resolveRef(p, dn.pkg);
          if (to) addRef({ from: fqn, to, via: "payloadRef", kind: "payload" });
        }
      }
    }
  }
  nodes(): DocNode[] { return [...this._nodes.values()]; }
  byFqn(fqn: string): DocNode | undefined { return this._nodes.get(fqn); }
  refsFrom(fqn: string): Ref[] { return this._from.get(fqn) ?? []; }
  refsTo(fqn: string): Ref[] { return this._to.get(fqn) ?? []; }
  degree(fqn: string): number {
    const n = (rs: Ref[]) => rs.filter((r) => r.kind !== "extends").length;
    return n(this.refsFrom(fqn)) + n(this.refsTo(fqn));
  }
  extendedBy(fqn: string): DocNode[] { return this._extBy.get(fqn) ?? []; }
  originsOf(fqn: string): OriginRef[] { return this._origins.get(fqn) ?? []; }
  ancestors(fqn: string): DocNode[] {
    const out: DocNode[] = [];
    const start = this._nodes.get(fqn);
    if (!start) return out;
    for (let s = start.node.superResolved; s; s = s.superResolved) {
      const t = this._nodes.get(fqnOf(s));
      if (!t) break;
      out.push(t);
    }
    return out;
  }
  relationshipsOf(fqn: string): { name: string; toFqn: string; cardinality: string }[] {
    return this.refsFrom(fqn).filter((r) => r.kind === "relationship")
      .map((r) => ({ name: r.via, toFqn: r.to, cardinality: r.cardinality ?? "" }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  relHref(fromHref: string, toHref: string): string {
    const fromParts = fromHref.split("/");
    const toParts = toHref.split("/");

    // Remove the filename from fromHref to get the directory
    fromParts.pop();

    // Find the common prefix length
    // Note: toParts.length - 1 excludes the filename segment, comparing only directories
    let commonLen = 0;
    for (let i = 0; i < Math.min(fromParts.length, toParts.length - 1); i++) {
      if (fromParts[i] === toParts[i]) {
        commonLen++;
      } else {
        break;
      }
    }

    // Calculate levels to go up
    const up = fromParts.length - commonLen;

    // Get the remaining path from the common ancestor
    const remaining = toParts.slice(commonLen).join("/");

    // Construct the relative path
    return up > 0 ? "../".repeat(up) + remaining : remaining;
  }
}
