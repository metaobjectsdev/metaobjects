package com.metaobjects.render;

import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/** ADR-0061: the JVM ports render Mustache only and refuse a Jinja body by name. */
public class TemplateEnginesTest {

    @Test
    public void aJinjaOnlyRefIsRefusedWithTheCode() throws IOException {
        Path root = Files.createTempDirectory("fp-jinja-");
        Files.createDirectories(root.resolve("g"));
        Files.writeString(root.resolve("g/s.j2"), "{{ name }}");
        Provider p = new FilesystemProvider(root);
        RenderException e = assertThrows(RenderException.class, () -> p.resolve("g/s"));
        assertTrue(e.getMessage(), e.getMessage().startsWith(TemplateEngines.ERR_TEMPLATE_ENGINE_UNSUPPORTED + ": g/s.j2"));
    }

    @Test
    public void aMustacheBodyBesideAJinjaOneStillResolves() throws IOException {
        Path root = Files.createTempDirectory("fp-jinja-");
        Files.createDirectories(root.resolve("g"));
        Files.writeString(root.resolve("g/s.mustache"), "M");
        Files.writeString(root.resolve("g/s.jinja"), "J");
        assertEquals("M", new FilesystemProvider(root).resolve("g/s"));
        assertNull(new FilesystemProvider(root).resolve("g/none"));
    }

    @Test
    public void aJinjaExtensionIsRefused() throws IOException {
        Path root = Files.createTempDirectory("fp-jinja-");
        RenderException e = assertThrows(RenderException.class, () -> new FilesystemProvider(root, ".jinja"));
        assertTrue(e.getMessage().startsWith(TemplateEngines.ERR_TEMPLATE_ENGINE_UNSUPPORTED));
        assertThrows(RenderException.class,
            () -> new ClasspathResourceProvider(getClass().getClassLoader(), "", ".J2"));
    }
}
