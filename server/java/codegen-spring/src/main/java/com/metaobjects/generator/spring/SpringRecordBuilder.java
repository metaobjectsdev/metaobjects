package com.metaobjects.generator.spring;

import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * The fluent builder a generated Java {@code record} carries, so a caller can set a subset of
 * its components (the Java-record half of #365).
 *
 * <p>A record offers exactly one way in: its canonical constructor, with every component, in
 * order. A caller setting 3 of 14 passes 14 arguments, 11 of them {@code null}, and the call
 * site breaks whenever a component is added. Records have no default values to soften that. The
 * builder is a plain nested class (deliberately NOT Lombok: generated code must not force an
 * annotation processor on an adopter), mirroring the Kotlin port's generated {@code Builder}.</p>
 *
 * <p>{@code build()} calls the canonical constructor and adds no checks of its own. A Java
 * record component accepts {@code null} and the constraints are Jakarta Validation annotations
 * enforced at validation time, so the builder admits exactly what the constructor admits. That
 * differs from Kotlin, where a non-null constructor parameter forces {@code requireNotNull}.</p>
 */
final class SpringRecordBuilder {

    /** The static factory's name, which a component of the same name would collide with. */
    private static final String FACTORY = "builder";

    /** The nested class's name, which the record itself or a type it references may already use. */
    private static final String BUILDER_CLASS = "Builder";

    /** A type expression naming a simple type {@code Builder}: bare, qualified, or a type argument. */
    private static final Pattern MENTIONS_BUILDER_CLASS =
        Pattern.compile("(^|[^A-Za-z0-9_$])" + BUILDER_CLASS + "([^A-Za-z0-9_$]|$)");

    private SpringRecordBuilder() {}

    /**
     * The record-body members: a {@code public static Builder builder()} factory and the nested
     * {@code Builder}. Empty when there is nothing to build, or when emitting it would not compile:
     * a component named {@code builder} (its accessor and the factory share a signature), a record
     * named {@code Builder} (a nested class may not share its enclosing class's name), or a component
     * type named {@code Builder} (the nested class would shadow it inside the builder).
     *
     * @param recordName the record's simple name
     * @param components {@code [type, name]} pairs in canonical-constructor order
     */
    static String members(String recordName, List<String[]> components) {
        if (components.isEmpty() || BUILDER_CLASS.equals(recordName)) return "";
        for (String[] c : components) {
            if (FACTORY.equals(c[1]) || MENTIONS_BUILDER_CLASS.matcher(c[0]).find()) return "";
        }
        StringBuilder b = new StringBuilder();
        b.append('\n')
         .append("    /** A fluent builder, so a caller can set a subset of the components. */\n")
         .append("    public static Builder ").append(FACTORY).append("() { return new Builder(); }\n")
         .append('\n')
         .append("    /** Builds a {@link ").append(recordName).append("}; an unset component stays null. */\n")
         .append("    public static final class Builder {\n");
        for (String[] c : components) {
            b.append("        private ").append(c[0]).append(' ').append(c[1]).append(";\n");
        }
        b.append('\n').append("        private Builder() {}\n").append('\n');
        for (String[] c : components) {
            b.append("        public Builder ").append(c[1]).append('(').append(c[0]).append(" v) { this.")
             .append(c[1]).append(" = v; return this; }\n");
        }
        String args = components.stream().map(c -> c[1]).collect(Collectors.joining(", "));
        b.append('\n')
         .append("        public ").append(recordName).append(" build() { return new ")
         .append(recordName).append('(').append(args).append("); }\n")
         .append("    }\n");
        return b.toString();
    }
}
