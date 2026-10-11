// FR-019 — shared + externally-provided enum resolution.
//
// A reusable enum is a ROOT/package-level abstract `field.enum` (a sibling of
// object.entity) that object fields reach through `extends`. Per ADR-0026 such a
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
// WHICH declaration a field resolves to is decided in the metadata layer
// (`resolveSharedEnumDeclaration`, ADR-0026 Amendment 1) — the same function the
// loader's #246 check uses. This module adds only the TypeScript naming and the
// `@provided` read.
//
// The common inline case (a concrete `field.enum` with @values declared directly,
// no shared declaration on its extends chain) is UNCHANGED — it stays a per-entity
// `<Entity><Field>` union.

import type { MetaField, MetaRoot } from "@metaobjectsdev/metadata";
import { FIELD_ATTR_PROVIDED, resolveSharedEnumDeclaration } from "@metaobjectsdev/metadata";
import { toPascalCase } from "./naming.js";
import { enumValues } from "./enum-meta.js";

/** A shared (root-level abstract) enum declaration the codegen must reason about. */
export interface SharedEnum {
  /** The materialized type name — the abstract declaration's PascalCase name (cross-port identity). */
  readonly name: string;
  /** The declaration's package-qualified key (`<package>::<Name>`). */
  readonly declaration: string;
  /** Member symbols (the @values SSOT), read from the declaration. */
  readonly values: string[];
  /** True when the declaration carries `@provided: true` (reference, don't materialize). */
  readonly provided: boolean;
}

/** The shared-enum descriptor a field resolves to, or undefined for inline enums. */
export function sharedEnumForField(field: MetaField): SharedEnum | undefined {
  const decl = resolveSharedEnumDeclaration(field);
  if (decl === undefined) return undefined;
  // The member set is the DECLARATION's (resolving, so `Money extends Currency` reads
  // the members it inherits) — never a consuming field's, so what is materialized
  // cannot depend on which consumer is visited first.
  const values = enumValues(decl);
  if (values === undefined) return undefined;
  return {
    name: toPascalCase(decl.name),
    declaration: decl.resolutionKey(),
    values,
    // ADR-0039 sanctioned own: @provided is a declaration-layer provenance marker
    // ("THIS type is supplied by hand-written/third-party code"), like `abstract` —
    // it does not flow down an extends chain. A resolving read misfires on a chained
    // declaration (root abstract `B extends` root abstract `@provided A`): B would be
    // reported provided and emit a reference to a hand-written `B` the adopter never
    // declared, instead of materializing B. Matches the JVM ports.
    provided: decl.ownAttrs().get(FIELD_ATTR_PROVIDED) === true,
  };
}

/**
 * All shared (root-level abstract) enum declarations in the loaded root that are
 * actually CONSUMED by at least one object field (entity, projection or value
 * object, through any number of `extends` hops) — keyed by the materialized type
 * name. A declaration nobody extends is not materialized (no dangling type).
 * Deterministic order: first-consumption order across objects.
 *
 * `select` (FR-023 §11.1 item 2), when given, narrows which CONSUMING entities
 * count toward "is this enum used" — an entity for which `select(entity.
 * resolutionKey())` is false contributes nothing, even if it extends the shared
 * declaration. It does not touch which declarations EXIST, only which usages are
 * counted. Absent `select` ⇒ every entity counts, byte-identical to before this
 * parameter existed.
 */
export function collectSharedEnums(
  root: MetaRoot,
  select?: (fqn: string) => boolean,
): Map<string, SharedEnum> {
  const out = new Map<string, SharedEnum>();
  for (const entity of root.objects()) {
    if (select !== undefined && !select(entity.resolutionKey())) continue;
    for (const field of entity.fields()) {
      const shared = sharedEnumForField(field);
      if (shared === undefined) continue;
      if (!out.has(shared.name)) out.set(shared.name, shared);
    }
  }
  return out;
}

/** The shared enums that metaobjects MATERIALIZES (non-@provided, consumed). */
export function materializedSharedEnums(
  root: MetaRoot,
  select?: (fqn: string) => boolean,
): SharedEnum[] {
  return [...collectSharedEnums(root, select).values()].filter((e) => !e.provided);
}

/** Whether any shared enum (materialized or provided) is consumed in the model. */
export function hasSharedEnums(root: MetaRoot): boolean {
  return collectSharedEnums(root).size > 0;
}
