// Data-dict shapes for the docs templates — the public contract template
// authors consume. Versioned per MO major; deprecated before removal.
//
// ## Stability contract (v1)
//
// Per the template-driven codegen design (D3 — data-shape stability), these
// types ARE a public API. Template authors who write custom Mustache files
// for `docs/entity-page.md` (or any of the partials) reference these keys.
//
// `EntityDocData` is the **Markdown-flavored** data shape — it intentionally
// mixes raw structural fields (entity, constraints) with
// **pre-rendered Markdown fragments** so cross-port walk functions (TS,
// Python, C#, Java, Kotlin) don't have to re-derive the same escaping rules
// (pipe-inside-cell escapes, backtick wrapping, identity bullets,
// description blockquotes). Fields whose JSDoc carries a `@markdown` tag
// encode Markdown-specific layout decisions and are stable for the v1
// contract; they are NOT useful for non-Markdown output (HTML, JSON, plain
// text).
//
// A consumer writing a custom Mustache template with **different table
// columns** or a **different output format** today must compose their own
// data from `MetaObject` directly — the v1 shape does not expose a
// structural-only layer. A future `EntityDocStructure` (raw fields only,
// no Markdown) may ship in v2 if a real adopter needs that surface; the
// split is deliberately deferred until then.
//
// ## Cross-port consistency
//
// Today's docsFile() refactor populates EntityDocData from MetaObject + the
// existing column-mapper / source-detect / enum-meta helpers. Cross-port
// implementations (C#, Java, Kotlin, Python) emit the same shape so a single
// set of Mustache templates can drive every port's docs codegen.
//
// ## Mustache idiom note
//
// Some sections carry both a list and a parallel `has*` boolean. The flag is
// only present to work around Mustache's lack of an "is non-empty array"
// primitive (`{{#identities}}` iterates but doesn't gate a wrapping section
// header). A future render engine version may let templates use
// `{{#identities.0}}` for the same effect, at which point the flag fields
// can be deprecated.

/** One row in the NEUTRAL Storage table — the physical persistence MAPPING,
 *  fully-rendered as a single Markdown table row. ADR-0020: the Storage
 *  section documents declared physical facts only (column name → neutral
 *  physical type → nullable → key) and makes NO language assumption — it does
 *  NOT carry a TypeScript type or any ORM DDL. Its value-add over the
 *  Constraints table is the field→column name mapping + any physical
 *  `@dbColumnType` override + the key role. The pre-rendered `rowLine` keeps
 *  templates trivial and means cross-port walk functions don't re-derive the
 *  Markdown escaping. */
export interface StorageFieldDoc {
  name: string;                  // raw field name (without backticks)
  /** @markdown — physical column name (field's `@column` if set, else the
   *  field name), wrapped in backticks. */
  columnCell: string;
  /** @markdown — neutral physical type (declared `@dbColumnType` override
   *  uppercased, else the field's logical type), wrapped in backticks. */
  typeCell: string;
  /** @markdown — "yes" if the field is nullable (not required, not a PK),
   *  else "no". */
  nullableCell: string;
  /** @markdown — key role: "primary key", "foreign key → `Target`", or "". */
  keyCell: string;
  /** @markdown — pre-rendered full Markdown table row, e.g.
   *    "| `id` | `long` | no | primary key |"
   *  Templates emit this verbatim via `{{{rowLine}}}`. */
  rowLine: string;
}

export interface IdentityDoc {
  /** @markdown — pre-formatted bullet text — e.g.
   *    "**Primary key:** `id` — generation: `increment`"
   *  (Carrying the fully-rendered string keeps the template trivial; the
   *  identity rendering rules are non-trivial and live in the builder.) */
  bullet: string;
}

export interface RelationshipDoc {
  /** @markdown — pre-formatted bullet text — e.g.
   *    "- `posts` — one-to-many → `Post` (composition)" */
  bullet: string;
}

export interface UsedByDoc {
  /** @markdown — pre-formatted bullet text. */
  bullet: string;
}

/** One row in the unified Fields table — merges the old Storage + Constraints
 *  cells into a single per-field row. Cells are pre-rendered Markdown so
 *  templates stay trivial. An empty cell is "".
 *
 *  Replaces the previous Storage + Constraints split which duplicated facts
 *  (field name, logical type, key role, required-vs-nullable). Following the
 *  research synthesis: domain-model docs (FHIR, GitHub GraphQL Objects,
 *  Schema.org) all surface one Fields/Properties table per resource. */
