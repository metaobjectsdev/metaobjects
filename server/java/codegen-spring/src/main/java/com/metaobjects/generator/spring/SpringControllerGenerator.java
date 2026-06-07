package com.metaobjects.generator.spring;

import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
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
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Generator: one Spring Web MVC {@code @RestController} Java file per
 * {@code object.entity} that has a {@code source.rdb} child with
 * {@code @kind="table"} (writable; the default). View and materializedView
 * kinds are skipped (read-only — would need a separate read-only
 * controller); storedProc and tableFunction kinds are skipped (no
 * controller-codegen story today).
 *
 * <p>Targets <strong>Spring Boot 3.x / Java 21</strong>, Spring Web MVC
 * (not WebFlux). Generated controllers carry no compile-time MetaObjects
 * dependency: only Spring + the matching generated {@code <Entity>Dto} +
 * {@code <Entity>Repository} need to be on the classpath at run time.</p>
 *
 * <p>Conforms to the cross-port REST API contract
 * (see {@code docs/features/api-contract.md}):</p>
 * <ul>
 *   <li>Routes: {@code /api/<entity-plural-lowercase>}
 *       (e.g. {@code /api/authors}).</li>
 *   <li>5 CRUD verbs: GET list, GET by id, POST create, PATCH + PUT update,
 *       DELETE.</li>
 *   <li>{@code ?withCount=1} switches list response to
 *       {@code { rows, total }}.</li>
 *   <li>{@code ?sort=field:asc|desc} parsed via a static per-entity allowlist
 *       (HTTP 400 on unknown field).</li>
 *   <li>{@code ?limit=N&offset=N} pagination with defaults
 *       (limit=50, offset=0).</li>
 *   <li>HTTP 404 envelope: {@code { "error": "not_found" }}.</li>
 *   <li>HTTP 400 envelope: {@code { "error": "invalid_<thing>" }}.</li>
 * </ul>
 *
 * <p>FR-009 filter operators ({@code eq / ne / gt / gte / lt / lte / in /
 * like / isNull}) ship via the {@code <Entity>FilterAllowlist} constant
 * emitted by {@link SpringFilterAllowlistGenerator} plus the runtime
 * {@code FilterParser} helper — the list handler validates the
 * {@code filter[<field>][<op>]=<value>} grammar against the allowlist and
 * passes a {@code List<FilterPredicate>} down to the repository.</p>
 *
 * <p>The generated controller delegates to the {@code <Entity>Repository}
 * interface emitted by {@link SpringRepositoryGenerator}, which the
 * consumer implements with their persistence layer of choice (Spring Data
 * JPA / jOOQ / plain JDBC).</p>
 *
 * <p>Substrate justification (hand-rolled string builder rather than
 * JavaPoet): same trade-off as
 * {@code KotlinSpringControllerGenerator}. Spring annotations
 * ({@code @GetMapping}, {@code @PathVariable}, {@code @RequestParam}) plus
 * generic types ({@code ResponseEntity<?>}, {@code Optional<EntityDto>})
 * don't translate cleanly to JavaPoet's {@code MethodSpec}/{@code AnnotationSpec}
 * APIs without a verbose dance of {@code $T} placeholders; the syntactic
 * surface is small (~110 lines per file) and matches the idiomatic Spring
 * style without the indirection of a typed-emit DSL.</p>
 *
 * <p>Args:</p>
 * <ul>
 *   <li>{@code outputDir} (required): output directory root.</li>
 * </ul>
 */
public class SpringControllerGenerator extends MultiFileDirectGeneratorBase<MetaObject> {

