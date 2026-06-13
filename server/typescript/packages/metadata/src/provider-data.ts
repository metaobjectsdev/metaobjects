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

import type { AttrSchema, ChildRule, TypeDefinition } from "./registry.js";
import { TypeId } from "./registry.js";
import type { AttrSubType } from "./core/attr/attr-constants.js";
import type { AttrValue, MetaData } from "./shared/meta-data.js";
import type { DataType } from "./data-type.js";

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
   * subtype (a list is invalid for attrs).
   */
  subType: string | readonly string[];
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
 * A declarative attribute definition (spec §3). Mirrors the data facets of
 * `AttrSchema`. Authored inside a `TypeDef.children` list as a `type: "attr"`
 * `ChildDef`; this standalone shape is exported for callers that build attr data
 * directly.
 */
export interface AttrDef {
  name: string;
  /** The attr's value-type (a registered attr subtype). */
  subType?: string;
  isArray?: boolean;
  required: boolean;
  default?: unknown;
  allowedValues?: readonly unknown[];
  description: string;
  rules?: string;
  example?: string;
  whenToUse?: string;
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
}

export interface ProviderDefinition {
  /** Owning provider id (groups doc pages). */
  provider: string;
  types: TypeDef[];
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
 * Turn a declarative `ProviderDefinition` + a code-supplied factory map into the
 * `TypeDefinition`s a provider passes to `registry.register()`.
 *
 * For each `TypeDef`: look up its factory (throws if missing); fan its `children`
 * out so `type: "attr"` entries become `AttrSchema`s and structural entries
 * become `ChildRule`s; carry `parents` and the optional `rules`/`example`/
 * `whenToUse` doc fields through onto the returned `TypeDefinition`.
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
  return data.types.map((t): TypeDefinition => {
    const key = `${t.type}.${t.subType}`;
    const factory = factories[key];
    if (factory === undefined) {
      throw new Error(`defineProviderFromData(${data.provider}): no factory for "${key}"`);
    }

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
    };
  });
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
    childSubType: child.subType,
    childName: child.name,
    min: child.min,
    max: child.max,
    ...(child.named !== undefined ? { named: child.named } : {}),
  };
}
