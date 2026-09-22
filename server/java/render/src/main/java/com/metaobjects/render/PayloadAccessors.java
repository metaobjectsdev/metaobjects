package com.metaobjects.render;

/**
 * Single source of truth for the names of the auto-derived boolean accessors a
 * payload exposes for its optional/collection fields.
 *
 * <p>The render engine derives a {@code has<Field>} section for every nullable/possibly-empty
 * payload field (String / List / nested object) so a Mustache prompt can gate a section on
 * presence ({@code {{#hasAbilities}}…{{/hasAbilities}}}) without a hand-written wrapper —
 * whether the payload arrives as a map or as the value object's generated record
 * ({@link #withDerivedAccessors}). These accessors are DERIVED, not declared in the payload
 * metadata — so the static template drift check ({@link Verify}) must recognise them the same
 * way the engine names them. Both consult THIS class so the derived name and the accepted
 * section name can never drift apart.
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
     * {@code hasAbilities}). The one naming rule the engine (derivation) and {@link Verify}
     * (acceptance) both call — do not inline a second copy of this rule.
     */
    public static String hasAccessorName(String fieldName) {
        return HAS_PREFIX + capitalize(fieldName);
    }

    /**
     * Capitalize the first character (leaving an already-uppercase first char
     * untouched). Byte-identical to {@code SpringNaming.capitalize}, the JVM codegen
     * spelling of the same rule.
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
        if (value instanceof java.util.Map<?, ?>) return Boolean.TRUE;
        if (value instanceof java.util.Collection<?> c) return !c.isEmpty();
        // getLength covers primitive arrays too; Object[] alone reported an empty
        // int[] as present, where every other port reports absent.
        if (value.getClass().isArray()) return java.lang.reflect.Array.getLength(value) > 0;
        return Boolean.TRUE;
    }

    /**
     * A view over {@code payload} carrying its derived {@code has<Field>} accessors,
     * recursively — for map-shaped payloads and Java records (viewed as the map of their
     * components).
     *
     * <p>Without it, the SAME payload data renders differently depending on the shape it
     * arrived in, which is the divergence the shared {@code render-derived-has-accessor} fixture
     * pins. Records need it since ADR-0056: a payload is the value object's own record, which
     * declares no {@code hasFoo()} method (the template-tier payload copy that emitted one is
     * gone).
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
        // A Java RECORD is viewed as the map of its components. Since ADR-0056 a template's payload
        // is the value object's own record, which declares no has<Field>() methods of its own (the
        // template-tier payload copy that emitted them is gone), so the engine derives them here
        // exactly as it does for a map — the same data renders the same whatever its shape.
        if (payload instanceof Record rec) {
            java.util.Map<String, Object> components = new java.util.LinkedHashMap<>();
            for (java.lang.reflect.RecordComponent rc : rec.getClass().getRecordComponents()) {
                try {
                    java.lang.reflect.Method accessor = rc.getAccessor();
                    accessor.setAccessible(true);
                    components.put(rc.getName(), accessor.invoke(rec));
                } catch (ReflectiveOperationException | RuntimeException e) {
                    // An inaccessible component is left out rather than failing the render;
                    // Mustache would not have resolved it on the record either.
                }
            }
            return withDerivedAccessors(components, depth);
        }
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
        // Every Collection, not just List — a Set's elements are contexts too, which
        // this method's own contract promises.
        if (payload instanceof java.util.Collection<?> coll) {
            java.util.List<Object> out = new java.util.ArrayList<>(coll.size());
            for (Object item : coll) out.add(withDerivedAccessors(item, depth + 1));
            return out;
        }
        if (payload.getClass().isArray() && !payload.getClass().getComponentType().isPrimitive()) {
            int n = java.lang.reflect.Array.getLength(payload);
            java.util.List<Object> out = new java.util.ArrayList<>(n);
            for (int i = 0; i < n; i++) out.add(withDerivedAccessors(java.lang.reflect.Array.get(payload, i), depth + 1));
            return out;
        }
        return payload;
    }
}
