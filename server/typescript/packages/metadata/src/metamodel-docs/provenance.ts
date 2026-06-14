// FR-033 S3 — metamodel provenance: who owns each type and who contributes each attr.
//
// The composed registry knows WHAT vocabulary exists but not WHICH of the five
// concern providers declared each piece — that fact is flattened away at
// registration. We recover it from the embedded `ProviderDefinition`s:
//
//   • a definition's `types[]` (non-universal entries) declare the `type.subType`s
//     that provider OWNS (registers), plus the attrs that ride INLINE on them;
//   • a definition's `extends[]` declare attrs a CONCERN provider contributes to a
//     type another provider owns (subType selector `"*"` / list / single);
//   • the universal `*.*` entry's attr children are COMMON attrs (documentation).
//
// The `"*"` extend selector is resolved against the LIVE registry's registered
// subtypes, so a concern attr added to "every field" is attributed on every
// concrete field subtype the doc renderer walks.

import type { TypeRegistry } from "../registry.js";
import type { ProviderDefinition, TypeDef, ChildDef } from "../provider-data.js";
import { CHILD_RULE_WILDCARD } from "../shared/structural.js";
import { isExcludedTypeSubType } from "../registry-manifest-exclusions.js";
import { ALL_PROVIDER_DEFINITIONS } from "./provider-definitions.js";

const ATTR_CHILD_TYPE = "attr";

/** A `(type, subType)` key, identical to the registry's internal key form. */
function typeKey(type: string, subType: string): string {
  return `${type}.${subType}`;
}

/** A `(type, subType, attrName)` key for the attr-provenance map. */
function attrKey(type: string, subType: string, attrName: string): string {
  return `${type}.${subType}.${attrName}`;
}

function isUniversal(t: TypeDef): boolean {
  return t.type === CHILD_RULE_WILDCARD && t.subType === CHILD_RULE_WILDCARD;
}

function isAttrChild(c: ChildDef): boolean {
  return c.type === ATTR_CHILD_TYPE;
}

/**
 * The provenance lens: maps each registered type/attr back to its owning /
 * contributing provider id, and the inverse (a provider → what it owns +
 * contributes). Built once from the embedded definitions + the live registry.
 */
export interface MetamodelProvenance {
  /** Provider id that REGISTERS (owns) this `type.subType`, or undefined. */
  ownerOfType(type: string, subType: string): string | undefined;
  /** Provider id that declared/contributed this attr on this `type.subType`. */
  ownerOfAttr(type: string, subType: string, attrName: string): string | undefined;
  /** Provider id that contributed this common (universal) attr. */
  ownerOfCommonAttr(attrName: string): string | undefined;
  /** The provider id → its description (from the embedded definition). */
  providerDescription(providerId: string): string | undefined;
  /** All provider ids that declared anything, sorted. */
  providerIds(): string[];
  /** The `type.subType`s a provider OWNS (registers), sorted. */
  typesOwnedBy(providerId: string): string[];
  /** The `(type.subType → [attrName])` a provider CONTRIBUTES via extends/inline, sorted. */
  attrsContributedBy(providerId: string): { typeSubType: string; attrs: string[] }[];
  /** Common attr names a provider contributes (universal), sorted. */
  commonAttrsBy(providerId: string): string[];
}

/**
 * Build the provenance lens from the embedded provider definitions + a composed
 * registry (the registry resolves `"*"` extend selectors to concrete subtypes).
 *
 * The provider descriptions are read from the embedded definitions indirectly:
 * a `ProviderDefinition` carries only `provider` (the id), so descriptions come
 * from a small registry-keyed lookup the caller can override; here we accept the
 * descriptions the provider objects expose by mapping id → the first non-empty
 * description we can derive. To keep this module pure + dependency-light, the
 * provider descriptions are supplied via `providerDescriptions`.
 */
