// Copyright 2026 MetaObjects authors.
package com.metaobjects.documentation;

import com.metaobjects.attr.StringArrayAttribute;
import com.metaobjects.attr.StringAttribute;

import java.util.List;

/**
 * The 7 universal documentation common attrs. Mirrors the TS {@code commonDocAttrs}
 * array and the C# {@code DocumentationSchema.CommonDocAttrs} list.
 *
 * <p>Value types use the Java-side subtype constants:</p>
 * <ul>
 *   <li>{@link StringAttribute#SUBTYPE_STRING} ({@code "string"}) — scalar string attrs</li>
 *   <li>{@link StringArrayAttribute#SUBTYPE_STRING_ARRAY} ({@code "stringarray"}) — array attrs</li>
 * </ul>
 *
 * <p>These values are cross-language-stable: TS uses {@code ATTR_SUBTYPE_STRING} /
 * {@code ATTR_SUBTYPE_STRINGARRAY} with the same underlying strings. Do not change them.</p>
 */
public final class DocumentationSchema {
    private DocumentationSchema() {}

    /**
     * A single documentation common-attr descriptor.
     *
     * @param name        Bare attr name (no {@code @} prefix). Cross-language-stable.
     * @param valueType   Attr value subtype — {@code "string"} or {@code "stringarray"}.
     * @param required    Whether this attr is required (all doc attrs are optional).
     * @param description Human-readable description of the attr's purpose.
     */
    public record CommonDocAttr(
        String name,
        String valueType,
        boolean required,
        String description
    ) {}

    /** The 7 universal documentation common attrs in declaration order. */
    public static final List<CommonDocAttr> COMMON_DOC_ATTRS = List.of(
        new CommonDocAttr(
            DocumentationConstants.DOC_ATTR_DESCRIPTION,
            StringAttribute.SUBTYPE_STRING,
            false,
            "Free-form user-facing prose. Markdown allowed, multi-line via YAML '|' block scalar. "
            + "Flows into doc-gen surfaces (JSDoc / XML-doc / Postgres COMMENT / Mermaid prose)."
        ),
        new CommonDocAttr(
            DocumentationConstants.DOC_ATTR_TITLE,
            StringAttribute.SUBTYPE_STRING,
            false,
            "Short single-line human label (e.g. 'Email' for a field.string email). "
            + "Optional supplement to description."
        ),
        new CommonDocAttr(
            DocumentationConstants.DOC_ATTR_NOTES,
            StringAttribute.SUBTYPE_STRING,
            false,
            "Internal-only rationale. Stays in metadata; never emitted to user-facing docs."
        ),
        new CommonDocAttr(
            DocumentationConstants.DOC_ATTR_DEPRECATED,
            StringAttribute.SUBTYPE_STRING,
            false,
            "Text reason for deprecation. Presence => deprecated. "
            + "Codegen emits @deprecated / [Obsolete] with this reason."
        ),
        new CommonDocAttr(
            DocumentationConstants.DOC_ATTR_REPLACED_BY,
            StringAttribute.SUBTYPE_STRING,
            false,
            "FQN reference to the replacement element. Only meaningful with `deprecated`. "
            + "Codegen appends 'Replaced by <ref>' to deprecation messages."
        ),
        new CommonDocAttr(
            DocumentationConstants.DOC_ATTR_SEE_ALSO,
            StringArrayAttribute.SUBTYPE_STRING_ARRAY,
            false,
            "External documentation URLs. Codegen emits @see / <seealso href=...>."
        ),
        new CommonDocAttr(
            DocumentationConstants.DOC_ATTR_ALIASES,
            StringArrayAttribute.SUBTYPE_STRING_ARRAY,
            false,
            "Alternate names for this element. Aids AI authoring disambiguation, search, migration."
        )
    );
}
