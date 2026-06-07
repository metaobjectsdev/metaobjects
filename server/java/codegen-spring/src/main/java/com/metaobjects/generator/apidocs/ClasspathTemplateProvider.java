package com.metaobjects.generator.apidocs;

import com.metaobjects.render.Provider;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Render {@link Provider} that resolves api-doc template refs (e.g.
 * {@code "api/entity-api"}) from classpath resources under
 * {@code /templates/<ref>.md.mustache}.
 *
 * <p>These templates are the Java port's own Tier-1 copies (Java-idiomatic — `java`
 * fences, repository/Spring framing); they ship as classpath resources of the
 * codegen-spring module and are adopter-overridable by placing a resource of the
 * same path earlier on the classpath. Resolution is classpath-only (no filesystem
 * I/O), mirroring {@link com.metaobjects.render.FilesystemProvider} but reading the
 * packaged templates rather than an on-disk root.
 *
 * <p>Returns {@code null} when the reference is absent or attempts path traversal —
 * the {@link com.metaobjects.render.Renderer} treats {@code null} as unresolved.
 */
public final class ClasspathTemplateProvider implements Provider {

    private static final String BASE_PREFIX = "templates/";
    private static final String EXTENSION = ".md.mustache";

    private final ClassLoader classLoader;

    public ClasspathTemplateProvider() {
        this(ClasspathTemplateProvider.class.getClassLoader());
    }

    public ClasspathTemplateProvider(ClassLoader classLoader) {
        this.classLoader = classLoader;
    }

    @Override
    public String resolve(String reference) {
        if (reference == null || reference.isEmpty()) {
            return null;
        }
        if (reference.contains("..")) {
            return null;
        }
        String resourcePath = BASE_PREFIX + reference + EXTENSION;
        try (InputStream in = classLoader.getResourceAsStream(resourcePath)) {
            if (in == null) {
                return null;
            }
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return null;
        }
    }
}
