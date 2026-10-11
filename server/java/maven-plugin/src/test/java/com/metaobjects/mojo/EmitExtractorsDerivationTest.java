package com.metaobjects.mojo;

import com.metaobjects.generator.EmitsObjectExtractors;
import org.junit.Before;
import org.junit.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

/**
 * The mojo tells the Java {@code entity} generator when a separate {@code extractor}
 * generator is in the run, so each {@code <Name>Extractor} has one emitter.
 *
 * <p>{@link UseNamesDerivationTest} holds the same seam for the names artifact, and for the
 * same reason: each generator's own tests construct it directly and never reach
 * {@link AbstractMetaDataMojo#buildGenerators}, so the derivation could be dropped there
 * with nothing failing. What would fail is an adopter's build, on the first edit to an owned
 * extractor, as an output path collision with the copy {@code entity} still wrote.</p>
 */
public class EmitExtractorsDerivationTest {

    /**
     * Declares that it writes the extractors as a generator of its own. The arg recorder is
     * the sibling names test's shared {@code RecordingGenerator} — same package, same seam,
     * one recorder rather than a copy that can drift from the other.
     */
    public static class RecordingExtractorGenerator extends UseNamesDerivationTest.RecordingGenerator
            implements EmitsObjectExtractors { }

    private MetaDataGeneratorMojo mojo;

    @Before
    public void setUp() {
        UseNamesDerivationTest.RecordingGenerator.SEEN.clear();
        mojo = new MetaDataGeneratorMojo();
        mojo.setLoader(new LoaderParam());
    }

    private static GeneratorParam param(Class<?> impl, Map<String, String> args) {
        GeneratorParam p = new GeneratorParam();
        p.setClassname(impl.getName());
        if (args != null) p.setArgs(args);
        return p;
    }

    private List<Map<String, String>> run(GeneratorParam... params) {
        mojo.setGenerators(List.of(params));
        mojo.buildGenerators(getClass().getClassLoader(), null);
        return UseNamesDerivationTest.RecordingGenerator.SEEN;
    }

    @Test
    public void a_separate_extractor_in_the_run_tells_every_generator_not_to_write_them() {
        List<Map<String, String>> seen = run(
                param(UseNamesDerivationTest.RecordingGenerator.class, null),
                param(RecordingExtractorGenerator.class, null));

        assertEquals(2, seen.size());
        for (Map<String, String> args : seen) {
            assertEquals("false", args.get(EmitsObjectExtractors.ARG_EMIT_EXTRACTORS));
        }
    }

    @Test
    public void a_run_without_one_leaves_the_arg_unset_so_entity_writes_them_as_before() {
        List<Map<String, String>> seen = run(param(UseNamesDerivationTest.RecordingGenerator.class, null));

        assertEquals(1, seen.size());
        assertFalse(seen.get(0).containsKey(EmitsObjectExtractors.ARG_EMIT_EXTRACTORS));
    }

    @Test
    public void an_explicit_pom_value_wins_over_the_derivation() {
        Map<String, String> pinned = new HashMap<>();
        pinned.put(EmitsObjectExtractors.ARG_EMIT_EXTRACTORS, "true");

        List<Map<String, String>> seen = run(
                param(UseNamesDerivationTest.RecordingGenerator.class, pinned),
                param(RecordingExtractorGenerator.class, null));

        assertEquals("true", seen.get(0).get(EmitsObjectExtractors.ARG_EMIT_EXTRACTORS));
    }
}
