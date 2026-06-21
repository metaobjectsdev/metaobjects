import type { AttrValue, MetaData } from "./shared/meta-data.js";
import { SUBTYPE_BASE, TYPE_ATTR } from "./shared/base-types.js";
import { CHILD_RULE_WILDCARD } from "./shared/structural.js";
import { type AttrSubType } from "./core/attr/attr-constants.js";
import type { DataType } from "./data-type.js";
import type { ReferenceDescriptor, NodeValidator } from "./validation-types.js";
import { MetaModelError } from "./errors.js";

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
  /**
   * `"*"` matches any subtype. A list (FR-033) admits any one of several
   * subtypes (e.g. a `source` child may be `["rdb", "view"]`).
   */
  childSubType: string | readonly string[];
  /** `"*"` matches any name. */
  childName: string;
  /**
   * FR-033 — cardinality lower bound. A required child has `min >= 1`. Optional
   * on the interface for back-compat with rules authored before FR-033.
   */
  min?: number;
  /**
   * FR-033 — cardinality upper bound; `null` means unbounded (0..∞). Optional
   * for back-compat.
   */
  max?: number | null;
  /** FR-033 — whether the child must carry an explicit name. */
  named?: boolean;
}

export interface AttrSchema {
  /** Attribute name WITHOUT the "@" prefix (e.g. "dbColumn", "currency"). */
  name: string;
  /**
   * The attribute's value type — one of the registered attr subtypes.
   *
   * Optional: when absent, the attr is declared-but-untyped (no parse-time
   * coercion; value stored raw via `toAttrValue`). Use this for polymorphic
   * attrs whose value type is determined by the owning node at consumption
   * time (e.g. `@default`, which is typed by its owning field's subtype).
   *
   * `SUBTYPE_BASE` ("base") MUST NOT be used here — it is the universal root
   * subtype for object/field/etc. nodes and carries no "untyped" semantics for
   * attrs. Attempting to register an AttrSchema with `valueType: "base"` throws.
   */
  valueType?: AttrSubType;
  /**
   * Whether this attribute is array-valued (a list of the scalar `valueType`).
   *
   * Array-ness is a single orthogonal axis — a `string` attr with `isArray: true`
   * is what was formerly the `stringarray` subtype. The loader coerces an
   * array-flagged attr through the array string-attr coercion (bare-string →
   * one-element array). Mirrors Java's `StringAttribute + @isArray` model.
   * Absent/false = scalar.
   */
  isArray?: boolean;
  /** Whether this attribute must be present on the node. */
  required: boolean;
  /** Default value applied when the attribute is absent. Optional. */
  default?: AttrValue;
  /** When set, the attribute's value must be one of these (a closed enum). Optional. */
  allowedValues?: readonly AttrValue[];
  /** Human/AI-facing description of what the attribute means. */
  description: string;
  /** FR-033 — prose documenting the complex rules enforced in code. Optional. */
  rules?: string;
  /** FR-033 — an example value, shown only in the provider detail page. Optional. */
  example?: string;
  /** FR-033 — guidance on when to reach for this attribute. Optional. */
  whenToUse?: string;
}

export interface TypeDefinition {
  typeId: TypeId;
  description: string;
  factory: (typeId: TypeId, name: string) => MetaData;
  childRules: ChildRule[];
  attributes: AttrSchema[];
  /** The coarse value-type classification, for (type, subType)s whose nodes
   *  carry a typed value (field, attr). Absent for non-value-bearing types. */
  dataType?: DataType;
  /**
   * FR-033 — the child-side placement claim: the `type.subType`s under which a
   * node of this type is allowed. Additive (an extension provider names a parent
   * without editing the parent's definition). Optional.
   */
  parents?: readonly string[];
  /** FR-033 — prose documenting the complex rules enforced in code. Optional. */
  rules?: string;
  /** FR-033 — an example, shown only in the provider detail page. Optional. */
  example?: string;
  /** FR-033 — guidance on when to reach for this type/subType. Optional. */
  whenToUse?: string;
  /** Max children of this type.subType per parent (`1` = singleton). Loader-enforced. */
  maxOccurs?: number;
  /** Default name for a singleton (`maxOccurs===1`) child declared with no name. */
  defaultName?: string;
  /**
   * Cross-references this node's attrs declare — resolved generically against the symbol
   * table (a dangling/kind-mismatched target fails the load). Carried by the type's
   * registration, so a downstream provider's references validate with no core changes.
   */
  references?: ReferenceDescriptor[];
  /**
   * The type's imperative validator (logic config can't express). Invoked by the recursive
   * validation walk. Owned by the provider that owns the type.
   */
  validate?: NodeValidator;
}

export class TypeRegistry {
  /** Keyed by `"type.subType"`. */
  private readonly _defs = new Map<string, TypeDefinition>();

  /** Per-type insertion-ordered subtype lists. */
  private readonly _subTypes = new Map<string, string[]>();

  /** Per-type designated default subType (queried by the YAML desugar). */
  private readonly _defaultSubTypes = new Map<string, string>();

  /** Attrs accepted on every metatype (declared by providers). */
  private readonly _commonAttrs: AttrSchema[] = [];

  /**
   * ADR-0023 Decision 2 — sealed state. Once sealed, every mutating registration
   * method (`register`/`setDefaultSubType`/`registerCommonAttrs`/`extend`) throws
   * `ERR_REGISTRY_SEALED`. The library seals its composed registry after the agreed
   * metamodel providers bootstrap, so nothing can register made-up metamodel
   * attributes post-bootstrap. A downstream app composes its own (unsealed) registry.
   */
  private _sealed = false;

