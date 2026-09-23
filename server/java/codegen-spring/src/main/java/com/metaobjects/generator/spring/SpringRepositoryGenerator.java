package com.metaobjects.generator.spring;

// Eject note (ADR-0034, JVM eject design): these siblings stay in
// com.metaobjects.generator.spring when this generator is copied out via
// `mvn metaobjects:eject` and its own package is renamed — an explicit import, not
// same-package bare-name resolution, is what keeps the ejected copy compiling.
import com.metaobjects.generator.spring.SpringM2mSupport;
import com.metaobjects.generator.spring.SpringNaming;
import com.metaobjects.generator.spring.SpringTypeMapper;
import com.metaobjects.generator.spring.TphPlan;

import com.metaobjects.field.MetaField;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.GeneratorIOWriter;
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
import com.metaobjects.identity.ReferenceIdentity;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.generator.util.RestSurfaceGate;
import com.metaobjects.object.MetaObject;
import com.metaobjects.source.MetaSource;
import com.metaobjects.source.RdbSource;
import static com.metaobjects.generator.spring.SpringNaming.firstRdbSource;

import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Collection;
import java.util.List;
import com.metaobjects.generator.util.GeneratedFileWriter;

/**
 * Generator: one hand-stubbed Java {@code interface} per writable
 * {@code object.entity} ({@code source.rdb @kind="table"}) that the consumer
 * implements with their preferred persistence layer (Spring Data JPA / jOOQ /
 * plain JDBC — all out of MetaObjects' concern).
 *
 * <p>Emitting the interface from codegen gives the
 * {@link SpringControllerGenerator} a stable, typed seam to call without
 * baking a persistence choice into the controller. The {@code SortClause}
 * record lives on this interface (rather than on the controller) so the
 * controller's call site reads {@code AuthorRepository.SortClause}, avoiding
 * a duplicate nested record at the controller level.</p>
 *
 * <p>The same source-kind filter rule as
 * {@link SpringControllerGenerator} applies here: view / materializedView /
 * storedProc / tableFunction are skipped — those entities are read-only and
 * would need a different repository surface (list + get only). Vanilla
 * entities (no {@code source.rdb} child at all) are also skipped — without a
 * source declaration there's no SQL surface to bind to.</p>
 *
 * <p>Args:</p>
 * <ul>
 *   <li>{@code outputDir} (required): output directory root.</li>
 * </ul>
 */
public class SpringRepositoryGenerator extends MultiFileDirectGeneratorBase<MetaObject> {

    @Override
    protected Class<MetaObject> getFilterClass() {
        return MetaObject.class;
    }

    private MetaDataLoader loader;

    @Override
    public void execute(MetaDataLoader loader) {
        parseArgs();
        this.loader = loader;
        Path outRoot = Paths.get(outDir.getAbsolutePath());
        for (MetaObject entity : loader.getMetaObjects()) {
            if (TphPlan.isTphSubtype(entity)) continue; // folded into the base — no own repository
            if (!appliesTo(entity)) continue;
            // F22 — a view-only projection gets a READ-ONLY seam: nothing that writes.
            if (RestSurfaceGate.isReadOnly(entity)) emitReadOnly(entity, outRoot);
            // FR-017 TPH: the discriminator base gets a polymorphic + per-subtype-scoped repository.
            else if (TphPlan.isTphBase(entity, loader)) emitTph(entity, outRoot);
            else emit(entity, outRoot);
        }
    }

    /**
     * True iff this generator emits a repository interface for {@code entity} — the same
     * shared {@link RestSurfaceGate#emitsRestSurface} decision the controller and the
     * filter allowlist make, because the controller delegates to this interface by name.
     *
     * <p>A READ-ONLY view-kind {@code object.projection} (F22) emits a repository too, but
     * a read-only one: list / count / findById and nothing that writes. See
     * {@link #emitReadOnly(MetaObject, Path)}.</p>
     */
    public static boolean appliesTo(MetaObject entity) {
        return RestSurfaceGate.emitsRestSurface(entity);
    }

