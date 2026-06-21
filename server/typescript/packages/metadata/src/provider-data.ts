// FR-033 — provider definitions as declarative data.
//
// A provider's *declarative* metamodel definition (vocabulary + attr constraints
// + child cardinality + descriptions + rule prose) lives as data; the factory
// (behavior) is supplied separately. `defineProviderFromData` turns that data +
// a code-supplied factory map into the `TypeDefinition`s a provider passes to
// `registry.register()`. This is the data/code boundary: declarative facts and
// rule *prose* are data; factories, imperative validation, and codegen stay code.
//
// See spec/superpowers/specs/2026-06-13-metamodel-self-description-design.md §3 +
// §3.1 (the constraint model). This module implements Plan Task 1, Task 2, and
// the format half of Task 7.

import type { AttrSchema, ChildRule, TypeDefinition, TypeRegistry } from "./registry.js";
import { TypeId } from "./registry.js";
import type { AttrSubType } from "./core/attr/attr-constants.js";
import type { AttrValue, MetaData } from "./shared/meta-data.js";
import type { DataType } from "./data-type.js";
import { CHILD_RULE_WILDCARD } from "./shared/structural.js";
import { SUBTYPE_BASE } from "./shared/base-types.js";

/**
 * A UNIFIED child requirement (spec §3.1). Every constraint on a type — both its
 * structural children AND its attributes — is one of these entries in a single
 * `children` list, distinguished by `type`:
 *
 *  - an **attribute** is a `{ type: "attr", … }` entry. Its `subType` is the
 *    attr's value-type (a single subtype — never a list), `max` is always 1
 *    (single-valued; a list-valued attr sets `isArray: true`), and it carries the
 *    attr-only facets `default` / `allowedValues` / `isArray`.
 *  - a **structural child** (`field`/`identity`/`source`/`validator`/…) carries
 *    full cardinality (`min`/`max`, `max: null` = unbounded) and may admit any of
 *    several subtypes via a `subType` list.
 *
 * `type` / `subType` / `name` accept the `"*"` wildcard.
 */
export interface ChildDef {
  /** Child type, or `"*"` for any. For attrs this is the literal `"attr"`. */
  type: string;
  /**
   * Child subtype: a single subtype, a list of admitted subtypes, or `"*"`.
   * For an `attr` entry this is the attr's value-type and MUST be a single
   * subtype (a list is invalid for attrs). Optional on an `attr` entry: an
   * omitted `subType` declares a polymorphic/untyped attr (e.g. `@default`,
   * whose value-type follows the owning field's subtype). A structural child
   * always supplies a `subType` (or `"*"`).
   */
  subType?: string | readonly string[];
  /** Child name, or `"*"` for any. */
  name: string;
  /** Cardinality lower bound. An attr is required iff `min >= 1`. */
  min: number;
  /** Cardinality upper bound; `null` = unbounded. For an attr this is 1. */
  max: number | null;
  /** Whether the child must carry an explicit name. */
  named?: boolean;
  description?: string;
  /** Prose documenting the complex rules enforced in code. */
  rules?: string;
  /** An example value/usage, shown only in the provider detail page. */
  example?: string;
  /** Guidance on when to reach for this child/attr. */
  whenToUse?: string;
  // --- attr-only facets (carried on a `type: "attr"` entry) ---
  /** Default value applied when the attr is absent. */
  default?: unknown;
  /** Closed enum of allowed values. */
  allowedValues?: readonly unknown[];
  /** Whether the attr is array-valued (the only way an attr's `max` may be > 1). */
  isArray?: boolean;
}

/**
 * A declarative type/subtype definition (spec §3). The `factory` is NOT here — it
 * is code, supplied via the `FactoryMap`. An attribute is a `type: "attr"` entry
 * inside `children`; structural children are the non-`"attr"` entries.
 */
