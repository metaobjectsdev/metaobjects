package com.metaobjects.origin;

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;

/**
 * Origin Types MetaData provider.
 *
 * <p>Registers the abstract {@code origin.base} type plus the concrete subtypes
 * {@code origin.passthrough}, {@code origin.aggregate}, {@code origin.computed},
 * and {@code origin.first}. Depends on {@code core-types} for
 * {@code metadata.base} inheritance.</p>
 *
 * <p>{@code origin.collection} was RESERVED-NOT-REGISTERED by FR-037 R2 (#336):
 * it duplicated {@code origin.aggregate @agg:collect} on a smaller attr set and
 * nothing ever dispatched on it. Re-entry bar: ADR-0007 Amendment 2.</p>
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
