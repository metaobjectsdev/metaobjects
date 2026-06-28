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
        // @PostMapping — create.
        assertTrue("expected @PostMapping create handler; saw:\n" + src,
            Pattern.compile("@PostMapping\\s*\\n\\s*public ResponseEntity<AuthorDto> create").matcher(src).find());
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
        // The 400 envelope for invalid sort is `{ "error": "invalid_sort" }`.
        assertTrue("expected invalid_sort 400 envelope; saw:\n" + src,
            src.contains("\"invalid_sort\""));
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
        // 400 envelope on parse failure mirrors the cross-port shape.
        assertTrue("expected invalid_filter_* 400 envelope on parse failure; saw:\n" + src,
            src.contains("Map.of(\"error\", filter.error())"));
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
}
