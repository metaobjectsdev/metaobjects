/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.conformance;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.io.json.CanonicalJsonSerializer;
import com.metaobjects.loader.InMemoryMetaDataSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataSource;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;
import org.junit.runners.Parameterized.Parameter;
import org.junit.runners.Parameterized.Parameters;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Parametric Java conformance runner over the shared {@code fixtures/conformance/} corpus.
 *
 * <p>Java port of the C# {@code ConformanceTests} class. Each discovered fixture
 * produces two parameterized JUnit cases:</p>
 * <ul>
 *   <li><strong>lint</strong> — corpus-integrity check: every code in
 *       {@code expected-errors.json} must be present in the canonical
 *       {@code ERROR-CODES.json} registry.</li>
 *   <li><strong>conformance</strong> — exercises the Java loader pipeline against
 *       the fixture's {@code input/} files and matches the result against the
 *       fixture's expectation files. Per-fixture status is classified against
 *       {@code conformance-expected-failures.json}; only {@code pass} and
 *       {@code known-gap} are acceptable.</li>
 * </ul>
 *
 * <p><strong>Java-specific behaviour:</strong></p>
 * <ul>
 *   <li>Provider set: Java uses ServiceLoader auto-registration. The
 *       {@code providers.json} flag is captured for honest fixture lint but
 *       the runner uses the default service-loaded provider set for every
 *       fixture. Fixtures requiring an alternate provider set go in the
 *       ledger.</li>
 *   <li>Loader-root-name leak: the Java loader's MetaRoot name is the loader
 *       name (a known H3a limitation). The runner pre-scans the first input
 *       file's {@code metadata.root.package} and uses it as the loader name
 *       so canonical round-trips produce the right top-level {@code package}.</li>
 *   <li>Warnings: the Java loader has no warning surface yet. Fixtures with
 *       {@code expected-warnings.json} are ledgered as gaps.</li>
 *   <li>Effective serialization + script execution: not implemented in the
 *       Java harness yet. Fixtures using {@code expected-effective.json} or
 *       {@code script.json} are ledgered.</li>
 * </ul>
 */
@RunWith(Parameterized.class)
public class ConformanceTest {

    // -----------------------------------------------------------------------
    // Static corpus + ledger state — initialised once per test run
    // -----------------------------------------------------------------------

    private static final Path CORPUS = CorpusRoot.locate();
    private static final Set<String> REGISTERED_CODES = FixtureLint.loadRegisteredCodes(CORPUS);
    private static final ExpectedFailures.Ledger LEDGER = ExpectedFailures.load(locateLedger());

    // ERR_* token in legacy message-only exceptions; e.g. "... ERR_BAD_ATTR_VALUE: ..."
    private static final Pattern ERR_TOKEN = Pattern.compile("\\bERR_[A-Z][A-Z0-9_]*\\b");

    // -----------------------------------------------------------------------
    // Parameter feed — one row per discovered fixture
    // -----------------------------------------------------------------------

    @Parameters(name = "{0}")
    public static Collection<Object[]> fixtures() {
        List<FixtureDiscovery.Fixture> all = FixtureDiscovery.discover(CORPUS);
        List<Object[]> rows = new ArrayList<>(all.size());
        for (FixtureDiscovery.Fixture f : all) {
            rows.add(new Object[]{f.name, f});
        }
        return rows;
    }

    /** First arg drives the JUnit display name. */
    @Parameter(0)
    public String fixtureName;

    @Parameter(1)
    public FixtureDiscovery.Fixture fix;

    // -----------------------------------------------------------------------
    // Lint test — corpus integrity, adapter-independent
    // -----------------------------------------------------------------------

    @Test
    public void lint() {
        List<String> problems = FixtureLint.lintFixture(fix, REGISTERED_CODES);
        if (!problems.isEmpty()) {
            fail("Fixture lint problems for " + fix.name + ":\n  - "
                + String.join("\n  - ", problems));
        }
    }

    // -----------------------------------------------------------------------
    // Conformance test — full pipeline through MetaDataLoader + CanonicalJsonSerializer
    // -----------------------------------------------------------------------

