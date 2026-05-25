package com.metaobjects.render;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class ClasspathResourceProviderTest {

    @Test
    public void resolvesClasspathResource() {
        Provider p = new ClasspathResourceProvider(
            Thread.currentThread().getContextClassLoader(),
            "prompts/");
        assertEquals("Welcome, {{name}}!\n", p.resolve("lobby/welcome"));
    }

    @Test
    public void returnsNullForMissingResource() {
        Provider p = new ClasspathResourceProvider(
            Thread.currentThread().getContextClassLoader(),
            "prompts/");
        assertNull(p.resolve("nope/none"));
    }

    @Test(expected = NullPointerException.class)
    public void rejectsNullClassLoader() {
        new ClasspathResourceProvider(null, "prompts/");
    }
}
