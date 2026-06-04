package com.metaobjects.conformance;

import com.metaobjects.io.json.CanonicalJsonSerializer;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.*;

/**
 * ADR-0023 — the conformance runner hard-fails a happy-path fixture (no
 * {@code expected-errors.json}, but ≥1 metadata-expectation file) when the
 * loader RECORDS any error under strict load. Mirrors the TS reference
 * (commit 9269f0ef) {@code runner.test.ts} hard-fail: a made-up {@code @}-attr
 * is recorded as {@code ERR_UNKNOWN_ATTR} (non-fatally) by the strict parser,
 * and the runner must turn that recorded error into a fixture failure that
 * names the unexpected code.
 *
 * <p>Drives {@link ConformanceTest#runConformanceChecks} against synthetic
 * fixtures written to a {@link TemporaryFolder} (NOT the shared corpus), so the
 * hard-fail is exercised in isolation without adding a permanently-failing
 * fixture to {@code fixtures/conformance/}.</p>
 */
public class StrictRunnerHardFailTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    /** Write a fixture dir under a temp corpus, then discover + return the Fixture. */
    private FixtureDiscovery.Fixture buildFixture(String name,
                                                  String inputJson,
                                                  boolean withExpectedJson) throws IOException {
        Path corpus = tmp.getRoot().toPath();
        Path dir = Files.createDirectories(corpus.resolve(name));
        Path inputDir = Files.createDirectories(dir.resolve("input"));
        Files.write(inputDir.resolve("meta.test.json"), inputJson.getBytes(StandardCharsets.UTF_8));
        if (withExpectedJson) {
            // Produce the canonical expected.json by serializing a strict load, so
            // the byte-compare check passes and the ONLY thing that can fail the
            // fixture is the ADR-0023 hard-fail on recorded errors.
            MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, "acme");
            loader.init();
            loader.load(List.of(new InMemoryStringSource(inputJson, "meta.test.json")));
            String canonical = CanonicalJsonSerializer.canonicalSerialize(loader.getRoot()).trim();
            Files.write(dir.resolve("expected.json"), canonical.getBytes(StandardCharsets.UTF_8));
        }
        List<FixtureDiscovery.Fixture> all = FixtureDiscovery.discover(corpus);
        return all.stream().filter(f -> f.name.equals(name)).findFirst()
            .orElseThrow(() -> new AssertionError("fixture not discovered: " + name));
    }

    private static String entity(String fieldChild) {
        return "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Widget\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    " + fieldChild + ","
            + "    { \"identity.primary\": { \"@fields\": \"id\" } }"
            + "  ] } }"
            + "] } }";
    }

    private static boolean namesUnknownAttr(List<String> failures) {
        return failures.stream().anyMatch(f -> f.contains("ERR_UNKNOWN_ATTR"));
    }

    // -----------------------------------------------------------------------
    // 1 — Happy-path fixture with a made-up scalar @-attr → runner HARD-FAILS,
    //     naming ERR_UNKNOWN_ATTR.
    // -----------------------------------------------------------------------

    @Test
    public void happyPathWithMadeUpAttrHardFails() throws IOException {
        FixtureDiscovery.Fixture fix = buildFixture(
            "happy-made-up-attr",
            entity("{ \"field.string\": { \"name\": \"code\", \"@bogusAttr\": \"x\" } }"),
            true);
        assertFalse("control: fixture must not declare expected-errors.json", fix.hasExpectedErrors);
        assertTrue("control: fixture must declare expected.json", fix.hasExpected);

        List<String> failures = new ArrayList<>();
        ConformanceTest.runConformanceChecks(fix, failures);

        assertFalse("ADR-0023: a happy-path fixture that records an error must FAIL", failures.isEmpty());
        assertTrue("the failure must name the unexpected ERR_UNKNOWN_ATTR; got: " + failures,
            namesUnknownAttr(failures));
    }

    // -----------------------------------------------------------------------
    // 2 — Clean happy-path fixture (no made-up attr) → runner PASSES (no failures).
    // -----------------------------------------------------------------------

    @Test
    public void cleanHappyPathPasses() throws IOException {
        FixtureDiscovery.Fixture fix = buildFixture(
            "happy-clean",
            entity("{ \"field.string\": { \"name\": \"code\", \"@maxLength\": 64 } }"),
            true);
        List<String> failures = new ArrayList<>();
        ConformanceTest.runConformanceChecks(fix, failures);
        assertTrue("a clean happy-path fixture must record ZERO failures; got: " + failures,
            failures.isEmpty());
    }

    // -----------------------------------------------------------------------
    // 3 — attr.properties exemption end-to-end through the runner: an undeclared
    //     OBJECT-valued @-attr is a sanctioned property bag → runner PASSES.
    // -----------------------------------------------------------------------

    @Test
    public void objectBagHappyPathPasses() throws IOException {
        FixtureDiscovery.Fixture fix = buildFixture(
            "happy-object-bag",
            entity("{ \"field.string\": { \"name\": \"code\","
                + " \"@uiHints\": { \"group\": \"inventory\", \"tier\": \"standard\" } } }"),
            true);
        List<String> failures = new ArrayList<>();
        ConformanceTest.runConformanceChecks(fix, failures);
        assertTrue("an undeclared object-valued @-attr (attr.properties bag) must NOT fail the "
                + "runner under ADR-0023; got: " + failures,
            failures.isEmpty());
    }
}
