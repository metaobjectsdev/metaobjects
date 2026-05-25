package com.metaobjects.render;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Objects;

/**
 * Resolves template references from classpath resources, e.g.
 * {@code new ClasspathResourceProvider(cl, "prompts/").resolve("lobby/welcome")}
 * reads {@code classpath:prompts/lobby/welcome.mustache}.
 *
 * <p>Path traversal ({@code ..}) is rejected by returning {@code null}.
 */
public final class ClasspathResourceProvider implements Provider {

    private final ClassLoader classLoader;
    private final String basePrefix;
    private final String extension;

    public ClasspathResourceProvider(ClassLoader classLoader, String basePrefix) {
        this(classLoader, basePrefix, ".mustache");
    }

    public ClasspathResourceProvider(ClassLoader classLoader, String basePrefix, String extension) {
        this.classLoader = Objects.requireNonNull(classLoader, "classLoader");
        this.basePrefix = basePrefix == null ? "" : basePrefix;
        this.extension = Objects.requireNonNull(extension, "extension");
    }

    @Override
    public String resolve(String reference) {
        if (reference == null || reference.isEmpty()) return null;
        if (reference.contains("..")) return null;

        String resourcePath = basePrefix + reference + extension;
        try (InputStream in = classLoader.getResourceAsStream(resourcePath)) {
            if (in == null) return null;
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return null;
        }
    }
}
