package com.metaobjects.generator.spring;

import com.metaobjects.MetaData;
import com.metaobjects.database.ColumnNaming;
import com.metaobjects.database.IndexNaming;
import com.metaobjects.field.MetaField;
import com.metaobjects.generator.EmitsPhysicalNameConstants;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.GeneratorIOWriter;
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.identity.MetaIdentity;
import com.metaobjects.index.Index;
import com.metaobjects.index.LookupIndex;
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
 * <h2>The artifact MIRRORS THE METADATA TREE</h2>
 *
 * <p>It used to be flat, and one member carried the cost. {@code NAME} held a table, a view
 * and a stored procedure depending on the object, told apart only by a sibling {@code KIND},
 * and in none of them did it hold the object's own name. A consumer reading {@code NAME}
 * could not know what kind of database object it had without reading a second member.</p>
 *
 * <p>Every node now carries its own {@code TYPE}, {@code SUB_TYPE} and {@code NAME}, and a
 * physical name sits under the member that says what it IS —
 * {@code SOURCE_PRIMARY_TABLE}, {@code SOURCE_REPLICA_VIEW}, {@code SOURCE_PRIMARY_PROC} —
 * using {@link MetaSource#PHYSICAL_NAME_ATTR_BY_KIND}, the metamodel's own FR-016/ADR-0018
 * alias map, so the artifact spells a physical name the way the metadata that declared it
 * does. Sources are keyed by effective {@code @role}, which is what finally gives a
 * WRITE-THROUGH entity's replica view a member of its own: it declares two physical names
 * and the artifact carried one.</p>
 *
 * <p>{@code TYPE}/{@code SUB_TYPE} are on every node but a FIELD, and the exception is the
 * point rather than an oversight: a field's subType does not change what its column
 * denotes, while an object's decides table-vs-view and an identity's decides
 * unique-vs-not — ADR-0040 put uniqueness in the type rather than in an attribute, so
 * {@code IDENTITY_<N>_SUB_TYPE} is the only thing distinguishing a unique alternate key
 * from a non-unique lookup. Fields keep the {@code <UPPER>_FIELD} / {@code <UPPER>_COLUMN}
 * pair they always had.</p>
 *
 * <p>{@code READ_ONLY} is REMOVED rather than relocated. It was never metadata — it is a
 * derivation over {@code @kind} ({@code MetaSource.isReadOnly()}) — and a sweep of all five
 * ports found zero consumers, generated or hand-written. An artifact that mirrors the tree
 * carries what was declared; a reader who wants read-only-ness asks
 * {@code SOURCE_<ROLE>_KIND}.</p>
 *
 * <p>An {@code INDEX} member is carried only where a SHARED resolver produces it —
 * {@code identity.secondary} and {@code index.lookup}, via {@link IndexNaming}. It is
 * deliberately absent on {@code identity.primary}, because no such name exists to carry:
 * migrate hardcodes {@code <table>_pkey} on Postgres, emits an unnamed PK on SQLite, and no
 * port's codegen names a primary key at all. Carrying it would restate a migrate-only,
 * dialect-conditional formula in an artifact whose entire promise is that a name is spelled
 * once — the #293 defect, re-created by the mechanism built to prevent it. It is absent on
 * {@code identity.reference} for the same reason unless a constraint name is declared.</p>
 *
 * <p>Mirrors the shipped Kotlin {@code KotlinNamesGenerator} /
 * {@code KotlinGenUtil.resolveObjectNames}, the C# {@code NamesGenerator} /
 * {@code CSharpNaming.ResolveObjectNames} and the TypeScript reference
 * ({@code codegen-ts/src/names.ts}) member for member, with Java's casing
 * (SCREAMING_SNAKE members, matching {@code SpringFilterAllowlistGenerator}'s idiom rather
 * than introducing a new one).</p>
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
                // "Fragment" means "declares no source", DERIVED rather than asserted:
                // this walk reaches a TPH base, which owns the shared table, and a
                // fragment emits no source members at all.
                emit(sup, outRoot, strategy,
                    SourceResolution.primaryRdbSource(sup) == null);
            }
        }
    }

    // -------------------------------------------------------------------------
    // §A2/§A3 — the per-object physical-name resolver. Mirrors Kotlin's
    // KotlinGenUtil.KotlinObjectNames and C#'s ObjectNames.
    // -------------------------------------------------------------------------

    /** Physical name + logical field name for one field. */
    private record FieldNames(String name, String column) {}

    /**
     * One {@code source.rdb} child, under the ROLE it plays.
     *
     * <p>{@code alias} is the member-name segment the physical name is carried under —
     * {@code table}, {@code view}, {@code materializedView}, {@code proc},
     * {@code function} — and it is not invented here: it is
     * {@link MetaSource#PHYSICAL_NAME_ATTR_BY_KIND}, the same map the canonical serializer
     * rewrites through. A local switch would be a second answer to a question the metamodel
     * already answers, and a sixth {@code @kind} would then need an edit here to be spelled
     * correctly.</p>
     */
    private record SourceNames(
            String type, String subType, String kind, String schema,
            String alias, String physicalName) {}

    /**
     * One {@code identity.*} or {@code index.*} child.
     *
     * <p>{@code index} — the database name — is present only for {@code identity.secondary}
     * and {@code index.lookup}; see the class doc for why {@code identity.primary} has none
     * to carry.</p>
     */
    private record KeyNames(String type, String subType, String name, String index) {}

    /**
     * The resolved physical-name shape for an object — what this generator emits.
     *
     * <p>Each collection has an ALL form and an OWN form. The ALL form is the lookup surface
     * — every field, source, identity and index the object resolves, inherited included —
     * because a miss on an inherited member is exactly the fallback-to-literal this artifact
     * removes. The OWN form is what the class DECLARES: inherited constants are declared by
     * the super's class and reached through Java's static-member inheritance, so a subtype
     * states each physical name once instead of restating its parent's. That is ADR-0039's
     * ONE sanctioned own-accessor use, in the exact form the ADR names it.</p>
     *
     * <p>{@code sources} is EMPTY on a FRAGMENT — an abstract base with no source of its
     * own, which contributes columns to its children and must never acquire a physical name
     * it never declared.</p>
     *
     * <p>There is no separate {@code inheritsSource} flag, and its absence is the own/all
     * split doing its job rather than an omission. A TPH subtype sharing its base's single
     * table declares no source of its own, so {@code ownSources} is EMPTY and the members
     * come from the base by static inheritance — which is the same structural question
     * ("did this object declare a source, or is it using its parent's?") answered by the
     * accessor that already had to be consulted, instead of by a second derivation that
     * could disagree with it.</p>
     */
    private record ObjectNames(
            String type, String subType, String name,
            Map<String, SourceNames> sources, Map<String, SourceNames> ownSources,
            Map<String, FieldNames> fields, Map<String, FieldNames> ownFields,
            Map<String, KeyNames> identities, Map<String, KeyNames> ownIdentities,
            Map<String, KeyNames> indexes, Map<String, KeyNames> ownIndexes,
            MetaObject superObject) {}

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

        return new ObjectNames(
            obj.getType(), obj.getSubType(),
            // The object's OWN name. The physical name is reached through
            // SOURCE_<ROLE>_<ALIAS>, which is the point of the restructure: one member
            // stopped meaning a table, a view and a procedure depending on the object.
            obj.getShortName(),
            sourcesOf(obj, true), sourcesOf(obj, false),
            // ADR-0039: getMetaFields() is the RESOLVING accessor (includeParentData
            // defaults to true) -- an inherited @column must resolve here, or the emitted
            // constant would disagree with the column a hand-written consumer binds to.
            fieldMap(obj.getMetaFields(), strategy), fieldMap(obj.getMetaFields(false), strategy),
            keysOf(obj.getIdentities(true)), keysOf(obj.getIdentities(false)),
            keysOf(obj.getChildren(LookupIndex.class, true)),
            keysOf(obj.getChildren(LookupIndex.class, false)),
            namesArtifactSuperOf(obj));
    }

    /**
     * Every {@code source.rdb} child of {@code obj}, keyed by effective role.
     *
     * <p>Role is the honest axis: the loader requires exactly one primary, and every
     * consumer that binds a second source picks it by role.</p>
     */
    private static Map<String, SourceNames> sourcesOf(MetaObject obj, boolean includeParentData) {
        Map<String, SourceNames> out = new LinkedHashMap<>();
        // ADR-0039: getSources(true) resolves through `extends`; getSources(false) is the
        // sanctioned own-only twin for "what does THIS class declare".
        for (MetaSource src : obj.getSources(includeParentData)) {
            String role = src.getRole();
            SourceNames resolved = sourceNamesOf(src);
            SourceNames existing = out.get(role);
            if (existing == null) {
                out.put(role, resolved);
                continue;
            }
            // The refusal is about DISAGREEMENT, not about the count — deliberately the
            // SAME rule SourceResolution already enforces for the physical name, rather
            // than a stricter one invented here. An abstract base and the child that
            // extends it may each declare a `@role: primary` source naming the same
            // relation; that is legal today and refusing it would make this artifact
            // stricter than the invariant it exists to serve.
            //
            // Two sources in one role that resolve DIFFERENTLY is the real problem, and
            // silently keeping one is the failure mode this artifact makes impossible: the
            // second name is carried nowhere, read by nobody, and the binding quietly takes
            // the first's.
            if (!existing.equals(resolved)) {
                throw new GeneratorException(
                    obj.getName() + " declares more than one source.rdb with @role: \"" + role
                        + "\", and they do not agree: " + existing + " vs " + resolved
                        + ". The names artifact keys sources by role, so the second has "
                        + "nowhere to go.");
            }
        }
        return out;
    }

    /**
     * One source node's names, keyed by the metamodel's own kind-to-alias map.
     *
     * <p>{@code READ_ONLY} is deliberately NOT carried here — see the class doc.</p>
     */
    private static SourceNames sourceNamesOf(MetaSource source) {
        // getEffectiveKind(), not a hand-rolled kind list -- derived from the source's own
        // logic so a second read-only-kind list here can't drift.
        String kind = source.getEffectiveKind();
        String schema = source.getSchema();
        return new SourceNames(
            source.getType(), source.getSubType(), kind,
            schema == null || schema.isEmpty() ? null : schema,
            // The metamodel's map, never a local switch.
            MetaSource.PHYSICAL_NAME_ATTR_BY_KIND.get(kind),
            source.getPhysicalName());
    }

    /**
     * The node types whose database index name the artifact carries.
     *
     * <p>A closed set rather than "anything with a name", because the rule is narrow and
     * worth stating: the artifact carries a physical name only where ONE resolver, shared
     * by every consumer, produces it. See the class doc.</p>
     */
    private static final Set<String> INDEX_NAMED_SUBTYPES = Set.of(
        MetaIdentity.TYPE_IDENTITY + "." + MetaIdentity.SUBTYPE_SECONDARY,
        Index.TYPE_INDEX + "." + Index.SUBTYPE_LOOKUP);

    /** Every {@code identity.*} / {@code index.*} child, keyed by metamodel name. */
    private static Map<String, KeyNames> keysOf(Collection<? extends MetaData> nodes) {
        Map<String, KeyNames> out = new LinkedHashMap<>();
        for (MetaData node : nodes) {
            // IndexNaming owns BOTH the package strip and the empty-name refusal, so the
            // artifact and any DDL a consumer writes cannot disagree about what an index is
            // called -- and the Kotlin Exposed emitter, which used to answer this question
            // with a local `shortName ?: name`, now goes through the same door.
            boolean named = INDEX_NAMED_SUBTYPES.contains(node.getType() + "." + node.getSubType());
            out.put(node.getShortName(), new KeyNames(
                node.getType(), node.getSubType(), node.getShortName(),
                named ? IndexNaming.resolve(node) : null));
        }
        return out;
    }

    private static Map<String, FieldNames> fieldMap(Collection<MetaField> src, String strategy) {
        Map<String, FieldNames> out = new LinkedHashMap<>();
        for (MetaField field : src) {
            out.put(field.getName(), new FieldNames(field.getName(), ColumnNaming.resolve(field, strategy)));
        }
        return out;
    }

    /**
     * Whether {@code obj} DECLARES anything a names class carries.
     *
     * <p>One predicate, because the class has four collections and the two places that ask
     * this question must agree about all four. They used to ask about fields alone, and the
     * cost was precise: an intermediate abstract declaring only an {@code identity.secondary}
     * — a key hoisted onto a chain, which is the whole reason such a node exists — answered
     * "no". {@link #namesArtifactSuperOf} then walked past it and
     * {@link #resolveSuperFragmentNames} emitted nothing for it, so its key appeared in
     * NEITHER the child's own map nor the grandparent's, while the generated code still
     * referenced it.</p>
     *
     * <p>ADR-0039: the own-only accessors are correct HERE — the question is what this node
     * declares, not what it can see. An inherited key belongs to the ancestor that declared
     * it and is reached through that ancestor's class.</p>
     */
    private static boolean declaresNamesContent(MetaObject obj) {
        return !obj.getMetaFields(false).isEmpty()
            || !obj.getIdentities(false).isEmpty()
            || !obj.getChildren(LookupIndex.class, false).isEmpty();
    }

    /**
     * The nearest ancestor of {@code obj} carrying a names class of its own, or null.
     *
     * <p>Walks PAST an ancestor with nothing to contribute — an abstract marker with no
     * fields, no keys and no source emits no class, so there is nothing to extend and the
     * search continues upward rather than stopping at a type that does not exist.</p>
     */
    static MetaObject namesArtifactSuperOf(MetaObject obj) {
        for (MetaData cur = obj.getSuperData(); cur != null; cur = cur.getSuperData()) {
            if (cur instanceof MetaObject candidate
                && (declaresNamesContent(candidate)
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
     * which its fields are columns at all. It carries NO source, because it has no physical
     * name and must never acquire one.</p>
     *
     * <p>Returns null when the object declares nothing of its own: an abstract marker has
     * nothing to extend, and emitting an empty class for it would put a name in the package
     * that says nothing. "Nothing" is {@link #declaresNamesContent} — fields OR keys, the
     * same question {@link #namesArtifactSuperOf} asks, so the walk and the emit cannot
     * disagree about which ancestors exist.</p>
     */
    static ObjectNames resolveSuperFragmentNames(MetaObject obj, String strategy) {
        if (!declaresNamesContent(obj)) return null;
        Collection<MetaField> own = obj.getMetaFields(false);
        return new ObjectNames(
            obj.getType(), obj.getSubType(), obj.getShortName(),
            Map.of(), Map.of(),
            fieldMap(obj.getMetaFields(), strategy), fieldMap(own, strategy),
            keysOf(obj.getIdentities(true)), keysOf(obj.getIdentities(false)),
            keysOf(obj.getChildren(LookupIndex.class, true)),
            keysOf(obj.getChildren(LookupIndex.class, false)),
            namesArtifactSuperOf(obj));
    }

    /**
     * SCREAMING_SNAKE member-name segment: the same camel-to-snake algorithm
     * {@link ColumnNaming} already uses for the {@code snake_case} column strategy,
     * uppercased. Kept local to this generator (not hoisted onto {@link SpringNaming})
     * since it names a constant INSIDE one generated file, not a generated class/method
     * name other generators need to reference.
     */
    static String namesMember(String name) {
        return ColumnNaming.toSnakeCase(name).toUpperCase(Locale.ROOT);
    }

    /**
     * One emitted constant: its member name, its Java literal, the node path it came from,
     * and the collection it belongs to.
     *
     * <p>{@code section} exists only so the emitted file keeps the tree's shape visually —
     * one blank line between the object's own identity, its sources, its fields, its
     * identities and its indexes. It is never read as data.</p>
     */
    private record Member(String member, String literal, String path, String section) {}

    private static Member str(String member, String value, String path, String section) {
        return new Member(member, "\"" + value + "\"", path, section);
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

        String superClass = names.superObject() == null
            ? null
            : SpringNaming.namesName(SpringNaming.splitFqn(names.superObject().getName())[1]);

        // Two nodes whose SCREAMING_SNAKE member forms collide would emit duplicate
        // constants. javac would refuse to compile the file, but the error would name a
        // generated .java and read as a codegen bug rather than a model one. Fail here,
        // naming the entity and both offending node paths instead.
        //
        // Checked over the WHOLE resolved member set, never just what this class declares:
        // once a child stopped restating its inherited constants, an own-only check could no
        // longer see a collision that spans the `extends` boundary — and javac would not
        // catch it either, because a subclass field HIDES the inherited one rather than
        // clashing with it. The file would compile while COLUMNS_BY_FIELD mapped the
        // inherited field name to the child's column.
        //
        // Over the WHOLE set rather than per collection, too, because the emitted class has
        // ONE flat namespace — a per-collection check would be four checks that each pass
        // while the file still fails to compile. What keeps the collections from colliding
        // with EACH OTHER is not this loop but the member prefix, which is derived from the
        // node's own metamodel type (`IDENTITY_`, `INDEX_`, `SOURCE_`) rather than chosen:
        // an identity and an index of the same name land under different prefixes by
        // construction. What this loop catches beyond fields is two nodes of the SAME type
        // whose names snake-fold together — `by_name` and `byName`, both `IDENTITY_BY_NAME_*`.
        refuseCollidingMembers(entity, membersOf(names, true));

        // The class DECLARES only its own members when it has a base to inherit the rest
        // from; without one it must declare everything it describes, because a consumer
        // looks a column up by field name and an inherited one has to be there.
        List<Member> declared = membersOf(names, superClass == null);

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

        String section = null;
        for (Member m : declared) {
            if (section != null && !section.equals(m.section())) src.append("\n");
            section = m.section();
            src.append("    public static final String ").append(m.member())
               .append(" = ").append(m.literal()).append(";\n");
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
            allRows.add(new String[] { namesMember(f.name()), f.name() });
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

    /**
     * Every constant this class describes, in emission order.
     *
     * <p>{@code all} selects the RESOLVED set (used for the collision guard, and for the
     * declaration set of a class with no base) over the OWN set (what a class with a base
     * declares, reaching the rest through static inheritance).</p>
     *
     * <p>The object's own {@code TYPE}/{@code SUB_TYPE}/{@code NAME} are always declared,
     * base or no base: they differ per object, and static hiding is what makes
     * {@code CarNames.NAME} say {@code "Car"} while {@code VehicleNames.NAME} says
     * {@code "Vehicle"}. The SOURCE block is the mirror image and needs no special case —
     * a TPH subtype declares no own source, so the own set is empty and the base's members
     * are what a consumer reaches.</p>
     */
    private static List<Member> membersOf(ObjectNames names, boolean all) {
        List<Member> out = new ArrayList<>();
        String self = names.name();
        out.add(str("TYPE", names.type(), self, "self"));
        out.add(str("SUB_TYPE", names.subType(), self, "self"));
        out.add(str("NAME", names.name(), self, "self"));

        Map<String, SourceNames> sources = all ? names.sources() : names.ownSources();
        for (String role : sorted(sources)) {
            SourceNames s = sources.get(role);
            String prefix = namesMember(s.type()) + "_" + namesMember(role) + "_";
            String path = self + ".sources." + role;
            out.add(str(prefix + "TYPE", s.type(), path, "sources"));
            out.add(str(prefix + "SUB_TYPE", s.subType(), path, "sources"));
            out.add(str(prefix + "KIND", s.kind(), path, "sources"));
            // Omitted entirely when undeclared -- never emitted as a null/empty literal.
            // Absent means undeclared; a `null` constant would read as "declared blank".
            if (s.schema() != null) out.add(str(prefix + "SCHEMA", s.schema(), path, "sources"));
            // No alias means a @kind carrying no physical-name slot. Omitting keeps a
            // future @kind from emitting a member holding "null".
            if (s.alias() != null && s.physicalName() != null) {
                out.add(str(prefix + namesMember(s.alias()), s.physicalName(), path, "sources"));
            }
        }

        Map<String, FieldNames> fields = all ? names.fields() : names.ownFields();
        for (String name : sorted(fields)) {
            FieldNames f = fields.get(name);
            String member = namesMember(f.name());
            String path = self + ".fields." + f.name();
            out.add(str(member + "_FIELD", f.name(), path, "fields"));
            out.add(str(member + "_COLUMN", f.column(), path, "fields"));
        }

        addKeys(out, self, "identities", all ? names.identities() : names.ownIdentities());
        addKeys(out, self, "indexes", all ? names.indexes() : names.ownIndexes());
        return out;
    }

    private static void addKeys(
            List<Member> out, String self, String label, Map<String, KeyNames> keys) {
        for (String name : sorted(keys)) {
            KeyNames k = keys.get(name);
            // The prefix comes from the node's own metamodel TYPE -- `IDENTITY_`, `INDEX_`
            // -- rather than from a literal, so the member and the tree agree by
            // construction.
            String prefix = namesMember(k.type()) + "_" + namesMember(k.name()) + "_";
            String path = self + "." + label + "." + k.name();
            out.add(str(prefix + "TYPE", k.type(), path, label));
            out.add(str(prefix + "SUB_TYPE", k.subType(), path, label));
            out.add(str(prefix + "NAME", k.name(), path, label));
            if (k.index() != null) out.add(str(prefix + "INDEX", k.index(), path, label));
        }
    }

    private static List<String> sorted(Map<String, ?> m) {
        List<String> keys = new ArrayList<>(m.keySet());
        keys.sort(String::compareTo);
        return keys;
    }

    private static void refuseCollidingMembers(MetaObject entity, List<Member> members) {
        Map<String, List<String>> pathsByMember = new LinkedHashMap<>();
        for (Member m : members) {
            List<String> paths = pathsByMember.computeIfAbsent(m.member(), k -> new ArrayList<>());
            // One node contributes several members and may legitimately repeat a path; only
            // TWO DISTINCT nodes yielding one member is a collision.
            if (!paths.contains(m.path())) paths.add(m.path());
        }
        for (Map.Entry<String, List<String>> e : pathsByMember.entrySet()) {
            if (e.getValue().size() > 1) {
                throw new GeneratorException(
                    entity.getName() + ": " + String.join(", ", e.getValue())
                        + " all yield the constant member '" + e.getKey()
                        + "'. Rename one, or give a field an explicit @column.");
            }
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
