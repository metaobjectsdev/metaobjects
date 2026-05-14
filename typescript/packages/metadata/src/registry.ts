import type { MetaModel } from "./model.js";
import { CHILD_RULE_WILDCARD } from "./constants.js";

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

export interface TypeDefinition {
  typeId: TypeId;
  description: string;
  factory: (typeId: TypeId, name: string) => MetaModel;
  childRules: ChildRule[];
}

export class TypeRegistry {
  /** Keyed by `"type.subType"`. */
  private readonly _defs = new Map<string, TypeDefinition>();

  /** Per-type insertion-ordered subtype lists. */
  private readonly _subTypes = new Map<string, string[]>();

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
