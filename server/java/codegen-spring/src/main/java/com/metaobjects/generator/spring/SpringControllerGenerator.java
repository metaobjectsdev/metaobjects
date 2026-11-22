package com.metaobjects.generator.spring;

// Eject note (ADR-0034, JVM eject design): these siblings stay in
// com.metaobjects.generator.spring when this generator is copied out via
// `mvn metaobjects:eject` and its own package is renamed — an explicit import, not
// same-package bare-name resolution, is what keeps the ejected copy compiling.
import com.metaobjects.generator.spring.AutoSetSupport;
import com.metaobjects.generator.spring.SpringGeneratorSupport;
import com.metaobjects.generator.spring.SpringJavaWriter;
import com.metaobjects.generator.spring.SpringM2mSupport;
import com.metaobjects.generator.spring.SpringNaming;
import com.metaobjects.generator.spring.SpringTypeMapper;
import com.metaobjects.generator.spring.TphPlan;

import com.metaobjects.config.ApiSettings;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.query.FilterOps;
import com.metaobjects.generator.EmitsReportExport;
import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.RunAware;
import com.metaobjects.generator.GeneratorIOWriter;
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
import com.metaobjects.generator.writer.CodeWriter;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.generator.util.RestSurfaceGate;
import com.metaobjects.object.MetaObject;
import com.metaobjects.source.MetaSource;
import com.metaobjects.source.RdbSource;
import com.metaobjects.validator.MetaValidator;
import static com.metaobjects.generator.spring.SpringNaming.firstRdbSource;

