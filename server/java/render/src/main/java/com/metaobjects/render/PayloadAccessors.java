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
}
