package com.metaobjects.generator.util;

import java.util.Set;

/**
 * The names Java will not accept where a generator wants to put a metadata field name, and
 * the escape for them. <b>One definition, for every Java emitter in every module</b> — the
 * POJO/interface writer in this module and the record-based Spring emitters in
 * {@code codegen-spring}, which reach it through
 * {@code com.metaobjects.generator.spring.runtime.RecordComponentNames}.
 *
 * <p>The sets are separate because the two restrictions are, and an emitter needs different
 * ones depending on where the name lands:
 *
 * <ul>
 *   <li>{@link #isKeyword} — JLS 3.9. Illegal as ANY identifier, so it is a PARSE error:
 *       {@code setClass(String class)}, or a record component declared {@code String class}.
 *       A get/is/set prefix shields the accessor NAME from this but not the parameter, and a
 *       record component has no prefix at all, so the field name IS the identifier.</li>
 *   <li>{@link #isObjectNoArgMethod} — JLS 8.10.3, the no-argument methods of
 *       {@code Object}. Legal as an identifier, illegal as a no-arg MEMBER: the accessor
 *       would have to override a final method. {@code equals} is absent deliberately — it
 *       takes a parameter, so {@code equals()} does not override it.</li>
 * </ul>
 *
 * <p>Keeping both here is what stops the halves drifting apart: the escape was first written
 * for record components ({@code notify}) and separately for POJO parameters ({@code class}),
 * and each fix left the other emitter still generating code that would not compile.
 *
 * <p>This is a JAVA restriction, not a metamodel one. {@code notify} and {@code class} are
 * legal field names in every port, and the escape never reaches the wire — callers pair it
 * with a {@code @JsonProperty} pinned to the declared name.
 */
public final class JavaIdentifiers {

    private JavaIdentifiers() { /* no instances */ }

    /**
     * JLS 3.9 keywords plus the three literals. Contextual keywords ({@code var},
     * {@code record}, {@code yield}, {@code sealed}, {@code permits}) are deliberately absent:
     * they are legal identifiers, and escaping them would rename a field that compiles today.
     */
    private static final Set<String> KEYWORDS = Set.of(
        "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class",
        "const", "continue", "default", "do", "double", "else", "enum", "extends", "final",
        "finally", "float", "for", "goto", "if", "implements", "import", "instanceof", "int",
        "interface", "long", "native", "new", "package", "private", "protected", "public",
        "return", "short", "static", "strictfp", "super", "switch", "synchronized", "this",
        "throw", "throws", "transient", "try", "void", "volatile", "while",
        "true", "false", "null");

    /** The no-argument methods of {@code Object} (JLS 8.10.3). */
    private static final Set<String> OBJECT_NO_ARG_METHODS = Set.of(
        "clone", "finalize", "getClass", "hashCode", "notify", "notifyAll", "toString", "wait");

    /** Whether {@code name} is a Java keyword or literal, and so illegal as any identifier. */
    private static boolean isKeyword(String name) {
        return KEYWORDS.contains(name);
    }

    /** Whether {@code name} is a no-argument method of {@code Object}. */
    private static boolean isObjectNoArgMethod(String name) {
        return OBJECT_NO_ARG_METHODS.contains(name);
    }

    /**
     * Whether {@code name} can be a no-argument MEMBER — a record component, a bare accessor,
     * an interface method. Either restriction disqualifies it.
     */
    public static boolean isIllegalMemberName(String name) {
        return isKeyword(name) || isObjectNoArgMethod(name);
    }

    /**
     * {@code name} escaped for use as a no-argument member, else unchanged.
     *
     * <p>A trailing underscore: the one transformation that cannot turn one legal metadata
     * name into another port's identifier convention, and that reads at the call site as
     * deliberate rather than as a typo.
     */
    public static String escapeMember(String name) {
        return isIllegalMemberName(name) ? name + "_" : name;
    }

    /**
     * {@code name} escaped for use as a plain identifier (a parameter, a local), else
     * unchanged. Narrower than {@link #escapeMember} on purpose: a parameter named
     * {@code getClass} or {@code notify} is perfectly legal, and escaping it would rename
     * something that compiles.
     */
    public static String escapeIdentifier(String name) {
        return isKeyword(name) ? name + "_" : name;
    }
}
