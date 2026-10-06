package com.metaobjects.generator.apidocs;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.generator.spring.SpringTestFixtures;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;

/**
 * The api-contract {@code projection/} corpus, docs half. The REST routes a read-only
 * projection's api page lists are exactly the routes its generated surface answers with a
 * row. Every port runs this assertion over the same model and the same expected set
 * ({@code fixtures/api-contract-conformance/projection/docs-routes.json}):
 *
 * <ul>
 *   <li>a projection with a declared identity lists {@code GET <path>} and {@code GET <path>/{id}};</li>
 *   <li>one with none lists {@code GET <path>} alone, even when it has a field named {@code id};</li>
 *   <li>no unit lists a write verb.</li>
 * </ul>
 *
 * <p>The booted-server half of the same contract is the corpus scenarios themselves
 * ({@code ProjectionGeneratedApiContractConformanceTest} in {@code integration-tests}).</p>
 */
public class ProjectionDocsRoutesTest extends SharedRegistryTestBase {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    /** Walk up to the repo root (the dir holding both {@code fixtures/} and {@code server/}). */
    private static Path corpus() {
        Path dir = Path.of(System.getProperty("user.dir")).toAbsolutePath().normalize();
        for (Path p = dir; p != null; p = p.getParent()) {
            if (Files.isDirectory(p.resolve("fixtures")) && Files.isDirectory(p.resolve("server"))) {
                return p.resolve("fixtures/api-contract-conformance/projection");
            }
        }
        throw new IllegalStateException("could not locate the repo root from " + dir);
    }

    /** The spelling every port's expected set uses: no leading slash or api prefix, {@code {id}}. */
    private static String normalize(String symbol) {
        int space = symbol.indexOf(' ');
        return symbol.substring(0, space) + " " + symbol.substring(space + 1).replaceFirst("^/?(?:api/)?", "");
    }

    @Test
    public void eachProjectionDocumentsExactlyTheRoutesItMounts() throws Exception {
        Path corpus = corpus();
        JsonNode expected = MAPPER.readTree(Files.readString(corpus.resolve("docs-routes.json"))).get("units");
        Path workspace = tempFolder.newFolder("projection-docs").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
            workspace, "projection-docs", Files.readString(corpus.resolve("meta.json")));

        JavaApiModel model = new JavaApiModelBuilder().build(loader, "projection-docs");

        Iterator<Map.Entry<String, JsonNode>> units = expected.fields();
        while (units.hasNext()) {
            Map.Entry<String, JsonNode> e = units.next();
            List<String> want = new ArrayList<>();
            e.getValue().forEach(n -> want.add(n.asText()));
            want.sort(null);

            ApiUnit unit = model.units().stream().filter(u -> u.node().equals(e.getKey())).findFirst()
                .orElseThrow(() -> new AssertionError("no api unit " + e.getKey()));
            List<String> documented = new ArrayList<>();
            for (ApiSymbol s : unit.symbols()) {
                if (s.kind() == ApiSymbolKind.REST) documented.add(normalize(s.name()));
            }
            documented.sort(null);
            assertEquals(e.getKey() + ": the routes its api page lists", want, documented);
        }
    }
}