    protected void emit(MetaObject entity, Path outRoot) {
        String[] split = SpringNaming.splitFqn(entity.getName());
        String pkg = split[0];
        String shortName = split[1];
        String dtoName = SpringNaming.dtoName(shortName);
        String repoName = SpringNaming.repositoryName(shortName);
        // PK type derived from identity.primary (uuid → java.util.UUID, long → Long, …);
        // a hard-coded Long made this interface un-implementable against a uuid-keyed table.
        String pkType = SpringTypeMapper.primaryKeyJavaType(entity);

        StringBuilder src = new StringBuilder();
        if (!pkg.isEmpty()) {
            src.append("package ").append(pkg).append(";\n\n");
        }
        src.append("import com.metaobjects.generator.spring.runtime.FilterPredicate;\n");
        src.append("import java.util.List;\n");
        src.append("import java.util.Optional;\n\n");
        src.append("/**\n");
        src.append(" * GENERATED interface — consumer implements with their preferred persistence layer\n");
        src.append(" * (Spring Data JPA / jOOQ / plain JDBC). The matching ")
           .append(shortName).append("Controller delegates to this interface.\n");
        src.append(" */\n");
        src.append("public interface ").append(repoName).append(" {\n\n");
        src.append("    /** Sort directive parsed from the cross-port ?sort=<field>:asc|desc grammar. */\n");
        src.append("    record SortClause(String field, String direction) {}\n\n");
        src.append("    List<").append(dtoName)
           .append("> list(int limit, int offset, SortClause sort, List<FilterPredicate> filters);\n");
        src.append("    long count(List<FilterPredicate> filters);\n");
        src.append("    Optional<").append(dtoName).append("> findById(").append(pkType).append(" id);\n");
        src.append("    ").append(dtoName).append(" create(").append(dtoName).append(" dto);\n");
        src.append("    Optional<").append(dtoName).append("> update(").append(pkType).append(" id, ")
           .append(dtoName).append(" dto);\n");
        // FR-035: presence-tracked partial update. The <Entity>Patch carries the
        // absent/null/value tristate the full DTO cannot, so an explicit null clears a
        // nullable column (an explicit null on a @required field is rejected at the
        // controller). Same package as the interface — no import needed.
        src.append("    Optional<").append(dtoName).append("> patch(").append(pkType).append(" id, ")
           .append(SpringNaming.patchName(shortName)).append(" patch);\n");
        src.append("    boolean delete(").append(pkType).append(" id);\n");

        // FR-018 M:N finders — one per @cardinality:"many" + @through relationship.
        // The matching controller's GET /{id}/<relationName> sub-resource delegates here.
        // The consumer implements the junction traversal (the runtime M2mJoinResolver helper
        // collapses the three resolution modes once the junction rows are fetched).
        for (SpringM2mSupport.M2mNav nav : SpringM2mSupport.resolve(entity, loader)) {
            src.append("\n    /** M:N traversal: the ").append(nav.targetShortName())
               .append(" rows related to this ").append(shortName)
               .append(" through ").append(nav.junctionShortName());
            if (nav.symmetric()) src.append(" (symmetric — union on read)");
            src.append(targetSubtypeJavadocClause(nav));
            src.append(". */\n");
            src.append("    List<").append(nav.targetDtoType()).append("> ")
               .append(m2mFinderName(nav.relationName())).append("(").append(pkType).append(" sourceId")
               .append(targetSubtypeParam(nav)).append(");\n");
        }

        // ADR-0038 reverse navigation — one finder PAIR per FK this entity holds
        // (each identity.reference). The referenced entity T navigates to its
        // referencing E rows by calling these with a T id. The method name derives
        // from the FK FIELD (PascalCased, trailing `Id` dropped) so same-pair FKs
        // (e.g. GameSession → Scene ×3) yield DISTINCT finders, never colliding —
        // and no @reverseName vocabulary is needed. NOT a lazy @OneToMany collection
        // (N+1 anti-pattern + needs an open session): a single indexed query
        // (WHERE fk = ?) plus a batched variant (WHERE fk IN (…)) for anti-N+1
        // loading of many parents.
        for (ReverseFk fk : reverseFksFor(entity)) {
            src.append("\n    /** Reverse nav: the ").append(shortName)
               .append(" rows whose ").append(fk.fkField())
               .append(" FK points at the given ").append(fk.targetShortName())
               .append(" id (single indexed query). */\n");
            src.append("    List<").append(dtoName).append("> ")
               .append(SpringNaming.reverseFinderName(fk.fkField()))
               .append("(").append(fk.valueType()).append(" ").append(fk.fkField()).append(");\n");
            src.append("    /** Reverse nav (batched, anti-N+1): the ").append(shortName)
               .append(" rows whose ").append(fk.fkField())
               .append(" FK is IN the given ").append(fk.targetShortName())
               .append(" ids. */\n");
            src.append("    List<").append(dtoName).append("> ")
               .append(SpringNaming.reverseFinderInName(fk.fkField()))
               .append("(List<").append(fk.valueType()).append("> ").append(fk.fkField()).append("s);\n");
        }
        src.append("}\n");

        try {
            Path outFile = outRoot.resolve(pkg.replace('.', '/')).resolve(repoName + ".java");
            GeneratedFileWriter.write(outFile, src.toString());
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing " + repoName + ".java for entity " + entity.getName() + ": " + e, e);
        }
    }


