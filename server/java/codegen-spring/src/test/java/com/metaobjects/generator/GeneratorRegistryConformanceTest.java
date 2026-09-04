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
import java.util.Set;
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

    /**
     * Registered stable names whose {@code classname} is deliberately NOT a wirable
     * {@link Generator} on this port. PINNED, not exempted —
     * {@link #everyRegisteredClassnameLoadsAndIsAWirableGenerator()} asserts the set matches
     * EXACTLY, so a NEW one fails just as loudly as one that has quietly been fixed.
     *
     * <p>{@code extractor} → {@code ExtractorCodeGenerator} is an emission HELPER driven by
     * {@code JavaObjectCodeGenerator.execute}: its output SHIPS whenever {@code entity} runs
     * — every non-abstract object gets an extractor — it is simply not independently wirable
     * in a {@code <generator>} entry the way the other four ports expose it. A fusion, not a
     * gap; {@code docs/ports/java.md} says so where an adopter will look.</p>
     *
     * <p>Shared with {@code NoMagicPhysicalNamesTest}, which must skip exactly these rows
     * when it builds a suite off the registry. ONE definition, so the two cannot drift into
     * disagreeing about which rows are runnable.</p>
     */
    public static final Set<String> FUSED_NOT_WIRABLE = Set.of("extractor");

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
     * Every registered {@code classname} must RESOLVE, and be a generator a pom can name.
     *
     * <p>{@link #everyRegistryEntryIsWellFormed()} above checks the classname is non-blank,
     * which is not the same question — a non-blank string can name a class that does not
     * exist, or one that exists and is not a {@link Generator} at all. That gap is not
     * hypothetical: the {@code template} row named
     * {@code render.templategen.TemplateGenerator}, a static factory with a private
     * constructor that deliberately does NOT implement {@code Generator}, so a
     * {@code <generator>} following the registry (or the deprecation notice on
     * {@code MustacheTemplateGenerator}, which pointed at the same class) died on
     * {@code AbstractMetaDataMojo}'s {@code (Generator) newInstance()}. Nothing here looked.
     *
     * <p>"Wirable" is exactly what the mojo requires: the class loads, implements
     * {@code Generator}, and can actually be INSTANTIATED through a no-arg constructor.</p>
     *
     * <p>That last word is load-bearing, and this check used to stop one step short of it.
     * It called {@code getDeclaredConstructor()} and never invoked the result — but
     * {@code getDeclaredConstructor()} succeeds for a PRIVATE constructor and for an
     * ABSTRACT class, while the mojo goes on to call {@code newInstance()} with no
     * {@code setAccessible}, which throws {@code IllegalAccessException} for the first and
     * {@code InstantiationException} for the second. So the gate would have passed a row
     * the mojo fails, which is the one thing it exists to prevent. No registered row is in
     * that state today; the check now instantiates, so none can arrive in it unnoticed.
     * The no-magic gates in this module and in codegen-kotlin already instantiate every
     * NATIVE generator, so doing it here costs nothing new.</p>
     */
    @Test
    public void everyRegisteredClassnameLoadsAndIsAWirableGenerator() {
        TreeSet<String> unloadable = new TreeSet<>();
        TreeSet<String> notWirable = new TreeSet<>();

        for (Map.Entry<String, GeneratorInfo> e : GeneratorRegistry.list().entrySet()) {
            Class<?> impl;
            try {
                impl = Class.forName(e.getValue().classname());
            } catch (ClassNotFoundException ex) {
                unloadable.add(e.getKey() + " -> " + e.getValue().classname());
                continue;
            }
            if (!Generator.class.isAssignableFrom(impl)) {
                notWirable.add(e.getKey());
                continue;
            }
            try {
                // INSTANTIATE, exactly as AbstractMetaDataMojo.buildGenerators does — see
                // the javadoc above for why merely resolving the constructor is too weak.
                impl.getDeclaredConstructor().newInstance();
            } catch (NoSuchMethodException ex) {
                notWirable.add(e.getKey() + " (no no-arg constructor)");
            } catch (ReflectiveOperationException | RuntimeException ex) {
                // IllegalAccessException (private ctor), InstantiationException (abstract),
                // or anything the constructor itself throws — the mojo would die on all of
                // them, so all of them are "not wirable" and the reason is reported.
                notWirable.add(e.getKey() + " (" + ex.getClass().getSimpleName() + ")");
            }
        }

        assertEquals("every registered classname must resolve on this port's classpath",
                new TreeSet<String>(), unloadable);
        assertEquals("registry rows that a <generator> entry cannot wire — see FUSED_NOT_WIRABLE",
                new TreeSet<>(FUSED_NOT_WIRABLE), notWirable);
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
