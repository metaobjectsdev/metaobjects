package com.metaobjects.render;

/**
 * Resolves a logical template reference (typically {@code group/source}) to
 * template text. The render engine never does I/O directly — it delegates
 * resolution to the injected {@code Provider}, so a fixed provider makes
 * {@link Renderer#render(RenderRequest)} deterministic.
 *
 * <p>Returns {@code null} when the reference can't be resolved. Render-time
 * code distinguishes "no provider supplied" from "provider returned null" —
 * the latter triggers {@code ERR_PARTIAL_UNRESOLVED} for partials.
 *
 * <p>Ported from {@code server/typescript/packages/render/src/provider.ts}
 * and {@code server/csharp/MetaObjects.Render/Provider.cs}.
 */
public interface Provider {

    /**
     * Resolve a logical reference to its template text, or {@code null} when
     * the reference doesn't exist.
     */
    String resolve(String reference);
}
