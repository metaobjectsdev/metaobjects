package com.metaobjects.registry;

import org.junit.Test;

import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertTrue;

/**
 * Verifies {@link MetaDataRegistry#createWithCoreProviders()} returns an
 * independent, core-populated registry (the building block for per-loader
 * registry isolation).
 */
public class CreateWithCoreProvidersTest {

    @Test
    public void createsIsolatedCorePopulatedRegistry() {
        MetaDataRegistry a = MetaDataRegistry.createWithCoreProviders();
        MetaDataRegistry b = MetaDataRegistry.createWithCoreProviders();

        // Independent instances, neither is the global singleton.
        assertNotSame(a, b);
        assertNotSame(a, MetaDataRegistry.getInstance());

        // Core vocabulary present: object.entity accepts a field.string child.
        assertTrue("core registry should accept field.string under object.entity",
            a.acceptsChild("object", "entity", "field", "string", "someField"));
    }
}
