package com.metaobjects.generator.spring.runtime;

import com.metaobjects.generator.util.JavaIdentifiers;

/**
 * The field names Java will not accept as a record component, and the escape generated code
 * uses for them. Two restrictions, both applied (the sets are {@link JavaIdentifiers}'):
 * a KEYWORD ({@code class}, {@code int}, …) cannot be an identifier at all, so the component
 * is a parse error; and a no-argument method of {@code Object} ({@code notify},
 * {@code toString}, …) cannot be one either, because the component's accessor would have to
 * override a final method (JLS 8.10.3). {@code equals} is absent deliberately: it takes a
 * parameter, so {@code equals()} does not override it and the name stays legal.
 *
 * <p><b>Why this lives in the runtime package rather than only in the generator.</b> The rule
 * is needed at BOTH times. At generation time it picks the Java identifier; at run time the
 * generated PATCH handler needs it too, because that handler validates a patch body by
 * iterating {@code assignedValues()} — whose keys are the DECLARED wire names — and passing
 * each key to {@code Validator#validateValue(Class, String property, Object)}. Bean Validation
 * resolves a record's property by its COMPONENT name, so an unescaped {@code "notify"} is not a
 * property of the generated record and {@code validateValue} throws
 * {@code IllegalArgumentException} — a 500 on any PATCH touching that field. Deriving the name
 * with this function keeps the generated controller free of per-entity state, and keeping the
 * SET here rather than in two places means the build-time and run-time answers cannot drift.
 *
 * <p>This is a JAVA restriction, not a metamodel one. {@code notify} is a legal field name in
 * every port — the shared fitness corpus declares one — and the WIRE name is unaffected: the
 * generated record pairs the escape with {@code @JsonProperty("<declared>")}.
 */
public final class RecordComponentNames {

    private RecordComponentNames() { /* no instances */ }

    /**
     * Whether a record component named {@code fieldName} would fail to compile — either
     * restriction disqualifies it. The sets live in {@link JavaIdentifiers} so this module and
     * the POJO writer in {@code codegen-base} cannot answer the question differently; they
     * once did, and each fix left the other emitter still generating uncompilable code.
     */
    public static boolean isReserved(String fieldName) {
        return JavaIdentifiers.isIllegalMemberName(fieldName);
    }

    /**
     * The Java identifier a record component must use for a field called {@code fieldName}.
     *
     * <p>Escapes with a trailing underscore — the one transformation that cannot turn one legal
     * metadata name into another port's identifier convention, and that reads at the call site
     * as deliberate rather than as a typo.
     */
    public static String escape(String fieldName) {
        return JavaIdentifiers.escapeMember(fieldName);
    }
}
