// SP-G Registry Conformance — the TS reference emitter.
//
// Walks an assembled core TypeRegistry and serializes the LOGICAL metamodel
// vocabulary as a canonical, fully-sorted, byte-stable JSON manifest. This is
// the single-source contract the other four ports (C#, Java, Kotlin, Python)
// must byte-match — a structural gate against the SP-C class of silent
// vocabulary drift (a port's registry diverging — wrong attr names, missing
// subtypes, different required-ness — with every behavioral corpus still green).
//
// The IN/OUT boundary (the v1 logical subset emittable byte-identically by all
// five ports) is documented in fixtures/registry-conformance/README.md. In
// short: type.subType + attrs[{name, valueType, required}] + commonAttrs +
// defaultSubTypes. EXCLUDED from v1 (per-port-physical or not-universally-
// tracked-on-the-registry): factories/native bindings; AttrSchema.default and
// allowedValues (Java's attr model — ChildRequirement — carries neither);
// inheritsFrom (only Java tracks a declared parent on the registry); childRules
// (Java conflates attrs + child-type rules + placement/validation constraints
// in one ChildRequirement list — mapping is non-trivial; deferred to a
// follow-on rather than guessed).

import type { AttrSchema, TypeRegistry } from "./registry.js";

/** One attribute in the manifest — the logical, cross-port-identical facet. */
interface ManifestAttr {
  name: string;
  /** The attr's value-type subtype, or null for a polymorphic/untyped attr (e.g. @default). */
  valueType: string | null;
  required: boolean;
}

/** One registered (type, subType) in the manifest, with its declared attrs. */
interface ManifestType {
  type: string;
  subType: string;
  attrs: ManifestAttr[];
}

/** The full canonical manifest. All collections are sorted for byte-stability. */
interface RegistryManifest {
  types: ManifestType[];
  commonAttrs: ManifestAttr[];
  defaultSubTypes: Record<string, string>;
}

/** ASCII-string compare so the sort is locale-independent and byte-stable across ports. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Normalize one AttrSchema to the manifest's logical attr shape. */
function toManifestAttr(attr: AttrSchema): ManifestAttr {
  return {
    name: attr.name,
    // `valueType` is omitted on the AttrSchema for polymorphic/untyped attrs;
    // the manifest renders that as an explicit `null` literal.
    valueType: attr.valueType ?? null,
    required: attr.required,
  };
}

/** Sort attrs by name (ascending, ASCII). */
function sortedAttrs(attrs: readonly AttrSchema[]): ManifestAttr[] {
  return attrs
    .map(toManifestAttr)
    .sort((a, b) => compareStrings(a.name, b.name));
}

/**
 * Build the canonical registry manifest object from an assembled registry.
 *
 * The registry must already be composed (e.g. `composeRegistry(coreProviders)`)
 * so all providers — core types, db-domain attrs, common doc attrs — have run.
 */
export function buildRegistryManifest(registry: TypeRegistry): RegistryManifest {
  // Walk every registered (type, subType). `allTypes()` returns the TypeIds;
  // `attrsOf` gives each one's declared attribute schemas.
  const types: ManifestType[] = registry
    .allTypes()
    .map((typeId) => ({
      type: typeId.type,
      subType: typeId.subType,
      attrs: sortedAttrs(registry.attrsOf(typeId.type, typeId.subType)),
    }))
    // Sort by the full "type.subType" key for a stable, port-independent order.
    .sort((a, b) =>
      compareStrings(`${a.type}.${a.subType}`, `${b.type}.${b.subType}`),
    );

  const commonAttrs = sortedAttrs(registry.getCommonAttrs());

  // defaultSubTypes: rebuild with sorted keys so JSON.stringify emits a stable
  // key order. There is no public "all default subTypes" accessor, so derive
  // the candidate type names from the registered types and probe each.
  const typeNames = Array.from(new Set(types.map((t) => t.type))).sort(
    compareStrings,
  );
  const defaultSubTypes: Record<string, string> = {};
  for (const typeName of typeNames) {
    const defaultSub = registry.defaultSubTypeOf(typeName);
    if (defaultSub !== undefined) {
      defaultSubTypes[typeName] = defaultSub;
    }
  }

  return { types, commonAttrs, defaultSubTypes };
}

/**
 * Emit the canonical registry manifest as a byte-stable JSON string.
 *
 * Serialization contract — every port MUST match this exactly:
 *  - 2-space indentation (JSON.stringify(_, _, 2)).
 *  - Object keys in a fixed order: the manifest is built with `types`,
 *    `commonAttrs`, `defaultSubTypes` (and each attr with `name`, `valueType`,
 *    `required`; each type with `type`, `subType`, `attrs`); JSON.stringify
 *    preserves insertion order.
 *  - All arrays sorted: `types` by "type.subType"; each `attrs` by name;
 *    `commonAttrs` by name; `defaultSubTypes` keys sorted.
 *  - `valueType: null` literal for polymorphic/untyped attrs.
 *  - A single trailing newline (matches the repo's committed-canonical style).
 */
export function emitRegistryManifest(registry: TypeRegistry): string {
  const manifest = buildRegistryManifest(registry);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
