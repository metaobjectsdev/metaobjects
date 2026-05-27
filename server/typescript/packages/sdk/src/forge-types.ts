// Meta Forge type + attribute name constants. Centralized for typo-safety
// per CLAUDE.md ("Named constants for metamodel strings — always") and so
// downstream readers (codegen prompts, MCP exposers) have one source of
// truth. See SP5 §4 for the design rationale.

// ---------------------------------------------------------------------------
// New top-level types registered by registerForgeTypes()
// ---------------------------------------------------------------------------

export const FORGE_TYPE_DECISION = "decision";
export const FORGE_TYPE_PRINCIPLE = "principle";
export const FORGE_TYPE_CONVENTION = "convention";
export const FORGE_TYPE_GLOSSARY = "glossary";
export const FORGE_TYPE_FAILURE = "failure";

export const FORGE_TYPES = [
  FORGE_TYPE_DECISION,
  FORGE_TYPE_PRINCIPLE,
  FORGE_TYPE_CONVENTION,
  FORGE_TYPE_GLOSSARY,
  FORGE_TYPE_FAILURE,
] as const;
export type ForgeType = (typeof FORGE_TYPES)[number];

// ---------------------------------------------------------------------------
// Subtypes per type (open lists; "base" is always valid)
// ---------------------------------------------------------------------------

export const FORGE_DECISION_SUBTYPES = ["base", "global", "scoped"] as const;
export const FORGE_PRINCIPLE_SUBTYPES = ["base", "advisory", "enforced"] as const;
export const FORGE_CONVENTION_SUBTYPES = ["base"] as const;
export const FORGE_GLOSSARY_SUBTYPES = ["base"] as const;
export const FORGE_FAILURE_SUBTYPES = ["base"] as const;

// ---------------------------------------------------------------------------
// @forge* attribute names (camelCase, no separator)
// ---------------------------------------------------------------------------

// Universal (any forge-related node)
export const FORGE_ATTR_CONFIDENCE = "forgeConfidence";
export const FORGE_ATTR_SOURCE = "forgeSource";
export const FORGE_ATTR_CAPTURED_AT = "forgeCapturedAt";
export const FORGE_ATTR_LAST_VALIDATED_COMMIT = "forgeLastValidatedCommit";

// Object/entity
export const FORGE_ATTR_PRIMARY_LOCATION = "forgePrimaryLocation";
export const FORGE_ATTR_OCCURRENCES = "forgeOccurrences";

// Decision
export const FORGE_ATTR_RATIONALE = "forgeRationale";
export const FORGE_ATTR_ALTERNATIVES = "forgeAlternatives";
export const FORGE_ATTR_SCOPE = "forgeScope";

// Principle
export const FORGE_ATTR_STATEMENT = "forgeStatement";
export const FORGE_ATTR_ENFORCEMENT = "forgeEnforcement";

// Convention
export const FORGE_ATTR_PATTERN_DESCRIPTION = "forgePatternDescription";
export const FORGE_ATTR_EXAMPLES = "forgeExamples";
export const FORGE_ATTR_COUNTER_EXAMPLES = "forgeCounterExamples";
export const FORGE_ATTR_APPLIES_TO = "forgeAppliesTo";

// Glossary
export const FORGE_ATTR_TERM = "forgeTerm";
export const FORGE_ATTR_SYNONYMS = "forgeSynonyms";
export const FORGE_ATTR_DEFINITION = "forgeDefinition";
export const FORGE_ATTR_CODE_ANCHORS = "forgeCodeAnchors";
export const FORGE_ATTR_SEE_ALSO = "forgeSeeAlso";

// Failure
export const FORGE_ATTR_WHAT_WAS_TRIED = "forgeWhatWasTried";
export const FORGE_ATTR_WHY_IT_FAILED = "forgeWhyItFailed";

