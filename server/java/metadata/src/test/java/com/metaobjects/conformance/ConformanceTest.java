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
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataSource;
import com.metaobjects.registry.MetaDataTypeProvider;
import com.metaobjects.source.CodeSource;
import com.metaobjects.source.ErrorSource;
import com.metaobjects.source.JsonSource;
import com.metaobjects.source.MergedSource;
import com.metaobjects.source.ResolvedSource;
import com.metaobjects.source.YamlSource;
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
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.ServiceLoader;
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

    /**
     * Cross-language provider-id aliases: the corpus uses canonical provider
     * names (e.g. {@code "metaobjects-core-types"}) that map to one or more of
     * Java's fine-grained {@link MetaDataTypeProvider}s. A canonical name is
     * considered "available" iff ALL of its backing Java provider ids are
     * service-loaded. Mirrors how the TS/C# adapters paper over the same
     * naming split.
     *
     * <p>Declared BEFORE {@link #AVAILABLE_PROVIDERS} so it is initialised first
     * (JLS §12.4 — class-init runs static fields top-to-bottom).</p>
     *
     * <p><strong>Maintenance caveat:</strong> if Java ever drops or renames one
     * of the 8 backing provider ids below, the {@code metaobjects-core-types}
     * alias will silently disappear from {@link #AVAILABLE_PROVIDERS} and any
     * fixture requiring it will fail honestly (as a missing-provider gap, not a
     * silent skip). Keep this list in sync with the actual provider IDs declared
     * in {@code META-INF/services/com.metaobjects.registry.MetaDataTypeProvider}.</p>
     */
    private static final java.util.Map<String, List<String>> PROVIDER_ALIASES =
        java.util.Map.of(
            // TS/C# expose one "metaobjects-core-types" provider; Java splits it
            // into per-concern providers (core, fields, attrs, objects, validators,
            // identity, relationships, sources).
            "metaobjects-core-types", List.of(
                "core-types",
                "field-types",
                "attribute-types",
                "object-types",
                "validator-types",
                "identity-types",
                "relationship-types",
                "source-types",
                "view-types",
                "layout-types",
                "template-types"
            )
        );

    /** Provider IDs available to the Java harness (via ServiceLoader auto-discovery). */
    private static final Set<String> AVAILABLE_PROVIDERS = discoverAvailableProviders();

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
        // warnings, or scripts. Anything that needs them fails honestly so the
        // ledger captures the gap.
        //
        // providers.json: Java auto-discovers providers via ServiceLoader, so
        // it cannot run with an arbitrary alternate provider set. But if a
        // fixture's required providers are a SUBSET of the available service-
        // loaded providers, the fixture can still be evaluated honestly — the
        // attrs/types it relies on are present, even if extra providers happen
        // to be loaded too. Only fail when a required provider is missing.

        // Provider-composition path: when a fixture's providers.json refers ONLY
        // to test-only providers (cycle-*, duplicate-*, depends-on-missing —
        // the provider-extension-* error fixtures), invoke
        // MetaDataRegistry.compose(...) on the resolved provider objects so the
        // expected ERR_PROVIDER_* code surfaces at compose time. The captured
        // exception flows into the existing thrown / errorCodesSeen pipeline
        // below, and the empty-stub input is skipped — the test result is fully
        // determined by the compose error.
        //
        // Fixtures that ALSO reference the cross-port "metaobjects-core-types"
        // alias (the new-subtype-success case) are NOT routed through compose:
        // their input is loaded by a loader given its OWN registry (core +
        // example-template-briefing) via setTypeRegistry below — no global
        // singleton mutation, so the success/fail pair is order-independent
        // (per ADR-0014).
        MetaDataException composeThrown = null;
        boolean handledByCompose = false;
        if (fix.hasProvidersJson) {
            List<String> missing = new ArrayList<>();
            for (String required : fix.requiredProviders) {
                if (!AVAILABLE_PROVIDERS.contains(required)) {
                    missing.add(required);
                }
            }
            if (!missing.isEmpty()) {
                failures.add("providers.json requires unavailable providers: " + missing);
            } else {
                boolean allTestOnly = !fix.requiredProviders.isEmpty()
                    && fix.requiredProviders.stream()
                        .allMatch(ConformanceTestProviders.TEST_PROVIDERS::containsKey);
                if (allTestOnly) {
                    List<com.metaobjects.registry.MetaDataTypeProvider> toCompose = new ArrayList<>();
                    for (String id : fix.requiredProviders) {
                        toCompose.add(ConformanceTestProviders.TEST_PROVIDERS.get(id));
                    }
                    try {
                        com.metaobjects.registry.MetaDataRegistry.compose(toCompose);
                    } catch (MetaDataException ce) {
                        composeThrown = ce;
                    }
                    handledByCompose = true;
                }
            }
        }
        if (fix.hasExpectedEffective) {
            failures.add("expected-effective.json (effective serialization) not supported by Java harness");
        }
        // expected-warnings.json is now supported — the assertion lives below,
        // after the loader has run (so loader.getWarnings() has a value to
        // compare against).
        // script.json is handled below — after the loader has run.

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
        // A fixture that requires the test-only example-template-briefing provider
        // gets its OWN registry (core + briefing) via setTypeRegistry — no global
        // singleton mutation, so the success/fail provider-extension pair is
        // order-independent and isolated. See PerLoaderRegistryTest and
        // docs/superpowers/specs/2026-05-29-java-per-loader-registry-design.md.
        if (fix.hasProvidersJson
                && fix.requiredProviders.contains("example-template-briefing")) {
            com.metaobjects.registry.MetaDataRegistry fixtureRegistry =
                com.metaobjects.registry.MetaDataRegistry.createWithCoreProviders();
            ConformanceTestProviders.BriefingTemplate.registerTypes(fixtureRegistry);
            loader.setTypeRegistry(fixtureRegistry);
        }
        loader.init();

        // Per the conformance contract (spec/conformance-tests.md): the sorted
        // set of error codes from a load attempt MUST equal the expected set.
        // We collect ALL errors visible after the load — both the ones the
        // loader RECORDED (via {@link MetaDataLoader#addError}) and the final
        // thrown one (if any) — so a multi-error fixture is honoured even
        // though the loader stays eager-throw on the first hard error.
        //
        // TS/Python/C# adapters expose a per-load errors collection directly;
        // Java mirrors that with {@link MetaDataLoader#getErrors()} plus the
        // thrown exception. Today no Java phase records into getErrors(), so
        // the practical effect is unchanged on the existing corpus — but the
        // harness shape is now correct for any future multi-error fixture
        // (and for any future phase that opts into the record-instead-of-throw
        // path).
        List<String> errorCodesSeen = new ArrayList<>();
        List<EnvelopeRecord> envelopesSeen = new ArrayList<>();
        MetaDataException thrown = null;
        if (handledByCompose) {
            // The provider-extension error fixtures: result is fully
            // determined by the MetaDataRegistry.compose(...) outcome above.
            // The empty meta.empty.json stub need not be loaded.
            thrown = composeThrown;
        } else {
            try {
                List<MetaDataSource> sources = new ArrayList<>(inputFiles.size());
                for (Path file : inputFiles) {
                    String content = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
                    sources.add(new InMemoryStringSource(content, file.getFileName().toString()));
                }
                loader.load(sources);
            } catch (MetaDataException ex) {
                thrown = ex;
            } catch (IOException ex) {
                failures.add("input read error: " + ex.getMessage());
                return;
            } catch (RuntimeException ex) {
                // A non-MetaDataException escaping the loader is itself a failure.
                failures.add("unexpected runtime exception during load: "
                    + ex.getClass().getSimpleName() + ": " + ex.getMessage());
                return;
            }
        }
        // Drain the loader-level accumulator first (errors recorded BEFORE the
        // throw, in source order), then append the thrown error if present.
        for (MetaDataException recorded : loader.getErrors()) {
            errorCodesSeen.add(extractErrorCode(recorded));
            envelopesSeen.add(buildEnvelope(recorded, fix.inputDir));
        }
        if (thrown != null) {
            errorCodesSeen.add(extractErrorCode(thrown));
            envelopesSeen.add(buildEnvelope(thrown, fix.inputDir));
        }

        // -- expected-errors check ------------------------------------------
        if (fix.hasExpectedErrors) {
            FixtureLint.ExpectedErrorsEnvelope envelope;
            try {
                JsonElement parsed = JsonParser.parseString(new String(
                    Files.readAllBytes(fix.dir.resolve("expected-errors.json")),
                    StandardCharsets.UTF_8));
                envelope = FixtureLint.parseExpectedErrorsEnvelope(parsed);
            } catch (Exception ex) {
                failures.add("expected-errors.json parse error: " + ex.getMessage());
                return;
            }
            // Code-set check (order-insensitive) — legacy semantics, always run.
            TreeSet<String> wantSet = new TreeSet<>();
            for (FixtureLint.ExpectedError e : envelope.errors) wantSet.add(e.code);
            TreeSet<String> gotSet = new TreeSet<>(errorCodesSeen);
            if (!wantSet.equals(gotSet)) {
                failures.add("expected errors " + wantSet + ", got " + gotSet);
            }
            // FR5a — per-error envelope assertion.
            // FR5c-finalize — same algorithm now also runs over warnings
            // when the fixture declares envelope-shape warnings.
            if (!envelope.legacy) {
                assertEnvelopeAlignment("envelope", envelope.errors, envelopesSeen, failures);

                // FR5c-finalize — warning length check uses the LEGACY warning
                // channel (mirrors the TS runner: any warning, envelope-shaped
                // or not, counts toward the total). The per-element envelope
                // shape assertion runs against the envelope-shaped channel,
                // and only when counts agree (otherwise the message already
                // names the count delta and per-element output would be noise).
                int expectedCount = envelope.warnings.size();
                int gotCount = loader.getWarnings().size();
                if (expectedCount != gotCount) {
                    failures.add("warning length mismatch: expected " + expectedCount
                        + ", got " + gotCount);
                } else {
                    List<EnvelopeRecord> warningEnvelopesSeen = new ArrayList<>();
                    for (com.metaobjects.source.LoaderWarning lw : loader.getEnvelopeWarnings()) {
                        warningEnvelopesSeen.add(buildEnvelope(lw, fix.inputDir));
                    }
                    // Only run per-element assertion when the envelope channel
                    // matches the expected count too (legacy-only warnings
                    // would otherwise produce a confusing index mismatch).
                    if (expectedCount == warningEnvelopesSeen.size()) {
                        assertEnvelopeAlignment("warning", envelope.warnings,
                            warningEnvelopesSeen, failures);
                    }
                }
            }
            return;
        }

        // If the fixture is NOT an expected-errors fixture but the loader
        // THREW (vs. recorded errors via {@link MetaDataLoader#addError}),
        // the tree is mid-build and we can't run tree-dependent checks.
        //
        // FR5c — errors recorded via {@code addError} (e.g.
        // {@code ERR_MERGE_CONFLICT} from the merge-attribution site) do NOT
        // halt tree building. Existing happy-path fixtures (e.g.
        // {@code overlay-attr-last-writer-wins}) exercise scenarios that now
        // surface a recorded error AND a valid tree; TS conformance behaves
        // the same way (no error-set check unless {@code expected-errors.json}
        // is declared). Only a thrown exception means the tree is unsafe.
        if (thrown != null) {
            failures.add("load threw " + extractErrorCode(thrown)
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
                failures.add("canonical serialization mismatch:\n--- expected ---\n"
                    + want + "\n--- got ---\n" + got);
            }
        }

        // -- expected-warnings check ----------------------------------------
        // Match the TS/C# contract: warnings are compared as a multiset of exact
        // strings (order-insensitive). If a fixture has NO expected-warnings.json
        // but the loader emitted some, that is itself a failure (we do not
        // silently swallow unexpected warnings on happy-path fixtures).
        List<String> gotWarnings = new ArrayList<>(loader.getWarnings());
        if (fix.hasExpectedWarnings) {
            List<String> wantWarnings;
            try {
                JsonElement parsed = JsonParser.parseString(new String(
                    Files.readAllBytes(fix.dir.resolve("expected-warnings.json")),
                    StandardCharsets.UTF_8));
                wantWarnings = parseExpectedWarnings(parsed);
            } catch (Exception ex) {
                failures.add("expected-warnings.json parse error: " + ex.getMessage());
                return;
            }
            // Multiset equality (order-insensitive, duplicate-preserving): sort
            // both lists and compare directly so the same warning emitted N
            // times must also appear N times in expected-warnings.json.
            List<String> wantSorted = new ArrayList<>(wantWarnings);
            List<String> gotSorted = new ArrayList<>(gotWarnings);
            Collections.sort(wantSorted);
            Collections.sort(gotSorted);
            if (!wantSorted.equals(gotSorted)) {
                failures.add("warnings mismatch:\n--- expected ---\n"
                    + wantSorted + "\n--- got ---\n" + gotSorted);
            }
        } else if (fix.hasExpected && !gotWarnings.isEmpty()) {
            failures.add("loader emitted unexpected warnings: " + gotWarnings);
        }

        // -- script.json check ----------------------------------------------
        if (fix.hasScript) {
            try {
                JsonElement scriptEl = JsonParser.parseString(new String(
                    Files.readAllBytes(fix.dir.resolve("script.json")),
                    StandardCharsets.UTF_8));
                ScriptRunner.run(loader, scriptEl, failures);
            } catch (Exception ex) {
                failures.add("script.json parse error: " + ex.getMessage());
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

    /**
     * Parse an {@code expected-warnings.json} document into a flat list of
     * warning strings. The format is a top-level JSON array of strings; anything
     * else is a corpus error and throws.
     */
    private static List<String> parseExpectedWarnings(JsonElement parsed) {
        if (!parsed.isJsonArray()) {
            throw new IllegalArgumentException(
                "expected-warnings.json must be a JSON array of strings");
        }
        List<String> out = new ArrayList<>();
        for (JsonElement el : parsed.getAsJsonArray()) {
            if (!el.isJsonPrimitive() || !el.getAsJsonPrimitive().isString()) {
                throw new IllegalArgumentException(
                    "expected-warnings.json entries must all be strings");
            }
            out.add(el.getAsString());
        }
        return out;
    }

    /**
     * Assert per-element envelope alignment between the expected list (from
     * {@code expected-errors.json}, either the {@code errors} or
     * {@code warnings} channel) and what the loader surfaced. Mirrors the TS
     * runner's identical block for errors + warnings.
     *
     * <p>Algorithm:</p>
     * <ul>
     *   <li>Length mismatch is a single failure (no per-element checks run).</li>
     *   <li>Per element: {@code code} must match. When the expected entry has
     *       no {@code source}, the per-element source check is skipped (count
     *       alone is the contract). Otherwise {@code format} + {@code files}
     *       always assert; {@code jsonPath}, {@code referrer}, {@code target}
     *       assert only when the expected entry declares them.</li>
     * </ul>
     *
     * @param label   "envelope" for errors, "warning" for warnings — woven
     *                into failure messages so the channel is unambiguous.
     */
    private static void assertEnvelopeAlignment(String label,
                                                 List<FixtureLint.ExpectedError> expected,
                                                 List<EnvelopeRecord> got,
                                                 List<String> failures) {
        if (expected.size() != got.size()) {
            failures.add(label + " length mismatch: expected " + expected.size()
                + ", got " + got.size());
            return;
        }
        for (int i = 0; i < expected.size(); i++) {
            FixtureLint.ExpectedError w = expected.get(i);
            EnvelopeRecord g = got.get(i);
            if (!w.code.equals(g.code)) {
                failures.add(label + "[" + i + "].code: expected '" + w.code
                    + "', got '" + g.code + "'");
                continue;
            }
            if (w.source == null) continue;
            if (!w.source.format.equals(g.format)) {
                failures.add(label + "[" + i + "].source.format: expected '"
                    + w.source.format + "', got '" + g.format + "'");
            }
            if (!w.source.files.equals(g.files)) {
                failures.add(label + "[" + i + "].source.files: expected "
                    + w.source.files + ", got " + g.files);
            }
            if (w.source.jsonPath != null && !w.source.jsonPath.equals(g.jsonPath)) {
                failures.add(label + "[" + i + "].source.jsonPath: expected '"
                    + w.source.jsonPath + "', got '" + g.jsonPath + "'");
            }
            // FR5d — assert referrer + target for format=resolved envelopes.
            if (w.source.referrer != null && !w.source.referrer.equals(g.referrer)) {
                failures.add(label + "[" + i + "].source.referrer: expected '"
                    + w.source.referrer + "', got '" + g.referrer + "'");
            }
            if (w.source.target != null && !w.source.target.equals(g.target)) {
                failures.add(label + "[" + i + "].source.target: expected '"
                    + w.source.target + "', got '" + g.target + "'");
            }
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
     * Discover provider IDs available to the Java harness via {@link ServiceLoader}.
     * This is the set the loader will populate at init time; we use it to honour
     * {@code providers.json}'s required-subset contract.
     *
     * <p>Augments the raw discovered set with cross-language aliases (see
     * {@link #PROVIDER_ALIASES}) so corpus-canonical names like
     * {@code metaobjects-core-types} resolve when their backing Java providers
     * are all loaded.</p>
     */
    private static Set<String> discoverAvailableProviders() {
        Set<String> ids = new LinkedHashSet<>();
        for (MetaDataTypeProvider provider : ServiceLoader.load(MetaDataTypeProvider.class)) {
            String id = provider.getProviderId();
            if (id != null && !id.isEmpty()) {
                ids.add(id);
            }
        }
        // Expose cross-language aliases when ALL of their backing Java provider
        // ids are present in the discovered set.
        for (var entry : PROVIDER_ALIASES.entrySet()) {
            if (ids.containsAll(entry.getValue())) {
                ids.add(entry.getKey());
            }
        }
        // Test-only providers used by the provider-extension-* fixtures.
        // Availability is satisfied per-fixture either by MetaDataRegistry.compose(...)
        // (the provider-error fixtures) or by a per-loader registry built with
        // createWithCoreProviders() + setTypeRegistry (the new-subtype-success
        // fixture) — see runConformanceChecks. No global-singleton mutation.
        ids.addAll(ConformanceTestProviders.TEST_PROVIDERS.keySet());
        return Collections.unmodifiableSet(ids);
    }

    /** Cross-port envelope record for the Java conformance runner. */
    private static final class EnvelopeRecord {
        final String code;
        final String format;
        final List<String> files;
        final String jsonPath;
        // FR5d — populated for format=resolved envelopes; null otherwise.
        final String referrer;
        final String target;
        EnvelopeRecord(String code, String format, List<String> files, String jsonPath,
                       String referrer, String target) {
            this.code = code;
            this.format = format;
            this.files = files;
            this.jsonPath = jsonPath;
            this.referrer = referrer;
            this.target = target;
        }
        EnvelopeRecord(String code, String format, List<String> files, String jsonPath) {
            this(code, format, files, jsonPath, null, null);
        }
    }

    /**
     * Build the cross-port envelope from a MetaDataException, normalising
     * file paths to be relative to the fixture's input directory so the
     * cross-port harness has a portable file token.
     */
    private static EnvelopeRecord buildEnvelope(MetaDataException ex, Path inputDir) {
        return buildEnvelope(extractErrorCode(ex), ex.getEnvelope().orElse(null), inputDir);
    }

    /**
     * FR5c-finalize — build the cross-port envelope from a
     * {@link com.metaobjects.source.LoaderWarning}. Shares the variant-by-
     * variant dispatch with the exception-side {@link #buildEnvelope(MetaDataException, Path)}.
     */
    private static EnvelopeRecord buildEnvelope(com.metaobjects.source.LoaderWarning warning,
                                                 Path inputDir) {
        return buildEnvelope(warning.code(), warning.source(), inputDir);
    }

    /**
     * Shared envelope builder — same algorithm whether the source comes from
     * a thrown exception, a recorded error, or a {@code LoaderWarning}.
     */
    private static EnvelopeRecord buildEnvelope(String code, ErrorSource env, Path inputDir) {
        if (env instanceof JsonSource js) {
            return new EnvelopeRecord(code, "json", relativizeFiles(js.files(), inputDir), js.jsonPath());
        }
        if (env instanceof YamlSource ys) {
            return new EnvelopeRecord(code, "yaml", relativizeFiles(ys.files(), inputDir), ys.jsonPath());
        }
        if (env instanceof MergedSource ms) {
            return new EnvelopeRecord(code, "merged", relativizeFiles(ms.files(), inputDir), ms.jsonPath());
        }
        if (env instanceof ResolvedSource rs) {
            // FR5d — surface referrer + target so the cross-port runner can assert them.
            return new EnvelopeRecord(code, "resolved", relativizeFiles(rs.files(), inputDir),
                rs.jsonPath(), rs.referrer(), rs.target());
        }
        if (env instanceof CodeSource) {
            return new EnvelopeRecord(code, "code", Collections.emptyList(), null);
        }
        // No envelope — synthesise a minimal root-of-file shape.
        return new EnvelopeRecord(code, "json", Collections.emptyList(), "$");
    }

    private static List<String> relativizeFiles(List<String> files, Path inputDir) {
        List<String> out = new ArrayList<>(files.size());
        String inputDirStr = inputDir.toAbsolutePath().toString();
        for (String f : files) {
            if (f.startsWith(inputDirStr)) {
                Path rel = inputDir.toAbsolutePath().relativize(Paths.get(f));
                out.add(rel.toString().replace('\\', '/'));
            } else {
                // Already a basename or a relative path; normalize separators.
                out.add(f.replace('\\', '/'));
            }
        }
        return out;
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
