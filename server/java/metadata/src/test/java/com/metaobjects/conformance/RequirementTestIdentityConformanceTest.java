package com.metaobjects.conformance;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.MetaRoot;
import com.metaobjects.loader.DirectorySource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataSource;
import com.metaobjects.requirement.MetaRequirement;
import com.metaobjects.requirement.RequirementTestFilter;
import com.metaobjects.requirement.RequirementTestIdentities;
import com.metaobjects.requirement.RequirementTestIdentities.Grain;
import com.metaobjects.requirement.RequirementTestIdentities.Identity;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Cross-port requirement-test identity corpus —
 * {@code fixtures/requirement-test-identity-conformance/}. See that directory's README.md for
 * the fixture format and the three runner steps: load {@code input/} STRICT, in file-name
 * order; compute the identities through the PUBLIC grain and filter seams, passing each only
 * when {@code options.json} sets it; compare tests and collisions with {@code expected.json}.
 *
 * <p>Mirrors the TypeScript reference
 * ({@code requirement-test-identity-conformance.test.ts}). A mismatch here is a bug in THIS
 * port, never in the fixture.</p>
 */
@RunWith(Parameterized.class)
public class RequirementTestIdentityConformanceTest {

    static final Path CORPUS =
        CorpusRoot.locate().resolveSibling("requirement-test-identity-conformance");

    /** The whole of {@code options.json}: a key outside this list is refused, not ignored. */
    private static final List<String> OPTION_KEYS = List.of("grain", "filter");

    /**
     * The corpus's closed list of filters, exactly eight rows. A predicate cannot be written in
     * a file five languages read, so a case NAMES one and every port's runner holds this table
     * in its own language. An unknown name fails the case.
     */
    static final Map<String, RequirementTestFilter> FILTERS = Map.of(
        "all", v -> true,
        "architectural", v -> MetaRequirement.SUBTYPE_ARCHITECTURAL.equals(v.subType()),
        "live", v -> MetaRequirement.STATUS_LIVE.equals(v.status()),
        "level-5", v -> v.level() != null && v.level() == MetaRequirement.LEVEL_MEMBER,
        "unlevelled", v -> v.level() == null,
        "package-acme-shop", v -> "acme::shop".equals(v.pkg()),
        "path-under-Shop", v -> v.path().equals("Shop") || v.path().startsWith("Shop."),
        "claims-entity", v -> v.implementedByTypes().contains("object.entity"));

    static final Pattern DOCUMENTED_CASE = Pattern.compile("^\\| `([^`]+)` \\|", Pattern.MULTILINE);

    @Parameterized.Parameters(name = "{0}")
    public static Collection<Object[]> fixtures() throws IOException {
        List<Object[]> params = new ArrayList<>();
        for (String name : caseNames()) params.add(new Object[]{name});
        return params;
    }

    static List<String> caseNames() throws IOException {
        try (Stream<Path> dirs = Files.list(CORPUS)) {
            return dirs.filter(Files::isDirectory).map(d -> d.getFileName().toString()).sorted().toList();
        }
    }

    private final String name;

    public RequirementTestIdentityConformanceTest(String name) {
        this.name = name;
    }

    @Test
    public void fixture() throws IOException {
        Path dir = CORPUS.resolve(name);
        Path expectedFile = dir.resolve("expected.json");
        assertTrue(name + ": no expected.json", Files.isRegularFile(expectedFile));
        JsonObject expected = JsonParser.parseString(Files.readString(expectedFile, StandardCharsets.UTF_8)).getAsJsonObject();

        Grain grain = null;
        RequirementTestFilter filter = null;
        Path optionsFile = dir.resolve("options.json");
        if (Files.isRegularFile(optionsFile)) {
            JsonObject options = JsonParser.parseString(Files.readString(optionsFile, StandardCharsets.UTF_8)).getAsJsonObject();
            for (String key : options.keySet()) {
                assertTrue(optionsFile + ": unknown option " + key, OPTION_KEYS.contains(key));
            }
            if (options.has("grain")) grain = Grain.parse(options.get("grain").getAsString());
            if (options.has("filter")) {
                String filterName = options.get("filter").getAsString();
                filter = FILTERS.get(filterName);
                if (filter == null) {
                    fail(optionsFile + ": unknown filter '" + filterName + "'. The corpus names: " + FILTERS.keySet());
                }
            }
        }

        // Step 1: STRICT, input/ in file-name order, one batch.
        MetaDataLoader loader = new MetaDataLoader(LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL, "requirement_test_identity_" + name.replace('-', '_'));
        loader.init();
        List<MetaDataSource> sources = new DirectorySource(dir.resolve("input"), new DirectorySource.Options()).expandToList();
        loader.load(sources);
        assertTrue(name + ": expected a clean strict load, got: " + loader.getErrors(), loader.getErrors().isEmpty());
        MetaRoot root = loader.getRoot();

        // Step 2: each option is passed only when the case sets it (null means the default).
        List<Identity> tests = RequirementTestIdentities.identities(root, grain, filter);

        // Step 3: compare.
        assertEquals(name, expectedTests(expected.getAsJsonArray("tests")), actualTests(tests));
        assertEquals(name, expectedPairs(expected.getAsJsonArray("collisions")),
            actualPairs(RequirementTestIdentities.witnessKeyCollisions(tests)));
    }

    // ---------------------------------------------------------------- comparison

    private static List<String> expectedTests(JsonArray tests) {
        List<String> rows = new ArrayList<>();
        for (JsonElement e : tests) {
            JsonObject t = e.getAsJsonObject();
            rows.add(row(t.get("id").getAsString(), t.get("package").getAsString(), t.get("path").getAsString(),
                t.get("unit").getAsString(), t.get("witnessKey").getAsString(), t.get("status").getAsString(),
                t.get("skip").isJsonNull() ? "null" : t.get("skip").getAsString(), t.get("digest").getAsString()));
        }
        rows.sort(Comparator.naturalOrder());
        return rows;
    }

    private static List<String> actualTests(List<Identity> tests) {
        List<String> rows = new ArrayList<>();
        for (Identity t : tests) {
            rows.add(row(t.id(), t.pkg(), t.path(), t.unit(), t.witnessKey(), t.status(),
                t.skip() == null ? "null" : t.skip(), t.digest()));
        }
        rows.sort(Comparator.naturalOrder());
        return rows;
    }

    private static String row(String... cells) {
        return String.join(" | ", cells);
    }

    private static List<String> expectedPairs(JsonArray pairs) {
        List<String> out = new ArrayList<>();
        for (JsonElement e : pairs) {
            JsonArray pair = e.getAsJsonArray();
            out.add(pairKey(pair.get(0).getAsString(), pair.get(1).getAsString()));
        }
        out.sort(Comparator.naturalOrder());
        return out;
    }

    private static List<String> actualPairs(List<String[]> pairs) {
        List<String> out = new ArrayList<>();
        for (String[] pair : pairs) out.add(pairKey(pair[0], pair[1]));
        out.sort(Comparator.naturalOrder());
        return out;
    }

    private static String pairKey(String a, String b) {
        return a.compareTo(b) <= 0 ? a + " || " + b : b + " || " + a;
    }
}
