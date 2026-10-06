package com.metaobjects.conformance;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.MetaRoot;
import com.metaobjects.library.LibrarySources;
import com.metaobjects.loader.DirectorySource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataSource;
import com.metaobjects.requirement.RequirementCheck;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Cross-port requirement-check conformance corpus — {@code fixtures/requirement-check-conformance/}.
 * See that directory's README.md for the fixture format and the three runner steps: load
 * {@code input/} STRICT, in file-name order, beside the libraries {@code options.json}
 * names; run the gate with no scope predicate and no forced coverage answer; compare the
 * diagnostics (an unordered multiset) and the summary with {@code expected.json}.
 *
 * <p>Mirrors the TypeScript reference ({@code requirement-check-conformance.test.ts}). A
 * mismatch here is a bug in THIS port's gate, never in the fixture.</p>
 */
@RunWith(Parameterized.class)
public class RequirementCheckConformanceTest {

    private static final Path CORPUS = CorpusRoot.locate().resolveSibling("requirement-check-conformance");

    /** The whole of {@code options.json}: a key outside this list is refused, not ignored. */
    private static final List<String> OPTION_KEYS = List.of("libraries", "requireImplementers");

    /** A case whose {@code input/} must be, file for file, another case's. */
    private static final Map<String, String> SAME_INPUT_AS = Map.of(
        "require-implementers", "nothing-implements-subtree");

    private static final Pattern DOCUMENTED_CASE = Pattern.compile("^\\| `([^`]+)` \\|", Pattern.MULTILINE);

    @Parameterized.Parameters(name = "{0}")
    public static Collection<Object[]> fixtures() throws IOException {
        List<Object[]> params = new ArrayList<>();
        for (String name : caseNames()) params.add(new Object[]{name});
        return params;
    }

    private static List<String> caseNames() throws IOException {
        try (Stream<Path> dirs = Files.list(CORPUS)) {
            return dirs.filter(Files::isDirectory).map(d -> d.getFileName().toString()).sorted().toList();
        }
    }

    private final String name;

    public RequirementCheckConformanceTest(String name) {
        this.name = name;
    }

    @Test
    public void everyCaseOnDiskIsDocumentedInTheReadmeAndNothingElseIs() throws IOException {
        String readme = Files.readString(CORPUS.resolve("README.md"), StandardCharsets.UTF_8);
        String section = readme.substring(readme.indexOf("\n## Cases\n"));
        int next = section.indexOf("\n## ", 1);
        if (next > 0) section = section.substring(0, next);
        List<String> documented = new ArrayList<>();
        Matcher m = DOCUMENTED_CASE.matcher(section);
        while (m.find()) documented.add(m.group(1));
        documented.sort(Comparator.naturalOrder());
        assertEquals(caseNames(), documented);
    }

    @Test
    public void fixture() throws IOException {
        Path dir = CORPUS.resolve(name);
        Path expectedFile = dir.resolve("expected.json");
        assertTrue(name + ": no expected.json", Files.isRegularFile(expectedFile));
        JsonObject expected = JsonParser.parseString(Files.readString(expectedFile, StandardCharsets.UTF_8)).getAsJsonObject();

        List<String> libraries = new ArrayList<>();
        boolean requireImplementers = false;
        Path optionsFile = dir.resolve("options.json");
        if (Files.isRegularFile(optionsFile)) {
            JsonObject options = JsonParser.parseString(Files.readString(optionsFile, StandardCharsets.UTF_8)).getAsJsonObject();
            for (String key : options.keySet()) {
                assertTrue(optionsFile + ": unknown option " + key, OPTION_KEYS.contains(key));
            }
            if (options.has("libraries")) {
                for (JsonElement l : options.getAsJsonArray("libraries")) libraries.add(l.getAsString());
            }
            if (options.has("requireImplementers")) {
                assertTrue(optionsFile + ": 'requireImplementers' must be a boolean",
                    options.get("requireImplementers").getAsJsonPrimitive().isBoolean());
                requireImplementers = options.get("requireImplementers").getAsBoolean();
            }
        }

        String twin = SAME_INPUT_AS.get(name);
        if (twin != null) assertEquals(name, inputFiles(twin), inputFiles(name));

        // Step 1: STRICT, libraries first and then input/ in file-name order, one batch.
        MetaDataLoader loader = new MetaDataLoader(LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL, "requirement_check_" + name.replace('-', '_'));
        loader.init();
        List<MetaDataSource> sources = new ArrayList<>(LibrarySources.librarySources(libraries));
        sources.addAll(new DirectorySource(dir.resolve("input"), new DirectorySource.Options()).expandToList());
        loader.load(sources);
        assertTrue(name + ": expected a clean strict load, got: " + loader.getErrors(), loader.getErrors().isEmpty());

        // Step 2: no scope predicate, no forced coverage answer.
        MetaRoot root = loader.getRoot();
        RequirementCheck.Scan scan = RequirementCheck.scan(root, new RequirementCheck.Options(null, requireImplementers));

        // Step 3: compare.
        assertEquals(name, multiset(expected.getAsJsonArray("diagnostics")), actualRows(RequirementCheck.check(root, scan)));
        assertEquals(name, expectedSummary(expected.get("summary")), actualSummary(RequirementCheck.summarise(root, scan)));
    }