import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Set;
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
 * <p>Layout (ADR-0063): the controller is written through a {@link SpringJavaWriter}. The
 * imports are collected and sorted by the writer, fixed code is written as it reads with
 * {@code text()}, and every member of the generated class comes from its own protected
 * {@code write*} method, so an owned copy (or a subclass) changes one handler by overriding
 * one method.</p>
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

    /** The list handler parameters, one per continuation line of its signature. */
    protected static final String PARAM_LIMIT = "@RequestParam(required = false) Integer limit";
    protected static final String PARAM_OFFSET = "@RequestParam(required = false) Integer offset";
    protected static final String PARAM_SORT = "@RequestParam(required = false) String sort";
    protected static final String PARAM_WITH_COUNT = "@RequestParam(required = false, name = \"withCount\") Integer withCount";
    protected static final String PARAM_REQUEST = "HttpServletRequest request";

    /** The line that closes a write handler's {@code try} and opens its constraint catch ({@link #writeConstraintCatch}). */
    protected static final String CATCH_RUNTIME = "} catch (RuntimeException e) {";

    /** The 404 body every by-id miss answers. */
    protected static final String NOT_FOUND_RESPONSE =
        "ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of(\"error\", \"not_found\"))";

    protected int reportMaxRows = DEFAULT_REPORT_MAX_ROWS;

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
    protected boolean reportExport = false;

    @Override
    public void setRun(Collection<? extends Generator> run) {
        reportExport = EmitsReportExport.includedIn(run);
    }

    /** The runtime package this run's output imports ({@link #ARG_RUNTIME_PACKAGE}). */
    protected String runtimePackage = RUNTIME_PACKAGE;

    private static final Logger LOG = LoggerFactory.getLogger(SpringControllerGenerator.class);

    @Override
    protected Class<MetaObject> getFilterClass() {
        return MetaObject.class;
    }

    protected MetaDataLoader loader;

    @Override
    public void execute(MetaDataLoader loader) {
        parseArgs();
        runtimePackage = getArg(ARG_RUNTIME_PACKAGE, RUNTIME_PACKAGE);
        reportMaxRows = Integer.parseInt(getArg(ARG_REPORT_MAX_ROWS, String.valueOf(DEFAULT_REPORT_MAX_ROWS)));
        this.loader = loader;
        Path outRoot = Paths.get(outDir.getAbsolutePath());
        for (MetaObject declared : loader.getMetaObjects()) {
            if (!isSelected(declared)) continue;
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

    // -----------------------------------------------------------------------
    // The file: writer, imports, class head, write.
    // -----------------------------------------------------------------------

    /** The writer one controller file is written with, set to its package. */
    protected SpringJavaWriter newWriter(String pkg) {
        SpringJavaWriter w = new SpringJavaWriter();
        if (!pkg.isEmpty()) w.packageName(pkg);
        return w;
    }

    /** A class of the helper runtime, by its qualified name in {@link #runtimePackage}. */
    protected String runtimeType(String simpleName) {
        return runtimePackage + "." + simpleName;
    }

    /** The imports of a WRITABLE controller (vanilla and single-table hierarchy alike). */
    protected void useWritableImports(SpringJavaWriter w) {
        w.use("com.fasterxml.jackson.databind.JsonNode");
        w.use("com.fasterxml.jackson.databind.ObjectMapper");
        w.use(runtimeType("ConstraintErrors"));
        w.use(runtimeType("PatchValidationException"));
        w.use(runtimeType("UnreadableBody"));
        w.use(runtimeType("UnknownBodyKeys"));
        w.use(runtimeType("ValidationIssues"));
        // The escape the PATCH loop applies to each assigned key before naming a Bean
        // Validation property — see RecordComponentNames for why it is needed at run time.
        w.use(runtimeType("RecordComponentNames"));
        w.use("org.springframework.http.HttpStatus");
        w.use("org.springframework.http.ResponseEntity");
        w.use("org.springframework.web.bind.annotation.DeleteMapping");
        w.use("org.springframework.web.bind.annotation.GetMapping");
        w.use("org.springframework.web.bind.annotation.PathVariable");
        w.use("org.springframework.web.bind.annotation.PostMapping");
        w.use("org.springframework.web.bind.annotation.RequestBody");
        w.use("org.springframework.web.bind.annotation.RequestMapping");
        w.use("org.springframework.web.bind.annotation.RequestMethod");
        w.use("org.springframework.web.bind.annotation.RequestParam");
        w.use("org.springframework.web.bind.annotation.RestController");
        useFilterImports(w);
        w.use("jakarta.servlet.http.HttpServletRequest");
        w.use("jakarta.validation.Validator");
        useCollectionImports(w);
    }

    /** The imports of a READ-ONLY controller (projection or served report). */
    protected void useReadOnlyImports(SpringJavaWriter w, MetaObject entity, boolean hasItem) {
        w.use("org.springframework.http.HttpStatus");
        w.use("org.springframework.http.ResponseEntity");
        w.use("org.springframework.web.bind.annotation.GetMapping");
        if (hasItem) w.use("org.springframework.web.bind.annotation.PathVariable");
        w.use("org.springframework.web.bind.annotation.PostMapping");
        w.use("org.springframework.web.bind.annotation.RequestMapping");
        if (hasItem) w.use("org.springframework.web.bind.annotation.RequestMethod");
        w.use("org.springframework.web.bind.annotation.RequestParam");
        w.use("org.springframework.web.bind.annotation.RestController");
        useFilterImports(w);
        if (reportExport && com.metaobjects.generator.util.GeneratorUtil.isReport(entity)) {
            w.use(runtimeType("ReportExport"));
            w.use("org.springframework.http.MediaType");
        }
        w.use("jakarta.servlet.http.HttpServletRequest");
        useCollectionImports(w);
    }

    protected void useFilterImports(SpringJavaWriter w) {
        w.use(runtimeType("FilterParseResult"));
        w.use(runtimeType("FilterParser"));
        w.use(runtimeType("FilterPredicate"));
    }

    protected void useCollectionImports(SpringJavaWriter w) {
        w.use("java.util.List");
        w.use("java.util.Map");
        w.use("java.util.Set");
    }

    /** The Javadoc paragraph telling an adopter where the routes' authentication belongs. */
    protected List<String> authDoc(String routeBase, boolean readOnly) {
        List<String> out = new ArrayList<>();
        if (readOnly) {
            out.add("<p>Auth: these read endpoints are unauthenticated. Require authentication for this path");
            out.add("in your Spring Security config, e.g. {@code http.authorizeHttpRequests(a ->");
        } else {
            out.add("<p>Auth: these endpoints are unauthenticated. Require authentication for this path in");
            out.add("your Spring Security config, e.g. {@code http.authorizeHttpRequests(a ->");
        }
        out.add("a.requestMatchers(\"" + routeBase + "/**\").authenticated())}.");
        out.add("A row-ownership rule (\"only the owner may read this row\") can't be expressed in path");
        out.add("config — eject this generator with {@code mvn metaobjects:eject} and hand-write those");
        out.add("endpoints.");
        return out;
    }

    /** The class Javadoc, its two annotations and its opening line; the caller closes the block. */
    protected CodeWriter.Block openControllerClass(SpringJavaWriter w, List<String> doc, String routeBase,
                                                   String controllerName) {
        w.doc(doc.toArray(new String[0]));
        w.line("@RestController");
        w.line("@RequestMapping(\"" + routeBase + "\")");
        return w.block("public class " + controllerName + " {");
    }

    /** Write the finished controller through the shared write path. */
    protected void writeControllerFile(Path outRoot, String pkg, String controllerName, SpringJavaWriter w,
                                       String failureContext) {
        try {
            Path outFile = outRoot.resolve(pkg.replace('.', '/')).resolve(controllerName + ".java");
            GeneratedFileWriter.write(outFile, w.toString());
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing " + failureContext.replace("{file}", controllerName + ".java") + ": " + e, e);
        }
    }

    // -----------------------------------------------------------------------
    // The WRITABLE controller.
    // -----------------------------------------------------------------------

    protected void emit(MetaObject entity, Path outRoot) {
        String[] split = SpringNaming.splitFqn(entity.getName());
        String pkg = split[0];
        String shortName = split[1];
        String dtoName = SpringNaming.dtoName(shortName);
        String repoName = SpringNaming.repositoryName(shortName);
        String controllerName = SpringNaming.controllerName(shortName);
        String routeBase = SpringNaming.controllerPath(entity);
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

        SpringJavaWriter w = newWriter(pkg);
        useWritableImports(w);
        List<String> doc = new ArrayList<>();
        doc.add("GENERATED — REST controller for " + shortName + " entity. Implements the cross-port API contract.");
        doc.add("");
        doc.addAll(authDoc(routeBase, false));
        try (CodeWriter.Block cls = openControllerClass(w, doc, routeBase, controllerName)) {
            // Sort allowlist — static per-entity Set. Field-prefixed inner constant keeps it
            // private to this controller (no cross-file collision risk).
            writeSortAllowlist(w, entity, sortFields);
            writeServerOwnedOnCreate(w, entity);
            ApiSettings api = ApiSettings.of(entity);
            writeKnownFields(w, api, new ArrayList<>(entity.getMetaFields()));
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
            writeWritableConstructor(w, controllerName, repoName);
            writeUnreadableBodyHandler(w);
            if (redacts) writeRedactHelpers(w);

            // GET (list) — pagination + sort + withCount + FR-009 filter operators.
            writeListHandler(w, shortName, dtoName, repoName, hidden, api.pagination());
            // GET /{id} — single by primary key.
            writeGetByIdHandler(w, pkType, hidden);
            writeCreateHandler(w, entity, dtoName, repoName, api, hidden);
            writeUpdateHandler(w, entity, shortName, dtoName, pkType, api, hidden);
            writeDeleteHandler(w, pkType);
            for (SpringM2mSupport.M2mNav nav : navs) writeM2mHandler(w, entity, nav, pkType);
            writeParseSortHelper(w, repoName);
        }
        writeControllerFile(outRoot, pkg, controllerName, w, "{file} for entity " + entity.getName());
    }

    /**
     * The three injected fields and the constructor of a writable controller: the repository,
     * the ObjectMapper (binds each present PATCH value) and the jakarta Validator.
     */
    protected void writeWritableConstructor(SpringJavaWriter w, String controllerName, String repoName) {
        w.line("private final " + repoName + " repository;");
        w.line("private final ObjectMapper objectMapper;");
        w.line("private final Validator validator;");
        w.blank();
        try (CodeWriter.Block b = w.block(
                "public " + controllerName + "(" + repoName + " repository, ObjectMapper objectMapper, Validator validator) {")) {
            w.text("""
                this.repository = repository;
                this.objectMapper = objectMapper;
                this.validator = validator;
                """);
        }
        w.blank();
    }

    /**
     * POST — create. FR-036: bind the raw DTO (no @Valid, whose default 400 body is NOT the
     * cross-port envelope and does not even fire under the standaloneSetup test harness) and
     * validate it EXPLICITLY with the injected Validator, emitting {"error":"validation"} on
     * any field-constraint violation BEFORE persisting.
     */
    protected void writeCreateHandler(SpringJavaWriter w, MetaObject entity, String dtoName, String repoName,
                                      ApiSettings api, List<String> hidden) {
        w.line("@PostMapping");
        // A create body that omits a field with a literal @default binds @default, as every
        // other port's create shape does. The DTO is a record, which cannot default a component,
        // so the handler binds the raw body, fills the absent defaulted fields, and then binds the
        // DTO (an explicit value, null included, is kept). An entity with no such field keeps the
        // direct DTO binding, byte-identical.
        List<MetaField> components = SpringGeneratorSupport.dtoComponentFields(entity);
        List<String> defaultPuts = createDefaultPuts(entity, components);
        // api.unknownFields = reject (the default) binds the raw body too: the undeclared keys are
        // read off the JSON itself, so the answer does not depend on how the host's ObjectMapper
        // treats an unknown property.
        boolean bindsRaw = !defaultPuts.isEmpty() || api.rejectsUnknownFields();
        String head = bindsRaw
            ? "public ResponseEntity<?> create(@RequestBody JsonNode body) {"
            : "public ResponseEntity<?> create(@RequestBody " + dtoName + " dto) {";
        try (CodeWriter.Block m = w.block(head)) {
            if (bindsRaw) writeFillDefaults(w, dtoName, defaultPuts, api.rejectsUnknownFields());
            // #484: a @formExclude / credential value is IGNORED (never rejected): the DTO is rebuilt
            // without it, so the column is left to the repository's default.
            // Also dropped (never rejected): a server-generated primary key, a readOnly field and a derived
            // field, none of which a client may set on create.
            writeStripWriteDenied(w, dtoName, components, createDeniedNames(entity, components));
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
            // Every violation is listed (never just the first): the issues are collected, then answered once.
            if (serverOwnedOnCreate(entity).isEmpty()) {
                w.line("ValidationIssues __issues = new ValidationIssues().addViolations(validator.validate(dto));");
            } else {
                w.text("""
                    ValidationIssues __issues = new ValidationIssues()
                            .addViolationsExcept(validator.validate(dto), SERVER_OWNED_ON_CREATE);
                    """);
            }
            writeIssuesVerdict(w);
            // Issue #203: honor @autoSet — stamp EVERY onCreate AND onUpdate column with now() before
            // persisting (the caller's value is ignored; a fresh row's updated_at equals its created_at).
            // The stamp is a static helper on the DTO record; entities with no @autoSet field call
            // repository.create(dto) verbatim (byte-identical to the pre-#203 handler).
            String createArg = SpringGeneratorSupport.hasAutoSetFields(entity)
                ? dtoName + ".stampForInsert(dto)" : "dto";
            try (CodeWriter.Block t = w.block("try {", CATCH_RUNTIME)) {
                w.line(dtoName + " saved = repository.create(" + createArg + ");");
                w.line("return ResponseEntity.status(HttpStatus.CREATED).body(" + redactOne("saved", hidden) + ");");
            }
            writeConstraintCatch(w);
        }
        w.blank();
    }

    /**
     * PATCH + PUT — single handler (per API contract; same body shape both verbs).
     * Both verbs MUST be expressed on one @RequestMapping with method={PATCH, PUT}.
     * Stacking @PatchMapping + @PutMapping on the same method does NOT register both
     * in Spring MVC — only one composed @RequestMapping per method is honored, so the
     * other verb 405s. (Surfaced by the SP-F generated-controller HTTP lane.)
     * FR-035 present-key PATCH: bind the RAW JsonNode (not the @Valid full DTO, which
     * conflates absent with null and 400s an omitted @required field), build the
     * presence-tracked <Entity>Patch, and delegate to repository.patch. An explicit
     * null clears a nullable column; an explicit null on a @required field throws
     * PatchValidationException → 400 {"error":"validation"}. update(id, dto) stays on
     * the interface for programmatic full-DTO use.
     */
    protected void writeUpdateHandler(SpringJavaWriter w, MetaObject entity, String shortName, String dtoName,
                                      String pkType, ApiSettings api, List<String> hidden) {
        String patchName = SpringNaming.patchName(shortName);
        w.line("@RequestMapping(value = \"/{id}\", method = { RequestMethod.PATCH, RequestMethod.PUT })");
        try (CodeWriter.Block m = w.block(
                "public ResponseEntity<?> update(@PathVariable " + pkType + " id, @RequestBody JsonNode body) {")) {
            writeUnknownFieldsGuard(w, api);
            writePatchBinding(w, patchName, dtoName);
            // Program D (spec section 0): validateValue does NOT cascade @Valid into a nested value
            // object's own constraints, so validate each PRESENT VO element EXPLICITLY. The property's
            // OWN constraints (@NotNull on a @required column, present-null tristate) are already
            // covered above / in <Entity>Patch.fromJson; this closes the nested-constraint gap (e.g. a
            // Marker.label over @maxLength, or null on a @required nested member) with a 400.
            writeValueObjectValidation(w, entity);
            writePatchVerdict(w);
            // Issue #203: honor @autoSet onUpdate — bump every onUpdate column to now() on EVERY partial
            // update (the model value is ignored; the server owns the timestamp), injected AFTER the
            // caller's present values are validated and BEFORE delegating so a PATCH that omits the
            // timestamp still bumps it. onCreate columns are never touched here (created_at is immutable).
            if (SpringGeneratorSupport.hasOnUpdateFields(entity)) {
                w.line("patch.stampAutoSetOnUpdate();");
            }
            try (CodeWriter.Block t = w.block("try {", CATCH_RUNTIME)) {
                w.line("return repository.patch(id, patch)");
                w.continuation(".<ResponseEntity<?>>map(" + okMapper(hidden) + ")");
                w.continuation(".orElseGet(() -> " + NOT_FOUND_RESPONSE + ");");
            }
            writeConstraintCatch(w);
        }
        w.blank();
    }

    /** DELETE — 204 on success, 404 envelope on miss. */
    protected void writeDeleteHandler(SpringJavaWriter w, String pkType) {
        w.line("@DeleteMapping(\"/{id}\")");
        try (CodeWriter.Block m = w.block("public ResponseEntity<?> delete(@PathVariable " + pkType + " id) {")) {
            try (CodeWriter.Block t = w.block("try {", CATCH_RUNTIME)) {
                w.text("""
                    if (repository.delete(id)) {
                        return ResponseEntity.noContent().build();
                    }
                    """);
                w.line("return " + NOT_FOUND_RESPONSE + ";");
            }
            writeConstraintCatch(w);
        }
        w.blank();
    }

    /**
     * FR-018 M:N traversal — GET /{id}/<relationName> exposes each
     * @cardinality:"many" + @through relationship as a sub-resource of the source,
     * returning the related target rows. The source URL segment is the entity name
     * pluralized (handled by @RequestMapping above); the relation segment is the
     * relationship name. Related-row order is not contractual. The repository finder
     * traverses the junction (hetero / directed self-join / symmetric union-on-read).
     */
    protected void writeM2mHandler(SpringJavaWriter w, MetaObject source, SpringM2mSupport.M2mNav nav, String pkType) {
        String finder = SpringGeneratorSupport.m2mFinderName(nav.relationName());
        String navCall = "repository." + finder + "(id" + SpringGeneratorSupport.targetSubtypeCallArg(nav) + ")";
        List<String> targetHidden = targetCredentials(source, nav);
        w.line("@GetMapping(\"/{id}/" + nav.relationName() + "\")");
        String rowType = targetHidden.isEmpty() ? nav.targetDtoType() : "Object";
        try (CodeWriter.Block m = w.block("public ResponseEntity<List<" + rowType + ">> "
                + finder + "(@PathVariable " + pkType + " id) {")) {
            w.line("return ResponseEntity.ok(" + redactAll(navCall, targetHidden) + ");");
        }
        w.blank();
    }

    /**
     * The head of a PATCH handler: bind the body to the presence-tracked patch and validate each
     * PRESENT value against the DTO's field constraints, collecting EVERY issue into
     * {@code __issues} (a bind failure lists all its problems, and the values that did bind are
     * still validated). Per-field and NOT a whole-bean validate, which would fire {@code @NotNull}
     * on ABSENT fields; {@code validateValue} skips null for {@code @Size}/{@code @Pattern} and a
     * non-required field carries no {@code @NotNull}, so a present-null-clears composes cleanly.
     * Leaves {@code __assigned} (the bound values) and {@code __patch} (null after a bind failure)
     * for {@link #writePatchVerdict}.
     */
    protected void writePatchBinding(SpringJavaWriter w, String patchName, String dtoName) {
        w.line("ValidationIssues __issues = new ValidationIssues();");
        w.line(patchName + " __patch = null;");
        w.line("Map<String, Object> __assigned;");
        try (CodeWriter.Block t = w.block("try {", "} catch (PatchValidationException e) {")) {
            w.line("__patch = " + patchName + ".fromJson(body, objectMapper);");
            w.line("__assigned = __patch.assignedValues();");
        }
        try (CodeWriter.Block c = w.bodyBlock()) {
            w.text("""
                __issues.addPatchFailure(e);
                __assigned = e.assignedValues();
                """);
        }
        try (CodeWriter.Block f = w.block("for (Map.Entry<String, Object> __e : __assigned.entrySet()) {")) {
            w.line("__issues.addAt(validator.validateValue(" + dtoName
                + ".class, RecordComponentNames.escape(__e.getKey()), __e.getValue()), __e.getKey());");
        }
    }

    /** The end of the PATCH validation: answer every collected issue at once, else expose {@code patch}. */
    protected void writePatchVerdict(SpringJavaWriter w) {
        writeIssuesVerdict(w);
        w.line("final var patch = __patch;");
    }

    /** Answer the collected {@code __issues} with a 400 when there are any. */
    protected void writeIssuesVerdict(SpringJavaWriter w) {
        w.text("""
            if (!__issues.isEmpty()) {
                return ResponseEntity.badRequest().body(__issues.body());
            }
            """);
    }

    /**
     * Program D — per-value-object nested-validation guards in a PATCH handler, one per
     * {@code field.object @storage:jsonb} column (spec section 0), reading the BOUND values from
     * {@code __assigned}. A present single VO value is validated whole; a present array is validated
     * element-by-element. Skips null (present-null clears / is caught upstream) so the tristate
     * composes. Every violation is collected into {@code __issues}, its path the field's wire name
     * then the element index or key then the member. Writes nothing for an entity with no
     * value-object columns, keeping non-VO controllers byte-identical.
     */
    protected void writeValueObjectValidation(SpringJavaWriter w, MetaObject entity) {
        for (ObjectField vf : SpringGeneratorSupport.valueObjectJsonbFields(entity)) {
            String name = SpringGeneratorSupport.escapeJavaString(vf.getName());
            if (vf.isArrayType()) {
                writeAssignedElementLoop(w, name);
            } else {
                try (CodeWriter.Block b = w.block("if (__assigned.get(\"" + name + "\") != null) {")) {
                    w.line("__issues.addViolations(validator.validate(__assigned.get(\"" + name + "\")), \"" + name + "\");");
                }
            }
        }
        // A field.map @objectRef carries the same nested value objects, and the POST path
        // cascades into them via @Valid on the DTO component. PATCH validates field-by-field
        // with validateValue, which does NOT cascade — so without this the two write paths
        // disagree for maps where they agree for field.object, and a PATCH could write a
        // nested value object POST rejects. The map's VALUES are the beans (keys are strings).
        writeValueObjectMapValidation(w, entity);
    }

    /** The map-of-value-object part of {@link #writeValueObjectValidation}, for a TPH subtype's PATCH. */
    protected void writeValueObjectMapValidation(SpringJavaWriter w, MetaObject entity) {
        for (MetaField vf : SpringGeneratorSupport.valueObjectMapFields(entity)) {
            writeAssignedMapLoop(w, SpringGeneratorSupport.escapeJavaString(vf.getName()));
        }
    }

    /** The element-wise validation of a present array-of-value-object {@code __assigned} entry. */
    protected void writeAssignedElementLoop(SpringJavaWriter w, String name) {
        try (CodeWriter.Block b = w.block("if (__assigned.get(\"" + name + "\") instanceof java.util.Collection<?> __c) {")) {
            w.line("int __i = 0;");
            try (CodeWriter.Block f = w.block("for (Object __el : __c) {")) {
                w.line("if (__el != null) __issues.addViolations(validator.validate(__el), \"" + name + "\", __i);");
                w.line("__i++;");
            }
        }
    }

    /** The value-wise validation of a present map-of-value-object {@code __assigned} entry. */
    protected void writeAssignedMapLoop(SpringJavaWriter w, String name) {
        try (CodeWriter.Block b = w.block("if (__assigned.get(\"" + name + "\") instanceof Map<?, ?> __m) {")) {
            try (CodeWriter.Block f = w.block("for (Map.Entry<?, ?> __en : __m.entrySet()) {")) {
                w.line("if (__en.getValue() != null) __issues.addViolations(validator.validate(__en.getValue()), \""
                    + name + "\", String.valueOf(__en.getKey()));");
            }
        }
    }

    /**
     * The map-of-value-object validation for a body bound as the union {@code <Base>Dto}, whose
     * accessors are plain (no {@code hasX()} tristate). Used by the TPH per-subtype CREATE path,
     * where absent and null are already indistinguishable on the bound DTO, so a null check is
     * the whole guard.
     *
     * <p>#362: without this the TPH create validated a {@code field.map @objectRef} with
     * {@code validateValue}, which applies the property's own constraints and does NOT cascade
     * {@code @Valid} into the map's values — so a posted
     * {@code {"labels": {"k": {...invalid...}}}} was accepted and written.
     */
    protected void writeMapValueValidationLoop(SpringJavaWriter w, String accessorExpr, String wireName) {
        try (CodeWriter.Block b = w.block("if (" + accessorExpr + " != null) {")) {
            try (CodeWriter.Block f = w.block("for (var __en : " + accessorExpr + ".entrySet()) {")) {
                w.line("if (__en.getValue() != null) __issues.addViolations(validator.validate(__en.getValue()), \""
                    + SpringGeneratorSupport.escapeJavaString(wireName) + "\", String.valueOf(__en.getKey()));");
            }
        }
    }

    // -----------------------------------------------------------------------
    // The READ-ONLY controller.
    // -----------------------------------------------------------------------

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
     * handlers, the sort allowlist, parseSort) they share by calling the same writers.</p>
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
        String routeBase = SpringNaming.controllerPath(entity);
        boolean hasItem = RestSurfaceGate.hasItemRoute(entity);
        String pkType = SpringTypeMapper.primaryKeyJavaType(entity);
        boolean report = com.metaobjects.generator.util.GeneratorUtil.isReport(entity);

        List<String> sortFields = sortableFields(entity);

        SpringJavaWriter w = newWriter(pkg);
        useReadOnlyImports(w, entity, hasItem);
        List<String> doc = new ArrayList<>();
        doc.add("GENERATED — READ-ONLY REST controller for the " + shortName + " " + noun + ".");
        if (!report) {
            doc.add("Implements the cross-port API contract: GET list + GET by id; every write");
            doc.add("verb answers 405 {\"error\": \"method_not_allowed\"}.");
        } else {
            doc.add("Implements the cross-port API contract: GET list; POST answers");
            doc.add("405 {\"error\": \"method_not_allowed\"}. A report has no identity, so no item");
            doc.add("route is mounted.");
        }
        doc.add("");
        doc.addAll(authDoc(routeBase, true));
        try (CodeWriter.Block cls = openControllerClass(w, doc, routeBase, controllerName)) {
            writeSortAllowlist(w, entity, sortFields);

            // #484: a projection field that inherits a credential (view.password) is hidden from its
            // rows. A served report is covered too: a derived column over a credential is a credential.
            List<String> hidden = SpringGeneratorSupport.credentialNames(entity);
            writeReadOnlyConstructor(w, controllerName, repoName, !hidden.isEmpty());
            if (!hidden.isEmpty()) writeRedactHelpers(w);

            if (report) {
                writeReportListHandler(w, shortName, dtoName, repoName, reportMaxRows, reportExport, routeBase, hidden);
            } else {
                writeListHandler(w, shortName, dtoName, repoName, hidden, ApiSettings.of(entity).pagination());
            }
            if (hasItem) {
                writeGetByIdHandler(w, pkType, hidden);
            }
            writeRejectWrites(w, hasItem, pkType);
            writeMethodNotAllowed(w, noun);
            writeParseSortHelper(w, repoName);
        }
        writeControllerFile(outRoot, pkg, controllerName, w, "{file} for " + noun + " " + entity.getName());
    }

    /**
     * Repository wiring of a read-only controller — constructor injection, the read-only seam
     * only. No ObjectMapper and no Validator: nothing here binds a request body, so injecting
     * either would make a consumer wire beans this controller can never use. Redaction needs
     * the ObjectMapper, so it is injected ONLY when a row hides a credential (#484).
     */
    protected void writeReadOnlyConstructor(SpringJavaWriter w, String controllerName, String repoName,
                                            boolean redacts) {
        w.line("private final " + repoName + " repository;");
        if (!redacts) {
            w.blank();
            try (CodeWriter.Block b = w.block("public " + controllerName + "(" + repoName + " repository) {")) {
                w.line("this.repository = repository;");
            }
        } else {
            w.line("private final com.fasterxml.jackson.databind.ObjectMapper objectMapper;");
            w.blank();
            try (CodeWriter.Block b = w.block("public " + controllerName + "(" + repoName
                    + " repository, com.fasterxml.jackson.databind.ObjectMapper objectMapper) {")) {
                w.line("this.objectMapper = objectMapper;");
                w.line("this.repository = repository;");
            }
        }
        w.blank();
    }

    /**
     * The 405 mappings of a read-only controller: POST on the collection and, when an item route
     * is mounted, PATCH / PUT / DELETE on the item. One mapping serves all three item verbs: the
     * bodies are identical and only the verb NAME differs, which the request carries. Stacking
     * {@code @PatchMapping} + {@code @PutMapping} on one method does NOT register both in Spring
     * MVC (see {@link #writeUpdateHandler}), so the method= list is the form that works.
     */
    protected void writeRejectWrites(SpringJavaWriter w, boolean hasItem, String pkType) {
        w.text("""
            @PostMapping
            public ResponseEntity<?> create() {
                return methodNotAllowed("POST");
            }
            """);
        w.blank();
        if (hasItem) {
            w.line("@RequestMapping(value = \"/{id}\", method = { RequestMethod.PATCH, RequestMethod.PUT, RequestMethod.DELETE })");
            try (CodeWriter.Block m = w.block(
                    "public ResponseEntity<?> rejectItemWrite(@PathVariable " + pkType + " id, HttpServletRequest request) {")) {
                w.line("return methodNotAllowed(request.getMethod());");
            }
            w.blank();
        }
    }

    /** The {@code methodNotAllowed} helper the 405 mappings answer through. */
    protected void writeMethodNotAllowed(SpringJavaWriter w, String noun) {
        try (CodeWriter.Block m = w.block("private static ResponseEntity<?> methodNotAllowed(String verb) {")) {
            w.line("return ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED)");
            w.continuation(".body(Map.of(\"error\", \"method_not_allowed\",");
            w.deeper(4, () -> w.line("\"message\", verb + \" is not supported on a " + noun + " (read-only).\"));"));
        }
        w.blank();
    }

    // -----------------------------------------------------------------------
    // Writers shared by the WRITABLE controller (emit) and the READ-ONLY one
    // (emitReadOnly): a read-only projection serves the same list + get + sort
    // surface a table entity does, and the F22 change must not be able to reword
    // one of them and not the other.
    //
    // emitTph() keeps its own handlers. A TPH base's list and get are DISCRIMINATOR-
    // scoped and its parseSort names a different repository type, so they are not the
    // same writer wearing a flag.
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
    protected static List<String> sortableFields(MetaObject entity) {
        List<String> sortFields = new ArrayList<>();
        // #484: a served report's credential column is not sortable: ordering by it is an oracle.
        List<String> credentials = com.metaobjects.generator.util.GeneratorUtil.isReport(entity)
            ? SpringGeneratorSupport.credentialNames(entity) : List.of();
        for (MetaField field : entity.getMetaFields()) {
            if (!FilterOps.supportsFiltering(field.getSubType())) continue;
            if (credentials.contains(field.getName())) continue;
            // A credential (view.password) is never sortable: the order would leak the hidden value.
            if (SpringGeneratorSupport.isCredentialField(field)) continue;
            // A derived report field over an array is not sortable (a map has no band above).
            if (com.metaobjects.generator.util.GeneratorUtil.isReport(entity) && (field.isArrayType() || field instanceof com.metaobjects.field.MapField)) continue;
            sortFields.add(field.getName());
        }
        return sortFields;
    }

    /** {@code names} as a comma-separated list of Java string literals. */
    protected static String quotedList(Collection<String> names) {
        List<String> out = new ArrayList<>(names.size());
        for (String n : names) out.add(javaLiteral(n));
        return String.join(", ", out);
    }

    /**
     * The static per-controller SORT_ALLOWLIST set plus its SORT_DEFAULT_ORDER map.
     * Field-prefixed inner constants keep them private to this controller (no
     * cross-file collision risk).
     */
    protected void writeSortAllowlist(SpringJavaWriter w, MetaObject owner, List<String> sortFields) {
        List<String> quoted = new ArrayList<>(sortFields.size());
        // The sortable names are the model's own and are written unescaped, as they always were.
        for (String f : sortFields) quoted.add('"' + f + '"');
        w.line("private static final Set<String> SORT_ALLOWLIST = Set.of(" + String.join(", ", quoted) + ");");
        w.blank();
        writeSortDefaultOrders(w, owner, sortFields);
    }

    /**
     * ADR-0019 Amendment 1 (W2/W3): a body Jackson cannot bind (a malformed or out-of-range
     * decimal, a wrong JSON type) answers {@code 400 {"error":"validation","field":...}}, the
     * cross-port validation envelope, rather than Spring's default body.
     */
    protected void writeUnreadableBodyHandler(SpringJavaWriter w) {
        w.text("""
            @org.springframework.web.bind.annotation.ExceptionHandler(org.springframework.http.converter.HttpMessageNotReadableException.class)
            public ResponseEntity<?> onUnreadableBody(org.springframework.http.converter.HttpMessageNotReadableException e) {
                return ResponseEntity.badRequest().body(UnreadableBody.envelope(e));
            }
            """);
        w.blank();
    }

    /** The head of a GET handler whose parameters are one per continuation line; returns its body scope. */
    protected CodeWriter.Block openHandler(SpringJavaWriter w, String name, List<String> params) {
        w.line("public ResponseEntity<?> " + name + "(");
        for (int i = 0; i < params.size(); i++) {
            w.continuation(params.get(i) + (i < params.size() - 1 ? "," : ") {"));
        }
        return w.bodyBlock();
    }

    /** The arguments after the query string of a {@code FilterParser.parse} call against {@code allowlist}. */
    protected static String filterAllowlistArgs(String allowlist) {
        return allowlist + ".FIELDS, " + allowlist + ".OPS_BY_FIELD, " + allowlist + ".DECIMAL_FIELDS, "
            + allowlist + ".DURATION_FIELDS";
    }

    /** {@code ?sort} parsing of a list handler, answering {@code invalid_sort} through {@code badRequest}. */
    protected void writeSortParse(SpringJavaWriter w, String repoName, String badRequest) {
        w.line(repoName + ".SortClause sortClause = null;");
        try (CodeWriter.Block b = w.block("if (sort != null) {")) {
            w.line("sortClause = parseSort(sort);");
            // `field` names the rejected sort field — required on every cross-port
            // invalid_sort envelope. `sort` is non-null in this branch and split()
            // always yields at least one element, so the index is safe.
            try (CodeWriter.Block c = w.block("if (sortClause == null) {")) {
                w.line("return " + badRequest + "Map.of(\"error\", \"invalid_sort\", \"field\", sort.split(\":\", 2)[0]));");
            }
        }
    }

    /** The {@code filter[...]} parse of a list handler, answering its error through {@code badRequest}. */
    protected void writeFilterParse(SpringJavaWriter w, String allowlist, String badRequest) {
        w.line("FilterParseResult filter = FilterParser.parse(");
        w.continuation("request.getQueryString(), " + filterAllowlistArgs(allowlist) + ");");
        try (CodeWriter.Block b = w.block("if (filter.error() != null) {")) {
            w.line("return " + badRequest + "Map.of(\"error\", filter.error(), \"field\", filter.field()));");
        }
    }

    /**
     * GET (list) — pagination + sort + withCount + FR-009 filter operators.
     * HttpServletRequest carries the raw query string so the bracketed
     * filter[&lt;field&gt;][&lt;op&gt;]=&lt;value&gt; grammar reaches FilterParser intact
     * (Spring's {@code @RequestParam} would collapse same-key occurrences).
     */
    protected void writeListHandler(SpringJavaWriter w, String shortName, String dtoName, String repoName,
                                    List<String> hidden, ApiSettings.Pagination page) {
        String bad = "ResponseEntity.badRequest().body(";
        w.line("@GetMapping");
        try (CodeWriter.Block m = openHandler(w, "list",
                List.of(PARAM_LIMIT, PARAM_OFFSET, PARAM_SORT, PARAM_WITH_COUNT, PARAM_REQUEST))) {
            writeLimit(w, page);
            w.line("int actualOffset = offset != null ? offset : 0;");
            writeSortParse(w, repoName, bad);
            writeFilterParse(w, SpringNaming.filterAllowlistName(shortName), bad);
            w.line("List<FilterPredicate> filters = filter.predicates();");
            w.line("List<" + dtoName + "> rows = repository.list(actualLimit, actualOffset, sortClause, filters);");
            try (CodeWriter.Block b = w.block("if (withCount != null && withCount == 1) {")) {
                w.line("long total = repository.count(filters);");
                w.line("return ResponseEntity.ok(Map.of(\"rows\", " + redactAll("rows", hidden) + ", \"total\", total));");
            }
            w.line("return ResponseEntity.ok(" + redactAll("rows", hidden) + ");");
        }
        w.blank();
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
     *
     * <p>With the export branch wired, no answer of the list route consults Accept (the
     * selector is ?format): every body goes through the {@code badRequest} / {@code ok} helpers,
     * which carry an explicit application/json that Spring then honours instead of negotiating
     * against the request's Accept header.</p>
     */
    protected void writeReportListHandler(SpringJavaWriter w, String shortName, String dtoName, String repoName,
                                          int maxRows, boolean export, String routeBase, List<String> hidden) {
        String bad = export ? "badRequest(" : "ResponseEntity.badRequest().body(";
        String ok = export ? "ok(" : "ResponseEntity.ok(";
        List<String> params = new ArrayList<>(List.of(
            "@RequestParam(required = false) String limit",
            "@RequestParam(required = false) String offset",
            PARAM_SORT));
        if (export) {
            // Text, not Integer: an export request spells the flag "true" as well as "1", and
            // this handler, not Spring's conversion, decides what each answers.
            params.add("@RequestParam(required = false, name = \"withCount\") String withCount");
            params.add("@RequestParam(required = false, name = \"format\") String format");
        } else {
            params.add(PARAM_WITH_COUNT);
        }
        params.add(PARAM_REQUEST);
        w.line("@GetMapping");
        try (CodeWriter.Block m = openHandler(w, "list", params)) {
            if (export) {
                try (CodeWriter.Block b = w.block("if (format != null) {")) {
                    w.line("return export(format, limit, offset, sort, withCount, request);");
                }
            }
            w.line("final int maxRows = " + maxRows + ";");
            writeReportBounds(w, bad, "Map.of(\"error\", \"report_too_large\", \"maxRows\", maxRows)");
            writeSortParse(w, repoName, bad);
            writeFilterParse(w, SpringNaming.filterAllowlistName(shortName), bad);
            w.line("List<FilterPredicate> filters = filter.predicates();");
            w.line("List<" + dtoName
                + "> rows = repository.list(requestedLimit != null ? requestedLimit : maxRows + 1, actualOffset, sortClause, filters);");
            try (CodeWriter.Block b = w.block("if (requestedLimit == null && rows.size() > maxRows) {")) {
                w.line("return " + bad + "Map.of(\"error\", \"report_too_large\", \"maxRows\", maxRows));");
            }
            try (CodeWriter.Block b = w.block(export
                    ? "if (\"1\".equals(withCount)) {" : "if (withCount != null && withCount == 1) {")) {
                w.line("long total = repository.count(filters);");
                w.line("return " + ok + "Map.of(\"rows\", " + redactAll("rows", hidden) + ", \"total\", total));");
            }
            w.line("return " + ok + redactAll("rows", hidden) + ");");
        }
        w.blank();
        if (export) {
            writeReportExportHandler(w, shortName, dtoName, repoName, routeBase, hidden);
        }
        writeParseBound(w);
        if (export) {
            w.text("""
                private static ResponseEntity<Object> badRequest(Object body) {
                    return ResponseEntity.badRequest().contentType(MediaType.APPLICATION_JSON).body(body);
                }

                private static ResponseEntity<Object> ok(Object body) {
                    return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).body(body);
                }
                """);
            w.blank();
        }
    }

    /**
     * The {@code limit} and {@code offset} of a report request, read as text: {@code requestedLimit}
     * (null when absent) and {@code actualOffset}. A limit above {@code maxRows} answers
     * {@code tooLarge}.
     */
    protected void writeReportBounds(SpringJavaWriter w, String badRequest, String tooLarge) {
        w.line("Integer requestedLimit = null;");
        try (CodeWriter.Block b = w.block("if (limit != null) {")) {
            w.line("Long parsed = parseBound(limit, 1);");
            try (CodeWriter.Block c = w.block("if (parsed == null) {")) {
                w.line("return " + badRequest + "Map.of(\"error\", \"pagination.invalid_value\", \"param\", \"limit\", \"value\", limit, \"expected\", \"an integer from 1 to \" + maxRows));");
            }
            try (CodeWriter.Block c = w.block("if (parsed > maxRows) {")) {
                w.line("return " + badRequest + tooLarge + ");");
            }
            w.line("requestedLimit = parsed.intValue();");
        }
        w.line("int actualOffset = 0;");
        try (CodeWriter.Block b = w.block("if (offset != null) {")) {
            w.line("Long parsed = parseBound(offset, 0);");
            try (CodeWriter.Block c = w.block("if (parsed == null) {")) {
                w.line("return " + badRequest + "Map.of(\"error\", \"pagination.invalid_value\", \"param\", \"offset\", \"value\", offset, \"expected\", \"a non-negative integer (0 or more)\"));");
            }
            w.line("actualOffset = (int) Math.min(parsed, Integer.MAX_VALUE);");
        }
    }

    /** The {@code parseBound} helper a report handler reads its page bounds with. */
    protected void writeParseBound(SpringJavaWriter w) {
        w.text("""
            /** A page bound as an integer of at least {@code min}, or null when it is not one. */
            private static Long parseBound(String raw, long min) {
                try {
                    long n = Long.parseLong(raw);
                    return n >= min ? n : null;
                } catch (NumberFormatException e) {
                    return null;
                }
            }
            """);
        w.blank();
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
    protected void writeReportExportHandler(SpringJavaWriter w, String shortName, String dtoName,
                                            String repoName, String routeBase, List<String> hidden) {
        String exportName = shortName + "Export";
        String bad = "badRequest(";
        w.line("private ResponseEntity<?> export(String format, String limit, String offset, String sort,");
        w.continuation("String withCount, HttpServletRequest request) {");
        try (CodeWriter.Block m = w.bodyBlock()) {
            w.line("final int maxRows = " + exportName + ".MAX_ROWS;");
            w.text("""
                if (!ReportExport.isFormat(format)) {
                    return badRequest(ReportExport.invalidFormat());
                }
                if (!ReportExport.JSON.equals(format) && ReportExport.isTruthy(withCount)) {
                    return badRequest(ReportExport.withCount());
                }
                """);
            writeReportBounds(w, bad, "ReportExport.tooLarge(maxRows)");
            writeSortParse(w, repoName, bad);
            writeFilterParse(w, SpringNaming.filterAllowlistName(shortName), bad);
            w.line("List<" + dtoName
                + "> rows = repository.list(requestedLimit != null ? requestedLimit : maxRows + 1, actualOffset, sortClause, filter.predicates());");
            w.text("""
                if (requestedLimit == null && rows.size() > maxRows) {
                    return badRequest(ReportExport.tooLarge(maxRows));
                }
                ResponseEntity.BodyBuilder ok = ResponseEntity.ok()
                """);
            w.continuation(".header(\"Content-Disposition\", ReportExport.contentDisposition(\""
                + routeBase.substring(routeBase.lastIndexOf('/') + 1) + "\", format))");
            w.continuation(".header(\"Content-Type\", ReportExport.contentType(format));");
            try (CodeWriter.Block s = w.block("switch (format) {")) {
                w.line("case ReportExport.CSV:");
                w.deeper(1, () -> w.line("return ok.body(" + exportName + ".csv(rows));"));
                w.line("case ReportExport.XML:");
                w.deeper(1, () -> w.line("return ok.body(" + exportName + ".xml(rows));"));
                w.line("default:");
                w.deeper(1, () -> {
                    try (CodeWriter.Block b = w.block("if (\"1\".equals(withCount)) {")) {
                        w.line("return ok.body(Map.of(\"rows\", " + redactAll("rows", hidden)
                            + ", \"total\", repository.count(filter.predicates())));");
                    }
                    w.line("return ok.body(" + redactAll("rows", hidden) + ");");
                });
            }
        }
        w.blank();
    }

    /** GET /{id} — single by primary key, 404 envelope on a miss. */
    protected void writeGetByIdHandler(SpringJavaWriter w, String pkType, List<String> hidden) {
        w.line("@GetMapping(\"/{id}\")");
        try (CodeWriter.Block m = w.block("public ResponseEntity<?> get(@PathVariable " + pkType + " id) {")) {
            w.line("return repository.findById(id)");
            w.continuation(".<ResponseEntity<?>>map(" + okMapper(hidden) + ")");
            w.continuation(".orElseGet(() -> " + NOT_FOUND_RESPONSE + ");");
        }
        w.blank();
    }

    /**
     * parseSort — returns null on malformed/disallowed input. Returning null lets the
     * list handler emit the 400 envelope itself rather than throwing — cleaner
     * separation. Package-internal to each generated file.
     *
     * <p>{@code ?sort=field} with no {@code :order} takes the field's DECLARED
     * {@code @sortableDefaultOrder}. The "asc" fallback stays HERE, at the read, so it is
     * spelled once per port and SORT_DEFAULT_ORDER carries declarations only.</p>
     */
    protected void writeParseSortHelper(SpringJavaWriter w, String repoName) {
        try (CodeWriter.Block m = w.block("private static " + repoName + ".SortClause parseSort(String raw) {")) {
            w.text("""
                String[] parts = raw.split(":", 2);
                if (parts.length == 0 || parts[0].isEmpty() || !SORT_ALLOWLIST.contains(parts[0])) return null;
                String dir = parts.length == 2 ? parts[1].toLowerCase()
                    : SORT_DEFAULT_ORDER.getOrDefault(parts[0], "asc");
                if (!dir.equals("asc") && !dir.equals("desc")) return null;
                """);
            w.line("return new " + repoName + ".SortClause(parts[0], dir);");
        }
        w.blank();
    }

    // -----------------------------------------------------------------------
    // The single-table hierarchy (TPH) controller.
    // -----------------------------------------------------------------------

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
        String routeBase = SpringNaming.controllerPath(base);
        String allowlistName = SpringNaming.filterAllowlistName(shortName);
        // The single TPH table is keyed by the BASE's primary identity — every polymorphic
        // + per-subtype by-id route binds that derived PK type (uuid → java.util.UUID, …).
        String pkType = SpringTypeMapper.primaryKeyJavaType(base);

        // Sort allowlist: the base's own scalar columns (the polymorphic sort surface). Subtype
        // columns are not sortable across the polymorphic collection. Same canonical band as the
        // vanilla allowlist above — hand-listing the exclusions here had already drifted from it.
        List<String> sortFields = new ArrayList<>();
        List<String> hierarchyCredentials = SpringGeneratorSupport.hierarchyCredentialNames(base);
        for (MetaField field : base.getMetaFields()) {
            if (!FilterOps.supportsFiltering(field.getSubType())) continue;
            if (hierarchyCredentials.contains(field.getName())) continue; // never sortable: the order leaks it
            sortFields.add(field.getName());
        }

        SpringJavaWriter w = newWriter(pkg);
        // FR-036 Program B: the per-subtype update handler binds the RAW JsonNode + builds the
        // presence-tracked <Sub>Patch (present-key PATCH tristate), so it needs Jackson + the
        // PatchValidationException + the jakarta Validator (present-value constraint checks) —
        // exactly the vanilla update handler's dependency set.
        useWritableImports(w);
        List<String> doc = new ArrayList<>();
        doc.add("GENERATED — TPH discriminator-base controller for " + shortName
            + " (polymorphic collection + per-subtype CRUD).");
        doc.add("Implements the cross-port API contract.");
        doc.add("");
        doc.addAll(authDoc(routeBase, false));
        try (CodeWriter.Block cls = openControllerClass(w, doc, routeBase, controllerName)) {
            // The polymorphic sort surface is the BASE's own columns, so the declared orders
            // are read off the base too — same owner the allowlist above was built from.
            writeSortAllowlist(w, base, sortFields);
            // A key declared by the base or by ANY subtype is known on every subtype route: a sibling
            // subtype's column is dropped there (it is not this route's to write), never refused.
            ApiSettings api = ApiSettings.of(base);
            List<MetaField> declared = new ArrayList<>(base.getMetaFields());
            declared.addAll(TphPlan.everySubtypeField(base, loader));
            writeKnownFields(w, api, declared);

            // FR-036 Program B: constructor-inject the ObjectMapper (binds each present PATCH value via
            // <Sub>Patch.fromJson, same wire codecs as create) + the jakarta Validator (per-field
            // present-value constraint checks on the per-subtype update) — same 3-arg shape the vanilla
            // controller uses. The polymorphic + read routes ignore them.
            writeWritableConstructor(w, controllerName, repoName);
            writeUnreadableBodyHandler(w);
            // #484: the TPH rows are union-DTO rows, so hide a credential declared on the base or on
            // ANY subtype from every response, and ignore a write-denied one on every subtype create.
            List<MetaField> unionFields = new ArrayList<>(SpringGeneratorSupport.scalarFields(base));
            for (MetaField f : TphPlan.collectSubtypeFields(base, loader)) {
                if (!(f instanceof com.metaobjects.field.ObjectField)) unionFields.add(f);
            }
            List<MetaField> markFields = new ArrayList<>(unionFields);
            markFields.addAll(TphPlan.everySubtypeField(base, loader));
            List<String> hidden = SpringGeneratorSupport.credentialNames(markFields);
            Set<String> writeDenied = SpringGeneratorSupport.hierarchyWriteDeniedNames(base);
            List<SpringM2mSupport.M2mNav> baseNavs = SpringM2mSupport.resolve(base, loader);
            boolean redacts = !hidden.isEmpty() || baseNavs.stream().anyMatch(n -> !targetCredentials(base, n).isEmpty())
                || plan.subtypes().stream().anyMatch(st -> SpringM2mSupport.resolve(st.entity(), loader).stream()
                    .anyMatch(n -> !targetCredentials(st.entity(), n).isEmpty()));
            if (redacts) writeRedactHelpers(w);

            writeTphListHandler(w, dtoName, repoName, allowlistName, api, hidden);
            writeTphGetHandler(w, pkType, hidden);
            // FR-018 x FR-017 — M:N traversal declared on the BASE: every row of the shared
            // table is a legitimate source, so this is the SAME mount + finder shape a vanilla
            // entity gets — no discriminator gating needed. Per-subtype traversal (including this
            // same relationship, inherited) is written inside the per-subtype set — the overlap is
            // deliberate (FR-017 design): a subtype resource carries the same sub-resources as any
            // other resource.
            for (SpringM2mSupport.M2mNav nav : baseNavs) writeM2mHandler(w, base, nav, pkType);

            for (TphPlan.Subtype st : plan.subtypes()) {
                writeTphSubtypeHandlers(w, base, st, dtoName, repoName, allowlistName, pkType, api, hidden,
                    unionFields, writeDenied);
            }

            writeTphNotFound(w);
            writeParseSortHelper(w, repoName);
        }
        writeControllerFile(outRoot, pkg, controllerName, w, "TPH {file} for entity " + base.getName());
    }

    /** Polymorphic list — the union across all subtypes, each row tagged by its discriminator. */
    protected void writeTphListHandler(SpringJavaWriter w, String dtoName, String repoName, String allowlistName,
                                       ApiSettings api, List<String> hidden) {
        w.line("// Polymorphic list — the union across all subtypes, each row tagged by its discriminator.");
        w.line("@GetMapping");
        try (CodeWriter.Block m = openHandler(w, "list",
                List.of(PARAM_LIMIT, PARAM_OFFSET, PARAM_SORT, PARAM_WITH_COUNT, PARAM_REQUEST))) {
            writeTphListHead(w, repoName, allowlistName, api);
            w.line("List<FilterPredicate> filters = filter.predicates();");
            w.line("List<" + dtoName + "> rows = repository.list(actualLimit, actualOffset, sortClause, filters);");
            try (CodeWriter.Block b = w.block("if (withCount != null && withCount == 1) {")) {
                w.line("return ResponseEntity.ok(Map.of(\"rows\", " + redactAll("rows", hidden)
                    + ", \"total\", repository.count(filters)));");
            }
            w.line("return ResponseEntity.ok(" + redactAll("rows", hidden) + ");");
        }
        w.blank();
    }

    /** The paging, sort and filter parsing a TPH list handler (polymorphic or per subtype) opens with. */
    protected void writeTphListHead(SpringJavaWriter w, String repoName, String allowlistName, ApiSettings api) {
        writeLimit(w, api.pagination());
        w.line("int actualOffset = offset != null ? offset : 0;");
        w.line(repoName + ".SortClause sortClause = null;");
        try (CodeWriter.Block b = w.block("if (sort != null) {")) {
            w.text("""
                sortClause = parseSort(sort);
                if (sortClause == null) return ResponseEntity.badRequest().body(Map.of("error", "invalid_sort", "field", sort.split(":", 2)[0]));
                """);
        }
        w.line("FilterParseResult filter = FilterParser.parse(request.getQueryString(), "
            + filterAllowlistArgs(allowlistName) + ");");
        w.line("if (filter.error() != null) return ResponseEntity.badRequest().body(Map.of(\"error\", filter.error(), \"field\", filter.field()));");
    }

    /** Polymorphic get — one row of whatever subtype it is. */
    protected void writeTphGetHandler(SpringJavaWriter w, String pkType, List<String> hidden) {
        w.line("// Polymorphic get — one row of whatever subtype it is.");
        w.line("@GetMapping(\"/{id}\")");
        try (CodeWriter.Block m = w.block("public ResponseEntity<?> get(@PathVariable " + pkType + " id) {")) {
            w.line("return repository.findById(id)");
            w.continuation(".<ResponseEntity<?>>map(" + okMapper(hidden) + ")");
            w.continuation(".orElseGet(this::notFound);");
        }
        w.blank();
    }

    /** The per-subtype CRUD set and M:N traversal of one TPH subtype. */
    protected void writeTphSubtypeHandlers(SpringJavaWriter w, MetaObject base, TphPlan.Subtype st, String dtoName,
                                           String repoName, String allowlistName, String pkType, ApiSettings api,
                                           List<String> hidden, List<MetaField> unionFields, Set<String> writeDenied) {
        String seg = st.routeSegment();              // url segment (e.g. "bridge")
        String disc = st.value();                    // discriminator value (e.g. "Bridge")
        String suffix = SpringNaming.capitalize(disc); // method-name suffix (e.g. "Bridge")
        w.line("// --- subtype " + disc + " (segment /" + seg + ") ---");
        writeTphSubtypeList(w, seg, disc, suffix, repoName, allowlistName, api, hidden);
        writeTphSubtypeGet(w, seg, disc, suffix, pkType, hidden);
        writeTphSubtypeCreate(w, base, st, seg, disc, suffix, dtoName, api, hidden, unionFields, writeDenied);
        writeTphSubtypeUpdate(w, base, st, seg, disc, suffix, pkType, api, hidden);
        writeTphSubtypeDelete(w, seg, disc, suffix, pkType);
        // FR-018 x FR-017 — M:N traversal scoped to THIS subtype: every relationship it
        // resolves, inherited ones (e.g. a base-declared relationship) included.
        for (SpringM2mSupport.M2mNav nav : SpringM2mSupport.resolve(st.entity(), loader)) {
            writeTphSubtypeM2mHandler(w, st, seg, disc, nav, pkType);
        }
    }

    /** Per-subtype list, scoped by the discriminator. */
    protected void writeTphSubtypeList(SpringJavaWriter w, String seg, String disc, String suffix, String repoName,
                                       String allowlistName, ApiSettings api, List<String> hidden) {
        w.line("@GetMapping(\"/" + seg + "\")");
        try (CodeWriter.Block m = openHandler(w, "list" + suffix,
                List.of(PARAM_LIMIT, PARAM_OFFSET, PARAM_SORT, PARAM_REQUEST))) {
            writeTphListHead(w, repoName, allowlistName, api);
            w.line("return ResponseEntity.ok(" + redactAll(
                "repository.listByType(\"" + disc + "\", actualLimit, actualOffset, sortClause, filter.predicates())",
                hidden) + ");");
        }
        w.blank();
    }

    /** Per-subtype get (404 cross-subtype). */
    protected void writeTphSubtypeGet(SpringJavaWriter w, String seg, String disc, String suffix, String pkType,
                                      List<String> hidden) {
        w.line("@GetMapping(\"/" + seg + "/{id}\")");
        try (CodeWriter.Block m = w.block("public ResponseEntity<?> get" + suffix + "(@PathVariable " + pkType + " id) {")) {
            w.line("return repository.findByIdAndType(id, \"" + disc + "\")");
            w.continuation(".<ResponseEntity<?>>map(" + okMapper(hidden) + ")");
            w.continuation(".orElseGet(this::notFound);");
        }
        w.blank();
    }

    /**
     * Per-subtype create (discriminator injected from URL) — FR-036: validate each body
     * value against the subtype's ANNOTATED <Sub>Dto constraints BEFORE persisting, emitting
     * the cross-port {"error":"validation"} envelope on any violation (so an over-@maxLength
     * or missing-@required column is a 400, not a silent 201). The bound body stays the union
     * <Base>Dto (the shape repository.createWithType consumes), but the union is annotation-
     * free — so validation runs PER FIELD against the subtype DTO (the annotated shape), the
     * exact type the per-subtype PATCH validates against. The validated set is the sibling
     * <Sub>Patch's settable fields (effective scalars MINUS PK MINUS discriminator): the PK
     * is auto-generated and the discriminator is injected from the URL, so neither is checked.
     * validateValue applies @NotNull to a null value, so an absent @required column 400s too —
     * matching the vanilla create's whole-bean validate, scoped to this subtype.
     */
    protected void writeTphSubtypeCreate(SpringJavaWriter w, MetaObject base, TphPlan.Subtype st, String seg,
                                         String disc, String suffix, String dtoName, ApiSettings api,
                                         List<String> hidden, List<MetaField> unionFields, Set<String> writeDenied) {
        // FR-036 Program B: referenced by FQN so a subtype in another package still resolves
        // without an import.
        String[] stSplit = SpringNaming.splitFqn(st.entity().getName());
        String stPrefix = stSplit[0].isEmpty() ? "" : stSplit[0] + ".";
        String subDto = stPrefix + SpringNaming.dtoName(stSplit[1]);
        String discField = TphPlan.discriminatorFieldOf(st.entity());
        List<MetaField> createValidated = SpringGeneratorSupport.settableFields(st.entity(), discField);
        // The subtype's cross-field rules are class-level @AssertTrue methods on <Sub>Dto, which
        // the per-property validateValue below never reaches. They are evaluated here against the
        // bound union body instead, the discriminator read as this route's pinned value.
        List<Map.Entry<MetaValidator, String>> crossFieldRules = SpringGeneratorSupport.crossFieldRules(
            st.entity(), SpringGeneratorSupport.dtoComponentFields(st.entity()),
            f -> f.getName().equals(discField)
                ? "\"" + SpringGeneratorSupport.escapeJavaString(disc) + "\""
                : "dto." + SpringNaming.recordComponentName(f.getName()) + "()");
        if (!crossFieldRules.isEmpty()) w.line("@SuppressWarnings(\"unchecked\")");
        w.line("@PostMapping(\"/" + seg + "\")");
        // As the vanilla create — fill the subtype's omitted literal @default fields into
        // the raw body, then bind the union DTO. No such field: the direct binding, byte-identical.
        List<String> subDefaultPuts = createDefaultPuts(st.entity(), SpringGeneratorSupport.dtoComponentFields(st.entity()));
        boolean bindsRaw = !subDefaultPuts.isEmpty() || api.rejectsUnknownFields();
        String head = bindsRaw
            ? "public ResponseEntity<?> create" + suffix + "(@RequestBody JsonNode body) {"
            : "public ResponseEntity<?> create" + suffix + "(@RequestBody " + dtoName + " dto) {";
        try (CodeWriter.Block m = w.block(head)) {
            if (bindsRaw) writeFillDefaults(w, dtoName, subDefaultPuts, api.rejectsUnknownFields());
            w.line("ValidationIssues __issues = new ValidationIssues();");
            for (MetaField vf : createValidated) {
                // Both the property STRING and the accessor take the escaped component name:
                // Bean Validation resolves a record's property by its COMPONENT, and
                // `dto.notify()` would bind to Object.notify().
                String vc = SpringNaming.recordComponentName(vf.getName());
                w.line("__issues.addAt(validator.validateValue(" + subDto + ".class, \"" + vc + "\", dto." + vc
                    + "()), \"" + SpringGeneratorSupport.escapeJavaString(vf.getName()) + "\");");
            }
            for (Map.Entry<MetaValidator, String> rule : crossFieldRules) {
                try (CodeWriter.Block b = w.block("if (!(" + rule.getValue() + ")) {")) {
                    w.line("__issues.add(ValidationIssues.CUSTOM, java.util.List.of(), \"a cross-field rule failed\");");
                }
            }
            // #362: validateValue above checks each property against the subtype DTO's own
            // constraints and stops there — it does NOT cascade @Valid into a nested bean. A
            // field.map @objectRef IS in createValidated (scalarFields skips only ObjectField),
            // so before this loop its VALUES — which are the beans — were written unvalidated.
            // The vanilla create cascades via @Valid on the DTO component; this is the TPH
            // path's equivalent, so the two write surfaces agree.
            for (MetaField vf : SpringGeneratorSupport.valueObjectMapFields(st.entity())) {
                writeMapValueValidationLoop(
                    w, "dto." + SpringNaming.recordComponentName(vf.getName()) + "()", vf.getName());
            }
            writeIssuesVerdict(w);
            // ADR-0045 (#203/#229): honor @autoSet on the TPH per-subtype create — stamp EVERY
            // onCreate AND onUpdate column with now() before persisting (the caller's value is
            // ignored), mirroring the vanilla create handler. The stamp helper is the BASE union
            // <Base>Dto's static method (NOT a standalone <Sub>Dto's): dto above is declared as
            // that same union type (createWithType binds/returns it), so a subtype-typed
            // stampForInsert(SubDto) would not type-check against it.
            //
            // Gate on `base`, NOT `st.entity()`. The helper this emits (<Base>Dto.stampForInsert)
            // is only ever generated by SpringDtoGenerator.emitTphUnion when
            // SpringGeneratorSupport.hasAutoSetFields(base) is true (@autoSet columns live on the
            // base, shared by every subtype row in the single table) — gating on the subtype's own
            // resolving field set instead let a subtype-declared @autoSet column fire `true` here
            // while the helper it calls was never emitted, producing a non-compiling controller. A
            // TPH subtype declaring its OWN @autoSet column is a documented non-goal (uniform with
            // the Kotlin and Python ports, both base-scoped): the column is simply never stamped.
            // #484: ignore (never reject) a @formExclude / credential value in the body.
            // Also dropped: the generated key, readOnly/derived columns, the discriminator (the
            // route's subtype is its only source) and every column only a SIBLING subtype declares.
            writeStripWriteDenied(w, dtoName, unionFields,
                tphCreateDeniedNames(st.entity(), unionFields, writeDenied, discField));
            String createArg = SpringGeneratorSupport.hasAutoSetFields(base)
                ? dtoName + ".stampForInsert(dto)" : "dto";
            try (CodeWriter.Block t = w.block("try {", CATCH_RUNTIME)) {
                w.line(dtoName + " saved = repository.createWithType(\"" + disc + "\", " + createArg + ");");
                w.line("return ResponseEntity.status(HttpStatus.CREATED).body(" + redactOne("saved", hidden) + ");");
            }
            writeConstraintCatch(w);
        }
        w.blank();
    }

    /**
     * Per-subtype update — FR-036 Program B present-key PATCH tristate (mirrors the vanilla
     * update handler; 404 cross-subtype; id + discriminator immutable). Bind the RAW
     * JsonNode (NOT the union DTO, which conflates absent with null and would 400 an omitted
     * @required column), build the presence-tracked <Sub>Patch (an explicit null clears a
     * nullable column; an explicit null on a @required base column throws
     * PatchValidationException → 400), validate each PRESENT value against the subtype DTO's
     * constraints, then patch scoped to the discriminator.
     */
    protected void writeTphSubtypeUpdate(SpringJavaWriter w, MetaObject base, TphPlan.Subtype st, String seg,
                                         String disc, String suffix, String pkType, ApiSettings api,
                                         List<String> hidden) {
        String[] stSplit = SpringNaming.splitFqn(st.entity().getName());
        String stPrefix = stSplit[0].isEmpty() ? "" : stSplit[0] + ".";
        String subPatch = stPrefix + SpringNaming.patchName(stSplit[1]);
        String subDto = stPrefix + SpringNaming.dtoName(stSplit[1]);
        w.line("@RequestMapping(value = \"/" + seg + "/{id}\", method = { RequestMethod.PATCH, RequestMethod.PUT })");
        try (CodeWriter.Block m = w.block("public ResponseEntity<?> update" + suffix + "(@PathVariable " + pkType
                + " id, @RequestBody JsonNode body) {")) {
            writeUnknownFieldsGuard(w, api);
            writePatchBinding(w, subPatch, subDto);
            writeValueObjectMapValidation(w, st.entity());
            writePatchVerdict(w);
            // ADR-0045 (#203/#229): bump every onUpdate @autoSet column on the per-subtype PATCH,
            // mirroring the vanilla update handler — injected after present-value validation,
            // before delegating, so the timestamp bumps even when the caller omits it. onCreate
            // columns are never touched here (immutable on update). Gated on `base`, matching the
            // create-arg gate, for the same reason.
            if (SpringGeneratorSupport.hasOnUpdateFields(base)) {
                w.line("patch.stampAutoSetOnUpdate();");
            }
            try (CodeWriter.Block t = w.block("try {", CATCH_RUNTIME)) {
                w.line("return repository.patchByIdAndType(id, \"" + disc + "\", patch.assignedValues())");
                w.continuation(".<ResponseEntity<?>>map(" + okMapper(hidden) + ")");
                w.continuation(".orElseGet(this::notFound);");
            }
            writeConstraintCatch(w);
        }
        w.blank();
    }

    /** Per-subtype delete (404 cross-subtype). */
    protected void writeTphSubtypeDelete(SpringJavaWriter w, String seg, String disc, String suffix, String pkType) {
        w.line("@DeleteMapping(\"/" + seg + "/{id}\")");
        try (CodeWriter.Block m = w.block("public ResponseEntity<?> delete" + suffix + "(@PathVariable " + pkType + " id) {")) {
            try (CodeWriter.Block t = w.block("try {", CATCH_RUNTIME)) {
                w.line("if (repository.deleteByIdAndType(id, \"" + disc + "\")) return ResponseEntity.noContent().build();");
                w.line("return notFound();");
            }
            writeConstraintCatch(w);
        }
        w.blank();
    }

    /**
     * FR-018 x FR-017 — M:N traversal scoped to ONE subtype. The GENERATED controller enforces
     * the gate itself (never left to the repository implementation): it composes the SAME
     * repository.findByIdAndType(id, disc) lookup the per-subtype GET already relies on — a
     * sibling subtype's id returns Optional.empty() there (the tph-cross-subtype-404 contract) —
     * and short-circuits to an EMPTY list, HTTP 200, before ever calling the traversal finder.
     * This costs one redundant primary-key lookup and adds no new persistence assumption: it
     * reuses a seam the consumer must already implement correctly for the per-subtype GET to
     * pass conformance. Without it, a copy-paste finder body (e.g. findTagsForBridge
     * implemented identically to findTags) compiles, type-checks, and silently 200s a
     * sibling's rows — nothing else in the pipeline catches that.
     */
    protected void writeTphSubtypeM2mHandler(SpringJavaWriter w, TphPlan.Subtype st, String seg, String disc,
                                             SpringM2mSupport.M2mNav nav, String pkType) {
        String subFinder = SpringGeneratorSupport.m2mFinderNameForSubtype(nav.relationName(), disc);
        List<String> targetHidden = targetCredentials(st.entity(), nav);
        w.line("@GetMapping(\"/" + seg + "/{id}/" + nav.relationName() + "\")");
        String rowType = targetHidden.isEmpty() ? nav.targetDtoType() : "Object";
        try (CodeWriter.Block m = w.block("public ResponseEntity<List<" + rowType + ">> " + subFinder
                + "(@PathVariable " + pkType + " id) {")) {
            try (CodeWriter.Block b = w.block("if (repository.findByIdAndType(id, \"" + disc + "\").isEmpty()) {")) {
                w.line("return ResponseEntity.ok(List.of());");
            }
            w.line("return ResponseEntity.ok(" + redactAll(
                "repository." + subFinder + "(id" + SpringGeneratorSupport.targetSubtypeCallArg(nav) + ")",
                targetHidden) + ");");
        }
        w.blank();
    }

    /** The {@code notFound()} helper the TPH handlers answer a miss through. */
    protected void writeTphNotFound(SpringJavaWriter w) {
        try (CodeWriter.Block m = w.block("private ResponseEntity<?> notFound() {")) {
            w.line("return " + NOT_FOUND_RESPONSE + ";");
        }
        w.blank();
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
     * Write the per-entity {@code SORT_DEFAULT_ORDER} constant the generated {@code parseSort}
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
     * <p>Written as {@code Map.ofEntries(Map.entry(..), ..)}, deliberately NOT {@code Map.of(..)}.
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
    protected void writeSortDefaultOrders(SpringJavaWriter w, MetaObject owner, List<String> sortFields) {
        // Walk the owner's OWN field list and keep the sortable ones, rather than looking each
        // allowlist name back up. `MetaObject.getMetaField(name)` does not return null for an
        // absent name — it THROWS MetaDataNotFoundException — so a name-keyed lookup turns any
        // future divergence between the allowlist and this map into an aborted build instead of
        // a skipped entry. Today both are sourced from this same owner, so nothing diverges;
        // this keeps that from being load-bearing. Mirrors the Kotlin sibling's `firstOrNull`.
        java.util.Set<String> sortable = new java.util.LinkedHashSet<>(sortFields);
        List<String> entries = new ArrayList<>();
        for (MetaField f : owner.getMetaFields()) {
            String name = f.getName();
            if (!sortable.contains(name)) continue;
            if (!f.hasMetaAttr(MetaField.ATTR_SORTABLE_DEFAULT_ORDER)) continue;
            String v = f.getMetaAttr(MetaField.ATTR_SORTABLE_DEFAULT_ORDER).getValueAsString();
            if (!"asc".equals(v) && !"desc".equals(v)) continue;
            entries.add("Map.entry(\"" + name + "\", \"" + v + "\")");
        }
        w.line("private static final Map<String, String> SORT_DEFAULT_ORDER = Map.ofEntries("
            + String.join(", ", entries) + ");");
        w.blank();
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
    protected static List<String> serverOwnedOnCreate(MetaObject entity) {
        List<String> pkFields = entity.getIdentities(true).stream()
            .filter(com.metaobjects.identity.MetaIdentity::isPrimary)
            .findFirst()
            .map(com.metaobjects.identity.MetaIdentity::getFields)
            .orElse(List.of());

        java.util.Set<String> denied = SpringGeneratorSupport.hierarchyWriteDeniedNames(entity);
        List<String> out = new ArrayList<>();
        // Every DTO component, not only scalars: the create strip (createDeniedNames) nulls a
        // readOnly / derived value-object jsonb component too, so its @NotNull must be ignored here.
        for (MetaField f : SpringGeneratorSupport.dtoComponentFields(entity)) {
            // #484: a write-denied field is IGNORED on create, so a @NotNull on it describes the
            // response shape and must not reject a body that (necessarily) omits it.
            if (pkFields.contains(f.getName()) || AutoSetSupport.isAutoSet(f)
                    || denied.contains(f.getName()) || isNonSettableOnCreate(f)) {
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
     *
     * <p>The caller opens its {@code try} with {@link #CATCH_RUNTIME} as the block's closing
     * line, so this writes the body of that {@code catch}.</p>
     */
    protected void writeConstraintCatch(SpringJavaWriter w) {
        try (CodeWriter.Block c = w.bodyBlock()) {
            w.text("""
                ConstraintErrors.Failure failure = ConstraintErrors.classify(e);
                if (failure == null) throw e;
                return ResponseEntity.status(failure.status())
                        .body(Map.of("error", failure.error(), "constraint", failure.constraint()));
                """);
        }
    }

    /** The credential wire names of the TARGET of {@code source}'s M:N relationship {@code nav} (#484). */
    protected static List<String> targetCredentials(MetaObject source, SpringM2mSupport.M2mNav nav) {
        for (com.metaobjects.relationship.MetaRelationship rel : source.getRelationships()) {
            if (!nav.relationName().equals(rel.getShortName())) continue;
            MetaObject target = com.metaobjects.loader.References.refTarget(
                rel, com.metaobjects.relationship.MetaRelationship.ATTR_OBJECT_REF);
            if (target == null) return List.of();
            // A TPH base target's rows are shared-table rows of every subtype, so a credential
            // declared on any subtype is hidden too.
            List<MetaField> fields = new ArrayList<>(SpringGeneratorSupport.dtoComponentFields(target));
            fields.addAll(TphPlan.everySubtypeField(target, source.getLoader()));
            return SpringGeneratorSupport.credentialNames(fields);
        }
        return List.of();
    }

    /**
     * One {@code filled.put(...)} statement per DTO component with a literal {@code @default}
     * this can spell (an enum member, a boolean, a number, a string), guarded by its absence from
     * the body. A SQL-expression default is the database's, an array or a temporal default has no
     * literal here, and a server-owned or {@code @autoSet} column is never the caller's to send.
     */
    protected static List<String> createDefaultPuts(MetaObject entity, List<MetaField> components) {
        List<String> out = new ArrayList<>();
        List<String> serverOwned = serverOwnedOnCreate(entity);
        for (MetaField f : components) {
            if (f.isArrayType() || serverOwned.contains(f.getName()) || AutoSetSupport.isAutoSet(f)) continue;
            if (f.isDerived()) continue;
            // ADR-0039: resolving — @default may be inherited via extends.
            if (!f.hasMetaAttr(MetaField.ATTR_DEFAULT)) continue;
            Object raw = f.getMetaAttr(MetaField.ATTR_DEFAULT).getValue();
            if (raw == null) continue;
            String text = raw.toString();
            String value = switch (f.getSubType()) {
                case com.metaobjects.field.EnumField.SUBTYPE_ENUM -> {
                    Object values = f.hasMetaAttr(com.metaobjects.field.EnumField.ATTR_VALUES)
                        ? f.getMetaAttr(com.metaobjects.field.EnumField.ATTR_VALUES).getValue() : null;
                    yield values instanceof List<?> l && l.stream().anyMatch(v -> text.equals(String.valueOf(v))) ? javaLiteral(text) : null;
                }
                case com.metaobjects.field.BooleanField.SUBTYPE_BOOLEAN ->
                    "true".equalsIgnoreCase(text) || "false".equalsIgnoreCase(text) ? text.toLowerCase() : null;
                case com.metaobjects.field.IntegerField.SUBTYPE_INT, com.metaobjects.field.LongField.SUBTYPE_LONG ->
                    text.matches("-?\\d+") ? text + "L" : null;
                case com.metaobjects.field.DoubleField.SUBTYPE_DOUBLE, com.metaobjects.field.FloatField.SUBTYPE_FLOAT ->
                    text.matches("-?\\d+(\\.\\d+)?([eE][-+]?\\d+)?") ? text + "d" : null;
                case com.metaobjects.field.DecimalField.SUBTYPE_DECIMAL ->
                    text.matches("-?\\d+(\\.\\d+)?") ? "new java.math.BigDecimal(\"" + text + "\")" : null;
                // A database expression (now(), gen_random_uuid()) is the database's to fill.
                case com.metaobjects.field.StringField.SUBTYPE_STRING ->
                    com.metaobjects.generator.util.GeneratorUtil.isSqlExpressionDefault(text) ? null : javaLiteral(text);
                default -> null;
            };
            if (value == null) continue;
            String key = javaLiteral(f.getName());
            out.add("if (!filled.has(" + key + ")) filled.put(" + key + ", " + value + ");");
        }
        return out;
    }

    protected static String javaLiteral(String text) {
        return "\"" + SpringGeneratorSupport.escapeJavaString(text) + "\"";
    }

    /** The body of a create handler bound to the raw {@code JsonNode body}: refuse a
     *  non-object body, fill the absent defaulted fields ({@link #createDefaultPuts}), bind
     *  {@code dto}. */
    protected void writeFillDefaults(SpringJavaWriter w, String dtoName, List<String> puts, boolean rejectUnknown) {
        w.text("""
            if (!(body instanceof com.fasterxml.jackson.databind.node.ObjectNode given)) {
                return ResponseEntity.badRequest().body(new ValidationIssues()
                        .add(ValidationIssues.INVALID_TYPE, java.util.List.of(), "request body must be a JSON object").body());
            }
            """);
        if (rejectUnknown) writeUnknownFieldsGuard(w, true);
        w.line("com.fasterxml.jackson.databind.node.ObjectNode filled = given.deepCopy();");
        for (String put : puts) w.line(put);
        w.line(dtoName + " dto;");
        try (CodeWriter.Block t = w.block("try {",
                "} catch (com.fasterxml.jackson.core.JsonProcessingException | IllegalArgumentException e) {")) {
            w.line("dto = objectMapper.treeToValue(filled, " + dtoName + ".class);");
        }
        try (CodeWriter.Block c = w.bodyBlock()) {
            w.line("return ResponseEntity.badRequest().body(UnreadableBody.envelope(e));");
        }
    }

    /**
     * The {@code KNOWN_FIELDS} constant of a controller that refuses undeclared body keys
     * ({@code api.unknownFields: reject}, the default): every declared field name of
     * {@code declared} (the entity, or for a single-table hierarchy the base and every subtype).
     * A declared key the client may not set (generated key, readOnly, derived, {@code @autoSet},
     * a sibling subtype's column) is known: it is dropped, never refused. Writes nothing under
     * {@code drop}, which keeps the controller byte-identical to one without the setting.
     */
    protected void writeKnownFields(SpringJavaWriter w, ApiSettings api, List<MetaField> declared) {
        if (!api.rejectsUnknownFields()) return;
        Set<String> names = new java.util.LinkedHashSet<>();
        for (MetaField f : declared) names.add(f.getName());
        w.doc("Every field the entity declares, as named on the wire: a body key outside it is refused.");
        w.line("private static final Set<String> KNOWN_FIELDS = Set.of(" + quotedList(names) + ");");
        w.blank();
    }

    /** The unknown-key check at the head of a PUT/PATCH handler (see {@link #writeUnknownFieldsGuard(SpringJavaWriter, boolean)}). */
    protected void writeUnknownFieldsGuard(SpringJavaWriter w, ApiSettings api) {
        if (api.rejectsUnknownFields()) writeUnknownFieldsGuard(w, true);
    }

    /** Answer {@code 400 unknown_fields} for an undeclared top-level key of {@code body}, checked on the raw JSON before any binding. */
    protected void writeUnknownFieldsGuard(SpringJavaWriter w, boolean enabled) {
        if (!enabled) return;
        w.text("""
            Map<String, Object> __unknown = UnknownBodyKeys.refusal(body, KNOWN_FIELDS);
            if (__unknown != null) {
                return ResponseEntity.badRequest().body(__unknown);
            }
            """);
    }

    /**
     * The {@code actualLimit} line of a list handler: no {@code limit} reads the page default
     * (50 unless the project sets {@code api.pagination}), and a {@code limit} above
     * {@code api.pagination.maxLimit} is {@code 400 {"error": "limit_too_large", "maxLimit": N}}.
     * Under {@code api.pagination} a negative {@code limit} is refused with the malformed-bound
     * envelope, as the TypeScript routes refuse it, so it never reaches a store that reads
     * {@code LIMIT -1} as no limit (SQLite) and steps around the cap.
     */
    protected void writeLimit(SpringJavaWriter w, ApiSettings.Pagination page) {
        if (page == null) {
            w.line("int actualLimit = limit != null ? limit : 50;");
            return;
        }
        try (CodeWriter.Block b = w.block("if (limit != null && limit < 0) {")) {
            w.line("return ResponseEntity.badRequest().body(Map.of(\"error\", \"pagination.invalid_value\", \"param\", \"limit\", "
                + "\"value\", String.valueOf(limit), \"expected\", \"a non-negative integer (0 or more)\"));");
        }
        try (CodeWriter.Block b = w.block("if (limit != null && limit > " + page.maxLimit() + ") {")) {
            w.line("return ResponseEntity.badRequest().body(Map.of(\"error\", \"limit_too_large\", \"maxLimit\", "
                + page.maxLimit() + "));");
        }
        w.line("int actualLimit = limit != null ? limit : " + page.defaultLimit() + ";");
    }

    /** A field no client may set on create regardless of the entity's key: readOnly or derived. */
    protected static boolean isNonSettableOnCreate(MetaField f) {
        return MetaField.MUTABILITY_READ_ONLY.equals(f.getMutability()) || f.isDerived();
    }

    /** The names of {@code fields} that are a server-generated primary key of {@code entity}. */
    protected static Set<String> generatedPkNames(MetaObject entity) {
        com.metaobjects.identity.PrimaryIdentity pk = entity.getPrimaryIdentity();
        if (pk == null || !pk.isAutoGenerated()) return Set.of();
        return new java.util.LinkedHashSet<>(pk.getFields());
    }

    /**
     * The components a plain create handler drops from the bound body before it reaches the
     * repository: write-denied ({@code @formExclude} / credential), a generated primary key (an
     * assigned key is the caller's), {@code readOnly} and derived fields.
     */
    protected static Set<String> createDeniedNames(MetaObject entity, List<MetaField> components) {
        Set<String> out = new java.util.LinkedHashSet<>(SpringGeneratorSupport.writeDeniedNames(components));
        Set<String> pk = generatedPkNames(entity);
        for (MetaField f : components) {
            if (pk.contains(f.getName()) || isNonSettableOnCreate(f)) out.add(f.getName());
        }
        return out;
    }

    /**
     * The union-DTO components a TPH per-subtype create drops: everything in
     * {@link #createDeniedNames}, the discriminator, and every column the route's subtype does not
     * itself declare (a sibling subtype's, never this route's to write).
     */
    protected static Set<String> tphCreateDeniedNames(MetaObject subtype, List<MetaField> union,
                                                      Set<String> writeDenied, String discField) {
        Set<String> out = new java.util.LinkedHashSet<>(writeDenied);
        Set<String> pk = generatedPkNames(subtype);
        java.util.Map<String, MetaField> own = new java.util.HashMap<>();
        for (MetaField f : SpringGeneratorSupport.scalarFields(subtype)) own.put(f.getName(), f);
        for (MetaField u : union) {
            MetaField f = own.get(u.getName());
            if (f == null || pk.contains(u.getName()) || u.getName().equals(discField) || isNonSettableOnCreate(f)) {
                out.add(u.getName());
            }
        }
        return out;
    }

    /** Rebuild {@code dto} with every write-denied component nulled; nothing when none is denied. */
    protected void writeStripWriteDenied(SpringJavaWriter w, String dtoName, List<MetaField> components,
                                         Set<String> writeDenied) {
        if (components.stream().noneMatch(f -> writeDenied.contains(f.getName()))) return;
        List<String> args = new ArrayList<>(components.size());
        for (MetaField f : components) {
            args.add(writeDenied.contains(f.getName())
                ? "null" : "dto." + SpringNaming.recordComponentName(f.getName()) + "()");
        }
        w.line("dto = new " + dtoName + "(" + String.join(", ", args) + ");");
    }

    /** Java source for a {@code String...} argument list naming {@code hidden}. */
    protected static String hiddenArgs(List<String> hidden) {
        StringBuilder b = new StringBuilder();
        // The record component's name, which is the member Jackson's contract knows it by.
        for (String h : hidden) b.append(", \"").append(SpringNaming.recordComponentName(h)).append('"');
        return b.toString();
    }

    /** Expression for one response row with {@code hidden} removed (the row itself when none). */
    protected static String redactOne(String expr, List<String> hidden) {
        return hidden.isEmpty() ? expr : "redact(" + expr + hiddenArgs(hidden) + ")";
    }

    /** Expression for a list of response rows with {@code hidden} removed from each. */
    protected static String redactAll(String expr, List<String> hidden) {
        return hidden.isEmpty() ? expr : "redactAll(" + expr + hiddenArgs(hidden) + ")";
    }

    /** The {@code Optional.map} argument that answers 200 with a row, minus {@code hidden}. */
    protected static String okMapper(List<String> hidden) {
        return hidden.isEmpty() ? "ResponseEntity::ok" : "r -> ResponseEntity.ok(" + redactOne("r", hidden) + ")";
    }

    /**
     * #484 — the helpers a controller uses to leave credential fields out of response bodies. The
     * shared DTO keeps the member (the application's own code reads and writes it); only the
     * generated HTTP boundary drops the key, so a credential is ABSENT, not null.
     *
     * <p>The DTO carries no wire annotation for the credential, so its key is whatever the host's
     * {@code ObjectMapper} makes of the member: a property naming strategy ({@code SNAKE_CASE} writes
     * {@code pinHash} as {@code pin_hash}), a mixin, a {@code @JsonProperty}. The key is therefore
     * READ from that mapper's own serialization contract, never re-derived from the field name, and
     * cached per row class. When the contract cannot be read (a custom serializer, a credential the
     * class declares but the contract has no property for) the response is refused (500), never
     * sent unstripped. As a second line of defence any key that spells a credential ignoring case,
     * {@code _} and {@code -} is removed too.
     */
    protected void writeRedactHelpers(SpringJavaWriter w) {
        w.text("""
            /** #484: the wire keys of each row class's credentials, read once from objectMapper's contract. */
            private final java.util.Map<List<Object>, java.util.Set<String>> credentialWireKeys = new java.util.concurrent.ConcurrentHashMap<>();

            private Object redact(Object row, String... hidden) {
                com.fasterxml.jackson.databind.node.ObjectNode node = objectMapper.valueToTree(row);
                node.remove(credentialWireKeys.computeIfAbsent(
                        List.of(row.getClass(), List.of(hidden)), k -> credentialKeysOf(row.getClass(), hidden)));
                java.util.Set<String> spelled = new java.util.HashSet<>();
                for (String h : hidden) spelled.add(normalizedKey(h));
                List<String> stray = new java.util.ArrayList<>();
                node.fieldNames().forEachRemaining(k -> { if (spelled.contains(normalizedKey(k))) stray.add(k); });
                node.remove(stray);
                return node;
            }

            private List<Object> redactAll(List<?> rows, String... hidden) {
                List<Object> out = new java.util.ArrayList<>(rows.size());
                for (Object row : rows) out.add(redact(row, hidden));
                return out;
            }

            /**
             * The JSON keys objectMapper writes the credential members {@code hidden} of {@code type} under,
             * read from its serialization contract so a naming strategy, mixin or @JsonProperty is honoured.
             * Throws (the response is refused, never sent unstripped) when the contract cannot be read.
             */
            private java.util.Set<String> credentialKeysOf(Class<?> type, String... hidden) {
                com.fasterxml.jackson.databind.SerializationConfig config = objectMapper.getSerializationConfig();
                com.fasterxml.jackson.databind.BeanDescription desc = config.introspect(objectMapper.constructType(type));
                try {
                    if (!(objectMapper.getSerializerProviderInstance().findValueSerializer(type)
                            instanceof com.fasterxml.jackson.databind.ser.std.BeanSerializerBase)) {
                        throw unstrippable(type, hidden, "its serializer is not a bean serializer (a custom serializer?)");
                    }
                } catch (com.fasterxml.jackson.databind.JsonMappingException e) {
                    throw unstrippable(type, hidden, "the mapper has no serializer for it");
                }
                java.util.Set<String> keys = new java.util.HashSet<>();
                for (String name : hidden) {
                    boolean matched = false;
                    for (com.fasterxml.jackson.databind.introspect.BeanPropertyDefinition p : desc.findProperties()) {
                        if (p.getInternalName().equals(name)) { keys.add(p.getName()); matched = true; }
                    }
                    if (!matched && declaresMember(type, name) && !desc.getIgnoredPropertyNames().contains(name)) {
                        throw unstrippable(type, new String[] {name}, "the credential has no property in the mapper's contract");
                    }
                }
                return keys;
            }

            private static boolean declaresMember(Class<?> type, String name) {
                for (Class<?> c = type; c != null && c != Object.class; c = c.getSuperclass()) {
                    for (java.lang.reflect.Field f : c.getDeclaredFields()) if (f.getName().equals(name)) return true;
                }
                return false;
            }

            private static String normalizedKey(String key) {
                return key.replace("_", "").replace("-", "").toLowerCase(java.util.Locale.ROOT);
            }

            private static IllegalStateException unstrippable(Class<?> type, String[] credentials, String why) {
                return new IllegalStateException("cannot strip the credential " + type.getSimpleName() + "."
                        + String.join(", " + type.getSimpleName() + ".", credentials) + " from a response: " + why
                        + ". Credential stripping reads the ObjectMapper's serialization contract; the response is"
                        + " refused rather than sent unstripped.");
            }
            """);
        w.blank();
    }

    /** The {@code SERVER_OWNED_ON_CREATE} constant; nothing, and the create handler keeps its old shape, when none. */
    protected void writeServerOwnedOnCreate(SpringJavaWriter w, MetaObject entity) {
        List<String> serverOwned = serverOwnedOnCreate(entity);
        if (serverOwned.isEmpty()) return;
        w.text("""
            /** Components the server owns on create (primary key, @autoSet): a
             *  @NotNull on one of these describes the RESPONSE shape and must not
             *  reject a create body that legitimately omits it. */
            """);
        List<String> quoted = new ArrayList<>(serverOwned.size());
        for (String s : serverOwned) quoted.add('"' + s + '"');
        w.line("private static final Set<String> SERVER_OWNED_ON_CREATE = Set.of(" + String.join(", ", quoted) + ");");
        w.blank();
    }
}
