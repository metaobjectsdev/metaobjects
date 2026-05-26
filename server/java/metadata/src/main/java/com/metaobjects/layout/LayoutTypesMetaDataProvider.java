package com.metaobjects.layout;

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Layout Types provider — registers {@link MetaLayout} (layout.base) and its
 * concrete subtypes. Cross-port parity with the TS/C# layout vocabulary.
 *
 * @since 7.0.0
 */
public class LayoutTypesMetaDataProvider implements MetaDataTypeProvider {

    private static final Logger log = LoggerFactory.getLogger(LayoutTypesMetaDataProvider.class);

    @Override
    public void registerTypes(MetaDataRegistry registry) {
        MetaLayout.registerTypes(registry);
        DataGridLayout.registerTypes(registry);
        log.debug("Layout types registered via provider");
    }

    @Override
    public String getProviderId() {
        return "layout-types";
    }

    @Override
    public String[] getDependencies() {
        // Depends on attribute-types so attr.filter is available for DataGridLayout's @filter.
        return new String[]{"core-base-types", "attribute-types"};
    }

    @Override
    public String getDescription() {
        return "Layout Types MetaData Provider — registers layout.base + concrete layout subtypes";
    }
}
