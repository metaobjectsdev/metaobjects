// Documentation common-attr constants. Bare names — the @-prefix is added by
// the serializer per ADR-0006.

export const DOC_ATTR_DESCRIPTION = "description";
export const DOC_ATTR_SUMMARY = "summary";
export const DOC_ATTR_TITLE = "title";
export const DOC_ATTR_NOTES = "notes";
export const DOC_ATTR_DEPRECATED = "deprecated";
export const DOC_ATTR_REPLACED_BY = "replacedBy";
export const DOC_ATTR_SEE_ALSO = "seeAlso";
export const DOC_ATTR_ALIASES = "aliases";

/** All 8 documentation common-attr names in declaration order. */
export const DOC_ATTR_NAMES = [
  DOC_ATTR_DESCRIPTION,
  DOC_ATTR_SUMMARY,
  DOC_ATTR_TITLE,
  DOC_ATTR_NOTES,
  DOC_ATTR_DEPRECATED,
  DOC_ATTR_REPLACED_BY,
  DOC_ATTR_SEE_ALSO,
  DOC_ATTR_ALIASES,
] as const;
export type DocAttrName = (typeof DOC_ATTR_NAMES)[number];