export interface TypeDef {
  type: string;
  subType: string;
  description: string;
  dataType?: string;
  rules?: string;
  example?: string;
  whenToUse?: string;
  /** Unified children list: attrs (`type: "attr"`) + structural children. */
  children?: ChildDef[];
  /** Child-side placement: the `type.subType`s under which this type is allowed. */
  parents?: readonly string[];
  /**
   * FR-033 base-composition opt-in. When `true` (and this is a non-base subtype),
   * the subtype additively inherits its `<type>.base`'s attrs (dedup by name) and
   * childRules (dedup structurally) — letting the JSON declare per-type-universal
   * rules once on `base`. Default/absent = OFF, so a subtype that deliberately
   * declares FEWER attrs than base (e.g. `validator.required`, which wants no
   * `min`/`max`) is never silently widened. Opted in per-subtype in S1; inert (no
   * registered output change) under S0.
   */
  extendsBase?: boolean;
  /**
   * Max number of children of this `type.subType` permitted under one parent.
   * `1` marks a singleton child (e.g. `identity.primary` — one per entity). The
   * loader enforces it. A singleton is the ONLY place a static `defaultName` is
   * safe (no sibling can collide), so `defaultName` is honored only when
   * `maxOccurs === 1`. Absent = unbounded.
   */
  maxOccurs?: number;
  /**
   * Author-omittable name for a singleton child. When a node of this type is
   * declared with no `name` AND `maxOccurs === 1`, the loader assigns
   * `defaultName` (e.g. `identity.primary` → `"primary"`). Keeps the one-and-only
   * node addressable (`Entity.primary`) without forcing a hand-written name.
   */
  defaultName?: string;
}

/**
 * FR-033 S1.5 — a declarative `registry.extend` directive. A **concern** provider
 * (db / ui / prompt) does NOT register new `type.subType`s; it ADDS attrs to types
 * an upstream provider (core) already registered. This entry is the data form of a
 * `registry.extend(type, sub, { attributes })` call: `subType` selects the target
 * subtype(s) and `children` are the `type: "attr"` entries (→ `AttrSchema`) to add.
 */
export interface ExtendDef {
  /** Target type whose subtype(s) are extended (e.g. `"field"`, `"source"`). */
  type: string;
  /**
   * Target subtype(s): a single subtype name, a LIST of subtype names, or the
   * `"*"` wildcard (= every currently-registered subtype of `type`). Resolved at
   * apply time against the registry.
   */
  subType: string | readonly string[];
  /**
   * Attrs to add to each resolved target. Concern providers add attrs only — these
   * must all be `type: "attr"` entries (lowered via `toAttrSchema`). A structural
   * child here is rejected (concern providers do not contribute child rules).
   */
  children: ChildDef[];
}

export interface ProviderDefinition {
  /** Owning provider id (groups doc pages). */
  provider: string;
  /**
   * The provider's type definitions. ONE entry may be the **universal** `*.*`
   * entry (`type: "*", subType: "*"`): it is NOT a registered type — its named
   * `attr` children are COMMON attributes (accepted on every node, registered via
   * `registry.registerCommonAttrs`). Every other entry is a real `type.subType`.
   * Optional — a concern (extends-only) provider declares no new types and may
   * omit this entirely (it carries only `extends`).
   */
  types?: TypeDef[];
  /**
   * FR-033 S1.5 — DATA-DRIVEN `registry.extend` directives. A **concern** provider
   * (db / ui / prompt) declares no new types; it reads its attrs from data and ADDS
   * them to already-registered types via these entries. Applied AFTER `types` in
   * `applyProviderDefinition`. Optional — a provider with only `types` is unaffected.
   */
  extends?: ExtendDef[];
}

/**
 * The code half of the data/code boundary: a `"<type>.<subType>"` → factory map.
 * The factory constructs the node instance; it stays code (behavior).
 */
export type FactoryMap = Record<string, (typeId: TypeId, name: string) => MetaData>;

const ATTR_CHILD_TYPE = "attr";

/** Whether a `ChildDef` declares an attribute (vs a structural child). */
function isAttrChild(child: ChildDef): boolean {
  return child.type === ATTR_CHILD_TYPE;
}

