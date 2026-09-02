package com.metaobjects.generator;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.generator.GeneratorRegistry.GeneratorInfo;
import com.metaobjects.generator.GeneratorRegistry.Tier;
import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Iterator;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Conformance gate: Java's {@link GeneratorRegistry} stable-name set MUST equal the
 * {@code java} slice of the canonical cross-port manifest
 * {@code fixtures/generator-registry-conformance/registry.json} (ADR-0021 D3), and
 * every entry's tier MUST agree with the manifest.
 *
 * <p>If this fails, the fix is to reconcile the registry and the manifest in the same
 * change — never edit the manifest just to make a port pass.</p>
 */
public class GeneratorRegistryConformanceTest {

    private static final String PORT_ID = "java";
    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** Walk up from the test's working dir to the repo root (the dir holding both {@code fixtures/} and {@code server/}). */
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

    private static JsonNode loadManifest() throws IOException {
        Path manifest = repoRoot().resolve("fixtures/generator-registry-conformance/registry.json");
        assertTrue("canonical manifest must exist at " + manifest, Files.exists(manifest));
        return MAPPER.readTree(Files.readString(manifest));
    }

    /** Manifest entries whose {@code ports} array includes this port. */
    private static Map<String, Tier> manifestSliceForPort(JsonNode manifest) {
        Map<String, Tier> slice = new TreeMap<>();
        JsonNode generators = manifest.get("generators");
        assertTrue("manifest must have a 'generators' object", generators != null && generators.isObject());
        Iterator<Map.Entry<String, JsonNode>> it = generators.fields();
        while (it.hasNext()) {
            Map.Entry<String, JsonNode> e = it.next();
            String name = e.getKey();
            JsonNode entry = e.getValue();
            JsonNode ports = entry.get("ports");
            boolean includesPort = false;
            if (ports != null && ports.isArray()) {
                for (JsonNode p : ports) {
                    if (PORT_ID.equals(p.asText())) {
                        includesPort = true;
                        break;
                    }
                }
            }
            if (includesPort) {
                Tier tier = "neutral".equals(entry.path("tier").asText("native"))
                        ? Tier.NEUTRAL : Tier.NATIVE;
                slice.put(name, tier);
            }
        }
        return slice;
    }

    @Test
    public void registryNameSetEqualsManifestJavaSlice() throws Exception {
        Map<String, Tier> expected = manifestSliceForPort(loadManifest());
        Map<String, GeneratorInfo> actual = GeneratorRegistry.list();

        TreeSet<String> expectedNames = new TreeSet<>(expected.keySet());
        TreeSet<String> actualNames = new TreeSet<>(actual.keySet());

        TreeSet<String> missingFromRegistry = new TreeSet<>(expectedNames);
        missingFromRegistry.removeAll(actualNames);

        TreeSet<String> extraInRegistry = new TreeSet<>(actualNames);
        extraInRegistry.removeAll(expectedNames);

        assertTrue(
                "Java generator registry name set does not match the manifest's java slice.\n"
                        + "  manifest java slice (" + expectedNames.size() + "): " + expectedNames + "\n"
                        + "  registry names      (" + actualNames.size() + "): " + actualNames + "\n"
                        + "  MISSING from registry (in manifest, not registered): " + missingFromRegistry + "\n"
                        + "  EXTRA in registry (registered, not in manifest): " + extraInRegistry + "\n"
                        + "Fix: reconcile GeneratorRegistry and registry.json together; do NOT edit the manifest to force a pass.",
                missingFromRegistry.isEmpty() && extraInRegistry.isEmpty());

        // Redundant but explicit set-equality assertion for a crisp message on size drift.
        assertEquals("registry name set must equal manifest java slice", expectedNames, actualNames);
    }

    @Test
    public void registryTiersAgreeWithManifest() throws Exception {
        Map<String, Tier> expected = manifestSliceForPort(loadManifest());
        Map<String, GeneratorInfo> actual = GeneratorRegistry.list();

        for (Map.Entry<String, Tier> e : expected.entrySet()) {
            GeneratorInfo info = actual.get(e.getKey());
            if (info == null) {
                continue; // set-equality test reports the diff; avoid NPE noise here.
            }
            assertEquals("tier mismatch for stable name '" + e.getKey() + "'", e.getValue(), info.tier());
        }
    }

    @Test
    public void everyRegistryEntryIsWellFormed() {
        for (Map.Entry<String, GeneratorInfo> e : GeneratorRegistry.list().entrySet()) {
            GeneratorInfo info = e.getValue();
            assertEquals("map key must equal stableName", e.getKey(), info.stableName());
            assertTrue("classname must be set for " + e.getKey(),
                    info.classname() != null && !info.classname().isBlank());
            assertTrue("description must be set for " + e.getKey(),
                    info.description() != null && !info.description().isBlank());
            assertTrue("tier must be set for " + e.getKey(), info.tier() != null);
        }
    }

    /**
     * Every registered generator must be NAMED on the adopter-facing port page.
     *
     * <p>There is no default generator suite on the JVM — {@code <generators>} in the pom is
     * the complete list, one entry per generator — so a generator absent from
     * {@code docs/ports/java.md} is one an adopter has no way to discover. The page had five
     * of fourteen. This asserts the page names each generator's stable name AND its simple
     * class name (the class name is what goes in the pom, so listing one without the other
     * still leaves the reader unable to wire it).</p>
     *
     * <p>Deliberately one-directional: it fails on an UNDOCUMENTED generator, never on extra
     * prose. Keeping the page's cell TEXT accurate is not something a string search can do,
     * and a gate that pretended otherwise would be the false confidence this one exists to
     * avoid.</p>
     */
    @Test
    public void everyRegisteredGeneratorIsNamedInThePortDoc() throws IOException {
        Path doc = repoRoot().resolve("docs/ports/java.md");
        assertTrue("port doc must exist at " + doc, Files.exists(doc));
        String page = Files.readString(doc);

        TreeSet<String> undocumented = new TreeSet<>();
        for (Map.Entry<String, GeneratorInfo> e : GeneratorRegistry.list().entrySet()) {
            String simpleName = e.getValue().classname()
                    .substring(e.getValue().classname().lastIndexOf('.') + 1);
            if (!page.contains("`" + e.getKey() + "`") || !page.contains(simpleName)) {
                undocumented.add(e.getKey() + " (" + simpleName + ")");
            }
        }

        assertTrue(
                "docs/ports/java.md must name every registered generator by stable name AND class.\n"
                        + "  MISSING: " + undocumented + "\n"
                        + "Fix: add a row to the Generators table — the JVM has no default suite, so a\n"
                        + "generator this page does not name is one nobody can wire.",
                undocumented.isEmpty());
    }
}