    private static Map<String, String> inputFiles(String caseName) throws IOException {
        Map<String, String> out = new TreeMap<>();
        try (Stream<Path> files = Files.list(CORPUS.resolve(caseName).resolve("input"))) {
            for (Path f : files.toList()) out.put(f.getFileName().toString(), Files.readString(f, StandardCharsets.UTF_8));
        }
        return out;
    }

    /** A row is {@code severity | code | path | message}; an absent path compares as the empty string. */
    private static List<String> multiset(JsonArray diagnostics) {
        List<String> rows = new ArrayList<>();
        for (JsonElement e : diagnostics) {
            JsonObject d = e.getAsJsonObject();
            rows.add(row(d.get("severity").getAsString(), d.get("code").getAsString(),
                d.has("path") ? d.get("path").getAsString() : "", d.get("message").getAsString()));
        }
        rows.sort(Comparator.naturalOrder());
        return rows;
    }

    private static List<String> actualRows(List<RequirementCheck.Diagnostic> diagnostics) {
        List<String> rows = new ArrayList<>();
        for (RequirementCheck.Diagnostic d : diagnostics) {
            rows.add(row(d.severity().name().toLowerCase(java.util.Locale.ROOT), d.code(),
                d.path() == null ? "" : d.path(), d.message()));
        }
        rows.sort(Comparator.naturalOrder());
        return rows;
    }

    private static String row(String severity, String code, String path, String message) {
        return severity + " | " + code + " | " + path + " | " + message;
    }

    /** The summary as a key-sorted {@code key=value} list; {@code null} for no requirement. */
    private static List<String> expectedSummary(JsonElement summary) {
        if (summary == null || summary.isJsonNull()) return null;
        JsonObject s = summary.getAsJsonObject();
        List<String> out = new ArrayList<>();
        for (String key : s.keySet()) {
            if (key.equals("byStatus")) {
                for (Map.Entry<String, JsonElement> e : s.getAsJsonObject("byStatus").entrySet()) {
                    out.add("byStatus." + e.getKey() + "=" + e.getValue().getAsInt());
                }
            } else {
                out.add(key + "=" + s.get(key).getAsInt());
            }
        }
        out.sort(Comparator.naturalOrder());
        return out;
    }

    private static List<String> actualSummary(RequirementCheck.Summary s) {
        if (s == null) return null;
        List<String> out = new ArrayList<>(Arrays.asList(
            "total=" + s.total(), "functional=" + s.functional(), "architectural=" + s.architectural(),
            "undecided=" + s.undecided(), "deferredUntracked=" + s.deferredUntracked()));
        for (Map.Entry<String, Integer> e : s.byStatus().entrySet()) out.add("byStatus." + e.getKey() + "=" + e.getValue());
        if (s.entitiesTotal() != null) out.add("entitiesTotal=" + s.entitiesTotal());
        if (s.entitiesClaimed() != null) out.add("entitiesClaimed=" + s.entitiesClaimed());
        out.sort(Comparator.naturalOrder());
        return out;
    }
}
