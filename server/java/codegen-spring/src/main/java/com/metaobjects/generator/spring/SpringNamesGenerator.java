package com.metaobjects.generator.spring;

import com.metaobjects.database.ColumnNaming;
import com.metaobjects.field.MetaField;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.GeneratorIOWriter;
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.source.MetaSource;

import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Generator: one {@code <Entity>Names.java} per object with a declared (or inherited)
 * primary {@code source.rdb} (#248) — GENERATED per-object physical database name
 * constants (spec A1/A2/A6) a hand-written consumer references instead of a string
 * literal.
 *
 * <p><b>Java has nowhere generated to consume this.</b> {@code codegen-spring} emits
 * no physical name anywhere else — the generated {@code <Entity>Dto} record is keyed by
 * logical field names and the generated {@code <Entity>Repository} is an interface the
 * consumer implements (no JPA annotations, no {@code @Table}/{@code @Column}). This
 * artifact exists for the hand-written persistence layer the consumer supplies, not for
 * anything else this toolchain emits.</p>
 *
 * <p>Mirrors the shipped Kotlin {@code KotlinNamesGenerator} /
 * {@code KotlinGenUtil.resolveObjectNames} and the C# {@code NamesGenerator} /
 * {@code CSharpNaming.ResolveObjectNames} member for member, with Java's casing
 * (SCREAMING_SNAKE per-field members, matching {@code SpringFilterAllowlistGenerator}'s
 * idiom rather than introducing a new one).</p>
 *
 * <p>Args:</p>
 * <ul>
 *   <li>{@code outputDir} (required): output directory root.</li>
 *   <li>{@code columnNaming} (optional): the column-naming strategy — one of
 *       {@link ColumnNaming#LITERAL}, {@link ColumnNaming#SNAKE_CASE},
 *       {@link ColumnNaming#KEBAB_CASE}. Defaults to {@link ColumnNaming#DEFAULT}
 *       (literal) — matching {@code ObjectManagerDB}'s runtime resolution, NOT Kotlin's
 *       {@code snake_case} codegen default. A Java artifact defaulting differently from
 *       the Java runtime would itself be the kind of drift this program exists to
 *       remove. Codegen cannot see a runtime {@code setColumnNaming(...)} call on
 *       {@code ObjectManagerDB} — a project pairing that call with this generator must
 *       pass the SAME strategy string to both, by hand (see
 *       {@code docs/features/field-types.md}).</li>
 * </ul>
 */
public class SpringNamesGenerator extends MultiFileDirectGeneratorBase<MetaObject> {

    @Override
    protected Class<MetaObject> getFilterClass() {
        return MetaObject.class;
    }

    @Override
    public void execute(MetaDataLoader loader) {
        parseArgs();
        Path outRoot = Paths.get(outDir.getAbsolutePath());
        String strategy = getArg("columnNaming", ColumnNaming.DEFAULT);
        for (MetaObject entity : loader.getMetaObjects()) {
            emit(entity, outRoot, strategy);
        }
    }

    // -------------------------------------------------------------------------
    // §A2/§A3 — the per-object physical-name resolver. Mirrors Kotlin's
    // KotlinGenUtil.KotlinObjectNames/KotlinFieldNames and C#'s ObjectNames/FieldNames.
    // -------------------------------------------------------------------------

    /** Physical name + logical field name for one field. */
    private record FieldNames(String name, String column) {}

    /** The resolved physical-name shape for an object — what this generator emits. */
    private record ObjectNames(
            String kind, String name, String schema, boolean readOnly,
            Map<String, FieldNames> fields) {}

    /**
     * R27 — the role-scoped PRIMARY {@code source.*} of {@code obj}, resolving through
     * the {@code extends} super chain (ADR-0039): {@code role == primary}, NEVER a
     * role-blind first-declared pick (that is {@link SpringNaming#firstRdbSource}, a
     * DIFFERENT question — "does a table exist to bind to?" — used by the other
     * generators in this package). {@code getSources(true)} is the RESOLVING accessor
     * (an inherited primary source must be seen, or an entity extending an abstract
     * base with its own primary source would wrongly read as unpersisted).
     *
     * @return the primary source, or {@code null} when {@code obj} has no {@code role
     *     == primary} source anywhere in its resolved chain (#248: participation in the
     *     database derives from a declared primary source, never from the object
     *     subtype)
     */
    static MetaSource primaryRdbSource(MetaObject obj) {
        for (MetaSource src : obj.getSources(true)) {
            if (MetaSource.ROLE_PRIMARY.equals(src.getRole())) return src;
        }
        return null;
    }

    /**
     * §A2/§A3 — the ONE place a data name is resolved for a generator run. Returns
     * {@code null} when {@code obj} has no primary source — #248: participation in the
     * database derives from a declared primary source, never from the object subtype.
     */
    static ObjectNames resolveObjectNames(MetaObject obj, String strategy) {
        // The full primary LIST, not just the first: the direction-blind divergence
        // guard below compares every primary against every other. primaryRdbSource
        // returns this list's head.
        List<MetaSource> primaries = new ArrayList<>();
        for (MetaSource src : obj.getSources(true)) {
            if (MetaSource.ROLE_PRIMARY.equals(src.getRole())) primaries.add(src);
        }
        if (primaries.isEmpty()) return null;
        MetaSource source = primaries.get(0);

        // ADR-0039: getMetaFields() is the RESOLVING accessor (includeParentData
        // defaults to true) -- an inherited @column must resolve here, or the emitted
        // constant would disagree with the column a hand-written consumer binds to.
        Map<String, FieldNames> fields = new LinkedHashMap<>();
        for (MetaField field : obj.getMetaFields()) {
            fields.put(field.getName(), new FieldNames(field.getName(), ColumnNaming.resolve(field, strategy)));
        }

        String name = source.getPhysicalName();

        // D4 -- every consumer downstream is meant to reference this name
        // UNCONDITIONALLY, no per-site equality guard. Refuse here instead, once, so
        // nothing downstream has to. Mirrors the Kotlin/C#/TS/Python guard exactly; see
        // KotlinGenUtil.resolveObjectNames for the full reachability analysis, including
        // the two shapes that reach it on metadata loading with ZERO errors and why the
        // check must be DIRECTION-BLIND rather than comparing against the primary
        // WRITABLE source (which can only see a divergence when one primary is
        // read-only, and only when that one is the inherited one).
        List<String> distinct = primaries.stream()
                .map(MetaSource::getPhysicalName).distinct().sorted().toList();
        if (distinct.size() > 1) {
            // Sorted, so the message is identical in every port regardless of source order.
            // Same idiom as the Kotlin sibling implementing this check
            // (KotlinGenUtil: distinct.joinToString(", ") { "\"$it\"" }).
            String joined = distinct.stream()
                    .map(n -> "\"" + n + "\"")
                    .collect(Collectors.joining(", "));
            throw new GeneratorException(
                obj.getName() + ": role=primary sources disagree on the object's physical "
                    + "name -- " + joined + ". Every consumer binds ONE name. Give them "
                    + "matching physical names, or drop the extra role=primary declaration.");
        }

        return new ObjectNames(
            // getEffectiveKind(), not a hand-rolled kind list -- derived from the
            // source's own logic so a second read-only-kind list here can't drift.
            source.getEffectiveKind(), name, source.getSchema(), source.isReadOnly(), fields);
    }

    /**
     * SCREAMING_SNAKE member-name segment for a field: the same camel-to-snake
     * algorithm {@link ColumnNaming} already uses for the {@code snake_case} column
     * strategy, uppercased. Kept local to this generator (not hoisted onto
     * {@link SpringNaming}) since it names a constant INSIDE one generated file, not a
     * generated class/method name other generators need to reference.
     */
    static String namesMember(String fieldName) {
        return ColumnNaming.toSnakeCase(fieldName).toUpperCase(Locale.ROOT);
    }

    protected void emit(MetaObject entity, Path outRoot, String strategy) {
        ObjectNames names = resolveObjectNames(entity, strategy);
        if (names == null) return; // #248: no primary source -- nothing to emit.

        String[] split = SpringNaming.splitFqn(entity.getName());
        String pkg = split[0];
        String shortName = split[1];
        String className = SpringNaming.namesName(shortName);

        // [member, field, column], sorted by field name.
        List<String[]> rows = new ArrayList<>();
        for (FieldNames f : names.fields().values()) {
            rows.add(new String[] { namesMember(f.name()), f.name(), f.column() });
        }
        rows.sort((a, b) -> a[1].compareTo(b[1]));

        // Two fields whose SCREAMING_SNAKE forms collide would emit duplicate constant
        // members. javac would refuse to compile the file, but the error would name a
        // generated .java and read as a codegen bug rather than a model one. Fail here,
        // naming the entity and both offending field names instead.
        Map<String, List<String>> fieldsByMember = new LinkedHashMap<>();
        for (String[] row : rows) {
            fieldsByMember.computeIfAbsent(row[0], k -> new ArrayList<>()).add(row[1]);
        }
        for (Map.Entry<String, List<String>> e : fieldsByMember.entrySet()) {
            if (e.getValue().size() > 1) {
                throw new GeneratorException(
                    entity.getName() + ": fields " + String.join(", ", e.getValue())
                        + " all yield the constant member '" + e.getKey()
                        + "'. Rename one, or give it an explicit @column.");
            }
        }

        StringBuilder src = new StringBuilder();
        if (!pkg.isEmpty()) {
            src.append("package ").append(pkg).append(";\n\n");
        }
        src.append("import java.util.Map;\n\n");
        src.append("/**\n");
        src.append(" * GENERATED — per-object physical database names for ").append(shortName).append(".\n");
        src.append(" */\n");
        src.append("public final class ").append(className).append(" {\n\n");

        src.append("    public static final String KIND = \"").append(names.kind()).append("\";\n");
        src.append("    public static final String NAME = \"").append(names.name()).append("\";\n");
        // Omitted entirely when undeclared -- never emitted as a null/empty literal.
        // Absent means undeclared; a `null` constant would read as "declared blank".
        if (names.schema() != null && !names.schema().isEmpty()) {
            src.append("    public static final String SCHEMA = \"").append(names.schema()).append("\";\n");
        }
        src.append("    public static final boolean READ_ONLY = ").append(names.readOnly()).append(";\n\n");

        for (String[] row : rows) {
            src.append("    public static final String ").append(row[0]).append("_FIELD = \"")
               .append(row[1]).append("\";\n");
            src.append("    public static final String ").append(row[0]).append("_COLUMN = \"")
               .append(row[2]).append("\";\n");
        }

        // The map's values reference the constants rather than repeating the literals --
        // the artifact must not spell a physical name twice inside itself.
        //
        // Map.ofEntries(...), not Map.of(...): Map.of has overloads for 0-10 pairs
        // only, so an object with 11+ fields (AllTypes in the canonical persistence
        // corpus has 21) emitted more argument pairs than any Map.of overload
        // accepts and javac refused the file outright. Map.ofEntries is a single
        // varargs method with no arity ceiling and still returns the same
        // immutable Map contract.
        src.append("\n    public static final Map<String, String> COLUMNS_BY_FIELD = Map.ofEntries(\n");
        for (int i = 0; i < rows.size(); i++) {
            String[] row = rows.get(i);
            src.append("        Map.entry(\"").append(row[1]).append("\", ").append(row[0]).append("_COLUMN)");
            src.append(i < rows.size() - 1 ? ",\n" : "\n");
        }
        src.append("    );\n");

        // No instances -- pure constants holder.
        src.append("\n    private ").append(className).append("() {}\n");
        src.append("}\n");

        try {
            Path outFile = outRoot.resolve(pkg.replace('.', '/')).resolve(className + ".java");
            GeneratedFileWriter.write(outFile, src.toString());
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing " + className + ".java for entity " + entity.getName() + ": " + e, e);
        }
    }

    // === MultiFileDirectGeneratorBase abstract-method stubs ====================
    // execute(MetaDataLoader) is overridden above with its own per-entity loop
    // (matching SpringFilterAllowlistGenerator), so the base class's single-file
    // write path below is never invoked; these are dead-but-required stubs.
    @Override
    protected void writeSingleFile(MetaObject md, GeneratorIOWriter<?> writer) { /* unused */ }

    @Override
    @SuppressWarnings({ "unchecked", "rawtypes" })
    protected <T extends GeneratorIOWriter> T getSingleWriter(
            MetaDataLoader loader, MetaObject md, PrintWriter pw) {
        return null;
    }

    @Override
    @SuppressWarnings({ "unchecked", "rawtypes" })
    protected <T extends GeneratorIOWriter> T getFinalWriter(
            MetaDataLoader loader, OutputStream out) {
        return null;
    }

    @Override
    protected void writeFinalFile(Collection<MetaObject> metadata, GeneratorIOWriter<?> writer) { /* none */ }

    @Override
    protected String getSingleOutputFilePath(MetaObject md) {
        return SpringNaming.splitFqn(md.getName())[0].replace('.', '/');
    }

    @Override
    protected String getSingleOutputFilename(MetaObject md) {
        return SpringNaming.namesName(SpringNaming.splitFqn(md.getName())[1]) + ".java";
    }
}
