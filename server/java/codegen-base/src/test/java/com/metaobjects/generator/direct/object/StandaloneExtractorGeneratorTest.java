package com.metaobjects.generator.direct.object;

import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.direct.object.javacode.ExtractorCodeGenerator;
import com.metaobjects.generator.direct.object.javacode.JavaObjectCodeGenerator;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.ObjectClassRegistry;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * The {@code extractor} generator: the one thing that writes a {@code <Name>Extractor}.
 *
 * <p>Through 8.0 the files were a step inside {@code entity}, written for a pom that declared
 * no such thing. ADR-0034 Amendment 9 rules out output no {@code <generator>} entry declares,
 * so these tests hold both halves: {@code entity} writes none, and this generator writes one
 * per concrete object {@code entity} wrote a class for, named by {@code entity}'s naming args
 * and narrowed by its filters.</p>
 */
public class StandaloneExtractorGeneratorTest {

    private static final String PKG = "acme::shapes";

    /** An abstract base, a concrete subtype, and an object nesting another. */
    private static final String META = "{ \"metadata.root\": {"
        + "  \"package\": \"" + PKG + "\","
        + "  \"children\": ["
        + "    { \"object.value\": { \"name\": \"Shape\", \"abstract\": true, \"children\": ["
        + "      { \"field.string\": { \"name\": \"label\" } }"
        + "    ]}},"
        + "    { \"object.value\": { \"name\": \"Circle\", \"extends\": \"Shape\", \"children\": ["
        + "      { \"field.double\": { \"name\": \"radius\" } }"
        + "    ]}},"
        + "    { \"object.value\": { \"name\": \"Drawing\", \"children\": ["
        + "      { \"field.string\": { \"name\": \"title\" } },"
        + "      { \"field.object\": { \"name\": \"outline\", \"@objectRef\": \"" + PKG + "::Circle\" } }"
        + "    ]}}"
        + "  ]"
        + "}}";

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @After
    public void resetRegistry() {
        ObjectClassRegistry.resetGlobal();
    }

    private MetaDataLoader loadMeta() {
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, "standalone-extractor");
        loader.init();
        loader.load(List.of(new InMemoryStringSource(META, "standalone-extractor/meta.json")));
        return loader;
    }

    private static Map<String, String> entityArgs(Path out, String flavor) {
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", out.toString());
        args.put("type", "class");
        args.put("flavor", flavor);
        return args;
    }

    private static void run(Generator generator, Map<String, String> args, MetaDataLoader loader) {
        generator.setArgs(args);
        generator.execute(loader);
    }

    /** Every {@code *Extractor.java} under {@code root}, by path relative to it. */
    private static Map<String, String> extractors(Path root) throws IOException {
        Map<String, String> out = new TreeMap<>();
        try (Stream<Path> walk = Files.walk(root)) {
            for (Path p : (Iterable<Path>) walk.filter(Files::isRegularFile)::iterator) {
                if (p.getFileName().toString().endsWith("Extractor.java")) {
                    out.put(root.relativize(p).toString().replace('\\', '/'),
                            Files.readString(p, StandardCharsets.UTF_8));
                }
            }
        }
        return out;
    }

    /** {@code entity} and {@code extractor} over one output directory, as a pom lists them. */
    private Path entityAndExtractor(String dir, String flavor, Map<String, String> naming, List<String> filters)
            throws Exception {
        Path out = tmp.newFolder(dir).toPath();
        JavaObjectCodeGenerator entity = new JavaObjectCodeGenerator();
        ExtractorCodeGenerator extractor = new ExtractorCodeGenerator();
        entity.setFilters(filters);
        extractor.setFilters(filters);
        Map<String, String> entityArgs = entityArgs(out, flavor);
        entityArgs.putAll(naming);
        Map<String, String> extractorArgs = new HashMap<>(naming);
        extractorArgs.put("outputDir", out.toString());
        MetaDataLoader loader = loadMeta();
        run(entity, entityArgs, loader);
        run(extractor, extractorArgs, loader);
        return out;
    }

    @Test
    public void entityWritesNoExtractorInEitherConcreteFlavor() throws Exception {
        for (String flavor : List.of("pojoAware", "valueObject")) {
            Path out = tmp.newFolder("entity-" + flavor).toPath();
            run(new JavaObjectCodeGenerator(), entityArgs(out, flavor), loadMeta());
            ObjectClassRegistry.resetGlobal();

            assertTrue(flavor + ": entity wrote an extractor no <generator> entry declared: "
                    + extractors(out).keySet(), extractors(out).isEmpty());
            // The rest of entity's output is what it was.
            assertTrue(Files.exists(out.resolve("acme/shapes/Circle.java")));
            assertTrue(Files.exists(out.resolve(
                    "com/metaobjects/generated/GeneratedObjectClassBindingProvider.java")));
        }
    }

    @Test
    public void itWritesOneExtractorPerConcreteObjectAndNothingElse() throws Exception {
        Path out = tmp.newFolder("standalone").toPath();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", out.toString());
        run(new ExtractorCodeGenerator(), args, loadMeta());

        // The abstract Shape gets none, and no class is written.
        assertEquals(List.of("acme/shapes/CircleExtractor.java", "acme/shapes/DrawingExtractor.java"),
                List.copyOf(extractors(out).keySet()));
        try (Stream<Path> walk = Files.walk(out)) {
            assertEquals(2, walk.filter(Files::isRegularFile).count());
        }
        String circle = extractors(out).get("acme/shapes/CircleExtractor.java");
        assertTrue(circle, circle.contains("package acme.shapes;"));
        assertTrue(circle, circle.contains("public final class CircleExtractor {"));
        assertTrue(circle, circle.contains("public static Circle extract("));
    }

    @Test
    public void itNamesTheExtractorsByTheSameArgsEntityNamesItsClassesBy() throws Exception {
        Map<String, String> naming = new HashMap<>();
        naming.put("pkgPrefix", "com.example");
        naming.put("pkgSuffix", "model");
        naming.put("namePrefix", "My");
        naming.put("nameSuffix", "Vo");

        Path out = entityAndExtractor("named", "pojoAware", naming, List.of());

        // The extractor sits beside the class entity wrote, and casts to it.
        assertTrue(Files.exists(out.resolve("com/example/acme/shapes/model/MyCircleVo.java")));
        String extractor = extractors(out).get("com/example/acme/shapes/model/MyCircleVoExtractor.java");
        assertTrue("no extractor beside MyCircleVo: " + extractors(out).keySet(), extractor != null);
        assertTrue(extractor, extractor.contains("package com.example.acme.shapes.model;"));
        assertTrue(extractor, extractor.contains("public static MyCircleVo extract("));
    }

    @Test
    public void givenEntitysFiltersItWritesAnExtractorForExactlyTheClassesEntityWrites() throws Exception {
        Path out = entityAndExtractor("filtered", "pojoAware", Map.of(), List.of(PKG + "::Drawing"));

        assertEquals(List.of("acme/shapes/DrawingExtractor.java"), List.copyOf(extractors(out).keySet()));
        assertTrue(Files.exists(out.resolve("acme/shapes/Drawing.java")));
        assertFalse(Files.exists(out.resolve("acme/shapes/Circle.java")));
    }

    @Test
    public void itRefusesToRunWithNoOutputDirectory() {
        try {
            run(new ExtractorCodeGenerator(), new HashMap<>(), loadMeta());
            fail("expected a GeneratorException naming the missing outputDir");
        } catch (GeneratorException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("outputDir"));
        }
    }
}
