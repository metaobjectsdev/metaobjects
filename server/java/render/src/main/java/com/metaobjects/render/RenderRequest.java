package com.metaobjects.render;

import java.util.List;

/**
 * Inputs to {@link Renderer#render(RenderRequest)}.
 *
 * <p>Either {@link #template} (inline body) or {@link #ref} (resolved via
 * {@link #provider}) must be set — never both. {@link #payload} and
 * {@link #provider} are required. Optional: {@link #format} (default
 * {@code "text"}), {@link #verify} (drift-guard payload field tree),
 * {@link #maxChars} (output truncation).
 *
 * <p>Mirrors {@code server/csharp/MetaObjects.Render/Renderer.cs}
 * {@code RenderRequest}.
 */
public record RenderRequest(
    String template,
    String ref,
    Object payload,
    Provider provider,
    String format,
    List<PayloadField> verify,
    Integer maxChars
) {
    /** Convenience constructor — ref-based, defaults format="text", no verify/maxChars. */
    public static RenderRequest of(String ref, Object payload, Provider provider) {
        return new RenderRequest(null, ref, payload, provider, Escapers.FORMAT_TEXT, null, null);
    }
}