export function buildMetamodelProvenance(
  registry: TypeRegistry,
  opts?: { providerDescriptions?: ReadonlyMap<string, string> },
): MetamodelProvenance {
  const ownerType = new Map<string, string>();
  const ownerAttr = new Map<string, string>();
  const ownerCommon = new Map<string, string>();

  // Inverse indexes for the provider lens.
  const ownedByProvider = new Map<string, Set<string>>();
  const contributedByProvider = new Map<string, Map<string, Set<string>>>();
  const commonByProvider = new Map<string, Set<string>>();
  const providerSet = new Set<string>();

  const note = (id: string) => {
    providerSet.add(id);
    if (!ownedByProvider.has(id)) ownedByProvider.set(id, new Set());
    if (!contributedByProvider.has(id)) contributedByProvider.set(id, new Map());
    if (!commonByProvider.has(id)) commonByProvider.set(id, new Set());
  };

  const recordContribution = (id: string, type: string, subType: string, attr: string) => {
    const k = attrKey(type, subType, attr);
    // First declarer wins (an attr is contributed by exactly one provider).
    if (!ownerAttr.has(k)) ownerAttr.set(k, id);
    const byType = contributedByProvider.get(id)!;
    const tk = typeKey(type, subType);
    if (!byType.has(tk)) byType.set(tk, new Set());
    byType.get(tk)!.add(attr);
  };

  for (const def of ALL_PROVIDER_DEFINITIONS) {
    const id = def.provider;
    note(id);

    for (const t of def.types ?? []) {
      if (isUniversal(t)) {
        // Universal `*.*` entry → common attrs, owned by this provider.
        for (const c of t.children ?? []) {
          if (isAttrChild(c)) {
            if (!ownerCommon.has(c.name)) ownerCommon.set(c.name, id);
            commonByProvider.get(id)!.add(c.name);
          }
        }
        continue;
      }
      // A real type this provider OWNS (registers).
      const tk = typeKey(t.type, t.subType);
      if (!ownerType.has(tk)) ownerType.set(tk, id);
      // The provider lens ("Owns (registers)" on providers.md) advertises the
      // SAME agreed vocabulary INDEX/type pages cover — skip the manifest-
      // excluded rows (the TS-web-presentation `view.*` controls) so all three
      // doc surfaces share one consistent set. (`ownerType` still records the
      // raw owner for any internal lookup; only the published list is filtered.)
      if (!isExcludedTypeSubType(t.type, t.subType)) ownedByProvider.get(id)!.add(tk);
      // Inline attrs on an owned type are contributed by the same provider.
      for (const c of t.children ?? []) {
        if (isAttrChild(c)) recordContribution(id, t.type, t.subType, c.name);
      }
    }

    // `extends[]` — a concern provider's attrs added to types another provider owns.
    for (const ext of def.extends ?? []) {
      const subTypes = resolveExtendSubTypes(registry, ext.type, ext.subType);
      for (const subType of subTypes) {
        for (const c of ext.children) {
          if (isAttrChild(c)) recordContribution(id, ext.type, subType, c.name);
        }
      }
    }
  }

  const descriptions = opts?.providerDescriptions ?? new Map<string, string>();

  const sorted = (s: Set<string>): string[] => [...s].sort(compare);

  return {
    ownerOfType: (type, subType) => ownerType.get(typeKey(type, subType)),
    ownerOfAttr: (type, subType, attrName) => ownerAttr.get(attrKey(type, subType, attrName)),
    ownerOfCommonAttr: (attrName) => ownerCommon.get(attrName),
    providerDescription: (providerId) => descriptions.get(providerId),
    providerIds: () => [...providerSet].sort(compare),
    typesOwnedBy: (providerId) => sorted(ownedByProvider.get(providerId) ?? new Set()),
    attrsContributedBy: (providerId) => {
      const byType = contributedByProvider.get(providerId) ?? new Map();
      return [...byType.entries()]
        .map(([typeSubType, attrs]) => ({
          typeSubType,
          attrs: sorted(attrs as Set<string>),
        }))
        .sort((a, b) => compare(a.typeSubType, b.typeSubType));
    },
    commonAttrsBy: (providerId) => sorted(commonByProvider.get(providerId) ?? new Set()),
  };
}

/** Resolve an extend `subType` selector to concrete registered subtypes. */
function resolveExtendSubTypes(
  registry: TypeRegistry,
  type: string,
  selector: string | readonly string[],
): readonly string[] {
  if (selector === CHILD_RULE_WILDCARD) return registry.allSubTypesOf(type);
  return Array.isArray(selector) ? selector : [selector as string];
}

/** ASCII codepoint compare — locale-independent, byte-stable. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
