package com.metaobjects.generator.spring;

import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Tests for {@link SpringPayloadGenerator}. Pins the per-template
 * payload-record contract: one Java record per {@code template.*}
 * (prompt / output / toolcall), named {@code <TemplateShortName>Payload},
 * in {@code <entity-pkg>.prompts}, with components typed from the
 * {@code @payloadRef} value-object's DECLARED fields only — any
 * {@code origin.*} child is IGNORED for typing (#270). FR-006 / ADR-0010.
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
    // origin.* coverage — #270: payload typing is DECLARED-TYPE-AUTHORITATIVE.
    // A field carrying any `origin.*` child types exactly as if the origin
    // child were absent (matching the origin-blind TS / C# emitters and the
    // converged Kotlin / Python ports; mirrors KotlinPayloadGeneratorTest).
    // ----------------------------------------------------------------------

    @Test
    public void originPassthroughIgnoredDeclaredTypeWins() throws Exception {
        // #270 — PayloadVo.title is DECLARED `field.int` but carries
        // `origin.passthrough @from "Source.title"` to a STRING source
        // (`@convert: true` acknowledges the deliberate type change, #185).
        // Expected: the DECLARED type (Integer), never the source's.
        String fixture = """
            {
              "metadata.root": { "package": "acme::demo", "children": [
                { "object.entity": { "name": "Source", "children": [
                    { "field.string": { "name": "title" } }
                ] } },
                { "object.value": { "name": "ArticleSummary", "children": [
                    { "field.int": { "name": "title", "children": [
                        { "origin.passthrough": { "@from": "Source.title", "@convert": true } }
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
        assertTrue("expected DECLARED `Integer title` (passthrough ignored); saw:\n" + src,
            src.contains("Integer title"));
        assertFalse("must NOT take the @from source's String type; saw:\n" + src,
            src.contains("String title"));
    }

    @Test
    public void originAggregateCountIgnoredDeclaredTypeWins() throws Exception {
        // #270 — PayloadVo.postCount is DECLARED `field.int` but carries
        // `origin.aggregate @agg count`. Expected: the DECLARED type (Integer) —
        // no more hardwired Long.
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
        assertTrue("expected DECLARED `Integer postCount` (count no longer hardwires Long); saw:\n" + src,
            src.contains("Integer postCount"));
        assertFalse("must NOT hardwire Long; saw:\n" + src,
            src.contains("Long postCount"));
    }

    @Test
    public void originAggregateAvgIgnoredDeclaredTypeWins() throws Exception {
        // #270 — PayloadVo.avgScore is DECLARED `field.float` but carries
        // `origin.aggregate @agg avg`. Expected: the DECLARED type (Float) —
        // no more hardwired Double.
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
                    { "field.float": { "name": "avgScore", "children": [
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
        assertTrue("expected DECLARED `Float avgScore` (avg no longer hardwires Double); saw:\n" + src,
            src.contains("Float avgScore"));
        assertFalse("must NOT hardwire Double; saw:\n" + src,
            src.contains("Double avgScore"));
    }

    @Test
    public void originAggregateSumIgnoredDeclaredTypeWins() throws Exception {
        // #270 — PayloadVo.totalScore is DECLARED `field.int`; the `@agg sum`
        // whose `@of` is a field.long no longer overrides it.
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
        assertTrue("expected DECLARED `Integer totalScore` (sum no longer takes @of type); saw:\n" + src,
            src.contains("Integer totalScore"));
        assertFalse("must NOT take the @of field's Long type; saw:\n" + src,
            src.contains("Long totalScore"));
    }

    @Test
    public void originCollectionIgnoredNoNestedPayloadEmitted() throws Exception {
        // #270 — PayloadVo.posts is DECLARED `field.string` but carries
        // `origin.collection @via "Author.posts"`. Expected:
        //   - the DECLARED scalar type (`String posts`) — no List<PostPayload>
        //   - NO PostPayload.java is emitted (a non-object field contributes no
        //     nested payload record; the @via target is never reached)
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
        assertFalse("PostPayload.java must NOT be emitted (origin.collection is ignored)",
            Files.exists(nestedFile));

        String parentSrc = Files.readString(parentFile);
        assertTrue("expected DECLARED `String posts`; saw:\n" + parentSrc,
            parentSrc.contains("String posts"));
        assertFalse("must NOT type as List<PostPayload>; saw:\n" + parentSrc,
            parentSrc.contains("java.util.List<PostPayload>"));
    }

    @Test
    public void originCollectionIgnoredAcrossMultipleTemplates() throws Exception {
        // #270 — two templates whose payload fields carry the same
        // `origin.collection` both emit the declared scalar; NO nested
        // PostPayload record exists anywhere in the run.
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
        Path outDir = tempFolder.newFolder("payload-coll-multi").toPath();
        Path workspace = tempFolder.newFolder("payload-coll-multi-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "payload-coll-multi", fixture);

        SpringPayloadGenerator gen = new SpringPayloadGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        // Both top-level payloads are emitted with the DECLARED scalar...
        String detailSrc = Files.readString(outDir.resolve("acme/demo/prompts/DetailViewPayload.java"));
        String overviewSrc = Files.readString(outDir.resolve("acme/demo/prompts/OverviewPayload.java"));
        assertTrue("detail must declare `String posts`; saw:\n" + detailSrc,
            detailSrc.contains("String posts"));
        assertTrue("overview must declare `String posts`; saw:\n" + overviewSrc,
            overviewSrc.contains("String posts"));
        // ...and NO PostPayload.java exists.
        assertFalse("PostPayload.java must NOT be emitted",
            Files.exists(outDir.resolve("acme/demo/prompts/PostPayload.java")));

        // Sanity: prompts dir has exactly the 2 parent payload files.
        try (java.util.stream.Stream<Path> stream = Files.list(outDir.resolve("acme/demo/prompts"))) {
            assertEquals("prompts dir should hold exactly 2 files (the 2 parents, no nested)",
                2L, stream.count());
        }
    }

    @Test
    public void disagreeingOriginCollectionDeclaredObjectRefWins() throws Exception {
        // #270 load-bearing disagreement test — the payload field DECLARES a curated
        // value-object (`field.object @objectRef: Highlight, isArray: true`) AND carries
        // an `origin.collection @via "Author.posts"` walking to a DIFFERENT, fuller
        // entity (Post). Expected:
        //   (a) `java.util.List<HighlightPayload> posts` — the DECLARATION wins;
        //   (b) HighlightPayload.java (the curated VO) is emitted, PostPayload.java is
        //       NOT — the silent payload-bloat leak the prompt pillar exists to prevent.
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
                    { "field.string": { "name": "title" } },
                    { "field.string": { "name": "body" } },
                    { "field.string": { "name": "internalNotes" } }
                ] } },
                { "object.value": { "name": "Highlight", "children": [
                    { "field.string": { "name": "snippet" } }
                ] } },
                { "object.value": { "name": "AuthorDigest", "children": [
                    { "field.object": { "name": "posts", "@objectRef": "Highlight",
                        "isArray": true, "children": [
                        { "origin.collection": { "@via": "Author.posts" } }
                    ] } }
                ] } },
                { "template.prompt": { "name": "AuthorDigestView",
                    "@payloadRef": "AuthorDigest", "@textRef": "demo/digest" } }
              ] }
            }
            """;
        Path outDir = tempFolder.newFolder("payload-disagree").toPath();
        Path workspace = tempFolder.newFolder("payload-disagree-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "payload-disagree", fixture);

        SpringPayloadGenerator gen = new SpringPayloadGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path parentFile = outDir.resolve("acme/demo/prompts/AuthorDigestViewPayload.java");
        Path curatedFile = outDir.resolve("acme/demo/prompts/HighlightPayload.java");
        Path entityFile = outDir.resolve("acme/demo/prompts/PostPayload.java");
        assertTrue("expected " + parentFile, Files.exists(parentFile));
        assertTrue("expected curated " + curatedFile, Files.exists(curatedFile));
        assertFalse("PostPayload.java (the @via entity) must NOT be emitted",
            Files.exists(entityFile));

        String parentSrc = Files.readString(parentFile);
        // (a) DECLARED wins: @objectRef + isArray, not the @via walk.
        assertTrue("expected `java.util.List<HighlightPayload> posts`; saw:\n" + parentSrc,
            parentSrc.contains("java.util.List<HighlightPayload> posts"));
        assertFalse("parent must NOT reference PostPayload; saw:\n" + parentSrc,
            parentSrc.contains("PostPayload"));

        String curatedSrc = Files.readString(curatedFile);
        // (b) the closure emits the curated VO's shape, not the fuller entity's.
        assertTrue("expected `public record HighlightPayload(`; saw:\n" + curatedSrc,
            curatedSrc.contains("public record HighlightPayload("));
        assertTrue("expected `String snippet`; saw:\n" + curatedSrc,
            curatedSrc.contains("String snippet"));
        assertFalse("curated record must NOT carry the entity's fields; saw:\n" + curatedSrc,
            curatedSrc.contains("internalNotes"));
    }

    /**
     * #270 / ADR-0044 name-map gate (positive direction) — a {@code field.object}
     * {@code @objectRef} that ALSO carries an origin child still contributes its
     * DECLARED edge to the name-map closure. Two same-short-named {@code Note} VOs
     * (one reached through the origin-carrying field, one plain) must BOTH receive
     * package-qualified names; if the origin-carrying edge were dropped from the
     * closure, the collision would go undetected and both would fall back to a
     * clobbered bare {@code NotePayload}.
     */
    @Test
    public void originCarryingObjectFieldStaysInNameMapClosure() throws Exception {
        Path fxDir = tempFolder.newFolder("xpkg-origin-pos-fx").toPath();
        Files.writeString(fxDir.resolve("meta.alpha.json"), """
            {
              "metadata.root": { "package": "acme::alpha", "children": [
                { "object.value": { "name": "Note", "children": [
                    { "field.string": { "name": "alphaText" } }
                ] } }
              ] }
            }
            """);
        Files.writeString(fxDir.resolve("meta.beta.json"), """
            {
              "metadata.root": { "package": "acme::beta", "children": [
                { "object.value": { "name": "Note", "children": [
                    { "field.string": { "name": "betaText" } }
                ] } }
              ] }
            }
            """);
        Files.writeString(fxDir.resolve("meta.app.json"), """
            {
              "metadata.root": { "package": "acme::app", "children": [
                { "object.entity": { "name": "Author", "children": [
                    { "field.long": { "name": "id" } },
                    { "relationship.aggregation": { "name": "posts",
                        "@objectRef": "Post", "@cardinality": "many" } }
                ] } },
                { "object.entity": { "name": "Post", "children": [
                    { "field.long":   { "name": "id" } },
                    { "field.string": { "name": "internalNotes" } }
                ] } },
                { "object.value": { "name": "Digest", "children": [
                    { "field.object": { "name": "fromAlpha",
                        "@objectRef": "acme::alpha::Note", "children": [
                        { "origin.collection": { "@via": "Author.posts" } }
                    ] } },
                    { "field.object": { "name": "fromBeta",
                        "@objectRef": "acme::beta::Note" } }
                ] } },
                { "template.output": { "name": "DigestDoc",
                    "@payloadRef": "Digest", "@textRef": "app/digest", "@format": "json" } }
              ] }
            }
            """);

        Path outDir = tempFolder.newFolder("xpkg-origin-pos").toPath();
        MetaDataLoader loader = loadMultiFile("xpkg-origin-pos",
            fxDir.resolve("meta.alpha.json"),
            fxDir.resolve("meta.beta.json"),
            fxDir.resolve("meta.app.json"));

        SpringPayloadGenerator gen = new SpringPayloadGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path prompts = outDir.resolve("acme/app/prompts");
        assertTrue("expected AcmeAlphaNotePayload.java (origin-carrying declared edge stays in closure)",
            Files.exists(prompts.resolve("AcmeAlphaNotePayload.java")));
        assertTrue("expected AcmeBetaNotePayload.java",
            Files.exists(prompts.resolve("AcmeBetaNotePayload.java")));
        assertFalse("must NOT emit a clobbered bare NotePayload.java",
            Files.exists(prompts.resolve("NotePayload.java")));
        assertFalse("must NOT emit PostPayload.java (the ignored @via entity)",
            Files.exists(prompts.resolve("PostPayload.java")));
        String digest = Files.readString(prompts.resolve("DigestDocPayload.java"));
        assertTrue("fromAlpha must type AcmeAlphaNotePayload; saw:\n" + digest,
            digest.contains("AcmeAlphaNotePayload fromAlpha"));
        assertTrue("fromBeta must type AcmeBetaNotePayload; saw:\n" + digest,
            digest.contains("AcmeBetaNotePayload fromBeta"));
    }

    /**
     * #270 / ADR-0044 name-map gate (negative direction) — a field carrying ONLY
     * {@code origin.collection} (a non-object field) contributes NOTHING to the
     * name-map closure. The {@code @via} walk reaches {@code acme::beta::Note},
     * which shares a bare short name with the declared {@code acme::alpha::Note};
     * were the retired collection edge still in the closure, the two would collide
     * and both would qualify. Instead the declared Note stays BARE.
     */
    @Test
    public void originCollectionOnlyFieldContributesNothingToNameMap() throws Exception {
        Path fxDir = tempFolder.newFolder("xpkg-origin-neg-fx").toPath();
        Files.writeString(fxDir.resolve("meta.alpha.json"), """
            {
              "metadata.root": { "package": "acme::alpha", "children": [
                { "object.value": { "name": "Note", "children": [
                    { "field.string": { "name": "alphaText" } }
                ] } }
              ] }
            }
            """);
        Files.writeString(fxDir.resolve("meta.beta.json"), """
            {
              "metadata.root": { "package": "acme::beta", "children": [
                { "object.value": { "name": "Note", "children": [
                    { "field.string": { "name": "betaText" } }
                ] } }
              ] }
            }
            """);
        Files.writeString(fxDir.resolve("meta.app.json"), """
            {
              "metadata.root": { "package": "acme::app", "children": [
                { "object.entity": { "name": "Author", "children": [
                    { "field.long": { "name": "id" } },
                    { "relationship.aggregation": { "name": "notes",
                        "@objectRef": "acme::beta::Note", "@cardinality": "many" } }
                ] } },
                { "object.value": { "name": "Digest", "children": [
                    { "field.object": { "name": "fromAlpha",
                        "@objectRef": "acme::alpha::Note" } },
                    { "field.string": { "name": "posts", "children": [
                        { "origin.collection": { "@via": "Author.notes" } }
                    ] } }
                ] } },
                { "template.output": { "name": "DigestDoc",
                    "@payloadRef": "Digest", "@textRef": "app/digest", "@format": "json" } }
              ] }
            }
            """);

        Path outDir = tempFolder.newFolder("xpkg-origin-neg").toPath();
        MetaDataLoader loader = loadMultiFile("xpkg-origin-neg",
            fxDir.resolve("meta.alpha.json"),
            fxDir.resolve("meta.beta.json"),
            fxDir.resolve("meta.app.json"));

        SpringPayloadGenerator gen = new SpringPayloadGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path prompts = outDir.resolve("acme/app/prompts");
        // The declared Note is UNIQUE in the closure (the origin-only field
        // contributes nothing), so it keeps its bare name.
        Path bare = prompts.resolve("NotePayload.java");
        assertTrue("expected bare NotePayload.java (no collision without the origin edge)",
            Files.exists(bare));
        assertTrue("bare NotePayload must carry the DECLARED alpha shape",
            Files.readString(bare).contains("String alphaText"));
        assertFalse("must NOT package-qualify (no collision): AcmeAlphaNotePayload.java",
            Files.exists(prompts.resolve("AcmeAlphaNotePayload.java")));
        assertFalse("must NOT package-qualify (no collision): AcmeBetaNotePayload.java",
            Files.exists(prompts.resolve("AcmeBetaNotePayload.java")));
        String digest = Files.readString(prompts.resolve("DigestDocPayload.java"));
        assertTrue("posts must be the DECLARED String scalar; saw:\n" + digest,
            digest.contains("String posts"));
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
        // field.object + a field carrying an (ignored, #270) passthrough origin.
        // All four must reach the parent record with their DECLARED types;
        // previous scalarFields() filter dropped the two object refs.
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

    /**
     * ADR-0044 (#219 stage 3) — two {@code object.value} {@code Note}s in different
     * packages ({@code acme::alpha} / {@code acme::beta}), both reachable from one
     * payload by FQN {@code @objectRef}, must emit as TWO distinct package-qualified
     * records ({@code AcmeAlphaNotePayload} / {@code AcmeBetaNotePayload}) into the
     * output package — never one clobbered {@code NotePayload.java} (the pre-fix bug
     * wrote both records to the same path, last-wins, dropping the alpha shape).
     * Loads the SHARED cross-port corpus so this is the same oracle every port runs.
     */
    @Test
    public void crossPackageCollisionEmitsDistinctPackageQualifiedRecords() throws Exception {
        Path corpus = findCorpus();
        assertTrue("shared corpus fixtures/template-output-render-conformance must be reachable",
            corpus != null && Files.exists(corpus.resolve("xpkg-collision/meta.app.json")));
        Path xpkg = corpus.resolve("xpkg-collision");

        Path outDir = tempFolder.newFolder("payload-xpkg").toPath();
        MetaDataLoader loader = loadMultiFile("xpkg",
            xpkg.resolve("meta.alpha.json"),
            xpkg.resolve("meta.beta.json"),
            xpkg.resolve("meta.app.json"));

        SpringPayloadGenerator gen = new SpringPayloadGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path prompts = outDir.resolve("acme/app/prompts");
        Path alpha = prompts.resolve("AcmeAlphaNotePayload.java");
        Path beta = prompts.resolve("AcmeBetaNotePayload.java");
        // Two DISTINCT records — never the shadowed bare name.
        assertTrue("expected AcmeAlphaNotePayload.java at " + alpha, Files.exists(alpha));
        assertTrue("expected AcmeBetaNotePayload.java at " + beta, Files.exists(beta));
        assertFalse("must NOT emit a clobbered bare NotePayload.java",
            Files.exists(prompts.resolve("NotePayload.java")));
        // Each record carries its OWN package's shape.
        assertTrue("AcmeAlphaNotePayload must carry alphaText",
            Files.readString(alpha).contains("String alphaText"));
        assertTrue("AcmeBetaNotePayload must carry betaText",
            Files.readString(beta).contains("String betaText"));
        // The primary payload references the two distinct qualified records.
        String digest = Files.readString(prompts.resolve("DigestDocPayload.java"));
        assertTrue("DigestDocPayload.fromAlpha must type AcmeAlphaNotePayload; saw:\n" + digest,
            digest.contains("AcmeAlphaNotePayload fromAlpha"));
        assertTrue("DigestDocPayload.fromBeta must type AcmeBetaNotePayload; saw:\n" + digest,
            digest.contains("AcmeBetaNotePayload fromBeta"));
    }

    /** Walk up from {@code user.dir} to the repo-root shared corpus, or {@code null}. */
    private static Path findCorpus() {
        Path p = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        while (p != null && !Files.exists(p.resolve("fixtures/template-output-render-conformance"))) {
            p = p.getParent();
        }
        return p != null ? p.resolve("fixtures/template-output-render-conformance") : null;
    }

    /** Load several metadata files into one merged loader (multi-package fixtures). */
    private MetaDataLoader loadMultiFile(String baseName, Path... files) throws Exception {
        List<URI> uris = new ArrayList<>();
        for (Path f : files) {
            uris.add(URIHelper.toURI("model:file:" + f.toAbsolutePath().toString().replace('\\', '/')));
        }
        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL,
            "spring-test-" + baseName);
        loader.setSourceURIs(uris);
        loader.init();
        return loader;
    }
}
