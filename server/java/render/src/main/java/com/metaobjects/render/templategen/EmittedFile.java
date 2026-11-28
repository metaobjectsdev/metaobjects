package com.metaobjects.render.templategen;

/**
 * One emitted file produced by {@link TemplateGenerator}.
 * Cross-port mirror of TS {@code EmittedFile}, Python {@code EmittedFile},
 * C# {@code record EmittedFile(string Path, string Content)}.
 *
 * <p>This is NOT the legacy {@code com.metaobjects.generator.Generator} contract
 * (which writes via {@code execute()} side-effects); this record exists because
 * the cross-port template-generator factory returns its files declaratively.
 *
 * <p>{@code sourceNode} is the resolution key of the one metadata node the file was rendered
 * from, recorded in the hash manifest; {@code null} for a per-package or per-model file.
 */
public record EmittedFile(String path, String content, String sourceNode) {
    /** A file rendered from the whole model or a package: no {@code sourceNode}. */
    public EmittedFile(String path, String content) {
        this(path, content, null);
    }
}
