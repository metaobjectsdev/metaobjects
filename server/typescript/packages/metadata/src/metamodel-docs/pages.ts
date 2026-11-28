// The metamodel reference pages' data: what the shared Mustache templates
// (`templates/metamodel/`) render as `INDEX.md`, `providers.md` and one
// `types/<family>.md` per type family.
//
// These pages document the METAMODEL ITSELF (the type/subtype/attr vocabulary of the
// strict registry), not a user's entities. Every port builds the same data from two
// inputs it already holds:
//
//   • its registry vocabulary manifest (`buildRegistryManifest`, byte-matched across the
//     ports by registry-conformance): the types, their attrs, descriptions and child rules;
//   • its embedded provider definitions (the `spec/metamodel/*.json` data every port
//     vendors): which provider OWNS each type and CONTRIBUTES each attr, and each attr's
//     default. The manifest is provider-blind by design (ADR-0050), so this is the only
//     place that fact lives.
//
// Plus the providers' one-line descriptions. The builder makes every decision (sorting,
// table cells, joined lists, links); a template only lays the lines out. The data is
// pinned by `fixtures/metamodel-docs/data/` and the pages by `fixtures/metamodel-docs/expected/`.
// Everything is sorted by code unit, so the output is byte-stable across runs and ports.

import type { ChildDef, ProviderDefinition, TypeDef } from "../provider-data.js";
import type { ManifestAttr, ManifestChild, ManifestType, RegistryManifest } from "../registry-manifest.js";
import { compareStrings } from "../registry-manifest.js";
import { CHILD_RULE_WILDCARD } from "../shared/structural.js";
import { SUBTYPE_BASE } from "../shared/base-types.js";

/** The shared template of `INDEX.md`. */
export const METAMODEL_INDEX_PAGE_REF = "metamodel/index.md";
/** The shared template of `providers.md`. */
export const METAMODEL_PROVIDERS_PAGE_REF = "metamodel/providers.md";
/** The shared template of each `types/<family>.md`. */
export const METAMODEL_TYPE_PAGE_REF = "metamodel/type-page.md";

/** One page to render: its output path (relative), its template ref and the template's data. */
export interface MetamodelDocsPage {
  path: string;
  template: string;
  data: Record<string, unknown>;
}

const ATTR_CHILD_TYPE = "attr";
const NO_VALUE = "—";