    private static final Logger LOG = LoggerFactory.getLogger(SpringControllerGenerator.class);

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
            if (!MetaObject.SUBTYPE_ENTITY.equals(entity.getSubType())) continue;
            if (com.metaobjects.generator.util.GeneratorUtil.isAbstract(entity)) continue;
            RdbSource sourceRdb = firstRdbSource(entity);
            if (sourceRdb == null) continue;
            if (!appliesTo(entity)) {
                // Same shape (entity / non-abstract / has rdb source) but a non-table
                // kind — log why no controller is emitted, then skip.
                logSkip(entity.getName(), sourceRdb.getEffectiveKind());
                continue;
            }
            emit(entity, outRoot);
        }
    }

    /**
     * True iff this generator emits a {@code @RestController} for {@code entity}:
     * a concrete (non-abstract) {@code object.entity} whose first {@code source.rdb}
     * child is {@code @kind="table"} (writable). Identical inclusion rule to
     * {@link SpringRepositoryGenerator#appliesTo(MetaObject)} — the controller
     * delegates to that repository, so the two emit sets coincide. View /
     * materializedView / storedProc / tableFunction kinds (and entities with no
     * {@code source.rdb}) are excluded. There is no {@code @emitRoutes}-style
     * opt-out attribute today — emission is driven purely by the table guard.
     * Extracted verbatim from the {@link #execute(MetaDataLoader)} per-node guard.
     */
    public static boolean appliesTo(MetaObject entity) {
        if (!MetaObject.SUBTYPE_ENTITY.equals(entity.getSubType())) return false;
        if (com.metaobjects.generator.util.GeneratorUtil.isAbstract(entity)) return false;
        RdbSource sourceRdb = firstRdbSource(entity);
        if (sourceRdb == null) return false;
        return MetaSource.KIND_TABLE.equals(sourceRdb.getEffectiveKind());
    }

    protected void logSkip(String entityName, String kind) {
        if (MetaSource.KIND_VIEW.equals(kind) || MetaSource.KIND_MATERIALIZED_VIEW.equals(kind)) {
            LOG.debug("skipping controller for {} — source.rdb @kind='{}' is read-only", entityName, kind);
        } else if (MetaSource.KIND_STORED_PROC.equals(kind)) {
            LOG.debug("skipping controller for {} — source.rdb @kind='storedProc' has no controller story today",
                entityName);
        } else {
            LOG.warn("skipping controller for {} — source.rdb @kind='{}' has no controller generator yet",
                entityName, kind);
        }
    }

    protected void emit(MetaObject entity, Path outRoot) {
        String[] split = SpringNaming.splitFqn(entity.getName());
        String pkg = split[0];
        String shortName = split[1];
        String dtoName = SpringNaming.dtoName(shortName);
        String repoName = SpringNaming.repositoryName(shortName);
        String controllerName = SpringNaming.controllerName(shortName);
        String routeBase = SpringNaming.controllerPath(shortName);

        // Sort allowlist: every scalar field is sortable. Skip ObjectField (no SQL column
        // surface today; @storage controls a separate column shape).
        List<String> sortFields = new ArrayList<>();
        for (MetaField field : entity.getMetaFields()) {
            if (field instanceof ObjectField) continue;
            sortFields.add(field.getName());
        }

        StringBuilder src = new StringBuilder();
        if (!pkg.isEmpty()) {
            src.append("package ").append(pkg).append(";\n\n");
        }
        src.append("import org.springframework.http.HttpStatus;\n");
        src.append("import org.springframework.http.ResponseEntity;\n");
        src.append("import org.springframework.web.bind.annotation.DeleteMapping;\n");
        src.append("import org.springframework.web.bind.annotation.GetMapping;\n");
        src.append("import org.springframework.web.bind.annotation.PathVariable;\n");
        src.append("import org.springframework.web.bind.annotation.PostMapping;\n");
        src.append("import org.springframework.web.bind.annotation.RequestBody;\n");
        src.append("import org.springframework.web.bind.annotation.RequestMapping;\n");
        src.append("import org.springframework.web.bind.annotation.RequestMethod;\n");
        src.append("import org.springframework.web.bind.annotation.RequestParam;\n");
        src.append("import org.springframework.web.bind.annotation.RestController;\n");
        src.append("import com.metaobjects.generator.spring.runtime.FilterParseResult;\n");
        src.append("import com.metaobjects.generator.spring.runtime.FilterParser;\n");
        src.append("import com.metaobjects.generator.spring.runtime.FilterPredicate;\n");
        src.append("import jakarta.servlet.http.HttpServletRequest;\n");
        src.append("import jakarta.validation.Valid;\n");
        src.append("import java.util.List;\n");
        src.append("import java.util.Map;\n");
        src.append("import java.util.Set;\n\n");

        src.append("/** GENERATED — REST controller for ").append(shortName)
           .append(" entity. Implements the cross-port API contract. */\n");
        src.append("@RestController\n");
        src.append("@RequestMapping(\"").append(routeBase).append("\")\n");
        src.append("public class ").append(controllerName).append(" {\n\n");

        // Sort allowlist — static per-entity Set. Field-prefixed inner constant keeps it
        // private to this controller (no cross-file collision risk).
        src.append("    private static final Set<String> SORT_ALLOWLIST = Set.of(");
        for (int i = 0; i < sortFields.size(); i++) {
            if (i > 0) src.append(", ");
            src.append('"').append(sortFields.get(i)).append('"');
        }
        src.append(");\n\n");

        // Repository wiring — constructor injection (Spring's recommended idiom; avoids
        // field-injection magic, plays well with final fields + final test seams).
        src.append("    private final ").append(repoName).append(" repository;\n\n");
        src.append("    public ").append(controllerName).append("(").append(repoName).append(" repository) {\n");
        src.append("        this.repository = repository;\n");
        src.append("    }\n\n");

        // GET (list) — pagination + sort + withCount + FR-009 filter operators.
        // HttpServletRequest carries the raw query string so the bracketed
        // filter[<field>][<op>]=<value> grammar reaches FilterParser intact
        // (Spring's @RequestParam would collapse same-key occurrences).
        String allowlistName = SpringNaming.filterAllowlistName(shortName);
        src.append("    @GetMapping\n");
        src.append("    public ResponseEntity<?> list(\n");
        src.append("            @RequestParam(required = false) Integer limit,\n");
        src.append("            @RequestParam(required = false) Integer offset,\n");
        src.append("            @RequestParam(required = false) String sort,\n");
        src.append("            @RequestParam(required = false, name = \"withCount\") Integer withCount,\n");
        src.append("            HttpServletRequest request) {\n");
        src.append("        int actualLimit = limit != null ? limit : 50;\n");
        src.append("        int actualOffset = offset != null ? offset : 0;\n");
        src.append("        ").append(repoName).append(".SortClause sortClause = null;\n");
        src.append("        if (sort != null) {\n");
        src.append("            sortClause = parseSort(sort);\n");
        src.append("            if (sortClause == null) {\n");
        src.append("                return ResponseEntity.badRequest().body(Map.of(\"error\", \"invalid_sort\"));\n");
        src.append("            }\n");
        src.append("        }\n");
        src.append("        FilterParseResult filter = FilterParser.parse(\n");
        src.append("                request.getQueryString(), ").append(allowlistName).append(".FIELDS, ")
           .append(allowlistName).append(".OPS_BY_FIELD);\n");
        src.append("        if (filter.error() != null) {\n");
        src.append("            return ResponseEntity.badRequest().body(Map.of(\"error\", filter.error()));\n");
        src.append("        }\n");
        src.append("        List<FilterPredicate> filters = filter.predicates();\n");
        src.append("        List<").append(dtoName)
           .append("> rows = repository.list(actualLimit, actualOffset, sortClause, filters);\n");
        src.append("        if (withCount != null && withCount == 1) {\n");
        src.append("            long total = repository.count(filters);\n");
        src.append("            return ResponseEntity.ok(Map.of(\"rows\", rows, \"total\", total));\n");
        src.append("        }\n");
        src.append("        return ResponseEntity.ok(rows);\n");
        src.append("    }\n\n");

        // GET /{id} — single by primary key.
        src.append("    @GetMapping(\"/{id}\")\n");
        src.append("    public ResponseEntity<?> get(@PathVariable Long id) {\n");
        src.append("        return repository.findById(id)\n");
        src.append("                .<ResponseEntity<?>>map(ResponseEntity::ok)\n");
        src.append("                .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of(\"error\", \"not_found\")));\n");
        src.append("    }\n\n");

        // POST — create.
        src.append("    @PostMapping\n");
        src.append("    public ResponseEntity<").append(dtoName).append("> create(@Valid @RequestBody ").append(dtoName).append(" dto) {\n");
        src.append("        ").append(dtoName).append(" saved = repository.create(dto);\n");
        src.append("        return ResponseEntity.status(HttpStatus.CREATED).body(saved);\n");
        src.append("    }\n\n");

        // PATCH + PUT — single handler (per API contract; same body shape both verbs).
        // Both verbs MUST be expressed on one @RequestMapping with method={PATCH, PUT}.
        // Stacking @PatchMapping + @PutMapping on the same method does NOT register both
        // in Spring MVC — only one composed @RequestMapping per method is honored, so the
        // other verb 405s. (Surfaced by the SP-F generated-controller HTTP lane.)
        src.append("    @RequestMapping(value = \"/{id}\", method = { RequestMethod.PATCH, RequestMethod.PUT })\n");
        src.append("    public ResponseEntity<?> update(@PathVariable Long id, @Valid @RequestBody ").append(dtoName).append(" dto) {\n");
        src.append("        return repository.update(id, dto)\n");
        src.append("                .<ResponseEntity<?>>map(ResponseEntity::ok)\n");
        src.append("                .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of(\"error\", \"not_found\")));\n");
        src.append("    }\n\n");

        // DELETE — 204 on success, 404 envelope on miss.
        src.append("    @DeleteMapping(\"/{id}\")\n");
        src.append("    public ResponseEntity<?> delete(@PathVariable Long id) {\n");
        src.append("        if (repository.delete(id)) {\n");
        src.append("            return ResponseEntity.noContent().build();\n");
        src.append("        }\n");
        src.append("        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of(\"error\", \"not_found\"));\n");
        src.append("    }\n\n");

        // FR-018 M:N traversal — GET /{id}/<relationName> exposes each
        // @cardinality:"many" + @through relationship as a sub-resource of the source,
        // returning the related target rows. The source URL segment is the entity name
        // pluralized (handled by @RequestMapping above); the relation segment is the
        // relationship name. Related-row order is not contractual. The repository finder
        // traverses the junction (hetero / directed self-join / symmetric union-on-read).
        for (SpringM2mSupport.M2mNav nav : SpringM2mSupport.resolve(entity, loader)) {
            String finder = SpringRepositoryGenerator.m2mFinderName(nav.relationName());
            src.append("    @GetMapping(\"/{id}/").append(nav.relationName()).append("\")\n");
            src.append("    public ResponseEntity<List<").append(nav.targetDtoType()).append(">> ")
               .append(finder).append("(@PathVariable Long id) {\n");
            src.append("        return ResponseEntity.ok(repository.").append(finder).append("(id));\n");
            src.append("    }\n\n");
        }

        // parseSort — returns null on malformed/disallowed input. Returning null lets the
        // list handler emit the 400 envelope itself rather than throwing — cleaner
        // separation. The DEFAULT_PK_FIELD constant below is referenced from the per-entity
        // controller so this helper is package-internal to each generated file.
        src.append("    private static ").append(repoName).append(".SortClause parseSort(String raw) {\n");
        src.append("        String[] parts = raw.split(\":\", 2);\n");
        src.append("        if (parts.length == 0 || parts[0].isEmpty() || !SORT_ALLOWLIST.contains(parts[0])) return null;\n");
        src.append("        String dir = parts.length == 2 ? parts[1].toLowerCase() : \"asc\";\n");
        src.append("        if (!dir.equals(\"asc\") && !dir.equals(\"desc\")) return null;\n");
        src.append("        return new ").append(repoName).append(".SortClause(parts[0], dir);\n");
        src.append("    }\n");
        src.append("}\n");

        try {
            Path outFile = outRoot.resolve(pkg.replace('.', '/')).resolve(controllerName + ".java");
            if (outFile.getParent() != null) Files.createDirectories(outFile.getParent());
            Files.writeString(outFile, src.toString());
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing " + controllerName + ".java for entity " + entity.getName() + ": " + e, e);
        }
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
        return SpringNaming.splitFqn(md.getName())[1] + "Controller.java";
    }
}
