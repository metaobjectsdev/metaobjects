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
import { ATTR_SUBTYPE_STRING, ATTR_SUBTYPE_STRINGARRAY } from "./core/attr/attr-constants.js";
import {
  EXCLUDED_PER_TYPE_ATTR_NAMES,
  isExcludedTypeSubType,
} from "./registry-manifest-exclusions.js";

/** One attribute in the manifest — the logical, cross-port-identical facet. */
interface ManifestAttr {
  name: string;
  /** The attr's SCALAR value-type subtype, or null for a polymorphic/untyped attr (e.g. @default). */
  valueType: string | null;
  /** True for an array-valued attr (a list of the scalar `valueType`); the orthogonal array axis. */
  isArray: boolean;
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

/**
 * Normalize one AttrSchema to the manifest's logical attr shape — decomposing
 * array-ness into a scalar `valueType` + an orthogonal `isArray` flag.
 *
 * An attr is array-valued when its schema sets `isArray: true` (the cross-port
 * model). For resilience, a legacy `valueType: "stringarray"` token is also
 * decomposed to `{ valueType: "string", isArray: true }` — so no `stringarray`
 * token ever reaches the manifest. A polymorphic attr (no valueType) is `null` +
 * non-array.
 */
function toManifestAttr(attr: AttrSchema): ManifestAttr {
  const isLegacyStringArray = attr.valueType === ATTR_SUBTYPE_STRINGARRAY;
  const isArray = attr.isArray === true || isLegacyStringArray;
  // The scalar value-type: a legacy stringarray token collapses to "string";
  // otherwise the declared valueType (omitted → null for polymorphic attrs).
  const valueType = isLegacyStringArray
    ? ATTR_SUBTYPE_STRING
    : (attr.valueType ?? null);
  return {
    name: attr.name,
    valueType,
    isArray,
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
 * Sort PER-TYPE attrs, filtering out the excluded per-type attr names
 * (structural keywords `isArray`/`isAbstract` + the `description` commonAttr —
 * see registry-manifest-exclusions). The filter is a no-op for TS (which never
 * registers them as per-type attrs); it is applied uniformly so the cross-port
 * contract is explicit. NOTE: `description` is filtered ONLY here — it remains
 * in the `commonAttrs` block (built via `sortedAttrs`, unfiltered).
 */
function sortedPerTypeAttrs(attrs: readonly AttrSchema[]): ManifestAttr[] {
  return sortedAttrs(attrs.filter((a) => !EXCLUDED_PER_TYPE_ATTR_NAMES.has(a.name)));
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
    // Skip excluded (type, subType) rows: the `metadata.base` inheritance
    // anchor (C-5) + the generic TS-presentation `view.*` controls (B-2).
    .filter((typeId) => !isExcludedTypeSubType(typeId.type, typeId.subType))
    .map((typeId) => ({
      type: typeId.type,
      subType: typeId.subType,
      attrs: sortedPerTypeAttrs(registry.attrsOf(typeId.type, typeId.subType)),
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
 *    `isArray`, `required`; each type with `type`, `subType`, `attrs`);
 *    JSON.stringify preserves insertion order.
 *  - All arrays sorted: `types` by "type.subType"; each `attrs` by name;
 *    `commonAttrs` by name; `defaultSubTypes` keys sorted.
 *  - `valueType: null` literal for polymorphic/untyped attrs.
 *  - A single trailing newline (matches the repo's committed-canonical style).
 */
export function emitRegistryManifest(registry: TypeRegistry): string {
  const manifest = buildRegistryManifest(registry);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
