// #357 — "what can I author HERE?", which is NOT the question the registry manifest answers.
//
// `buildRegistryManifest` answers "what must all five ports byte-match?" and deliberately
// carves rows OUT of its answer: the `metadata.base` inheritance anchor, which only the
// JVM registers. This catalog enumerates every (type, subType) the registry accepts and
// MARKS the rows the cross-port manifest omits, so a carve-out reads as "not cross-port"
// rather than "missing".
//
// History: the 13 generic `view.*` controls used to be such a carve-out, and `meta types`
// once reported them exactly as a genuine typo is. Ruling R40 put them back in the
// manifest as kind-1 vocabulary: cross-port, every port loads them strictly, and
// `implementedIn: ["typescript"]` says which ports act on them so far.

import type { TypeDefinition, TypeRegistry } from "./registry.js";
import {
  type ManifestAttr,
  type ManifestChild,
  classifyPerTypeAttr,
  INCLUDED,
  compareStrings,
  sortedAttrs,
  sortedChildren,
  METAMODEL_VERSION,
} from "./registry-manifest.js";
import { classifyTypeSubType } from "./registry-manifest-exclusions.js";
import { SUBTYPE_BASE } from "./shared/base-types.js";

/** One registered (type, subType), as an AUTHOR sees it. */
export interface VocabularyType {
  type: string;
  subType: string;
  description: string;
  rules?: string;
  example?: string;
  whenToUse?: string;
  attrs: ManifestAttr[];
  children: ManifestChild[];
  parents?: string[];
  /**
   * R40 kind 1 — the ports that implement this type so far (`["typescript"]`); absent =
   * every port. Cross-port vocabulary either way: every port loads it strictly.
   */
  implementedIn?: readonly string[];
  /**
   * False when the cross-port manifest carves this row out — vocabulary THIS port
   * accepts that the shared five-port contract does not carry. An author can use it
   * here; a sibling port may not have it.
   */
  crossPort: boolean;
  /** Why it is not cross-port (the carve-out's declared category). Absent when it is. */
  portPrivateReason?: string;
  /**
   * True for a type's shared ROOT subtype (`<type>.base`). Attrs and child rules
   * registered there apply to every subtype of the type (see constraint-merge.ts), so a
   * `base` row is a summary of the whole family rather than a control an author picks.
   * Deliberately NOT called "abstract": nothing in the registry records abstractness, and
   * some `base` rows (`attr.base`) are the authorable polymorphic form.
   */
  sharedRoot: boolean;
}

/** Every (type, subType) the registry accepts, plus what every node accepts. */
export interface VocabularyCatalog {
  metamodelVersion: string;
  types: VocabularyType[];
  /** Attrs accepted on EVERY node, whatever its type (`@title`, `@description`, …). */
  commonAttrs: ManifestAttr[];
  defaultSubTypes: Record<string, string>;
}

function toVocabularyType(def: TypeDefinition): VocabularyType {
  const { type, subType } = def.typeId;
  const reason = classifyTypeSubType(type, subType);
  const out: VocabularyType = {
    type,
    subType,
    description: def.description,
    ...(def.rules !== undefined ? { rules: def.rules } : {}),
    ...(def.example !== undefined ? { example: def.example } : {}),
    ...(def.whenToUse !== undefined ? { whenToUse: def.whenToUse } : {}),
    // Same attr filter the manifest applies — the carved-out per-type attr names are
    // bare structural keywords (`isArray`, `extends`) that `@`-prefix to ERR_RESERVED_ATTR,
    // OO-port native bindings, and the `description` commonAttr re-registered per type.
    // Listing any of them here would teach metadata the loader rejects. The manifest's
    // FR-024 requiredness override is deliberately NOT applied: that freezes the
    // CROSS-PORT value during a reference-first rollout, and this answer is about what
    // THIS registry requires of an author right now.
    attrs: sortedAttrs(def.attributes.filter((a) => classifyPerTypeAttr(a.name) === INCLUDED)),
    children: sortedChildren(def.childRules),
    ...(def.implementedIn !== undefined && def.implementedIn.length > 0
      ? { implementedIn: [...def.implementedIn].sort(compareStrings) }
      : {}),
    crossPort: reason === undefined,
    ...(reason !== undefined ? { portPrivateReason: reason } : {}),
    sharedRoot: subType === SUBTYPE_BASE,
  };
  if (def.parents !== undefined && def.parents.length > 0) {
    out.parents = [...def.parents].sort(compareStrings);
  }
  return out;
}

/**
 * Build the authoring-facing vocabulary catalog from an assembled registry.
 *
 * The registry must be COMPOSED (`composeRegistry(coreProviders)`), not merely
 * `registerCoreTypes`'d: the db, ui-web and documentation providers each register attrs
 * onto types the core provider declares, so a partially-composed registry reports a type
 * that exists with most of its attributes missing — `field.string` with 6 attrs instead of
 * 16, and no commonAttrs at all.
 */
export function buildVocabularyCatalog(registry: TypeRegistry): VocabularyCatalog {
  const types = registry
    .allTypes()
    .map((typeId) => toVocabularyType(registry.find(typeId.type, typeId.subType) as TypeDefinition))
    .sort((a, b) =>
      compareStrings(`${a.type}.${a.subType}`, `${b.type}.${b.subType}`),
    );

  const typeNames = Array.from(new Set(types.map((t) => t.type))).sort(compareStrings);
  const defaultSubTypes: Record<string, string> = {};
  for (const typeName of typeNames) {
    const defaultSub = registry.defaultSubTypeOf(typeName);
    if (defaultSub !== undefined) defaultSubTypes[typeName] = defaultSub;
  }

  return {
    metamodelVersion: METAMODEL_VERSION,
    types,
    commonAttrs: sortedAttrs(registry.getCommonAttrs()),
    defaultSubTypes,
  };
}
