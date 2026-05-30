// FR-010 artifact 1 — one field of an output-format fragment.

import type { FieldKind } from "../recover/types.js";
import type { OutputFormatSpec } from "./output-format-spec.js";

/**
 * One field of an output-format fragment. `enumValues`/`enumDoc` are non-null
 * only for ENUM; `nested` non-null only for OBJECT; `example`/`instruction` are
 * nullable.
 *
 * Precondition: `name` must be identifier-safe (valid XML element name / JSON
 * key). The renderer does not escape field names.
 */
export interface PromptField {
  readonly name: string;
  readonly kind: FieldKind;
  readonly required: boolean;
  readonly array: boolean;
  readonly enumValues: readonly string[] | null;
  readonly enumDoc: Readonly<Record<string, string>> | null;
  readonly example: string | null;
  readonly instruction: string | null;
  readonly nested: OutputFormatSpec | null;
}
