// Mermaid ER renderer — produces a docs/model.md body with:
//   1. A top-level ```mermaid erDiagram block of entities + identity.reference relationships.
//   2. A per-entity prose section consuming the 6 user-facing doc attrs (notes excluded).
//
// D5: @notes is NEVER emitted. Per the Documentation Provider design.

import type { MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import {
  DOC_ATTR_ALIASES,
  DOC_ATTR_DEPRECATED,
  DOC_ATTR_DESCRIPTION,
  DOC_ATTR_REPLACED_BY,
  DOC_ATTR_SEE_ALSO,
  DOC_ATTR_TITLE,
} from "@metaobjectsdev/metadata";

/** Render a docs/model.md body: Mermaid erDiagram + per-entity prose. Abstract
 *  entities are excluded — they have no physical table to put in a diagram
 *  (matches migrate-ts/expected-schema.ts's same filter). */
export function renderMermaidModel(root: MetaRoot): string {
  const entities = root
    .objects()
    .filter((o) => o.isEntity() && !o.isAbstract);
  const parts: string[] = [];

  parts.push("# Data Model");
  parts.push("");
  parts.push("```mermaid");
  parts.push("erDiagram");
  for (const line of renderRelationships(entities)) parts.push(`    ${line}`);
  for (const entity of entities) {
    parts.push("");
    for (const line of renderEntityBlock(entity)) parts.push(`    ${line}`);
  }
  parts.push("```");
  parts.push("");

  for (const entity of entities) {
    for (const line of renderEntityProse(entity)) parts.push(line);
    parts.push("");
  }

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
    const marker = pkFields.has(field.name)
      ? " PK"
      : fkFields.has(field.name)
        ? " FK"
        : "";
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
  const out: string[] = [];
  const title = readStr(entity.attr(DOC_ATTR_TITLE)) ?? entity.name;
  out.push(`## ${title}`);
  const desc = readStr(entity.attr(DOC_ATTR_DESCRIPTION));
  if (desc) {
    out.push("");
    out.push(desc);
  }
  const aliases = readStrArr(entity.attr(DOC_ATTR_ALIASES));
  if (aliases.length > 0) {
    out.push("");
    out.push(`*Aliases:* ${aliases.join(", ")}`);
  }
  const deprecated = readStr(entity.attr(DOC_ATTR_DEPRECATED));
  // Truthy check (not !== undefined): an empty @deprecated is the same signal
  // as none (no reason ⇒ nothing meaningful to render in the prose callout).
  if (deprecated) {
    const replaced = readStr(entity.attr(DOC_ATTR_REPLACED_BY));
    out.push("");
    out.push(
      `> ⚠️ **Deprecated:** ${deprecated}${replaced ? ` Replaced by **${replaced}**.` : ""}`,
    );
  }
  const seeAlso = readStrArr(entity.attr(DOC_ATTR_SEE_ALSO));
  if (seeAlso.length > 0) {
    out.push("");
    out.push("**See also:**");
    for (const url of seeAlso) out.push(`- <${url}>`);
  }
  // notes intentionally NOT emitted — D5 contract.
  return out;
}

function readStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function readStrArr(v: unknown): string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string")
    ? (v as string[])
    : [];
}
