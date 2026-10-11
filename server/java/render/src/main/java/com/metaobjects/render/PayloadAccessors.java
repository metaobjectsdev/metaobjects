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

    /**
     * The positional accessor injected into every map-shaped ELEMENT of a collection, so a list
     * separator needs no hand-computed {@code last} flag:
     * {@code {{#items}}{{name}}{{^-last}}, {{/-last}}{{/items}}}. The leading {@code -} cannot
     * collide with a field name and is still an ordinary Mustache tag name, so the template stays
     * valid Mustache. A scalar element has nowhere to hold a key and carries none. An authored key
     * of the same name wins, as for {@code has<Field>}.
     */
    public static final String LAST_ACCESSOR = "-last";

    private PayloadAccessors() { /* no instances */ }

    /** Marks each object element of an already-derived list with its {@code -last} position. */
    @SuppressWarnings("unchecked")
    private static java.util.List<Object> withPositionalAccessors(java.util.List<Object> elements) {
        int last = elements.size() - 1;
        for (int i = 0; i < elements.size(); i++) {
            Object el = elements.get(i);
            if (el instanceof TypedView view) {
                view.last = i == last;
            } else if (el instanceof java.util.Map<?, ?> m) {
                ((java.util.Map<String, Object>) m).putIfAbsent(LAST_ACCESSOR, i == last);
            }
        }
        return elements;
    }

    /** True when {@code name} is {@code -last} and the scope is a collection element. */
    public static boolean isPositionalAccessor(boolean inElement, String name) {
        return inElement && LAST_ACCESSOR.equals(name);
    }

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
     * recursively — for map-shaped payloads, Java records (viewed as the map of their
     * components) and any other typed object, which covers getter-based beans and Kotlin data
     * classes (overlaid by a {@code TypedView}: the object's own members, plus the derived names).
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

    // A record class's accessors, resolved ONCE per class. getRecordComponents() returns a
    // defensive copy per call and getAccessor() re-resolves the Method each time — without
    // this cache a record payload was reflected component-by-component on every render of
    // every node. Class shapes are immutable, so no eviction. Mirrors the C# port's
    // WireNameCache (MetaObjects.Render/PayloadAccessors.cs).
    private static final java.util.concurrent.ConcurrentHashMap<Class<?>, RecordAccessor[]> ACCESSORS =
        new java.util.concurrent.ConcurrentHashMap<>();

    private record RecordAccessor(String name, java.lang.reflect.Method getter) {}

    private static RecordAccessor[] accessorsFor(Class<?> recordClass) {
        return ACCESSORS.computeIfAbsent(recordClass, c -> {
            var components = c.getRecordComponents();
            var accessors = new RecordAccessor[components.length];
            for (int i = 0; i < components.length; i++) {
                var getter = components[i].getAccessor();
                getter.setAccessible(true);
                accessors[i] = new RecordAccessor(components[i].getName(), getter);
            }
            return accessors;
        });
    }

    private static Object withDerivedAccessors(Object payload, int depth) {
        if (depth > 32 || payload == null) return payload; // pathological graph
        // A Java RECORD is viewed as the map of its components. Since ADR-0056 a template's payload
        // is the value object's own record, which declares no has<Field>() methods of its own (the
        // template-tier payload copy that emitted them is gone), so the engine derives them here
        // exactly as it does for a map — the same data renders the same whatever its shape.
        if (payload instanceof Record rec) {
            java.util.Map<String, Object> components = new java.util.LinkedHashMap<>();
            for (RecordAccessor a : accessorsFor(rec.getClass())) {
                try {
                    components.put(a.name(), a.getter().invoke(rec));
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
            return withPositionalAccessors(out);
        }
        if (payload.getClass().isArray() && !payload.getClass().getComponentType().isPrimitive()) {
            int n = java.lang.reflect.Array.getLength(payload);
            java.util.List<Object> out = new java.util.ArrayList<>(n);
            for (int i = 0; i < n; i++) out.add(withDerivedAccessors(java.lang.reflect.Array.get(payload, i), depth + 1));
            return withPositionalAccessors(out);
        }
        if (isViewable(payload)) return new TypedView(payload, depth);
        return payload;
    }

    /**
     * A value the engine treats specially by its TYPE — a scalar, an iterable, a lambda — or a
     * platform value is handed over untouched; only an application object is overlaid.
     */
    private static boolean isViewable(Object payload) {
        if (payload instanceof Enum<?> || payload instanceof CharSequence || payload instanceof Number
                || payload instanceof Boolean || payload instanceof Character
                || payload instanceof Iterable<?> || payload instanceof java.util.Iterator<?>
                || payload instanceof java.util.function.Function<?, ?>
                || payload instanceof java.util.concurrent.Callable<?>) return false;
        String n = payload.getClass().getName();
        return !(n.startsWith("java.") || n.startsWith("javax.") || n.startsWith("jdk.") || n.startsWith("kotlin."));
    }

    private static final Object MISSING = new Object();

    // The engine's own member lookup, so a typed object resolves exactly the names it always
    // did: a method by its exact name, getX / isX, and a non-private field.
    private static final com.github.mustachejava.reflect.ReflectionObjectHandler NATIVE =
        new com.github.mustachejava.reflect.ReflectionObjectHandler();

    // One resolved lookup per (class, name). Class shapes are immutable, so no eviction.
    private static final java.util.concurrent.ConcurrentHashMap<Class<?>,
            java.util.concurrent.ConcurrentHashMap<String, com.github.mustachejava.util.Wrapper>> LOOKUPS =
        new java.util.concurrent.ConcurrentHashMap<>();

    /** The value of {@code target}'s own member {@code name}, or {@link #MISSING} when it has none. */
    private static Object ownMember(Object target, String name) {
        java.util.List<Object> scope = java.util.Collections.singletonList(target);
        com.github.mustachejava.util.Wrapper lookup = LOOKUPS
            .computeIfAbsent(target.getClass(), c -> new java.util.concurrent.ConcurrentHashMap<>())
            .computeIfAbsent(name, n -> NATIVE.find(n, scope));
        if (lookup instanceof com.github.mustachejava.reflect.MissingWrapper) return MISSING;
        try {
            return lookup.call(scope);
        } catch (com.github.mustachejava.util.GuardException e) {
            return MISSING;
        }
    }

    /**
     * The derived-accessor overlay of a typed object. To the engine it is a map that holds every
     * name the object itself resolves — read from the object only when the template asks for it —
     * plus the derived {@code has<Field>} and {@code -last}; a name the object has always wins.
     * Its string form is the object's own.
     */
    private static final class TypedView extends java.util.AbstractMap<String, Object> {
        private final Object target;
        private final int depth;
        private Boolean last;

        TypedView(Object target, int depth) {
            this.target = target;
            this.depth = depth;
        }

        private Object resolve(Object key) {
            if (!(key instanceof String name) || name.indexOf('.') >= 0) return MISSING;
            Object own = ownMember(target, name);
            if (own != MISSING) return withDerivedAccessors(own, depth + 1);
            if (LAST_ACCESSOR.equals(name)) return last != null ? last : MISSING;
            if (!name.startsWith(HAS_PREFIX) || name.length() == HAS_PREFIX.length()) return MISSING;
            String rest = name.substring(HAS_PREFIX.length());
            for (String field : new String[] { Character.toLowerCase(rest.charAt(0)) + rest.substring(1), rest }) {
                if (!hasAccessorName(field).equals(name)) continue;
                Object value = ownMember(target, field);
                if (value == MISSING) continue;
                Boolean derived = accessorValue(value);
                if (derived != null) return derived;
            }
            return MISSING;
        }

        @Override public boolean containsKey(Object key) { return resolve(key) != MISSING; }

        @Override public Object get(Object key) {
            Object value = resolve(key);
            return value == MISSING ? null : value;
        }

        @Override public java.util.Set<java.util.Map.Entry<String, Object>> entrySet() {
            return java.util.Collections.emptySet();
        }

        @Override public String toString() { return target.toString(); }

        @Override public boolean equals(Object o) { return o == this; }

        @Override public int hashCode() { return System.identityHashCode(this); }
    }
}
