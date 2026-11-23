package com.metaobjects.generator.spring;

import com.metaobjects.generator.writer.CodeWriter;
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
public final class SpringRecordBuilder {

    /** The static factory's name, which a component of the same name would collide with. */
    private static final String FACTORY = "builder";

    /** The nested class's name, which the record itself or a type it references may already use. */
    private static final String BUILDER_CLASS = "Builder";

    /** A type expression naming a simple type {@code Builder}: bare, qualified, or a type argument. */
    private static final Pattern MENTIONS_BUILDER_CLASS =
        Pattern.compile("(^|[^A-Za-z0-9_$])" + BUILDER_CLASS + "([^A-Za-z0-9_$]|$)");

    private SpringRecordBuilder() {}

    /**
     * Write the record-body members: a {@code public static Builder builder()} factory and the
     * nested {@code Builder}, each after a blank line, at the writer's current indent. Writes
     * nothing when there is nothing to build, or when emitting it would not compile: a component
     * named {@code builder} (its accessor and the factory share a signature), a record named
     * {@code Builder} (a nested class may not share its enclosing class's name), or a component
     * type named {@code Builder} (the nested class would shadow it inside the builder).
     *
     * @param recordName the record's simple name
     * @param components {@code [type, name]} pairs in canonical-constructor order
     * @return whether anything was written
     */
    public static boolean writeMembers(CodeWriter w, String recordName, List<String[]> components) {
        if (!applies(recordName, components)) return false;
        w.blank();
        w.line("/** A fluent builder, so a caller can set a subset of the components. */");
        w.line("public static Builder " + FACTORY + "() { return new Builder(); }");
        w.blank();
        w.line("/** Builds a {@link " + recordName + "}; an unset component stays null. */");
        try (CodeWriter.Block b = w.block("public static final class " + BUILDER_CLASS + " {")) {
            for (String[] c : components) w.line("private " + c[0] + " " + c[1] + ";");
            w.blank();
            w.line("private Builder() {}");
            w.blank();
            for (String[] c : components) {
                w.line("public Builder " + c[1] + "(" + c[0] + " v) { this." + c[1] + " = v; return this; }");
            }
            w.blank();
            String args = components.stream().map(c -> c[1]).collect(Collectors.joining(", "));
            w.line("public " + recordName + " build() { return new " + recordName + "(" + args + "); }");
        }
        return true;
    }

    /** Whether a builder is written for {@code recordName} over {@code components} (see {@link #writeMembers}). */
    public static boolean applies(String recordName, List<String[]> components) {
        if (components.isEmpty() || BUILDER_CLASS.equals(recordName)) return false;
        for (String[] c : components) {
            if (FACTORY.equals(c[1]) || MENTIONS_BUILDER_CLASS.matcher(c[0]).find()) return false;
        }
        return true;
    }
}
