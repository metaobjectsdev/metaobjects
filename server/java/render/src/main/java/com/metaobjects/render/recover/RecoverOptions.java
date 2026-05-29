package com.metaobjects.render.recover;

import java.util.Map;
import java.util.function.Function;

/**
 * Bounded runtime override surface (the "20%"). aliases/normalizers are MERGED with the
 * schema's, runtime winning on key conflict. onField is the single bespoke-coercion hook.
 */
public record RecoverOptions(
        Tolerance tolerance,
        Map<String, String> aliases,
        Map<String, Function<String, Object>> normalizers,
        OnField onField) {

    /** ctx carries the field path and the FieldSpec; return null to fall through to default coercion. */
    @FunctionalInterface
    public interface OnField {
        Object coerce(String fieldPath, String rawValue, FieldSpec spec);
    }

    public RecoverOptions {
        tolerance = tolerance == null ? Tolerance.NORMAL : tolerance;
        aliases = aliases == null ? Map.of() : Map.copyOf(aliases);
        normalizers = normalizers == null ? Map.of() : Map.copyOf(normalizers);
    }

    public static RecoverOptions defaults() {
        return new RecoverOptions(Tolerance.NORMAL, Map.of(), Map.of(), null);
    }

    public RecoverOptions withTolerance(Tolerance t) {
        return new RecoverOptions(t, aliases, normalizers, onField);
    }
}
