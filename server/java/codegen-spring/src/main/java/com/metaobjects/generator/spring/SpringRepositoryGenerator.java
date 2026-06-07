package com.metaobjects.generator.spring;

import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.GeneratorIOWriter;
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
import com.metaobjects.loader.MetaDataLoader;
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
            if (!appliesTo(entity)) continue;
            emit(entity, outRoot);
        }
    }

    /**
     * True iff this generator emits a repository for {@code entity}: a concrete
     * (non-abstract) {@code object.entity} whose first {@code source.rdb} child
     * is {@code @kind="table"} (writable). View / materializedView / storedProc /
     * tableFunction kinds — and entities with no {@code source.rdb} at all — are
     * excluded. Extracted verbatim from the {@link #execute(MetaDataLoader)}
     * per-node guard so the api-docs IR builder can reuse the same decision.
     */
    public static boolean appliesTo(MetaObject entity) {
        if (!MetaObject.SUBTYPE_ENTITY.equals(entity.getSubType())) return false;
        if (com.metaobjects.generator.util.GeneratorUtil.isAbstract(entity)) return false;
        RdbSource sourceRdb = firstRdbSource(entity);
        if (sourceRdb == null) return false;
        return MetaSource.KIND_TABLE.equals(sourceRdb.getEffectiveKind());
    }

    protected void emit(MetaObject entity, Path outRoot) {
        String[] split = SpringNaming.splitFqn(entity.getName());
        String pkg = split[0];
        String shortName = split[1];
        String dtoName = SpringNaming.dtoName(shortName);
        String repoName = SpringNaming.repositoryName(shortName);

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
        src.append("    Optional<").append(dtoName).append("> findById(Long id);\n");
        src.append("    ").append(dtoName).append(" create(").append(dtoName).append(" dto);\n");
        src.append("    Optional<").append(dtoName).append("> update(Long id, ").append(dtoName).append(" dto);\n");
        src.append("    boolean delete(Long id);\n");

        // FR-018 M:N finders — one per @cardinality:"many" + @through relationship.
        // The matching controller's GET /{id}/<relationName> sub-resource delegates here.
        // The consumer implements the junction traversal (the runtime M2mJoinResolver helper
        // collapses the three resolution modes once the junction rows are fetched).
        for (SpringM2mSupport.M2mNav nav : SpringM2mSupport.resolve(entity, loader)) {
            src.append("\n    /** M:N traversal: the ").append(nav.targetShortName())
               .append(" rows related to this ").append(shortName)
               .append(" through ").append(nav.junctionShortName());
            if (nav.symmetric()) src.append(" (symmetric — union on read)");
            src.append(". */\n");
            src.append("    List<").append(nav.targetDtoType()).append("> ")
               .append(m2mFinderName(nav.relationName())).append("(Long sourceId);\n");
        }
        src.append("}\n");

        try {
            Path outFile = outRoot.resolve(pkg.replace('.', '/')).resolve(repoName + ".java");
            if (outFile.getParent() != null) Files.createDirectories(outFile.getParent());
            Files.writeString(outFile, src.toString());
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing " + repoName + ".java for entity " + entity.getName() + ": " + e, e);
        }
    }

    /** Repository finder name for an M:N relationship: {@code tags} → {@code findTags}. */
    public static String m2mFinderName(String relationName) {
        if (relationName.isEmpty()) return "find";
        return "find" + Character.toUpperCase(relationName.charAt(0)) + relationName.substring(1);
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
