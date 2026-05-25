// Copyright 2026 MetaObjects authors.
package com.metaobjects.documentation;

import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;

/**
 * Documentation common-attrs provider — cross-language doc layer (TS/C# parity).
 *
 * <p>Registers the 7 universal documentation attributes via
 * {@link MetaDataRegistry#registerCommonAttribute(String, String, boolean)} so
 * they are accepted on any node (every type / every subType):</p>
 *
 * <ul>
 *   <li>{@code @description}, {@code @title}, {@code @notes}, {@code @deprecated},
 *       {@code @replacedBy} — single-string attrs</li>
 *   <li>{@code @seeAlso}, {@code @aliases} — string-array attrs</li>
 * </ul>
 *
 * <p>The {@code @notes} attribute is the internal-only rationale slot — per the
 * cross-language contract it must never be emitted to user-facing doc-gen
 * (JSDoc / XML-doc / Postgres {@code COMMENT ON} / Mermaid prose). It is
 * registered here so the loader accepts it on any node, but doc-emitters
 * downstream are expected to skip it.</p>
 */
public class DocumentationMetaDataProvider implements MetaDataTypeProvider {

    @Override
    public String getProviderId() {
        return "metaobjects-documentation";
    }

    @Override
    public String[] getDependencies() {
        // Depends on core-types because the common-attr registration references
        // StringAttribute.SUBTYPE_STRING (a core type subtype).
        return new String[]{"core-base-types"};
    }

    @Override
    public void registerTypes(MetaDataRegistry registry) {
        // All 7 docs attrs are string-valued; @seeAlso and @aliases are arrays.
        // Cross-language contract: @deprecated is a string (free-form note such as
        // "Use contactEmail instead."), not a boolean — every port's fixtures use
        // a string value.
        registry.registerCommonAttribute(
            DocumentationConstants.DOC_ATTR_DESCRIPTION,
            StringAttribute.SUBTYPE_STRING, false);
        registry.registerCommonAttribute(
            DocumentationConstants.DOC_ATTR_TITLE,
            StringAttribute.SUBTYPE_STRING, false);
        registry.registerCommonAttribute(
            DocumentationConstants.DOC_ATTR_NOTES,
            StringAttribute.SUBTYPE_STRING, false);
        registry.registerCommonAttribute(
            DocumentationConstants.DOC_ATTR_DEPRECATED,
            StringAttribute.SUBTYPE_STRING, false);
        registry.registerCommonAttribute(
            DocumentationConstants.DOC_ATTR_REPLACED_BY,
            StringAttribute.SUBTYPE_STRING, false);
        registry.registerCommonAttribute(
            DocumentationConstants.DOC_ATTR_SEE_ALSO,
            StringAttribute.SUBTYPE_STRING, true);
        registry.registerCommonAttribute(
            DocumentationConstants.DOC_ATTR_ALIASES,
            StringAttribute.SUBTYPE_STRING, true);
    }

    @Override
    public String getDescription() {
        return "Documentation Provider - cross-language doc attrs (description/title/notes/deprecated/replacedBy/seeAlso/aliases)";
    }
}