    /**
     * F22 — emit the READ-ONLY consumer seam for a view-only {@code object.projection}:
     * {@code list} / {@code count} / {@code findById} and nothing else.
     *
     * <p>Deliberately NOT {@link #emit(MetaObject, Path)} with the write methods elided.
     * An interface is a contract offered to a consumer, and a projection cannot honour
     * {@code create} / {@code update} / {@code patch} / {@code delete} against a SQL view
     * under any implementation — emitting them would ask every adopter to write four
     * methods that must throw. The matching read-only controller calls exactly these
     * three, so the pair stays closed.</p>
     *
     * <p>{@code findById} appears only when the projection is addressable by a
     * single-column primary key, matching the controller's {@code /{id}} routes
     * ({@link RestSurfaceGate#hasItemRoute}).</p>
     */
    protected void emitReadOnly(MetaObject entity, Path outRoot) {
        String[] split = SpringNaming.splitFqn(entity.getName());
        String pkg = split[0];
        String shortName = split[1];
        String dtoName = SpringNaming.dtoName(shortName);
        String repoName = SpringNaming.repositoryName(shortName);
        boolean hasItem = RestSurfaceGate.hasItemRoute(entity);
        String pkType = SpringTypeMapper.primaryKeyJavaType(entity);

        StringBuilder src = new StringBuilder();
        if (!pkg.isEmpty()) {
            src.append("package ").append(pkg).append(";\n\n");
        }
        src.append("import com.metaobjects.generator.spring.runtime.FilterPredicate;\n");
        src.append("import java.util.List;\n");
        if (hasItem) {
            src.append("import java.util.Optional;\n");
        }
        src.append("\n");
        src.append("/**\n");
        src.append(" * GENERATED interface — consumer implements with their preferred persistence layer\n");
        src.append(" * (Spring Data JPA / jOOQ / plain JDBC). The matching ")
           .append(shortName).append("Controller delegates to this interface.\n");
        src.append(" *\n");
        src.append(" * <p>READ-ONLY: ").append(shortName)
           .append(" is a projection over a database view, so there is no write method to\n");
        src.append(" * implement. Its controller answers every write verb with 405.</p>\n");
        src.append(" */\n");
        src.append("public interface ").append(repoName).append(" {\n\n");
        src.append("    /** Sort directive parsed from the cross-port ?sort=<field>:asc|desc grammar. */\n");
        src.append("    record SortClause(String field, String direction) {}\n\n");
        src.append("    List<").append(dtoName)
           .append("> list(int limit, int offset, SortClause sort, List<FilterPredicate> filters);\n");
        src.append("    long count(List<FilterPredicate> filters);\n");
        if (hasItem) {
            src.append("    Optional<").append(dtoName).append("> findById(").append(pkType).append(" id);\n");
        }
        src.append("}\n");

        try {
            Path outFile = outRoot.resolve(pkg.replace('.', '/')).resolve(repoName + ".java");
            GeneratedFileWriter.write(outFile, src.toString());
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing " + repoName + ".java for projection " + entity.getName() + ": " + e, e);
        }
    }