    @Test
    public void conformance() {
        List<String> failures = new ArrayList<>();
        runConformanceChecks(fix, failures);
        boolean passed = failures.isEmpty();

        String status = ExpectedFailures.classify(passed, fix.name, LEDGER);

        String detail = passed
            ? "(no failures)"
            : String.join("; ", failures);

        assertTrue(
            fix.name + " [" + status + "]: " + detail,
            "pass".equals(status) || "known-gap".equals(status));
    }

    // -----------------------------------------------------------------------
    // Conformance pipeline
    // -----------------------------------------------------------------------

    /**
     * Run the full check suite for one fixture and accumulate failure strings.
     * Mirrors {@code ConformanceTests.RunChecks} in the C# runner, restricted
     * to the checks the Java harness currently supports.
     */
    private static void runConformanceChecks(FixtureDiscovery.Fixture fix,
                                              List<String> failures) {
        // -- Unsupported-feature fast-fails (honest gaps) --------------------
        // The Java harness does not yet implement effective serialization,
        // warnings, scripts, or provider-set composition. Anything that needs
        // them fails honestly so the ledger captures the gap.

        if (fix.hasProvidersJson) {
            failures.add("providers.json (provider-set composition) not supported by Java harness");
        }
        if (fix.hasExpectedEffective) {
            failures.add("expected-effective.json (effective serialization) not supported by Java harness");
        }
        if (fix.hasExpectedWarnings) {
            failures.add("expected-warnings.json (warnings surface) not supported by Java harness");
        }
        if (fix.hasScript) {
            failures.add("script.json (operation scripts) not supported by Java harness");
        }

        // -- Load all input files --------------------------------------------
        List<Path> inputFiles = listInputFiles(fix.inputDir);
        if (inputFiles.isEmpty()) {
            failures.add("no input files under " + fix.inputDir);
            return;
        }

        // Pre-scan the first input file for its declared package so the
        // loader name matches what the serializer will emit as the top-level
        // `package` key (mitigates the Java loader-root-name leak).
        String loaderName = detectLoaderName(inputFiles);

        LoaderOptions opts = LoaderOptions.create(false, false, true);
        MetaDataLoader loader = new MetaDataLoader(opts, MetaDataLoader.SUBTYPE_MANUAL, loaderName);
        loader.init();

        List<String> errorCodesSeen = new ArrayList<>();
        try {
            List<MetaDataSource> sources = new ArrayList<>(inputFiles.size());
            for (Path file : inputFiles) {
                String content = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
                sources.add(new InMemoryMetaDataSource(content, file.getFileName().toString()));
            }
            loader.load(sources);
        } catch (MetaDataException ex) {
            errorCodesSeen.add(extractErrorCode(ex));
        } catch (IOException ex) {
            failures.add("input read error: " + ex.getMessage());
            return;
        } catch (RuntimeException ex) {
            // A non-MetaDataException escaping the loader is itself a failure.
            failures.add("unexpected runtime exception during load: "
                + ex.getClass().getSimpleName() + ": " + ex.getMessage());
            return;
        }

        // -- expected-errors check ------------------------------------------
        if (fix.hasExpectedErrors) {
            List<String> want;
            try {
                JsonElement parsed = JsonParser.parseString(new String(
                    Files.readAllBytes(fix.dir.resolve("expected-errors.json")),
                    StandardCharsets.UTF_8));
                want = FixtureLint.parseExpectedErrors(parsed);
            } catch (Exception ex) {
                failures.add("expected-errors.json parse error: " + ex.getMessage());
                return;
            }
            TreeSet<String> wantSet = new TreeSet<>(want);
            TreeSet<String> gotSet = new TreeSet<>(errorCodesSeen);
            if (!wantSet.equals(gotSet)) {
                failures.add("expected errors " + wantSet + ", got " + gotSet);
            }
            return;
        }

        // If the fixture is NOT an expected-errors fixture but the load
        // produced an error, we can't continue with tree-dependent checks.
        if (!errorCodesSeen.isEmpty()) {
            failures.add("load produced errors " + errorCodesSeen
                + " — cannot run tree-dependent checks");
            return;
        }

        // -- expected.json check --------------------------------------------
        if (fix.hasExpected) {
            String want;
            try {
                want = new String(Files.readAllBytes(fix.dir.resolve("expected.json")),
                    StandardCharsets.UTF_8).trim();
            } catch (IOException ex) {
                failures.add("expected.json read error: " + ex.getMessage());
                return;
            }
            String got = CanonicalJsonSerializer.canonicalSerialize(loader.getRoot()).trim();
            if (!want.equals(got)) {
                failures.add("canonical serialization mismatch");
            }
        }

        // -- no-expectation safeguard ---------------------------------------
        if (!fix.hasExpected
            && !fix.hasExpectedEffective
            && !fix.hasExpectedErrors
            && !fix.hasExpectedWarnings
            && !fix.hasScript
            && failures.isEmpty()) {
            failures.add("fixture declares no expectation files");
        }
    }

