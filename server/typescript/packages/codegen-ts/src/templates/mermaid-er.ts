// Mermaid ER renderer — produces a docs/model.md body with:
//   1. A top-level ```mermaid erDiagram block of entities + identity.reference relationships.
//   2. A per-entity prose section consuming the 6 user-facing doc attrs (notes excluded).
//
// D5: the notes attr is NEVER emitted. Per the Documentation Provider design.

import type { MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import {
  DOC_ATTR_DESCRIPTION,
  FIELD_SUBTYPE_OBJECT,
  FIELD_ATTR_OBJECT_REF,
  OBJECT_SUBTYPE_VALUE,
} from "@metaobjectsdev/metadata";
import { readDocAttrs } from "./jsdoc.js";

/** Render JUST the fenced ```mermaid erDiagram``` block for the whole model
 *  (entities + identity.reference relationships) — NO per-entity prose. This is
 *  the single neutral ER-diagram builder; both `renderMermaidModel()` (the
 *  standalone model.md body) AND the neutral docs OVERVIEW page (`README.md`,
 *  emitted by the Tier-2 `meta docs` engine) consume it, so there is exactly
 *  ONE place ER topology is computed — no duplicate graph logic (ADR-0020).
 *
 *  Abstract entities are excluded — they have no physical table to put in a
 *  diagram (matches migrate-ts/expected-schema.ts's same filter). */
export function renderMermaidErBlock(root: MetaRoot): string {
  const entities = root
    .objects()
    .filter((o) => o.isEntity() && !o.isAbstract);
  const parts: string[] = [];
  parts.push("```mermaid");
  parts.push("erDiagram");
  for (const line of renderRelationships(entities)) parts.push(`    ${line}`);
  for (const entity of entities) {
    parts.push("");
    for (const line of renderEntityBlock(entity)) parts.push(`    ${line}`);
  }
  parts.push("```");
  return parts.join("\n");
}

/** Render a docs/model.md body: Mermaid erDiagram + per-entity prose. Abstract
 *  entities are excluded — they have no physical table to put in a diagram
 *  (matches migrate-ts/expected-schema.ts's same filter). Reuses the shared
 *  `renderMermaidErBlock()` for the diagram so the ER logic is never duplicated. */
export function renderMermaidModel(root: MetaRoot): string {
  const entities = root
    .objects()
    .filter((o) => o.isEntity() && !o.isAbstract);
  const parts: string[] = [];

  parts.push("# Data Model");
  parts.push("");
  parts.push(renderMermaidErBlock(root));
  parts.push("");

  for (const entity of entities) {
    for (const line of renderEntityProse(entity)) parts.push(line);
    parts.push("");
  }

  return parts.join("\n");
}

/** Render a Mermaid flowchart for ONE focal entity and its direct neighbors
 *  (1-hop). Three node kinds are surfaced and styled distinctly:
 *
 *    - **focal**       — the entity this page is about (deeper blue)
 *    - **same**        — entity in the focal's own package (blue)
 *    - **external**    — entity in a different package (dashed gray)
 *    - **vo**          — value object referenced via `field.object` (rounded
 *                        purple) — composition rather than FK
 *
 *  Every node has a Mermaid `click <node> "./<node>.md"` directive, so the
 *  rendered SVG is a true navigation surface — click any neighbor to jump to
 *  its page. Edges are labeled with the field name that connects them.
 *
 *  This replaces the previous erDiagram-based renderer: Mermaid 10's erDiagram
 *  has near-zero styling and no click support, while flowchart supports both.
 *  The crow's-foot one-to-many notation is dropped — for a 1-hop context
 *  diagram, "what kind of node is this" matters more than ER cardinality.
 *
 *  Returns `undefined` when the focal entity has no neighbors at all, so a
 *  template can `{{#mini}}…{{/mini}}` and skip the section cleanly. Abstract
 *  entities are excluded as neighbors (no physical rows). */
export function renderEntityNeighborhoodErBlock(
  focal: MetaObject,
  root: MetaRoot,
): string | undefined {
  if (focal.isAbstract) return undefined;

  // Resolve neighbor kind so the flowchart can color/shape it accordingly.
  // Same-package = focal's effective package; differing or unknown = external.
  // Value object = object.value subtype. Aborts return classify→undefined.
  //
  // `node.package` is the OWN attr only — entities that take their package
  // from the file-default (`metadata.root: { package: ... }`) leave it
  // undefined. Use `fileDefaultPackage` as the fallback so cross-file
  // boundary detection works in the common case where adopters set the
  // package once at the root, not on every entity. Mirrors the same
  // resolution rule docs-paths.ts uses for page placement.
  const byName = new Map<string, MetaObject>();
  for (const obj of root.objects()) byName.set(obj.name, obj);
  const effectivePkg = (n: MetaObject) => n.package ?? n.fileDefaultPackage;
  const focalPackage = effectivePkg(focal);

  const sameDomain = new Set<string>();
  const external   = new Set<string>();
  const valueObjs  = new Set<string>();

  type NeighborKind = "same" | "external" | "vo";
  function classify(name: string): NeighborKind | undefined {
    if (name === focal.name) return "same";   // self-reference (parent-id etc.)
    const target = byName.get(name);
    if (!target) return undefined;
    if (target.subType === OBJECT_SUBTYPE_VALUE) {
      valueObjs.add(name);
      return "vo";
    }
    if (target.isAbstract) return undefined;
    if (effectivePkg(target) === focalPackage) {
      sameDomain.add(name);
      return "same";
    }
    external.add(name);
    return "external";
  }

  const edges: Array<{ from: string; to: string; label: string }> = [];

  // Outgoing FK — focal references other entities.
  for (const ref of focal.referenceIdentities()) {
    const target = ref.targetEntity;
    const field = ref.fields[0];
    if (typeof target !== "string" || typeof field !== "string") continue;
    const targetName = target.split("::").pop()!;
    if (classify(targetName) === undefined) continue;
    edges.push({ from: focal.name, to: targetName, label: field });
  }

  // Incoming FK — entities that reference the focal.
  for (const other of root.objects().filter(o => o.isEntity() && !o.isAbstract)) {
    if (other.name === focal.name) continue;
    for (const ref of other.referenceIdentities()) {
      const target = ref.targetEntity;
      if (typeof target !== "string") continue;
      if (target.split("::").pop() !== focal.name) continue;
      const field = ref.fields[0];
      if (typeof field !== "string") continue;
      if (classify(other.name) === undefined) continue;
      edges.push({ from: other.name, to: focal.name, label: field });
    }
  }

  // Value-object composition — `field.object @objectRef ContactInfo` etc.
  // These aren't FKs (no row-level identity); they're embedded composition.
  // Surfaced because adopters care: "what's inside this entity's `jsonb`
  // column?" Click-through to the VO docs answers that.
  for (const field of focal.fields()) {
    if (field.subType !== FIELD_SUBTYPE_OBJECT) continue;
    const ref = field.ownAttr(FIELD_ATTR_OBJECT_REF);
    if (typeof ref !== "string" || ref.length === 0) continue;
    const targetName = ref.split("::").pop()!;
    if (classify(targetName) === undefined) continue;
    edges.push({ from: focal.name, to: targetName, label: field.name });
  }

  if (edges.length === 0) return undefined;

  // Build the flowchart. Nodes first (so all are declared before edges),
  // then edges, then click directives, then classDefs + class assignments.
  const allNodes = new Set<string>([focal.name, ...sameDomain, ...external, ...valueObjs]);
  const parts: string[] = ["```mermaid", "flowchart TB"];

  for (const name of allNodes) {
    if (valueObjs.has(name)) {
      // Stadium (rounded-rect) shape signals composition / embedded value.
      parts.push(`    ${name}(["${name}"])`);
    } else {
      // Sharp rectangle for entities.
      parts.push(`    ${name}["${name}"]`);
    }
  }
  for (const { from, to, label } of edges) {
    parts.push(`    ${from} -->|"${label}"| ${to}`);
  }
  // Click directives — link every node (focal + neighbors) to its docs page.
  // Flat-layout assumption: `./<Name>.md` lives next to the focal's page.
  // Package-layout adopters can override the template; the data plumbing
  // is identical either way.
  for (const name of allNodes) {
    parts.push(`    click ${name} "./${name}.md"`);
  }
  // Visual styling: 4 node kinds, 4 classes. Color choices are deliberately
  // muted so the diagram reads as documentation, not infographic art.
  parts.push("    classDef focal    fill:#dbeafe,stroke:#1e40af,stroke-width:2px,color:#1e293b;");
  parts.push("    classDef same     fill:#eff6ff,stroke:#3b82f6,color:#1e293b;");
  parts.push("    classDef external fill:#f3f4f6,stroke:#9ca3af,stroke-dasharray:4 3,color:#374151;");
  parts.push("    classDef vo       fill:#faf5ff,stroke:#9333ea,color:#1e293b;");
  parts.push(`    class ${focal.name} focal;`);
  const sameOthers = [...sameDomain].filter(n => n !== focal.name);
  if (sameOthers.length > 0) parts.push(`    class ${sameOthers.join(",")} same;`);
  if (external.size > 0)     parts.push(`    class ${[...external].join(",")} external;`);
  if (valueObjs.size > 0)    parts.push(`    class ${[...valueObjs].join(",")} vo;`);
  parts.push("```");
  return parts.join("\n");
}

function renderRelationships(entities: MetaObject[]): string[] {
  const lines: string[] = [];
  for (const entity of entities) {
    for (const ref of entity.referenceIdentities()) {
      const refTo = ref.targetEntity;
      if (typeof refTo !== "string" || refTo.length === 0) continue;
      // One-to-many by default — a foreign key on `entity` references one row on `refTo`.
      lines.push(`${refTo} ||--o{ ${entity.name} : "references"`);
    }
  }
  return lines;
}

function renderEntityBlock(entity: MetaObject): string[] {
  const out: string[] = [`${entity.name} {`];
  const pkFields = pkFieldNames(entity);
  const fkFields = fkFieldNames(entity);
  for (const field of entity.fields()) {
    let marker = "";
    if (pkFields.has(field.name)) marker = " PK";
    else if (fkFields.has(field.name)) marker = " FK";
    const desc = field.attr(DOC_ATTR_DESCRIPTION);
    const comment =
      typeof desc === "string" && desc.length > 0
        ? ` "${escapeMermaidComment(desc.split("\n")[0]!)}"`
        : "";
    out.push(`    ${field.subType} ${field.name}${marker}${comment}`);
  }
  out.push("}");
  return out;
}

function pkFieldNames(entity: MetaObject): Set<string> {
  const out = new Set<string>();
  const primary = entity.primaryIdentity();
  if (primary) {
    for (const f of primary.fields) out.add(f);
  }
  return out;
}

function fkFieldNames(entity: MetaObject): Set<string> {
  const out = new Set<string>();
  for (const ref of entity.referenceIdentities()) {
    for (const f of ref.fields) out.add(f);
  }
  return out;
}

function escapeMermaidComment(s: string): string {
  return s.replace(/"/g, '\\"');
}

function renderEntityProse(entity: MetaObject): string[] {
  // readDocAttrs handles the typeof-string / Array.isArray guards and intentionally
  // omits `notes` (D5 contract — never read, never emitted).
  const docs = readDocAttrs(entity);
  const out: string[] = [];
  out.push(`## ${docs.title ?? entity.name}`);
  if (docs.description) {
    out.push("");
    out.push(docs.description);
  }
  if (docs.aliases && docs.aliases.length > 0) {
    out.push("");
    out.push(`*Aliases:* ${docs.aliases.join(", ")}`);
  }
  // Truthy check (not !== undefined): an empty deprecated value is the same
  // signal as none (no reason ⇒ nothing meaningful to render in the prose callout).
  if (docs.deprecated) {
    const replaced = docs.replacedBy ? ` Replaced by **${docs.replacedBy}**.` : "";
    out.push("");
    out.push(`> ⚠️ **Deprecated:** ${docs.deprecated}${replaced}`);
  }
  if (docs.seeAlso && docs.seeAlso.length > 0) {
    out.push("");
    out.push("**See also:**");
    for (const url of docs.seeAlso) out.push(`- <${url}>`);
  }
  return out;
}
