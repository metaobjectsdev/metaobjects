// Per-field doc anchor convention (linked-template-source-docs).
//
// A field's stable doc anchor slug is `field-<name>` (the field name verbatim).
// This is the SINGLE source of truth for the slug, shared by BOTH:
//   • the entity-page builder, which emits a literal `<a id="field-<name>">` in
//     each Constraints-table Field cell, and
//   • the template-source annotator, whose links target `#field-<name>`.
// Sharing one helper means the anchor and its links can never drift.
//
// The name is used verbatim (not URL-slugified): MetaObjects field names are
// already identifier-safe (no spaces / punctuation), so `field-<name>` is a
// valid HTML id and a valid Markdown fragment as-is.

/** The stable doc-anchor slug for a field: `field-<name>`. */
export function fieldAnchorSlug(name: string): string {
  return `field-${name}`;
}

/** The literal HTML anchor a Markdown link can target: `<a id="field-<name>"></a>`.
 *  Renders on GitHub-flavored Markdown and static-site generators, including
 *  inside a table cell. */
export function fieldAnchorHtml(name: string): string {
  return `<a id="${fieldAnchorSlug(name)}"></a>`;
}
