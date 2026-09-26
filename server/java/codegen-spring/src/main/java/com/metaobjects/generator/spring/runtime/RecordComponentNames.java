package com.metaobjects.generator.spring.runtime;

import java.util.Set;

/**
 * The field names Java will not accept as a record component, and the escape generated code
 * uses for them. Two restrictions, both applied: a KEYWORD ({@code class}, {@code int}, …)
 * cannot be an identifier at all, so the component is a parse error; and a no-argument method
 * of {@code Object} ({@code notify}, {@code toString}, …) cannot be one either, because the
 * component's accessor would have to override a final method (JLS 8.10.3). {@code equals} is
 * absent deliberately: it takes a parameter, so {@code equals()} does not override it and the
 * name stays legal.
 *
 * <p><b>Why this lives in the runtime package rather than only in the generator.</b> The rule
 * is needed at BOTH times. At generation time it picks the Java identifier; at run time the
 * generated PATCH handler needs it too, because that handler validates a patch body by
 * iterating {@code assignedValues()} — whose keys are the DECLARED wire names — and passing
 * each key to {@code Validator#validateValue(Class, String property, Object)}. Bean Validation
 * resolves a record's property by its COMPONENT name, so an unescaped {@code "notify"} is not a
 * property of the generated record and {@code validateValue} throws
 * {@code IllegalArgumentException} — a 500 on any PATCH touching that field. Deriving the name
 * with this function keeps the generated controller free of per-entity state.
 *
 * <p><b>Why the sets are spelled out here and not borrowed.</b> Generated code runs against
 * this class, and {@code mvn metaobjects:eject} hands it to an adopter as plain source they
 * own, so it depends on the JDK alone. The generation-time answer lives in
 * {@code com.metaobjects.generator.util.JavaIdentifiers}; the two must agree, because a
 * component named by one and looked up by the other is the 500 described above.
 * {@code RecordComponentNamesParityTest} fails the build the moment they differ.
 *
 * <p>This is a JAVA restriction, not a metamodel one. {@code notify} is a legal field name in
 * every port — the shared fitness corpus declares one — and the WIRE name is unaffected: the
 * generated record pairs the escape with {@code @JsonProperty("<declared>")}.
 */
public final class RecordComponentNames {

    private RecordComponentNames() { /* no instances */ }

    /**
     * JLS 3.9 keywords plus the three literals. Contextual keywords ({@code var},
     * {@code record}, {@code yield}, {@code sealed}, {@code permits}) are deliberately absent:
     * they are legal identifiers, and escaping them would rename a field that compiles today.
     */
    static final Set<String> KEYWORDS = Set.of(
        "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class",
        "const", "continue", "default", "do", "double", "else", "enum", "extends", "final",
        "finally", "float", "for", "goto", "if", "implements", "import", "instanceof", "int",
        "interface", "long", "native", "new", "package", "private", "protected", "public",
        "return", "short", "static", "strictfp", "super", "switch", "synchronized", "this",
        "throw", "throws", "transient", "try", "void", "volatile", "while",
        "true", "false", "null");

    /** The no-argument methods of {@code Object} (JLS 8.10.3). */
    static final Set<String> OBJECT_NO_ARG_METHODS = Set.of(
        "clone", "finalize", "getClass", "hashCode", "notify", "notifyAll", "toString", "wait");

    /** Whether a record component named {@code fieldName} would fail to compile — either
     *  restriction disqualifies it. */
    public static boolean isReserved(String fieldName) {
        return KEYWORDS.contains(fieldName) || OBJECT_NO_ARG_METHODS.contains(fieldName);
    }

    /**
     * The Java identifier a record component must use for a field called {@code fieldName}.
     *
     * <p>Escapes with a trailing underscore — the one transformation that cannot turn one legal
     * metadata name into another port's identifier convention, and that reads at the call site
     * as deliberate rather than as a typo.
     */
    public static String escape(String fieldName) {
        return isReserved(fieldName) ? fieldName + "_" : fieldName;
    }
}
