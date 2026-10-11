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

    /** Adds {@code -last} to the map-shaped elements of an already-derived list. */
    @SuppressWarnings("unchecked")
    private static java.util.List<Object> withPositionalAccessors(java.util.List<Object> elements) {
        int last = elements.size() - 1;
        for (int i = 0; i < elements.size(); i++) {
            if (elements.get(i) instanceof java.util.Map<?, ?> m) {
                java.util.Map<String, Object> el = (java.util.Map<String, Object>) m;
                el.putIfAbsent(LAST_ACCESSOR, i == last);
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
     * components) and getter-based beans, which covers Kotlin data classes (viewed as the map of
     * their getters and public fields).
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
        if (isViewableBean(payload)) {
            java.util.Map<String, Object> members = new java.util.LinkedHashMap<>();
            for (MemberReader r : readersFor(payload.getClass())) {
                try {
                    members.putIfAbsent(r.name(), r.read(payload));
                } catch (ReflectiveOperationException | RuntimeException e) {
                    // Left out rather than failing the render, as for a record component.
                }
            }
            return withDerivedAccessors(members, depth);
        }
        return payload;
    }

    // A getter-based bean's readable members, resolved ONCE per class like the record accessors.
    // Names are the ones the Mustache engine already resolved on such an object: the getter's own
    // name (getName, isActive), the property name it implies (name,
    // active) and public fields. Only getters are read — a fluent method is never invoked
    // as a side effect of viewing — and nothing declared by Object (so no getClass) is exposed.
    private static final java.util.concurrent.ConcurrentHashMap<Class<?>, MemberReader[]> MEMBERS =
        new java.util.concurrent.ConcurrentHashMap<>();

    private record MemberReader(String name, java.lang.reflect.Method getter, java.lang.reflect.Field field) {
        Object read(Object target) throws ReflectiveOperationException {
            return getter != null ? getter.invoke(target) : field.get(target);
        }
    }

    private static MemberReader[] readersFor(Class<?> type) {
        return MEMBERS.computeIfAbsent(type, c -> {
            java.util.List<MemberReader> readers = new java.util.ArrayList<>();
            for (java.lang.reflect.Method m : c.getMethods()) {
                if (m.getDeclaringClass() == Object.class || m.getParameterCount() != 0
                        || java.lang.reflect.Modifier.isStatic(m.getModifiers())
                        || m.getReturnType() == void.class) continue;
                String n = m.getName();
                String property = n.startsWith("get") ? n.substring(3) : n.startsWith("is") ? n.substring(2) : null;
                if (property == null || property.isEmpty() || !Character.isUpperCase(property.charAt(0))) continue;
                try {
                    m.setAccessible(true);
                } catch (RuntimeException e) {
                    continue;
                }
                readers.add(new MemberReader(n, m, null));
                readers.add(new MemberReader(decapitalize(property), m, null));
            }
            for (java.lang.reflect.Field f : c.getFields()) {
                if (java.lang.reflect.Modifier.isStatic(f.getModifiers())) continue;
                try {
                    f.setAccessible(true);
                } catch (RuntimeException e) {
                    continue;
                }
                readers.add(new MemberReader(f.getName(), null, f));
            }
            return readers.toArray(new MemberReader[0]);
        });
    }

    /** The Java Beans rule: lowercase the first character unless the first two are both upper case. */
    private static String decapitalize(String s) {
        if (s.length() > 1 && Character.isUpperCase(s.charAt(0)) && Character.isUpperCase(s.charAt(1))) return s;
        return Character.toLowerCase(s.charAt(0)) + s.substring(1);
    }

    /** A scalar-like or platform value keeps its own string form; only an application bean is viewed. */
    private static boolean isViewableBean(Object payload) {
        if (payload instanceof Enum<?> || payload instanceof CharSequence || payload instanceof Number
                || payload instanceof Boolean || payload instanceof Character || payload instanceof Iterable<?>) return false;
        String n = payload.getClass().getName();
        return !(n.startsWith("java.") || n.startsWith("javax.") || n.startsWith("jdk.")
                || n.startsWith("kotlin.") || n.startsWith("sun.") || n.startsWith("com.sun."));
    }
}
