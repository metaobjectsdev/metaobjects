// Copyright 2026 MetaObjects authors.
package com.metaobjects.documentation;

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;

/**
 * Documentation common-attrs provider — cross-language doc layer (TS/C# parity).
 *
 * <p>This Java port currently provides the API + SPI surface only.</p>
 *
 * <p>TODO(java-h3b): wire the 7 common attrs via a registerCommonAttribute
 * mechanism on MetaDataRegistry once H3b's conformance harness lands and the
 * cross-language commonAttrs contract is testable here. Until then, this
 * provider's registerTypes is a no-op — Java's loader does not yet have an
 * open-policy validation pass to merge common attrs into.</p>
 *
 * <p>The constants in {@link DocumentationConstants} are usable now by any
 * Java consumer that wants to read/write the 7 attr names with the
 * cross-language-stable spelling.</p>
 */
public class DocumentationMetaDataProvider implements MetaDataTypeProvider {

    @Override
    public String getProviderId() {
        return "metaobjects-documentation";
    }

    @Override
    public String[] getDependencies() {
        // No hard dep until commonAttrs are registered; align with the cross-language
        // contract (provider depends on core-types) by declaring it now.
        return new String[]{"core-base-types"};
    }

    @Override
    public void registerTypes(MetaDataRegistry registry) {
        // Intentional no-op for now — see class-level Javadoc TODO(java-h3b).
        // When the registerCommonAttribute API lands, replace with:
        //   for (var attr : DocumentationSchema.COMMON_DOC_ATTRS) {
        //       registry.registerCommonAttribute(attr.name(), attr.valueType(), attr.required());
        //   }
    }

    @Override
    public String getDescription() {
        return "Documentation Provider - cross-language doc attrs (description/title/notes/deprecated/replacedBy/seeAlso/aliases)";
    }
}
