package com.metaobjects.generator.spring;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Pattern;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Tests for {@link SpringControllerGenerator}. Covers the cross-port API
 * contract: URL grammar, 5 verbs, {@code withCount=1} envelope, per-entity
 * sort allowlist, and the view-kind skip rule. String-search assertions
 * match the style of {@code KotlinSpringControllerGeneratorTest}.
 */
public class SpringControllerGeneratorTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private static final String AUTHOR_FIXTURE = """
        {
          "metadata.root": { "package": "acme::blog", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long":      { "name": "id" } },
                { "field.string":    { "name": "name", "@maxLength": 100, "@required": true } },
                { "field.string":    { "name": "bio" } },
                { "field.timestamp": { "name": "createdAt" } },
                { "source.rdb":      { "@table": "authors" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }
        """;

    private static final String VIEW_FIXTURE = """
        {
          "metadata.root": { "package": "acme::report", "children": [
            { "object.projection": { "name": "SalesReport", "children": [
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "regionName", "@maxLength": 100 } },
                { "field.long":   { "name": "totalCents" } },
                { "source.rdb":   { "@table": "v_sales_report", "@kind": "view" } }
            ] } }
          ] }
        }
        """;

    @Test
    public void emitsRestControllerWithAllFiveVerbs() throws Exception {
        Path outDir = tempFolder.newFolder("ctrl-five").toPath();
        Path workspace = tempFolder.newFolder("ctrl-five-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "author-five", AUTHOR_FIXTURE);

        SpringControllerGenerator gen = new SpringControllerGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path controller = outDir.resolve("acme/blog/AuthorController.java");
        assertTrue("expected " + controller, Files.exists(controller));
        String src = Files.readString(controller);

        // @RestController + @RequestMapping at the class level.
        assertTrue("expected @RestController; saw:\n" + src, src.contains("@RestController"));
        // Bare @GetMapping (list) — verb without a path.
        assertTrue("expected bare @GetMapping list handler; saw:\n" + src,
            Pattern.compile("@GetMapping\\s*\\n\\s*public ResponseEntity<\\?> list").matcher(src).find());
        // @GetMapping("/{id}") — get by id.
        assertTrue("expected @GetMapping(\"/{id}\"); saw:\n" + src,
            src.contains("@GetMapping(\"/{id}\")"));
        // @PostMapping — create. FR-036: no @Valid (its default 400 body is not the cross-port
        // envelope); the handler binds the raw DTO and validates it explicitly with the injected
        // Validator, returning {"error":"validation"} on any field-constraint violation.
        assertTrue("expected @PostMapping create handler; saw:\n" + src,
            Pattern.compile("@PostMapping\\s*\\n\\s*public ResponseEntity<\\?> create\\(@RequestBody AuthorDto dto\\)").matcher(src).find());
        assertTrue("expected explicit validator.validate(dto) on create (FR-036); saw:\n" + src,
            src.contains("validator.validate(dto)"));
        // PATCH AND PUT share the update handler (per API contract) — expressed as a single
        // @RequestMapping with method={PATCH, PUT}. Stacking @PatchMapping + @PutMapping on
        // one method only registers one verb in Spring MVC (the other 405s).
        assertTrue("expected @RequestMapping(value = \"/{id}\", method = { RequestMethod.PATCH, RequestMethod.PUT }); saw:\n" + src,
            src.contains("@RequestMapping(value = \"/{id}\", method = { RequestMethod.PATCH, RequestMethod.PUT })"));
        // @DeleteMapping("/{id}") — delete.
        assertTrue("expected @DeleteMapping(\"/{id}\"); saw:\n" + src,
            src.contains("@DeleteMapping(\"/{id}\")"));
    }

    @Test
    public void pathHonorsApiPrefixAndEntityPlural() throws Exception {
        Path outDir = tempFolder.newFolder("ctrl-path").toPath();
        Path workspace = tempFolder.newFolder("ctrl-path-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "author-path", AUTHOR_FIXTURE);

        SpringControllerGenerator gen = new SpringControllerGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        String src = Files.readString(outDir.resolve("acme/blog/AuthorController.java"));
        // /api/<entity-plural-lowercase> per the cross-port contract; Author → authors.
        assertTrue("expected @RequestMapping(\"/api/authors\"); saw:\n" + src,
            src.contains("@RequestMapping(\"/api/authors\")"));
    }

    @Test
    public void withCountReturnsEnvelopeAndBareRowsBothEmitted() throws Exception {
        Path outDir = tempFolder.newFolder("ctrl-wc").toPath();
        Path workspace = tempFolder.newFolder("ctrl-wc-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "author-wc", AUTHOR_FIXTURE);

        SpringControllerGenerator gen = new SpringControllerGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        String src = Files.readString(outDir.resolve("acme/blog/AuthorController.java"));
        // Both the envelope path AND the bare-rows path must be emitted.
        assertTrue("expected {rows,total} envelope on withCount=1; saw:\n" + src,
            src.contains("Map.of(\"rows\", rows, \"total\", total)"));
        // Bare rows path: `ResponseEntity.ok(rows)` (no envelope).
        assertTrue("expected bare-rows OK response on default list; saw:\n" + src,
            src.contains("return ResponseEntity.ok(rows);"));
        // The withCount parameter itself is declared on the list handler.
        assertTrue("expected withCount @RequestParam; saw:\n" + src,
            src.contains("name = \"withCount\""));
    }

    @Test
    public void sortAllowlistEmittedPerEntity() throws Exception {
        Path outDir = tempFolder.newFolder("ctrl-sort").toPath();
        Path workspace = tempFolder.newFolder("ctrl-sort-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "author-sort", AUTHOR_FIXTURE);

        SpringControllerGenerator gen = new SpringControllerGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        String src = Files.readString(outDir.resolve("acme/blog/AuthorController.java"));
        // Static private allowlist as Set.of(...) — keeps the allowlist a compile-time
        // constant so an unknown sort field can never reach the repository.
        assertTrue("expected private static SORT_ALLOWLIST; saw:\n" + src,
            src.contains("private static final Set<String> SORT_ALLOWLIST = Set.of("));
        // All four scalar fields in the Author fixture appear in the allowlist.
        assertTrue("expected all four scalar fields in the sort allowlist; saw:\n" + src,
            src.contains("\"id\"") && src.contains("\"name\"")
                && src.contains("\"bio\"") && src.contains("\"createdAt\""));
        // The 400 envelope for invalid sort is `{ "error": "invalid_sort", "field": <name> }` —
        // `field` names the rejected sort field, required on every cross-port filter/sort
        // envelope (docs/features/api-contract.md, "Error response").
        assertTrue("expected invalid_sort 400 envelope naming the field; saw:\n" + src,
            src.contains("Map.of(\"error\", \"invalid_sort\", \"field\", sort.split(\":\", 2)[0])"));
    }

    @Test
    public void listHandlerWiresFilterParserAndPredicates() throws Exception {
        // FR-009: the generated list() must take HttpServletRequest (for the raw
        // query string), call FilterParser.parse against the per-entity allowlist,
        // 400 on parse error, and pass the List<FilterPredicate> down to the
        // repository (both list + count paths).
        Path outDir = tempFolder.newFolder("ctrl-filter").toPath();
        Path workspace = tempFolder.newFolder("ctrl-filter-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "author-filter", AUTHOR_FIXTURE);

        SpringControllerGenerator gen = new SpringControllerGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        String src = Files.readString(outDir.resolve("acme/blog/AuthorController.java"));

        // HttpServletRequest is the load-bearing arg: Spring's @RequestParam
        // collapses repeated keys so we MUST go through the raw query string.
        assertTrue("expected HttpServletRequest arg on list(); saw:\n" + src,
            src.contains("HttpServletRequest request"));
        // FilterParser must be called with the entity's allowlist.
        assertTrue("expected FilterParser.parse(...) call against AuthorFilterAllowlist; saw:\n" + src,
            src.contains("FilterParser.parse(")
                && src.contains("AuthorFilterAllowlist.FIELDS")
                && src.contains("AuthorFilterAllowlist.OPS_BY_FIELD"));
        // 400 envelope on parse failure mirrors the cross-port shape — including
        // `field`, which every filter envelope carries so a caller sending several
        // filters knows which one was rejected.
        assertTrue("expected invalid_filter_* 400 envelope on parse failure; saw:\n" + src,
            src.contains("Map.of(\"error\", filter.error(), \"field\", filter.field())"));
        // Predicates must flow into BOTH list + count repository calls (the count
        // path is what powers ?withCount=1; same filter must apply to both).
        assertTrue("expected predicates passed into repository.list; saw:\n" + src,
            src.contains("repository.list(actualLimit, actualOffset, sortClause, filters)"));
        assertTrue("expected predicates passed into repository.count; saw:\n" + src,
            src.contains("repository.count(filters)"));
    }

    @Test
    public void filterAllowlistEmittedAlongsideController() throws Exception {
        // The codegen contract: when SpringFilterAllowlistGenerator runs against
        // the same entity, it emits <Entity>FilterAllowlist.java with FIELDS +
        // OPS_BY_FIELD constants the controller can refer to.
        Path outDir = tempFolder.newFolder("ctrl-allowlist").toPath();
        Path workspace = tempFolder.newFolder("ctrl-allowlist-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "author-allowlist", AUTHOR_FIXTURE);

        SpringFilterAllowlistGenerator gen = new SpringFilterAllowlistGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path allowlist = outDir.resolve("acme/blog/AuthorFilterAllowlist.java");
        assertTrue("expected " + allowlist + " emitted alongside the controller",
            Files.exists(allowlist));
        String src = Files.readString(allowlist);
        // Author has no @filterable fields in the controller-test fixture (we share
        // the same fixture across tests), so the allowlist is empty — but the
        // file MUST still be present for the controller to reference.
        assertTrue("expected FIELDS Set in allowlist file; saw:\n" + src,
            src.contains("public static final Set<String> FIELDS"));
        assertTrue("expected OPS_BY_FIELD Map in allowlist file; saw:\n" + src,
            src.contains("public static final Map<String, Set<String>> OPS_BY_FIELD"));
    }

    @Test
    public void viewKindEntitiesAreSkipped() throws Exception {
        // SalesReport has @kind="view" — must NOT produce a controller (read-only).
        Path outDir = tempFolder.newFolder("ctrl-view").toPath();
        Path workspace = tempFolder.newFolder("ctrl-view-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "view-skip", VIEW_FIXTURE);

        SpringControllerGenerator gen = new SpringControllerGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path controller = outDir.resolve("acme/report/SalesReportController.java");
        assertFalse("view-kind entities must NOT produce a controller; saw " + controller + " present",
            Files.exists(controller));
    }

    /**
     * The shape every real adopter has and no other fixture in this file had: a primary key
     * that is {@code @required} AND server-generated. {@code AUTHOR_FIXTURE}'s {@code id}
     * carries no {@code @required}, so the DTO never put {@code @NotNull} on it and the create
     * handler's over-broad validation could not be observed — which is exactly why FINDINGS F25
     * shipped and why this fixture exists rather than a tweak to that one.
     */
    private static final String REQUIRED_PK_FIXTURE = """
        {
          "metadata.root": { "package": "acme::ship", "children": [
            { "object.entity": { "name": "Parcel", "children": [
                { "field.uuid":      { "name": "id", "@required": true } },
                { "field.string":    { "name": "code", "@maxLength": 24, "@required": true } },
                { "field.timestamp": { "name": "createdAt", "@required": true } },
                { "source.rdb":      { "@table": "parcel" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "uuid" } }
            ] } }
          ] }
        }
        """;

    /**
     * A POST must not be rejected for omitting a column the SERVER owns.
     *
     * <p>The DTO is both the request and the response body, so a {@code @required} primary key
     * earns {@code @NotNull} — a true statement about the response, and a false one about the
     * request, because {@code @generation: uuid} means the caller must NOT invent the key.
     * Validating the whole DTO therefore turned every create into a 400, and the only workaround
     * was a client-supplied primary key, which defeats the declared strategy (FINDINGS F25).</p>
     *
     * <p>The TPH create path already applied this rule via
     * {@code SpringDtoGenerator.settableFields}; this pins the vanilla path to the same answer.</p>
     */
    @Test
    public void createDoesNotValidateServerOwnedColumnsOutOfTheBody() throws Exception {
        Path outDir = tempFolder.newFolder("ctrl-pk").toPath();
        Path workspace = tempFolder.newFolder("ctrl-pk-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "parcel-pk", REQUIRED_PK_FIXTURE);

        SpringControllerGenerator gen = new SpringControllerGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        String src = Files.readString(outDir.resolve("acme/ship/ParcelController.java"));

        assertTrue("the server-owned set must name the generated primary key; saw:\n" + src,
            src.contains("SERVER_OWNED_ON_CREATE = Set.of(\"id\")"));

        // The create handler must FILTER violations, not simply reject any.
        assertTrue("create must ignore violations on server-owned components; saw:\n" + src,
            src.contains(".anyMatch(v -> !SERVER_OWNED_ON_CREATE.contains(v.getPropertyPath().toString()))"));
        assertFalse("create must no longer reject on ANY violation; saw:\n" + src,
            src.contains("if (!validator.validate(dto).isEmpty())"));

        // And it must still VALIDATE — the cascade into nested beans is why validate(dto) is
        // kept rather than narrowed to per-property validateValue.
        assertTrue("create must still run the validator; saw:\n" + src,
            src.contains("validator.validate(dto)"));
    }

    /**
     * The rule keys on being the PRIMARY KEY, not on being {@code @required}.
     *
     * <p>{@code AUTHOR_FIXTURE}'s {@code id} carries no {@code @required}, so the DTO puts no
     * {@code @NotNull} on it and the filter has nothing to ignore — but the component is still
     * server-owned ({@code @generation: increment}), so the set names it anyway. Pinning this
     * keeps the two cases from drifting into two rules: a key the database generates is not
     * caller-supplied whether or not the model also calls it required.</p>
     */
    @Test
    public void serverOwnedKeysOnThePrimaryKeyNotOnRequired() throws Exception {
        Path outDir = tempFolder.newFolder("ctrl-nopk").toPath();
        Path workspace = tempFolder.newFolder("ctrl-nopk-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "author-nopk", AUTHOR_FIXTURE);

        SpringControllerGenerator gen = new SpringControllerGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        String src = Files.readString(outDir.resolve("acme/blog/AuthorController.java"));
        assertTrue("a generated PK is server-owned even without @required; saw:\n" + src,
            src.contains("SERVER_OWNED_ON_CREATE = Set.of(\"id\")"));
        assertFalse("and the over-broad guard is gone here too; saw:\n" + src,
            src.contains("if (!validator.validate(dto).isEmpty())"));
    }

    /**
     * Every WRITE verb must map a database constraint violation to the cross-port envelope.
     *
     * <p>Without it a driver failure reaches Spring's default handler and the caller gets a bare
     * 500 for what is a CLIENT error — a foreign key that does not exist, or a value duplicating
     * a unique one, both declared in the same metadata the route already validates against
     * (FINDINGS F16). Asserted per verb rather than once, because the three handlers are emitted
     * by three separate code paths and the TPH set by three more.</p>
     */
    @Test
    public void everyWriteVerbMapsConstraintViolations() throws Exception {
        Path outDir = tempFolder.newFolder("ctrl-cv").toPath();
        Path workspace = tempFolder.newFolder("ctrl-cv-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "author-cv", AUTHOR_FIXTURE);

        SpringControllerGenerator gen = new SpringControllerGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        String src = Files.readString(outDir.resolve("acme/blog/AuthorController.java"));

        assertTrue("the runtime classifier must be imported; saw:\n" + src,
            src.contains("import com.metaobjects.generator.spring.runtime.ConstraintErrors;"));

        // One catch per write verb: create, patch/put, delete.
        int catches = src.split("catch \\(RuntimeException e\\)", -1).length - 1;
        assertEquals("expected a constraint catch on create, update and delete; saw:\n" + src,
            3, catches);

        assertTrue("an unrecognised failure must be RETHROWN, not reported as a constraint; saw:\n" + src,
            src.contains("if (failure == null) throw e;"));
        assertTrue("the body must carry the cross-port error + constraint pair; saw:\n" + src,
            src.contains("Map.of(\"error\", failure.error(), \"constraint\", failure.constraint())"));
    }
}
