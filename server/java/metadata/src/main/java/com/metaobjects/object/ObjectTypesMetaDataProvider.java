package com.metaobjects.object;

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;

/**
 * Object Types MetaData provider with priority 5.
 * Registers the base object type and the entity/value semantic subtypes; the representation
 * classes (Pojo/Mapped/Proxy) are resolver-selected at load time, not registered subtypes (ADR-0005).
 */
public class ObjectTypesMetaDataProvider implements MetaDataTypeProvider {

    @Override
    public void registerTypes(MetaDataRegistry registry) {
        // FIRST: Register the base object type that all others inherit from
        MetaObject.registerTypes(registry);

        // Semantic subtypes (ADR-0005): object.entity / object.value. No dedicated impl class —
        // the loader instantiates the resolver-chosen representation (Pojo/Mapped/Proxy).
        // The Pojo/Mapped/Proxy subtypes are NO LONGER registered; those classes survive only
        // as resolver-selected representation impls.
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
        return "Object Types MetaData Provider - Registers the base object type and the entity/value semantic subtypes (representations are resolver-selected, not registered subtypes)";
    }
}