    // -----------------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------------

    private static List<Path> listInputFiles(Path inputDir) {
        List<Path> files = new ArrayList<>();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(inputDir, "*.json")) {
            for (Path p : stream) {
                if (Files.isRegularFile(p)) {
                    files.add(p);
                }
            }
        } catch (IOException e) {
            throw new AssertionError("Failed to enumerate input files in " + inputDir, e);
        }
        Collections.sort(files);
        return files;
    }

    /**
     * Extract the structured ErrorCode if the exception carries one;
     * otherwise scan the message text for an {@code ERR_*} token.
     * Returns {@code ERR_UNKNOWN} when neither yields anything.
     */
    private static String extractErrorCode(MetaDataException ex) {
        return ex.getCode()
            .map(Enum::name)
            .orElseGet(() -> scanMessageForErrorCode(ex.getMessage()));
    }

    private static String scanMessageForErrorCode(String message) {
        if (message == null) return ErrorCode.ERR_UNKNOWN.name();
        Matcher m = ERR_TOKEN.matcher(message);
        if (m.find()) {
            return m.group();
        }
        return ErrorCode.ERR_UNKNOWN.name();
    }

    /**
     * Pre-scan the first input file's {@code metadata.root.package} and return
     * it. Empty string when the input declares no package. Used as the loader
     * name to mitigate the loader-root-name leak in the Java loader (the
     * serializer emits the loader's name as the top-level {@code package} key).
     */
    private static String detectLoaderName(List<Path> inputFiles) {
        for (Path p : inputFiles) {
            try {
                String content = new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
                JsonElement el = JsonParser.parseString(content);
                if (!el.isJsonObject()) continue;
                JsonObject root = el.getAsJsonObject();
                JsonElement metaRootEl = root.get("metadata.root");
                if (metaRootEl == null || !metaRootEl.isJsonObject()) continue;
                JsonElement pkgEl = metaRootEl.getAsJsonObject().get("package");
                if (pkgEl != null && pkgEl.isJsonPrimitive()
                    && pkgEl.getAsJsonPrimitive().isString()) {
                    return pkgEl.getAsString();
                }
                return ""; // metadata.root present but no package — loader name empty
            } catch (Exception ignore) {
                // Try the next file if this one can't be parsed.
            }
        }
        return "";
    }

    /**
     * Locate the per-language ledger file. Lives at
     * {@code server/java/metadata/conformance-expected-failures.json}. We
     * resolve it by walking up from CWD just like the corpus root, so the
     * runner works equally well from the metadata-module dir, the java root,
     * or the repo root.
     */
    private static Path locateLedger() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve("server/java/metadata/conformance-expected-failures.json");
            if (Files.isRegularFile(candidate)) {
                return candidate;
            }
            // Direct hit when CWD is server/java/metadata.
            Path local = dir.resolve("conformance-expected-failures.json");
            if (Files.isRegularFile(local) && dir.getFileName() != null
                && "metadata".equals(dir.getFileName().toString())) {
                return local;
            }
            dir = dir.getParent();
        }
        // Fall back to a non-existent path; ExpectedFailures.load returns empty.
        return Paths.get("conformance-expected-failures.json").toAbsolutePath();
    }
}
