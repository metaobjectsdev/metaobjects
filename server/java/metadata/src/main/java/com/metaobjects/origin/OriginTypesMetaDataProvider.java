package com.metaobjects.origin;

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;

/**
 * Origin Types MetaData provider.
 *
 * <p>Registers the abstract {@code origin.base} type plus the concrete subtypes
 * {@code origin.passthrough}, {@code origin.aggregate}, {@code origin.collection},
 * {@code origin.computed}, and {@code origin.first}. Depends on {@code core-types}
 * for {@code metadata.base} inheritance.</p>
 *
 * <p>Discovered via the standard {@link MetaDataTypeProvider} ServiceLoader
 * mechanism — wired through
 * {@code META-INF/services/com.metaobjects.registry.MetaDataTypeProvider}.</p>
 */
public class OriginTypesMetaDataProvider implements MetaDataTypeProvider {

    @Override
    public void registerTypes(MetaDataRegistry registry) {
        // Register abstract base type first (declares the union of attrs).
        MetaOrigin.registerTypes(registry);

        // Register concrete origin subtypes.
        PassthroughOrigin.registerTypes(registry);
        AggregateOrigin.registerTypes(registry);
        CollectionOrigin.registerTypes(registry);
        ComputedOrigin.registerTypes(registry);
        FirstOrigin.registerTypes(registry);
    }

    @Override
    public String getProviderId() {
        return "origin-types";
    }

    @Override
    public String[] getDependencies() {
        return new String[]{"core-types"};
    }

    @Override
    public String getDescription() {
        return "Origin Types (passthrough / aggregate / collection / computed / first — field-level provenance)";
    }
}
