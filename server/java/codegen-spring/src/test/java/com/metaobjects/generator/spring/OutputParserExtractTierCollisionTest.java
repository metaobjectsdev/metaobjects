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
 * #228 — Java port of the extract/output-parser tier collision-scoped naming fix.
 * {@link SpringOutputParserGenerator} now consumes {@link SpringPayloadGenerator}'s
 * OWN ADR-0044 name map (never re-derives naming) so a cross-package short-name
 * collision on a NESTED {@code field.object} target VO gets the SAME
 * package-qualified record name the payload tier emits — a bare {@code NotePayload}
 * reference would either be a dangling class reference or (worse) a duplicate-method
 * compile error when two colliding VOs both derive {@code fromNotePayload(...)}.
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

        // Both colliding nested VOs get their OWN distinct, collision-scoped mapper —
        // never the bare `NotePayload` the payload generator no longer emits under
        // collision, and never a dropped/clobbered second mapper.
        assertTrue("expected a fromAcmeAlphaNotePayload mapper; saw:\n" + src,
            src.contains("private static AcmeAlphaNotePayload fromAcmeAlphaNotePayload(java.util.Map<String, Object> d)"));
        assertTrue("expected a fromAcmeBetaNotePayload mapper; saw:\n" + src,
            src.contains("private static AcmeBetaNotePayload fromAcmeBetaNotePayload(java.util.Map<String, Object> d)"));
        assertFalse("must NEVER reference/emit the shadowed bare fromNotePayload mapper; saw:\n" + src,
            src.contains("fromNotePayload("));
        assertFalse("must NEVER reference the shadowed bare NotePayload type; saw:\n" + src,
            src.contains("NotePayload fromNotePayload") || src.contains(" NotePayload)"));

        // The root mapper's fromAlpha/fromBeta fields route to their OWN qualified mapper.
        assertTrue("fromAlpha field must recurse into fromAcmeAlphaNotePayload; saw:\n" + src,
            src.contains("fromAcmeAlphaNotePayload(asMap(d.get(\"fromAlpha\")))"));
        assertTrue("fromBeta field must recurse into fromAcmeBetaNotePayload; saw:\n" + src,
            src.contains("fromAcmeBetaNotePayload(asMap(d.get(\"fromBeta\")))"));
    }

    // -------------------------------------------------------------------------
    // No-churn: a non-colliding nested VO keeps its bare mapper name/type — proves
    // the nameMap consultation is a no-op absent a collision (byte-identical to
    // pre-#228 output).
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
            src.contains("private static DetailPayload fromDetailPayload(java.util.Map<String, Object> d)"));
        assertTrue("detail field must recurse into the bare fromDetailPayload; saw:\n" + src,
            src.contains("fromDetailPayload(asMap(d.get(\"detail\")))"));
        assertFalse("must NOT package-qualify a non-colliding VO", src.contains("AcmeAiDetailPayload"));
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

        // SpringPayloadGenerator: each template's record must carry its OWN
        // package's field, never the other's, regardless of load order.
        SpringPayloadGenerator payloadGen = new SpringPayloadGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        payloadGen.setArgs(args);
        payloadGen.execute(loader);

        String alphaPayloadSrc = Files.readString(outDir.resolve("acme/alpha/prompts/ReportDocAlphaPayload.java"));
        String betaPayloadSrc = Files.readString(outDir.resolve("acme/beta/prompts/ReportDocBetaPayload.java"));
        assertTrue("ReportDocAlphaPayload must carry alphaVal (own package); saw:\n" + alphaPayloadSrc,
            alphaPayloadSrc.contains("String alphaVal"));
        assertFalse("ReportDocAlphaPayload must NOT carry betaVal (wrong package); saw:\n" + alphaPayloadSrc,
            alphaPayloadSrc.contains("betaVal"));
        assertTrue("ReportDocBetaPayload must carry betaVal (own package); saw:\n" + betaPayloadSrc,
            betaPayloadSrc.contains("String betaVal"));
        assertFalse("ReportDocBetaPayload must NOT carry alphaVal (wrong package); saw:\n" + betaPayloadSrc,
            betaPayloadSrc.contains("alphaVal"));

        // SpringOutputParserGenerator: same resolver, same guarantee — the generated
        // mapper for each template's OWN root payload must read its OWN field name.
        SpringOutputParserGenerator parserGen = new SpringOutputParserGenerator();
        parserGen.setArgs(args);
        parserGen.execute(loader);

        String alphaParserSrc = Files.readString(outDir.resolve("acme/alpha/prompts/ReportDocAlphaParser.java"));
        String betaParserSrc = Files.readString(outDir.resolve("acme/beta/prompts/ReportDocBetaParser.java"));
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
    // Helpers (mirrors SpringPayloadGeneratorTest's private helpers of the same name).
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
