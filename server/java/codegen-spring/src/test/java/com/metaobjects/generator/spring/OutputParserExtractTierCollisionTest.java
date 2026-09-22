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

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * ADR-0056 — the template tier references a value object's OWN record and declares none.
 * {@link SpringValueObjectGenerator} writes each value object's record once, in its own
 * package; {@link SpringOutputParserGenerator} and {@link SpringRenderHelperGenerator} name it
 * fully qualified. So:
 * <ul>
 *   <li>a value object reached from templates in two packages exists ONCE and both compile
 *       against it (#387 — the old per-template payload copy landed in only one package);</li>
 *   <li>two same-short-name value objects in different packages need no type renaming — the
 *       packages tell them apart. Only the parser's private {@code from<Name>} mapper METHODS,
 *       which share one class, are package-qualified on a collision.</li>
 * </ul>
 *
 * <p>Also covers the ADR-0042 build-time {@code @payloadRef} resolver fix
 * (checkpoint 3): {@code resolveValueObject} was previously a package-BLIND
 * bare-name-anywhere scan (first match in load order wins); it now resolves in the
 * referring template's OWN package first, matching the loader's own
 * {@code ValidationPhase} validation of the same ref.
 */
public class OutputParserExtractTierCollisionTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    // -------------------------------------------------------------------------
    // Step 1 (brief) — shared xpkg-collision-json corpus: nested field.object
    // collision (acme::alpha::Note / acme::beta::Note), both reachable from one
    // payload (Digest) via FQN @objectRef.
    // -------------------------------------------------------------------------

    @Test
    public void xpkgCollisionJsonEmitsDistinctMappersForBothCollidingNestedVos() throws Exception {
        Path corpus = findCorpus();
        assertTrue("shared corpus fixtures/template-output-render-conformance must be reachable",
            corpus != null && Files.exists(corpus.resolve("xpkg-collision-json/meta.app.json")));
        Path xpkg = corpus.resolve("xpkg-collision-json");

        Path outDir = tempFolder.newFolder("outputparser-xpkg").toPath();
        MetaDataLoader loader = loadMultiFile("xpkg-op",
            xpkg.resolve("meta.alpha.json"),
            xpkg.resolve("meta.beta.json"),
            xpkg.resolve("meta.app.json"));

        SpringOutputParserGenerator gen = new SpringOutputParserGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path parser = outDir.resolve("acme/app/prompts/DigestPromptParser.java");
        assertTrue("expected DigestPromptParser.java at " + parser, Files.exists(parser));
        String src = Files.readString(parser);

        // Each Note maps into its OWN package's record. The two mappers share this class, so
        // their METHOD names are package-qualified; the types need no renaming.
        assertTrue("expected a fromAcmeAlphaNote mapper returning acme.alpha.Note; saw:\n" + src,
            src.contains("private static acme.alpha.Note fromAcmeAlphaNote(java.util.Map<String, Object> d)"));
        assertTrue("expected a fromAcmeBetaNote mapper returning acme.beta.Note; saw:\n" + src,
            src.contains("private static acme.beta.Note fromAcmeBetaNote(java.util.Map<String, Object> d)"));
        assertFalse("must NEVER emit a colliding bare fromNote mapper; saw:\n" + src,
            src.contains("fromNote("));
        assertFalse("no template-tier payload type survives; saw:\n" + src, src.contains("NotePayload"));

        // The root mapper's fromAlpha/fromBeta fields route to their OWN mapper.
        assertTrue("fromAlpha field must recurse into fromAcmeAlphaNote; saw:\n" + src,
            src.contains("fromAcmeAlphaNote(asMap(d.get(\"fromAlpha\")))"));
        assertTrue("fromBeta field must recurse into fromAcmeBetaNote; saw:\n" + src,
            src.contains("fromAcmeBetaNote(asMap(d.get(\"fromBeta\")))"));

        // The whole graph compiles against the value-object records.
        SpringValueObjectGenerator voGen = new SpringValueObjectGenerator();
        voGen.setArgs(args);
        voGen.execute(loader);
        SpringTestFixtures.compileGenerated(outDir, tempFolder.newFolder("outputparser-xpkg-classes").toPath());
    }

    // -------------------------------------------------------------------------
    // #387 — one shared view, two consuming packages, one generator run.
    // -------------------------------------------------------------------------

    private static final String SHARED_FIXTURE = """
        { "metadata.root": { "package": "acme::shared", "children": [
            { "object.value": { "name": "StyleView", "children": [
                { "field.string": { "name": "tone", "@required": true } }
            ] } }
        ] } }
        """;

    private static String consumerFixture(String pkg, String prefix) {
        return """
            { "metadata.root": { "package": "acme::%1$s", "children": [
                { "object.value": { "name": "%2$sPayload", "children": [
                    { "field.object": { "name": "style", "@objectRef": "acme::shared::StyleView" } }
                ] } },
                { "template.output": { "name": "%2$sDoc", "@payloadRef": "%2$sPayload",
                    "@textRef": "%1$s/doc", "@format": "text" } },
                { "template.prompt": { "name": "%2$sAsk", "@payloadRef": "%2$sPayload",
                    "@responseRef": "%2$sPayload", "@textRef": "%1$s/doc", "@responseFormat": "json" } }
            ] } }
            """.formatted(pkg, prefix);
    }

    @Test
    public void aValueObjectSharedByTwoPackagesIsEmittedOnceAndReferencedFromBoth() throws Exception {
        Path workspace = tempFolder.newFolder("shared-view").toPath();
        Path shared = workspace.resolve("meta.shared.json");
        Path alpha = workspace.resolve("meta.alpha.json");
        Path beta = workspace.resolve("meta.beta.json");
        Files.writeString(shared, SHARED_FIXTURE);
        Files.writeString(alpha, consumerFixture("alpha", "Alpha"));
        Files.writeString(beta, consumerFixture("beta", "Beta"));
        Path templates = tempFolder.newFolder("shared-view-templates").toPath();
        for (String pkg : List.of("alpha", "beta")) {
            Path t = templates.resolve(pkg + "/doc.mustache");
            Files.createDirectories(t.getParent());
            Files.writeString(t, "{{style.tone}}");
        }
        MetaDataLoader loader = loadMultiFile("shared-view", shared, alpha, beta);

        Path outDir = tempFolder.newFolder("shared-view-out").toPath();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        args.put("templateRoot", templates.toString());
        for (com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?> g : List.of(
                new SpringValueObjectGenerator(), new SpringOutputParserGenerator(),
                new SpringRenderHelperGenerator())) {
            g.setArgs(args);
            g.execute(loader);
        }

        List<String> files;
        try (java.util.stream.Stream<Path> walk = Files.walk(outDir)) {
            files = walk.filter(Files::isRegularFile).map(f -> outDir.relativize(f).toString()).sorted().toList();
        }
        // The shared view exists exactly once, in its own package.
        assertTrue("expected acme/shared/StyleView.java; files=" + files,
            files.contains("acme/shared/StyleView.java"));
        assertTrue("the shared view must be emitted exactly once; files=" + files,
            files.stream().filter(f -> f.contains("StyleView")).count() == 1);
        // The prompts packages hold only template-keyed artifacts.
        assertTrue("nothing value-shaped in a prompts package; files=" + files,
            files.stream().filter(f -> f.contains("/prompts/"))
                .allMatch(f -> f.endsWith("Parser.java") || f.endsWith("RenderHelper.java")));

        SpringTestFixtures.compileGenerated(outDir, tempFolder.newFolder("shared-view-classes").toPath());
    }

    // -------------------------------------------------------------------------
    // A non-colliding nested VO's mapper is named for its bare short name.
    // -------------------------------------------------------------------------

    private static final String NO_CHURN_FIXTURE = """
        {
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "Detail", "children": [
                { "field.string": { "name": "note", "@required": true } }
            ] } },
            { "object.value": { "name": "WidgetOut", "children": [
                { "field.string": { "name": "title", "@required": true } },
                { "field.object": { "name": "detail", "@objectRef": "Detail" } }
            ] } },
            { "template.prompt": {
                "name": "WidgetDoc",
                "@payloadRef": "WidgetOut",
                "@responseRef": "WidgetOut",
                "@textRef": "widget/doc",
                "@format": "text",
                "@responseFormat": "json"
            } }
          ] }
        }
        """;

    @Test
    public void noChurnNonCollidingNestedVoKeepsBareMapperName() throws Exception {
        Path outDir = tempFolder.newFolder("outputparser-nochurn").toPath();
        Path workspace = tempFolder.newFolder("outputparser-nochurn-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "nochurn", NO_CHURN_FIXTURE);

        SpringOutputParserGenerator gen = new SpringOutputParserGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path parser = outDir.resolve("acme/ai/prompts/WidgetDocParser.java");
        assertTrue("expected WidgetDocParser.java at " + parser, Files.exists(parser));
        String src = Files.readString(parser);

        assertTrue("non-colliding nested VO must keep its BARE mapper; saw:\n" + src,
            src.contains("private static acme.ai.Detail fromDetail(java.util.Map<String, Object> d)"));
        assertTrue("detail field must recurse into the bare fromDetail; saw:\n" + src,
            src.contains("fromDetail(asMap(d.get(\"detail\")))"));
        assertFalse("must NOT package-qualify a non-colliding VO", src.contains("AcmeAiDetail"));
    }

    // -------------------------------------------------------------------------
    // Checkpoint 3 — build-time @payloadRef resolver: a BARE @payloadRef that
    // cross-package-collides on its OWN name must bind the referring template's
    // OWN package, regardless of load order (was package-blind, first-match-wins).
    // -------------------------------------------------------------------------

    private static String alphaReportJson() {
        return """
            { "metadata.root": { "package": "acme::alpha", "children": [
                { "object.value": { "name": "Report", "children": [
                    { "field.string": { "name": "alphaVal", "@required": true } }
                ] } },
                { "template.prompt": {
                    "name": "ReportDocAlpha",
                    "@payloadRef": "Report",
                    "@responseRef": "Report",
                    "@textRef": "report/alpha",
                    "@format": "text",
                    "@responseFormat": "json"
                } }
            ] } }
            """;
    }

    private static String betaReportJson() {
        return """
            { "metadata.root": { "package": "acme::beta", "children": [
                { "object.value": { "name": "Report", "children": [
                    { "field.string": { "name": "betaVal", "@required": true } }
                ] } },
                { "template.prompt": {
                    "name": "ReportDocBeta",
                    "@payloadRef": "Report",
                    "@responseRef": "Report",
                    "@textRef": "report/beta",
                    "@format": "text",
                    "@responseFormat": "json"
                } }
            ] } }
            """;
    }

    @Test
    public void barePayloadRefCollisionBindsOwnPackage_alphaLoadedFirst() throws Exception {
        assertBarePayloadRefBindsOwnPackage(true);
    }

    @Test
    public void barePayloadRefCollisionBindsOwnPackage_betaLoadedFirst() throws Exception {
        assertBarePayloadRefBindsOwnPackage(false);
    }

    private void assertBarePayloadRefBindsOwnPackage(boolean alphaFirst) throws Exception {
        Path workspace = tempFolder.newFolder("bare-payloadref-" + alphaFirst).toPath();
        Path alphaFile = workspace.resolve("meta.alpha.json");
        Path betaFile = workspace.resolve("meta.beta.json");
        Files.writeString(alphaFile, alphaReportJson());
        Files.writeString(betaFile, betaReportJson());

        MetaDataLoader loader = alphaFirst
            ? loadMultiFile("bare-" + alphaFirst, alphaFile, betaFile)
            : loadMultiFile("bare-" + alphaFirst, betaFile, alphaFile);

        Path outDir = tempFolder.newFolder("bare-payloadref-out-" + alphaFirst).toPath();

        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());

        // SpringOutputParserGenerator: same resolver, same guarantee — the generated
        // mapper for each template's OWN root payload must read its OWN field name.
        SpringOutputParserGenerator parserGen = new SpringOutputParserGenerator();
        parserGen.setArgs(args);
        parserGen.execute(loader);

        String alphaParserSrc = Files.readString(outDir.resolve("acme/alpha/prompts/ReportDocAlphaParser.java"));
        String betaParserSrc = Files.readString(outDir.resolve("acme/beta/prompts/ReportDocBetaParser.java"));
        assertTrue("ReportDocAlphaParser must return acme.alpha.Report; saw:\n" + alphaParserSrc,
            alphaParserSrc.contains("public static acme.alpha.Report parse(String text)"));
        assertTrue("ReportDocBetaParser must return acme.beta.Report; saw:\n" + betaParserSrc,
            betaParserSrc.contains("public static acme.beta.Report parse(String text)"));
        assertTrue("ReportDocAlphaParser's mapper must read alphaVal; saw:\n" + alphaParserSrc,
            alphaParserSrc.contains("ExtractMap.asString(d, \"alphaVal\")"));
        assertFalse("ReportDocAlphaParser's mapper must NOT read betaVal; saw:\n" + alphaParserSrc,
            alphaParserSrc.contains("betaVal"));
        assertTrue("ReportDocBetaParser's mapper must read betaVal; saw:\n" + betaParserSrc,
            betaParserSrc.contains("ExtractMap.asString(d, \"betaVal\")"));
        assertFalse("ReportDocBetaParser's mapper must NOT read alphaVal; saw:\n" + betaParserSrc,
            betaParserSrc.contains("alphaVal"));
    }

    // -------------------------------------------------------------------------
    // Helpers.
    // -------------------------------------------------------------------------

    /** Walk up from {@code user.dir} to the repo-root shared corpus, or {@code null}. */
    private static Path findCorpus() {
        Path p = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        while (p != null && !Files.exists(p.resolve("fixtures/template-output-render-conformance"))) {
            p = p.getParent();
        }
        return p != null ? p.resolve("fixtures/template-output-render-conformance") : null;
    }

    /** Load several metadata files into one merged loader (multi-package fixtures), in the
     *  EXACT order given (MetaDataLoader does not re-sort an explicit URI list). */
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
