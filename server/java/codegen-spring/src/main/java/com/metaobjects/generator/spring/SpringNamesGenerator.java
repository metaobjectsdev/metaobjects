package com.metaobjects.generator.spring;

import com.metaobjects.MetaData;
import com.metaobjects.database.ColumnNaming;
import com.metaobjects.field.MetaField;
import com.metaobjects.generator.EmitsPhysicalNameConstants;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.GeneratorIOWriter;
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.source.MetaSource;
import com.metaobjects.source.SourceResolution;

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
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

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
public class SpringNamesGenerator extends MultiFileDirectGeneratorBase<MetaObject>
        implements EmitsPhysicalNameConstants {

    @Override
    protected Class<MetaObject> getFilterClass() {
        return MetaObject.class;
    }

    @Override
    public void execute(MetaDataLoader loader) {
        parseArgs();
        Path outRoot = Paths.get(outDir.getAbsolutePath());
        String strategy = getArg("columnNaming", ColumnNaming.DEFAULT);
        // Pass 1 — every object that participates in the database (#248).
        Set<String> emitted = new HashSet<>();
        for (MetaObject entity : loader.getMetaObjects()) {
            if (emit(entity, outRoot, strategy, false)) emitted.add(entity.getName());
        }
        // Pass 2 — the abstract bases those participants EXTEND, each carrying the columns
        // it declares so a child states them once rather than restating its parent's.
        //
        // Reached by walking UP from a participant, never by scanning for abstracts: that
        // is what keeps #248 intact. A sourceless object nothing persistable extends — an
        // object.value, say — is not reached, so it acquires no class and no phantom
        // participation.
        for (MetaObject entity : loader.getMetaObjects()) {
            if (!emitted.contains(entity.getName())) continue;
            for (MetaObject sup = namesArtifactSuperOf(entity); sup != null;
                 sup = namesArtifactSuperOf(sup)) {
                // Already emitted, and so is everything above it.
                if (!emitted.add(sup.getName())) break;
                emit(sup, outRoot, strategy, true);
            }
        }
    }

    // -------------------------------------------------------------------------
    // §A2/§A3 — the per-object physical-name resolver. Mirrors Kotlin's
    // KotlinGenUtil.KotlinObjectNames/KotlinFieldNames and C#'s ObjectNames/FieldNames.
    // -------------------------------------------------------------------------

    /** Physical name + logical field name for one field. */
    private record FieldNames(String name, String column) {}

    /**
     * The resolved physical-name shape for an object — what this generator emits.
     *
     * <p>{@code fields} is every field, INHERITED INCLUDED: it is the lookup surface, and a
     * miss on an inherited field is exactly the fallback-to-literal this artifact removes.
     * {@code ownFields} is what the class DECLARES — inherited constants are declared by
     * the super's class and reached through Java's static-member inheritance, so a subtype
     * states each physical name once instead of restating its parent's. That is ADR-0039's
     * ONE sanctioned own-accessor use, in the exact form the ADR names it.</p>
     *
     * <p>{@code kind}/{@code name}/{@code schema} are null and {@code readOnly} false on a
     * FRAGMENT — an abstract base with no source of its own, which contributes columns to
     * its children and has no physical name to carry.</p>
     *
     * <p>{@code inheritsSource} is true when the primary source is the SUPER'S rather than
     * declared here (a TPH subtype sharing its base's single table). Reference identity of
     * the resolved source NODE, never an equality test on the resolved strings: a
     * divergence guard is precisely what this codebase forbids at a substitution site, and
     * the question being asked is structural.</p>
     */
    private record ObjectNames(
            String kind, String name, String schema, boolean readOnly,
            Map<String, FieldNames> fields, Map<String, FieldNames> ownFields,
            MetaObject superObject, boolean inheritsSource) {}

    /**
     * §A2/§A3 — the ONE place a data name is resolved for a generator run. Returns
     * {@code null} when {@code obj} has no primary source — #248: participation in the
     * database derives from a declared primary source, never from the object subtype.
     */
    static ObjectNames resolveObjectNames(MetaObject obj, String strategy) {
        // primaryRdbSource, not a scan of our own: it carries the divergence refusal that
        // used to live in this method, and it lives in the metadata module so that OMDB
        // and every other generator inherit it too. This method runs only when the
        // `names` generator is in the run, so a refusal that lived only here was no
        // refusal at all -- see SourceResolution's class doc.
        MetaSource source = SourceResolution.primaryRdbSource(obj);
        if (source == null) return null;

        // ADR-0039: getMetaFields() is the RESOLVING accessor (includeParentData
        // defaults to true) -- an inherited @column must resolve here, or the emitted
        // constant would disagree with the column a hand-written consumer binds to.
        Map<String, FieldNames> fields = fieldMap(obj.getMetaFields(), strategy);
        // ADR-0039's sanctioned own-accessor use: what this class DECLARES. See ObjectNames.
        Map<String, FieldNames> ownFields = fieldMap(obj.getMetaFields(false), strategy);

        MetaObject superObject = namesArtifactSuperOf(obj);
        boolean inheritsSource = superObject != null
            && SourceResolution.primaryRdbSource(superObject) == source;

        String name = source.getPhysicalName();

        return new ObjectNames(
            // getEffectiveKind(), not a hand-rolled kind list -- derived from the
            // source's own logic so a second read-only-kind list here can't drift.
            source.getEffectiveKind(), name, source.getSchema(), source.isReadOnly(),
            fields, ownFields, superObject, inheritsSource);
    }

    private static Map<String, FieldNames> fieldMap(Collection<MetaField> src, String strategy) {
        Map<String, FieldNames> out = new LinkedHashMap<>();
        for (MetaField field : src) {
            out.put(field.getName(), new FieldNames(field.getName(), ColumnNaming.resolve(field, strategy)));
        }
        return out;
    }

    /**
     * The nearest ancestor of {@code obj} carrying a names class of its own, or null.
     *
     * <p>Walks PAST an ancestor with nothing to contribute — an abstract marker with no
     * fields and no source emits no class, so there is nothing to extend and the search
     * continues upward rather than stopping at a type that does not exist.</p>
     */
    static MetaObject namesArtifactSuperOf(MetaObject obj) {
        for (MetaData cur = obj.getSuperData(); cur != null; cur = cur.getSuperData()) {
            if (cur instanceof MetaObject candidate
                && (!candidate.getMetaFields(false).isEmpty()
                    || SourceResolution.primaryRdbSource(candidate) != null)) {
                return candidate;
            }
        }
        return null;
    }

    /**
     * The names FRAGMENT for an object that a sourced object extends but which declares no
     * source of its own — the {@code BaseEntity} pattern: shared fields, no table.
     *
     * <p>Separate from {@link #resolveObjectNames} on purpose, and the separation is the
     * #248 rule intact rather than weakened. "Has a primary source" still decides whether
     * an object is a database participant, so an {@code object.value} carrying fields
     * resolves to nothing here as it always has. A fragment is emitted only for an object
     * REACHED from a participant by walking {@code extends} upward — the only context in
     * which its fields are columns at all. It carries no kind/name/schema/readOnly, because
     * it has no physical name and must never acquire one.</p>
     *
     * <p>Returns null when the object declares no fields of its own: an abstract marker has
     * nothing to extend, and emitting an empty class for it would put a name in the package
     * that says nothing.</p>
     */
    static ObjectNames resolveSuperFragmentNames(MetaObject obj, String strategy) {
        Collection<MetaField> own = obj.getMetaFields(false);
        if (own.isEmpty()) return null;
        return new ObjectNames(
            null, null, null, false,
            fieldMap(obj.getMetaFields(), strategy), fieldMap(own, strategy),
            namesArtifactSuperOf(obj), false);
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

    /** @return true when a file was written. */
    protected boolean emit(MetaObject entity, Path outRoot, String strategy, boolean fragment) {
        ObjectNames names = fragment
            ? resolveSuperFragmentNames(entity, strategy)
            : resolveObjectNames(entity, strategy);
        if (names == null) return false; // #248: no primary source -- nothing to emit.

        String[] split = SpringNaming.splitFqn(entity.getName());
        String pkg = split[0];
        String shortName = split[1];
        String className = SpringNaming.namesName(shortName);

        // The class DECLARES only its own columns when it has a base to inherit the rest
        // from; without one it must declare every field it describes, because a consumer
        // looks a column up by field name and an inherited one has to be there.
        String superClass = names.superObject() == null
            ? null
            : SpringNaming.namesName(SpringNaming.splitFqn(names.superObject().getName())[1]);
        Map<String, FieldNames> declared = superClass == null ? names.fields() : names.ownFields();

        // [member, field, column], sorted by field name.
        List<String[]> rows = new ArrayList<>();
        for (FieldNames f : declared.values()) {
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
        // `abstract`, not `final`: this class is now a base other names classes extend
        // rather than restate. Java inherits static members, so `CopayAuthNames.ID_COLUMN`
        // resolves through the base and every consumption site is unchanged; `abstract`
        // keeps the "no instances" guarantee `final` + a private constructor used to give,
        // while still allowing a subclass.
        src.append("public abstract class ").append(className);
        if (superClass != null) src.append(" extends ").append(superClass);
        src.append(" {\n\n");

        // A fragment has no source, so no KIND/NAME/SCHEMA/READ_ONLY — it must never acquire
        // a physical name it never declared. A TPH subtype INHERITS its base's source, so
        // those come from the base class rather than being restated here.
        if (!fragment && !names.inheritsSource()) {
        src.append("    public static final String KIND = \"").append(names.kind()).append("\";\n");
        src.append("    public static final String NAME = \"").append(names.name()).append("\";\n");
        // Omitted entirely when undeclared -- never emitted as a null/empty literal.
        // Absent means undeclared; a `null` constant would read as "declared blank".
        if (names.schema() != null && !names.schema().isEmpty()) {
            src.append("    public static final String SCHEMA = \"").append(names.schema()).append("\";\n");
        }
        src.append("    public static final boolean READ_ONLY = ").append(names.readOnly()).append(";\n\n");
        }

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
        //
        // It stays COMPLETE — every field, inherited included — because it is the lookup
        // surface, and a miss on an inherited field is exactly the fallback-to-literal this
        // artifact removes. It repeats no LITERAL: an inherited entry's value is the base's
        // own constant, reached through Java's static-member inheritance. Hiding the base's
        // field of the same name is what makes <Sub>Names.COLUMNS_BY_FIELD the complete one.
        List<String[]> allRows = new ArrayList<>();
        for (FieldNames f : names.fields().values()) {
            allRows.add(new String[] { namesMember(f.name()), f.name(), f.column() });
        }
        allRows.sort((a, b) -> a[1].compareTo(b[1]));
        src.append("\n    public static final Map<String, String> COLUMNS_BY_FIELD = Map.ofEntries(\n");
        for (int i = 0; i < allRows.size(); i++) {
            String[] row = allRows.get(i);
            src.append("        Map.entry(\"").append(row[1]).append("\", ").append(row[0]).append("_COLUMN)");
            src.append(i < allRows.size() - 1 ? ",\n" : "\n");
        }
        src.append("    );\n");

        // No instances -- pure constants holder. PROTECTED, not private: a subclass's
        // implicit constructor calls super(), and a private one made every generated
        // subclass fail to compile ("XNames() has private access"). The class is abstract,
        // so this cannot construct one either way.
        src.append("\n    protected ").append(className).append("() {}\n");
        src.append("}\n");

        try {
            Path outFile = outRoot.resolve(pkg.replace('.', '/')).resolve(className + ".java");
            GeneratedFileWriter.write(outFile, src.toString());
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing " + className + ".java for entity " + entity.getName() + ": " + e, e);
        }
        return true;
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
