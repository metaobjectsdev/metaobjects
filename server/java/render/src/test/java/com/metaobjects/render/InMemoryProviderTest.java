package com.metaobjects.render;

import org.junit.Test;

import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class InMemoryProviderTest {

    @Test
    public void resolvesKnownReference() {
        Provider p = new InMemoryProvider(Map.of("g/s", "hello"));
        assertEquals("hello", p.resolve("g/s"));
    }

    @Test
    public void returnsNullForUnknownReference() {
        Provider p = new InMemoryProvider(Map.of());
        assertNull(p.resolve("nope/none"));
    }
}
