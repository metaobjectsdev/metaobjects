package com.metaobjects.render;

/**
 * Single source of truth for the names of the auto-derived boolean accessors a
 * payload record exposes for its optional/collection fields.
 *
 * <p>{@code SpringPayloadGenerator} emits a {@code has<Field>()} instance method
 * for every nullable/possibly-empty payload component (String / List / nested
 * object-reference) so a Mustache prompt can gate a section on presence
 * ({@code {{#hasAbilities}}…{{/hasAbilities}}}) without a hand-written wrapper.
 * These accessors are DERIVED, not declared in the payload YAML — so the static
 * template drift check ({@link Verify}) must recognise them the same way the
 * generator names them. Both consult THIS class so the emitted method name and
 * the accepted section name can never drift apart.
 *
 * <p>Kept in the zero-core-dependency {@code render} module so both the render
 * engine ({@link Verify}) and the codegen generators can share it without a
 * dependency cycle.
 */
public final class PayloadAccessors {

    /** The {@code has} prefix every derived boolean accessor carries. */
    public static final String HAS_PREFIX = "has";

    private PayloadAccessors() { /* no instances */ }

    /**
     * The boolean-accessor method/section name for a payload field:
     * {@code "has" + capitalize(fieldName)} (e.g. {@code abilities} →
     * {@code hasAbilities}). Mirrors {@code SpringPayloadGenerator}'s emission
     * exactly — do not inline a second copy of this rule.
     */
    public static String hasAccessorName(String fieldName) {
        return HAS_PREFIX + capitalize(fieldName);
    }

    /**
     * Capitalize the first character (leaving an already-uppercase first char
     * untouched). Byte-identical to {@code SpringNaming.capitalize} so the
     * accessor name matches the generated method name character-for-character.
     */
    public static String capitalize(String s) {
        if (s == null || s.isEmpty()) return s;
        char c0 = s.charAt(0);
        if (Character.isUpperCase(c0)) return s;
        return Character.toUpperCase(c0) + s.substring(1);
    }

    /**
     * Is {@code value} "present" for the purposes of {@code has<Field>}? Mirrors the
     * emitter's per-type bodies exactly: String → non-null and non-blank; Collection →
     * non-null and non-empty; reference → non-null.
     *
     * <p>Returns {@code null} for numbers and booleans, which the emitter deliberately
     * skips — they are always-present scalars, and a {@code {{#hasCount}}} over an int is
     * drift rather than a conditional. Returning null (rather than false) keeps that
     * distinction: nothing is injected, so the name stays unresolved exactly as it is on a
     * generated record that has no such method.
     */
    public static Boolean accessorValue(Object value) {
        if (value == null) return Boolean.FALSE;
        if (value instanceof CharSequence cs) return !cs.toString().isBlank();
        if (value instanceof Boolean || value instanceof Number) return null;
        if (value instanceof java.util.Collection<?> c) return !c.isEmpty();
        if (value instanceof Object[] a) return a.length > 0;
        return Boolean.TRUE;
    }

    /**
     * A view over {@code payload} carrying its derived {@code has<Field>} accessors,
     * recursively — for MAP-SHAPED payloads only.
     *
     * <p>A generated payload record already answers {@code hasFoo()} by its own emitted
     * method and is returned untouched; this fills the gap for the map/list graphs the
     * runtime and the conformance corpus actually pass. Without it, the SAME payload data
     * renders differently depending on whether it arrived as a record or as a map, which
     * is the divergence the shared {@code render-derived-has-accessor} fixture pins.
     *
     * <p>NON-MUTATING — a render must not change the object it was handed. An AUTHORED key
     * always wins. Recursion follows Mustache's own scoping: every nested map and every
     * collection ELEMENT becomes a context in its own right.
     */
    public static Object withDerivedAccessors(Object payload) {
        return withDerivedAccessors(payload, 0);
    }

    private static Object withDerivedAccessors(Object payload, int depth) {
        if (depth > 32 || payload == null) return payload; // pathological graph
        if (payload instanceof java.util.Map<?, ?> map) {
            java.util.Map<String, Object> out = new java.util.LinkedHashMap<>();
            for (java.util.Map.Entry<?, ?> e : map.entrySet()) {
                if (!(e.getKey() instanceof String k)) continue;
                out.put(k, withDerivedAccessors(e.getValue(), depth + 1));
            }
            for (java.util.Map.Entry<?, ?> e : map.entrySet()) {
                if (!(e.getKey() instanceof String k)) continue;
                String name = hasAccessorName(k);
                if (out.containsKey(name)) continue; // authored wins
                Boolean derived = accessorValue(e.getValue());
                if (derived != null) out.put(name, derived);
            }
            return out;
        }
        if (payload instanceof java.util.List<?> list) {
            java.util.List<Object> out = new java.util.ArrayList<>(list.size());
            for (Object item : list) out.add(withDerivedAccessors(item, depth + 1));
            return out;
        }
        return payload;
    }
}
