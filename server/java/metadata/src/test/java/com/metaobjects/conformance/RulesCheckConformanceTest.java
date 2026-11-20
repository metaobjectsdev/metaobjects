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
import com.metaobjects.api.RulesCheck;
import com.metaobjects.config.RulesSettings;
import com.metaobjects.config.NeutralConfig;
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
 * Cross-port rules-gate conformance corpus ({@code fixtures/rules-check-conformance/}, ADR-0066).
 * Loads {@code input/} strict, reads {@code options.json} through the config reader, runs the
 * gate and compares diagnostics (an unordered multiset) and the summary with {@code expected.json}.
 */
@RunWith(Parameterized.class)
public class RulesCheckConformanceTest {

    private static final Path CORPUS = CorpusRoot.locate().resolveSibling("rules-check-conformance");
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

    public RulesCheckConformanceTest(String name) {
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

        RulesSettings settings = RulesSettings.DEFAULT;
        Path optionsFile = dir.resolve("options.json");
        if (Files.isRegularFile(optionsFile)) {
            // options.json holds the rules/verify blocks only; the reader also wants the schema marker.
            JsonObject options = JsonParser.parseString(Files.readString(optionsFile, StandardCharsets.UTF_8)).getAsJsonObject();
            options.addProperty("schema_version", 1);
            settings = NeutralConfig.parse(options.toString(), optionsFile.toString()).getRulesSettings();
        }

        MetaDataLoader loader = new MetaDataLoader(LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL, "rules_check_" + name.replace('-', '_'));
        loader.init();
        loader.load(new DirectorySource(dir.resolve("input"), new DirectorySource.Options()).expandToList());
        assertTrue(name + ": expected a clean strict load, got: " + loader.getErrors(), loader.getErrors().isEmpty());

        RulesCheck.Result result = RulesCheck.check(loader.getRoot(), settings);

        assertEquals(name, multiset(expected.getAsJsonArray("diagnostics")), actualRows(result.diagnostics()));
        assertEquals(name, expectedSummary(expected.get("summary")), actualSummary(result.summary()));
    }

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

    private static List<String> expectedSummary(JsonElement summary) {
        if (summary == null || summary.isJsonNull()) return null;
        JsonObject s = summary.getAsJsonObject();
        List<String> out = new ArrayList<>();
        for (String key : s.keySet()) out.add(key + "=" + s.get(key).getAsInt());
        out.sort(Comparator.naturalOrder());
        return out;
    }

    private static List<String> actualSummary(RulesCheck.Summary s) {
        if (s == null) return null;
        List<String> out = new ArrayList<>(Arrays.asList(
            "operations=" + s.operations(), "lifecycles=" + s.lifecycles(), "transitions=" + s.transitions()));
        out.sort(Comparator.naturalOrder());
        return out;
    }
}