/**
 * Whether a `TypeDef` is the UNIVERSAL `*.*` entry — the carrier for COMMON
 * attributes (attrs accepted on EVERY node). It is NOT a real registered type;
 * its named `attr` children are routed to `registry.registerCommonAttrs(...)` by
 * the unified apply path. Documentation uses this; ordinary providers do not.
 */
function isUniversalEntry(t: TypeDef): boolean {
  return t.type === CHILD_RULE_WILDCARD && t.subType === CHILD_RULE_WILDCARD;
}

/**
 * Turn a declarative `ProviderDefinition` + a code-supplied factory map into the
 * `TypeDefinition`s a provider passes to `registry.register()`.
 *
 * For each real `TypeDef` (every entry EXCEPT the universal `*.*` entry, which
 * carries common attrs and is handled by `applyProviderDefinition`): look up its
 * factory (throws if missing); fan its `children` out so `type: "attr"` entries
 * become `AttrSchema`s and structural entries become `ChildRule`s; carry `parents`
 * and the optional `rules`/`example`/`whenToUse` doc fields through onto the
 * returned `TypeDefinition`.
 *
 * BASE-COMPOSITION (FR-033): a non-base subtype that opts in via
 * `extendsBase: true` additively inherits its `<type>.base`'s `attributes` (dedup
 * by name) and `childRules` (dedup structurally) — letting a JSON declare
 * universal-per-type rules once on `base`. Purely additive (a subtype's own
 * declarations win on a name/shape collision). OFF by default so a subtype that
 * deliberately declares fewer attrs than base is never widened — inert under S0
 * (no provider opts in yet), the rail S1 will use.
 *
 * Builder-local validation (cheap, structural): an attr entry must be
 * single-valued (`max === 1`) unless `isArray`; an attr entry's `subType` must be
 * a single subtype (not a list); every child must have `min >= 0` and
 * (`max === null || max >= min`).
 */
export function defineProviderFromData(
  data: ProviderDefinition,
  factories: FactoryMap,
): TypeDefinition[] {
  // Pre-compute each type's OWN lowered attrs + childRules, keyed by "type.subType",
  // so base-composition can fold a base's contributions into its subtypes. A
  // concern (extends-only) provider may omit `types` entirely.
  const realTypes = (data.types ?? []).filter((t) => !isUniversalEntry(t));
  const lowered = new Map<
    string,
    { attributes: AttrSchema[]; childRules: ChildRule[] }
  >();

  for (const t of realTypes) {
    const key = `${t.type}.${t.subType}`;
    const attributes: AttrSchema[] = [];
    const childRules: ChildRule[] = [];
    for (const child of t.children ?? []) {
      validateCardinality(data.provider, key, child);
      if (isAttrChild(child)) {
        attributes.push(toAttrSchema(data.provider, key, child));
      } else {
        childRules.push(toChildRule(child));
      }
    }
    lowered.set(key, { attributes, childRules });
  }

  return realTypes.map((t): TypeDefinition => {
    const key = `${t.type}.${t.subType}`;
    const factory = factories[key];
    if (factory === undefined) {
      throw new Error(`defineProviderFromData(${data.provider}): no factory for "${key}"`);
    }

    const self = lowered.get(key)!;
    const { attributes, childRules } = composeWithBase(t, self, lowered);

    return {
      typeId: new TypeId(t.type, t.subType),
      description: t.description,
      factory,
      childRules,
      attributes,
      ...(t.dataType !== undefined ? { dataType: t.dataType as DataType } : {}),
      ...(t.parents !== undefined ? { parents: t.parents } : {}),
      ...(t.rules !== undefined ? { rules: t.rules } : {}),
      ...(t.example !== undefined ? { example: t.example } : {}),
      ...(t.whenToUse !== undefined ? { whenToUse: t.whenToUse } : {}),
      ...(t.maxOccurs !== undefined ? { maxOccurs: t.maxOccurs } : {}),
      ...(t.defaultName !== undefined ? { defaultName: t.defaultName } : {}),
    };
  });
}

