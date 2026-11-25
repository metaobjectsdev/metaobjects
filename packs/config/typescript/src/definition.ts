/**
 * Register a pack's vocabulary definition (the spec/metamodel/*.json format, ADR-0069's
 * `metamodel/*.json`) through the public provider contract: `registry.register` for each
 * type the pack owns, `registry.extend` for each rule it adds to a type it does not.
 *
 * Core lowers its own bundled definitions the same way (provider-data.ts) but does not
 * export that path, and a pack may lean only on what core's package version promises
 * (ADR-0069 §5). `definition.test.ts` holds this lowering to core's: the two give the
 * same registry manifest for this pack's file.
 */
import { TypeId, type AttrSchema, type ChildRule, type MetaData, type TypeRegistry } from "@metaobjectsdev/metadata";

type AttrValue = NonNullable<AttrSchema["default"]>;
type ValueType = NonNullable<AttrSchema["valueType"]>;

/** One `children` entry: an attribute when `type` is `"attr"`, otherwise a child rule. */
export interface PackChildDef {
  readonly type: string;
  readonly subType?: string | readonly string[];
  readonly name: string;
  readonly min: number;
  readonly max: number | null;
  readonly named?: boolean;
  readonly description?: string;
  readonly default?: unknown;
  readonly allowedValues?: readonly unknown[];
  readonly isArray?: boolean;
}

export interface PackTypeDef {
  readonly type: string;
  readonly subType: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly children: readonly PackChildDef[];
}

export interface PackExtendDef {
  readonly type: string;
  /** A subtype, a list of them, or `"*"` for every subtype registered when the pack is composed. */
  readonly subType: string | readonly string[];
  readonly children: readonly PackChildDef[];
}

export interface PackDefinition {
  readonly provider: string;
  readonly types: readonly PackTypeDef[];
  readonly extends?: readonly PackExtendDef[];
}

export type PackFactory = (typeId: TypeId, name: string) => MetaData;

const ATTR = "attr";
const WILDCARD = "*";

function toAttr(owner: string, c: PackChildDef): AttrSchema {
  if (Array.isArray(c.subType)) throw new Error(`${owner}: attr @${c.name} declares a list subType; an attr has one value type`);
  return {
    name: c.name,
    ...(c.subType !== undefined ? { valueType: c.subType as ValueType } : {}),
    ...(c.isArray !== undefined ? { isArray: c.isArray } : {}),
    required: c.min >= 1,
    ...(c.default !== undefined ? { default: c.default as AttrValue } : {}),
    ...(c.allowedValues !== undefined ? { allowedValues: c.allowedValues as readonly AttrValue[] } : {}),
    description: c.description ?? "",
  };
}

function toRule(c: PackChildDef): ChildRule {
  return {
    childType: c.type,
    childSubType: c.subType ?? WILDCARD,
    childName: c.name,
    min: c.min,
    max: c.max,
    ...(c.named !== undefined ? { named: c.named } : {}),
  };
}

function split(owner: string, children: readonly PackChildDef[]): { attributes: AttrSchema[]; childRules: ChildRule[] } {
  const attributes: AttrSchema[] = [];
  const childRules: ChildRule[] = [];
  for (const c of children) {
    if (c.type === ATTR) attributes.push(toAttr(owner, c));
    else childRules.push(toRule(c));
  }
  return { attributes, childRules };
}

/** Register every type `def` owns, with the factory `factories` names for it, then apply its `extends`. */
export function registerDefinition(
  registry: TypeRegistry,
  def: PackDefinition,
  factories: Readonly<Record<string, PackFactory>>,
): void {
  for (const t of def.types) {
    const key = `${t.type}.${t.subType}`;
    const factory = factories[key];
    if (factory === undefined) throw new Error(`${def.provider}: no factory for ${key}`);
    registry.register({
      typeId: new TypeId(t.type, t.subType),
      description: t.description,
      ...(t.whenToUse !== undefined ? { whenToUse: t.whenToUse } : {}),
      factory,
      ...split(key, t.children),
    });
  }
  for (const ext of def.extends ?? []) {
    const owner = `${ext.type}.${Array.isArray(ext.subType) ? ext.subType.join(",") : ext.subType}`;
    const additions = split(owner, ext.children);
    const subTypes = ext.subType === WILDCARD ? registry.allSubTypesOf(ext.type) : Array.isArray(ext.subType) ? ext.subType : [ext.subType as string];
    for (const subType of subTypes) registry.extend(ext.type, subType, additions);
  }
}