/** Escape a markdown table cell: collapse newlines, escape pipes. */
function cell(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/** The anchor GitHub assigns to a `### field.currency` heading: `fieldcurrency`. */
function anchor(type: string, subType: string): string {
  return `${type}${subType}`.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** A value (a default, an allowed value) as an inline-code token; nothing for no value. */
function valueToken(v: unknown): string {
  if (v === null || v === undefined) return "";
  return `\`${String(v)}\``;
}

/** `` `a`, `b` `` — each item in code, comma-joined. */
function codeList(items: readonly string[], prefix = ""): string {
  return items.map((i) => `\`${prefix}${i}\``).join(", ");
}

/** The scalar value-type + array suffix the docs show for an attr. */
function attrTypeLabel(attr: ManifestAttr): string {
  const scalar = attr.valueType ?? "any";
  return attr.isArray ? `${scalar}[]` : scalar;
}

/** The childSubType label: a single subtype, a `*`, or a comma-joined list. */
function childSubTypeLabel(childSubType: string | readonly string[]): string {
  return typeof childSubType === "string" ? childSubType : childSubType.join(", ");
}

/** One structural child rule as its list line: `` `field.*` — 0..* ``. */
function childLine(rule: ManifestChild): string {
  const nameSuffix = rule.childName === CHILD_RULE_WILDCARD ? "" : ` (name \`${rule.childName}\`)`;
  const min = rule.min ?? 0;
  const max = rule.max === null || rule.max === undefined ? "*" : String(rule.max);
  return `\`${rule.childType}.${childSubTypeLabel(rule.childSubType)}\`${nameSuffix} — ${min}..${max}`;
}

function isUniversal(t: TypeDef): boolean {
  return t.type === CHILD_RULE_WILDCARD && t.subType === CHILD_RULE_WILDCARD;
}

function isAttrChild(c: ChildDef): boolean {
  return c.type === ATTR_CHILD_TYPE;
}

/** What the provider definitions say about one attr on one `type.subType`. */
interface AttrProvenance {
  provider: string;
  default?: unknown;
}

/** The provenance lens: who owns each type, who contributes each attr, per provider. */
interface Provenance {
  ownerOfType: Map<string, string>;
  attrs: Map<string, AttrProvenance>;
  providerIds: string[];
  owned: Map<string, Set<string>>;
  contributed: Map<string, Map<string, Set<string>>>;
  common: Map<string, Set<string>>;
}

/**
 * Walk the provider definitions. A definition's non-universal `types[]` are the
 * `type.subType`s it OWNS, with their inline attrs; its `extends[]` are attrs it contributes
 * to types another provider owns (`"*"` resolves to every subtype the manifest lists for
 * that type); its universal `*.*` entry's attrs are COMMON attrs. The first declarer of an
 * attr on a type wins. "Owns" lists only the types the manifest covers, so all three page
 * kinds describe one vocabulary.
 */
function buildProvenance(
  manifest: RegistryManifest,
  definitions: readonly ProviderDefinition[],
): Provenance {
  const covered = new Set(manifest.types.map((t) => `${t.type}.${t.subType}`));
  const subTypesOf = new Map<string, string[]>();
  for (const t of manifest.types) {
    if (!subTypesOf.has(t.type)) subTypesOf.set(t.type, []);
    subTypesOf.get(t.type)!.push(t.subType);
  }

  const p: Provenance = {
    ownerOfType: new Map(),
    attrs: new Map(),
    providerIds: [],
    owned: new Map(),
    contributed: new Map(),
    common: new Map(),
  };
  const ids = new Set<string>();

  const record = (id: string, type: string, subType: string, c: ChildDef): void => {
    const key = `${type}.${subType}.${c.name}`;
    if (!p.attrs.has(key)) {
      p.attrs.set(key, c.default === undefined ? { provider: id } : { provider: id, default: c.default });
    }
    const byType = p.contributed.get(id)!;
    const tk = `${type}.${subType}`;
    if (!byType.has(tk)) byType.set(tk, new Set());
    byType.get(tk)!.add(c.name);
  };

  for (const def of definitions) {
    const id = def.provider;
    if (!ids.has(id)) {
      ids.add(id);
      p.owned.set(id, new Set());
      p.contributed.set(id, new Map());
      p.common.set(id, new Set());
    }
    for (const t of def.types ?? []) {
      if (isUniversal(t)) {
        for (const c of t.children ?? []) if (isAttrChild(c)) p.common.get(id)!.add(c.name);
        continue;
      }
      const tk = `${t.type}.${t.subType}`;
      if (!p.ownerOfType.has(tk)) p.ownerOfType.set(tk, id);
      if (covered.has(tk)) p.owned.get(id)!.add(tk);
      for (const c of t.children ?? []) if (isAttrChild(c)) record(id, t.type, t.subType, c);
    }
    for (const ext of def.extends ?? []) {
      const subTypes =
        ext.subType === CHILD_RULE_WILDCARD
          ? (subTypesOf.get(ext.type) ?? [])
          : typeof ext.subType === "string"
            ? [ext.subType]
            : ext.subType;
      for (const subType of subTypes) {
        for (const c of ext.children) if (isAttrChild(c)) record(id, ext.type, subType, c);
      }
    }
  }
  p.providerIds = [...ids].sort(compareStrings);
  return p;
}

/** `INDEX.md`: every `type.subType`, its one-line description and its page link. */
function indexData(types: readonly ManifestType[]): Record<string, unknown> {
  return {
    rows: types.map((t) => ({
      typeSubType: `${t.type}.${t.subType}`,
      description: cell(t.description),
      page: `types/${t.type}.md#${anchor(t.type, t.subType)}`,
    })),
  };
}

/** `providers.md`: each provider, what it owns and what it contributes. */
function providersData(
  p: Provenance,
  descriptions: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const sorted = (s: ReadonlySet<string>): string[] => [...s].sort(compareStrings);
  return {
    providers: p.providerIds.map((id) => {
      const description = descriptions.get(id);
      const owned = sorted(p.owned.get(id)!);
      const common = sorted(p.common.get(id)!);
      const contributed = [...p.contributed.get(id)!.entries()]
        .sort(([a], [b]) => compareStrings(a, b))
        .map(([typeSubType, attrs]) => ({ typeSubType, attrs: codeList(sorted(attrs), "@") }));
      return {
        id,
        hasDescription: description !== undefined,
        ...(description !== undefined ? { description } : {}),
        hasOwns: owned.length > 0,
        ...(owned.length > 0 ? { owns: codeList(owned) } : {}),
        hasUniversal: common.length > 0,
        ...(common.length > 0 ? { universal: codeList(common, "@") } : {}),
        hasContributes: contributed.length > 0,
        contributes: contributed,
      };
    }),
  };
}

/** One `### type.subType` section of a type page. */
function sectionData(
  t: ManifestType,
  p: Provenance,
  commonAttrNames: ReadonlySet<string>,
): Record<string, unknown> {
  const owner = p.ownerOfType.get(`${t.type}.${t.subType}`);
  // An attr inherited from `<type>.base` (`extendsBase`) is recorded against the BASE in
  // the definitions, not the concrete subtype, so fall back to the base.
  const attrs = t.attrs
    .filter((a) => !commonAttrNames.has(a.name))
    .map((a) => {
      const prov =
        p.attrs.get(`${t.type}.${t.subType}.${a.name}`) ?? p.attrs.get(`${t.type}.${SUBTYPE_BASE}.${a.name}`);
      return {
        name: a.name,
        type: attrTypeLabel(a),
        required: a.required ? "yes" : "no",
        default: valueToken(prov?.default),
        allowed: (a.allowedValues ?? []).map(valueToken).join(", "),
        provider: prov?.provider ?? NO_VALUE,
        description: cell(a.description),
      };
    });
  const children = t.children.filter((c) => c.childType !== ATTR_CHILD_TYPE).map(childLine);
  const implementedIn = t.implementedIn !== undefined ? [...t.implementedIn].sort(compareStrings) : [];
  const parents = t.parents !== undefined ? [...t.parents].sort(compareStrings) : [];
  return {
    typeSubType: `${t.type}.${t.subType}`,
    description: t.description,
    hasOwner: owner !== undefined,
    ...(owner !== undefined ? { owner } : {}),
    hasImplementedIn: implementedIn.length > 0,
    ...(implementedIn.length > 0 ? { implementedIn: implementedIn.join(", ") } : {}),
    hasRules: t.rules !== undefined,
    ...(t.rules !== undefined ? { rules: t.rules } : {}),
    hasWhenToUse: t.whenToUse !== undefined,
    ...(t.whenToUse !== undefined ? { whenToUse: t.whenToUse } : {}),
    hasExample: t.example !== undefined,
    ...(t.example !== undefined ? { example: t.example } : {}),
    hasAttrs: attrs.length > 0,
    attrs,
    hasChildren: children.length > 0,
    children,
    hasParents: parents.length > 0,
    ...(parents.length > 0 ? { parents: codeList(parents) } : {}),
  };
}

/**
 * Every metamodel reference page, in output order: `INDEX.md`, `providers.md`, then one
 * `types/<family>.md` per type family, sorted. The manifest's types are already sorted by
 * `type.subType`; documentation (common) attrs are left off the type pages and listed once
 * on the providers page.
 */
export function buildMetamodelDocsPages(
  manifest: RegistryManifest,
  definitions: readonly ProviderDefinition[],
  providerDescriptions: ReadonlyMap<string, string>,
): MetamodelDocsPage[] {
  const p = buildProvenance(manifest, definitions);
  const commonAttrNames = new Set(manifest.commonAttrs.map((a) => a.name));
  const pages: MetamodelDocsPage[] = [
    { path: "INDEX.md", template: METAMODEL_INDEX_PAGE_REF, data: indexData(manifest.types) },
    {
      path: "providers.md",
      template: METAMODEL_PROVIDERS_PAGE_REF,
      data: providersData(p, providerDescriptions),
    },
  ];
  const byFamily = new Map<string, ManifestType[]>();
  for (const t of manifest.types) {
    if (!byFamily.has(t.type)) byFamily.set(t.type, []);
    byFamily.get(t.type)!.push(t);
  }
  for (const family of [...byFamily.keys()].sort(compareStrings)) {
    pages.push({
      path: `types/${family}.md`,
      template: METAMODEL_TYPE_PAGE_REF,
      data: {
        family,
        sections: byFamily.get(family)!.map((t) => sectionData(t, p, commonAttrNames)),
      },
    });
  }
  return pages;
}