export interface FieldDoc {
  field: string;                 // raw field name (without backticks/anchor)
  /** @markdown — anchored, badge-prefixed field cell:
   *    `<a id="field-id"></a>🔑 \`id\``  (PK)
   *    `<a id="field-userId"></a>🔗 \`userId\``  (FK)
   *    `<a id="field-name"></a>\`name\``  (plain) */
  fieldCell: string;
  /** @markdown — neutral logical type; for FK fields, suffixed with the
   *  cross-linked target — e.g. "`int` → [`User`](User.md)". */
  typeCell: string;
  /** @markdown — "yes" / "" — whether the field is required (or a PK). */
  requiredCell: string;
  /** @markdown — physical persistence info, ONLY when interesting:
   *    `@column` override that differs from the field name → "`UserId`"
   *    `@dbColumnType` set → "`UserId` `UUID`"  (or "`Data` `JSONB`" when
   *      the field name happens to match the column)
   *  Empty when field name == column AND no @dbColumnType override. */
  storageCell: string;
  /** @markdown — all the rules: validators (regex/length/numeric), default,
   *  enum value set, extends EnumName, references, unique. Joined by " · ". */
  rulesCell: string;
}

/** One expanded per-field detail entry — rendered as a sub-section below
 *  the at-a-glance Fields table. ONLY emitted for fields with non-trivial
 *  content (@description / @summary / validators / extends-enum / FK ref /
 *  default / column-override). Skipped for plain typed fields with nothing
 *  extra to surface — keeps the entity page from ballooning with empty
 *  stubs.
 *
 *  The `block` is fully pre-rendered Markdown so the template is trivial
 *  (`{{{block}}}` per row) and cross-port walks emit consistent output
 *  without re-implementing the layout.
 *
 *  Authoring path: any field that wants surface in this section just sets
 *  `@description` and/or `@summary` in the metadata YAML. Mirrors the
 *  per-entity pattern. */
export interface FieldDetailDoc {
  field: string;                 // raw field name (without backticks)
  /** @markdown — the full per-field block, headed by `### \`fieldName\``
   *  and followed by italic summary, description paragraph, validator
   *  bullets, type/FK/extends/default lines. */
  block: string;
}

/** Deprecated alias for {@link FieldDoc} — kept for back-compat in case any
 *  external template author destructured the old ConstraintRow shape.
 *  @deprecated use FieldDoc */
export interface ConstraintRow {
  field: string;                 // raw field name (without backticks)
  /** @markdown — "yes" / "" — whether the field is required (or a PK). */
  required: string;
  /** @markdown — neutral logical type cell, e.g. "`string`", "`enum`",
   *  "`Address[]`". */
  type: string;
  /** @markdown — size/range limits, e.g. "maxLength: 200" — "" if none. */
  limits: string;
  /** @markdown — declared rules: enum value sets, patterns, validators,
   *  uniqueness, default — "" if none. */
  rules: string;
}

export interface EntityDocData {
  /** @markdown — auto-emitted by the templateGenerator; templates may also
   *  echo it for human readers. Format: `<!-- @generated by
   *  @metaobjectsdev/codegen-ts — DO NOT EDIT. -->`. */
  generatedMarker: string;

  /** The entity preamble — RAW (not Markdown-flavored). Custom non-Markdown
   *  templates can rely on these fields. */
  entity: {
    name: string;                // "Author"
    type: string;                // "object.entity"
    source?: string;             // "meta.blog.json"
    package?: string;            // "acme::blog"
    description?: string;        // raw description text (may be multi-line)
    summary?: string;            // raw summary text (single line)
  };

  /** @markdown — description as a blockquote (one `> ` per line). Present
   *  iff `entity.description` is present. Pre-rendered so multi-line
   *  descriptions don't have to be expressed as Mustache structural
   *  constructs. */
  descriptionQuote?: string;

  /** @markdown — `@summary` rendered as a one-line italic lead-in (e.g.
   *  `*Tracks ...*`). Present iff `entity.summary` is set. Distinct from
   *  `descriptionQuote` (a blockquote) so an entity that carries BOTH
   *  surfaces both — short headline above, expanded paragraph below. */
  summaryLead?: string;

