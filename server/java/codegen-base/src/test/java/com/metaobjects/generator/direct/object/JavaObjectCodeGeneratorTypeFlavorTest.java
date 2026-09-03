package com.metaobjects.generator.direct.object;

import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.direct.object.javacode.JavaObjectCodeGenerator;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.InMemoryStringSource;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * {@code type} x {@code flavor} — the four combinations, and the one that used to fail
 * unreadably.
 *
 * <p>With no {@code flavor} this generator emits INTERFACES: the legacy
 * {@code JavaCodeWriter}'s {@code writeGetter}/{@code writeSetter} throw for any other
 * type. But {@code getSupportedTypes()} advertises {@code class}, so {@code type=class}
 * with no flavor was waved through configuration and then opened a class body it never
 * populated or closed. What surfaced was the writer's close-time balance check —
 * {@code "The indenting increment is not back to root level, invalid logic"} — naming an
 * output file that has nothing wrong with it, for a run whose only problem was two
 * arguments that do not go together.</p>
 *
 * <p>Found by running the Java generator registry's whole NATIVE suite over one model
 * (see {@code NoMagicPhysicalNamesTest} in codegen-spring), which is the first thing in
 * this repo that had ever asked this generator to run with a bare {@code type=class}.</p>
 */
public class JavaObjectCodeGeneratorTypeFlavorTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static final String META = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [\n"
        + "  { \"object.entity\": { \"name\": \"Customer\", \"children\": [\n"
        + "      { \"source.rdb\": { \"@table\": \"customers\" } },\n"
        + "      { \"field.long\":   { \"name\": \"id\" } },\n"
        + "      { \"field.string\": { \"name\": \"email\" } },\n"
        + "      { \"identity.primary\": { \"name\": \"pk\", \"@fields\": [\"id\"],\n"
        + "                                \"@generation\": \"increment\" } } ] } } ] } }";

    private MetaDataLoader loadMeta() {
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, "type-flavor-" + System.nanoTime());
        loader.init();
        loader.load(List.of(new InMemoryStringSource(META, "type-flavor/meta.json")));
        return loader;
    }

    /** Generate with the given args; returns the emitted .java files. */
    private List<File> generate(String type, String flavor) throws Exception {
        Path gen = tmp.newFolder().toPath();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());
        args.put("type", type);
        if (flavor != null) args.put("flavor", flavor);

        JavaObjectCodeGenerator generator = new JavaObjectCodeGenerator();
        generator.setArgs(args);
        generator.execute(loadMeta());

        try (Stream<Path> s = Files.walk(gen)) {
            return s.filter(p -> p.toString().endsWith(".java")).map(Path::toFile).toList();
        }
    }

    @Test
    public void type_class_with_no_flavor_is_refused_at_configuration_naming_the_fix() throws Exception {
        try {
            generate("class", null);
            fail("expected a GeneratorException: type=class with no flavor cannot emit a class body");
        } catch (GeneratorException e) {
            String msg = e.getMessage();
            // The message must name the way OUT, not just the fault — this replaces an error
            // that named an innocent output file and said "invalid logic".
            assertTrue(msg, msg.contains("pojoAware"));
            assertTrue(msg, msg.contains("valueObject"));
            assertTrue(msg, msg.contains("interface"));
            assertFalse("must not be the old close-time indent error: " + msg,
                msg.contains("indenting increment"));
        }
    }

    @Test
    public void the_three_coherent_combinations_all_emit() throws Exception {
        // Teeth for the refusal above: it must reject ONLY the incoherent pair. A guard that
        // is too wide would look identical from the failing side.
        assertFalse("type=interface, no flavor", generate("interface", null).isEmpty());
        assertFalse("type=class, flavor=pojoAware", generate("class", "pojoAware").isEmpty());
        assertFalse("type=class, flavor=valueObject", generate("class", "valueObject").isEmpty());
    }
}
