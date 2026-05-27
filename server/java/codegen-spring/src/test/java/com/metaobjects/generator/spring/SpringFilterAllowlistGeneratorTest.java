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

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Tests for {@link SpringFilterAllowlistGenerator}. Covers the FR-009
 * authoring contract: only {@code @filterable: true} fields appear in
 * the allowlist; operator gating per field subtype matches the cross-port
 * matrix; entities with zero filterable fields still emit a (empty)
 * allowlist so the generated controller can unconditionally delegate to it.
 */
public class SpringFilterAllowlistGeneratorTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    /** All fields present, NONE marked filterable → empty allowlist. */
    private static final String NO_FILTERABLE_FIXTURE = """
        {
          "metadata.root": { "package": "acme::blog", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long":      { "name": "id" } },
                { "field.string":    { "name": "name", "@maxLength": 100, "@required": true } },
                { "field.string":    { "name": "bio" } },
                { "field.timestamp": { "name": "createdAt" } },
                { "source.rdb":      { "@table": "authors" } },
                { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }
        """;

    /** Mixed: one string + one numeric + one timestamp + one boolean filterable. */
    private static final String MIXED_FILTERABLE_FIXTURE = """
        {
          "metadata.root": { "package": "acme::blog", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long":      { "name": "id", "@filterable": true } },
                { "field.string":    { "name": "name", "@maxLength": 100, "@required": true, "@filterable": true } },
                { "field.string":    { "name": "bio" } },
                { "field.timestamp": { "name": "createdAt", "@filterable": true } },
                { "field.boolean":   { "name": "published", "@filterable": true } },
                { "source.rdb":      { "@table": "authors" } },
                { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }
        """;

    @Test
    public void emptyAllowlistWhenNoFieldFilterable() throws Exception {
        Path outDir = tempFolder.newFolder("fa-empty").toPath();
        Path workspace = tempFolder.newFolder("fa-empty-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "fa-empty", NO_FILTERABLE_FIXTURE);

        SpringFilterAllowlistGenerator gen = new SpringFilterAllowlistGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path allowlist = outDir.resolve("acme/blog/AuthorFilterAllowlist.java");
        assertTrue("expected " + allowlist + " to exist (empty allowlist still emitted)",
            Files.exists(allowlist));
        String src = Files.readString(allowlist);

        // Empty FIELDS set + empty OPS_BY_FIELD map so the generated controller can
        // always call into them without conditional branching.
        assertTrue("expected empty Set.of() for FIELDS; saw:\n" + src,
            src.contains("public static final Set<String> FIELDS = Set.of();"));
        assertTrue("expected empty Map.of() for OPS_BY_FIELD; saw:\n" + src,
            src.contains("public static final Map<String, Set<String>> OPS_BY_FIELD = Map.of();"));
        // No bio / id / createdAt should appear as map keys (no field is filterable).
        assertFalse("'bio' must not be in the allowlist; saw:\n" + src,
            src.contains("\"bio\","));
    }

    @Test
    public void filterableFieldAppearsInAllowlist() throws Exception {
        Path outDir = tempFolder.newFolder("fa-mixed").toPath();
        Path workspace = tempFolder.newFolder("fa-mixed-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "fa-mixed", MIXED_FILTERABLE_FIXTURE);

        SpringFilterAllowlistGenerator gen = new SpringFilterAllowlistGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        String src = Files.readString(outDir.resolve("acme/blog/AuthorFilterAllowlist.java"));

        // The four @filterable fields must appear in FIELDS (bio is NOT filterable).
        assertTrue("expected 'id' in FIELDS; saw:\n" + src, src.contains("\"id\""));
        assertTrue("expected 'name' in FIELDS; saw:\n" + src, src.contains("\"name\""));
        assertTrue("expected 'createdAt' in FIELDS; saw:\n" + src, src.contains("\"createdAt\""));
        assertTrue("expected 'published' in FIELDS; saw:\n" + src, src.contains("\"published\""));

        // bio is NOT marked @filterable — must NOT appear in FIELDS or as an OPS_BY_FIELD key.
        // Asserting on the quoted "bio" pattern that would appear in either Set.of(...) or
        // a Map.of(...) entry. (The raw substring must not show up at all in this file.)
        assertFalse("'bio' must not be in the allowlist; saw:\n" + src,
            src.contains("\"bio\""));
    }

    @Test
    public void operatorGatingPerSubtype() throws Exception {
        Path outDir = tempFolder.newFolder("fa-ops").toPath();
        Path workspace = tempFolder.newFolder("fa-ops-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "fa-ops", MIXED_FILTERABLE_FIXTURE);

        SpringFilterAllowlistGenerator gen = new SpringFilterAllowlistGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        String src = Files.readString(outDir.resolve("acme/blog/AuthorFilterAllowlist.java"));

        // String → eq, ne, in, like, isNull. Match the full line for 'name' so we
        // assert the exact operator set rather than just "any of these appears".
        assertTrue("expected name → string ops; saw:\n" + src,
            src.contains("\"name\", Set.of(\"eq\", \"ne\", \"in\", \"like\", \"isNull\")"));
        // Long (numeric) → eq, ne, gt, gte, lt, lte, in, isNull.
        assertTrue("expected id → numeric ops; saw:\n" + src,
            src.contains("\"id\", Set.of(\"eq\", \"ne\", \"gt\", \"gte\", \"lt\", \"lte\", \"in\", \"isNull\")"));
        // Timestamp shares the numeric op set (gt/lte/etc are valid on timestamps).
        assertTrue("expected createdAt → numeric ops (date/timestamp share that set); saw:\n" + src,
            src.contains("\"createdAt\", Set.of(\"eq\", \"ne\", \"gt\", \"gte\", \"lt\", \"lte\", \"in\", \"isNull\")"));
        // Boolean → eq, isNull only (no gt/lt/etc allowed on booleans).
        assertTrue("expected published → boolean ops; saw:\n" + src,
            src.contains("\"published\", Set.of(\"eq\", \"isNull\")"));
    }
}
