package com.metaobjects.template;

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Template Types provider — registers {@link MetaTemplate} (template.base)
 * and its concrete subtypes ({@link OutputTemplate}, {@link PromptTemplate}).
 * FR-004 cross-port parity.
 *
 * @since 7.0.0
 */
public class TemplateTypesMetaDataProvider implements MetaDataTypeProvider {

    private static final Logger log = LoggerFactory.getLogger(TemplateTypesMetaDataProvider.class);

    @Override
    public void registerTypes(MetaDataRegistry registry) {
        MetaTemplate.registerTypes(registry);
        OutputTemplate.registerTypes(registry);
        PromptTemplate.registerTypes(registry);
        log.debug("Template types registered via provider");
    }

    @Override
    public String getProviderId() {
        return "template-types";
    }

    @Override
    public String[] getDependencies() {
        return new String[]{"core-base-types", "attribute-types"};
    }

    @Override
    public String getDescription() {
        return "Template Types MetaData Provider — FR-004 prompt/output templates";
    }
}