  /** Seal the registry: every subsequent mutating registration throws
   *  `ERR_REGISTRY_SEALED`. Idempotent. Reads are unaffected. */
  seal(): void {
    this._sealed = true;
  }

  /** Whether this registry has been sealed (ADR-0023). */
  isSealed(): boolean {
    return this._sealed;
  }

  /** Guard at the top of every mutating registration method. */
  private checkNotSealed(operation: string): void {
    if (this._sealed) {
      throw new MetaModelError(
        `TypeRegistry is sealed (ADR-0023): ${operation} is not permitted after metamodel ` +
        `bootstrap. Made-up metamodel attributes/types are structurally disallowed — a new ` +
        `metamodel attribute requires a registered provider + human agreement. Downstream apps ` +
        `that need extra vocabulary must compose their own (unsealed) registry.`,
        { code: "ERR_REGISTRY_SEALED" },
      );
    }
  }

  register(def: TypeDefinition): void {
    this.checkNotSealed(`register("${def.typeId.toString()}")`);
    const key = def.typeId.toString();
    if (this._defs.has(key)) {
      throw new Error(
        `TypeRegistry: duplicate registration for "${key}" (type="${def.typeId.type}", subType="${def.typeId.subType}")`,
      );
    }

    // Reject SUBTYPE_BASE as an attr valueType. "base" is the universal root
    // subtype for object/field/etc. nodes; it must NOT be used as an attr value
    // type because it carries no meaningful type semantics for attrs (its DataType
    // resolves to DATA_TYPE_STRING, silently coercing boolean/number defaults to
    // strings). Polymorphic attrs (e.g. @default) must omit valueType instead.
    for (const attr of def.attributes) {
      if (attr.valueType === SUBTYPE_BASE) {
        throw new Error(
          `TypeRegistry.register: attr "${attr.name}" on "${key}" declares valueType "${SUBTYPE_BASE}", ` +
          `which is not valid for attrs. Use no valueType (omit the field) for a polymorphic/untyped attr.`,
        );
      }
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
    this.checkNotSealed(`setDefaultSubType("${type}")`);
    this._defaultSubTypes.set(type, subType);
  }

  /** The designated default subType for a type, or undefined if none was designated. */
  defaultSubTypeOf(type: string): string | undefined {
    return this._defaultSubTypes.get(type);
  }

  /** The declared attribute schema for a (type, subType), or [] if the
   *  pair is unregistered or declares no attributes. */
  attrsOf(type: string, subType: string): AttrSchema[] {
    return [...(this.find(type, subType)?.attributes ?? [])];
  }

  /**
   * Register attrs that are accepted on every metatype. Callers (providers) use
   * this to declare cross-cutting attrs (e.g. doc attrs). Repeated registration
   * of the same name is silently deduped (first registration wins); conflicts with
   * per-type attrs are resolved at validation time (Task 1.3).
   */
  registerCommonAttrs(attrs: AttrSchema[]): void {
    this.checkNotSealed("registerCommonAttrs");
    for (const attr of attrs) {
      if (attr.valueType === SUBTYPE_BASE) {
        throw new Error(
          `TypeRegistry.registerCommonAttrs: attr "${attr.name}" declares valueType "${SUBTYPE_BASE}", ` +
          `which is not valid for attrs. Use no valueType (omit the field) for a polymorphic/untyped attr.`,
        );
      }
      if (this._commonAttrs.some((existing) => existing.name === attr.name)) {
        continue; // dedupe same-name re-registration; conflict-with-per-type-attr is checked at validation time
      }
      this._commonAttrs.push(attr);
    }
  }

  /** Returns the registered common attrs (attrs accepted on every metatype).
   *  Returns a defensive copy so callers cannot mutate internal state, matching
   *  the spread-copy pattern used by `attrsOf` and `allSubTypesOf`. */
  getCommonAttrs(): readonly AttrSchema[] {
    return [...this._commonAttrs];
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
    this.checkNotSealed(`extend("${type}.${subType}")`);
    const def = this.find(type, subType);
    if (def === undefined) {
      throw new Error(
        `TypeRegistry.extend: no registered type "${type}.${subType}" to extend`,
      );
    }
    for (const attr of ext.attributes ?? []) {
      if (attr.valueType === SUBTYPE_BASE) {
        throw new Error(
          `TypeRegistry.extend: attr "${attr.name}" being added to "${type}.${subType}" declares valueType "${SUBTYPE_BASE}", ` +
          `which is not valid for attrs. Use no valueType (omit the field) for a polymorphic/untyped attr.`,
        );
      }
      if (def.attributes.some((a) => a.name === attr.name)) {
        throw new MetaModelError(
          `TypeRegistry.extend: attribute "${attr.name}" is already declared on "${type}.${subType}"`,
          { code: "ERR_PROVIDER_ATTR_CONFLICT" },
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
  // FR-033 — childSubType may be a wildcard, a single subtype, or a list of
  // admitted subtypes.
  const subTypeMatches =
    rule.childSubType === CHILD_RULE_WILDCARD ||
    (Array.isArray(rule.childSubType)
      ? rule.childSubType.includes(child.subType)
      : rule.childSubType === child.subType);
  return (
    (rule.childType === CHILD_RULE_WILDCARD || rule.childType === child.type) &&
    subTypeMatches &&
    (rule.childName === CHILD_RULE_WILDCARD || rule.childName === child.name)
  );
}
