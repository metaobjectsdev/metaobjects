package com.metaobjects.generator.direct.object;

import com.metaobjects.generator.EmitsObjectExtractors;
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
 * The {@code extractor} generator wired on its own.
 *
 * <p>It used to exist only as a step inside {@code entity}: no {@code <generator>} entry
 * could name it, so it could not be owned or drift-checked apart from {@code entity}. These
 * tests hold the three things that make it a generator in its own right: it writes the same
 * files {@code entity} writes, {@code entity} can be told to leave them to it, and with
 * nothing told, {@code entity} still writes them as it always has.</p>
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

    @Test
    public void entityStillWritesTheExtractorsWhenNothingElseDoes() throws Exception {
        Path out = tmp.newFolder("fused").toPath();
        run(new JavaObjectCodeGenerator(), entityArgs(out, "pojoAware"), loadMeta());

        assertEquals(List.of("acme/shapes/CircleExtractor.java", "acme/shapes/DrawingExtractor.java"),
                List.copyOf(extractors(out).keySet()));
    }

    @Test
    public void entityLeavesTheExtractorsAloneWhenToldASeparateGeneratorWritesThem() throws Exception {
        Path out = tmp.newFolder("split").toPath();
        Map<String, String> args = entityArgs(out, "pojoAware");
        args.put(JavaObjectCodeGenerator.ARG_EMIT_EXTRACTORS, "false");
        run(new JavaObjectCodeGenerator(), args, loadMeta());

        assertTrue("entity wrote extractors it was told to leave: " + extractors(out).keySet(),
                extractors(out).isEmpty());
        // The rest of entity's output is untouched by the arg.
        assertTrue(Files.exists(out.resolve("acme/shapes/Circle.java")));
        assertTrue(Files.exists(out.resolve(
                "com/metaobjects/generated/GeneratedObjectClassBindingProvider.java")));
    }

    @Test
    public void onItsOwnItWritesTheSameFilesEntityWrites() throws Exception {
        Path fused = tmp.newFolder("fused").toPath();
        run(new JavaObjectCodeGenerator(), entityArgs(fused, "valueObject"), loadMeta());

        Path standalone = tmp.newFolder("standalone").toPath();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", standalone.toString());
        run(new ExtractorCodeGenerator(), args, loadMeta());

        assertFalse(extractors(fused).isEmpty());
        assertEquals(extractors(fused), extractors(standalone));
        // And nothing but extractors: the abstract Shape gets none, and no class is written.
        try (Stream<Path> walk = Files.walk(standalone)) {
            assertEquals(2, walk.filter(Files::isRegularFile).count());
        }
    }

    @Test
    public void itNamesTheExtractorsByTheSameArgsEntityNamesItsClassesBy() throws Exception {
        Map<String, String> naming = new HashMap<>();
        naming.put("pkgPrefix", "com.example");
        naming.put("pkgSuffix", "model");
        naming.put("namePrefix", "My");
        naming.put("nameSuffix", "Vo");

        Path fused = tmp.newFolder("fused").toPath();
        Map<String, String> entity = entityArgs(fused, "pojoAware");
        entity.putAll(naming);
        run(new JavaObjectCodeGenerator(), entity, loadMeta());

        Path standalone = tmp.newFolder("standalone").toPath();
        Map<String, String> args = new HashMap<>(naming);
        args.put("outputDir", standalone.toString());
        run(new ExtractorCodeGenerator(), args, loadMeta());

        assertTrue(extractors(standalone).containsKey(
                "com/example/acme/shapes/model/MyCircleVoExtractor.java"));
        assertEquals(extractors(fused), extractors(standalone));
    }

    @Test
    public void givenEntitysFiltersItWritesAnExtractorForExactlyTheClassesEntityWrites() throws Exception {
        List<String> filters = List.of(PKG + "::Drawing");

        Path fused = tmp.newFolder("fused").toPath();
        JavaObjectCodeGenerator entity = new JavaObjectCodeGenerator();
        entity.setFilters(filters);
        run(entity, entityArgs(fused, "pojoAware"), loadMeta());

        Path standalone = tmp.newFolder("standalone").toPath();
        ExtractorCodeGenerator extractor = new ExtractorCodeGenerator();
        extractor.setFilters(filters);
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", standalone.toString());
        run(extractor, args, loadMeta());

        assertEquals(List.of("acme/shapes/DrawingExtractor.java"), List.copyOf(extractors(standalone).keySet()));
        assertEquals(extractors(fused), extractors(standalone));
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

    @Test
    public void aRunDerivesTheArgFromTheGeneratorsInIt() {
        Map<String, String> args = Map.of("outputDir", "out");

        // No separate extractor in the run: the arg stays unset, so entity keeps its default.
        assertFalse(EmitsObjectExtractors.deriveEmitExtractors(
                args, List.of(new JavaObjectCodeGenerator()))
                .containsKey(EmitsObjectExtractors.ARG_EMIT_EXTRACTORS));

        // A separate extractor in the run: entity is told to leave the files to it.
        assertEquals("false", EmitsObjectExtractors.deriveEmitExtractors(
                args, List.of(new JavaObjectCodeGenerator(), new ExtractorCodeGenerator()))
                .get(EmitsObjectExtractors.ARG_EMIT_EXTRACTORS));

        // An explicit value in the pom wins over the derivation.
        Map<String, String> pinned = new HashMap<>(args);
        pinned.put(EmitsObjectExtractors.ARG_EMIT_EXTRACTORS, "true");
        assertEquals("true", EmitsObjectExtractors.deriveEmitExtractors(
                pinned, List.of(new JavaObjectCodeGenerator(), new ExtractorCodeGenerator()))
                .get(EmitsObjectExtractors.ARG_EMIT_EXTRACTORS));
    }
}