export const FORGE_ATTRS = [
  FORGE_ATTR_CONFIDENCE,
  FORGE_ATTR_SOURCE,
  FORGE_ATTR_CAPTURED_AT,
  FORGE_ATTR_LAST_VALIDATED_COMMIT,
  FORGE_ATTR_PRIMARY_LOCATION,
  FORGE_ATTR_OCCURRENCES,
  FORGE_ATTR_RATIONALE,
  FORGE_ATTR_ALTERNATIVES,
  FORGE_ATTR_SCOPE,
  FORGE_ATTR_STATEMENT,
  FORGE_ATTR_ENFORCEMENT,
  FORGE_ATTR_PATTERN_DESCRIPTION,
  FORGE_ATTR_EXAMPLES,
  FORGE_ATTR_COUNTER_EXAMPLES,
  FORGE_ATTR_APPLIES_TO,
  FORGE_ATTR_TERM,
  FORGE_ATTR_SYNONYMS,
  FORGE_ATTR_DEFINITION,
  FORGE_ATTR_CODE_ANCHORS,
  FORGE_ATTR_SEE_ALSO,
  FORGE_ATTR_WHAT_WAS_TRIED,
  FORGE_ATTR_WHY_IT_FAILED,
] as const;
export type ForgeAttr = (typeof FORGE_ATTRS)[number];

// ---------------------------------------------------------------------------
// registerForgeTypes
// ---------------------------------------------------------------------------

import {
  type ChildRule,
  type MetaDataTypeProvider,
  type TypeDefinition,
  TypeId,
  TypeRegistry,
  MetaData,
  TYPE_ATTR,
  CHILD_RULE_WILDCARD,
} from "@metaobjectsdev/metadata";

/** Minimal concrete MetaData subclass used for all forge descriptive nodes. */
class MetaForgeNode extends MetaData {}

function wildcardOf(childType: string): ChildRule {
  return {
    childType,
    childSubType: CHILD_RULE_WILDCARD,
    childName: CHILD_RULE_WILDCARD,
  };
}

function def(
  type: string,
  subType: string,
  description: string,
  childRules: ChildRule[],
): TypeDefinition {
  return {
    typeId: new TypeId(type, subType),
    description,
    factory: (typeId, name) => new MetaForgeNode(typeId, name),
    childRules,
    attributes: [],
  };
}

/**
 * The Meta Forge provider — registers Meta Forge's five descriptive top-level
 * types (decision, principle, convention, glossary, failure) plus their
 * subtypes. Composed AFTER `metaobjects-core-types` so the structural attr
 * type is available for forge child rules.
 *
 * Use via `composeRegistry([...coreProviders, forgeTypesProvider])` or via
 * `loadMemory()`'s default bundle (forge is included by default).
 */
export const forgeTypesProvider: MetaDataTypeProvider = {
  id: "metaobjects-forge",
  dependencies: ["metaobjects-core-types"],
  description: "Meta Forge descriptive top-level types (decision, principle, convention, glossary, failure).",
  registerTypes(registry: TypeRegistry): void {
    const forgeChildRules = [wildcardOf(TYPE_ATTR)];

    for (const subType of FORGE_DECISION_SUBTYPES) {
      registry.register(def(FORGE_TYPE_DECISION, subType, `Forge decision (${subType})`, forgeChildRules));
    }
    for (const subType of FORGE_PRINCIPLE_SUBTYPES) {
      registry.register(def(FORGE_TYPE_PRINCIPLE, subType, `Forge principle (${subType})`, forgeChildRules));
    }
    for (const subType of FORGE_CONVENTION_SUBTYPES) {
      registry.register(def(FORGE_TYPE_CONVENTION, subType, `Forge convention (${subType})`, forgeChildRules));
    }
    for (const subType of FORGE_GLOSSARY_SUBTYPES) {
      registry.register(def(FORGE_TYPE_GLOSSARY, subType, `Forge glossary entry (${subType})`, forgeChildRules));
    }
    for (const subType of FORGE_FAILURE_SUBTYPES) {
      registry.register(def(FORGE_TYPE_FAILURE, subType, `Forge failure record (${subType})`, forgeChildRules));
    }
  },
};

/**
 * Register Meta Forge's five descriptive top-level types into the given
 * registry. Must be called AFTER `registerCoreTypes()`.
 *
 * Thin back-compat wrapper over `forgeTypesProvider.registerTypes`; prefer
 * the provider directly for new code (composes correctly with other providers).
 */
export function registerForgeTypes(registry: TypeRegistry): void {
  forgeTypesProvider.registerTypes(registry);
}
