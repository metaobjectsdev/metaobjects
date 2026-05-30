// FR-010 artifact 1 — render-time overrides of the metadata defaults.

import type { PromptStyle } from "./prompt-style.js";

/**
 * Render-time overrides of the metadata defaults. `style` undefined keeps the
 * spec's style; the maps override `PromptField.example`/`PromptField.instruction`
 * per field name.
 */
export interface PromptOverrides {
  readonly style?: PromptStyle;
  readonly examples?: Readonly<Record<string, string>>;
  readonly instructions?: Readonly<Record<string, string>>;
}

/** No overrides — keep every metadata default. Mirrors Java `PromptOverrides.none()`. */
export const PROMPT_OVERRIDES_NONE: PromptOverrides = Object.freeze({
  // `style` omitted (not `undefined`) under exactOptionalPropertyTypes: an absent
  // style keeps the spec's own style, matching Java `PromptOverrides.none()`.
  examples: {},
  instructions: {},
});

/** No overrides — keep every metadata default. */
export function noOverrides(): PromptOverrides {
  return PROMPT_OVERRIDES_NONE;
}
