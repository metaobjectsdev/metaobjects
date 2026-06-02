// Data-dict shape for the NEUTRAL template.output doc page (the "render
// contract" page). Sibling of EntityDocData (docs-data.ts) — same public-API
// stability contract: template authors who write a custom Mustache file for
// `docs/template-page.md` reference these keys.
//
// CRITICAL — NEUTRALITY: this shape carries NO language assumptions. There are
// no generated-helper signatures, no language type names, no SDK tokens. The
// `capability` field is a FIXED, language-neutral English sentence per @kind
// (see template-doc-builder.ts). The page describes the RENDER CONTRACT (what
// the template references, validates, and produces), not any one port's code.
//
// Markdown-flavored, like EntityDocData: a few fields are pre-rendered (the
// parts table is structural, but escaping / raw-vs-escaped wording lives in the
// builder so the template stays trivial and cross-port walks don't re-derive it).

/** One part of a multipart (email) template — a single rendered source ref with
 *  its format and whether the renderer escapes its output for that format. */
export interface TemplateOutputPart {
  /** Human-readable part label, e.g. "Subject", "HTML body", "Text body". */
  label: string;
  /** The logical text ref rendered for this part (e.g. "email/welcome.html"). */
  ref: string;
  /** Render format for this part: "text" | "html" (subject/text = text, html = html). */
  format: string;
  /** True iff the renderer escapes output for this part's format (html → true). */
  escaped: boolean;
}

export interface TemplateDocData {
  /** @markdown — the generated-by marker, echoed at the top of the page. */
  generatedMarker: string;

  /** Raw template node name — also the emitted filename (`<name>.md`). */
  name: string;

  /** @kind — "document" | "email". */
  kind: "document" | "email";
  /** Convenience flag for the Mustache template (no "is X" primitive). */
  isEmail: boolean;

  /** @markdown — description as a blockquote (one `> ` per line). Present iff
   *  the template declares a @description. Mirrors EntityDocData. */
  descriptionQuote?: string;

  /** Document: the @format (e.g. "html"). Email: "" — the parts carry format. */
  format: string;

  /** Email only: the ordered multipart parts (subject, html body, text body?). */
  parts?: TemplateOutputPart[];

  /** The payload object the template renders from. `link` is `./<rawName>.md` —
   *  the payload entity's own doc page (raw-name convention, matching the
   *  entity-page filename + the entity's Used-by back-link). */
  payload: { name: string; link: string };

  /** @requiredTags, if declared. Drives both the Input "Required fields" line
   *  and the Render-contract "Required tags" bullet. */
  requiredTags?: string[];
  /** Present-and-non-empty flag for @requiredTags (Mustache has no "non-empty
   *  array" primitive; same idiom as EntityDocData's `has*` flags). */
  hasRequiredTags?: boolean;

  /** @maxChars, if declared (document only in practice). */
  maxChars?: number;

  /** The template refs this page renders: [@textRef] for a document, or the
   *  2–3 email part refs. Drives the Source section. */
  sourceRefs: string[];

  /** FIXED, language-NEUTRAL capability sentence per @kind. No type names, no
   *  function signatures. See template-doc-builder.ts. */
  capability: string;
}
