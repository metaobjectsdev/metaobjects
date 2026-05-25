package com.metaobjects.template;

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;

/**
 * Template Types MetaData provider.
 *
 * <p>Registers the abstract {@code template.base} type plus the two concrete
 * subtypes {@code template.prompt} and {@code template.output} (FR-004 fourth
 * pillar: cross-language prompt construction). Depends on {@code core-types}
 * for {@code metadata.base} inheritance.</p>
 *
 * <p>Discovered via the standard {@link MetaDataTypeProvider} ServiceLoader
 * mechanism — wired through
 * {@code META-INF/services/com.metaobjects.registry.MetaDataTypeProvider}.</p>
 */
public class TemplateTypesMetaDataProvider implements MetaDataTypeProvider {

    @Override
    public void registerTypes(MetaDataRegistry registry) {
        // Register abstract base type first (declares the union of shared attrs).
        MetaTemplate.registerTypes(registry);

        // Register concrete template subtypes.
        PromptTemplate.registerTypes(registry);
        OutputTemplate.registerTypes(registry);

        // Root-level acceptance for template.* is declared on metadata.root in
        // MetaRoot's static initializer alongside object/field/attr/validator/view/
        // identity/relationship — templates are a top-level metadata type.
    }

    @Override
    public String getProviderId() {
        return "template-types";
    }

    @Override
    public String[] getDependencies() {
        return new String[]{"core-types"};
    }

    @Override
    public String getDescription() {
        return "Template Types (prompt / output — FR-004 cross-language prompt construction)";
    }
}
