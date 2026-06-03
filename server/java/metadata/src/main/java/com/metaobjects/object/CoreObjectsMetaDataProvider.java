package com.metaobjects.object;

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;

/**
 * Core objects MetaData type provider.
 *
 * <p>Historically registered a parallel {@code value*} / {@code data*} attribute
 * vocabulary onto {@code object.base} (e.g. {@code valueEqualsBy},
 * {@code valueObjectType}, {@code dataBuilderClass}, {@code dataImmutable}).
 * SP-G Unit 6b removed those registrations: they were vestigial — registered on
 * the metamodel but read by NO runtime, codegen (including the flavored-object
 * generators), or loader path in any module — and they were a Java-only
 * divergence from the cross-port {@code object.*} logical vocabulary
 * ({@code discriminator}/{@code discriminatorValue}; {@code object.value} also
 * carries {@code normalize}). The flavored-object codegen (pojoAware /
 * valueObject) derives its flavor from the generator's own configuration, never
 * from these metamodel attrs.</p>
 *
 * <p>{@code object.entity} / {@code object.value} are owned by the metadata
 * module ({@link EntityMetaObject} / {@link ValueMetaObject}); the retired
 * dynamic {@code object.data} no longer registers here. This provider now
 * contributes no attribute extensions, but remains a registered
 * {@link MetaDataTypeProvider} (service-loaded) as the slot for future
 * object-family extensions and to keep the provider dependency graph stable.</p>
 *
 * <p>Priority: 50 (after base types, before other extensions).</p>
 */
public class CoreObjectsMetaDataProvider implements MetaDataTypeProvider {

    @Override
    public String getProviderId() {
        return "core-object-extensions";
    }

    @Override
    public String[] getDependencies() {
        // Depends on object-types since it extended object.base.
        return new String[]{"object-types"};
    }

    @Override
    public void registerTypes(MetaDataRegistry registry) {
        // No attribute extensions. The former value*/data* registrations were
        // vestigial (zero consumers) and a cross-port vocabulary divergence;
        // removed in SP-G Unit 6b.
    }

    @Override
    public String getDescription() {
        return "Core Objects MetaData Provider (no attribute extensions — value*/data* removed in SP-G Unit 6b)";
    }
}
