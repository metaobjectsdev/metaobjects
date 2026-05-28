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
        assertTrue("expected `) {}` empty body; saw:\n" + src,
            src.contains(") {}"));
        assertTrue("expected `String name` component; saw:\n" + src,
            src.contains("String name"));
        assertTrue("expected `Integer age` component (wrapped); saw:\n" + src,
            src.contains("Integer age"));
        assertFalse("expected wrapped `Integer`, not primitive `int`; saw:\n" + src,
            src.contains(" int "));
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

        Path payload = outDir.resolve("acme/ai/prompts/npcTurnPayload.java");
        assertTrue("expected npcTurnPayload.java at " + payload, Files.exists(payload));
        String src = Files.readString(payload);
        assertTrue("expected `public record npcTurnPayload(`; saw:\n" + src,
            src.contains("public record npcTurnPayload("));
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

        Path payload = outDir.resolve("acme/ai/prompts/lookupWeatherPayload.java");
        assertTrue("expected lookupWeatherPayload.java at " + payload, Files.exists(payload));
        String src = Files.readString(payload);
        assertTrue("expected `public record lookupWeatherPayload(`; saw:\n" + src,
            src.contains("public record lookupWeatherPayload("));
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
}
