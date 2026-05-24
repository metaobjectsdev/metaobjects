package com.metaobjects.source;

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;

/**
 * Source Types MetaData provider.
 *
 * <p>Registers the abstract {@code source.base} type and the concrete
 * {@code source.rdb} subtype. Depends on {@code core-types} for
 * {@code metadata.base} inheritance.</p>
 */
public class SourceTypesMetaDataProvider implements MetaDataTypeProvider {

    @Override
    public void registerTypes(MetaDataRegistry registry) {
        // Register abstract base type first
        MetaSource.registerTypes(registry);

        // Register concrete source subtypes
        RdbSource.registerTypes(registry);
    }

    @Override
    public String getProviderId() {
        return "source-types";
    }

    @Override
    public String[] getDependencies() {
        return new String[]{"core-types"};
    }

    @Override
    public String getDescription() {
        return "Source Types (rdb — relational-database table/view/stored-proc/table-function)";
    }
}
