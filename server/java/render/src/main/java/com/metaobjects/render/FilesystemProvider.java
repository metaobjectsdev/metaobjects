package com.metaobjects.render;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Objects;

/**
 * Resolves template references from a filesystem root, e.g.
 * {@code resolve("lobby/welcome")} reads {@code <root>/lobby/welcome.mustache}.
 *
 * <p>Path traversal (segments containing {@code ..}) is rejected at resolve
 * time: returns {@code null} rather than throwing, so callers see a clean
 * "unresolved" outcome. A second belt-and-suspenders check confirms the
 * normalized candidate path remains under {@code root}.
 *
 * <p>Mustache only (ADR-0061): a ref whose only body is a Jinja file
 * ({@code .jinja} / {@code .j2} / {@code .jinja2}) throws a {@link RenderException}
 * carrying {@link TemplateEngines#ERR_TEMPLATE_ENGINE_UNSUPPORTED}, and so does a
 * Jinja {@code extension}.
 *
 * <p>Mirrors {@code server/csharp/MetaObjects.Render/FilesystemProvider.cs}.
 */
public final class FilesystemProvider implements Provider {

    private final Path root;
    private final String extension;

    public FilesystemProvider(Path root) {
        this(root, ".mustache");
    }

    public FilesystemProvider(Path root, String extension) {
        this.root = Objects.requireNonNull(root, "root").toAbsolutePath().normalize();
        this.extension = Objects.requireNonNull(extension, "extension");
        TemplateEngines.refuseJinjaExtension(extension);
    }

    @Override
    public String resolve(String reference) {
        if (reference == null || reference.isEmpty()) return null;
        if (reference.contains("..")) return null;  // path-traversal guard

        Path candidate = root.resolve(reference + extension).normalize();
        if (!candidate.startsWith(root)) return null;   // belt-and-suspenders
        if (!Files.isRegularFile(candidate)) {
            TemplateEngines.refuseJinjaSibling(reference, ext -> {
                Path jinja = root.resolve(reference + ext).normalize();
                return jinja.startsWith(root) && Files.isRegularFile(jinja);
            });
            return null;
        }

        try {
            return Files.readString(candidate, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return null;
        }
    }
}