/**
 * Apply a `ProviderDefinition` to a registry via the ONE uniform path: register
 * every real `type.subType` (with base-composition) AND register the universal
 * `*.*` entry's named `attr` children as COMMON attrs. This replaces the bespoke
 * `commonAttrs` helper — documentation rides the same mechanism as every other
 * provider.
 */
export function applyProviderDefinition(
  registry: TypeRegistry,
  data: ProviderDefinition,
  factories: FactoryMap,
): void {
  for (const def of defineProviderFromData(data, factories)) {
    registry.register(def);
  }
  const commonAttrs = universalCommonAttrs(data);
  if (commonAttrs.length > 0) {
    registry.registerCommonAttrs(commonAttrs);
  }
  applyExtends(registry, data);
}

/**
 * Apply a definition's `extends` directives (FR-033 S1.5) via `registry.extend`.
 * For each directive: resolve the target subtypes (`"*"` → every registered subtype
 * of the type; a list → each named subtype; a string → that one), lower its `attr`
 * children to `AttrSchema[]`, and `registry.extend(type, sub, { attributes })`.
 * Concern providers contribute attrs only — a non-`attr` child is rejected.
 */
function applyExtends(registry: TypeRegistry, data: ProviderDefinition): void {
  for (const ext of data.extends ?? []) {
    const attributes: AttrSchema[] = [];
    for (const child of ext.children) {
      if (!isAttrChild(child)) {
        throw new Error(
          `applyProviderDefinition(${data.provider}): extends "${ext.type}" may only carry attr ` +
            `children; found a structural child "${child.type}".`,
        );
      }
      validateCardinality(data.provider, ext.type, child);
      attributes.push(toAttrSchema(data.provider, ext.type, child));
    }
    for (const subType of resolveExtendSubTypes(registry, ext)) {
      registry.extend(ext.type, subType, { attributes });
    }
  }
}

/**
 * Resolve an `ExtendDef`'s `subType` selector to concrete subtype names:
 *   - `"*"` → every currently-registered subtype of `ext.type`;
 *   - a list → each named subtype, in declared order;
 *   - a single string → that one subtype.
 */
function resolveExtendSubTypes(registry: TypeRegistry, ext: ExtendDef): readonly string[] {
  if (ext.subType === CHILD_RULE_WILDCARD) {
    return registry.allSubTypesOf(ext.type);
  }
  return Array.isArray(ext.subType) ? ext.subType : [ext.subType as string];
}

/**
 * Lower the universal `*.*` entry's named `attr` children into `AttrSchema[]` for
 * `registry.registerCommonAttrs(...)`. Returns `[]` when no `*.*` entry is present.
 * Same field mapping as `toAttrSchema`. Exported for callers that register common
 * attrs themselves; `applyProviderDefinition` is the usual door.
 */
export function universalCommonAttrs(data: ProviderDefinition): AttrSchema[] {
  const universal = (data.types ?? []).find(isUniversalEntry);
  if (universal === undefined) return [];
  const key = `${universal.type}.${universal.subType}`;
  const out: AttrSchema[] = [];
  for (const child of universal.children ?? []) {
    if (!isAttrChild(child)) {
      throw new Error(
        `applyProviderDefinition(${data.provider}): the universal "${key}" entry may only ` +
          `carry attr children (common attrs); found a structural child "${child.type}".`,
      );
    }
    validateCardinality(data.provider, key, child);
    out.push(toAttrSchema(data.provider, key, child));
  }
  return out;
}

/**
 * Fold a real `TypeDef`'s OWN lowered attrs/childRules with its `<type>.base`'s
 * (when the definition declares one and this subtype is not itself `base`).
 * Additive: own entries win on a name (attr) / structural-shape (rule) collision;
 * base entries the subtype lacks are appended. A NO-OP when there is no base in
 * THIS definition, or when the subtype already declares the full base set.
 */
