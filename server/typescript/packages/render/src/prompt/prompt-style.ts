// FR-010 artifact 1 — output-format prompt renderer.
//
// How the output-format fragment teaches the model. Guidance is NEVER carried in
// comments (models ignore them) — it lives in prose / inline placeholders / a
// filled skeleton. Default is "guide".
//
// Tier-2 idiomatic TS: the Java SCREAMING_SNAKE enum (GUIDE/INLINE/EXAMPLE_ONLY)
// becomes a string-union whose members ARE the wire `@promptStyle` values
// ("guide" | "inline" | "exampleOnly") — no name<->wire mapping table needed.

/**
 * - `"guide"`: prose field list ("Fill in each field…") followed by an example skeleton.
 * - `"inline"`: a single skeleton whose field values are inline placeholders / enum choices.
 * - `"exampleOnly"`: just a filled example skeleton, nothing else.
 */
export const PromptStyle = {
  GUIDE: "guide",
  INLINE: "inline",
  EXAMPLE_ONLY: "exampleOnly",
} as const;
export type PromptStyle = (typeof PromptStyle)[keyof typeof PromptStyle];

/**
 * Maps the `@promptStyle` attribute string to a {@link PromptStyle}. Null or any
 * unrecognized value falls back to `"guide"` (matches Java `PromptStyle.from`).
 */
export function promptStyleFrom(s?: string | null): PromptStyle {
  switch (s) {
    case PromptStyle.INLINE:
      return PromptStyle.INLINE;
    case PromptStyle.EXAMPLE_ONLY:
      return PromptStyle.EXAMPLE_ONLY;
    default:
      return PromptStyle.GUIDE;
  }
}
