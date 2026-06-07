package com.metaobjects.generator.apidocs;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.generator.spring.SpringTestFixtures;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Cross-port api-docs LAYOUT conformance gate (SP-2c): the Java {@code api/java} surface
 * MUST resolve to the SAME paths + cross-link hrefs the TS conformance test already
 * asserts against the shared contract
 * {@code fixtures/conformance/api-docs-cross-port/expected-paths.json}.
 *
 * <p>Both ports asserting one manifest ⟹ the polyglot doc tree coheres: a {@code model}
 * page can link to {@code api/ts} AND {@code api/java}, and each api page links back to the
 * same model page, with relative hrefs that resolve identically on disk.</p>
 *
 * <p>This test is the JAVA half. It loads the SAME input metadata
 * ({@code fixtures/conformance/api-docs-cross-port/input/meta.json}) the TS side loads,
 * builds the {@link JavaApiModel}, and for each manifest unit asserts — using the EXACT
 * path/href math the {@code metaobjects:docs} goal ({@code DocsMojo}) uses, computed via
 * {@link DocsPaths}, never re-derived here — that:
 * <ul>
 *   <li>{@code apiSubDir + "/" + docPageOutputPath(PACKAGE, pkg, node)} equals the
 *       manifest {@code apiJavaPath};</li>
 *   <li>{@code modelCrossHref(apiJavaPath, pagePath, null)} equals the manifest
 *       {@code apiJavaToModel};</li>
 *   <li>the rendered unit page actually carries the contract back-link
 *       {@code **Model / metadata:** [<node>](<modelHref>)}.</li>
 * </ul>
 *
 * <p>It also asserts <b>set coverage</b>: every manifest unit is documented by the Java
 * builder (Java documents the same unit set), so neither port silently documents a
 * different surface.</p>
 *
 * <p>If a path/href diverges from the manifest, that is a REAL cross-port layout
 * divergence (or a Java path bug) — the gate exists to surface it, not to be weakened.
 * The manifest is the single source of truth, already validated by the TS test; a Java
 * mismatch means the Java side is wrong (or the unit sets genuinely differ).</p>
 */
public class ApiDocsCrossPortConformanceTest extends SharedRegistryTestBase {

    private static final String CASE = "api-docs-cross-port";
    private static final String PROJECT = "api-docs-cross-port";
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    /** Walk up to the repo root (the dir holding both {@code fixtures/} and {@code server/}). */
    private static Path repoRoot() {
        Path dir = Path.of(System.getProperty("user.dir")).toAbsolutePath().normalize();
        for (Path p = dir; p != null; p = p.getParent()) {
            if (Files.isDirectory(p.resolve("fixtures")) && Files.isDirectory(p.resolve("server"))) {
                return p;
            }
        }
        throw new IllegalStateException(
            "could not locate repo root (a dir containing both fixtures/ and server/) from " + dir);
    }

    private static Path caseDir() {
        return repoRoot().resolve("fixtures/conformance/" + CASE);
    }

    @Test
    public void javaApiJavaPathsAndHrefsMatchTheSharedManifest() throws Exception {
        // ---- load the shared contract + the SAME input metadata the TS test uses ----
        JsonNode manifest = MAPPER.readTree(
            Files.readString(caseDir().resolve("expected-paths.json")));
        assertEquals("manifest layout must be 'package'", "package", manifest.get("layout").asText());
        String apiJavaSubDir = manifest.get("apiJavaSubDir").asText(); // "api/java"
        assertEquals("manifest apiJavaSubDir must be 'api/java'", "api/java", apiJavaSubDir);

        String metaJson = Files.readString(caseDir().resolve("input/meta.json"));
        Path workspace = tempFolder.newFolder("xport-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, CASE, metaJson);

        JavaApiModel model = new JavaApiModelBuilder().build(loader, PROJECT);

        // ---- coverage: Java documents (at least) every manifest unit ----
        TreeSet<String> manifestNodes = new TreeSet<>();
        for (JsonNode u : manifest.get("units")) {
            manifestNodes.add(u.get("node").asText());
        }
        TreeSet<String> javaNodes = new TreeSet<>();
        for (ApiUnit u : model.units()) {
            javaNodes.add(u.node());
        }
        TreeSet<String> missing = new TreeSet<>(manifestNodes);
        missing.removeAll(javaNodes);
        assertTrue(
            "Java api-docs does NOT document every unit the shared manifest lists.\n"
                + "  manifest units: " + manifestNodes + "\n"
                + "  java units    : " + javaNodes + "\n"
                + "  MISSING from java (in manifest, not documented): " + missing + "\n"
                + "If Java legitimately documents a different unit set, this is a real cross-port "
                + "finding — reconcile the manifest/builder together; do NOT weaken this assertion.",
            missing.isEmpty());

        // Both ports document the SAME unit set (the manifest is the agreed surface).
        // The api-docs-cross-port fixture is authored to that exact set, so equality holds.
        assertEquals("Java unit set must equal the shared manifest's unit set",
            manifestNodes, javaNodes);

        // ---- per-unit: api/java path + model back-href match the manifest EXACTLY ----
        // Path/href math mirrors DocsMojo with layout=package, apiSubDir="api/java",
        // modelBaseUrl=null — every value from DocsPaths, nothing re-derived here.
        JavaApiDocsRenderer renderer = new JavaApiDocsRenderer();
        List<String> checked = new ArrayList<>();
        for (JsonNode unitNode : manifest.get("units")) {
            String node = unitNode.get("node").asText();
            ApiUnit unit = findUnit(model, node);

            String pagePath = DocsPaths.docPageOutputPath(
                DocsPaths.Layout.PACKAGE, unit.pkg(), unit.node());

            String apiJavaPath = apiJavaSubDir + "/" + pagePath;
            assertEquals("api/java path for '" + node + "' must match the shared manifest",
                unitNode.get("apiJavaPath").asText(), apiJavaPath);

            String modelHref = DocsPaths.modelCrossHref(apiJavaPath, pagePath, null);
            assertEquals("api/java → model href for '" + node + "' must match the shared manifest",
                unitNode.get("apiJavaToModel").asText(), modelHref);

            // The rendered page must actually carry the contract back-link.
            String page = renderer.renderUnitPage(unit, modelHref);
            String expectedBackLink = "**Model / metadata:** [" + node + "](" + modelHref + ")";
            assertTrue(
                "rendered api/java page for '" + node + "' must carry the back-link:\n  "
                    + expectedBackLink + "\nactual page:\n" + page,
                page.contains(expectedBackLink));

            checked.add(node);
        }

        // Guard: every manifest unit was actually asserted (no silent zero-iteration pass).
        assertEquals("must have asserted every manifest unit",
            new TreeSet<>(manifestNodes), new TreeSet<>(checked));
    }

    private static ApiUnit findUnit(JavaApiModel model, String node) {
        for (ApiUnit u : model.units()) {
            if (u.node().equals(node)) {
                return u;
            }
        }
        throw new AssertionError("no Java api-docs unit '" + node + "' in " + model.units());
    }
}
