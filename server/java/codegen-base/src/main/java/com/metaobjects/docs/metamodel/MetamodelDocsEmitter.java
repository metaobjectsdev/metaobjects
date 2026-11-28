package com.metaobjects.docs.metamodel;

import com.metaobjects.render.Escapers;
import com.metaobjects.render.Provider;
import com.metaobjects.render.RenderRequest;
import com.metaobjects.render.Renderer;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Renders the metamodel reference pages: {@link MetamodelDocsPages} data through the shared
 * Mustache templates. The one place the {@code metamodel-docs} generators of Java and Kotlin
 * meet, so each is a thin shell naming its arguments.
 *
 * <p>A template ref {@code metamodel/index.md} resolves to {@code <templateDir>/metamodel/index.md.mustache}
 * when a project supplies a template directory, else to the classpath resource
 * {@code metaobjects/templates/metamodel/index.md.mustache}; a same-path resource earlier on the
 * classpath overrides the packaged one.</p>
 */
public final class MetamodelDocsEmitter {

    private static final String CLASSPATH_PREFIX = "metaobjects/templates/";
    private static final String EXTENSION = ".mustache";

    private MetamodelDocsEmitter() {
    }

    /** Every page's content keyed by its path relative to {@code subDir} ("" = the output root). */
    public static Map<String, String> emit(String subDir, Path templateDir) {
        Provider provider = provider(templateDir, MetamodelDocsEmitter.class.getClassLoader());
        Renderer renderer = new Renderer();
        String prefix = subDir == null || subDir.isEmpty() ? "" : subDir.replaceAll("/+$", "") + "/";
        Map<String, String> out = new LinkedHashMap<>();
        for (MetamodelDocsPages.Page page : MetamodelDocsPages.build()) {
            out.put(prefix + page.path(), renderer.render(new RenderRequest(
                    null, page.template(), page.data(), provider, Escapers.FORMAT_MARKDOWN, null, null)));
        }
        return out;
    }

    /** Render pages built elsewhere (the corpus test builds from pinned inputs). */
    public static String render(MetamodelDocsPages.Page page, Provider provider) {
        return new Renderer().render(new RenderRequest(
                null, page.template(), page.data(), provider, Escapers.FORMAT_MARKDOWN, null, null));
    }

    public static Provider provider(Path templateDir, ClassLoader classLoader) {
        return ref -> {
            if (ref == null || ref.isEmpty() || ref.contains("..")) return null;
            if (templateDir != null) {
                Path file = templateDir.resolve(ref + EXTENSION);
                if (Files.isRegularFile(file)) {
                    try {
                        return Files.readString(file, StandardCharsets.UTF_8);
                    } catch (IOException e) {
                        throw new IllegalStateException("metamodel docs: could not read " + file, e);
                    }
                }
            }
            try (InputStream in = classLoader.getResourceAsStream(CLASSPATH_PREFIX + ref + EXTENSION)) {
                return in == null ? null : new String(in.readAllBytes(), StandardCharsets.UTF_8);
            } catch (IOException e) {
                return null;
            }
        };
    }
}