function composeWithBase(
  t: TypeDef,
  self: { attributes: AttrSchema[]; childRules: ChildRule[] },
  lowered: Map<string, { attributes: AttrSchema[]; childRules: ChildRule[] }>,
): { attributes: AttrSchema[]; childRules: ChildRule[] } {
  // OFF by default (S0): a subtype inherits its base only when it opts in via
  // `extendsBase: true`. Keeps the current canonical byte-identical — no provider
  // sets it yet — while the rail is in place for S1.
  if (t.extendsBase !== true) return self;
  if (t.subType === SUBTYPE_BASE) return self;
  const base = lowered.get(`${t.type}.${SUBTYPE_BASE}`);
  if (base === undefined) return self;

  const attributes = [...self.attributes];
  const haveAttr = new Set(attributes.map((a) => a.name));
  for (const baseAttr of base.attributes) {
    if (!haveAttr.has(baseAttr.name)) {
      attributes.push(baseAttr);
      haveAttr.add(baseAttr.name);
    }
  }

  const childRules = [...self.childRules];
  const haveRule = new Set(childRules.map(childRuleId));
  for (const baseRule of base.childRules) {
    const id = childRuleId(baseRule);
    if (!haveRule.has(id)) {
      childRules.push(baseRule);
      haveRule.add(id);
    }
  }

  return { attributes, childRules };
}

/** A stable structural identity for a ChildRule (base-composition dedup). */
function childRuleId(rule: ChildRule): string {
  const sub =
    typeof rule.childSubType === "string"
      ? rule.childSubType
      : [...rule.childSubType].sort().join("|");
  return [
    rule.childType,
    sub,
    rule.childName,
    rule.min ?? "",
    rule.max === null ? "null" : (rule.max ?? ""),
    rule.named ?? "",
  ].join(" ");
}

/** Validate the min/max axis (and attr single-valuedness) for one child entry. */
function validateCardinality(provider: string, typeKey: string, child: ChildDef): void {
  if (child.min < 0) {
    throw new Error(
      `defineProviderFromData(${provider}): child "${child.name}" on "${typeKey}" has min ${child.min} < 0.`,
    );
  }
  if (child.max !== null && child.max < child.min) {
    throw new Error(
      `defineProviderFromData(${provider}): child "${child.name}" on "${typeKey}" has max ${child.max} < min ${child.min}.`,
    );
  }
  if (isAttrChild(child) && child.max !== 1 && child.isArray !== true) {
    throw new Error(
      `defineProviderFromData(${provider}): attr "${child.name}" on "${typeKey}" is single-valued ` +
        `(max must be 1; a list-valued attr sets isArray: true).`,
    );
  }
}

/** An `type: "attr"` child entry IS an `AttrSchema`. */
function toAttrSchema(provider: string, typeKey: string, child: ChildDef): AttrSchema {
  if (Array.isArray(child.subType)) {
    throw new Error(
      `defineProviderFromData(${provider}): attr "${child.name}" on "${typeKey}" declares a list subType ` +
        `— an attr's value-type is a single subtype.`,
    );
  }
  return {
    name: child.name,
    ...(child.subType !== undefined ? { valueType: child.subType as AttrSubType } : {}),
    ...(child.isArray !== undefined ? { isArray: child.isArray } : {}),
    required: child.min >= 1,
    ...(child.default !== undefined ? { default: child.default as AttrValue } : {}),
    ...(child.allowedValues !== undefined
      ? { allowedValues: child.allowedValues as readonly AttrValue[] }
      : {}),
    description: child.description ?? "",
    ...(child.rules !== undefined ? { rules: child.rules } : {}),
    ...(child.example !== undefined ? { example: child.example } : {}),
    ...(child.whenToUse !== undefined ? { whenToUse: child.whenToUse } : {}),
  };
}

/** A structural (`type !== "attr"`) child entry IS a `ChildRule`. */
function toChildRule(child: ChildDef): ChildRule {
  return {
    childType: child.type,
    // A structural child always supplies a subType; default to the `"*"`
    // wildcard if (unusually) omitted, so the rule stays well-formed.
    childSubType: child.subType ?? CHILD_RULE_WILDCARD,
    childName: child.name,
    min: child.min,
    max: child.max,
    ...(child.named !== undefined ? { named: child.named } : {}),
  };
}
