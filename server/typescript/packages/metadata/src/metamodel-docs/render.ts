// FR-033 S3 — the metamodel doc renderer (pure, deterministic, byte-stable).
//
// Documents the METAMODEL ITSELF — the type/subtype/attr vocabulary of the
// strict registry — for an LLM (and humans). This is distinct from `meta docs
// --model`, which documents a USER's entities. The output is a tiered markdown
// tree:
//
//   INDEX.md          every type.subType + one-liner + link  (always-on map)
//   types/<type>.md   per family: each subtype's full composed attrs (provider-
//                     tagged) + allowed children + cardinality + parents
//   providers.md      the 5-concern ownership index (the provider lens)
//
// Rendering is plain deterministic TS string-building: the metadata package
// owns no codegen-ts / Mustache dependency, and the output is small + fully
// structural, so a self-contained string builder is simpler and keeps the
// byte-stability contract trivially auditable. Everything is sorted by ASCII
// codepoint for cross-run / cross-port determinism.

import type { AttrSchema, ChildRule, TypeDefinition, TypeRegistry } from "../registry.js";
import type { MetamodelProvenance } from "./provenance.js";
import { isExcludedTypeSubType } from "../registry-manifest-exclusions.js";
import { ATTR_SUBTYPE_STRINGARRAY, ATTR_SUBTYPE_STRING } from "../core/attr/attr-constants.js";
import { CHILD_RULE_WILDCARD } from "../shared/structural.js";
import { SUBTYPE_BASE } from "../shared/base-types.js";

/** The regeneration command, named in every file's DO-NOT-EDIT header. */
const REGEN_COMMAND = "meta docs --metamodel";

/** ASCII codepoint compare — locale-independent, byte-stable. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The DO-NOT-EDIT header prepended to every emitted file. */
function header(what: string): string {
  return (
    `<!-- @generated — DO NOT EDIT.\n` +
    `     ${what}\n` +
    `     Regenerate with: ${REGEN_COMMAND} -->\n`
  );
}

