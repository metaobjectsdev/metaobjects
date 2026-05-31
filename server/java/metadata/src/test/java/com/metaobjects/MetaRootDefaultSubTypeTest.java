package com.metaobjects;

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.StandardServiceRegistry;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Regression coverage for the {@code metadata.root} default-subType bug that
 * surfaced alongside the Spring Boot fat-jar bootstrap failure.
 *
 * <p>{@link MetaRoot#registerTypes} must register the {@code metadata -> root}
 * default subType (so a bare {@code metadata:} YAML key desugars to
 * {@code metadata.root}) <em>even when the {@code metadata.root} type is already
 * registered</em>. Previously the default-subType assignment sat <em>after</em>
 * the type-registration idempotency guard, so a provider running against a
 * registry that already had the type returned early and never set the default —
 * leaving "type 'metadata' has no default subType" at desugar time.
 */
public class MetaRootDefaultSubTypeTest {

    /**
     * When {@code metadata.root} is already registered but its default subType is
     * not yet set, {@link MetaRoot#registerTypes} must still set it. Without the
     * fix the idempotency guard returns early and {@code defaultSubTypeOf} stays
     * null, so this test fails.
     */
    @Test
    public void registerTypesSetsDefaultSubTypeEvenWhenTypeAlreadyRegistered() {
        // An isolated, un-bootstrapped registry (the ServiceRegistry is never
        // consulted here — we register the type by hand to model the
        // "already registered on another path" precondition).
        MetaDataRegistry registry = new MetaDataRegistry(new StandardServiceRegistry());

        // Precondition: the metadata.root TYPE is registered, but no default subType.
        registry.registerType(MetaRoot.class, def -> def
            .type(MetaData.TYPE_METADATA).subType(MetaData.SUBTYPE_ROOT)
            .description("Root metadata node"));
        assertTrue("precondition: metadata.root type is registered",
            registry.isRegistered(MetaData.TYPE_METADATA, MetaData.SUBTYPE_ROOT));
        assertNull("precondition: no default subType yet",
            registry.defaultSubTypeOf(MetaData.TYPE_METADATA));

        // Running the provider registration against a registry that already has
        // the type must still install the default subType.
        MetaRoot.registerTypes(registry);

        assertEquals("bare 'metadata:' must desugar to metadata.root",
            MetaData.SUBTYPE_ROOT, registry.defaultSubTypeOf(MetaData.TYPE_METADATA));
    }

    /**
     * A registry bootstrapped with the core providers exposes the
     * {@code metadata -> root} default — the normal path that lets a bare
     * {@code metadata:} root desugar.
     */
    @Test
    public void coreProviderBootstrapRegistersDefaultSubType() {
        MetaDataRegistry registry = MetaDataRegistry.createWithCoreProviders();
        assertEquals(MetaData.SUBTYPE_ROOT, registry.defaultSubTypeOf(MetaData.TYPE_METADATA));
    }
}
