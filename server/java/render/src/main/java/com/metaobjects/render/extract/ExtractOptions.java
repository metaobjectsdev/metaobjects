package com.metaobjects.render.extract;

import java.util.Map;
import java.util.function.Function;

/**
 * Bounded runtime override surface (the "20%"). aliases/normalizers are MERGED with the
 * schema's, runtime winning on key conflict. onField is the single per-field bespoke-coercion
 * hook; onLocate is the single document-level (payload-location) hook.
 *
 * <p>{@code rootless} (XML only): when {@code true}, the input has NO enclosing root element —
 * the payload's fields ARE the top-level elements (a flat sequence like
 * {@code <a>..</a><b>..</b>}). The engine parses those top-level elements directly instead of
 * locating a {@code <rootName>} span, so the caller need not synthesize a wrapper. No effect for
 * JSON. Default {@code false} (a single root element is expected, as before).</p>
 */
public record ExtractOptions(
        Tolerance tolerance,
        Map<String, String> aliases,
        Map<String, Function<String, Object>> normalizers,
        OnField onField,
        OnLocate onLocate,
        boolean rootless) {

    /** ctx carries the field path and the FieldSpec; return null to fall through to default coercion. */
    @FunctionalInterface
    public interface OnField {
        Object coerce(String fieldPath, String rawValue, FieldSpec spec);
    }

    /**
     * FR-364: the document-level locate hook. Receives the RAW reply text (never null — see
     * {@link Extract#extract}) and the schema's declared {@link Format}; returns the substring
     * that is the payload, or {@code null} to fall back to the default locator (the
     * fenced-then-first-object rule #363 fixed). A non-null return is parsed by the normal
     * pipeline exactly like a default-located span — tolerance, coercion, {@code normalizers},
     * and {@code onField} downstream are unaffected — so this hook only decides WHICH text is
     * the payload, never how it is parsed. The returned text need not be a literal substring of
     * the input (the hook may synthesize it). A thrown exception propagates (it is not
     * swallowed), matching {@code onField}.
     */
    @FunctionalInterface
    public interface OnLocate {
        String locate(String text, Format format);
    }

    public ExtractOptions {
        tolerance = tolerance == null ? Tolerance.NORMAL : tolerance;
        aliases = aliases == null ? Map.of() : Map.copyOf(aliases);
        normalizers = normalizers == null ? Map.of() : Map.copyOf(normalizers);
    }

    public static ExtractOptions defaults() {
        return new ExtractOptions(Tolerance.NORMAL, Map.of(), Map.of(), null, null, false);
    }

    public ExtractOptions withTolerance(Tolerance t) {
        return new ExtractOptions(t, aliases, normalizers, onField, onLocate, rootless);
    }

    /** The single document-level locate hook. See {@link OnLocate}. Returns a copy with
     *  {@code onLocate} set. */
    public ExtractOptions withOnLocate(OnLocate hook) {
        return new ExtractOptions(tolerance, aliases, normalizers, onField, hook, rootless);
    }

    /** XML only: parse a rootless flat element sequence directly (no wrapper root). See the
     *  record javadoc. Returns a copy with {@code rootless} set. */
    public ExtractOptions withRootless(boolean r) {
        return new ExtractOptions(tolerance, aliases, normalizers, onField, onLocate, r);
    }
}