    /**
     * FR-017 TPH: emit the discriminator-base repository interface — the consumer seam for a
     * single-table hierarchy. Polymorphic operations span the whole table; per-subtype operations
     * are scoped to a discriminator value (passed by the controller, baked in from the URL).
     * Every method trades the base {@code <Base>Dto} (which carries the UNION of subtype columns
     * for a TPH base — see {@link SpringDtoGenerator}). Subtype entities emit no own repository.
     */
    protected void emitTph(MetaObject base, Path outRoot) {
        String[] split = SpringNaming.splitFqn(base.getName());
        String pkg = split[0];
        String shortName = split[1];
        String dtoName = SpringNaming.dtoName(shortName);
        String repoName = SpringNaming.repositoryName(shortName);
        // The single TPH table is keyed by the BASE's primary identity — polymorphic and
        // per-subtype-scoped operations all trade that derived PK type (uuid → java.util.UUID, …).
        String pkType = SpringTypeMapper.primaryKeyJavaType(base);
        // Non-null by construction — execute() only calls emitTph when TphPlan.isTphBase(entity)
        // already proved planFor(entity, loader) resolves.
        TphPlan.Plan plan = TphPlan.planFor(base, loader);

        StringBuilder src = new StringBuilder();
        if (!pkg.isEmpty()) src.append("package ").append(pkg).append(";\n\n");
        src.append("import com.metaobjects.generator.spring.runtime.FilterPredicate;\n");
        src.append("import java.util.List;\n");
        src.append("import java.util.Optional;\n\n");
        src.append("/**\n");
        src.append(" * GENERATED TPH interface — consumer implements with their preferred persistence layer.\n");
        src.append(" * Polymorphic operations span the single ").append(shortName)
           .append(" table; the per-subtype operations are scoped to a discriminator value\n");
        src.append(" * (injected by the matching ").append(shortName).append("Controller from the URL segment).\n");
        src.append(" */\n");
        src.append("public interface ").append(repoName).append(" {\n\n");
        src.append("    /** Sort directive parsed from the cross-port ?sort=<field>:asc|desc grammar. */\n");
        src.append("    record SortClause(String field, String direction) {}\n\n");
        src.append("    // --- polymorphic (whole table) ---\n");
        src.append("    List<").append(dtoName)
           .append("> list(int limit, int offset, SortClause sort, List<FilterPredicate> filters);\n");
        src.append("    long count(List<FilterPredicate> filters);\n");
        src.append("    Optional<").append(dtoName).append("> findById(").append(pkType).append(" id);\n\n");
        src.append("    // --- per-subtype (scoped to the discriminator value) ---\n");
        src.append("    List<").append(dtoName)
           .append("> listByType(String discriminator, int limit, int offset, SortClause sort, List<FilterPredicate> filters);\n");
        src.append("    Optional<").append(dtoName).append("> findByIdAndType(")
           .append(pkType).append(" id, String discriminator);\n");
        src.append("    ").append(dtoName).append(" createWithType(String discriminator, ").append(dtoName).append(" dto);\n");
        src.append("    Optional<").append(dtoName)
           .append("> updateByIdAndType(").append(pkType).append(" id, String discriminator, ")
           .append(dtoName).append(" dto);\n");
        // FR-036 Program B: presence-tracked partial update for a per-subtype route. `assigned` is a
        // <Sub>Patch.assignedValues() map — the PRESENT columns (name→value, incl. an explicit
        // null), scoped to the discriminator. The impl applies ONLY the present keys (an absent
        // column is untouched; an explicit null clears it); id + discriminator are immutable. This
        // is the TPH analogue of the vanilla patch(id, <Entity>Patch) seam.
        src.append("    Optional<").append(dtoName)
           .append("> patchByIdAndType(").append(pkType)
           .append(" id, String discriminator, java.util.Map<String, Object> assigned);\n");
        src.append("    boolean deleteByIdAndType(").append(pkType).append(" id, String discriminator);\n");

        // FR-018 x FR-017 — M:N traversal inside a TPH hierarchy. A relationship declared on
        // the BASE is legitimate for every row of the shared table, so it gets one whole-table
        // finder (same shape + name as the vanilla repository's M:N finder). A relationship
        // resolved by a CONCRETE SUBTYPE — its own, or inherited from the base — additionally
        // gets a finder SCOPED to that subtype. The subtype-membership check is NOT this
        // finder's obligation: the GENERATED controller (see SpringControllerGenerator#emitTph)
        // composes repository.findByIdAndType(id, discriminator) — the same seam the per-subtype
        // GET already gates on — BEFORE ever calling this finder, and short-circuits to an empty
        // list, HTTP 200, when sourceId does not name a row of this subtype. That enforces the
        // gate on every conforming implementation by construction, rather than leaving a
        // documented obligation a copy-paste finder body could silently violate. Distinct method
        // names per subtype are still required here (unlike the vanilla finder) because the
        // interface cannot declare two methods with the same erasure that behave differently by
        // discriminator.
        src.append("\n    // --- M:N traversal (whole-table, then per-subtype-scoped) ---\n");
        for (SpringM2mSupport.M2mNav nav : SpringM2mSupport.resolve(base, loader)) {
            src.append("    /** M:N traversal: the ").append(nav.targetShortName())
               .append(" rows related to this ").append(shortName)
               .append(" through ").append(nav.junctionShortName());
            if (nav.symmetric()) src.append(" (symmetric — union on read)");
            src.append(targetSubtypeJavadocClause(nav));
            src.append(". */\n");
            src.append("    List<").append(nav.targetDtoType()).append("> ")
               .append(m2mFinderName(nav.relationName())).append("(").append(pkType).append(" sourceId")
               .append(targetSubtypeParam(nav)).append(");\n");
        }
        for (TphPlan.Subtype st : plan.subtypes()) {
            for (SpringM2mSupport.M2mNav nav : SpringM2mSupport.resolve(st.entity(), loader)) {
                src.append("    /** M:N traversal scoped to ").append(st.value())
                   .append(": the ").append(nav.targetShortName()).append(" rows related to this ")
                   .append(st.value()).append(" through ").append(nav.junctionShortName())
                   .append(". The generated controller calls this ONLY after confirming sourceId ")
                   .append("names a ").append(st.value())
                   .append(" row (via findByIdAndType) — implementations may assume sourceId is ")
                   .append("valid for this subtype.");
                if (nav.targetDiscriminatorValue() != null) {
                    // The TARGET side of the same gate: unlike sourceId (verified above, by the
                    // GENERATED controller, before this finder is ever called), the target's own
                    // subtype is NOT verified by anything MetaObjects generates — the junction
                    // join is entirely consumer-owned, and Java's interface cannot AND a
                    // discriminator into a join it does not write. Implementations MUST use the
                    // targetSubtype argument — always the resolved discriminator literal — to
                    // filter the join to rows of that subtype.
                    src.append(" Implementations MUST use the targetSubtype argument (always the")
                       .append(" resolved \"").append(nav.targetDiscriminatorValue())
                       .append("\" literal) to filter the join to rows of that subtype; a")
                       .append(" copy-paste of the unscoped join would silently return a")
                       .append(" same-table sibling's rows.");
                }
                src.append(" */\n");
                src.append("    List<").append(nav.targetDtoType()).append("> ")
                   .append(m2mFinderNameForSubtype(nav.relationName(), st.value()))
                   .append("(").append(pkType).append(" sourceId")
                   .append(targetSubtypeParam(nav)).append(");\n");
            }
        }
        src.append("}\n");

        try {
            Path outFile = outRoot.resolve(pkg.replace('.', '/')).resolve(repoName + ".java");
            GeneratedFileWriter.write(outFile, src.toString());
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing TPH " + repoName + ".java for entity " + base.getName() + ": " + e, e);
        }
    }

