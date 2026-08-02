package com.metaobjects.loader;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

/**
 * #233 — the {@code activeLoaders} concurrency-protection key must be scoped to a
 * single loader INSTANCE, not to its class/subType/name. Two reactor modules that
 * configure a {@code <loader>} with the same name would otherwise share one
 * {@code init()} future — module B's init() returning module A's loader and leaving
 * B's own tree unloaded.
 */
public class LoaderKeyIsolationTest {

    private static MetaDataLoader sameNamed() {
        // Same class + subType + name as any other instance from this factory.
        return new MetaDataLoader(LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, "shared-name");
    }

    @Test
    public void keyIsStableForOneInstance() {
        MetaDataLoader a = sameNamed();
        assertEquals("same instance must produce the same key (same-instance init dedup)",
                a.buildLoaderKey(), a.buildLoaderKey());
    }

    @Test
    public void keyIsUniqueAcrossInstancesWithIdenticalIdentity() {
        MetaDataLoader a = sameNamed();
        MetaDataLoader b = sameNamed();
        assertNotEquals("two distinct loaders sharing class/subType/name must NOT share an activeLoaders key",
                a.buildLoaderKey(), b.buildLoaderKey());
    }
}
