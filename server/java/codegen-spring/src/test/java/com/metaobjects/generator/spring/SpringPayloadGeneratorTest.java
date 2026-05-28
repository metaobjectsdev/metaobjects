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

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Tests for {@link SpringPayloadGenerator}. Pins the per-template
 * payload-record contract: one Java record per {@code template.*}
 * (prompt / output / toolcall), named {@code <TemplateShortName>Payload},
 * in {@code <entity-pkg>.prompts}, with components mirroring the
 * {@code @payloadRef} value-object's scalar fields, honouring
 * {@code origin.*} children. FR-006 / ADR-0010.
 */
public class SpringPayloadGeneratorTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private static final String SIMPLE_FIXTURE = """
        {
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "NpcResponsePayload", "children": [
                { "field.string": { "name": "name" } },
                { "field.int":    { "name": "age" } }
            ] } },
            { "template.output": {
                "name": "NpcResponseOutput",
                "@payloadRef": "NpcResponsePayload",
                "@textRef": "npc/output",
                "@format": "json"
            } }
          ] }
        }
        """;

    @Test
    public void emitsRecordPerOutputTemplate() throws Exception {
        Path outDir = tempFolder.newFolder("payload-simple").toPath();
        Path workspace = tempFolder.newFolder("payload-simple-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "payload-simple", SIMPLE_FIXTURE);

        SpringPayloadGenerator gen = new SpringPayloadGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path payload = outDir.resolve("acme/ai/prompts/NpcResponseOutputPayload.java");
        assertTrue("expected NpcResponseOutputPayload.java at " + payload, Files.exists(payload));
        String src = Files.readString(payload);

        assertTrue("expected `package acme.ai.prompts;`; saw:\n" + src,
            src.contains("package acme.ai.prompts;"));
        assertTrue("expected record declaration; saw:\n" + src,
            src.contains("public record NpcResponseOutputPayload("));
        assertTrue("expected `String name` component; saw:\n" + src,
            src.contains("String name"));
        assertTrue("expected `Integer age` component (wrapped); saw:\n" + src,
            src.contains("Integer age"));
        assertFalse("expected wrapped `Integer`, not primitive `int`; saw:\n" + src,
            src.contains(" int "));
        // String component → hasFoo() helper emitted (Mustache-section-gate use).
        assertTrue("expected `hasName()` helper for String component; saw:\n" + src,
            src.contains("public boolean hasName()")
                && src.contains("return name != null && !name.isBlank();"));
        // Boxed-primitive numeric → NO helper (always-present scalar convention).
        assertFalse("expected NO `hasAge()` helper for Integer component; saw:\n" + src,
            src.contains("public boolean hasAge()"));
    }

    @Test
    public void emitsRecordForPromptTemplate() throws Exception {
        // Cross-port parity: template.prompt must emit a payload record too.
        // Mirrors KotlinPayloadGenerator (iterates ALL MetaTemplate subtypes).
        String fixture = """
            {
              "metadata.root": { "package": "acme::ai", "children": [
                { "object.value": { "name": "NpcPromptPayload", "children": [
                    { "field.string": { "name": "mood" } }
                ] } },
                { "template.prompt": {
                    "name": "npcTurn",
                    "@payloadRef": "NpcPromptPayload",
                    "@textRef": "npc/turn",
                    "@format": "xml"
                } }
              ] }
            }
            """;
        Path outDir = tempFolder.newFolder("payload-prompt").toPath();
        Path workspace = tempFolder.newFolder("payload-prompt-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "payload-prompt", fixture);

        SpringPayloadGenerator gen = new SpringPayloadGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        // PascalCase the record name regardless of camelCase template name —
        // matches Java's class-naming convention and parity with Kotlin/C#/TS/Python.
        Path payload = outDir.resolve("acme/ai/prompts/NpcTurnPayload.java");
        assertTrue("expected NpcTurnPayload.java at " + payload, Files.exists(payload));
        String src = Files.readString(payload);
        assertTrue("expected `public record NpcTurnPayload(`; saw:\n" + src,
            src.contains("public record NpcTurnPayload("));
        assertTrue("expected `String mood` component; saw:\n" + src,
            src.contains("String mood"));
    }

    @Test
    public void emitsRecordForToolcallTemplate() throws Exception {
        // template.toolcall also carries @payloadRef and must emit a payload
        // record. Falls out of the "iterate ALL MetaTemplate" loop for free.
        String fixture = """
            {
              "metadata.root": { "package": "acme::ai", "children": [
                { "object.value": { "name": "WeatherArgs", "children": [
                    { "field.string": { "name": "city" } }
                ] } },
                { "template.toolcall": {
                    "name": "lookupWeather",
                    "@toolName": "lookup_weather",
                    "@payloadRef": "WeatherArgs"
                } }
              ] }
            }
            """;
        Path outDir = tempFolder.newFolder("payload-toolcall").toPath();
        Path workspace = tempFolder.newFolder("payload-toolcall-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "payload-toolcall", fixture);

        SpringPayloadGenerator gen = new SpringPayloadGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path payload = outDir.resolve("acme/ai/prompts/LookupWeatherPayload.java");
        assertTrue("expected LookupWeatherPayload.java at " + payload, Files.exists(payload));
        String src = Files.readString(payload);
        assertTrue("expected `public record LookupWeatherPayload(`; saw:\n" + src,
            src.contains("public record LookupWeatherPayload("));
        assertTrue("expected `String city` component; saw:\n" + src,
            src.contains("String city"));
    }

    @Test
    public void skipsTemplatesWithUnresolvedPayloadRef() throws Exception {
        String fixture = """
            {
              "metadata.root": { "package": "acme::ai", "children": [
                { "object.value": { "name": "NpcResponsePayload", "children": [
                    { "field.string": { "name": "name" } }
                ] } },
                { "template.output": {
                    "name": "NpcResponseOutput",
                    "@payloadRef": "NpcResponsePayload",
                    "@textRef": "npc/output",
                    "@format": "json"
                } }
              ] }
            }
            """;
        // Happy path — emits one file. Negative payloadRef coverage lives in the
        // loader validation pass (ERR_UNRESOLVED_PAYLOAD_REF), so a missing-ref
        // fixture would fail to load, not produce a no-op generator run.
        Path outDir = tempFolder.newFolder("payload-resolved").toPath();
        Path workspace = tempFolder.newFolder("payload-resolved-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "payload-resolved", fixture);

        SpringPayloadGenerator gen = new SpringPayloadGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        assertTrue(Files.exists(outDir.resolve("acme/ai/prompts/NpcResponseOutputPayload.java")));
    }

    // ----------------------------------------------------------------------
    // origin.* coverage — FR-004 payload-VO field-value provenance
    // (mirrors KotlinPayloadGeneratorTest)
    // ----------------------------------------------------------------------

    @Test
    public void originPassthroughResolvesSourceFieldType() throws Exception {
        // PayloadVo.title carries `origin.passthrough @from "Source.title"`.
        // Expected: emitted component uses Source.title's type (String).
        String fixture = """
            {
              "metadata.root": { "package": "acme::demo", "children": [
                { "object.entity": { "name": "Source", "children": [
                    { "field.string": { "name": "title" } }
                ] } },
                { "object.value": { "name": "ArticleSummary", "children": [
                    { "field.string": { "name": "title", "children": [
                        { "origin.passthrough": { "@from": "Source.title" } }
                    ] } }
                ] } },
                { "template.prompt": { "name": "Article",
                    "@payloadRef": "ArticleSummary", "@textRef": "demo/article" } }
              ] }
            }
            """;
        Path outDir = tempFolder.newFolder("payload-pt").toPath();
        Path workspace = tempFolder.newFolder("payload-pt-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "payload-pt", fixture);

        SpringPayloadGenerator gen = new SpringPayloadGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path emitted = outDir.resolve("acme/demo/prompts/ArticlePayload.java");
        assertTrue("expected " + emitted, Files.exists(emitted));
        String src = Files.readString(emitted);
        assertTrue("expected `String title` from passthrough; saw:\n" + src,
            src.contains("String title"));
    }

    @Test
    public void originAggregateCountEmitsLong() throws Exception {
        // PayloadVo.postCount has `origin.aggregate @agg count @of "Post.id" @via "Author.posts"`.
        // Expected: emitted component is Long regardless of payload field's own subtype.
        String fixture = """
            {
              "metadata.root": { "package": "acme::demo", "children": [
                { "object.entity": { "name": "Author", "children": [
                    { "field.long": { "name": "id" } },
                    { "relationship.aggregation": { "name": "posts",
                        "@objectRef": "Post", "@cardinality": "many" } }
                ] } },
                { "object.entity": { "name": "Post", "children": [
                    { "field.long": { "name": "id" } }
                ] } },
                { "object.value": { "name": "AuthorSummary", "children": [
                    { "field.int": { "name": "postCount", "children": [
                        { "origin.aggregate": {
                            "@agg": "count", "@of": "Post.id", "@via": "Author.posts" } }
                    ] } }
                ] } },
                { "template.prompt": { "name": "AuthorStats",
                    "@payloadRef": "AuthorSummary", "@textRef": "demo/author" } }
              ] }
            }
            """;
        Path outDir = tempFolder.newFolder("payload-count").toPath();
        Path workspace = tempFolder.newFolder("payload-count-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "payload-count", fixture);

        SpringPayloadGenerator gen = new SpringPayloadGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path emitted = outDir.resolve("acme/demo/prompts/AuthorStatsPayload.java");
        assertTrue("expected " + emitted, Files.exists(emitted));
        String src = Files.readString(emitted);
        assertTrue("expected `Long postCount` (count → Long); saw:\n" + src,
            src.contains("Long postCount"));
    }

    @Test
    public void originAggregateAvgEmitsDouble() throws Exception {
        // PayloadVo.avgScore has `origin.aggregate @agg avg @of "Post.score"`.
        // Expected: emitted component is Double regardless of @of field's type.
        String fixture = """
            {
              "metadata.root": { "package": "acme::demo", "children": [
                { "object.entity": { "name": "Author", "children": [
                    { "field.long": { "name": "id" } },
                    { "relationship.aggregation": { "name": "posts",
                        "@objectRef": "Post", "@cardinality": "many" } }
                ] } },
                { "object.entity": { "name": "Post", "children": [
                    { "field.long":   { "name": "id" } },
                    { "field.long":   { "name": "score" } }
                ] } },
                { "object.value": { "name": "AuthorSummary", "children": [
                    { "field.double": { "name": "avgScore", "children": [
                        { "origin.aggregate": {
                            "@agg": "avg", "@of": "Post.score", "@via": "Author.posts" } }
                    ] } }
                ] } },
                { "template.prompt": { "name": "AuthorStats",
                    "@payloadRef": "AuthorSummary", "@textRef": "demo/author" } }
              ] }
            }
            """;
        Path outDir = tempFolder.newFolder("payload-avg").toPath();
        Path workspace = tempFolder.newFolder("payload-avg-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "payload-avg", fixture);

        SpringPayloadGenerator gen = new SpringPayloadGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path emitted = outDir.resolve("acme/demo/prompts/AuthorStatsPayload.java");
        assertTrue("expected " + emitted, Files.exists(emitted));
        String src = Files.readString(emitted);
        assertTrue("expected `Double avgScore` (avg → Double); saw:\n" + src,
            src.contains("Double avgScore"));
    }

    @Test
    public void originAggregateSumEmitsSourceFieldType() throws Exception {
        // PayloadVo.totalScore has `origin.aggregate @agg sum @of "Post.score"` where Post.score is field.long.
        // Expected: emitted component takes the @of field's type (Long).
        String fixture = """
            {
              "metadata.root": { "package": "acme::demo", "children": [
                { "object.entity": { "name": "Author", "children": [
                    { "field.long": { "name": "id" } },
                    { "relationship.aggregation": { "name": "posts",
                        "@objectRef": "Post", "@cardinality": "many" } }
                ] } },
                { "object.entity": { "name": "Post", "children": [
                    { "field.long":   { "name": "id" } },
                    { "field.long":   { "name": "score" } }
                ] } },
                { "object.value": { "name": "AuthorSummary", "children": [
                    { "field.int": { "name": "totalScore", "children": [
                        { "origin.aggregate": {
                            "@agg": "sum", "@of": "Post.score", "@via": "Author.posts" } }
                    ] } }
                ] } },
                { "template.prompt": { "name": "AuthorStats",
                    "@payloadRef": "AuthorSummary", "@textRef": "demo/author" } }
              ] }
            }
            """;
        Path outDir = tempFolder.newFolder("payload-sum").toPath();
        Path workspace = tempFolder.newFolder("payload-sum-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "payload-sum", fixture);

        SpringPayloadGenerator gen = new SpringPayloadGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path emitted = outDir.resolve("acme/demo/prompts/AuthorStatsPayload.java");
        assertTrue("expected " + emitted, Files.exists(emitted));
        String src = Files.readString(emitted);
        // payload field's own subtype is `field.int` (Integer) — sum/min/max must
        // override it with the @of field's type (Long here).
        assertTrue("expected `Long totalScore` (sum → @of field type); saw:\n" + src,
            src.contains("Long totalScore"));
    }

    @Test
    public void originCollectionEmitsListOfNestedPayload() throws Exception {
        // PayloadVo.posts has `origin.collection @via "Author.posts"`.
        // Expected:
        //   - parent payload emits `java.util.List<PostPayload> posts`
        //   - a separate file PostPayload.java is also emitted in the same prompts/ package
        //   - PostPayload contains Post's primitive fields
        String fixture = """
            {
              "metadata.root": { "package": "acme::demo", "children": [
                { "object.entity": { "name": "Author", "children": [
                    { "field.long": { "name": "id" } },
                    { "relationship.aggregation": { "name": "posts",
                        "@objectRef": "Post", "@cardinality": "many" } }
                ] } },
                { "object.value": { "name": "Post", "children": [
                    { "field.long":   { "name": "id" } },
                    { "field.string": { "name": "title" } }
                ] } },
                { "object.value": { "name": "AuthorDetail", "children": [
                    { "field.string": { "name": "posts", "children": [
                        { "origin.collection": { "@via": "Author.posts" } }
                    ] } }
                ] } },
                { "template.prompt": { "name": "AuthorView",
                    "@payloadRef": "AuthorDetail", "@textRef": "demo/author" } }
              ] }
            }
            """;
        Path outDir = tempFolder.newFolder("payload-coll").toPath();
        Path workspace = tempFolder.newFolder("payload-coll-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "payload-coll", fixture);

        SpringPayloadGenerator gen = new SpringPayloadGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path parentFile = outDir.resolve("acme/demo/prompts/AuthorViewPayload.java");
        Path nestedFile = outDir.resolve("acme/demo/prompts/PostPayload.java");
        assertTrue("expected " + parentFile, Files.exists(parentFile));
        assertTrue("expected nested " + nestedFile, Files.exists(nestedFile));

        String parentSrc = Files.readString(parentFile);
        assertTrue("expected `java.util.List<PostPayload> posts` on parent; saw:\n" + parentSrc,
            parentSrc.contains("java.util.List<PostPayload> posts"));

        String nestedSrc = Files.readString(nestedFile);
        assertTrue("expected `public record PostPayload(`; saw:\n" + nestedSrc,
            nestedSrc.contains("public record PostPayload("));
        assertTrue("expected `Long id` in nested; saw:\n" + nestedSrc,
            nestedSrc.contains("Long id"));
        assertTrue("expected `String title` in nested; saw:\n" + nestedSrc,
            nestedSrc.contains("String title"));
        assertTrue("expected `package acme.demo.prompts;` on nested; saw:\n" + nestedSrc,
            nestedSrc.contains("package acme.demo.prompts;"));
    }

    @Test
    public void originCollectionDedupesNestedPayloadAcrossMultipleTemplates() throws Exception {
        // Two templates reference the same collection target — the nested
        // PostPayload should be emitted exactly once.
        String fixture = """
            {
              "metadata.root": { "package": "acme::demo", "children": [
                { "object.entity": { "name": "Author", "children": [
                    { "field.long": { "name": "id" } },
                    { "relationship.aggregation": { "name": "posts",
                        "@objectRef": "Post", "@cardinality": "many" } }
                ] } },
                { "object.value": { "name": "Post", "children": [
                    { "field.long":   { "name": "id" } },
                    { "field.string": { "name": "title" } }
                ] } },
                { "object.value": { "name": "AuthorDetail", "children": [
                    { "field.string": { "name": "posts", "children": [
                        { "origin.collection": { "@via": "Author.posts" } }
                    ] } }
                ] } },
                { "object.value": { "name": "AuthorOverview", "children": [
                    { "field.string": { "name": "posts", "children": [
                        { "origin.collection": { "@via": "Author.posts" } }
                    ] } }
                ] } },
                { "template.prompt": { "name": "DetailView",
                    "@payloadRef": "AuthorDetail", "@textRef": "demo/detail" } },
                { "template.prompt": { "name": "Overview",
                    "@payloadRef": "AuthorOverview", "@textRef": "demo/overview" } }
              ] }
            }
            """;
        Path outDir = tempFolder.newFolder("payload-coll-dedupe").toPath();
        Path workspace = tempFolder.newFolder("payload-coll-dedupe-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "payload-coll-dedupe", fixture);

        SpringPayloadGenerator gen = new SpringPayloadGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        // Both top-level payloads are emitted...
        assertTrue(Files.exists(outDir.resolve("acme/demo/prompts/DetailViewPayload.java")));
        assertTrue(Files.exists(outDir.resolve("acme/demo/prompts/OverviewPayload.java")));
        // ...and exactly one PostPayload.java exists.
        Path nested = outDir.resolve("acme/demo/prompts/PostPayload.java");
        assertTrue("expected single PostPayload.java", Files.exists(nested));

        // Both parents must reference the SAME nested type by name.
        String detailSrc = Files.readString(outDir.resolve("acme/demo/prompts/DetailViewPayload.java"));
        String overviewSrc = Files.readString(outDir.resolve("acme/demo/prompts/OverviewPayload.java"));
        assertTrue("detail must reference List<PostPayload>; saw:\n" + detailSrc,
            detailSrc.contains("java.util.List<PostPayload> posts"));
        assertTrue("overview must reference List<PostPayload>; saw:\n" + overviewSrc,
            overviewSrc.contains("java.util.List<PostPayload> posts"));

        // Sanity: prompts dir has exactly the 3 expected payload files.
        try (java.util.stream.Stream<Path> stream = Files.list(outDir.resolve("acme/demo/prompts"))) {
            assertEquals("prompts dir should hold exactly 3 files (2 parents + 1 nested)",
                3L, stream.count());
        }
    }

    // ── field.object support (no origin) ──────────────────────────────────

    @Test
    public void fieldObjectSingleRefEmitsNestedPayloadAndRecordReferenceType() throws Exception {
        // A payload-VO with a naked field.object @objectRef (no isArray) should
        // emit BOTH the parent payload (with the nested type as the component)
        // and a sibling <Target>Payload record. Closes the ObjectField filter gap.
        String fixture = """
            {
              "metadata.root": { "package": "acme::ai", "children": [
                { "object.value": { "name": "ClosureSummaryView", "children": [
                    { "field.string": { "name": "verdict" } }
                ] } },
                { "object.value": { "name": "AdjudicationPayload", "children": [
                    { "field.int":    { "name": "turnNumber" } },
                    { "field.object": { "name": "closureSummary",
                                        "@objectRef": "acme::ai::ClosureSummaryView",
                                        "@storage": "flattened" } }
                ] } },
                { "template.output": {
                    "name": "AdjudicationOutput",
                    "@payloadRef": "AdjudicationPayload",
                    "@textRef": "adj/output",
                    "@format": "json"
                } }
              ] }
            }
            """;
        Path outDir = tempFolder.newFolder("obj-single").toPath();
        Path workspace = tempFolder.newFolder("obj-single-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "obj-single", fixture);

        SpringPayloadGenerator gen = new SpringPayloadGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path parent = outDir.resolve("acme/ai/prompts/AdjudicationOutputPayload.java");
        Path nested = outDir.resolve("acme/ai/prompts/ClosureSummaryViewPayload.java");
        assertTrue("expected AdjudicationOutputPayload.java; saw absent", Files.exists(parent));
        assertTrue("expected nested ClosureSummaryViewPayload.java; saw absent", Files.exists(nested));

        String parentSrc = Files.readString(parent);
        assertTrue("parent must declare `Integer turnNumber`; saw:\n" + parentSrc,
            parentSrc.contains("Integer turnNumber"));
        assertTrue("parent must declare `ClosureSummaryViewPayload closureSummary` (single ref, NOT List); saw:\n" + parentSrc,
            parentSrc.contains("ClosureSummaryViewPayload closureSummary"));
        assertFalse("single-ref must NOT be wrapped in List; saw:\n" + parentSrc,
            parentSrc.contains("List<ClosureSummaryViewPayload>"));

        String nestedSrc = Files.readString(nested);
        assertTrue("nested payload must declare `String verdict`; saw:\n" + nestedSrc,
            nestedSrc.contains("String verdict"));
    }

    @Test
    public void fieldObjectIsArrayEmitsListType() throws Exception {
        // A field.object with isArray:true must emit `java.util.List<<Target>Payload>`,
        // mirroring origin.collection. Nested payload is emitted once.
        String fixture = """
            {
              "metadata.root": { "package": "acme::ai", "children": [
                { "object.value": { "name": "PlayerActionEntry", "children": [
                    { "field.string": { "name": "name" } }
                ] } },
                { "object.value": { "name": "AdjudicationPayload", "children": [
                    { "field.int":    { "name": "turnNumber" } },
                    { "field.object": { "name": "playerActions", "isArray": true,
                                        "@objectRef": "acme::ai::PlayerActionEntry",
                                        "@storage": "jsonb" } }
                ] } },
                { "template.output": {
                    "name": "AdjudicationOutput",
                    "@payloadRef": "AdjudicationPayload",
                    "@textRef": "adj/output",
                    "@format": "json"
                } }
              ] }
            }
            """;
        Path outDir = tempFolder.newFolder("obj-array").toPath();
        Path workspace = tempFolder.newFolder("obj-array-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "obj-array", fixture);

        SpringPayloadGenerator gen = new SpringPayloadGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path parent = outDir.resolve("acme/ai/prompts/AdjudicationOutputPayload.java");
        Path nested = outDir.resolve("acme/ai/prompts/PlayerActionEntryPayload.java");
        assertTrue(Files.exists(parent));
        assertTrue(Files.exists(nested));

        String parentSrc = Files.readString(parent);
        assertTrue("isArray must emit `java.util.List<PlayerActionEntryPayload> playerActions`; saw:\n" + parentSrc,
            parentSrc.contains("java.util.List<PlayerActionEntryPayload> playerActions"));
    }

    @Test
    public void fieldObjectMixedFieldsAllSurviveIntoParent() throws Exception {
        // Cover the multi-shape case: scalar + single field.object + isArray
        // field.object + a passthrough origin. All four must reach the parent
        // record; previous scalarFields() filter dropped the two object refs.
        String fixture = """
            {
              "metadata.root": { "package": "acme::ai", "children": [
                { "object.entity": { "name": "Source", "children": [
                    { "field.string": { "name": "label" } }
                ] } },
                { "object.value": { "name": "Closure", "children": [
                    { "field.string": { "name": "summary" } }
                ] } },
                { "object.value": { "name": "Action", "children": [
                    { "field.string": { "name": "actor" } }
                ] } },
                { "object.value": { "name": "MixedPayload", "children": [
                    { "field.int":    { "name": "turn" } },
                    { "field.object": { "name": "closure",
                                        "@objectRef": "acme::ai::Closure",
                                        "@storage": "flattened" } },
                    { "field.object": { "name": "actions", "isArray": true,
                                        "@objectRef": "acme::ai::Action",
                                        "@storage": "jsonb" } },
                    { "field.string": { "name": "label", "children": [
                        { "origin.passthrough": { "@from": "Source.label" } }
                    ] } }
                ] } },
                { "template.output": {
                    "name": "MixedOutput",
                    "@payloadRef": "MixedPayload",
                    "@textRef": "mix/output",
                    "@format": "json"
                } }
              ] }
            }
            """;
        Path outDir = tempFolder.newFolder("obj-mixed").toPath();
        Path workspace = tempFolder.newFolder("obj-mixed-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "obj-mixed", fixture);

        SpringPayloadGenerator gen = new SpringPayloadGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        String parentSrc = Files.readString(outDir.resolve("acme/ai/prompts/MixedOutputPayload.java"));
        assertTrue("scalar `Integer turn`; saw:\n" + parentSrc, parentSrc.contains("Integer turn"));
        assertTrue("single ref `ClosurePayload closure`; saw:\n" + parentSrc,
            parentSrc.contains("ClosurePayload closure"));
        assertTrue("list ref `java.util.List<ActionPayload> actions`; saw:\n" + parentSrc,
            parentSrc.contains("java.util.List<ActionPayload> actions"));
        assertTrue("passthrough `String label`; saw:\n" + parentSrc,
            parentSrc.contains("String label"));
        // Both nested payloads must exist.
        assertTrue(Files.exists(outDir.resolve("acme/ai/prompts/ClosurePayload.java")));
        assertTrue(Files.exists(outDir.resolve("acme/ai/prompts/ActionPayload.java")));
    }

    @Test
    public void camelCaseTemplateNameYieldsPascalCaseRecord() throws Exception {
        // Pin Gap 2: a camelCase template short name (e.g. `adjudicationUser`)
        // must produce a PascalCase record + file name. Nested payload class
        // names are independently capitalised the same way.
        String fixture = """
            {
              "metadata.root": { "package": "acme::ai", "children": [
                { "object.value": { "name": "userContext", "children": [
                    { "field.string": { "name": "displayName" } }
                ] } },
                { "object.value": { "name": "AdjudicationUserPayloadView", "children": [
                    { "field.int":    { "name": "turn" } },
                    { "field.object": { "name": "context",
                                        "@objectRef": "acme::ai::userContext",
                                        "@storage": "flattened" } }
                ] } },
                { "template.prompt": {
                    "name": "adjudicationUser",
                    "@payloadRef": "AdjudicationUserPayloadView",
                    "@textRef": "adj/user",
                    "@format": "xml"
                } }
              ] }
            }
            """;
        Path outDir = tempFolder.newFolder("camel-case").toPath();
        Path workspace = tempFolder.newFolder("camel-case-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "camel-case", fixture);

        SpringPayloadGenerator gen = new SpringPayloadGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        // File name PascalCased even though the template short name is camelCase.
        Path parent = outDir.resolve("acme/ai/prompts/AdjudicationUserPayload.java");
        assertTrue("expected AdjudicationUserPayload.java (NOT adjudicationUserPayload); saw absent",
            Files.exists(parent));
        assertFalse("camelCase file must NOT exist",
            Files.exists(outDir.resolve("acme/ai/prompts/adjudicationUserPayload.java")));
        String parentSrc = Files.readString(parent);
        assertTrue("record name must be PascalCase; saw:\n" + parentSrc,
            parentSrc.contains("public record AdjudicationUserPayload("));

        // Nested payload class name PascalCased too — `userContext` (camelCase
        // VO short name) becomes `UserContextPayload`.
        Path nested = outDir.resolve("acme/ai/prompts/UserContextPayload.java");
        assertTrue("nested UserContextPayload.java (NOT userContextPayload) must exist",
            Files.exists(nested));
        assertTrue("parent must reference the PascalCased nested record; saw:\n" + parentSrc,
            parentSrc.contains("UserContextPayload context"));
    }

    // ── hasFoo() helper emission (Mustache section-gate ergonomics) ──────

    @Test
    public void emitsHasFooHelpersForNullableFields() throws Exception {
        // Pins the four hasFoo() emission rules in a single fixture:
        //   - String                  → hasFoo() with isBlank check
        //   - java.util.List<...>     → hasFoo() with isEmpty check
        //   - nested object ref       → hasFoo() with null check
        //   - boxed primitive numeric → NO helper
        // These methods make Mustache `{{#hasFoo}}...{{/hasFoo}}` section
        // gates work natively on the generated record — no hand-written
        // wrapper class needed for downstream templating consumers.
        String fixture = """
            {
              "metadata.root": { "package": "acme::ai", "children": [
                { "object.value": { "name": "ItemView", "children": [
                    { "field.string": { "name": "label" } }
                ] } },
                { "object.value": { "name": "Payload", "children": [
                    { "field.string": { "name": "name" } },
                    { "field.int":    { "name": "count" } },
                    { "field.boolean":{ "name": "enabled" } },
                    { "field.object": { "name": "items",   "isArray": true,
                                        "@objectRef": "acme::ai::ItemView",
                                        "@storage":   "jsonb" } },
                    { "field.object": { "name": "primary",
                                        "@objectRef": "acme::ai::ItemView",
                                        "@storage":   "flattened" } }
                ] } },
                { "template.output": {
                    "name": "HelpersOutput",
                    "@payloadRef": "Payload",
                    "@textRef": "demo/helpers",
                    "@format": "json"
                } }
              ] }
            }
            """;
        Path outDir = tempFolder.newFolder("payload-helpers").toPath();
        Path workspace = tempFolder.newFolder("payload-helpers-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "payload-helpers", fixture);

        SpringPayloadGenerator gen = new SpringPayloadGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path payload = outDir.resolve("acme/ai/prompts/HelpersOutputPayload.java");
        assertTrue("expected HelpersOutputPayload.java at " + payload, Files.exists(payload));
        String src = Files.readString(payload);

        // String → hasName() with isBlank check
        assertTrue("String field should get hasName() with isBlank check; saw:\n" + src,
            src.contains("public boolean hasName()")
                && src.contains("return name != null && !name.isBlank();"));

        // List → hasItems() with isEmpty check
        assertTrue("List field should get hasItems() with isEmpty check; saw:\n" + src,
            src.contains("public boolean hasItems()")
                && src.contains("return items != null && !items.isEmpty();"));

        // Nested object ref → hasPrimary() with null check
        assertTrue("Nested object ref should get hasPrimary() with null check; saw:\n" + src,
            src.contains("public boolean hasPrimary()")
                && src.contains("return primary != null;"));

        // Boxed-primitive numeric → NO helper
        assertFalse("Integer field should NOT get hasCount(); saw:\n" + src,
            src.contains("public boolean hasCount()"));

        // Boxed-primitive boolean → NO helper
        assertFalse("Boolean field should NOT get hasEnabled(); saw:\n" + src,
            src.contains("public boolean hasEnabled()"));

        // Nested record gets its own helpers — recursion check
        Path nested = outDir.resolve("acme/ai/prompts/ItemViewPayload.java");
        assertTrue("nested ItemViewPayload.java must exist", Files.exists(nested));
        String nestedSrc = Files.readString(nested);
        assertTrue("nested record String field gets hasLabel(); saw:\n" + nestedSrc,
            nestedSrc.contains("public boolean hasLabel()")
                && nestedSrc.contains("return label != null && !label.isBlank();"));
    }
}
