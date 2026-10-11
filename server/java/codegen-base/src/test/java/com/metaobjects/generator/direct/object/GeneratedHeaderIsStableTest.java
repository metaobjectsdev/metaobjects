package com.metaobjects.generator.direct.object;

import com.metaobjects.generator.direct.object.javacode.JavaObjectCodeGenerator;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.ObjectClassRegistry;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.*;

/**
 * Adopter report G10: the header of a generated class stamped the wall-clock time
 * ({@code Generated On: Sat Oct 10 15:17:47 EDT 2026}), so regenerating an unchanged model
 * rewrote every generated file and put a full tree of one-line diffs in the adopter's commit.
 * The header must be a function of the metadata alone.
 */
public class GeneratedHeaderIsStableTest {

    private static final String META = "{ \"metadata.root\": {"
        + "  \"package\": \"acme::payload\","
        + "  \"children\": ["
        + "    { \"object.value\": { \"name\": \"Address\", \"children\": ["
        + "      { \"field.string\": { \"name\": \"city\" } }"
        + "    ]}}"
        + "  ]"
        + "}}";

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @After
    public void resetRegistry() {
        ObjectClassRegistry.resetGlobal();
    }

    private Map<String, String> generate(String dir) throws Exception {
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "stable-header");
        loader.init();
        loader.load(List.of(new InMemoryStringSource(META, "stable-header/meta.json")));
        Path out = tmp.newFolder(dir).toPath();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", out.toString());
        args.put("type", "class");
        args.put("flavor", "valueObject");
        JavaObjectCodeGenerator generator = new JavaObjectCodeGenerator();
        generator.setArgs(args);
        generator.execute(loader);
        Map<String, String> files = new TreeMap<>();
        try (Stream<Path> s = Files.walk(out)) {
            for (Path p : s.filter(Files::isRegularFile).collect(Collectors.toList())) {
                files.put(out.relativize(p).toString(), Files.readString(p));
            }
        }
        return files;
    }

    @Test
    public void regeneratingAnUnchangedModelWritesIdenticalFiles() throws Exception {
        Map<String, String> first = generate("first");
        // Past the one-second resolution of the old wall-clock stamp.
        Thread.sleep(1100);
        Map<String, String> second = generate("second");
        assertFalse("the generator wrote nothing", first.isEmpty());
        assertEquals(first, second);
        first.values().forEach(src ->
            assertFalse("the header must carry no timestamp:\n" + src, src.contains("Generated On")));
    }
}
