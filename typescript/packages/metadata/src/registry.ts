import type { AttrValue, MetaData } from "./meta/meta-data.js";
import { type AttrSubType, CHILD_RULE_WILDCARD } from "./constants.js";

export class TypeId {
  constructor(
    public readonly type: string,
    public readonly subType: string,
  ) {}

  toString(): string {
    return `${this.type}.${this.subType}`;
  }

  equals(other: TypeId): boolean {
    return this.type === other.type && this.subType === other.subType;
  }
}

export interface ChildRule {
  /** `"*"` matches any type. */
  childType: string;
  /** `"*"` matches any subtype. */
  childSubType: string;
  /** `"*"` matches any name. */
  childName: string;
}

export interface AttrSchema {
  /** Attribute name WITHOUT the "@" prefix (e.g. "dbColumn", "currency"). */
  name: string;
  /** The attribute's value type — one of the registered attr subtypes. */
  valueType: AttrSubType;
  /** Whether this attribute must be present on the node. */
  required: boolean;
  /** Default value applied when the attribute is absent. Optional. */
  default?: AttrValue;
  /** When set, the attribute's value must be one of these (a closed enum). Optional. */
  allowedValues?: readonly AttrValue[];
  /** Human/AI-facing description of what the attribute means. */
  description: string;
}

export interface TypeDefinition {
  typeId: TypeId;
  description: string;
  factory: (typeId: TypeId, name: string) => MetaData;
  childRules: ChildRule[];
  attributes: AttrSchema[];
}

export class TypeRegistry {
  /** Keyed by `"type.subType"`. */
  private readonly _defs = new Map<string, TypeDefinition>();

  /** Per-type insertion-ordered subtype lists. */
  private readonly _subTypes = new Map<string, string[]>();

  /** Per-type designated default subType (queried by the YAML desugar). */
  private readonly _defaultSubTypes = new Map<string, string>();

  register(def: TypeDefinition): void {
    const key = def.typeId.toString();
    if (this._defs.has(key)) {
      throw new Error(
        `TypeRegistry: duplicate registration for "${key}" (type="${def.typeId.type}", subType="${def.typeId.subType}")`,
      );
    }
    this._defs.set(key, def);

    const list = this._subTypes.get(def.typeId.type);
    if (list !== undefined) {
      list.push(def.typeId.subType);
    } else {
      this._subTypes.set(def.typeId.type, [def.typeId.subType]);
    }
  }

  find(type: string, subType: string): TypeDefinition | undefined {
    return this._defs.get(`${type}.${subType}`);
  }

  has(type: string, subType: string): boolean {
    return this.find(type, subType) !== undefined;
  }

  allTypes(): TypeId[] {
    return Array.from(this._defs.values()).map((def) => def.typeId);
  }

  allSubTypesOf(type: string): string[] {
    return [...(this._subTypes.get(type) ?? [])];
  }

  /** Designate the default subType for a bare `type` key (used by YAML authoring sugar). */
  setDefaultSubType(type: string, subType: string): void {
    this._defaultSubTypes.set(type, subType);
  }

  /** The designated default subType for a type, or undefined if none was designated. */
  defaultSubTypeOf(type: string): string | undefined {
    return this._defaultSubTypes.get(type);
  }

  /** The declared attribute schema for a (type, subType), or [] if the
   *  pair is unregistered or declares no attributes. */
  attrsOf(type: string, subType: string): AttrSchema[] {
    return this.find(type, subType)?.attributes ?? [];
  }

  /**
   * Additively enrich an already-registered (type, subType): append attributes
   * and/or child rules. Does NOT touch factory / typeId / dataType / default
   * subType — a type's identity belongs to whoever registered it. Used by
   * providers to extend types another provider defined.
   */
  extend(
    type: string,
    subType: string,
    ext: { attributes?: AttrSchema[]; childRules?: ChildRule[] },
  ): void {
    const def = this.find(type, subType);
    if (def === undefined) {
      throw new Error(
        `TypeRegistry.extend: no registered type "${type}.${subType}" to extend`,
      );
    }
    for (const attr of ext.attributes ?? []) {
      if (def.attributes.some((a) => a.name === attr.name)) {
        throw new Error(
          `TypeRegistry.extend: attribute "${attr.name}" is already declared on "${type}.${subType}"`,
        );
      }
      def.attributes.push(attr);
    }
    for (const rule of ext.childRules ?? []) {
      def.childRules.push(rule);
    }
  }
}

export function childRuleMatches(
  rule: ChildRule,
  child: { type: string; subType: string; name: string },
): boolean {
  return (
    (rule.childType === CHILD_RULE_WILDCARD || rule.childType === child.type) &&
    (rule.childSubType === CHILD_RULE_WILDCARD || rule.childSubType === child.subType) &&
    (rule.childName === CHILD_RULE_WILDCARD || rule.childName === child.name)
  );
}
