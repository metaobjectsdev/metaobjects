package com.metaobjects.render.templategen;

/**
 * One emitted file produced by {@link TemplateGenerator}.
 * Cross-port mirror of TS {@code EmittedFile}, Python {@code EmittedFile},
 * C# {@code record EmittedFile(string Path, string Content)}.
 *
 * <p>This is NOT the legacy {@code com.metaobjects.generator.Generator} contract
 * (which writes via {@code execute()} side-effects); this record exists because
 * the cross-port template-generator factory returns its files declaratively.
 */
public record EmittedFile(String path, String content) {}
