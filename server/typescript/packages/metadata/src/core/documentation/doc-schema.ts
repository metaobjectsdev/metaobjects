import { type AttrSchema } from "../../registry.js";
import { ATTR_SUBTYPE_STRING } from "../attr/attr-constants.js";
import {
  DOC_ATTR_ALIASES,
  DOC_ATTR_DEPRECATED,
  DOC_ATTR_DESCRIPTION,
  DOC_ATTR_NOTES,
  DOC_ATTR_REPLACED_BY,
  DOC_ATTR_SEE_ALSO,
  DOC_ATTR_SUMMARY,
  DOC_ATTR_TITLE,
} from "./doc-constants.js";

/**
 * The 8 universal documentation common attrs. Registered via the
 * registry.registerCommonAttrs() hook by the documentation provider.
 * Per ADR-0006, attr names are bare here; the serializer prefixes with @.
 */
export const commonDocAttrs: AttrSchema[] = [
  {
    name: DOC_ATTR_DESCRIPTION,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "Free-form user-facing prose. Markdown allowed, multi-line via YAML '|' block scalar. Flows into doc-gen surfaces (JSDoc / XML-doc / Postgres COMMENT / Mermaid prose).",
  },
  {
    name: DOC_ATTR_SUMMARY,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "Short single-line tagline (OpenAPI `summary` pattern) — used in index tables, sidebar previews, and AI prompts where the full @description is too long. Optional supplement to @description; when @summary is unset, doc surfaces typically fall back to the first sentence of @description.",
  },
  {
    name: DOC_ATTR_TITLE,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "Short single-line human label (e.g. 'Email' for a `field.string email`). Optional supplement to description.",
  },
  {
    name: DOC_ATTR_NOTES,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "Internal-only rationale. Stays in metadata; never emitted to user-facing docs.",
  },
  {
    name: DOC_ATTR_DEPRECATED,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "Text reason for deprecation. Presence ⇒ deprecated. Codegen emits @deprecated / [Obsolete] with this reason.",
  },
  {
    name: DOC_ATTR_REPLACED_BY,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "FQN reference to the replacement element. Only meaningful with `deprecated`. Codegen appends 'Replaced by <ref>' to deprecation messages.",
  },
  {
    name: DOC_ATTR_SEE_ALSO,
    valueType: ATTR_SUBTYPE_STRING,
    isArray: true,
    required: false,
    description: "External documentation URLs. Codegen emits @see / <seealso href=...>.",
  },
  {
    name: DOC_ATTR_ALIASES,
    valueType: ATTR_SUBTYPE_STRING,
    isArray: true,
    required: false,
    description: "Alternate names for this element. Aids AI authoring disambiguation, search, migration.",
  },
];