    /** Repository finder name for an M:N relationship: {@code tags} → {@code findTags}. */
    public static String m2mFinderName(String relationName) {
        if (relationName.isEmpty()) return "find";
        return "find" + Character.toUpperCase(relationName.charAt(0)) + relationName.substring(1);
    }

    /**
     * FR-017 x FR-018: the subtype-scoped M:N finder name, e.g. {@code ("tags", "Bridge")} →
     * {@code findTagsForBridge}. Distinct from {@link #m2mFinderName} because a TPH interface
     * may need BOTH the whole-table finder (base-declared relationship) AND a per-subtype one
     * for the exact same relation name (an inherited relationship resolved by more than one
     * subtype) — same naming shape as the existing {@code list<Suffix>}/{@code get<Suffix>}
     * per-subtype CRUD methods.
     */
    public static String m2mFinderNameForSubtype(String relationName, String discriminatorValue) {
        return m2mFinderName(relationName) + "For" + SpringNaming.capitalize(discriminatorValue);
    }

    /**
     * FW-8 follow-up (target-side TPH gate): the extra finder parameter clause for {@code nav} —
     * {@code ", String targetSubtype"} when {@code nav}'s target is a concrete TPH subtype,
     * empty otherwise. Threading this same {@code targetDiscriminatorValue() != null} test at
     * every finder declaration AND its matching controller call site (see
     * {@link SpringControllerGenerator}) is what keeps a widened finder's interface signature
     * and call site in agreement — a real disagreement here is a javac compile error, not a
     * silently-wrong runtime result, because each (relation name, source scope) pair is its own
     * distinct Java method (never a single shared seam multiple mounts must agree on the arity
     * of, unlike the Python port's one Protocol method per relation name).
     */
    public static String targetSubtypeParam(SpringM2mSupport.M2mNav nav) {
        return nav.targetDiscriminatorValue() != null ? ", String targetSubtype" : "";
    }

