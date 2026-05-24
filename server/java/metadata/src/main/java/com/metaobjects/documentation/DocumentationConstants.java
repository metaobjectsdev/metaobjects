// Copyright 2026 MetaObjects authors.
package com.metaobjects.documentation;

import java.util.List;

/**
 * The 7 universal documentation common-attr names. Bare strings, identical
 * across all language ports (TS / C# / Java / Python). The serializer adds
 * the @-prefix on canonical JSON output per ADR-0006.
 */
public final class DocumentationConstants {
    private DocumentationConstants() {}

    public static final String DOC_ATTR_DESCRIPTION = "description";
    public static final String DOC_ATTR_TITLE        = "title";
    public static final String DOC_ATTR_NOTES        = "notes";
    public static final String DOC_ATTR_DEPRECATED   = "deprecated";
    public static final String DOC_ATTR_REPLACED_BY  = "replacedBy";
    public static final String DOC_ATTR_SEE_ALSO     = "seeAlso";
    public static final String DOC_ATTR_ALIASES      = "aliases";

    /** All 7 names in declaration order. */
    public static final List<String> DOC_ATTR_NAMES = List.of(
        DOC_ATTR_DESCRIPTION,
        DOC_ATTR_TITLE,
        DOC_ATTR_NOTES,
        DOC_ATTR_DEPRECATED,
        DOC_ATTR_REPLACED_BY,
        DOC_ATTR_SEE_ALSO,
        DOC_ATTR_ALIASES
    );
}