/** Escape a markdown table cell: collapse newlines, escape pipes. */
function cell(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/** The anchor GitHub assigns to a `### field.currency` heading: `fieldcurrency`. */
function anchor(type: string, subType: string): string {
  return `${type}${subType}`.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The scalar value-type + array suffix the docs show for an attr. */
function attrTypeLabel(attr: AttrSchema): string {
  const isLegacyStringArray = attr.valueType === ATTR_SUBTYPE_STRINGARRAY;
  const isArray = attr.isArray === true || isLegacyStringArray;
  const scalar = isLegacyStringArray
    ? ATTR_SUBTYPE_STRING
    : (attr.valueType ?? "any");
  return isArray ? `${scalar}[]` : scalar;
}

/** Render one attr value (default / an allowed value) as an inline-code token. */
function valueToken(v: unknown): string {
  if (v === null || v === undefined) return "";
  return `\`${String(v)}\``;
}

/** The childSubType cell: a single subtype, a `*`, or a comma-joined list. */
function childSubTypeLabel(childSubType: string | readonly string[]): string {
  return Array.isArray(childSubType) ? childSubType.join(", ") : (childSubType as string);
}

/** A cardinality range `min..max` (`*` for unbounded / undefined upper). */
function cardinality(rule: ChildRule): string {
  const min = rule.min ?? 0;
  const max = rule.max === null || rule.max === undefined ? "*" : String(rule.max);
  return `${min}..${max}`;
}

/** Whether a child rule is a STRUCTURAL child (not an attr — attrs live in the table). */
function isStructuralChild(rule: ChildRule): boolean {
  return rule.childType !== "attr";
}

/**
 * Render the per-subtype Attributes table. Columns:
 *   Attribute | Type | Required | Default | Allowed values | Provider | Description
 * Sorted by attr name; common (universal documentation) attrs are excluded
 * (mentioned once on the providers page) to keep per-type pages lean.
 */
function attrsTable(
  def: TypeDefinition,
  provenance: MetamodelProvenance,
  commonAttrNames: ReadonlySet<string>,
): string {
  const rows = def.attributes
    .filter((a) => !commonAttrNames.has(a.name))
    .slice()
    .sort((a, b) => compare(a.name, b.name));
  if (rows.length === 0) return "_No subtype-specific attributes._\n";

  const lines: string[] = [
    "| Attribute | Type | Required | Default | Allowed values | Provider | Description |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const a of rows) {
    // Resolve the contributing provider. An attr inherited from `<type>.base`
    // (FR-033 `extendsBase`) is recorded against the BASE in the embedded data,
    // not the concrete subtype — so fall back to the base owner when the
    // subtype-specific lookup misses. (`base` itself has no further fallback.)
    const provider =
      provenance.ownerOfAttr(def.typeId.type, def.typeId.subType, a.name) ??
      provenance.ownerOfAttr(def.typeId.type, SUBTYPE_BASE, a.name) ??
      "—";
    const allowed = (a.allowedValues ?? []).map(valueToken).join(", ");
    lines.push(
      `| \`@${a.name}\` | ${attrTypeLabel(a)} | ${a.required ? "yes" : "no"} | ` +
        `${valueToken(a.default)} | ${allowed} | ${provider} | ${cell(a.description)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Render the Allowed children list (structural child rules), sorted. */
function childrenList(def: TypeDefinition): string {
  const structural = def.childRules
    .filter(isStructuralChild)
    .slice()
    .sort(
      (a, b) =>
        compare(a.childType, b.childType) ||
        compare(childSubTypeLabel(a.childSubType), childSubTypeLabel(b.childSubType)) ||
        compare(a.childName, b.childName),
    );
  if (structural.length === 0) return "_No structural children._\n";
  const lines = structural.map((r) => {
    const nameSuffix =
      r.childName === CHILD_RULE_WILDCARD ? "" : ` (name \`${r.childName}\`)`;
    return `- \`${r.childType}.${childSubTypeLabel(r.childSubType)}\`${nameSuffix} — ${cardinality(r)}`;
  });
  return `${lines.join("\n")}\n`;
}

/** Render one subtype section on a type-family page. */
function subtypeSection(
  def: TypeDefinition,
  provenance: MetamodelProvenance,
  commonAttrNames: ReadonlySet<string>,
): string {
  const { type, subType } = def.typeId;
  const owner = provenance.ownerOfType(type, subType);
  const parts: string[] = [`### ${type}.${subType}\n`];
  parts.push(`${def.description}\n`);
  if (owner !== undefined) parts.push(`**Owning provider:** ${owner}\n`);
  if (def.rules !== undefined) parts.push(`**Rules:** ${def.rules}\n`);
  if (def.whenToUse !== undefined) parts.push(`**When to use:** ${def.whenToUse}\n`);
  if (def.example !== undefined) parts.push(`**Example:**\n\n\`\`\`\n${def.example}\n\`\`\`\n`);

  parts.push(`**Attributes**\n`);
  parts.push(attrsTable(def, provenance, commonAttrNames));

  parts.push(`**Allowed children**\n`);
  parts.push(childrenList(def));

  if (def.parents !== undefined && def.parents.length > 0) {
    const ps = [...def.parents].sort(compare).map((p) => `\`${p}\``).join(", ");
    parts.push(`**Parents:** ${ps}\n`);
  }
  return parts.join("\n");
}

/**
 * The registered (type, subType) definitions the metamodel docs cover — every
 * registered pair EXCEPT the ones the registry-conformance manifest carves out
 * (TS-web-presentation `view.*` controls + the `metadata.base` inheritance
 * anchor) so the docs describe exactly the agreed cross-port vocabulary.
 */
function coveredDefs(registry: TypeRegistry): TypeDefinition[] {
  return registry
    .allTypes()
    .filter((id) => !isExcludedTypeSubType(id.type, id.subType))
    .map((id) => registry.find(id.type, id.subType) as TypeDefinition)
    .sort((a, b) =>
      compare(
        `${a.typeId.type}.${a.typeId.subType}`,
        `${b.typeId.type}.${b.typeId.subType}`,
      ),
    );
}

/** Render INDEX.md — the always-on map: every type.subType + one-liner + link. */
function renderIndex(defs: readonly TypeDefinition[]): string {
  const lines: string[] = [
    header("Metamodel vocabulary index — every type.subType, its one-line description, and a link to its type page."),
    "# MetaObjects Metamodel — Index\n",
    "This documents the **metamodel itself** — the type / subtype / attribute",
    "vocabulary the loader accepts — generated from the strict registry. It is",
    "NOT documentation of a user's entities (that is `meta docs --model`).\n",
    "Follow a link into `types/<family>.md` for the full attribute table, allowed",
    "children, and cardinality of a subtype. Universal documentation attributes",
    "(`@description`/`@title`/…) apply to every node and are listed once in",
    "[providers.md](providers.md) under `metaobjects-documentation`.\n",
    "| Type.subType | Description | Page |",
    "| --- | --- | --- |",
  ];
  for (const def of defs) {
    const { type, subType } = def.typeId;
    const link = `[types/${type}.md#${anchor(type, subType)}](types/${type}.md#${anchor(type, subType)})`;
    lines.push(`| \`${type}.${subType}\` | ${cell(def.description)} | ${link} |`);
  }
  return `${lines.join("\n")}\n`;
}

/** Render one types/<family>.md page from that family's subtype definitions. */
function renderTypePage(
  family: string,
  defs: readonly TypeDefinition[],
  provenance: MetamodelProvenance,
  commonAttrNames: ReadonlySet<string>,
): string {
  const parts: string[] = [
    header(`Metamodel reference for the \`${family}\` type family — each subtype's composed attributes, allowed children, and cardinality.`),
    `# Metamodel — \`${family}\` types\n`,
    `Each section below is one \`${family}.<subType>\`. The **Attributes** table lists`,
    `the subtype's own + concern-contributed attributes (provider-tagged); universal`,
    `documentation attributes are omitted here (see [providers.md](../providers.md)).`,
    `**Allowed children** lists the structural child rules with their cardinality`,
    `(\`min..max\`, \`*\` = unbounded).\n`,
  ];
  for (const def of defs) {
    parts.push(subtypeSection(def, provenance, commonAttrNames));
  }
  return `${parts.join("\n")}\n`;
}

/** Render providers.md — the 5-concern ownership index (the provider lens). */
function renderProviders(provenance: MetamodelProvenance): string {
  const parts: string[] = [
    header("Concern-provider ownership index — which provider owns each type and contributes each attribute."),
    "# MetaObjects Metamodel — Providers\n",
    "The metamodel is composed from concern providers. Each **owns** the",
    "type/subtypes it registers and may **contribute** attributes to types another",
    "provider owns. This is the ownership lens over the same vocabulary",
    "[INDEX.md](INDEX.md) lists by type.\n",
  ];
  for (const id of provenance.providerIds()) {
    parts.push(`## ${id}\n`);
    const desc = provenance.providerDescription(id);
    if (desc !== undefined) parts.push(`${desc}\n`);

    const owned = provenance.typesOwnedBy(id);
    if (owned.length > 0) {
      parts.push(`**Owns (registers):** ${owned.map((t) => `\`${t}\``).join(", ")}\n`);
    }

    const common = provenance.commonAttrsBy(id);
    if (common.length > 0) {
      parts.push(
        `**Universal attributes (every node):** ${common.map((a) => `\`@${a}\``).join(", ")}\n`,
      );
    }

    const contributed = provenance.attrsContributedBy(id);
    if (contributed.length > 0) {
      parts.push(`**Contributes attributes:**\n`);
      const lines = contributed.map(
        (c) => `- \`${c.typeSubType}\`: ${c.attrs.map((a) => `\`@${a}\``).join(", ")}`,
      );
      parts.push(`${lines.join("\n")}\n`);
    }
  }
  return `${parts.join("\n")}\n`;
}

/**
 * Render the full metamodel doc tree (pure + deterministic). Returns a
 * `Map<relativePath, markdown>` keyed by:
 *   `INDEX.md`, `providers.md`, `types/<family>.md`.
 *
 * The registry must already be composed (`composeRegistry(coreProviders)`); the
 * provenance lens is built once (`buildMetamodelProvenance`) and threaded in.
 */
export function renderMetamodelDocs(
  registry: TypeRegistry,
  provenance: MetamodelProvenance,
): Map<string, string> {
  const defs = coveredDefs(registry);
  const commonAttrNames = new Set(registry.getCommonAttrs().map((a) => a.name));

  const out = new Map<string, string>();
  out.set("INDEX.md", renderIndex(defs));
  out.set("providers.md", renderProviders(provenance));

  // Group by type family, sorted within + across.
  const byFamily = new Map<string, TypeDefinition[]>();
  for (const def of defs) {
    const fam = def.typeId.type;
    if (!byFamily.has(fam)) byFamily.set(fam, []);
    byFamily.get(fam)!.push(def);
  }
  for (const fam of [...byFamily.keys()].sort(compare)) {
    out.set(
      `types/${fam}.md`,
      renderTypePage(fam, byFamily.get(fam)!, provenance, commonAttrNames),
    );
  }
  return out;
}
