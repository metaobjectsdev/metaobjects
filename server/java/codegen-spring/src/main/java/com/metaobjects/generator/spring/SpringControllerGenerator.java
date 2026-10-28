package com.metaobjects.generator.spring;

// Eject note (ADR-0034, JVM eject design): these siblings stay in
// com.metaobjects.generator.spring when this generator is copied out via
// `mvn metaobjects:eject` and its own package is renamed — an explicit import, not
// same-package bare-name resolution, is what keeps the ejected copy compiling.
import com.metaobjects.generator.spring.AutoSetSupport;
import com.metaobjects.generator.spring.SpringGeneratorSupport;
import com.metaobjects.generator.spring.SpringM2mSupport;
import com.metaobjects.generator.spring.SpringNaming;
import com.metaobjects.generator.spring.SpringTypeMapper;
import com.metaobjects.generator.spring.TphPlan;

import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.query.FilterOps;
import com.metaobjects.generator.EmitsReportExport;
import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.RunAware;
import com.metaobjects.generator.GeneratorIOWriter;
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
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
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import com.metaobjects.generator.util.GeneratedFileWriter;

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
 *   <li>{@code runtimePackage} (optional): package the output imports its helper runtime
 *       from; defaults to {@link #RUNTIME_PACKAGE}.</li>
 * </ul>
 */
public class SpringControllerGenerator extends MultiFileDirectGeneratorBase<MetaObject> implements RunAware {

    /**
     * The package the emitted code imports its helper runtime from ({@code FilterParser},
     * {@code PatchValidationException}, …). {@code mvn metaobjects:eject} copies that runtime
     * into the adopter's module and rewrites THIS line of the ejected copy to name it, so an
     * owned generator's output imports the owned runtime. Keep it on one line.
     */
    public static final String RUNTIME_PACKAGE = "com.metaobjects.generator.spring.runtime";

    /** Generator arg overriding {@link #RUNTIME_PACKAGE} — for a packaged generator whose
     *  output must use the same owned runtime copy as an ejected neighbour. */
    public static final String ARG_RUNTIME_PACKAGE = "runtimePackage";

    /**
     * The most rows a report list answers when no {@link #ARG_REPORT_MAX_ROWS} is given; the same
     * default in every port. With no {@code limit} a report answers every row up to the cap and
     * is refused above it, never truncated.
     */
    public static final int DEFAULT_REPORT_MAX_ROWS = 10_000;

    /** Generator arg: the row cap of a served report's list route (default
     *  {@link #DEFAULT_REPORT_MAX_ROWS}). One row more than the cap, or a {@code limit} above
     *  it, answers {@code 400 {"error": "report_too_large", "maxRows": N}}. Reports only. */
    public static final String ARG_REPORT_MAX_ROWS = "reportMaxRows";

    private int reportMaxRows = DEFAULT_REPORT_MAX_ROWS;

    /**
     * Whether a {@code report-export} generator ({@link EmitsReportExport}) is in this run, as
     * {@link #setRun} reports it. A served report's list route then also answers
     * {@code ?format=csv|json|xml} (the "Report export" section of
     * {@code docs/features/api-contract.md}); the handler reads its cap from the generated
     * {@code <Report>Export.MAX_ROWS}, so the cap is set once, on {@code report-export}
     * ({@code maxRows}). Without one the generated routes are byte-identical to a project
     * without the feature. The two caps never both apply to one request: with {@code ?format}
     * the export cap governs and {@code report_too_large} never answers; without it
     * {@link #ARG_REPORT_MAX_ROWS} is untouched.
     */
    private boolean reportExport = false;

    @Override
    public void setRun(Collection<? extends Generator> run) {
        reportExport = EmitsReportExport.includedIn(run);
    }

    /** The runtime package this run's output imports ({@link #ARG_RUNTIME_PACKAGE}). */
    private String runtimePackage = RUNTIME_PACKAGE;

    private static final Logger LOG = LoggerFactory.getLogger(SpringControllerGenerator.class);

    @Override
    protected Class<MetaObject> getFilterClass() {
        return MetaObject.class;
    }

    private MetaDataLoader loader;

    @Override
    public void execute(MetaDataLoader loader) {
        parseArgs();
        runtimePackage = getArg(ARG_RUNTIME_PACKAGE, RUNTIME_PACKAGE);
        reportMaxRows = Integer.parseInt(getArg(ARG_REPORT_MAX_ROWS, String.valueOf(DEFAULT_REPORT_MAX_ROWS)));
        this.loader = loader;
        Path outRoot = Paths.get(outDir.getAbsolutePath());
        for (MetaObject declared : loader.getMetaObjects()) {
            // FR-044: a served report is emitted from its read model; any other report
            // has no shape and emits nothing.
            MetaObject entity = RestSurfaceGate.restShapeOf(declared);
            if (entity == null) continue;
            if (com.metaobjects.generator.util.GeneratorUtil.isAbstract(entity)) continue;
            // FR-017 TPH: a subtype is folded into its base's single table + base controller —
            // it emits no standalone controller (it carries no own source.rdb either, so the
            // table guard below also excludes it; this is the explicit, model-driven guard).
            if (TphPlan.isTphSubtype(entity)) continue;
            RdbSource sourceRdb = firstRdbSource(entity);
            if (sourceRdb == null) continue;
            if (!appliesTo(entity)) {
                // Same shape (persisted, non-abstract, has an rdb source) but a kind with no
                // controller story — log why no controller is emitted, then skip.
                logSkip(entity.getName(), sourceRdb.getEffectiveKind());
                continue;
            }
            // F22 — a view-only projection gets a READ-ONLY controller: reads served, every
            // write verb answering the cross-port 405 envelope. A served report (FR-044)
            // takes the same path and, having no identity, comes out keyless.
            if (RestSurfaceGate.isReadOnly(entity)) {
                emitReadOnly(entity, outRoot);
                continue;
            }
            // FR-017 TPH: a discriminator base emits ONE controller mounting the polymorphic
            // collection routes plus a full per-subtype CRUD set scoped by the discriminator.
            TphPlan.Plan tph = TphPlan.planFor(entity, loader);
            if (tph != null) emitTph(entity, tph, outRoot);
            else emit(entity, outRoot);
        }
    }

    /**
     * True iff this generator emits a {@code @RestController} for {@code entity} —
     * a WRITABLE object (a concrete table-kind {@code object.entity}, or a write-through
     * entity), a READ-ONLY view-kind {@code object.projection} (F22) or a served
     * {@code object.report} (FR-044, emitted from {@link RestSurfaceGate#restShapeOf}). Ask
     * {@link RestSurfaceGate#isReadOnly(MetaObject)} which of the two shapes is emitted.
     *
     * <p>The predicate itself lives in {@link RestSurfaceGate} and is SHARED with
     * {@link SpringGeneratorSupport#repositoryAppliesTo(MetaObject)} and
     * {@link SpringFilterAllowlistGenerator#appliesTo(MetaObject)} — not merely equal to
     * them. The controller NAMES the repository and the allowlist, so a gate widened in
     * one copy and not the others emits a controller importing types nothing generated,
     * and {@code generate} still exits 0. There is no {@code @emitRoutes}-style opt-out
     * attribute today — emission is driven purely by the shape.</p>
     */
    public static boolean appliesTo(MetaObject entity) {
        return RestSurfaceGate.emitsRestSurface(entity);
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
        // PK type derived from identity.primary (uuid → java.util.UUID, long → Long, …);
        // a hard-coded Long made Spring 400 every uuid-keyed by-id request.
        String pkType = SpringTypeMapper.primaryKeyJavaType(entity);

        // Sort allowlist: FilterOps.supportsFiltering is the CANONICAL, cross-port answer to
        // "can this subtype be ordered" — the same band `@sortable` borrows, and the same one
        // the loader checks in ValidationPhase.validateSortableHasSupportedSubtype. Asking it
        // here instead of hand-listing the exclusions means the generated allowlist cannot
        // drift from what the loader accepts, and a new band-less subtype needs no edit.
        // (object and map are the band-less subtypes today: a map is one jsonb column holding
        // a JSON object, so ORDER BY over it sorts by jsonb collation — meaningless as an
        // ordering, and a 400 on the ports that reject it.)
        List<String> sortFields = sortableFields(entity);

        StringBuilder src = new StringBuilder();
        if (!pkg.isEmpty()) {
            src.append("package ").append(pkg).append(";\n\n");
        }
        src.append("import com.fasterxml.jackson.databind.JsonNode;\n");
        src.append("import com.fasterxml.jackson.databind.ObjectMapper;\n");
        src.append("import ").append(runtimePackage).append(".ConstraintErrors;\n");
        src.append("import ").append(runtimePackage).append(".PatchValidationException;\n");
        src.append("import ").append(runtimePackage).append(".UnreadableBody;\n");
        // The escape the PATCH loop applies to each assigned key before naming a Bean
        // Validation property — see RecordComponentNames for why it is needed at run time.
        src.append("import ").append(runtimePackage).append(".RecordComponentNames;\n");
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
        src.append("import ").append(runtimePackage).append(".FilterParseResult;\n");
        src.append("import ").append(runtimePackage).append(".FilterParser;\n");
        src.append("import ").append(runtimePackage).append(".FilterPredicate;\n");
        src.append("import jakarta.servlet.http.HttpServletRequest;\n");
        src.append("import jakarta.validation.Validator;\n");
        src.append("import java.util.List;\n");
        src.append("import java.util.Map;\n");
        src.append("import java.util.Set;\n\n");

        src.append("/**\n");
        src.append(" * GENERATED — REST controller for ").append(shortName)
           .append(" entity. Implements the cross-port API contract.\n");
        src.append(" *\n");
        src.append(" * <p>Auth: these endpoints are unauthenticated. Require authentication for this path in\n");
        src.append(" * your Spring Security config, e.g. {@code http.authorizeHttpRequests(a ->\n");
        src.append(" * a.requestMatchers(\"").append(routeBase).append("/**\").authenticated())}.\n");
        src.append(" * A row-ownership rule (\"only the owner may read this row\") can't be expressed in path\n");
        src.append(" * config — eject this generator with {@code mvn metaobjects:eject} and hand-write those\n");
        src.append(" * endpoints.\n");
        src.append(" */\n");
        src.append("@RestController\n");
        src.append("@RequestMapping(\"").append(routeBase).append("\")\n");
        src.append("public class ").append(controllerName).append(" {\n\n");

        // Sort allowlist — static per-entity Set. Field-prefixed inner constant keeps it
        // private to this controller (no cross-file collision risk).
        appendSortAllowlist(src, entity, sortFields);
        appendServerOwnedOnCreate(src, entity);
        // #484: the credential fields this entity's rows carry, hidden from every response body.
        List<String> hidden = SpringGeneratorSupport.credentialNames(entity);
        List<SpringM2mSupport.M2mNav> navs = SpringM2mSupport.resolve(entity, loader);
        boolean redacts = !hidden.isEmpty() || navs.stream().anyMatch(n -> !targetCredentials(entity, n).isEmpty());

        // Repository wiring — constructor injection (Spring's recommended idiom; avoids
        // field-injection magic, plays well with final fields + final test seams). The
        // ObjectMapper (Spring's configured bean) binds the FR-035 patch body's per-field
        // values via <Entity>Patch.fromJson, so the same wire codecs apply as on create.
        // FR-036: the injected jakarta Validator runs the DTO's field constraints over HTTP
        // (POST validates the whole DTO; PATCH validates each present value) so a constraint
        // violation returns the cross-port {"error":"validation"} envelope, not Spring's default.
        src.append("    private final ").append(repoName).append(" repository;\n");
        src.append("    private final ObjectMapper objectMapper;\n");
        src.append("    private final Validator validator;\n\n");
        src.append("    public ").append(controllerName).append("(").append(repoName)
           .append(" repository, ObjectMapper objectMapper, Validator validator) {\n");
        src.append("        this.repository = repository;\n");
        src.append("        this.objectMapper = objectMapper;\n");
        src.append("        this.validator = validator;\n");
        src.append("    }\n\n");
        appendUnreadableBodyHandler(src);
        if (redacts) appendRedactHelpers(src);

        // GET (list) — pagination + sort + withCount + FR-009 filter operators.
        // HttpServletRequest carries the raw query string so the bracketed
        // filter[<field>][<op>]=<value> grammar reaches FilterParser intact
        // (Spring's @RequestParam would collapse same-key occurrences).
        appendListHandler(src, shortName, dtoName, repoName, hidden);

        // GET /{id} — single by primary key.
        appendGetByIdHandler(src, pkType, hidden);

        // POST — create. FR-036: bind the raw DTO (no @Valid, whose default 400 body is NOT the
        // cross-port envelope and does not even fire under the standaloneSetup test harness) and
        // validate it EXPLICITLY with the injected Validator, emitting {"error":"validation"} on
        // any field-constraint violation BEFORE persisting.
        src.append("    @PostMapping\n");
        src.append("    public ResponseEntity<?> create(@RequestBody ").append(dtoName).append(" dto) {\n");
        // #484: a @formExclude / credential value is IGNORED (never rejected): the DTO is rebuilt
        // without it, so the column is left to the repository's default.
        appendStripWriteDenied(src, dtoName, SpringGeneratorSupport.dtoComponentFields(entity));
        // A caller does not supply server-owned columns, so a @NotNull on one must not reject
        // the request. The DTO is BOTH the request and the response body, so `id` carries
        // @NotNull because it is @required in the RESPONSE — while being identity.primary
        // @generation:uuid, i.e. a column the database defaults and the caller must not invent.
        // Validating the whole DTO therefore made every POST a 400 for any entity whose PK is
        // @required, and the only "workaround" was a client-invented primary key.
        //
        // The TPH create path has always applied this rule, through
        // SpringGeneratorSupport.settableFields ("the PK is auto-generated and the discriminator is
        // injected from the URL, so neither is validated from the body") — which is why a TPH
        // entity POSTed fine while a vanilla one did not. This is the vanilla path adopting the
        // same rule, so the two write surfaces finally agree.
        //
        // validator.validate(dto) is KEPT rather than narrowed to per-property validateValue:
        // it is what cascades @Valid into nested value objects. The violations are FILTERED,
        // and only by TOP-LEVEL property name — a nested path like "labels[0].code" can never
        // match, so cascaded constraints still reject.
        if (serverOwnedOnCreate(entity).isEmpty()) {
            // Byte-identical to the pre-fix handler for an entity with no server-owned column,
            // so this change moves only the output it has to.
            src.append("        if (!validator.validate(dto).isEmpty()) {\n");
        } else {
            src.append("        if (validator.validate(dto).stream()\n");
            src.append("                .anyMatch(v -> !SERVER_OWNED_ON_CREATE.contains(v.getPropertyPath().toString()))) {\n");
        }
        src.append("            return ResponseEntity.badRequest().body(Map.of(\"error\", \"validation\"));\n");
        src.append("        }\n");
        // Issue #203: honor @autoSet — stamp EVERY onCreate AND onUpdate column with now() before
        // persisting (the caller's value is ignored; a fresh row's updated_at equals its created_at).
        // The stamp is a static helper on the DTO record; entities with no @autoSet field call
        // repository.create(dto) verbatim (byte-identical to the pre-#203 handler).
        String createArg = SpringGeneratorSupport.hasAutoSetFields(entity)
            ? dtoName + ".stampForInsert(dto)" : "dto";
        src.append("        try {\n");
        src.append("            ").append(dtoName).append(" saved = repository.create(").append(createArg).append(");\n");
        src.append("            return ResponseEntity.status(HttpStatus.CREATED).body(")
           .append(redactOne("saved", hidden)).append(");\n");
        appendConstraintCatch(src);
        src.append("    }\n\n");

        // PATCH + PUT — single handler (per API contract; same body shape both verbs).
        // Both verbs MUST be expressed on one @RequestMapping with method={PATCH, PUT}.
        // Stacking @PatchMapping + @PutMapping on the same method does NOT register both
        // in Spring MVC — only one composed @RequestMapping per method is honored, so the
        // other verb 405s. (Surfaced by the SP-F generated-controller HTTP lane.)
        // FR-035 present-key PATCH: bind the RAW JsonNode (not the @Valid full DTO, which
        // conflates absent with null and 400s an omitted @required field), build the
        // presence-tracked <Entity>Patch, and delegate to repository.patch. An explicit
        // null clears a nullable column; an explicit null on a @required field throws
        // PatchValidationException → 400 {"error":"validation"}. update(id, dto) stays on
        // the interface for programmatic full-DTO use.
        String patchName = SpringNaming.patchName(shortName);
        src.append("    @RequestMapping(value = \"/{id}\", method = { RequestMethod.PATCH, RequestMethod.PUT })\n");
        src.append("    public ResponseEntity<?> update(@PathVariable ").append(pkType)
           .append(" id, @RequestBody JsonNode body) {\n");
        src.append("        ").append(patchName).append(" patch;\n");
        src.append("        try {\n");
        src.append("            patch = ").append(patchName).append(".fromJson(body, objectMapper);\n");
        src.append("        } catch (PatchValidationException e) {\n");
        src.append("            return ResponseEntity.badRequest().body(Map.of(\"error\", \"validation\"));\n");
        src.append("        }\n");
        // FR-036: validate each PRESENT patch value against the DTO's field constraints (per-field,
        // NOT a whole-bean validate — that would fire @NotNull on ABSENT fields). jakarta
        // validateValue skips null for @Size/@Pattern and non-required fields carry no @NotNull, so
        // a present-null-clears on a nullable field composes cleanly.
        src.append("        for (Map.Entry<String, Object> __e : patch.assignedValues().entrySet()) {\n");
        src.append("            if (!validator.validateValue(").append(dtoName)
           .append(".class, RecordComponentNames.escape(__e.getKey()), __e.getValue()).isEmpty()) {\n");
        src.append("                return ResponseEntity.badRequest().body(Map.of(\"error\", \"validation\"));\n");
        src.append("            }\n");
        src.append("        }\n");
        // Program D (spec section 0): validateValue does NOT cascade @Valid into a nested value
        // object's own constraints, so validate each PRESENT VO element EXPLICITLY. The property's
        // OWN constraints (@NotNull on a @required column, present-null tristate) are already
        // covered above / in <Entity>Patch.fromJson; this closes the nested-constraint gap (e.g. a
        // Marker.label over @maxLength, or null on a @required nested member) with a 400.
        appendValueObjectValidation(src, entity);
        // Issue #203: honor @autoSet onUpdate — bump every onUpdate column to now() on EVERY partial
        // update (the model value is ignored; the server owns the timestamp), injected AFTER the
        // caller's present values are validated and BEFORE delegating so a PATCH that omits the
        // timestamp still bumps it. onCreate columns are never touched here (created_at is immutable).
        if (SpringGeneratorSupport.hasOnUpdateFields(entity)) {
            src.append("        patch.stampAutoSetOnUpdate();\n");
        }
        src.append("        try {\n");
        src.append("            return repository.patch(id, patch)\n");
        src.append("                    .<ResponseEntity<?>>map(").append(okMapper(hidden)).append(")\n");
        src.append("                    .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of(\"error\", \"not_found\")));\n");
        appendConstraintCatch(src);
        src.append("    }\n\n");

        // DELETE — 204 on success, 404 envelope on miss.
        src.append("    @DeleteMapping(\"/{id}\")\n");
        src.append("    public ResponseEntity<?> delete(@PathVariable ").append(pkType).append(" id) {\n");
        src.append("        try {\n");
        src.append("            if (repository.delete(id)) {\n");
        src.append("                return ResponseEntity.noContent().build();\n");
        src.append("            }\n");
        src.append("            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of(\"error\", \"not_found\"));\n");
        appendConstraintCatch(src);
        src.append("    }\n\n");

        // FR-018 M:N traversal — GET /{id}/<relationName> exposes each
        // @cardinality:"many" + @through relationship as a sub-resource of the source,
        // returning the related target rows. The source URL segment is the entity name
        // pluralized (handled by @RequestMapping above); the relation segment is the
        // relationship name. Related-row order is not contractual. The repository finder
        // traverses the junction (hetero / directed self-join / symmetric union-on-read).
        for (SpringM2mSupport.M2mNav nav : navs) {
            String finder = SpringGeneratorSupport.m2mFinderName(nav.relationName());
            String navCall = "repository." + finder + "(id" + SpringGeneratorSupport.targetSubtypeCallArg(nav) + ")";
            src.append("    @GetMapping(\"/{id}/").append(nav.relationName()).append("\")\n");
            if (targetCredentials(entity, nav).isEmpty()) {
                src.append("    public ResponseEntity<List<").append(nav.targetDtoType()).append(">> ")
                   .append(finder).append("(@PathVariable ").append(pkType).append(" id) {\n");
                src.append("        return ResponseEntity.ok(").append(navCall).append(");\n");
            } else {
                src.append("    public ResponseEntity<List<Object>> ")
                   .append(finder).append("(@PathVariable ").append(pkType).append(" id) {\n");
                src.append("        return ResponseEntity.ok(")
                   .append(redactAll(navCall, targetCredentials(entity, nav))).append(");\n");
            }
            src.append("    }\n\n");
        }

        // parseSort — returns null on malformed/disallowed input. Returning null lets the
        // list handler emit the 400 envelope itself rather than throwing — cleaner
        // separation. The DEFAULT_PK_FIELD constant below is referenced from the per-entity
        // controller so this helper is package-internal to each generated file.
        appendParseSortHelper(src, repoName);
        src.append("}\n");

        try {
            Path outFile = outRoot.resolve(pkg.replace('.', '/')).resolve(controllerName + ".java");
            GeneratedFileWriter.write(outFile, src.toString());
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing " + controllerName + ".java for entity " + entity.getName() + ": " + e, e);
        }
    }

    /**
     * Program D — append per-value-object nested-validation guards into the vanilla PATCH handler,
     * one per {@code field.object @storage:jsonb} column (spec section 0). A present single VO
     * value is validated whole; a present array is validated element-by-element. Skips null
     * (present-null clears / is caught upstream) so the tristate composes. Emits nothing for an
     * entity with no value-object columns, keeping non-VO controllers byte-identical.
     */
    private static void appendValueObjectValidation(StringBuilder src, MetaObject entity) {
        for (ObjectField vf : SpringGeneratorSupport.valueObjectJsonbFields(entity)) {
            String name = vf.getName();
            // has<Cap>() needs no escape — capitalisation already clears the collision — but
            // the value accessor does.
            String accessor = SpringNaming.recordComponentName(name);
            String cap = SpringNaming.capitalize(name);
            if (vf.isArrayType()) {
                appendElementValidationLoop(src, accessor, cap, "patch." + accessor + "()");
            } else {
                src.append("        if (patch.has").append(cap).append("() && patch.")
                   .append(accessor).append("() != null && !validator.validate(patch.")
                   .append(accessor).append("()).isEmpty()) {\n");
                src.append("            return ResponseEntity.badRequest().body(Map.of(\"error\", \"validation\"));\n");
                src.append("        }\n");
            }
        }
        // A field.map @objectRef carries the same nested value objects, and the POST path
        // cascades into them via @Valid on the DTO component. PATCH validates field-by-field
        // with validateValue, which does NOT cascade — so without this the two write paths
        // disagree for maps where they agree for field.object, and a PATCH could write a
        // nested value object POST rejects. The map's VALUES are the beans (keys are strings).
        for (MetaField vf : SpringGeneratorSupport.valueObjectMapFields(entity)) {
            String name = vf.getName();
            String accessor = SpringNaming.recordComponentName(name);
            appendElementValidationLoop(
                src, accessor, SpringNaming.capitalize(name), "patch." + accessor + "().values()");
        }
    }

    /**
     * Emit the present-and-non-null guard plus an element-wise {@code validator.validate} loop
     * over {@code iterableExpr}. Shared by the array-of-value-object branch and the
     * map-of-value-object branch: they differ ONLY in the iterable expression, and writing the
     * body twice meant the 400 envelope existed in three places, so adding an error code (as
     * other ports have) would have missed one.
     *
     * @param accessor the field's Java accessor name — ALREADY escaped via
     *     {@link SpringNaming#recordComponentName}. Each caller escapes once and derives both
     *     this and {@code iterableExpr} from that one local, so the two cannot disagree; the
     *     escape is not repeated here because {@code iterableExpr} is the caller's to build.
     * @param cap the DECLARED name capitalised, for {@code has<Cap>()} — never escaped,
     *     because capitalisation already clears the collision with {@code Object}'s methods.
     */
    private static void appendElementValidationLoop(
            StringBuilder src, String accessor, String cap, String iterableExpr) {
        src.append("        if (patch.has").append(cap).append("() && patch.")
           .append(accessor).append("() != null) {\n");
        src.append("            for (var __el : ").append(iterableExpr).append(") {\n");
        src.append("                if (__el != null && !validator.validate(__el).isEmpty()) {\n");
        src.append("                    return ResponseEntity.badRequest().body(Map.of(\"error\", \"validation\"));\n");
        src.append("                }\n");
        src.append("            }\n");
        src.append("        }\n");
    }

    /**
     * The same element-wise {@code validator.validate} loop as
     * {@link #appendElementValidationLoop}, minus the presence guard — for a body bound as the
     * union {@code <Base>Dto}, whose accessors are plain (no {@code hasX()} tristate). Used by
     * the TPH per-subtype CREATE path, where absent and null are already indistinguishable on
     * the bound DTO, so a null check is the whole guard.
     *
     * <p>#362: without this the TPH create validated a {@code field.map @objectRef} with
     * {@code validateValue}, which applies the property's own constraints and does NOT cascade
     * {@code @Valid} into the map's values — so a posted
     * {@code {"labels": {"k": {...invalid...}}}} was accepted and written.
     */
    private static void appendMapValueValidationLoop(StringBuilder src, String accessorExpr) {
        src.append("        if (").append(accessorExpr).append(" != null) {\n");
        src.append("            for (var __el : ").append(accessorExpr).append(".values()) {\n");
        src.append("                if (__el != null && !validator.validate(__el).isEmpty()) {\n");
        src.append("                    return ResponseEntity.badRequest().body(Map.of(\"error\", \"validation\"));\n");
        src.append("                }\n");
        src.append("            }\n");
        src.append("        }\n");
    }


    /**
     * F22 — emit the READ-ONLY {@code @RestController} for a view-only
     * {@code object.projection}: GET list + GET by id, with {@code POST} on the collection
     * and {@code PATCH} / {@code PUT} / {@code DELETE} on the item each answering
     * {@code 405 {"error": "method_not_allowed"}}.
     *
     * <p>405 and not 404: the resource plainly exists — the same path answers GET — and a
     * 404 would tell a caller the collection is absent when it is merely not writable. The
     * verbs are mounted EXPLICITLY rather than left to Spring, which answers an unmatched
     * method on a matched path with its own error body and would put a fifth body shape on
     * a wire the other four ports spell one way. PUT is among them because the writable
     * controller serves it; the verb a projection forgets to refuse is the one that falls
     * through to a 404 — which is exactly what TypeScript did until this corpus caught it.
     * {@code message} is free prose and is deliberately not part of the asserted contract.</p>
     *
     * <p>A SEPARATE assembly rather than {@code if (writable)} branches through
     * {@link #emit(MetaObject, Path)}. That method carries create/update DTO validation, the
     * FR-035 present-key tristate, {@code @autoSet} stamping, the FR-037 frozen-field strip
     * and constraint-error classification — every one of which is meaningless here, and
     * threading a flag through all of them is how a read-only surface drifts into carrying
     * write machinery it can never run. What the two genuinely share (the list + get
     * handlers, the sort allowlist, parseSort) they share by calling the same emitters.</p>
     *
     * <p>The item verbs follow the item GET. A projection's identity is OPTIONAL
     * (ADR-0028), and a keyless one mounts no {@code /{id}} read — so it refuses only the
     * collection verb, rather than advertising an address it never serves.</p>
     *
     * <p>FR-044: a served {@code object.report} is emitted here too, from its read model.
     * A report has no identity at all, so it is always the keyless shape: the list, the
     * collection 405, and no {@code /{id}} mapping of any verb.</p>
     */
    protected void emitReadOnly(MetaObject entity, Path outRoot) {
        // What the javadoc and the 405 message call this object. Free prose on the wire
        // (`message` is not part of the asserted contract), but it must not call a report
        // a projection.
        String noun = SpringNaming.readOnlyNoun(entity);
        String[] split = SpringNaming.splitFqn(entity.getName());
        String pkg = split[0];
        String shortName = split[1];
        String dtoName = SpringNaming.dtoName(shortName);
        String repoName = SpringNaming.repositoryName(shortName);
        String controllerName = SpringNaming.controllerName(shortName);
        String routeBase = SpringNaming.controllerPath(shortName);
        boolean hasItem = RestSurfaceGate.hasItemRoute(entity);
        String pkType = SpringTypeMapper.primaryKeyJavaType(entity);

        List<String> sortFields = sortableFields(entity);

        StringBuilder src = new StringBuilder();
        if (!pkg.isEmpty()) {
            src.append("package ").append(pkg).append(";\n\n");
        }
        src.append("import org.springframework.http.HttpStatus;\n");
        src.append("import org.springframework.http.ResponseEntity;\n");
        src.append("import org.springframework.web.bind.annotation.GetMapping;\n");
        if (hasItem) {
            src.append("import org.springframework.web.bind.annotation.PathVariable;\n");
        }
        src.append("import org.springframework.web.bind.annotation.PostMapping;\n");
        src.append("import org.springframework.web.bind.annotation.RequestMapping;\n");
        if (hasItem) {
            src.append("import org.springframework.web.bind.annotation.RequestMethod;\n");
        }
        src.append("import org.springframework.web.bind.annotation.RequestParam;\n");
        src.append("import org.springframework.web.bind.annotation.RestController;\n");
        src.append("import ").append(runtimePackage).append(".FilterParseResult;\n");
        src.append("import ").append(runtimePackage).append(".FilterParser;\n");
        src.append("import ").append(runtimePackage).append(".FilterPredicate;\n");
        if (reportExport && com.metaobjects.generator.util.GeneratorUtil.isReport(entity)) {
            src.append("import ").append(runtimePackage).append(".ReportExport;\n");
            src.append("import org.springframework.http.MediaType;\n");
        }
        src.append("import jakarta.servlet.http.HttpServletRequest;\n");
        src.append("import java.util.List;\n");
        src.append("import java.util.Map;\n");
        src.append("import java.util.Set;\n\n");

        src.append("/**\n");
        src.append(" * GENERATED — READ-ONLY REST controller for the ").append(shortName)
           .append(" ").append(noun).append(".\n");
        if (!com.metaobjects.generator.util.GeneratorUtil.isReport(entity)) {
            src.append(" * Implements the cross-port API contract: GET list + GET by id; every write\n");
            src.append(" * verb answers 405 {\"error\": \"method_not_allowed\"}.\n");
        } else {
            src.append(" * Implements the cross-port API contract: GET list; POST answers\n");
            src.append(" * 405 {\"error\": \"method_not_allowed\"}. A report has no identity, so no item\n");
            src.append(" * route is mounted.\n");
        }
        src.append(" *\n");
        src.append(" * <p>Auth: these read endpoints are unauthenticated. Require authentication for this path\n");
        src.append(" * in your Spring Security config, e.g. {@code http.authorizeHttpRequests(a ->\n");
        src.append(" * a.requestMatchers(\"").append(routeBase).append("/**\").authenticated())}.\n");
        src.append(" * A row-ownership rule (\"only the owner may read this row\") can't be expressed in path\n");
        src.append(" * config — eject this generator with {@code mvn metaobjects:eject} and hand-write those\n");
        src.append(" * endpoints.\n");
        src.append(" */\n");
        src.append("@RestController\n");
        src.append("@RequestMapping(\"").append(routeBase).append("\")\n");
        src.append("public class ").append(controllerName).append(" {\n\n");

        appendSortAllowlist(src, entity, sortFields);

        // Repository wiring — constructor injection, the read-only seam only. No
        // ObjectMapper and no Validator: nothing here binds a request body, so injecting
        // either would make a consumer wire beans this controller can never use.
        src.append("    private final ").append(repoName).append(" repository;\n\n");
        src.append("    public ").append(controllerName).append("(").append(repoName)
           .append(" repository) {\n");
        src.append("        this.repository = repository;\n");
        src.append("    }\n\n");

        if (com.metaobjects.generator.util.GeneratorUtil.isReport(entity)) {
            appendReportListHandler(src, shortName, dtoName, repoName, reportMaxRows, reportExport, routeBase);
        } else {
            appendListHandler(src, shortName, dtoName, repoName, List.of());
        }
        if (hasItem) {
            appendGetByIdHandler(src, pkType, List.of());
        }

        src.append("    @PostMapping\n");
        src.append("    public ResponseEntity<?> create() {\n");
        src.append("        return methodNotAllowed(\"POST\");\n");
        src.append("    }\n\n");
        if (hasItem) {
            // One mapping for all three item verbs: the bodies are identical and only the
            // verb NAME differs, which the request carries. Stacking @PatchMapping +
            // @PutMapping on one method does NOT register both in Spring MVC (see emit()),
            // so the method= list is the form that works.
            src.append("    @RequestMapping(value = \"/{id}\", method = { RequestMethod.PATCH, RequestMethod.PUT, RequestMethod.DELETE })\n");
            src.append("    public ResponseEntity<?> rejectItemWrite(@PathVariable ").append(pkType)
               .append(" id, HttpServletRequest request) {\n");
            src.append("        return methodNotAllowed(request.getMethod());\n");
            src.append("    }\n\n");
        }
        src.append("    private static ResponseEntity<?> methodNotAllowed(String verb) {\n");
        src.append("        return ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED)\n");
        src.append("                .body(Map.of(\"error\", \"method_not_allowed\",\n");
        src.append("                        \"message\", verb + \" is not supported on a ").append(noun)
           .append(" (read-only).\"));\n");
        src.append("    }\n\n");

        appendParseSortHelper(src, repoName);
        src.append("}\n");

        try {
            Path outFile = outRoot.resolve(pkg.replace('.', '/')).resolve(controllerName + ".java");
            GeneratedFileWriter.write(outFile, src.toString());
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing " + controllerName + ".java for " + noun + " " + entity.getName() + ": " + e, e);
        }
    }

    // -----------------------------------------------------------------------
    // Emitters shared by the WRITABLE controller (emit) and the READ-ONLY one
    // (emitReadOnly). Extracted verbatim from emit(), split at exactly the points
    // that keep its output byte-identical: a read-only projection serves the same
    // list + get + sort surface a table entity does, and the F22 change must not be
    // able to reword one of them and not the other.
    //
    // emitTph() keeps its own copies. A TPH base's list and get are DISCRIMINATOR-
    // scoped and its parseSort names a different repository type, so they are not the
    // same emitter wearing a flag.
    // -----------------------------------------------------------------------

    /**
     * The sortable field names: those whose subtype can be ORDERED at all.
     * {@code FilterOps.supportsFiltering} is the canonical cross-port answer — the same
     * band {@code @sortable} borrows and the loader checks in
     * {@code ValidationPhase.validateSortableHasSupportedSubtype} — so the generated
     * allowlist cannot drift from what the loader accepts, and a new band-less subtype
     * needs no edit here. (object and map are the band-less subtypes today: a map is one
     * jsonb column holding a JSON object, so ORDER BY over it sorts by jsonb collation —
     * meaningless as an ordering, and a 400 on the ports that reject it.)
     */
    private static List<String> sortableFields(MetaObject entity) {
        List<String> sortFields = new ArrayList<>();
        for (MetaField field : entity.getMetaFields()) {
            if (!FilterOps.supportsFiltering(field.getSubType())) continue;
            // A derived report field over an array is not sortable (a map has no band above).
            if (com.metaobjects.generator.util.GeneratorUtil.isReport(entity) && (field.isArrayType() || field instanceof com.metaobjects.field.MapField)) continue;
            sortFields.add(field.getName());
        }
        return sortFields;
    }

    /**
     * The static per-controller SORT_ALLOWLIST set plus its SORT_DEFAULT_ORDER map.
     * Field-prefixed inner constants keep them private to this controller (no
     * cross-file collision risk).
     */
    private static void appendSortAllowlist(StringBuilder src, MetaObject entity, List<String> sortFields) {
        src.append("    private static final Set<String> SORT_ALLOWLIST = Set.of(");
        for (int i = 0; i < sortFields.size(); i++) {
            if (i > 0) src.append(", ");
            src.append('"').append(sortFields.get(i)).append('"');
        }
        src.append(");\n\n");
        appendSortDefaultOrders(src, entity, sortFields);
    }

    /**
     * ADR-0019 Amendment 1 (W2/W3): a body Jackson cannot bind (a malformed or out-of-range
     * decimal, a wrong JSON type) answers {@code 400 {"error":"validation","field":...}}, the
     * cross-port validation envelope, rather than Spring's default body.
     */
    private static void appendUnreadableBodyHandler(StringBuilder src) {
        src.append("    @org.springframework.web.bind.annotation.ExceptionHandler(")
           .append("org.springframework.http.converter.HttpMessageNotReadableException.class)\n");
        src.append("    public ResponseEntity<?> onUnreadableBody(")
           .append("org.springframework.http.converter.HttpMessageNotReadableException e) {\n");
        src.append("        return ResponseEntity.badRequest().body(UnreadableBody.envelope(e));\n");
        src.append("    }\n\n");
    }

    /**
     * GET (list) — pagination + sort + withCount + FR-009 filter operators.
     * HttpServletRequest carries the raw query string so the bracketed
     * filter[&lt;field&gt;][&lt;op&gt;]=&lt;value&gt; grammar reaches FilterParser intact
     * (Spring's {@code @RequestParam} would collapse same-key occurrences).
     */
    private static void appendListHandler(StringBuilder src, String shortName, String dtoName, String repoName,
            List<String> hidden) {
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
        // `field` names the rejected sort field — required on every cross-port
        // invalid_sort envelope. `sort` is non-null in this branch and split()
        // always yields at least one element, so the index is safe.
        src.append("                return ResponseEntity.badRequest().body(Map.of(\"error\", \"invalid_sort\", \"field\", sort.split(\":\", 2)[0]));\n");
        src.append("            }\n");
        src.append("        }\n");
        src.append("        FilterParseResult filter = FilterParser.parse(\n");
        src.append("                request.getQueryString(), ").append(allowlistName).append(".FIELDS, ")
           .append(allowlistName).append(".OPS_BY_FIELD, ").append(allowlistName).append(".DECIMAL_FIELDS);\n");
        src.append("        if (filter.error() != null) {\n");
        src.append("            return ResponseEntity.badRequest().body(Map.of(\"error\", filter.error(), \"field\", filter.field()));\n");
        src.append("        }\n");
        src.append("        List<FilterPredicate> filters = filter.predicates();\n");
        src.append("        List<").append(dtoName)
           .append("> rows = repository.list(actualLimit, actualOffset, sortClause, filters);\n");
        src.append("        if (withCount != null && withCount == 1) {\n");
        src.append("            long total = repository.count(filters);\n");
        src.append("            return ResponseEntity.ok(Map.of(\"rows\", ").append(redactAll("rows", hidden))
           .append(", \"total\", total));\n");
        src.append("        }\n");
        src.append("        return ResponseEntity.ok(").append(redactAll("rows", hidden)).append(");\n");
        src.append("    }\n\n");
    }

    /**
     * GET (list) of a report: every row up to the cap, refused above it. There is no page
     * default and nothing is truncated; a request that would answer more than {@code maxRows}
     * rows is {@code 400 {"error": "report_too_large", "maxRows": N}} before any body is
     * written (the repository is asked for one row past the cap when no {@code limit} is sent).
     * A bound that is not usable (limit below 1, negative offset, not an integer) is refused with
     * {@code pagination.invalid_value}, the envelope the TypeScript mounts use, instead of being
     * ignored or answered by the framework's own conversion error. The bounds arrive as text so
     * this handler, not Spring, decides what a bad one answers.
     */
    private static void appendReportListHandler(StringBuilder out, String shortName, String dtoName,
                                                String repoName, int maxRows, boolean export,
                                                String routeBase) {
        StringBuilder src = new StringBuilder();
        appendReportListHandlerBody(src, shortName, dtoName, repoName, maxRows, export, routeBase);
        String handler = src.toString();
        if (export) {
            // With the export branch wired, no answer of the list route consults Accept (the
            // selector is ?format): every body carries an explicit application/json, which
            // Spring then honours instead of negotiating against the request's Accept header.
            handler = handler.replace("ResponseEntity.badRequest().body(", "badRequest(")
                .replaceAll("ResponseEntity\\.ok\\((?!\\))", "ok(");
        }
        out.append(handler);
        if (export) {
            out.append("    private static ResponseEntity<Object> badRequest(Object body) {\n");
            out.append("        return ResponseEntity.badRequest().contentType(MediaType.APPLICATION_JSON).body(body);\n");
            out.append("    }\n\n");
            out.append("    private static ResponseEntity<Object> ok(Object body) {\n");
            out.append("        return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).body(body);\n");
            out.append("    }\n\n");
        }
    }

    private static void appendReportListHandlerBody(StringBuilder src, String shortName, String dtoName,
                                                String repoName, int maxRows, boolean export,
                                                String routeBase) {
        String allowlistName = SpringNaming.filterAllowlistName(shortName);
        src.append("    @GetMapping\n");
        src.append("    public ResponseEntity<?> list(\n");
        src.append("            @RequestParam(required = false) String limit,\n");
        src.append("            @RequestParam(required = false) String offset,\n");
        src.append("            @RequestParam(required = false) String sort,\n");
        if (export) {
            // Text, not Integer: an export request spells the flag "true" as well as "1", and
            // this handler, not Spring's conversion, decides what each answers.
            src.append("            @RequestParam(required = false, name = \"withCount\") String withCount,\n");
            src.append("            @RequestParam(required = false, name = \"format\") String format,\n");
        } else {
            src.append("            @RequestParam(required = false, name = \"withCount\") Integer withCount,\n");
        }
        src.append("            HttpServletRequest request) {\n");
        if (export) {
            src.append("        if (format != null) {\n");
            src.append("            return export(format, limit, offset, sort, withCount, request);\n");
            src.append("        }\n");
        }
        src.append("        final int maxRows = ").append(maxRows).append(";\n");
        src.append("        Integer requestedLimit = null;\n");
        src.append("        if (limit != null) {\n");
        src.append("            Long parsed = parseBound(limit, 1);\n");
        src.append("            if (parsed == null) {\n");
        src.append("                return ResponseEntity.badRequest().body(Map.of(\"error\", \"pagination.invalid_value\", \"param\", \"limit\", \"value\", limit, \"expected\", \"an integer from 1 to \" + maxRows));\n");
        src.append("            }\n");
        src.append("            if (parsed > maxRows) {\n");
        src.append("                return ResponseEntity.badRequest().body(Map.of(\"error\", \"report_too_large\", \"maxRows\", maxRows));\n");
        src.append("            }\n");
        src.append("            requestedLimit = parsed.intValue();\n");
        src.append("        }\n");
        src.append("        int actualOffset = 0;\n");
        src.append("        if (offset != null) {\n");
        src.append("            Long parsed = parseBound(offset, 0);\n");
        src.append("            if (parsed == null) {\n");
        src.append("                return ResponseEntity.badRequest().body(Map.of(\"error\", \"pagination.invalid_value\", \"param\", \"offset\", \"value\", offset, \"expected\", \"a non-negative integer (0 or more)\"));\n");
        src.append("            }\n");
        src.append("            actualOffset = (int) Math.min(parsed, Integer.MAX_VALUE);\n");
        src.append("        }\n");
        src.append("        ").append(repoName).append(".SortClause sortClause = null;\n");
        src.append("        if (sort != null) {\n");
        src.append("            sortClause = parseSort(sort);\n");
        src.append("            if (sortClause == null) {\n");
        src.append("                return ResponseEntity.badRequest().body(Map.of(\"error\", \"invalid_sort\", \"field\", sort.split(\":\", 2)[0]));\n");
        src.append("            }\n");
        src.append("        }\n");
        src.append("        FilterParseResult filter = FilterParser.parse(\n");
        src.append("                request.getQueryString(), ").append(allowlistName).append(".FIELDS, ")
           .append(allowlistName).append(".OPS_BY_FIELD, ").append(allowlistName).append(".DECIMAL_FIELDS);\n");
        src.append("        if (filter.error() != null) {\n");
        src.append("            return ResponseEntity.badRequest().body(Map.of(\"error\", filter.error(), \"field\", filter.field()));\n");
        src.append("        }\n");
        src.append("        List<FilterPredicate> filters = filter.predicates();\n");
        src.append("        List<").append(dtoName)
           .append("> rows = repository.list(requestedLimit != null ? requestedLimit : maxRows + 1, actualOffset, sortClause, filters);\n");
        src.append("        if (requestedLimit == null && rows.size() > maxRows) {\n");
        src.append("            return ResponseEntity.badRequest().body(Map.of(\"error\", \"report_too_large\", \"maxRows\", maxRows));\n");
        src.append("        }\n");
        if (export) {
            src.append("        if (\"1\".equals(withCount)) {\n");
        } else {
            src.append("        if (withCount != null && withCount == 1) {\n");
        }
        src.append("            long total = repository.count(filters);\n");
        src.append("            return ResponseEntity.ok(Map.of(\"rows\", rows, \"total\", total));\n");
        src.append("        }\n");
        src.append("        return ResponseEntity.ok(rows);\n");
        src.append("    }\n\n");
        if (export) {
            appendReportExportHandler(src, shortName, dtoName, repoName, routeBase);
        }
        src.append("    /** A page bound as an integer of at least {@code min}, or null when it is not one. */\n");
        src.append("    private static Long parseBound(String raw, long min) {\n");
        src.append("        try {\n");
        src.append("            long n = Long.parseLong(raw);\n");
        src.append("            return n >= min ? n : null;\n");
        src.append("        } catch (NumberFormatException e) {\n");
        src.append("            return null;\n");
        src.append("        }\n");
        src.append("    }\n\n");
    }

    /**
     * {@code GET ?format=csv|json|xml} of a report, the {@code report-export} branch of the list
     * route. The same sort and filter parsing, allowlists and 400 envelopes as the list; the
     * differences are the cap and the body. An absent {@code limit} reads every row up to
     * {@code <Report>Export.MAX_ROWS} (one more row is read to tell the cap from more than the
     * cap, and the answer is {@code export_too_large} before a byte is written); an explicit
     * {@code limit} above the cap is the same refusal, and one within it pages. With a format the
     * export cap governs and {@code report_too_large} never answers. {@code withCount} is refused
     * with CSV and XML; a JSON export with {@code withCount=1} is the list route's
     * {@code { rows, total }} envelope. {@code Accept} is never read.
     */
    private static void appendReportExportHandler(StringBuilder src, String shortName, String dtoName,
                                                  String repoName, String routeBase) {
        String allowlistName = SpringNaming.filterAllowlistName(shortName);
        String exportName = shortName + "Export";
        src.append("    private ResponseEntity<?> export(String format, String limit, String offset, String sort,\n");
        src.append("            String withCount, HttpServletRequest request) {\n");
        src.append("        final int maxRows = ").append(exportName).append(".MAX_ROWS;\n");
        src.append("        if (!ReportExport.isFormat(format)) {\n");
        src.append("            return ResponseEntity.badRequest().body(ReportExport.invalidFormat());\n");
        src.append("        }\n");
        src.append("        if (!ReportExport.JSON.equals(format) && ReportExport.isTruthy(withCount)) {\n");
        src.append("            return ResponseEntity.badRequest().body(ReportExport.withCount());\n");
        src.append("        }\n");
        src.append("        Integer requestedLimit = null;\n");
        src.append("        if (limit != null) {\n");
        src.append("            Long parsed = parseBound(limit, 1);\n");
        src.append("            if (parsed == null) {\n");
        src.append("                return ResponseEntity.badRequest().body(Map.of(\"error\", \"pagination.invalid_value\", \"param\", \"limit\", \"value\", limit, \"expected\", \"an integer from 1 to \" + maxRows));\n");
        src.append("            }\n");
        src.append("            if (parsed > maxRows) {\n");
        src.append("                return ResponseEntity.badRequest().body(ReportExport.tooLarge(maxRows));\n");
        src.append("            }\n");
        src.append("            requestedLimit = parsed.intValue();\n");
        src.append("        }\n");
        src.append("        int actualOffset = 0;\n");
        src.append("        if (offset != null) {\n");
        src.append("            Long parsed = parseBound(offset, 0);\n");
        src.append("            if (parsed == null) {\n");
        src.append("                return ResponseEntity.badRequest().body(Map.of(\"error\", \"pagination.invalid_value\", \"param\", \"offset\", \"value\", offset, \"expected\", \"a non-negative integer (0 or more)\"));\n");
        src.append("            }\n");
        src.append("            actualOffset = (int) Math.min(parsed, Integer.MAX_VALUE);\n");
        src.append("        }\n");
        src.append("        ").append(repoName).append(".SortClause sortClause = null;\n");
        src.append("        if (sort != null) {\n");
        src.append("            sortClause = parseSort(sort);\n");
        src.append("            if (sortClause == null) {\n");
        src.append("                return ResponseEntity.badRequest().body(Map.of(\"error\", \"invalid_sort\", \"field\", sort.split(\":\", 2)[0]));\n");
        src.append("            }\n");
        src.append("        }\n");
        src.append("        FilterParseResult filter = FilterParser.parse(\n");
        src.append("                request.getQueryString(), ").append(allowlistName).append(".FIELDS, ")
           .append(allowlistName).append(".OPS_BY_FIELD, ").append(allowlistName).append(".DECIMAL_FIELDS);\n");
        src.append("        if (filter.error() != null) {\n");
        src.append("            return ResponseEntity.badRequest().body(Map.of(\"error\", filter.error(), \"field\", filter.field()));\n");
        src.append("        }\n");
        src.append("        List<").append(dtoName)
           .append("> rows = repository.list(requestedLimit != null ? requestedLimit : maxRows + 1, actualOffset, sortClause, filter.predicates());\n");
        src.append("        if (requestedLimit == null && rows.size() > maxRows) {\n");
        src.append("            return ResponseEntity.badRequest().body(ReportExport.tooLarge(maxRows));\n");
        src.append("        }\n");
        src.append("        ResponseEntity.BodyBuilder ok = ResponseEntity.ok()\n");
        src.append("                .header(\"Content-Disposition\", ReportExport.contentDisposition(\"")
           .append(routeBase.substring(routeBase.lastIndexOf('/') + 1)).append("\", format))\n");
        src.append("                .header(\"Content-Type\", ReportExport.contentType(format));\n");
        src.append("        switch (format) {\n");
        src.append("            case ReportExport.CSV:\n");
        src.append("                return ok.body(").append(exportName).append(".csv(rows));\n");
        src.append("            case ReportExport.XML:\n");
        src.append("                return ok.body(").append(exportName).append(".xml(rows));\n");
        src.append("            default:\n");
        src.append("                if (\"1\".equals(withCount)) {\n");
        src.append("                    return ok.body(Map.of(\"rows\", rows, \"total\", repository.count(filter.predicates())));\n");
        src.append("                }\n");
        src.append("                return ok.body(rows);\n");
        src.append("        }\n");
        src.append("    }\n\n");
    }

    /** GET /{id} — single by primary key, 404 envelope on a miss. */
    private static void appendGetByIdHandler(StringBuilder src, String pkType, List<String> hidden) {
        src.append("    @GetMapping(\"/{id}\")\n");
        src.append("    public ResponseEntity<?> get(@PathVariable ").append(pkType).append(" id) {\n");
        src.append("        return repository.findById(id)\n");
        src.append("                .<ResponseEntity<?>>map(").append(okMapper(hidden)).append(")\n");
        src.append("                .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of(\"error\", \"not_found\")));\n");
        src.append("    }\n\n");
    }

    /**
     * parseSort — returns null on malformed/disallowed input. Returning null lets the
     * list handler emit the 400 envelope itself rather than throwing — cleaner
     * separation. Package-internal to each generated file.
     */
    private static void appendParseSortHelper(StringBuilder src, String repoName) {
        src.append("    private static ").append(repoName).append(".SortClause parseSort(String raw) {\n");
        src.append("        String[] parts = raw.split(\":\", 2);\n");
        src.append("        if (parts.length == 0 || parts[0].isEmpty() || !SORT_ALLOWLIST.contains(parts[0])) return null;\n");
        // `?sort=field` with no `:order` takes the field's DECLARED @sortableDefaultOrder.
        // The "asc" fallback stays HERE, at the read, so it is spelled once per port and
        // SORT_DEFAULT_ORDER carries declarations only.
        src.append("        String dir = parts.length == 2 ? parts[1].toLowerCase()\n");
        src.append("            : SORT_DEFAULT_ORDER.getOrDefault(parts[0], \"asc\");\n");
        src.append("        if (!dir.equals(\"asc\") && !dir.equals(\"desc\")) return null;\n");
        src.append("        return new ").append(repoName).append(".SortClause(parts[0], dir);\n");
        src.append("    }\n");
    }

    /**
     * FR-017 TPH: emit the discriminator-base controller. ONE {@code @RestController} at
     * {@code /api/<base-plural>} mounting:
     * <ul>
     *   <li>the polymorphic collection — {@code GET /} (union list) + {@code GET /{id}} (any subtype);</li>
     *   <li>per subtype {@code <seg>} (the {@code @discriminatorValue} lowercased): {@code GET /<seg>}
     *       (subtype-scoped list), {@code GET /<seg>/{id}} (404 cross-subtype),
     *       {@code POST /<seg>} (discriminator injected from the URL, never the body; body values
     *       validated against the subtype {@code <Sub>Dto} constraints &rarr; 400 {@code {"error":"validation"}}),
     *       {@code PATCH|PUT /<seg>/{id}} (404 cross-subtype; discriminator immutable),
     *       {@code DELETE /<seg>/{id}} (404 cross-subtype).</li>
     * </ul>
     *
     * <p>Every endpoint uses the base {@code <Base>Dto} — for a TPH base that DTO carries the UNION
     * of all subtype columns (folded nullable by {@link SpringDtoGenerator}), so a polymorphic row
     * surfaces its subtype-specific values and a per-subtype POST body binds its own columns. The
     * controller delegates to the TPH-shaped {@code <Base>Repository}
     * ({@link SpringRepositoryGenerator}); the discriminator value per subtype route is baked in
     * from the {@link TphPlan}.</p>
     */
    protected void emitTph(MetaObject base, TphPlan.Plan plan, Path outRoot) {
        String[] split = SpringNaming.splitFqn(base.getName());
        String pkg = split[0];
        String shortName = split[1];
        String dtoName = SpringNaming.dtoName(shortName);
        String repoName = SpringNaming.repositoryName(shortName);
        String controllerName = SpringNaming.controllerName(shortName);
        String routeBase = SpringNaming.controllerPath(shortName);
        String allowlistName = SpringNaming.filterAllowlistName(shortName);
        // The single TPH table is keyed by the BASE's primary identity — every polymorphic
        // + per-subtype by-id route binds that derived PK type (uuid → java.util.UUID, …).
        String pkType = SpringTypeMapper.primaryKeyJavaType(base);

        // Sort allowlist: the base's own scalar columns (the polymorphic sort surface). Subtype
        // columns are not sortable across the polymorphic collection. Same canonical band as the
        // vanilla allowlist above — hand-listing the exclusions here had already drifted from it.
        List<String> sortFields = new ArrayList<>();
        for (MetaField field : base.getMetaFields()) {
            if (!FilterOps.supportsFiltering(field.getSubType())) continue;
            sortFields.add(field.getName());
        }

        StringBuilder src = new StringBuilder();
        if (!pkg.isEmpty()) src.append("package ").append(pkg).append(";\n\n");
        // FR-036 Program B: the per-subtype update handler binds the RAW JsonNode + builds the
        // presence-tracked <Sub>Patch (present-key PATCH tristate), so it needs Jackson + the
        // PatchValidationException + the jakarta Validator (present-value constraint checks) —
        // exactly the vanilla update handler's dependency set.
        src.append("import com.fasterxml.jackson.databind.JsonNode;\n");
        src.append("import com.fasterxml.jackson.databind.ObjectMapper;\n");
        src.append("import ").append(runtimePackage).append(".ConstraintErrors;\n");
        src.append("import ").append(runtimePackage).append(".PatchValidationException;\n");
        src.append("import ").append(runtimePackage).append(".UnreadableBody;\n");
        // The escape the PATCH loop applies to each assigned key before naming a Bean
        // Validation property — see RecordComponentNames for why it is needed at run time.
        src.append("import ").append(runtimePackage).append(".RecordComponentNames;\n");
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
        src.append("import ").append(runtimePackage).append(".FilterParseResult;\n");
        src.append("import ").append(runtimePackage).append(".FilterParser;\n");
        src.append("import ").append(runtimePackage).append(".FilterPredicate;\n");
        src.append("import jakarta.servlet.http.HttpServletRequest;\n");
        src.append("import jakarta.validation.Validator;\n");
        src.append("import java.util.List;\n");
        src.append("import java.util.Map;\n");
        src.append("import java.util.Set;\n\n");

        src.append("/**\n");
        src.append(" * GENERATED — TPH discriminator-base controller for ").append(shortName)
           .append(" (polymorphic collection + per-subtype CRUD).\n");
        src.append(" * Implements the cross-port API contract.\n");
        src.append(" *\n");
        src.append(" * <p>Auth: these endpoints are unauthenticated. Require authentication for this path in\n");
        src.append(" * your Spring Security config, e.g. {@code http.authorizeHttpRequests(a ->\n");
        src.append(" * a.requestMatchers(\"").append(routeBase).append("/**\").authenticated())}.\n");
        src.append(" * A row-ownership rule (\"only the owner may read this row\") can't be expressed in path\n");
        src.append(" * config — eject this generator with {@code mvn metaobjects:eject} and hand-write those\n");
        src.append(" * endpoints.\n");
        src.append(" */\n");
        src.append("@RestController\n");
        src.append("@RequestMapping(\"").append(routeBase).append("\")\n");
        src.append("public class ").append(controllerName).append(" {\n\n");

        src.append("    private static final Set<String> SORT_ALLOWLIST = Set.of(");
        for (int i = 0; i < sortFields.size(); i++) {
            if (i > 0) src.append(", ");
            src.append('"').append(sortFields.get(i)).append('"');
        }
        src.append(");\n\n");
        // The polymorphic sort surface is the BASE's own columns, so the declared orders
        // are read off the base too — same owner the allowlist above was built from.
        appendSortDefaultOrders(src, base, sortFields);

        // FR-036 Program B: constructor-inject the ObjectMapper (binds each present PATCH value via
        // <Sub>Patch.fromJson, same wire codecs as create) + the jakarta Validator (per-field
        // present-value constraint checks on the per-subtype update) — same 3-arg shape the vanilla
        // controller uses. The polymorphic + read routes ignore them.
        src.append("    private final ").append(repoName).append(" repository;\n");
        src.append("    private final ObjectMapper objectMapper;\n");
        src.append("    private final Validator validator;\n\n");
        src.append("    public ").append(controllerName).append("(").append(repoName)
           .append(" repository, ObjectMapper objectMapper, Validator validator) {\n");
        src.append("        this.repository = repository;\n");
        src.append("        this.objectMapper = objectMapper;\n");
        src.append("        this.validator = validator;\n");
        src.append("    }\n\n");
        appendUnreadableBodyHandler(src);
        // #484: the TPH rows are union-DTO rows, so hide a credential declared on the base or on
        // ANY subtype from every response, and ignore a write-denied one on every subtype create.
        List<MetaField> unionFields = new ArrayList<>(SpringGeneratorSupport.scalarFields(base));
        for (MetaField f : TphPlan.collectSubtypeFields(base, loader)) {
            if (!(f instanceof com.metaobjects.field.ObjectField)) unionFields.add(f);
        }
        List<String> hidden = SpringGeneratorSupport.credentialNames(unionFields);
        List<SpringM2mSupport.M2mNav> baseNavs = SpringM2mSupport.resolve(base, loader);
        boolean redacts = !hidden.isEmpty() || baseNavs.stream().anyMatch(n -> !targetCredentials(base, n).isEmpty())
            || plan.subtypes().stream().anyMatch(st -> SpringM2mSupport.resolve(st.entity(), loader).stream()
                .anyMatch(n -> !targetCredentials(st.entity(), n).isEmpty()));
        if (redacts) appendRedactHelpers(src);

        // --- polymorphic collection ---
        src.append("    // Polymorphic list — the union across all subtypes, each row tagged by its discriminator.\n");
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
        src.append("            if (sortClause == null) return ResponseEntity.badRequest().body(Map.of(\"error\", \"invalid_sort\", \"field\", sort.split(\":\", 2)[0]));\n");
        src.append("        }\n");
        src.append("        FilterParseResult filter = FilterParser.parse(request.getQueryString(), ")
           .append(allowlistName).append(".FIELDS, ").append(allowlistName).append(".OPS_BY_FIELD, ").append(allowlistName).append(".DECIMAL_FIELDS);\n");
        src.append("        if (filter.error() != null) return ResponseEntity.badRequest().body(Map.of(\"error\", filter.error(), \"field\", filter.field()));\n");
        src.append("        List<FilterPredicate> filters = filter.predicates();\n");
        src.append("        List<").append(dtoName).append("> rows = repository.list(actualLimit, actualOffset, sortClause, filters);\n");
        src.append("        if (withCount != null && withCount == 1) {\n");
        src.append("            return ResponseEntity.ok(Map.of(\"rows\", ").append(redactAll("rows", hidden))
           .append(", \"total\", repository.count(filters)));\n");
        src.append("        }\n");
        src.append("        return ResponseEntity.ok(").append(redactAll("rows", hidden)).append(");\n");
        src.append("    }\n\n");

        src.append("    // Polymorphic get — one row of whatever subtype it is.\n");
        src.append("    @GetMapping(\"/{id}\")\n");
        src.append("    public ResponseEntity<?> get(@PathVariable ").append(pkType).append(" id) {\n");
        src.append("        return repository.findById(id)\n");
        src.append("                .<ResponseEntity<?>>map(").append(okMapper(hidden)).append(")\n");
        src.append("                .orElseGet(this::notFound);\n");
        src.append("    }\n\n");

        // FR-018 x FR-017 — M:N traversal declared on the BASE: every row of the shared
        // table is a legitimate source, so this is the SAME mount + finder shape a vanilla
        // entity gets (see emit() above) — no discriminator gating needed. Per-subtype
        // traversal (including this same relationship, inherited) is emitted below, inside
        // the per-subtype loop — the overlap is deliberate (FR-017 design): a subtype
        // resource carries the same sub-resources as any other resource.
        for (SpringM2mSupport.M2mNav nav : baseNavs) {
            String finder = SpringGeneratorSupport.m2mFinderName(nav.relationName());
            String navCall = "repository." + finder + "(id" + SpringGeneratorSupport.targetSubtypeCallArg(nav) + ")";
            src.append("    @GetMapping(\"/{id}/").append(nav.relationName()).append("\")\n");
            if (targetCredentials(base, nav).isEmpty()) {
                src.append("    public ResponseEntity<List<").append(nav.targetDtoType()).append(">> ")
                   .append(finder).append("(@PathVariable ").append(pkType).append(" id) {\n");
                src.append("        return ResponseEntity.ok(").append(navCall).append(");\n");
            } else {
                src.append("    public ResponseEntity<List<Object>> ")
                   .append(finder).append("(@PathVariable ").append(pkType).append(" id) {\n");
                src.append("        return ResponseEntity.ok(")
                   .append(redactAll(navCall, targetCredentials(base, nav))).append(");\n");
            }
            src.append("    }\n\n");
        }

        // --- per-subtype CRUD ---
        for (TphPlan.Subtype st : plan.subtypes()) {
            String seg = st.routeSegment();              // url segment (e.g. "bridge")
            String disc = st.value();                    // discriminator value (e.g. "Bridge")
            String suffix = SpringNaming.capitalize(disc); // method-name suffix (e.g. "Bridge")
            // FR-036 Program B: the per-subtype route binds this subtype's presence-tracked
            // <Sub>Patch (emitted by SpringDtoGenerator) and validates present values against its
            // standalone annotated <Sub>Dto. Referenced by FQN so a subtype in another package
            // still resolves without an import.
            String[] stSplit = SpringNaming.splitFqn(st.entity().getName());
            String stPrefix = stSplit[0].isEmpty() ? "" : stSplit[0] + ".";
            String subPatch = stPrefix + SpringNaming.patchName(stSplit[1]);
            String subDto = stPrefix + SpringNaming.dtoName(stSplit[1]);

            src.append("    // --- subtype ").append(disc).append(" (segment /").append(seg).append(") ---\n");

            // per-subtype list
            src.append("    @GetMapping(\"/").append(seg).append("\")\n");
            src.append("    public ResponseEntity<?> list").append(suffix).append("(\n");
            src.append("            @RequestParam(required = false) Integer limit,\n");
            src.append("            @RequestParam(required = false) Integer offset,\n");
            src.append("            @RequestParam(required = false) String sort,\n");
            src.append("            HttpServletRequest request) {\n");
            src.append("        int actualLimit = limit != null ? limit : 50;\n");
            src.append("        int actualOffset = offset != null ? offset : 0;\n");
            src.append("        ").append(repoName).append(".SortClause sortClause = null;\n");
            src.append("        if (sort != null) {\n");
            src.append("            sortClause = parseSort(sort);\n");
            src.append("            if (sortClause == null) return ResponseEntity.badRequest().body(Map.of(\"error\", \"invalid_sort\", \"field\", sort.split(\":\", 2)[0]));\n");
            src.append("        }\n");
            src.append("        FilterParseResult filter = FilterParser.parse(request.getQueryString(), ")
               .append(allowlistName).append(".FIELDS, ").append(allowlistName).append(".OPS_BY_FIELD, ").append(allowlistName).append(".DECIMAL_FIELDS);\n");
            src.append("        if (filter.error() != null) return ResponseEntity.badRequest().body(Map.of(\"error\", filter.error(), \"field\", filter.field()));\n");
            src.append("        return ResponseEntity.ok(").append(redactAll(
                "repository.listByType(\"" + disc + "\", actualLimit, actualOffset, sortClause, filter.predicates())",
                hidden)).append(");\n");
            src.append("    }\n\n");

            // per-subtype get (404 cross-subtype)
            src.append("    @GetMapping(\"/").append(seg).append("/{id}\")\n");
            src.append("    public ResponseEntity<?> get").append(suffix)
               .append("(@PathVariable ").append(pkType).append(" id) {\n");
            src.append("        return repository.findByIdAndType(id, \"").append(disc).append("\")\n");
            src.append("                .<ResponseEntity<?>>map(").append(okMapper(hidden)).append(")\n");
            src.append("                .orElseGet(this::notFound);\n");
            src.append("    }\n\n");

            // per-subtype create (discriminator injected from URL) — FR-036: validate each body
            // value against the subtype's ANNOTATED <Sub>Dto constraints BEFORE persisting, emitting
            // the cross-port {"error":"validation"} envelope on any violation (so an over-@maxLength
            // or missing-@required column is a 400, not a silent 201). The bound body stays the union
            // <Base>Dto (the shape repository.createWithType consumes), but the union is annotation-
            // free — so validation runs PER FIELD against the subtype DTO (the annotated shape), the
            // exact type the per-subtype PATCH validates against. The validated set is the sibling
            // <Sub>Patch's settable fields (effective scalars MINUS PK MINUS discriminator): the PK
            // is auto-generated and the discriminator is injected from the URL, so neither is checked.
            // validateValue applies @NotNull to a null value, so an absent @required column 400s too —
            // matching the vanilla create's whole-bean validate, scoped to this subtype.
            List<MetaField> createValidated =
                SpringGeneratorSupport.settableFields(st.entity(), TphPlan.discriminatorFieldOf(st.entity()));
            src.append("    @PostMapping(\"/").append(seg).append("\")\n");
            src.append("    public ResponseEntity<?> create").append(suffix)
               .append("(@RequestBody ").append(dtoName).append(" dto) {\n");
            for (MetaField vf : createValidated) {
                // Both the property STRING and the accessor take the escaped component name:
                // Bean Validation resolves a record's property by its COMPONENT, and
                // `dto.notify()` would bind to Object.notify().
                String vc = SpringNaming.recordComponentName(vf.getName());
                src.append("        if (!validator.validateValue(").append(subDto).append(".class, \"")
                   .append(vc).append("\", dto.").append(vc).append("()).isEmpty()) {\n");
                src.append("            return ResponseEntity.badRequest().body(Map.of(\"error\", \"validation\"));\n");
                src.append("        }\n");
            }
            // #362: validateValue above checks each property against the subtype DTO's own
            // constraints and stops there — it does NOT cascade @Valid into a nested bean. A
            // field.map @objectRef IS in createValidated (scalarFields skips only ObjectField),
            // so before this loop its VALUES — which are the beans — were written unvalidated.
            // The vanilla create cascades via @Valid on the DTO component; this is the TPH
            // path's equivalent, so the two write surfaces agree.
            for (MetaField vf : SpringGeneratorSupport.valueObjectMapFields(st.entity())) {
                appendMapValueValidationLoop(
                    src, "dto." + SpringNaming.recordComponentName(vf.getName()) + "()");
            }
            // ADR-0045 (#203/#229): honor @autoSet on the TPH per-subtype create — stamp EVERY
            // onCreate AND onUpdate column with now() before persisting (the caller's value is
            // ignored), mirroring the vanilla create handler's createArg above. The stamp helper
            // is the BASE union <Base>Dto's static method (NOT a standalone <Sub>Dto's): dto above
            // is declared as that same union type (createWithType binds/returns it), so a
            // subtype-typed stampForInsert(SubDto) would not type-check against it.
            //
            // Review fix (Task 3): gate on `base`, NOT `st.entity()`. The helper this emits
            // (<Base>Dto.stampForInsert) is only ever generated by
            // SpringDtoGenerator.emitTphUnion when SpringGeneratorSupport.hasAutoSetFields(base) is true
            // (@autoSet columns live on the base, shared by every subtype row in the single
            // table) — gating this call on the subtype's own resolving field set instead let a
            // subtype-declared @autoSet column fire `true` here while the helper it calls was
            // never emitted, producing a non-compiling controller. A TPH subtype declaring its
            // OWN @autoSet column is a documented non-goal (uniform with the Kotlin and Python
            // ports, both base-scoped): the column is simply never stamped, not a compile break.
            // #484: ignore (never reject) a @formExclude / credential value in the body.
            appendStripWriteDenied(src, dtoName, unionFields);
            String createArg = SpringGeneratorSupport.hasAutoSetFields(base)
                ? dtoName + ".stampForInsert(dto)" : "dto";
            src.append("        try {\n");
            src.append("            ").append(dtoName).append(" saved = repository.createWithType(\"").append(disc)
               .append("\", ").append(createArg).append(");\n");
            src.append("            return ResponseEntity.status(HttpStatus.CREATED).body(")
               .append(redactOne("saved", hidden)).append(");\n");
            appendConstraintCatch(src);
            src.append("    }\n\n");

            // per-subtype update — FR-036 Program B present-key PATCH tristate (mirrors the vanilla
            // update handler; 404 cross-subtype; id + discriminator immutable). Bind the RAW
            // JsonNode (NOT the union DTO, which conflates absent with null and would 400 an omitted
            // @required column), build the presence-tracked <Sub>Patch (an explicit null clears a
            // nullable column; an explicit null on a @required base column throws
            // PatchValidationException → 400), validate each PRESENT value against the subtype DTO's
            // constraints, then patch scoped to the discriminator.
            src.append("    @RequestMapping(value = \"/").append(seg)
               .append("/{id}\", method = { RequestMethod.PATCH, RequestMethod.PUT })\n");
            src.append("    public ResponseEntity<?> update").append(suffix)
               .append("(@PathVariable ").append(pkType).append(" id, @RequestBody JsonNode body) {\n");
            src.append("        ").append(subPatch).append(" patch;\n");
            src.append("        try {\n");
            src.append("            patch = ").append(subPatch).append(".fromJson(body, objectMapper);\n");
            src.append("        } catch (PatchValidationException e) {\n");
            src.append("            return ResponseEntity.badRequest().body(Map.of(\"error\", \"validation\"));\n");
            src.append("        }\n");
            src.append("        for (Map.Entry<String, Object> __e : patch.assignedValues().entrySet()) {\n");
            src.append("            if (!validator.validateValue(").append(subDto)
               .append(".class, RecordComponentNames.escape(__e.getKey()), __e.getValue()).isEmpty()) {\n");
            src.append("                return ResponseEntity.badRequest().body(Map.of(\"error\", \"validation\"));\n");
            src.append("            }\n");
            src.append("        }\n");
            // #362: as on the create path above, validateValue does not cascade into a nested
            // bean, so a PRESENT field.map @objectRef had its values written unvalidated. The
            // <Sub>Patch carries the hasX()/x() tristate, so this is the same loop the vanilla
            // PATCH runs — skipping absent keys, and skipping an explicit null (which clears).
            for (MetaField vf : SpringGeneratorSupport.valueObjectMapFields(st.entity())) {
                String mvc = SpringNaming.recordComponentName(vf.getName());
                appendElementValidationLoop(
                    src, mvc, SpringNaming.capitalize(vf.getName()),
                    "patch." + mvc + "().values()");
            }
            // ADR-0045 (#203/#229): bump every onUpdate @autoSet column on the per-subtype PATCH,
            // mirroring the vanilla update handler above — injected after present-value
            // validation, before delegating, so the timestamp bumps even when the caller omits
            // it. onCreate columns are never touched here (immutable on update).
            //
            // Review fix (Task 3): gate on `base`, matching the create-arg gate above, for the
            // same reason — a subtype-own @autoSet column is a documented non-goal, never
            // stamped, uniform across ports.
            if (SpringGeneratorSupport.hasOnUpdateFields(base)) {
                src.append("        patch.stampAutoSetOnUpdate();\n");
            }
            src.append("        try {\n");
            src.append("            return repository.patchByIdAndType(id, \"").append(disc)
               .append("\", patch.assignedValues())\n");
            src.append("                    .<ResponseEntity<?>>map(").append(okMapper(hidden)).append(")\n");
            src.append("                    .orElseGet(this::notFound);\n");
            appendConstraintCatch(src);
            src.append("    }\n\n");

            // per-subtype delete (404 cross-subtype)
            src.append("    @DeleteMapping(\"/").append(seg).append("/{id}\")\n");
            src.append("    public ResponseEntity<?> delete").append(suffix)
               .append("(@PathVariable ").append(pkType).append(" id) {\n");
            src.append("        try {\n");
            src.append("            if (repository.deleteByIdAndType(id, \"").append(disc).append("\")) return ResponseEntity.noContent().build();\n");
            src.append("            return notFound();\n");
            appendConstraintCatch(src);
            src.append("    }\n\n");

            // FR-018 x FR-017 — M:N traversal scoped to THIS subtype: every relationship it
            // resolves, inherited ones (e.g. a base-declared relationship) included — a
            // subtype resource carries the same sub-resources as any other. The GENERATED
            // controller enforces the gate itself (never left to the repository
            // implementation): it composes the SAME repository.findByIdAndType(id, disc) lookup
            // the per-subtype GET above already relies on — a sibling subtype's id returns
            // Optional.empty() there (the tph-cross-subtype-404 contract) — and short-circuits
            // to an EMPTY list, HTTP 200, before ever calling the traversal finder. This costs
            // one redundant primary-key lookup and adds no new persistence assumption: it reuses
            // a seam the consumer must already implement correctly for the per-subtype GET to
            // pass conformance. Without it, a copy-paste finder body (e.g. findTagsForBridge
            // implemented identically to findTags) compiles, type-checks, and silently 200s a
            // sibling's rows — nothing else in the pipeline catches that.
            for (SpringM2mSupport.M2mNav nav : SpringM2mSupport.resolve(st.entity(), loader)) {
                String subFinder = SpringGeneratorSupport.m2mFinderNameForSubtype(nav.relationName(), disc);
                src.append("    @GetMapping(\"/").append(seg).append("/{id}/").append(nav.relationName()).append("\")\n");
                boolean navHides = !targetCredentials(st.entity(), nav).isEmpty();
                src.append("    public ResponseEntity<List<").append(navHides ? "Object" : nav.targetDtoType()).append(">> ")
                   .append(subFinder).append("(@PathVariable ").append(pkType).append(" id) {\n");
                src.append("        if (repository.findByIdAndType(id, \"").append(disc).append("\").isEmpty()) {\n");
                src.append("            return ResponseEntity.ok(List.of());\n");
                src.append("        }\n");
                src.append("        return ResponseEntity.ok(").append(redactAll(
                    "repository." + subFinder + "(id" + SpringGeneratorSupport.targetSubtypeCallArg(nav) + ")",
                    targetCredentials(st.entity(), nav))).append(");\n");
                src.append("    }\n\n");
            }
        }

        // shared helpers
        src.append("    private ResponseEntity<?> notFound() {\n");
        src.append("        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of(\"error\", \"not_found\"));\n");
        src.append("    }\n\n");
        src.append("    private static ").append(repoName).append(".SortClause parseSort(String raw) {\n");
        src.append("        String[] parts = raw.split(\":\", 2);\n");
        src.append("        if (parts.length == 0 || parts[0].isEmpty() || !SORT_ALLOWLIST.contains(parts[0])) return null;\n");
        // `?sort=field` with no `:order` takes the field's DECLARED @sortableDefaultOrder.
        // The "asc" fallback stays HERE, at the read, so it is spelled once per port and
        // SORT_DEFAULT_ORDER carries declarations only.
        src.append("        String dir = parts.length == 2 ? parts[1].toLowerCase()\n");
        src.append("            : SORT_DEFAULT_ORDER.getOrDefault(parts[0], \"asc\");\n");
        src.append("        if (!dir.equals(\"asc\") && !dir.equals(\"desc\")) return null;\n");
        src.append("        return new ").append(repoName).append(".SortClause(parts[0], dir);\n");
        src.append("    }\n");
        src.append("}\n");

        try {
            Path outFile = outRoot.resolve(pkg.replace('.', '/')).resolve(controllerName + ".java");
            GeneratedFileWriter.write(outFile, src.toString());
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing TPH " + controllerName + ".java for entity " + base.getName() + ": " + e, e);
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

    /**
     * Emit the per-entity {@code SORT_DEFAULT_ORDER} constant the generated {@code parseSort}
     * reads for a {@code ?sort=field} carrying no {@code :order}.
     *
     * <p>Carries DECLARED orders only — a field with no {@code @sortableDefaultOrder} is absent
     * and the generated read supplies {@code "asc"}. That split is deliberate and matches the
     * other four ports: one place per port spells the fallback, so a port cannot drift by
     * baking a different default into its allowlist.
     *
     * <p>ADR-0039: resolving accessor — {@code @sortableDefaultOrder} may be inherited via
     * {@code extends}.
     *
     * <p>Emitted as {@code Map.ofEntries(Map.entry(..), ..)}, deliberately NOT {@code Map.of(..)}.
     * {@code Map.of} is a set of fixed-arity overloads topping out at TEN pairs with no varargs
     * form — alternating key/value types make one impossible — so an entity whose eleventh field
     * declares {@code @sortableDefaultOrder} emits a controller that does not compile
     * ({@code no suitable method found for of(..)}). The sibling {@code SORT_ALLOWLIST} above is
     * safe at any size only because {@code Set.of} DOES have a {@code Set.of(E...)} varargs
     * overload, which is what makes {@code Map.of} look safe by analogy when it is not.
     * {@code Map.ofEntries} takes varargs and has no ceiling; it also infers K and V from the
     * assignment target at zero entries, so the empty case — the common one, since most models
     * declare no {@code @sortableDefaultOrder} at all — needs no special branch.
     */
    private static void appendSortDefaultOrders(StringBuilder src, MetaObject owner, List<String> sortFields) {
        // Walk the owner's OWN field list and keep the sortable ones, rather than looking each
        // allowlist name back up. `MetaObject.getMetaField(name)` does not return null for an
        // absent name — it THROWS MetaDataNotFoundException — so a name-keyed lookup turns any
        // future divergence between the allowlist and this map into an aborted build instead of
        // a skipped entry. Today both are sourced from this same owner, so nothing diverges;
        // this keeps that from being load-bearing. Mirrors the Kotlin sibling's `firstOrNull`.
        java.util.Set<String> sortable = new java.util.LinkedHashSet<>(sortFields);
        StringBuilder entries = new StringBuilder();
        for (MetaField f : owner.getMetaFields()) {
            String name = f.getName();
            if (!sortable.contains(name)) continue;
            if (!f.hasMetaAttr(MetaField.ATTR_SORTABLE_DEFAULT_ORDER)) continue;
            String v = f.getMetaAttr(MetaField.ATTR_SORTABLE_DEFAULT_ORDER).getValueAsString();
            if (!"asc".equals(v) && !"desc".equals(v)) continue;
            if (entries.length() > 0) entries.append(", ");
            entries.append("Map.entry(\"").append(name).append("\", \"").append(v).append("\")");
        }
        src.append("    private static final Map<String, String> SORT_DEFAULT_ORDER = Map.ofEntries(")
           .append(entries).append(");\n\n");
    }

    /**
     * The DTO record components a CALLER never supplies on create, because the server owns them:
     * the primary-key field(s) and every {@code @autoSet} column.
     *
     * <p>This is the same concept {@link SpringGeneratorSupport#settableFields(MetaObject, String)}
     * already excludes for the TPH create path and the {@code <Entity>Patch} — stated here as the
     * COMPLEMENT (what to ignore) rather than the settable set, because the vanilla create
     * validates the whole DTO for its {@code @Valid} cascade and filters the result.</p>
     *
     * <p>Returned as record-component names, which is what a {@code ConstraintViolation}'s
     * property path spells for a record.</p>
     */
    private static List<String> serverOwnedOnCreate(MetaObject entity) {
        List<String> pkFields = entity.getIdentities(true).stream()
            .filter(com.metaobjects.identity.MetaIdentity::isPrimary)
            .findFirst()
            .map(com.metaobjects.identity.MetaIdentity::getFields)
            .orElse(List.of());

        List<String> out = new ArrayList<>();
        for (MetaField f : SpringGeneratorSupport.scalarFields(entity)) {
            // #484: a write-denied field is IGNORED on create, so a @NotNull on it describes the
            // response shape and must not reject a body that (necessarily) omits it.
            if (pkFields.contains(f.getName()) || AutoSetSupport.isAutoSet(f)
                    || SpringGeneratorSupport.isApiWriteDenied(f)) {
                String component = SpringNaming.recordComponentName(f.getName());
                if (!out.contains(component)) out.add(component);
            }
        }
        return out;
    }

    /**
     * Closes a write handler's {@code try} with the cross-port constraint-violation mapping.
     *
     * <p>A generated CRUD route had no try/catch around its write, so a driver failure reached
     * Spring's default handler and came back as a bare 500 — for a client-supplied foreign key
     * that does not exist, or a value duplicating a unique one, both of which are CLIENT errors
     * the model already describes ({@code identity.reference}, {@code identity.secondary}).
     * Unrecognised throwables are RETHROWN, so the operator keeps the full diagnostic and the
     * caller still gets a plain 500 carrying none of it.</p>
     *
     * <p>{@code RuntimeException} rather than {@code Exception}: every Spring data-access failure
     * is unchecked, and widening it here would force a checked-exception signature onto handlers
     * that cannot throw one.</p>
     */
    private static void appendConstraintCatch(StringBuilder src) {
        src.append("        } catch (RuntimeException e) {\n");
        src.append("            ConstraintErrors.Failure failure = ConstraintErrors.classify(e);\n");
        src.append("            if (failure == null) throw e;\n");
        src.append("            return ResponseEntity.status(failure.status())\n");
        src.append("                    .body(Map.of(\"error\", failure.error(), \"constraint\", failure.constraint()));\n");
        src.append("        }\n");
    }

    /** The credential wire names of the TARGET of {@code source}'s M:N relationship {@code nav} (#484). */
    private static List<String> targetCredentials(MetaObject source, SpringM2mSupport.M2mNav nav) {
        for (com.metaobjects.relationship.MetaRelationship rel : source.getRelationships()) {
            if (!nav.relationName().equals(rel.getShortName())) continue;
            MetaObject target = com.metaobjects.loader.References.refTarget(
                rel, com.metaobjects.relationship.MetaRelationship.ATTR_OBJECT_REF);
            if (target == null) return List.of();
            // A TPH base target's rows are shared-table rows of every subtype, so a credential
            // declared on any subtype is hidden too.
            List<MetaField> fields = new ArrayList<>(SpringGeneratorSupport.dtoComponentFields(target));
            for (MetaField f : TphPlan.collectSubtypeFields(target, source.getLoader())) {
                if (!(f instanceof ObjectField)) fields.add(f);
            }
            return SpringGeneratorSupport.credentialNames(fields);
        }
        return List.of();
    }

    /** The fields of a create body that a generated write route ignores (#484). */
    private static void appendStripWriteDenied(StringBuilder src, String dtoName, List<MetaField> components) {
        if (components.stream().noneMatch(SpringGeneratorSupport::isApiWriteDenied)) return;
        src.append("        dto = new ").append(dtoName).append("(");
        for (int i = 0; i < components.size(); i++) {
            MetaField f = components.get(i);
            if (i > 0) src.append(", ");
            src.append(SpringGeneratorSupport.isApiWriteDenied(f)
                ? "null" : "dto." + SpringNaming.recordComponentName(f.getName()) + "()");
        }
        src.append(");\n");
    }

    /** Java source for a {@code String...} argument list naming {@code hidden}. */
    private static String hiddenArgs(List<String> hidden) {
        StringBuilder b = new StringBuilder();
        for (String h : hidden) b.append(", \"").append(h).append('"');
        return b.toString();
    }

    /** Expression for one response row with {@code hidden} removed (the row itself when none). */
    private static String redactOne(String expr, List<String> hidden) {
        return hidden.isEmpty() ? expr : "redact(" + expr + hiddenArgs(hidden) + ")";
    }

    /** Expression for a list of response rows with {@code hidden} removed from each. */
    private static String redactAll(String expr, List<String> hidden) {
        return hidden.isEmpty() ? expr : "redactAll(" + expr + hiddenArgs(hidden) + ")";
    }

    /** The {@code Optional.map} argument that answers 200 with a row, minus {@code hidden}. */
    private static String okMapper(List<String> hidden) {
        return hidden.isEmpty() ? "ResponseEntity::ok" : "r -> ResponseEntity.ok(" + redactOne("r", hidden) + ")";
    }

    /**
     * #484 — the helpers a controller uses to leave credential fields out of response bodies. The
     * shared DTO keeps the member (the application's own code reads and writes it); only the
     * generated HTTP boundary drops the key, so a credential is ABSENT, not null.
     */
    private static void appendRedactHelpers(StringBuilder src) {
        src.append("    private Object redact(Object row, String... hidden) {\n");
        src.append("        com.fasterxml.jackson.databind.node.ObjectNode node = objectMapper.valueToTree(row);\n");
        src.append("        node.remove(java.util.Arrays.asList(hidden));\n");
        src.append("        return node;\n");
        src.append("    }\n\n");
        src.append("    private List<Object> redactAll(List<?> rows, String... hidden) {\n");
        src.append("        List<Object> out = new java.util.ArrayList<>(rows.size());\n");
        src.append("        for (Object row : rows) out.add(redact(row, hidden));\n");
        src.append("        return out;\n");
        src.append("    }\n\n");
    }

    private static void appendServerOwnedOnCreate(StringBuilder src, MetaObject entity) {
        List<String> serverOwned = serverOwnedOnCreate(entity);
        if (serverOwned.isEmpty()) return;   // no constant, and the handler keeps its old shape
        src.append("    /** Components the server owns on create (primary key, @autoSet): a\n");
        src.append("     *  @NotNull on one of these describes the RESPONSE shape and must not\n");
        src.append("     *  reject a create body that legitimately omits it. */\n");
        src.append("    private static final Set<String> SERVER_OWNED_ON_CREATE = Set.of(");
        for (int i = 0; i < serverOwned.size(); i++) {
            if (i > 0) src.append(", ");
            src.append('"').append(serverOwned.get(i)).append('"');
        }
        src.append(");\n\n");
    }

}
