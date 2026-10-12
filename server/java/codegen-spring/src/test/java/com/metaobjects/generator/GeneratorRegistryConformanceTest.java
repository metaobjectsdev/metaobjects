package com.metaobjects.generator;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.generator.GeneratorRegistry.GeneratorInfo;
import com.metaobjects.generator.GeneratorRegistry.Layer;
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
 * every entry's tier AND layer MUST agree with the manifest.
 *
 * <p>If this fails, the fix is to reconcile the registry and the manifest in the same
 * change — never edit the manifest just to make a port pass.</p>
 */
public class GeneratorRegistryConformanceTest {

    private static final String PORT_ID = "java";
    private static final ObjectMapper MAPPER = new ObjectMapper();

    /**
     * The closed set of {@code layer} values, spelled out rather than derived from
     * {@link Layer}. Enumerating the enum would make this gate agree with whatever the
     * code says, which is the one thing a conformance gate must not do.
     */
    private static final Set<String> ALLOWED_LAYERS =
            Set.of("model", "persistence", "api", "client", "docs", "capability");

    /**
     * Registered stable names whose {@code classname} is deliberately NOT a wirable
     * {@link Generator} on this port. PINNED, not exempted —
     * {@link #everyRegisteredClassnameLoadsAndIsAWirableGenerator()} asserts the set matches
     * EXACTLY, so a NEW one fails just as loudly as one that has quietly been fixed.
     *
     * <p>Empty. {@code extractor} was the one member while {@code ExtractorCodeGenerator} was
     * only a step inside {@code entity}; it is a generator of its own now, as on the other
     * four ports, and {@code entity} still writes its files when no separate one is in the
     * run.</p>
     *
     * <p>Shared with {@code NoMagicPhysicalNamesTest}, which must skip exactly these rows
     * when it builds a suite off the registry. ONE definition, so the two cannot drift into
     * disagreeing about which rows are runnable.</p>
     */
    public static final Set<String> NOT_WIRABLE = Set.of();

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

    private static Set<String> pendingCensus(JsonNode manifest) {
        Set<String> names = new java.util.TreeSet<>();
        for (JsonNode p : manifest.path("eject").path("pending")) {
            if (PORT_ID.equals(p.path("port").asText()) && "census".equals(p.path("assertion").asText())) {
                names.add(p.path("generator").asText());
            }
        }
        return names;
    }

    /** Manifest entries whose {@code ports} array includes this port. */
    private static Map<String, Tier> manifestSliceForPort(JsonNode manifest) {
        Map<String, Tier> slice = new TreeMap<>();
        Set<String> pending = pendingCensus(manifest);
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
            // A name the shared file expects here and lists as a pending census gap is the
            // eject contract's to report (EjectContractTest), which fails once it is registered.
            if (includesPort && !pending.contains(name)) {
                Tier tier = "neutral".equals(entry.path("tier").asText("native"))
                        ? Tier.NEUTRAL : Tier.NATIVE;
                slice.put(name, tier);
            }
        }
        return slice;
    }

    /** Every manifest entry's {@code layer}, for EVERY port — this gate also checks the
     *  manifest's own well-formedness, which is not port-scoped. */
    private static Map<String, String> manifestLayers(JsonNode manifest) {
        Map<String, String> layers = new TreeMap<>();
        Iterator<Map.Entry<String, JsonNode>> it = manifest.get("generators").fields();
        while (it.hasNext()) {
            Map.Entry<String, JsonNode> e = it.next();
            layers.put(e.getKey(), e.getValue().path("layer").asText(""));
        }
        return layers;
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
    public void registryLayersAgreeWithManifest() throws Exception {
        JsonNode manifest = loadManifest();
        Map<String, String> layers = manifestLayers(manifest);
        Map<String, GeneratorInfo> actual = GeneratorRegistry.list();

        for (Map.Entry<String, Tier> e : manifestSliceForPort(manifest).entrySet()) {
            GeneratorInfo info = actual.get(e.getKey());
            if (info == null) {
                continue; // set-equality test reports the diff; avoid NPE noise here.
            }
            assertEquals("layer mismatch for stable name '" + e.getKey() + "'",
                    layers.get(e.getKey()), info.layer().manifestValue());
        }
    }

    @Test
    public void everyManifestEntryDeclaresOneOfTheSixLayers() throws Exception {
        TreeSet<String> bad = new TreeSet<>();
        for (Map.Entry<String, String> e : manifestLayers(loadManifest()).entrySet()) {
            if (!ALLOWED_LAYERS.contains(e.getValue())) {
                bad.add(e.getKey() + "='" + e.getValue() + "'");
            }
        }
        assertTrue("manifest entries with a missing or unknown layer (allowed: "
                + new TreeSet<>(ALLOWED_LAYERS) + "): " + bad, bad.isEmpty());
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
            assertTrue("layer must be set for " + e.getKey(), info.layer() != null);
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
        assertEquals("registry rows that a <generator> entry cannot wire — see NOT_WIRABLE",
                new TreeSet<>(NOT_WIRABLE), notWirable);
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
