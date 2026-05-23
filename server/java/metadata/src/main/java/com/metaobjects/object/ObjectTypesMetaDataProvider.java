package com.metaobjects.object;

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;

/**
 * Object Types MetaData provider with priority 5.
 * Registers the base object type and the entity/value semantic subtypes, each backed by its
 * own implementation class ({@link EntityMetaObject} / {@link ValueMetaObject}); value access
 * uses the shared reflection/map hybrid with an optional {@code @objectAdapter} seam (ADR-0005).
 */
public class ObjectTypesMetaDataProvider implements MetaDataTypeProvider {

    @Override
    public void registerTypes(MetaDataRegistry registry) {
        // FIRST: Register the base object type that all others inherit from
        MetaObject.registerTypes(registry);

        // Semantic subtypes (ADR-0005): object.entity / object.value, each backed by a dedicated
        // impl class. The registry constructs them directly — no per-node representation resolver.
        MetaObject.registerEntityValueTypes(registry);
    }

    @Override
    public String getProviderId() {
        return "object-types";
    }

    @Override
    public String[] getDependencies() {
        // Depends on core base types to ensure metadata.base is available for object.base inheritance
        return new String[]{"core-base-types"};
    }

    @Override
    public String getDescription() {
        return "Object Types MetaData Provider - Registers the base object type and the entity/value semantic subtypes (each backed by a dedicated implementation class)";
    }
}