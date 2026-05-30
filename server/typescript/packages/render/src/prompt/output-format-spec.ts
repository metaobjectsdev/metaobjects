// FR-010 artifact 1 — a complete output-format descriptor.

import type { Format } from "../recover/types.js";
import type { PromptField } from "./prompt-field.js";
import type { PromptStyle } from "./prompt-style.js";

/**
 * A complete output-format descriptor: the format, the root element/object name,
 * the default presentation style, and the ordered fields. Drives
 * {@link renderOutputFormat}.
 *
 * Precondition: `rootName` must be identifier-safe (valid XML element name / JSON
 * key). The renderer does not escape it.
 */
export interface OutputFormatSpec {
  readonly format: Format;
  readonly rootName: string;
  readonly style: PromptStyle;
  readonly fields: readonly PromptField[];
}
