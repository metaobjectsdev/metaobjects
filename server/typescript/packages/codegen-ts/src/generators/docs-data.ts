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

/** One row in the neutral Constraints table — fully pre-rendered cells, so
 *  templates stay trivial and cross-port walk functions don't re-derive the
 *  escaping. Each cell is plain Markdown text; an empty cell is "". Unlike the
 *  language-specific Storage table, this is built from the field metadata's OWN
 *  declared constraints and renders for every object (including value objects
 *  with no storage). */
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
  };

  /** @markdown — description as a blockquote (one `> ` per line). Present
   *  iff `entity.description` is present. Pre-rendered so multi-line
   *  descriptions don't have to be expressed as Mustache structural
   *  constructs. */
  descriptionQuote?: string;

  /** @markdown — multi-line preamble block: Type / Source? / Package?, one
   *  per line, in the exact order matching the legacy emitter. Always
   *  present. */
  preambleHeader: string;

  /** Storage section — the NEUTRAL physical persistence mapping (column name,
   *  physical type, nullable, key). Present iff the entity has a writable rdb
   *  source and is NOT object.value. Carries NO language-specific type or DDL
   *  (ADR-0020). */
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

  /** Constraints section — the NEUTRAL replacement for the old language-
   *  specific Validation/Generated-code sections (ADR-0020). Built from the
   *  object's OWN field metadata, so it renders for every object including
   *  value objects with no storage. Always emitted. */
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

  /** Present flag for the storage section. */
  hasStorage?: boolean;
}