  /** @markdown — fenced ```mermaid erDiagram block``` showing the focal
   *  entity plus its direct in/out FK neighbors (1-hop). Replaces the
   *  cognitive load of the whole-model graph with an in-context view.
   *  Mirrors the dbdocs pattern. Skipped when the entity has no neighbors. */
  neighborhoodErBlock?: string;
  /** Gate flag for Mustache — true iff `neighborhoodErBlock` is present.
   *  See the "Mustache idiom note" at the top of this file. */
  hasNeighborhoodEr?: boolean;

  /** @markdown — multi-line preamble block: Type / Source? / Package?, one
   *  per line, in the exact order matching the legacy emitter. Always
   *  present. */
  preambleHeader: string;

  /** Unified Fields section — one row per field, merging the per-field facts
   *  the old Storage + Constraints tables split between. Always emitted when
   *  the entity has any fields. */
  fields: {
    hasFields: boolean;
    rows: FieldDoc[];
  };

  /** Expanded per-field details — emitted as a "## Field details" section
   *  AFTER the at-a-glance Fields table. Skips fields with nothing extra to
   *  say (no description, no summary, no validators, no extends, no default,
   *  no FK, no column override) so the section doesn't balloon the page. */
  fieldDetails: {
    hasDetails: boolean;
    rows: FieldDetailDoc[];
  };

  /** @deprecated Storage section. The merged Fields table covers this now;
   *  the old shape is still populated for adopters with custom templates that
   *  reference it, but new templates should use `fields` instead. */
  storage?: {
    /** @markdown — pre-rendered "| Column | Type | Nullable | Key |\n|---|...|"
     *  header pair. */
    tableHeader: string;
    rows: StorageFieldDoc[];
  };

  /** Identity section bullets — empty array iff section is omitted.
   *  See the "Mustache idiom note" at the top of this file for why this
   *  ships alongside a parallel `hasIdentities` boolean. */
  identities?: IdentityDoc[];
  /** Present-and-non-empty flag for the identities section. See the
   *  "Mustache idiom note" at the top of this file. */
  hasIdentities?: boolean;

  /** Relationships section — same list+flag pattern as identities. */
  relationships?: RelationshipDoc[];
  /** Present-and-non-empty flag for the relationships section. */
  hasRelationships?: boolean;

  /** @deprecated Constraints section. The merged Fields table covers this
   *  now; the old shape is still populated for adopters with custom templates
   *  that reference it, but new templates should use `fields` instead. */
  constraints: {
    /** True iff there is at least one row to render (objects always have
     *  fields, so this is generally true; gates the section header). */
    hasConstraints: boolean;
    rows: ConstraintRow[];
  };

  /** "Used by" — present iff any templates declare `@payloadRef` → this
   *  entity. Same list+flag pattern as identities. */
  usedBy?: UsedByDoc[];
  /** Present-and-non-empty flag for the usedBy section. */
  hasUsedBy?: boolean;

  /** "Required by" (shape C) — the `requirement.*` nodes whose `@implementedBy`
   *  resolves to THIS entity. Same list+flag pattern as `usedBy`.
   *
   *  ABSENT — not empty, not false — when nothing claims the entity, so the
   *  Mustache section does not render and an unclaimed entity's page stays
   *  BYTE-IDENTICAL to its pre-feature output. That is the no-churn contract:
   *  a project with no ledger, or an entity nothing claims, must see no diff.
   *
   *  ENTITY PAGES ONLY. Object coverage is entity-grain (`spec/capability-ledger.md`),
   *  so a claimed `object.value` / `object.projection` gets nothing here — surfacing
   *  one would imply a coverage rule the ledger does not actually have.
   *
   *  That governs which PAGE a row lands on, not how deep the CLAIM may point: an L5
   *  claim names a member, resolves to the FIELD, and still renders on the owning
   *  entity's page with the member named in the row (`· on \`status\``). */
  claimedBy?: UsedByDoc[];
  /** Present-and-non-empty flag for the claimedBy section. */
  hasClaimedBy?: boolean;

  /** Present flag for the storage section. */
  hasStorage?: boolean;

  /** Cross-links to this entity's generated-SDK api page, one per api surface
   *  (per language). Present only when api surfaces are emitted with the model. */
  apiRefs?: Array<{ label: string; href: string; last?: boolean }>;
}