    /**
     * The matching CALL-SITE argument clause for {@link #targetSubtypeParam} — the quoted
     * discriminator literal when {@code nav}'s target is TPH, empty otherwise. Used by
     * {@link SpringControllerGenerator} at every M:N call site (unscoped base finder AND every
     * subtype-scoped {@code find<Rel>For<Disc>} finder) so each call site's argument count
     * always matches its own finder's declared parameter count.
     */
    static String targetSubtypeCallArg(SpringM2mSupport.M2mNav nav) {
        return nav.targetDiscriminatorValue() != null
            ? ", \"" + nav.targetDiscriminatorValue() + "\""
            : "";
    }

    /**
     * The javadoc clause naming a widened finder's target-subtype literal, appended right
     * before the closing sentence period — empty when {@code nav}'s target isn't TPH (byte-
     * identical javadoc for the overwhelming common case).
     */
    static String targetSubtypeJavadocClause(SpringM2mSupport.M2mNav nav) {
        if (nav.targetDiscriminatorValue() == null) return "";
        return " (target is a TPH subtype: this finder also takes targetSubtype, always the"
            + " resolved \"" + nav.targetDiscriminatorValue() + "\" literal)";
    }

    /**
     * One reverse FK an entity holds (ADR-0038), derived from an {@code identity.reference}:
     * the FK field name, the target entity short name, and the Java value type of the FK
     * (the type a {@code findBy<FkField>} arg / element takes — the FK column's own Java type).
     */
    public record ReverseFk(String fkField, String targetShortName, String valueType) {}

    /**
     * Collect every reverse FK an entity declares, in declaration order — one per
     * {@code identity.reference} child with a single FK field. Compound references
     * (multi-field FKs) are skipped (no single-column finder shape). The value type
     * is the FK field's own Java type via {@link SpringTypeMapper#javaTypeName}.
     */
    public static List<ReverseFk> reverseFksFor(MetaObject entity) {
        List<ReverseFk> out = new java.util.ArrayList<>();
        for (com.metaobjects.MetaData child : entity.getChildren()) {
            if (!(child instanceof ReferenceIdentity ref)) continue;
            List<String> fields = ref.getFields();
            if (fields.size() != 1) continue; // single-column FKs only
            String fkField = fields.get(0);
            String target = ref.getTargetEntity();
            String targetShort = target == null ? "" : stripPackage(target);
            String valueType = "Long";
            if (entity.hasMetaField(fkField)) {
                MetaField<?> f = entity.getMetaField(fkField);
                valueType = SpringTypeMapper.javaTypeName(f);
            }
            out.add(new ReverseFk(fkField, targetShort, valueType));
        }
        return out;
    }

    private static String stripPackage(String name) {
        int idx = name.lastIndexOf("::");
        return idx >= 0 ? name.substring(idx + 2) : name;
    }

    // === MultiFileDirectGeneratorBase abstract-method stubs ====================
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
        return SpringNaming.splitFqn(md.getName())[1] + "Repository.java";
    }
}
