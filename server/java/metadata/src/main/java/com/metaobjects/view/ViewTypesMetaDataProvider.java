package com.metaobjects.view;

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * View Types provider — registers {@link MetaView} (view.base) and its
 * concrete subtypes so they are discoverable through the unified registry.
 *
 * <p>Cross-port: the TS/C# ports surface a "view-types" provider for the
 * same vocabulary (today: {@code view.currency}; future: validation views,
 * display views). Priority 10 mirrors the field/attr providers — runs after
 * {@code core-base-types} (0) so {@code metadata.base} is available.</p>
 *
 * @since 7.0.0
 */
public class ViewTypesMetaDataProvider implements MetaDataTypeProvider {

    private static final Logger log = LoggerFactory.getLogger(ViewTypesMetaDataProvider.class);

    @Override
    public void registerTypes(MetaDataRegistry registry) {
        MetaView.registerTypes(registry);
        CurrencyView.registerTypes(registry);
        log.debug("View types registered via provider");
    }

    @Override
    public String getProviderId() {
        return "view-types";
    }

    @Override
    public String[] getDependencies() {
        return new String[]{"core-base-types"};
    }

    @Override
    public String getDescription() {
        return "View Types MetaData Provider — registers view.base + concrete view subtypes";
    }
}
