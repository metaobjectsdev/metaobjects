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
import com.metaobjects.MetaRoot;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.ValidationPhase;
import com.metaobjects.loader.parser.yaml.ParserYaml;
import com.metaobjects.loader.parser.yaml.YamlDesugar;
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

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
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
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Parametric Java YAML conformance runner over the shared
 * {@code fixtures/yaml-conformance/} corpus (ADR-0006 D4).
 *
 * <p>Mirrors the TS reference at
 * {@code server/typescript/packages/metadata/test/yaml-conformance.test.ts} and the
 * Python sibling at {@code server/python/tests/conformance/test_yaml_conformance.py}.
 * Each fixture directory under {@code fixtures/yaml-conformance/} contains:</p>
 * <ul>
 *   <li>{@code input.yaml} — required</li>
 *   <li>{@code expected.json} — happy-path: canonical-serialized output must match</li>
 *   <li>{@code expected-errors.json} — error-path: emitted ERR_* code set must match</li>
 * </ul>
 *
 * <p>Adding a directory under {@code fixtures/yaml-conformance/} adds a parametrized
 * test automatically. The corpus is shared across every port — Java is one of four
 * (TS, Python, Java, C#).</p>
 *
 * <p>The runner uses a per-language ledger file at
 * {@code server/java/metadata/yaml-conformance-expected-failures.json} (mirrors the
 * canonical-JSON conformance runner). The ledger is expected to be empty for Java
 * because Java is fully source-v2 + ADR-0006-aligned.</p>
 */
@RunWith(Parameterized.class)
public class YamlConformanceTest {

    private static final Path CORPUS = locateYamlCorpus();
    private static final ExpectedFailures.Ledger LEDGER = ExpectedFailures.load(locateLedger());

    // ERR_* token in legacy message-only exceptions; e.g. "... ERR_BAD_ATTR_VALUE: ..."
    private static final Pattern ERR_TOKEN = Pattern.compile("\\bERR_[A-Z][A-Z0-9_]*\\b");

    @Parameters(name = "{0}")
    public static Collection<Object[]> fixtures() {
        List<YamlFixture> all = discover(CORPUS);
        List<Object[]> rows = new ArrayList<>(all.size());
        for (YamlFixture f : all) rows.add(new Object[]{f.name, f});
        return rows;
    }

    @Parameter(0)
    public String fixtureName;

    @Parameter(1)
    public YamlFixture fix;

    @Test
    public void conformance() {
        List<String> failures = new ArrayList<>();
        runChecks(fix, failures);
        boolean passed = failures.isEmpty();

        String status = ExpectedFailures.classify(passed, fix.name, LEDGER);
        String detail = passed ? "(no failures)" : String.join("; ", failures);

        assertTrue(
            fix.name + " [" + status + "]: " + detail,
            "pass".equals(status) || "known-gap".equals(status));
    }

    // -----------------------------------------------------------------------
    // Per-fixture pipeline
    // -----------------------------------------------------------------------

    private static void runChecks(YamlFixture fix, List<String> failures) {
        String yaml;
        try {
            yaml = new String(Files.readAllBytes(fix.dir.resolve("input.yaml")),
                StandardCharsets.UTF_8);
        } catch (IOException ex) {
            failures.add("input.yaml read error: " + ex.getMessage());
            return;
        }

        // Pre-scan input.yaml for a top-level `package:` so the loader name matches
        // what the serializer emits — mirrors ConformanceTest's loader-root-name leak
        // mitigation. The pre-scan is intentionally minimal (a regex on the YAML text)
        // because the YAML is not yet parsed.
        String loaderName = detectLoaderNameFromYaml(yaml);
        LoaderOptions opts = LoaderOptions.create(false, false, true);
        MetaDataLoader loader = new MetaDataLoader(opts, MetaDataLoader.SUBTYPE_MANUAL,
            loaderName);
        loader.init();

        // 1. Desugar — collect every desugar diagnostic (the multi-error path).
        Set<String> codesSeen = new LinkedHashSet<>();
        List<YamlEnvelopeRecord> envelopesSeen = new ArrayList<>();
        ParserYaml parser = new ParserYaml(loader, "input.yaml");
        ParserYaml.YamlResult yamlResult;
        try {
            InputStream is = new ByteArrayInputStream(yaml.getBytes(StandardCharsets.UTF_8));
            yamlResult = parser.parseYamlCollecting(is);
        } catch (MetaDataException ex) {
            String code = extractErrorCode(ex);
            if (codesSeen.add(code)) envelopesSeen.add(buildYamlEnvelopeFromException(ex, code));
            yamlResult = null;
        }

        // 2. Add desugar collected codes.
        if (yamlResult != null) {
            for (YamlDesugar.CollectedError err : yamlResult.errors) {
                String code = err.code != null ? err.code.name() : ErrorCode.ERR_MALFORMED_YAML.name();
                if (codesSeen.add(code)) {
                    // YAML desugar errors don't carry an envelope yet — synthesize
                    // a root-level yaml shape.
                    envelopesSeen.add(new YamlEnvelopeRecord(code, "yaml",
                        Collections.singletonList("input.yaml"), "$"));
                }
            }
            // 3. Hand the canonical to buildTree — capture any subsequent build-time
            //    error (e.g. ERR_RESERVED_ATTR raised inline by the canonical parser).
            boolean buildTreeOk = true;
            try {
                parser.buildTree(yamlResult.canonical);
            } catch (MetaDataException ex) {
                String code = extractErrorCode(ex);
                if (codesSeen.add(code)) envelopesSeen.add(buildYamlEnvelopeFromException(ex, code));
                buildTreeOk = false;
            } catch (RuntimeException ex) {
                failures.add("unexpected runtime exception during buildTree: "
                    + ex.getClass().getSimpleName() + ": " + ex.getMessage());
                return;
            }

            // 4. Run the post-load ValidationPhase — fires post-parse content checks
            //    (e.g. EnumField @values: ERR_BAD_ATTR_VALUE on a non-string value).
            //    Mirrors what MetaDataLoader.load() does after parsing each source.
            //    Skipped on a buildTree failure since the tree is incomplete.
            if (buildTreeOk) {
                MetaRoot root = loader.getRoot();
                if (root != null) {
                    try {
                        ValidationPhase.run(root);
                    } catch (MetaDataException ex) {
                        String code = extractErrorCode(ex);
                        if (codesSeen.add(code)) envelopesSeen.add(buildYamlEnvelopeFromException(ex, code));
                    } catch (RuntimeException ex) {
                        failures.add("unexpected runtime exception during ValidationPhase: "
                            + ex.getClass().getSimpleName() + ": " + ex.getMessage());
                        return;
                    }
                }
            }
        }

        // -- expected-errors check ------------------------------------------
        if (fix.hasExpectedErrors) {
            FixtureLint.ExpectedErrorsEnvelope envelope = parseExpectedErrorsEnvelope(
                fix.dir.resolve("expected-errors.json"));
            // Code-set check.
            TreeSet<String> wantSet = new TreeSet<>();
            for (FixtureLint.ExpectedError e : envelope.errors) wantSet.add(e.code);
            TreeSet<String> gotSet = new TreeSet<>(codesSeen);
            if (!wantSet.equals(gotSet)) {
                failures.add("expected errors " + wantSet + ", got " + gotSet);
            }
            // FR5a per-error envelope assertion (in declaration order).
            if (!envelope.legacy) {
                if (envelope.errors.size() != envelopesSeen.size()) {
                    failures.add("envelope length mismatch: expected " + envelope.errors.size()
                        + ", got " + envelopesSeen.size());
                } else {
                    for (int i = 0; i < envelope.errors.size(); i++) {
                        FixtureLint.ExpectedError w = envelope.errors.get(i);
                        YamlEnvelopeRecord g = envelopesSeen.get(i);
                        if (!w.code.equals(g.code)) {
                            failures.add("envelope[" + i + "].code: expected '" + w.code
                                + "', got '" + g.code + "'");
                            continue;
                        }
                        if (w.source == null) continue;
                        if (!w.source.format.equals(g.format)) {
                            failures.add("envelope[" + i + "].source.format: expected '"
                                + w.source.format + "', got '" + g.format + "'");
                        }
                        if (!w.source.files.equals(g.files)) {
                            failures.add("envelope[" + i + "].source.files: expected "
                                + w.source.files + ", got " + g.files);
                        }
                        if (w.source.jsonPath != null && !w.source.jsonPath.equals(g.jsonPath)) {
                            failures.add("envelope[" + i + "].source.jsonPath: expected '"
                                + w.source.jsonPath + "', got '" + g.jsonPath + "'");
                        }
                    }
                }
            }
            return;
        }

        // -- happy-path canonical serialization check -----------------------
        if (!codesSeen.isEmpty()) {
            failures.add("load produced errors " + codesSeen
                + " — cannot compare canonical output");
            return;
        }
        if (!fix.hasExpected) {
            failures.add("fixture declares no expectation files");
            return;
        }
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

    // -----------------------------------------------------------------------
    // Fixture discovery
    // -----------------------------------------------------------------------

    /** A single YAML conformance fixture. */
    public static final class YamlFixture {
        public final String name;
        public final Path dir;
        public final boolean hasExpected;
        public final boolean hasExpectedErrors;

        YamlFixture(String name, Path dir, boolean hasExpected, boolean hasExpectedErrors) {
            this.name = name;
            this.dir = dir;
            this.hasExpected = hasExpected;
            this.hasExpectedErrors = hasExpectedErrors;
        }
    }

    private static List<YamlFixture> discover(Path corpus) {
        List<YamlFixture> fixtures = new ArrayList<>();
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(corpus)) {
            List<Path> entries = new ArrayList<>();
            for (Path p : ds) entries.add(p);
            Collections.sort(entries);
            for (Path entry : entries) {
                if (!Files.isDirectory(entry)) continue;
                boolean hasExpected = Files.isRegularFile(entry.resolve("expected.json"));
                boolean hasErrors = Files.isRegularFile(entry.resolve("expected-errors.json"));
                if (hasExpected && hasErrors) {
                    throw new AssertionError(
                        "Fixture '" + entry.getFileName()
                            + "' has both expected.json and expected-errors.json — one only.");
                }
                if (!hasExpected && !hasErrors) {
                    throw new AssertionError(
                        "Fixture '" + entry.getFileName()
                            + "' has neither expected.json nor expected-errors.json.");
                }
                if (!Files.isRegularFile(entry.resolve("input.yaml"))) {
                    throw new AssertionError(
                        "Fixture '" + entry.getFileName() + "' is missing input.yaml.");
                }
                fixtures.add(new YamlFixture(entry.getFileName().toString(), entry,
                    hasExpected, hasErrors));
            }
        } catch (IOException ex) {
            throw new AssertionError("Failed to enumerate YAML corpus at " + corpus, ex);
        }
        return fixtures;
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /**
     * Locate the {@code fixtures/yaml-conformance/} directory by walking up from CWD.
     * Mirrors {@link CorpusRoot#locate} but for the YAML corpus (a sibling directory).
     */
    private static Path locateYamlCorpus() {
        String env = System.getenv("METAOBJECTS_YAML_CONFORMANCE_CORPUS");
        if (env != null && !env.isEmpty()) {
            Path envPath = Paths.get(env);
            if (!Files.isDirectory(envPath)) {
                throw new AssertionError(
                    "METAOBJECTS_YAML_CONFORMANCE_CORPUS points to a non-existent directory: " + env);
            }
            return envPath.toAbsolutePath();
        }
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve("fixtures/yaml-conformance");
            if (Files.isDirectory(candidate)) return candidate;
            dir = dir.getParent();
        }
        throw new AssertionError(
            "Could not locate fixtures/yaml-conformance/ by walking up from: "
                + Paths.get("").toAbsolutePath());
    }

    /**
     * Locate the per-language YAML ledger file. Lives at
     * {@code server/java/metadata/yaml-conformance-expected-failures.json}. Parallels the
     * canonical-JSON ledger discovery in {@code ConformanceTest}.
     */
    private static Path locateLedger() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve(
                "server/java/metadata/yaml-conformance-expected-failures.json");
            if (Files.isRegularFile(candidate)) return candidate;
            Path local = dir.resolve("yaml-conformance-expected-failures.json");
            if (Files.isRegularFile(local) && dir.getFileName() != null
                && "metadata".equals(dir.getFileName().toString())) {
                return local;
            }
            dir = dir.getParent();
        }
        return Paths.get("yaml-conformance-expected-failures.json").toAbsolutePath();
    }

    private static String extractErrorCode(MetaDataException ex) {
        return ex.getCode()
            .map(Enum::name)
            .orElseGet(() -> scanMessageForErrorCode(ex.getMessage()));
    }

    private static String scanMessageForErrorCode(String message) {
        if (message == null) return ErrorCode.ERR_UNKNOWN.name();
        Matcher m = ERR_TOKEN.matcher(message);
        if (m.find()) return m.group();
        return ErrorCode.ERR_UNKNOWN.name();
    }

    private static List<String> parseExpectedErrors(Path file) {
        try {
            JsonElement el = JsonParser.parseString(new String(
                Files.readAllBytes(file), StandardCharsets.UTF_8));
            return FixtureLint.parseExpectedErrors(el);
        } catch (IOException ex) {
            throw new AssertionError("expected-errors.json read error: " + ex.getMessage(), ex);
        }
    }

    /** Parse the YAML fixture's expected-errors.json into the FR5a envelope shape. */
    private static FixtureLint.ExpectedErrorsEnvelope parseExpectedErrorsEnvelope(Path file) {
        try {
            JsonElement el = JsonParser.parseString(new String(
                Files.readAllBytes(file), StandardCharsets.UTF_8));
            return FixtureLint.parseExpectedErrorsEnvelope(el);
        } catch (IOException ex) {
            throw new AssertionError("expected-errors.json read error: " + ex.getMessage(), ex);
        }
    }

    /** Per-error cross-port envelope record used inside the YAML runner. */
    private static final class YamlEnvelopeRecord {
        final String code;
        final String format;
        final List<String> files;
        final String jsonPath;
        YamlEnvelopeRecord(String code, String format, List<String> files, String jsonPath) {
            this.code = code;
            this.format = format;
            this.files = files;
            this.jsonPath = jsonPath;
        }
    }

    /**
     * Build a cross-port envelope record from a YAML-runner MetaDataException.
     * YAML fixtures' file token is always {@code "input.yaml"} (the authoring
     * file the consumer sees), not the per-port internal source id.
     */
    private static YamlEnvelopeRecord buildYamlEnvelopeFromException(MetaDataException ex, String code) {
        ErrorSource env = ex.getEnvelope().orElse(null);
        if (env instanceof JsonSource js) {
            return new YamlEnvelopeRecord(code, "json",
                Collections.singletonList("input.yaml"), js.jsonPath());
        }
        if (env instanceof YamlSource ys) {
            return new YamlEnvelopeRecord(code, "yaml",
                Collections.singletonList("input.yaml"), ys.jsonPath());
        }
        if (env instanceof MergedSource ms) {
            return new YamlEnvelopeRecord(code, "merged", ms.files(), ms.jsonPath());
        }
        if (env instanceof ResolvedSource rs) {
            return new YamlEnvelopeRecord(code, "resolved", rs.files(), rs.jsonPath());
        }
        if (env instanceof CodeSource) {
            return new YamlEnvelopeRecord(code, "code", Collections.emptyList(), null);
        }
        return new YamlEnvelopeRecord(code, "yaml", Collections.singletonList("input.yaml"), "$");
    }

    /**
     * Best-effort scan of {@code input.yaml} for a top-level {@code package: <value>}
     * line so the loader name matches the canonical serializer's top-level package
     * emission. Conservative — recognises only the simple {@code package: <bare>} form
     * at the top of the document. Returns "" when no package is declared.
     */
    private static String detectLoaderNameFromYaml(String yaml) {
        // Look only inside the top-level metadata block. The simple corpus uses
        // `metadata:` at column 0 and `  package: <value>` at column 2.
        Pattern p = Pattern.compile("(?m)^[ \\t]+package:[ \\t]*([^\\s\"]+)");
        Matcher m = p.matcher(yaml);
        if (m.find()) {
            return m.group(1).trim();
        }
        return "";
    }
}
