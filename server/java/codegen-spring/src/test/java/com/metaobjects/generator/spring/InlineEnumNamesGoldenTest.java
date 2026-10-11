package com.metaobjects.generator.spring;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
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

/**
 * A model with NO shared enum declaration regenerates byte-identical Java.
 *
 * <p>The contract under test is the generated output itself: {@code SpringDtoGenerator},
 * {@code SpringValueObjectGenerator} and {@code SpringOutputParserGenerator} run over
 * {@code golden/inline-enum-names/input/meta.json} — inline entity enums, a projection field and
 * a value-object field that extend an entity's inline enum, a value object's own inline enum,
 * and a two-hop chain that ends at an inline enum — and every emitted file must equal its
 * counterpart under {@code golden/inline-enum-names/expected/}.
 *
 * <p>The oracle is independent of the code under test: the expected files were written by the
 * generators as they stood at commit {@code 166c30786}, the commit the shared-enum rule
 * (ADR-0026 Amendment 1) branched from. That commit's {@code server/java} tree was extracted
 * with {@code git archive} into a temporary directory, built there, and the same three
 * generators were run over this same input. What a wrong implementation gets caught on: naming
 * an inline enum {@code <Owner><Field>} where it used to be named for its top-most super (so
 * {@code ShipmentSummaryDto.Status} would become {@code ShipmentSummaryDto.ShipmentSummaryStatus}).
 */
public class InlineEnumNamesGoldenTest extends SharedRegistryTestBase {

    private static final Path GOLDEN = Path.of("src/test/resources/golden/inline-enum-names");

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static Map<String, String> filesUnder(Path root) throws IOException {
        Map<String, String> files = new TreeMap<>();
        try (Stream<Path> walk = Files.walk(root)) {
            for (Path p : walk.filter(Files::isRegularFile).toList()) {
                files.put(root.relativize(p).toString().replace('\\', '/'),
                    Files.readString(p, StandardCharsets.UTF_8));
            }
        }
        return files;
    }

    @Test
    public void aModelWithNoSharedEnumRegeneratesByteIdenticalJava() throws Exception {
        MetaDataLoader loader = SpringTestFixtures.loadFixture(tmp.newFolder().toPath(), "inlineEnumNames",
            Files.readString(GOLDEN.resolve("input/meta.json"), StandardCharsets.UTF_8));
        Path out = tmp.newFolder().toPath();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", out.toString());
        for (var generator : List.of(
                new SpringDtoGenerator(), new SpringValueObjectGenerator(), new SpringOutputParserGenerator())) {
            generator.setArgs(args);
            generator.execute(loader);
        }

        Map<String, String> expected = filesUnder(GOLDEN.resolve("expected"));
        Map<String, String> actual = filesUnder(out);
        assertFalse("the golden tree must not be empty", expected.isEmpty());
        assertEquals("the generated file set must match the golden tree", expected.keySet(), actual.keySet());
        for (Map.Entry<String, String> e : expected.entrySet()) {
            assertEquals(e.getKey() + " must be byte-identical to the golden file", e.getValue(), actual.get(e.getKey()));
        }
    }
}
