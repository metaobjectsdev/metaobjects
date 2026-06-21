// FR-019 — shared + externally-provided enum resolution.
//
// A reusable enum is a ROOT/package-level abstract `field.enum` (a sibling of
// object.entity) that concrete entity fields `extends`. Per ADR-0026 such a
// declaration is materialized ONCE per port and referenced, instead of being
// redeclared inline in every consuming entity file.
//
// Two cases on the abstract declaration:
//   • non-@provided → metaobjects MATERIALIZES the type once (a shared module),
//     and consuming fields reference it.
//   • @provided: true → metaobjects emits NOTHING for the type; consuming fields
//     reference an existing hand-written/third-party type, resolved via per-port
//     codegen config (the namespace/module never lives in metadata — ADR-0001).
//
// The common inline case (a concrete `field.enum` with @values declared directly,
// no root-extends) is UNCHANGED — it stays a per-entity `<Entity><Field>` union.

import type { MetaField, MetaRoot } from "@metaobjectsdev/metadata";
import {
  FIELD_SUBTYPE_ENUM,
  FIELD_ATTR_PROVIDED,
  TYPE_METADATA,
} from "@metaobjectsdev/metadata";
import { toPascalCase } from "./naming.js";
import { enumValues } from "./enum-meta.js";

/** A shared (root-level abstract) enum declaration the codegen must reason about. */
export interface SharedEnum {
  /** The materialized type name — the abstract declaration's PascalCase name (cross-port identity). */
  readonly name: string;
  /** Member symbols (the @values SSOT). */
  readonly values: string[];
  /** True when the declaration carries `@provided: true` (reference, don't materialize). */
  readonly provided: boolean;
}

/**
 * The root-level abstract `field.enum` a concrete enum field resolves to via
 * `extends`, or undefined when the field is an inline enum (no root-abstract
 * super). A super qualifies only when it is (a) an abstract field, AND (b) a
 * direct child of the metadata root (a package-level declaration) — NOT an
 * abstract field nested inside another object.
 */
export function resolveSharedEnumDecl(field: MetaField): MetaField | undefined {
  if (field.subType !== FIELD_SUBTYPE_ENUM) return undefined;
  const sup = field.resolveSuper();
  if (sup === undefined) return undefined;
  if (!sup.isAbstract) return undefined;
  // The declaration must sit at the package/root level (sibling of object.entity),
  // i.e. its parent node is the metadata root.
  const parent = sup.parent;
  if (parent === undefined || parent.type !== TYPE_METADATA) return undefined;
  return sup;
}

/** The shared-enum descriptor a field resolves to, or undefined for inline enums. */
export function sharedEnumForField(field: MetaField): SharedEnum | undefined {
  const decl = resolveSharedEnumDecl(field);
  if (decl === undefined) return undefined;
  const values = enumValues(field);
  if (values === undefined) return undefined;
  return {
    name: toPascalCase(decl.name),
    values,
    provided: decl.attr(FIELD_ATTR_PROVIDED) === true,
  };
}

/**
 * All shared (root-level abstract) enum declarations in the loaded root that are
 * actually CONSUMED by at least one concrete entity field — keyed by the
 * materialized type name. A declaration nobody extends is not materialized (no
 * dangling type). Deterministic order: first-consumption order across entities.
 */
export function collectSharedEnums(root: MetaRoot): Map<string, SharedEnum> {
  const out = new Map<string, SharedEnum>();
  for (const entity of root.objects()) {
    for (const field of entity.fields()) {
      const shared = sharedEnumForField(field);
      if (shared === undefined) continue;
      if (!out.has(shared.name)) out.set(shared.name, shared);
    }
  }
  return out;
}

/** The shared enums that metaobjects MATERIALIZES (non-@provided, consumed). */
export function materializedSharedEnums(root: MetaRoot): SharedEnum[] {
  return [...collectSharedEnums(root).values()].filter((e) => !e.provided);
}

/** Whether any shared enum (materialized or provided) is consumed in the model. */
export function hasSharedEnums(root: MetaRoot): boolean {
  return collectSharedEnums(root).size > 0;
}
